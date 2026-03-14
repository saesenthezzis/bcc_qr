import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../utils/Logger';
import { sanitizeAmount } from '../utils/Sanitizer';
import { Order, OrderStatus } from '../types';
import { EventEmitter } from 'events';

export class SurveillanceAgent extends EventEmitter {
  private bankUrl: string;
  private bankLogin: string;
  private bankPassword: string;
  private storagePath: string;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lastHardRefresh: number = 0;
  private readonly HARD_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 минут
  private isBrowserInitialized: boolean = false;
  private isWaitingForSms: boolean = false;
  private smsCodePromise: Promise<string> | null = null;
  private resolveSmsCode: ((code: string) => void) | null = null;

  constructor(bankUrl: string, bankLogin: string, bankPassword: string) {
    super();
    this.bankUrl = bankUrl;
    this.bankLogin = bankLogin;
    this.bankPassword = bankPassword;
    this.storagePath = path.join(process.cwd(), 'storage');

    // Создаём директорию storage если не существует
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }
  }

  /**
   * Проверка и исправление URL (всегда /ru версия)
   */
  private async ensureCorrectUrl(): Promise<void> {
    if (!this.page) return;

    const currentUrl = this.page.url();
    const targetUrl = 'https://online.bcc.kz/cashier-cabinet/ru';
    
    // Проверка на /en версию или 404
    if (currentUrl.includes('/en') || currentUrl.includes('404')) {
      Logger.info(`Surveillance: Wrong URL (${currentUrl}), redirecting to /ru`);
      await this.page.goto(targetUrl, { waitUntil: 'networkidle' });
    }
  }

  /**
   * Проверка сессии на валидность (публичный метод для index.ts)
   */
  async checkSessionValid(): Promise<boolean> {
    if (!this.page) return false;

    try {
      const bodyText = await this.page.textContent('body');
      if (!bodyText) return false;

      const invalidSessionMarkers = ['не авторизован', 'сессия закончилась', 'session expired', 'unauthorized'];

      for (const marker of invalidSessionMarkers) {
        if (bodyText.toLowerCase().includes(marker.toLowerCase())) {
          Logger.warn(`Surveillance: Invalid session detected (${marker})`);
          return false;
        }
      }

      // Проверка наличия таблицы (признак авторизации)
      const hasTable = await this.page.isVisible('.bcc-table-body').catch(() => false);
      return hasTable;
    } catch (error) {
      Logger.warn(`Surveillance: Session check failed - ${error}`);
      return false;
    }
  }

  /**
   * Инициализация браузера (один раз при старте)
   */
  async initBrowser(): Promise<void> {
    if (this.isBrowserInitialized) {
      Logger.info('Surveillance: Browser already initialized');
      return;
    }

    Logger.info('Surveillance: Initializing browser...');

    const sessionPath = path.join(this.storagePath, 'session.json');

    // Пробуем загрузить существующую сессию
    let storageState: { cookies: any[], origins: any[] } | undefined = undefined;
    if (fs.existsSync(sessionPath)) {
      try {
        storageState = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
        Logger.info('Surveillance: Loaded existing session');
      } catch (error) {
        Logger.warn('Surveillance: Failed to load session, will login fresh');
      }
    }

    this.browser = await chromium.launch({
      headless: true, // Headless режим для стабильности
      // Флаги для экономии памяти (важно для Render с 512MB лимитом)
      args: [
        '--disable-dev-shm-usage', // Испольвать /tmp вместо /dev/shm
        '--no-sandbox', // Без песочницы (требуется в Docker)
        '--disable-gpu', // Отключаем GPU для экономии памяти
        '--disable-accelerated-2d-canvas',
        '--disable-webgl',
        '--ignore-certificate-errors',
        '--allow-running-insecure-content',
        '--disable-features=CertificateTransparency',
        '--auto-select-desktop-certificate-origin="online.bcc.kz"',
      ],
    });

    this.context = await this.browser.newContext({
      storageState,
      ignoreHTTPSErrors: true,
      // Фиксированный размер окна для стабильных скриншотов
      viewport: { width: 1920, height: 1080 },
    });

    this.page = await this.context.newPage();

    // Агрессивный обработчик диалогов (сертификаты, алерты)
    this.page.on('dialog', async (dialog) => {
      Logger.info(`Surveillance: Dialog detected: ${dialog.message}`);
      await dialog.accept();
    });

    // Обработчик certificate popup через клавиатуру
    this.page.on('framenavigated', async () => {
      // Пытаемся нажать Enter для выбора сертификата
      if (this.page) {
        await this.page.keyboard.press('Enter').catch(() => {});
      }
    });

    this.isBrowserInitialized = true;
    Logger.info('Surveillance: Browser initialized (1920x1080)');
  }

  /**
   * Логин на банковский портал с сохранением сессии
   * Conditional Login: если уже в кабинете — пропускаем вход
   * SMS Detection: если требуется СМС — уведомляем админа
   */
  async login(): Promise<void> {
    Logger.info('Surveillance: Starting login...');

    // Инициализируем браузер если ещё не инициализирован
    if (!this.isBrowserInitialized) {
      await this.initBrowser();
    }

    const sessionPath = path.join(this.storagePath, 'session.json');

    try {
      await this.page!.goto('https://online.bcc.kz/cashier-cabinet/ru', { waitUntil: 'networkidle', timeout: 60000 });

      // Агрессивное закрытие окна сертификата (серия нажатий Enter)
      await this.page!.waitForTimeout(500);
      for (let i = 0; i < 3; i++) {
        await this.page!.keyboard.press('Enter').catch(() => {});
        await this.page!.waitForTimeout(200);
      }
      Logger.info('Surveillance: Certificate popup dismissal attempted');

      // Проверка URL
      await this.ensureCorrectUrl();

      // === Conditional Login: проверяем, не залогинены ли уже ===
      const alreadyLoggedIn = await this.checkSessionValid();
      if (alreadyLoggedIn) {
        Logger.info('Surveillance: Already logged in (session restored)');
        await this.saveSession(sessionPath);
        return;
      }

      // Fast Check: проверяем наличие поля логина всего 5 секунд
      const hasLoginField = await this.page!.waitForSelector('input#username', { timeout: 5000 })
        .then(() => true)
        .catch(() => false);

      if (!hasLoginField) {
        // Поля логина нет, но и таблица не видна — возможно временная проблема
        Logger.warn('Surveillance: Login field not found after 5s, but session may be valid');
        const stillLoggedIn = await this.checkSessionValid();
        if (stillLoggedIn) {
          Logger.info('Surveillance: Session is valid, skipping login');
          await this.saveSession(sessionPath);
          return;
        }
        throw new Error('Login field not found and session invalid');
      }

      // Ввод логина (телефон) с обходом маски
      await this.fillPhoneField('input#username', this.bankLogin);

      // Ввод пароля
      await this.page!.fill('input#password', this.bankPassword);
      await this.page!.click('button[type="submit"]');

      // === SMS Detection: ждём либо таблицу, либо СМС-поле ===
      const smsCodeSent = await this.handleSmsVerification(sessionPath);
      if (!smsCodeSent) {
        // Если СМС не требовалось, просто ждём таблицу
        await this.page!.waitForSelector('.bcc-table-body', { timeout: 30000 });
      }

      // Сохранение сессии
      await this.saveSession(sessionPath);

      Logger.info('Surveillance: Login successful, session saved');
    } catch (error) {
      // Не считаем ошибкой таймаут если ждём СМС
      const errorMessage = String(error);
      if (this.isWaitingForSms && (errorMessage.includes('Timeout') || errorMessage.includes('timeout'))) {
        Logger.warn('Surveillance: Timeout while waiting, but SMS verification is in progress');
        throw error;
      }
      Logger.error(`Surveillance: Login failed - ${error}`);
      throw error;
    }
  }

  /**
   * Обработка СМС-верификации
   * Использует Promise.race для ожидания либо таблицы, либо СМС-поля
   * @returns true если СМС было отправлено и обработано, false если СМС не требовалось
   */
  private async handleSmsVerification(sessionPath: string): Promise<boolean> {
    Logger.info('Surveillance: Checking for SMS verification or table...');

    // Ждём появления либо таблицы, либо СМС-поля (что появится первым)
    const SMS_SELECTORS = [
      'input.bcc-input-code__input',
      'input[placeholder*="код"]',
      'input[placeholder*="SMS"]',
      'input[type="text"][maxlength="4"]',
      'input[type="text"][maxlength="6"]',
    ];

    try {
      // Используем Promise.race для определения что появилось первым
      const [tableVisible, smsFieldVisible] = await Promise.all([
        this.page!.isVisible('.bcc-table-body').catch(() => false),
        this.checkSmsFieldVisible(SMS_SELECTORS),
      ]);

      // Если таблица уже видна — СМС не требуется
      if (tableVisible) {
        Logger.debug('Surveillance: Table visible, SMS not required');
        return false;
      }

      // Если СМС-поле найдено
      if (smsFieldVisible) {
        Logger.info('Surveillance: SMS verification required');
        return await this.processSmsVerification(SMS_SELECTORS, sessionPath);
      }

      // Если ничего не видно, пробуем подождать ещё немного
      Logger.warn('Surveillance: Neither table nor SMS field visible, waiting...');
      await this.page!.waitForTimeout(3000);

      // Повторная проверка
      const retryTableVisible = await this.page!.isVisible('.bcc-table-body').catch(() => false);
      if (retryTableVisible) {
        return false;
      }

      const retrySmsVisible = await this.checkSmsFieldVisible(SMS_SELECTORS);
      if (retrySmsVisible) {
        return await this.processSmsVerification(SMS_SELECTORS, sessionPath);
      }

      Logger.warn('Surveillance: Could not determine login result');
      return false;

    } catch (error) {
      Logger.error(`Surveillance: SMS verification check failed - ${error}`);
      return false;
    }
  }

  /**
   * Проверка видимости любого из СМС-полей
   */
  private async checkSmsFieldVisible(selectors: string[]): Promise<boolean> {
    for (const selector of selectors) {
      const visible = await this.page!.$(selector).then(async (el) => {
        if (!el) return false;
        return el.isVisible().catch(() => false);
      }).catch(() => false);
      if (visible) return true;
    }
    return false;
  }

  /**
   * Обработка СМС-верификации (скриншот, ожидание кода, ввод)
   */
  private async processSmsVerification(smsSelectors: string[], sessionPath: string): Promise<boolean> {
    // Находим все поля для СМС-кода (4 отдельных поля)
    const smsInputs = await this.page!.$$('input.bcc-input-code__input');

    if (smsInputs.length === 0) {
      Logger.warn('Surveillance: SMS fields not found, trying alternative selectors');
      // Пробуем альтернативные селекторы
      for (const selector of smsSelectors) {
        const altInputs = await this.page!.$$(selector);
        if (altInputs.length > 0) {
          smsInputs.push(...altInputs);
        }
      }
    }

    if (smsInputs.length === 0) {
      Logger.debug('Surveillance: No SMS input fields found');
      return false;
    }

    Logger.info(`Surveillance: Found ${smsInputs.length} SMS input fields`);

    // Ждём завершения анимации появления модального окна
    await this.page!.waitForTimeout(1000);

    // Дополнительно убеждаемся, что СМС-поле видно
    try {
      await this.page!.waitForSelector('input.bcc-input-code__input', { state: 'visible', timeout: 5000 });
    } catch (e) {
      Logger.warn('Surveillance: SMS input not fully visible, proceeding anyway');
    }

    // Делаем скриншот модального окна СМС (только видимая область)
    const screenshotPath = path.join(this.storagePath, 'sms_screenshot.png');
    await this.page!.screenshot({
      path: screenshotPath,
      fullPage: false, // Только видимая область (1920x1080)
    });

    Logger.info(`Surveillance: Screenshot saved to ${screenshotPath}`);

    // Отправляем скриншот админу через событие
    const screenshotBuffer = fs.readFileSync(screenshotPath);
    this.emit('smsRequired', {
      screenshot: screenshotBuffer,
      timestamp: new Date().toISOString(),
    });

    // Очищаем файл после отправки (не храним мусор)
    try {
      fs.unlinkSync(screenshotPath);
      Logger.debug(`Surveillance: Screenshot file cleaned up`);
    } catch (unlinkError) {
      Logger.warn(`Surveillance: Failed to delete screenshot: ${unlinkError}`);
    }

    // Ждём СМС-код от админа
    Logger.info('Surveillance: Waiting for SMS code from admin...');
    this.isWaitingForSms = true;

    const smsCode = await this.waitForSmsCode();
    Logger.info(`Surveillance: SMS code received: ${smsCode}`);

    // Вводим СМС-код по одному символу в каждое поле
    try {
      const inputs = await this.page!.$$('input.bcc-input-code__input');
      
      if (inputs.length >= smsCode.length) {
        // Ввод по одному символу в каждое поле
        for (let i = 0; i < smsCode.length && i < inputs.length; i++) {
          await inputs[i].fill(smsCode[i]);
          await this.page!.waitForTimeout(100);
        }
        Logger.info('Surveillance: SMS code entered into individual fields');
      } else {
        // Если полей меньше чем символов, вводим весь код в первое поле
        await this.page!.fill(smsSelectors[0], smsCode);
        Logger.info('Surveillance: SMS code entered as single string');
      }

      await this.page!.waitForTimeout(500);

      // Нажимаем Enter или ищем кнопку подтверждения
      await this.page!.keyboard.press('Enter');
      await this.page!.waitForTimeout(1000);

      // Пытаемся найти кнопку подтверждения
      const submitButtons = [
        'button[type="submit"]',
        'button:has-text("Подтвердить")',
        'button:has-text("Confirm")',
        'button.bcc-button',
      ];

      for (const selector of submitButtons) {
        const button = await this.page!.$(selector).catch(() => null);
        if (button) {
          await button.click().catch(() => {});
          Logger.info(`Surveillance: Submit button clicked (${selector})`);
          break;
        }
      }

      Logger.info('Surveillance: SMS code submitted');

      // Ждём исчезновения модального окна СМС
      try {
        await this.page!.waitForSelector('.bcc-modal', { state: 'hidden', timeout: 10000 });
        Logger.info('Surveillance: SMS modal closed');
      } catch (modalError) {
        Logger.debug('Surveillance: SMS modal not found or already hidden');
      }

      // Ждём загрузки таблицы после успешного ввода СМС
      await this.page!.waitForSelector('.bcc-table-body', { timeout: 30000 });
      Logger.info('Surveillance: Table loaded after SMS verification');

    } catch (error) {
      Logger.error(`Surveillance: Error during SMS code submission - ${error}`);
      throw error;
    } finally {
      this.isWaitingForSms = false;
    }

    return true;
  }

  /**
   * Ожидание СМС-кода от админа
   */
  private waitForSmsCode(): Promise<string> {
    this.smsCodePromise = new Promise<string>((resolve) => {
      this.resolveSmsCode = resolve;
    });
    return this.smsCodePromise;
  }

  /**
   * Публичный метод для получения СМС-кода из Dispatcher
   */
  public submitSmsCode(code: string): void {
    if (this.resolveSmsCode) {
      this.resolveSmsCode(code);
      this.resolveSmsCode = null;
      this.smsCodePromise = null;
      Logger.info(`Surveillance: SMS code received: ${code}`);
    }
  }

  /**
   * Проверка статуса ожидания СМС
   */
  public getIsWaitingForSms(): boolean {
    return this.isWaitingForSms;
  }

  /**
   * Заполнение поля телефона с обходом маски ввода
   */
  private async fillPhoneField(selector: string, phone: string): Promise<void> {
    if (!this.page) return;

    try {
      // Клик по полю
      await this.page.click(selector);
      await this.page.waitForTimeout(200);

      // Выделение всего текста (Ctrl+A) и удаление
      await this.page.keyboard.press('Control+A');
      await this.page.waitForTimeout(100);
      await this.page.keyboard.press('Backspace');
      await this.page.waitForTimeout(200);

      // Посимвольный ввод номера с задержкой для маски
      await this.page.type(selector, phone, { delay: 100 });

      Logger.info(`Surveillance: Phone field filled with ${phone}`);
    } catch (error) {
      Logger.error(`Surveillance: Failed to fill phone field - ${error}`);
      throw error;
    }
  }

  /**
   * Сохранение сессии в файл
   */
  private async saveSession(sessionPath: string): Promise<void> {
    if (this.context) {
      const state = await this.context.storageState();
      fs.writeFileSync(sessionPath, JSON.stringify(state, null, 2));
    }
  }

  /**
   * Hard refresh (полная перезагрузка) каждые 15 минут
   */
  async hardRefreshIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now - this.lastHardRefresh >= this.HARD_REFRESH_INTERVAL_MS) {
      Logger.info('Surveillance: Performing hard refresh (15 min interval)');
      await this.hardRefresh();
      this.lastHardRefresh = now;
    }
  }

  /**
   * Полная перезагрузка страницы (F5)
   */
  async hardRefresh(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    try {
      await this.page.reload({ waitUntil: 'networkidle' });
      await this.page.waitForSelector('.bcc-table-body', { timeout: 10000 });
      Logger.info('Surveillance: Hard refresh completed');
    } catch (error) {
      Logger.error(`Surveillance: Hard refresh failed - ${error}`);
      throw error;
    }
  }

  /**
   * Обновление таблицы через кнопку refresh (мягкое)
   */
  async softRefresh(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    try {
      const refreshButton = await this.page.$('button.bcc-button_iconOnly');
      if (refreshButton) {
        await refreshButton.click();
        Logger.info('Surveillance: Soft refresh button clicked');
      } else {
        Logger.warn('Surveillance: Soft refresh button not found');
      }
      
      await this.page.waitForSelector('.bcc-table-body', { timeout: 10000 });
      await this.page.waitForTimeout(2000);
      
      Logger.info('Surveillance: Soft refresh completed');
    } catch (error) {
      Logger.error(`Surveillance: Soft refresh failed - ${error}`);
    }
  }

  /**
   * Извлечение данных о заказах из таблицы транзакций
   * Data mapping:
   * - external_id: td:nth-child(1) (индекс 0)
   * - status: td:nth-child(5) (индекс 4) -> .bcc-tag__content
   * - amount: td:nth-child(6) (индекс 5) -> p[class*="amount-with-currency-sign_amount"]
   * Фильтр: "Выдано" (READY_FOR_QR) и "Нужно подтвердить" (PENDING)
   */
  async extractOrders(): Promise<Order[]> {
    Logger.info('Surveillance: Extracting orders...');

    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    const orders: Order[] = [];

    try {
      // Ожидание таблицы
      await this.page.waitForSelector('.bcc-table-body__row', { timeout: 10000 });

      // Извлечение всех строк
      const rows = await this.page.$$('.bcc-table-body__row');
      Logger.info(`Surveillance: Found ${rows.length} rows in table`);

      for (const row of rows) {
        try {
          // Получаем все ячейки
          const cells = await row.$$('td');
          if (cells.length < 6) {
            Logger.warn('Surveillance: Row has less than 6 cells, skipping');
            continue;
          }

          // external_id из 0-й ячейки
          const externalIdElement = cells[0];
          const externalId = await externalIdElement.innerText();
          if (!externalId || externalId.trim() === '') {
            Logger.debug('Surveillance: Empty external_id, skipping');
            continue;
          }

          // status из 4-й ячейки (индекс 4) -> .bcc-tag__content
          const statusCell = cells[4];
          const statusElement = await statusCell.$('.bcc-tag__content');
          if (!statusElement) {
            Logger.debug('Surveillance: No status element, skipping');
            continue;
          }

          const statusText = await statusElement.innerText();
          const trimmedStatus = statusText.trim();

          // Фильтр: только "Выдано" или "Нужно подтвердить"
          let orderStatus: OrderStatus;
          if (trimmedStatus === 'Выдано') {
            orderStatus = 'READY_FOR_QR';
          } else if (trimmedStatus === 'Нужно подтвердить') {
            orderStatus = 'PENDING';
          } else {
            Logger.debug(`Surveillance: Status "${trimmedStatus}" not matched, skipping`);
            continue;
          }

          // amount из 5-й ячейки (индекс 5) -> p[class*="amount-with-currency-sign_amount"]
          const amountCell = cells[5];
          const amountElement = await amountCell.$('p[class*="amount-with-currency-sign_amount"]');
          if (!amountElement) {
            Logger.debug('Surveillance: No amount element, skipping');
            continue;
          }

          const amountRaw = await amountElement.innerText();
          const amount = sanitizeAmount(amountRaw);

          if (amount <= 0) {
            Logger.warn(`Surveillance: Invalid amount ${amount} for order ${externalId}, skipping`);
            continue;
          }

          orders.push({ external_id: externalId.trim(), amount, status: orderStatus });
          Logger.info(`Surveillance: Extracted order ${externalId} (${amount} KZT, ${orderStatus})`);

        } catch (error) {
          Logger.warn(`Failed to parse row: ${error}`);
          continue;
        }
      }

      const readyCount = orders.filter(o => o.status === 'READY_FOR_QR').length;
      const pendingCount = orders.filter(o => o.status === 'PENDING').length;
      Logger.info(`Surveillance: Extracted ${orders.length} orders (${readyCount} ready, ${pendingCount} pending)`);
    } catch (error) {
      Logger.error(`Surveillance: Extraction failed - ${error}`);
      throw error;
    }

    return orders;
  }

  /**
   * Основной метод для ротации: обновление + экстракция
   * Используется в цикле while(true) без перезапуска браузера
   */
  async runRotation(): Promise<Order[]> {
    Logger.info('Surveillance: Running rotation...');
    
    // Проверка и восстановление сессии при необходимости
    await this.login();
    
    // Обновление данных
    await this.hardRefreshIfNeeded();
    await this.softRefresh();
    
    // Экстракция
    return await this.extractOrders();
  }

  /**
   * Основной метод: логин + экстракция (для обратной совместимости)
   */
  async getNewOrders(): Promise<Order[]> {
    await this.login();
    await this.hardRefreshIfNeeded();
    await this.softRefresh();
    return await this.extractOrders();
  }

  /**
   * Закрытие браузера
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      Logger.info('Surveillance: Browser closed');
    }
  }
}
