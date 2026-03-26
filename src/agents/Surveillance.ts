import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../utils/Logger';
import { sanitizeAmount } from '../utils/Sanitizer';
import { Order, OrderStatus } from '../types';
import { EventEmitter } from 'events';
import { RegistryAgent } from './Registry';

export class SurveillanceAgent extends EventEmitter {
  private bankUrl: string;
  private bankLogin: string;
  private bankPassword: string;
  private storagePath: string;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lastHardRefresh: number = 0;
  private readonly HARD_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
  private isBrowserInitialized: boolean = false;
  private isWaitingForSms: boolean = false;
  private smsCodePromise: Promise<string> | null = null;
  private resolveSmsCode: ((code: string) => void) | null = null;
  private registry: RegistryAgent | null = null;

  constructor(bankUrl: string, bankLogin: string, bankPassword: string, registry?: RegistryAgent) {
    super();
    this.bankUrl = bankUrl;
    this.bankLogin = bankLogin;
    this.bankPassword = bankPassword;
    this.storagePath = path.join(process.cwd(), 'storage');
    this.registry = registry || null;

    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }
  }

  public setRegistry(registry: RegistryAgent): void {
    this.registry = registry;
  }

  private async ensureCorrectUrl(): Promise<void> {
    if (!this.page) return;

    const currentUrl = this.page.url();
    const targetUrl = 'https://online.bcc.kz/cashier-cabinet/ru';

    if (currentUrl.includes('/en') || currentUrl.includes('404')) {
      Logger.info(`Surveillance: Wrong URL (${currentUrl}), redirecting to /ru`);
      await this.page.goto(targetUrl, { waitUntil: 'networkidle' });
    }
  }

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

      const hasTable = await this.page.isVisible('.bcc-table-body').catch(() => false);
      return hasTable;
    } catch (error) {
      Logger.warn(`Surveillance: Session check failed - ${error}`);
      return false;
    }
  }

  async initBrowser(): Promise<void> {
    if (this.isBrowserInitialized) {
      Logger.info('Surveillance: Browser already initialized');
      return;
    }

    Logger.info('Surveillance: Initializing browser...');

    const sessionPath = path.join(this.storagePath, 'session.json');
    let storageState: { cookies: any[], origins: any[] } | undefined = undefined;

    if (this.registry) {
      const cloudSession = await this.registry.loadSessionFromDb();
      if (cloudSession) {
        storageState = cloudSession;
        Logger.info('Surveillance: Loaded session from Supabase');
      }
    }

    if (!storageState && fs.existsSync(sessionPath)) {
      try {
        storageState = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
        Logger.info('Surveillance: Loaded existing local session');
      } catch (error) {
        Logger.warn('Surveillance: Failed to load local session');
      }
    }

    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--no-setuid-sandbox',
        '--disable-gpu',
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
      viewport: { width: 1920, height: 1080 },
    });

    this.page = await this.context.newPage();

    this.page.on('dialog', async (dialog) => {
      Logger.info(`Surveillance: Dialog detected: ${dialog.message}`);
      await dialog.accept();
    });

    this.page.on('framenavigated', async () => {
      if (this.page) {
        await this.page.keyboard.press('Enter').catch(() => {});
      }
    });

    this.isBrowserInitialized = true;
    Logger.info('Surveillance: Browser initialized (1920x1080)');
  }

  async login(): Promise<void> {
    Logger.info('Surveillance: Starting login...');

    if (!this.isBrowserInitialized) {
      await this.initBrowser();
    }

    const sessionPath = path.join(this.storagePath, 'session.json');

    try {
      // Patience Mode: ждем полную загрузку страницы
      await this.page!.goto('https://online.bcc.kz/cashier-cabinet/ru', { 
        waitUntil: 'domcontentloaded',
        timeout: 60000 
      });
      
      // Дополнительное ожидание networkidle после domcontentloaded
      await this.page!.waitForLoadState('networkidle', { timeout: 60000 });

      await this.page!.waitForTimeout(500);
      for (let i = 0; i < 3; i++) {
        await this.page!.keyboard.press('Enter').catch(() => {});
        await this.page!.waitForTimeout(200);
      }
      Logger.info('Surveillance: Certificate popup dismissal attempted');

      await this.ensureCorrectUrl();

      // Даем время на загрузку "тяжелого" банка
      await this.page!.waitForTimeout(2000);
      await this.page!.waitForLoadState('networkidle');
      await this.page!.waitForTimeout(3000);

      const pageState = await this.detectPageState();

      if (pageState === 'LOGGED_IN') {
        Logger.info('Surveillance: Already logged in (session restored)');
        await this.saveSession(sessionPath);
        return;
      }

      if (pageState === 'LOGIN_FORM') {
        Logger.info('Surveillance: Login form detected, entering credentials');
        await this.performLogin(sessionPath);
        return;
      }

      if (pageState === 'SKELETON') {
        Logger.info('Surveillance: Skeleton state detected, waiting for data...');
        // Ждем появления данных в таблице до 60 секунд
        try {
          await this.page!.waitForSelector('.bcc-table-body__row', { timeout: 60000, state: 'visible' });
          Logger.info('Surveillance: Data loaded after skeleton wait');
          await this.saveSession(sessionPath);
          return;
        } catch (timeoutError) {
          Logger.warn('Surveillance: Data did not appear after skeleton wait, reloading');
        }
      }

      if (pageState === 'UNKNOWN') {
        const currentUrl = this.page!.url();
        Logger.warn(`Surveillance: Unknown page state. URL: ${currentUrl}`);

        // Patience Mode: 3 попытки с reload и ожиданием 60s
        for (let attempt = 1; attempt <= 3; attempt++) {
          Logger.info(`Surveillance: Reload attempt ${attempt}/3 with 60s patience`);
          
          // Полная перезагрузка страницы
          await this.page!.reload({ 
            waitUntil: 'domcontentloaded',
            timeout: 60000 
          });
          await this.page!.waitForLoadState('networkidle', { timeout: 60000 });
          await this.page!.waitForTimeout(10000); // Даем время на загрузку данных

          const retryState = await this.detectPageState();
          
          if (retryState === 'LOGGED_IN') {
            Logger.info('Surveillance: Table found after reload, considering as logged in');
            await this.saveSession(sessionPath);
            return;
          }
          
          if (retryState === 'LOGIN_FORM') {
            Logger.info('Surveillance: Login form found after reload');
            await this.performLogin(sessionPath);
            return;
          }
          
          if (retryState === 'SKELETON') {
            Logger.info(`Surveillance: Still skeleton on attempt ${attempt}, waiting more...`);
            try {
              await this.page!.waitForSelector('.bcc-table-body__row', { timeout: 60000, state: 'visible' });
              Logger.info('Surveillance: Data loaded after skeleton wait');
              await this.saveSession(sessionPath);
              return;
            } catch (timeoutError) {
              Logger.warn(`Surveillance: Skeleton timeout on attempt ${attempt}`);
            }
          }
        }

        Logger.error('Surveillance: Cannot determine page state after 3 reload attempts');
        throw new Error(`Unknown page state at URL: ${currentUrl} after 3 reload attempts with 60s patience`);
      }

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (this.isWaitingForSms && (errorMsg.includes('Timeout') || errorMsg.includes('timeout'))) {
        Logger.warn('Surveillance: Timeout while waiting, but SMS verification is in progress');
        throw error;
      }

      const isSessionValid = await this.checkSessionValid().catch(() => false);
      if (isSessionValid) {
        Logger.warn('Surveillance: Error occurred but session appears valid, continuing');
        return;
      }

      Logger.error(`Surveillance: Login failed - ${errorMsg}`);
      throw error;
    }
  }

  private async detectPageState(): Promise<'LOGGED_IN' | 'LOGIN_FORM' | 'SKELETON' | 'UNKNOWN'> {
    try {
      // Smart State Detection: сначала ждем появления таблицы или логина
      const [hasTable, hasLoginField] = await Promise.all([
        this.page!.isVisible('.bcc-table-body').catch(() => false),
        this.page!.isVisible('input#username').catch(() => false),
      ]);

      if (hasTable && !hasLoginField) {
        // Проверяем, есть ли данные в таблице (не "скелетон" ли)
        const hasRows = await this.page!.isVisible('.bcc-table-body__row').catch(() => false);
        if (hasRows) {
          return 'LOGGED_IN';
        } else {
          // Таблица есть, но данных нет — это "скелетон"
          Logger.debug('Surveillance: Table visible but no rows (skeleton detected)');
          return 'SKELETON';
        }
      }

      if (hasLoginField && !hasTable) {
        return 'LOGIN_FORM';
      }

      if (hasTable && hasLoginField) {
        Logger.warn('Surveillance: Both table and login field visible, prioritizing table');
        return 'LOGGED_IN';
      }

      // Проверяем явный "скелетон" — серые блоки загрузки
      const hasSkeleton = await this.page!.isVisible('[class*="skeleton"]').catch(() => false) ||
                          await this.page!.isVisible('[class*="loading"]').catch(() => false);
      if (hasSkeleton) {
        Logger.debug('Surveillance: Skeleton/loading state detected');
        return 'SKELETON';
      }

      return 'UNKNOWN';
    } catch (error) {
      Logger.error(`Surveillance: Page state detection failed - ${error}`);
      return 'UNKNOWN';
    }
  }

  private async performLogin(sessionPath: string): Promise<void> {
    await this.fillPhoneField('input#username', this.bankLogin);

    await this.page!.fill('input#password', this.bankPassword);
    await this.page!.click('button[type="submit"]');

    const smsCodeSent = await this.handleSmsVerification(sessionPath);
    if (!smsCodeSent) {
      // Patience Mode: ждем таблицу до 60 секунд
      await this.page!.waitForSelector('.bcc-table-body', { timeout: 60000 });
    }

    await this.saveSession(sessionPath);
    Logger.info('Surveillance: Login successful, session saved');
  }

  private async handleSmsVerification(sessionPath: string): Promise<boolean> {
    Logger.info('Surveillance: Checking for SMS verification or table...');

    const SMS_SELECTORS = [
      'input.bcc-input-code__input',
      'input[placeholder*="код"]',
      'input[placeholder*="SMS"]',
      'input[type="text"][maxlength="4"]',
      'input[type="text"][maxlength="6"]',
    ];

    try {
      const [tableVisible, smsFieldVisible] = await Promise.all([
        this.page!.isVisible('.bcc-table-body').catch(() => false),
        this.checkSmsFieldVisible(SMS_SELECTORS),
      ]);

      if (tableVisible) {
        Logger.debug('Surveillance: Table visible, SMS not required');
        return false;
      }

      if (smsFieldVisible) {
        Logger.info('Surveillance: SMS verification required');
        return await this.processSmsVerification(SMS_SELECTORS, sessionPath);
      }

      Logger.warn('Surveillance: Neither table nor SMS field visible, waiting...');
      await this.page!.waitForTimeout(3000);

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

  private async processSmsVerification(smsSelectors: string[], sessionPath: string): Promise<boolean> {
    let smsInputs = await this.page!.$$('input.bcc-input-code__input');

    if (smsInputs.length === 0) {
      Logger.warn('Surveillance: SMS fields not found, trying alternative selectors');
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

    await this.page!.waitForTimeout(1000);

    try {
      await this.page!.waitForSelector('input.bcc-input-code__input', { state: 'visible', timeout: 60000 });
    } catch (e) {
      Logger.warn('Surveillance: SMS input not fully visible, proceeding anyway');
    }

    const screenshotPath = path.join(this.storagePath, 'sms_screenshot.png');
    await this.page!.screenshot({
      path: screenshotPath,
      fullPage: false,
    });

    Logger.info(`Surveillance: Screenshot saved to ${screenshotPath}`);

    const screenshotBuffer = fs.readFileSync(screenshotPath);
    this.emit('smsRequired', {
      screenshot: screenshotBuffer,
      timestamp: new Date().toISOString(),
    });

    try {
      fs.unlinkSync(screenshotPath);
      Logger.debug(`Surveillance: Screenshot file cleaned up`);
    } catch (unlinkError) {
      Logger.warn(`Surveillance: Failed to delete screenshot: ${unlinkError}`);
    }

    Logger.info('Surveillance: Waiting for SMS code from admin...');
    this.isWaitingForSms = true;

    const smsCode = await this.waitForSmsCode();
    Logger.info(`Surveillance: SMS code received: ${smsCode}`);

    try {
      const inputs = await this.page!.$$('input.bcc-input-code__input');

      if (inputs.length >= smsCode.length) {
        for (let i = 0; i < smsCode.length && i < inputs.length; i++) {
          await inputs[i].fill(smsCode[i]);
          await this.page!.waitForTimeout(100);
        }
        Logger.info('Surveillance: SMS code entered into individual fields');
      } else {
        await this.page!.fill(smsSelectors[0], smsCode);
        Logger.info('Surveillance: SMS code entered as single string');
      }

      await this.page!.waitForTimeout(500);

      await this.page!.keyboard.press('Enter');
      await this.page!.waitForTimeout(1000);

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

      try {
        await this.page!.waitForSelector('.bcc-modal', { state: 'hidden', timeout: 60000 });
        Logger.info('Surveillance: SMS modal closed');
      } catch (modalError) {
        Logger.debug('Surveillance: SMS modal not found or already hidden');
      }

      await this.page!.waitForSelector('.bcc-table-body', { timeout: 60000, state: 'visible' });
      Logger.info('Surveillance: Table loaded after SMS verification');

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      Logger.error(`Surveillance: Error during SMS code submission - ${errorMsg}`);
      throw error;
    } finally {
      this.isWaitingForSms = false;
    }

    return true;
  }

  private async fillPhoneField(selector: string, phone: string): Promise<void> {
    if (!this.page) return;

    try {
      await this.page.click(selector);
      await this.page.waitForTimeout(200);

      await this.page.keyboard.press('Control+A');
      await this.page.waitForTimeout(100);
      await this.page.keyboard.press('Backspace');
      await this.page.waitForTimeout(200);

      await this.page.type(selector, phone, { delay: 100 });

      Logger.info(`Surveillance: Phone field filled with ${phone}`);
    } catch (error) {
      Logger.error(`Surveillance: Failed to fill phone field - ${error}`);
      throw error;
    }
  }

  private async saveSession(sessionPath: string): Promise<void> {
    if (!this.context) return;

    try {
      const state = await this.context.storageState();
      const stateJson = JSON.stringify(state, null, 2);

      fs.writeFileSync(sessionPath, stateJson);
      Logger.info('Session saved to local file');

      if (this.registry) {
        await this.registry.saveSessionToDb(state);
        Logger.info('Session synced to Supabase');
      }
    } catch (error) {
      Logger.error(`Failed to save session: ${error}`);
    }
  }

  async syncSessionToCloud(): Promise<boolean> {
    if (!this.context || !this.registry) return false;

    try {
      const state = await this.context.storageState();
      const success = await this.registry.saveSessionToDb(state);
      if (success) {
        Logger.info('Session manually synced to Supabase');
      }
      return success;
    } catch (error) {
      Logger.error(`Failed to sync session: ${error}`);
      return false;
    }
  }

  async hardRefreshIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now - this.lastHardRefresh >= this.HARD_REFRESH_INTERVAL_MS) {
      Logger.info('Surveillance: Performing hard refresh (15 min interval)');
      await this.hardRefresh();
      this.lastHardRefresh = now;
    }
  }

  async hardRefresh(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    try {
      await this.page.reload({ waitUntil: 'networkidle' });
      await this.page.waitForSelector('.bcc-table-body', { timeout: 60000 });
      Logger.info('Surveillance: Hard refresh completed');
    } catch (error) {
      Logger.error(`Surveillance: Hard refresh failed - ${error}`);
      throw error;
    }
  }

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

      await this.page.waitForSelector('.bcc-table-body', { timeout: 60000 });
      await this.page.waitForTimeout(2000);

      Logger.info('Surveillance: Soft refresh completed');
    } catch (error) {
      Logger.error(`Surveillance: Soft refresh failed - ${error}`);
    }
  }

  async extractOrders(): Promise<Order[]> {
    Logger.info('Surveillance: Extracting orders...');

    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    const orders: Order[] = [];

    try {
      await this.page.waitForSelector('.bcc-table-body__row', { timeout: 60000 });

      const rows = await this.page.$$('.bcc-table-body__row');
      Logger.info(`Surveillance: Found ${rows.length} rows in table`);

      for (const row of rows) {
        try {
          const cells = await row.$$('td');
          if (cells.length < 6) {
            Logger.warn('Surveillance: Row has less than 6 cells, skipping');
            continue;
          }

          const externalIdElement = cells[0];
          const externalId = await externalIdElement.innerText();
          if (!externalId || externalId.trim() === '') {
            Logger.debug('Surveillance: Empty external_id, skipping');
            continue;
          }

          const statusCell = cells[4];
          const statusElement = await statusCell.$('.bcc-tag__content');
          if (!statusElement) {
            Logger.debug('Surveillance: No status element, skipping');
            continue;
          }

          const statusText = await statusElement.innerText();
          const trimmedStatus = statusText.trim();

          let orderStatus: OrderStatus;
          if (trimmedStatus === 'Выдано') {
            orderStatus = 'READY_FOR_QR';
          } else if (trimmedStatus === 'Нужно подтвердить') {
            orderStatus = 'PENDING';
          } else {
            Logger.debug(`Surveillance: Status "${trimmedStatus}" not matched, skipping`);
            continue;
          }

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

  async runRotation(): Promise<Order[]> {
    Logger.info('Surveillance: Running rotation...');

    await this.login();

    await this.hardRefreshIfNeeded();
    await this.softRefresh();

    return await this.extractOrders();
  }

  async getNewOrders(): Promise<Order[]> {
    await this.login();
    await this.hardRefreshIfNeeded();
    await this.softRefresh();
    return await this.extractOrders();
  }

  async waitForSmsCode(): Promise<string> {
    this.smsCodePromise = new Promise<string>((resolve) => {
      this.resolveSmsCode = resolve;
    });
    return this.smsCodePromise;
  }

  public submitSmsCode(code: string): void {
    if (this.resolveSmsCode) {
      this.resolveSmsCode(code);
      this.resolveSmsCode = null;
      this.smsCodePromise = null;
      Logger.info(`Surveillance: SMS code received: ${code}`);
    }
  }

  public getIsWaitingForSms(): boolean {
    return this.isWaitingForSms;
  }

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
