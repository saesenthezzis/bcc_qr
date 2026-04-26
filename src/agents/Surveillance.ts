import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../utils/Logger';
import { sanitizeAmount } from '../utils/Sanitizer';
import { Order, OrderStatus, OrderData } from '../types';
import { getBccCode } from '../utils/InstallmentMapper';
import { EventEmitter } from 'events';
import { RegistryAgent } from './Registry';

export class SurveillanceAgent extends EventEmitter {
  private bankUrl: string;
  private bankLogin: string;
  private bankPassword: string;
  private readonly logger: Logger;
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
  private skipCallback: (() => Promise<string | null>) | null = null;
  private pauseCallback: ((paused: boolean) => void) | null = null;
  private isMonitoringPaused: boolean = false;

  constructor(bankUrl: string, bankLogin: string, bankPassword: string, logger: Logger, registry?: RegistryAgent) {
    super();
    this.bankUrl = bankUrl;
    this.bankLogin = bankLogin;
    this.bankPassword = bankPassword;
    this.logger = logger;
    this.storagePath = path.join(process.cwd(), 'storage');
    this.registry = registry || null;

    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }
  }

  setSkipCallback(callback: () => Promise<string | null>): void {
    this.skipCallback = callback;
  }

  setPauseCallback(callback: (paused: boolean) => void): void {
    this.pauseCallback = (paused: boolean) => {
      this.isMonitoringPaused = paused;
      callback(paused);
    };
  }

  public setMonitoringPaused(paused: boolean): void {
    this.isMonitoringPaused = paused;
  }

  public setRegistry(registry: RegistryAgent): void {
    this.registry = registry;
  }

  private async ensureCorrectUrl(): Promise<void> {
    if (!this.page) return;

    const currentUrl = this.page.url();
    const targetUrl = 'https://online.bcc.kz/cashier-cabinet/ru';

    if (currentUrl.includes('/en') || currentUrl.includes('404')) {
      this.logger.info(`Surveillance: Wrong URL (${currentUrl}), redirecting to /ru`);
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
          this.logger.warn(`Surveillance: Invalid session detected (${marker})`);
          return false;
        }
      }

      const hasTable = await this.page.isVisible('.bcc-table-body').catch(() => false);
      return hasTable;
    } catch (error) {
      this.logger.warn(`Surveillance: Session check failed - ${error}`);
      return false;
    }
  }

  async initBrowser(): Promise<void> {
    if (this.isBrowserInitialized) {
      this.logger.info('Surveillance: Browser already initialized');
      return;
    }

    this.logger.info('Surveillance: Initializing browser...');

    const sessionPath = path.join(this.storagePath, 'session.json');
      let storageState: { cookies: any[], origins: any[] } | undefined = undefined;

    if (this.registry) {
      const cloudSession = await this.registry.loadSessionFromDb();
      if (cloudSession) {
        storageState = cloudSession;
        this.logger.info('Surveillance: Loaded session from Supabase');
      }
    }

    if (!storageState && fs.existsSync(sessionPath)) {
      try {
        storageState = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
        this.logger.info('Surveillance: Loaded existing local session');
      } catch (error) {
        this.logger.warn('Surveillance: Failed to load local session');
      }
    }

    this.browser = await chromium.launch({
      headless: process.env.HEADLESS !== 'false',
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
    this.page.setDefaultTimeout(90000);
    this.page.setDefaultNavigationTimeout(90000);

    this.page.on('dialog', async (dialog) => {
      this.logger.info(`Surveillance: Dialog detected: ${dialog.message}`);
      await dialog.accept();
    });

    this.page.on('framenavigated', async () => {
      if (this.page) {
        await this.page.keyboard.press('Enter').catch(() => {});
      }
    });

    this.isBrowserInitialized = true;
    this.logger.info('Surveillance: Browser initialized (1920x1080)');
  }

  async login(): Promise<void> {
    this.logger.info('Surveillance: Starting login...');

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
      this.logger.info('Surveillance: Certificate popup dismissal attempted');

      await this.ensureCorrectUrl();

      // Даем время на загрузку "тяжелого" банка
      await this.page!.waitForTimeout(2000);
      await this.page!.waitForLoadState('networkidle');
      await this.page!.waitForTimeout(3000);

      const pageState = await this.detectPageState();

      if (pageState === 'LOGGED_IN') {
        this.logger.info('Surveillance: Already logged in (session restored)');
        await this.saveSession(sessionPath);
        return;
      }

      if (pageState === 'LOGIN_FORM') {
        this.logger.info('Surveillance: Login form detected, entering credentials');
        await this.performLogin(sessionPath);
        return;
      }

      if (pageState === 'SKELETON') {
        this.logger.info('Surveillance: Skeleton state detected, waiting for data...');
        // Ждем появления данных в таблице до 60 секунд
        try {
          await this.page!.waitForSelector('.bcc-table-body__row', { timeout: 60000, state: 'visible' });
          this.logger.info('Surveillance: Data loaded after skeleton wait');
          await this.saveSession(sessionPath);
          return;
        } catch (timeoutError) {
          this.logger.warn('Surveillance: Data did not appear after skeleton wait, reloading');
        }
      }

      if (pageState === 'UNKNOWN') {
        const currentUrl = this.page!.url();
        this.logger.warn(`Surveillance: Unknown page state. URL: ${currentUrl}`);

        // Patience Mode: 3 попытки с reload и ожиданием 60s
        for (let attempt = 1; attempt <= 3; attempt++) {
          this.logger.info(`Surveillance: Reload attempt ${attempt}/3 with 60s patience`);
          
          // Полная перезагрузка страницы
          await this.page!.reload({ 
            waitUntil: 'domcontentloaded',
            timeout: 60000 
          });
          await this.page!.waitForLoadState('networkidle', { timeout: 60000 });
          await this.page!.waitForTimeout(10000); // Даем время на загрузку данных

          const retryState = await this.detectPageState();
          
          if (retryState === 'LOGGED_IN') {
            this.logger.info('Surveillance: Table found after reload, considering as logged in');
            await this.saveSession(sessionPath);
            return;
          }
          
          if (retryState === 'LOGIN_FORM') {
            this.logger.info('Surveillance: Login form found after reload');
            await this.performLogin(sessionPath);
            return;
          }
          
          if (retryState === 'SKELETON') {
            this.logger.info(`Surveillance: Still skeleton on attempt ${attempt}, waiting more...`);
            try {
              await this.page!.waitForSelector('.bcc-table-body__row', { timeout: 60000, state: 'visible' });
              this.logger.info('Surveillance: Data loaded after skeleton wait');
              await this.saveSession(sessionPath);
              return;
            } catch (timeoutError) {
              this.logger.warn(`Surveillance: Skeleton timeout on attempt ${attempt}`);
            }
          }
        }

        this.logger.error('Surveillance: Cannot determine page state after 3 reload attempts');
        throw new Error(`Unknown page state at URL: ${currentUrl} after 3 reload attempts with 60s patience`);
      }

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (this.isWaitingForSms && (errorMsg.includes('Timeout') || errorMsg.includes('timeout'))) {
        this.logger.warn('Surveillance: Timeout while waiting, but SMS verification is in progress');
        throw error;
      }

      const isSessionValid = await this.checkSessionValid().catch(() => false);
      if (isSessionValid) {
        this.logger.warn('Surveillance: Error occurred but session appears valid, continuing');
        return;
      }

      this.logger.error(`Surveillance: Login failed - ${errorMsg}`);
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
          this.logger.debug('Surveillance: Table visible but no rows (skeleton detected)');
          return 'SKELETON';
        }
      }

      if (hasLoginField && !hasTable) {
        return 'LOGIN_FORM';
      }

      if (hasTable && hasLoginField) {
        this.logger.warn('Surveillance: Both table and login field visible, prioritizing table');
        return 'LOGGED_IN';
      }

      // Проверяем явный "скелетон" — серые блоки загрузки
      const hasSkeleton = await this.page!.isVisible('[class*="skeleton"]').catch(() => false) ||
                          await this.page!.isVisible('[class*="loading"]').catch(() => false);
      if (hasSkeleton) {
        this.logger.debug('Surveillance: Skeleton/loading state detected');
        return 'SKELETON';
      }

      return 'UNKNOWN';
    } catch (error) {
      this.logger.error(`Surveillance: Page state detection failed - ${error}`);
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
    this.logger.info('Surveillance: Login successful, session saved');
  }

  private async handleSmsVerification(sessionPath: string): Promise<boolean> {
    this.logger.info('Surveillance: Checking for SMS verification or table...');

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
        this.logger.debug('Surveillance: Table visible, SMS not required');
        return false;
      }

      if (smsFieldVisible) {
        this.logger.info('Surveillance: SMS verification required');
        return await this.processSmsVerification(SMS_SELECTORS, sessionPath);
      }

      this.logger.warn('Surveillance: Neither table nor SMS field visible, waiting...');
      await this.page!.waitForTimeout(3000);

      const retryTableVisible = await this.page!.isVisible('.bcc-table-body').catch(() => false);
      if (retryTableVisible) {
        return false;
      }

      const retrySmsVisible = await this.checkSmsFieldVisible(SMS_SELECTORS);
      if (retrySmsVisible) {
        return await this.processSmsVerification(SMS_SELECTORS, sessionPath);
      }

      this.logger.warn('Surveillance: Could not determine login result');
      return false;

    } catch (error) {
      this.logger.error(`Surveillance: SMS verification check failed - ${error}`);
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
      this.logger.warn('Surveillance: SMS fields not found, trying alternative selectors');
      for (const selector of smsSelectors) {
        const altInputs = await this.page!.$$(selector);
        if (altInputs.length > 0) {
          smsInputs.push(...altInputs);
        }
      }
    }

    if (smsInputs.length === 0) {
      this.logger.debug('Surveillance: No SMS input fields found');
      return false;
    }

    this.logger.info(`Surveillance: Found ${smsInputs.length} SMS input fields`);

    await this.page!.waitForTimeout(1000);

    try {
      await this.page!.waitForSelector('input.bcc-input-code__input', { state: 'visible', timeout: 60000 });
    } catch (e) {
      this.logger.warn('Surveillance: SMS input not fully visible, proceeding anyway');
    }

    const screenshotPath = path.join(this.storagePath, 'sms_screenshot.png');
    await this.page!.screenshot({
      path: screenshotPath,
      fullPage: false,
    });

    this.logger.info(`Surveillance: Screenshot saved to ${screenshotPath}`);

    const screenshotBuffer = fs.readFileSync(screenshotPath);
    this.emit('smsRequired', {
      screenshot: screenshotBuffer,
      timestamp: new Date().toISOString(),
    });

    try {
      fs.unlinkSync(screenshotPath);
      this.logger.debug(`Surveillance: Screenshot file cleaned up`);
    } catch (unlinkError) {
      this.logger.warn(`Surveillance: Failed to delete screenshot: ${unlinkError}`);
    }

    this.logger.info('Surveillance: Waiting for SMS code from admin...');
    this.isWaitingForSms = true;

    const smsCode = await this.waitForSmsCode();
    this.logger.info(`Surveillance: SMS code received: ${smsCode}`);

    try {
      const inputs = await this.page!.$$('input.bcc-input-code__input');

      if (inputs.length >= smsCode.length) {
        for (let i = 0; i < smsCode.length && i < inputs.length; i++) {
          await inputs[i].fill(smsCode[i]);
          await this.page!.waitForTimeout(100);
        }
        this.logger.info('Surveillance: SMS code entered into individual fields');
      } else {
        await this.page!.fill(smsSelectors[0], smsCode);
        this.logger.info('Surveillance: SMS code entered as single string');
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
          this.logger.info(`Surveillance: Submit button clicked (${selector})`);
          break;
        }
      }

      this.logger.info('Surveillance: SMS code submitted');

      try {
        await this.page!.waitForSelector('.bcc-modal', { state: 'hidden', timeout: 60000 });
        this.logger.info('Surveillance: SMS modal closed');
      } catch (modalError) {
        this.logger.debug('Surveillance: SMS modal not found or already hidden');
      }

      await this.page!.waitForSelector('.bcc-table-body', { timeout: 60000, state: 'visible' });
      this.logger.info('Surveillance: Table loaded after SMS verification');

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Surveillance: Error during SMS code submission - ${errorMsg}`);
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

      this.logger.info(`Surveillance: Phone field filled with ${phone}`);
    } catch (error) {
      this.logger.error(`Surveillance: Failed to fill phone field - ${error}`);
      throw error;
    }
  }

  private async saveSession(sessionPath: string): Promise<void> {
    if (!this.context) return;

    try {
      const state = await this.context.storageState();
      const stateJson = JSON.stringify(state, null, 2);

      fs.writeFileSync(sessionPath, stateJson);
      this.logger.info('Session saved to local file');

      if (this.registry) {
        await this.registry.saveSessionToDb(state);
        this.logger.info('Session synced to Supabase');
      }
    } catch (error) {
      this.logger.error(`Failed to save session: ${error}`);
    }
  }

  async syncSessionToCloud(): Promise<boolean> {
    if (!this.context || !this.registry) return false;

    try {
      const state = await this.context.storageState();
      const success = await this.registry.saveSessionToDb(state);
      if (success) {
        this.logger.info('Session manually synced to Supabase');
      }
      return success;
    } catch (error) {
      this.logger.error(`Failed to sync session: ${error}`);
      return false;
    }
  }

  async hardRefreshIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now - this.lastHardRefresh >= this.HARD_REFRESH_INTERVAL_MS) {
      this.logger.info('Surveillance: Performing hard refresh (15 min interval)');
      await this.hardRefresh();
      this.lastHardRefresh = now;
    }
  }

  async hardRefresh(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    try {
      this.logger.info('Surveillance: Hard refresh started...');

      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });

      try {
        await this.page.waitForSelector('.bcc-table-body__row', { state: 'visible', timeout: 90000 });
        this.logger.info('Surveillance: Page ready - table rows visible');
      } catch {
        this.logger.warn('Surveillance: Table not visible after reload, checking session...');
        const sessionValid = await this.checkSessionValid().catch(() => false);
        if (!sessionValid) {
          this.logger.warn('Surveillance: Session expired, re-logging in...');
          await this.login();
        }
      }

      await this.page.waitForTimeout(5000);
      this.logger.info('Surveillance: Hard refresh complete');
    } catch (error) {
      this.logger.error(`Surveillance: Hard refresh failed - ${error}`);
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
        this.logger.info('Surveillance: Soft refresh button clicked');
      } else {
        this.logger.warn('Surveillance: Soft refresh button not found');
      }

      await this.page.waitForSelector('.bcc-table-body', { timeout: 60000 });
      await this.page.waitForTimeout(2000);

      this.logger.info('Surveillance: Soft refresh completed');
    } catch (error) {
      this.logger.error(`Surveillance: Soft refresh failed - ${error}`);
    }
  }

  async extractOrders(): Promise<Order[]> {
    this.logger.info('Surveillance: Extracting orders...');

    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    const orders: Order[] = [];

    try {
      await this.page.waitForSelector('.bcc-table-body__row', { timeout: 60000 });

      const rows = await this.page.$$('.bcc-table-body__row');
      this.logger.info(`Surveillance: Found ${rows.length} rows in table`);

      for (const row of rows) {
        try {
          const cells = await row.$$('td');
          if (cells.length < 6) {
            this.logger.warn('Surveillance: Row has less than 6 cells, skipping');
            continue;
          }

          const externalIdElement = cells[0];
          const externalId = await externalIdElement.innerText();
          if (!externalId || externalId.trim() === '') {
            this.logger.debug('Surveillance: Empty external_id, skipping');
            continue;
          }

          const statusCell = cells[4];
          const statusElement = await statusCell.$('.bcc-tag__content');
          if (!statusElement) {
            this.logger.debug('Surveillance: No status element, skipping');
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
            this.logger.debug(`Surveillance: Status "${trimmedStatus}" not matched, skipping`);
            continue;
          }

          const amountCell = cells[5];
          const amountElement = await amountCell.$('p[class*="amount-with-currency-sign_amount"]');
          if (!amountElement) {
            this.logger.debug('Surveillance: No amount element, skipping');
            continue;
          }

          const amountRaw = await amountElement.innerText();
          const amount = sanitizeAmount(amountRaw);

          if (amount <= 0) {
            this.logger.warn(`Surveillance: Invalid amount ${amount} for order ${externalId}, skipping`);
            continue;
          }

          orders.push({ external_id: externalId.trim(), amount, status: orderStatus });
          this.logger.info(`Surveillance: Extracted order ${externalId} (${amount} KZT, ${orderStatus})`);

        } catch (error) {
          this.logger.warn(`Failed to parse row: ${error}`);
          continue;
        }
      }

      const readyCount = orders.filter(o => o.status === 'READY_FOR_QR').length;
      const pendingCount = orders.filter(o => o.status === 'PENDING').length;
      this.logger.info(`Surveillance: Extracted ${orders.length} orders (${readyCount} ready, ${pendingCount} pending)`);
    } catch (error) {
      this.logger.error(`Surveillance: Extraction failed - ${error}`);
      throw error;
    }

    return orders;
  }

  async runRotation(): Promise<Order[]> {
    this.logger.info('Surveillance: Running rotation...');

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
      this.logger.info(`Surveillance: SMS code received: ${code}`);
    }
  }

  public getIsWaitingForSms(): boolean {
    return this.isWaitingForSms;
  }

  async takeErrorScreenshot(label = 'critical_failure'): Promise<Buffer | null> {
    if (!this.page) {
      this.logger.warn(`Surveillance: No page available for error screenshot (${label})`);
      return null;
    }

    try {
      return await this.page.screenshot({ type: 'png', fullPage: true });
    } catch (error) {
      this.logger.error(`Surveillance: Failed to take error screenshot (${label}) - ${error}`);
      return null;
    }
  }

  async close(): Promise<void> {
    if (!this.browser) {
      this.isBrowserInitialized = false;
      return;
    }

    try {
      await this.browser.close();
      this.logger.info('Surveillance: Browser closed');
    } catch (error) {
      this.logger.warn(`Surveillance: Error while closing browser - ${error}`);
    } finally {
      this.browser = null;
      this.context = null;
      this.page = null;
      this.isBrowserInitialized = false;
    }
  }

  async restartBrowser(): Promise<void> {
    const sessionPath = path.join(this.storagePath, 'session.json');

    this.logger.info('Surveillance: Restarting browser...');

    try {
      await this.saveSession(sessionPath);
    } catch (error) {
      this.logger.warn(`Surveillance: Failed to save session before restart - ${error}`);
    }

    await this.close();
    await this.initBrowser();

    this.logger.info('Surveillance: Browser restarted');
  }

  // SMS Confirmation Methods

  async checkSmsConfirmationRequired(orderId: string): Promise<boolean> {
    // Mock mode
    if (process.env.BROWSER_MOCK === 'true') {
      this.logger.info(`[MOCK] Checking SMS confirmation for ${orderId} - returning true`);
      return true;
    }

    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    try {
      this.logger.info(`[INFO] Order ${orderId} needs confirmation. Opening sidebar to verify SMS button...`);

      // Step 1: Close any open sidebar first
      const backdropOpen = await this.page.$('.bcc-fridge-backdrop_open').catch(() => null);
      if (backdropOpen) {
        this.logger.info(`[INFO] Sidebar already open, closing it first...`);
        
        // Try multiple methods to close sidebar
        // Method 1: Click on backdrop
        try {
          await backdropOpen.click({ timeout: 2000 });
          this.logger.info(`[INFO] Clicked backdrop to close sidebar`);
          await this.page.waitForTimeout(1000);
        } catch (backdropError) {
          this.logger.warn(`[INFO] Failed to click backdrop, trying close button...`);
          
          // Method 2: Find and click close button
          const closeButton = await this.page.$('button[aria-label="Close"]').catch(() => null) ||
                              await this.page.$('.bcc-fridge button.bcc-button_iconOnly').catch(() => null);
          if (closeButton) {
            await closeButton.click({ timeout: 2000 }).catch(() => {});
            this.logger.info(`[INFO] Clicked close button`);
            await this.page.waitForTimeout(1000);
          } else {
            // Method 3: Escape key as last resort
            await this.page.keyboard.press('Escape');
            this.logger.info(`[INFO] Pressed Escape key`);
            await this.page.waitForTimeout(1000);
          }
        }
        
        // Verify sidebar is closed
        const stillOpen = await this.page.$('.bcc-fridge-backdrop_open').catch(() => null);
        if (stillOpen) {
          this.logger.warn(`[WARN] Sidebar still open after close attempt, forcing page refresh`);
          await this.page.reload({ waitUntil: 'networkidle' });
          await this.page.waitForTimeout(2000);
        }
      }

      // Find the order row
      const rows = await this.page.$$('.bcc-table-body__row');
      for (const row of rows) {
        const cells = await row.$$('td');
        if (cells.length < 1) continue;

        const idCell = cells[0];
        const rowId = (await idCell.innerText()).trim();

        if (rowId === orderId) {
          // Click to open sidebar
          this.logger.info(`[INFO] Clicking on order ${orderId} to open sidebar...`);
          await row.click();
          await this.page.waitForSelector('div.bcc-fridge_open', {
            state: 'visible',
            timeout: 30000
          });
          this.logger.info(`[INFO] Sidebar opened for order ${orderId}`);

          // Only after the sidebar is open do we wait for content to appear.
          try {
            await this.page.waitForSelector('div.bcc-fridge_content', { 
              state: 'visible', 
              timeout: 30000 
            });
            this.logger.info(`[INFO] Sidebar content loaded for order ${orderId}`);
          } catch (sidebarError) {
            this.logger.warn(`[INFO] Sidebar content not detected, continuing anyway...`);
          }

          // Allow footer actions to render after the panel opens.
          await this.page.waitForTimeout(1500);
          const smsButtonSelectors = [
            'div.bcc-fridge-footer button:has-text("Отправить SMS")',
            'button[data-pw="button"]:has-text("Отправить SMS")',
            'button:has-text("Отправить SMS")',
            'button.bcc-button:has-text("Отправить SMS")',
            'div.bcc-fridge button:has-text("Отправить")',
          ];

          let hasSmsButton = false;
          let foundSelector = '';

          // First attempt
          for (const selector of smsButtonSelectors) {
            const button = await this.page.$(selector);
            if (button) {
              // Check if button is actually visible and stable
              const isVisible = await button.isVisible().catch(() => false);
              if (isVisible) {
                hasSmsButton = true;
                foundSelector = selector;
                this.logger.info(`[INFO] ✅ SMS button FOUND with selector: ${selector}`);
                break;
              }
            }
          }

          // Retry if not found (bank UI might be slow)
          if (!hasSmsButton) {
            this.logger.info(`[INFO] SMS button not found on first attempt, retrying after 500ms...`);
            await this.page.waitForTimeout(500);

            for (const selector of smsButtonSelectors) {
              const button = await this.page.$(selector);
              if (button) {
                const isVisible = await button.isVisible().catch(() => false);
                if (isVisible) {
                  hasSmsButton = true;
                  foundSelector = selector;
                  this.logger.info(`[INFO] ✅ SMS button FOUND on retry with selector: ${selector}`);
                  break;
                }
              }
            }
          }

          // If still not found, take debug screenshot
          if (!hasSmsButton) {
            this.logger.warn(`[INFO] ❌ SMS button NOT FOUND for order ${orderId} after retry`);
            
            try {
              const screenshotPath = path.join(this.storagePath, `error_sms_button_not_found_${orderId}.png`);
              await this.page.screenshot({
                path: screenshotPath,
                fullPage: false,
              });
              this.logger.info(`[DEBUG] Screenshot saved to ${screenshotPath} for debugging`);
              this.emit('smsButtonNotFound', { orderId, screenshotPath });
            } catch (screenshotError) {
              this.logger.warn(`[DEBUG] Failed to save debug screenshot: ${screenshotError}`);
            }
          }

          if (!hasSmsButton) {
            this.logger.info(`[INFO] Closing sidebar for order ${orderId}`);
            await this.page.keyboard.press('Escape');
            await this.page.waitForTimeout(500);
          } else {
            this.logger.info(`[INFO] Keeping sidebar open for order ${orderId} to continue SMS flow`);
          }

          return hasSmsButton;
        }
      }

      this.logger.warn(`Surveillance: Order ${orderId} not found in table`);
      return false;
    } catch (error) {
      this.logger.error(`Surveillance: Failed to check SMS confirmation for ${orderId} - ${error}`);
      
      // Take error screenshot
      try {
        const screenshotPath = path.join(this.storagePath, `error_check_sms_${orderId}.png`);
        await this.page.screenshot({
          path: screenshotPath,
          fullPage: false,
        });
        this.logger.info(`[DEBUG] Error screenshot saved to ${screenshotPath}`);
      } catch (screenshotError) {
        this.logger.warn(`[DEBUG] Failed to save error screenshot: ${screenshotError}`);
      }

      return false;
    }
  }

  async clickSendSmsButton(orderId: string): Promise<boolean> {
    // Mock mode
    if (process.env.BROWSER_MOCK === 'true') {
      this.logger.info(`[MOCK] Кнопка "Отправить SMS" нажата для ${orderId}`);
      await new Promise(resolve => setTimeout(resolve, 500));
      return true;
    }

    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    try {
      this.logger.info(`Surveillance: Clicking Send SMS button for ${orderId}`);

      // Step 1: Check that sidebar is open
      await this.page.waitForSelector('div.bcc-fridge_open', { timeout: 5000 });

      // Define button selectors in order of priority
      const buttonSelectors = [
        'div.bcc-fridge-footer button[data-pw="button"]',
        'div.bcc-fridge-footer .bcc-button',
        '.bcc-fridge_open button[data-pw="button"]',
        'button:has-text("Отправить SMS")',
      ];

      // Step 2: Try each selector in order
      let buttonClicked = false;
      let usedSelector = '';
      for (const selector of buttonSelectors) {
        const button = await this.page.$(selector);
        if (button && await button.isVisible()) {
          await button.scrollIntoViewIfNeeded();
          await button.click();
          this.logger.info(`Surveillance: Send SMS button clicked with selector: ${selector}`);
          usedSelector = selector;
          buttonClicked = true;
          break;
        }
      }

      if (!buttonClicked) {
        this.logger.warn(`Surveillance: Send SMS button not found with any selector for ${orderId}`);
        return false;
      }

      // Step 3: Wait for modal to appear
      try {
        await this.page.waitForSelector(
          'div[data-pw="input-code-container"]',
          { state: 'visible', timeout: 30000 }
        );
      } catch (modalError) {
        this.logger.error(`Surveillance: Modal did not appear after clicking Send SMS button - ${modalError}`);
        return false;
      }

      this.logger.info(`Surveillance: Send SMS button clicked successfully with selector: ${usedSelector}`);
      return true;
    } catch (error) {
      this.logger.error(`Surveillance: Failed to click Send SMS button for ${orderId} - ${error}`);
      return false;
    }
  }

  async checkSmsBlockedModal(): Promise<boolean> {
    // Mock mode - never blocked in mock
    if (process.env.BROWSER_MOCK === 'true') {
      this.logger.info(`[MOCK] Checking SMS blocked modal - returning false (not blocked)`);
      return false;
    }

    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    try {
      // Check for blocked modal with multiple possible selectors
      const blockedSelectors = [
        'h4:has-text("Вы несколько раз ввели неверно SMS-код")',
        'text="Вы несколько раз ввели неверно SMS-код"',
        '.bcc-modal:has-text("SMS-код")',
      ];

      for (const selector of blockedSelectors) {
        const element = await this.page.$(selector);
        if (element) {
          const isVisible = await element.isVisible().catch(() => false);
          if (isVisible) {
            this.logger.warn('Surveillance: SMS blocked modal detected');
            return true;
          }
        }
      }

      return false;
    } catch (error) {
      this.logger.error(`Surveillance: Failed to check SMS blocked modal - ${error}`);
      return false;
    }
  }

  async checkSmsErrorModal(): Promise<{ error: boolean, isBlocked: boolean }> {
    // Mock mode - never return errors in mock
    if (process.env.BROWSER_MOCK === 'true') {
      this.logger.info(`[MOCK] Checking SMS error modal - returning { error: false, isBlocked: false }`);
      return { error: false, isBlocked: false };
    }

    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    const result = { error: false, isBlocked: false };

    // Check only snackbar
    const snackbar = await this.page.$('.bcc-snackbar');
    if (snackbar && await snackbar.isVisible()) {
      const text = await snackbar.textContent() ?? '';
      if (text.includes('Сессия истекла')) {
        return { error: true, isBlocked: false };
      }
    }

    // Check only modal with error
    const errorModal = await this.page.$('.bcc-modal.bcc-modal_show');
    if (errorModal && await errorModal.isVisible()) {
      const text = await errorModal.textContent() ?? '';
      const isBlocked = text.includes('заблокировали') || text.includes('24 часа');
      const isError = text.includes('неверно') || text.includes('ошибка') || isBlocked;
      if (isError) return { error: true, isBlocked };
    }

    return result;
  }

  async waitForSuccessPopup(): Promise<boolean> {
    // Mock mode - return true immediately
    if (process.env.BROWSER_MOCK === 'true') {
      this.logger.info(`[MOCK] Waiting for success popup - returning true`);
      return true;
    }

    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    try {
      await this.page.waitForSelector(
        '.bcc-snackbar, div:has-text("Заявка подтверждена")',
        { state: 'visible', timeout: 30000 }
      );
      return true;
    } catch {
      // Попап не появился — проверяем закрылась ли модалка
      const modal = await this.page.$('.bcc-modal.bcc-modal_show');
      if (!modal) return true; // модалка закрылась = успех
      return false;
    }
  }

  async closeSmsBlockedModal(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    try {
      this.logger.info('Surveillance: Closing SMS blocked modal');

      // Try to find and click close button
      const closeSelectors = [
        'div.bcc-modal_container button',
        'button.bcc-button:has-text("Закрыть")',
        'button.bcc-button:has-text("ОК")',
        '.bcc-modal button[aria-label="Close"]',
      ];

      for (const selector of closeSelectors) {
        const button = await this.page.$(selector);
        if (button) {
          await button.click();
          this.logger.info('Surveillance: SMS blocked modal closed');
          await this.page.waitForTimeout(1000);
          return;
        }
      }

      // Fallback: press Escape
      await this.page.keyboard.press('Escape');
      this.logger.info('Surveillance: SMS blocked modal closed with Escape');
      await this.page.waitForTimeout(1000);
    } catch (error) {
      this.logger.error(`Surveillance: Failed to close SMS blocked modal - ${error}`);
    }
  }

  async enterSmsCode(code: string, orderId: string): Promise<boolean> {
    // Mock mode
    if (process.env.BROWSER_MOCK === 'true') {
      this.logger.info(`[MOCK] СМС-код "${code}" введен для ${orderId}, имитация успеха`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      this.logger.info(`[MOCK] Статус заявки ${orderId} изменен на "Выдано"`);
      return true;
    }

    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    try {
      this.logger.info(`Surveillance: Entering SMS code for ${orderId}`);

      // Find the container: div[data-pw="input-code-container"]
      const container = await this.page.$('div[data-pw="input-code-container"]');
      if (!container) {
        this.logger.warn('Surveillance: SMS input container not found');
        return false;
      }

      // Inside the container find all input fields
      const inputs = await container.$$('input');
      if (inputs.length === 0) {
        this.logger.warn('Surveillance: No input fields found in container');
        return false;
      }

      // For each digit, click the input field and use keyboard press
      for (let i = 0; i < code.length && i < inputs.length; i++) {
        await inputs[i].click();
        await this.page.keyboard.press(code[i]);
        await this.page.waitForTimeout(150);
      }
      this.logger.info('Surveillance: SMS code entered into individual fields using keyboard press');

      // Wait for frontend validation to process the completed code
      await this.page.waitForTimeout(500);
      this.logger.info('Surveillance: Waited 500ms for frontend validation after code entry');

      return true;
    } catch (error) {
      this.logger.error(`Surveillance: Failed to enter SMS code for ${orderId} - ${error}`);
      return false;
    }
  }

  async takeSmsScreenshot(orderId: string, type: 'input' | 'blocked'): Promise<Buffer | null> {
    // Mock mode - create a simple mock screenshot
    if (process.env.BROWSER_MOCK === 'true') {
      this.logger.info(`[MOCK] Creating mock screenshot for ${orderId} (${type})`);
      // Create a simple 1x1 PNG buffer as mock
      const mockPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
      return mockPng;
    }

    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    try {
      this.logger.info('Surveillance: Looking for modal element for screenshot...');
      
      // Wait for the modal to be fully rendered before taking screenshot
      await this.page.waitForSelector('div.bcc-modal.bcc-modal_show, div[role="dialog"]', { timeout: 5000 });
      
      // Try to get the specific modal element first
      const modal = await this.page.$('div[role="dialog"], div.bcc-modal.bcc-modal_show');
      this.logger.info(`Surveillance: Modal found: ${!!modal}`);
      
      let buffer: Buffer;
      
      if (!modal) {
        // fallback — скриншот всей страницы
        this.logger.info('Surveillance: Taking screenshot of full page as fallback');
        const screenshotPath = path.join(this.storagePath, `sms_${type}_${orderId}.png`);
        await this.page.screenshot({
          path: screenshotPath,
          type: 'png'
        });
        buffer = fs.readFileSync(screenshotPath);
        
        // Clean up file
        try {
          fs.unlinkSync(screenshotPath);
        } catch (unlinkError) {
          this.logger.warn(`Surveillance: Failed to delete screenshot: ${unlinkError}`);
        }
      } else {
        // Take screenshot of the modal element
        this.logger.info('Surveillance: Taking screenshot of modal element');
        buffer = await modal.screenshot({ type: 'png' });
      }
      
      this.logger.info('Surveillance: Screenshot taken for modal');
      return buffer;
    } catch (error) {
      this.logger.error(`Surveillance: Failed to take screenshot for ${orderId} - ${error}`);
      return null;
    }
  }

  async clickConfirmButton(orderId: string): Promise<{ success: boolean; debugScreenshot?: Buffer }> {
    if (!this.page) throw new Error('Page not initialized');

    // Mock mode
    if (process.env.BROWSER_MOCK === 'true') {
      this.logger.info(`[MOCK] Confirm button clicked for ${orderId}`);
      return { success: true };
    }

    const MAX_CLICK_ATTEMPTS = 3;
    const MODAL_DISAPPEAR_TIMEOUT = 5000;

    try {
      this.logger.info(`Surveillance: Looking for confirm button for ${orderId}...`);

      // Multiple locator strategies — dialog-scoped first, then broader
      const buttonSelectors = [
        'div[role="dialog"] button:has-text("Подтвердить")',
        'div.bcc-modal_show button:has-text("Подтвердить")',
        'button[data-pw="submit-button"]',
        'div[role="dialog"] button[type="submit"]',
        'div.bcc-modal_show button[type="submit"]',
        'button:has-text("Подтвердить")',
      ];

      let confirmButton = null;
      let usedSelector = '';

      for (const selector of buttonSelectors) {
        const btn = await this.page.$(selector);
        if (btn) {
          const isVisible = await btn.isVisible().catch(() => false);
          if (isVisible) {
            confirmButton = btn;
            usedSelector = selector;
            this.logger.info(`Surveillance: Confirm button found with selector: ${selector}`);
            break;
          }
        }
      }

      if (!confirmButton) {
        this.logger.error(`Surveillance: Confirm button NOT FOUND for ${orderId} with any selector`);
        try {
          const screenshotPath = path.join(this.storagePath, `error_confirm_btn_${orderId}.png`);
          await this.page.screenshot({ path: screenshotPath, fullPage: false });
          this.logger.info(`Surveillance: Debug screenshot saved to ${screenshotPath}`);
        } catch (screenshotErr) {
          this.logger.warn(`Surveillance: Failed to save debug screenshot: ${screenshotErr}`);
        }
        return { success: false };
      }

      // Wait for button to become enabled (frontend validates code first)
      this.logger.info(`Surveillance: Waiting for confirm button to become enabled...`);
      const enabledTimeout = 30000;
      const pollInterval = 300;
      const startTime = Date.now();

      while (Date.now() - startTime < enabledTimeout) {
        const isDisabled = await confirmButton.isDisabled().catch(() => true);
        if (!isDisabled) {
          this.logger.info(`Surveillance: Confirm button is now ENABLED (waited ${Date.now() - startTime}ms)`);
          break;
        }
        await this.page.waitForTimeout(pollInterval);
      }

      // Final check — if still disabled, log warning but attempt click anyway
      const stillDisabled = await confirmButton.isDisabled().catch(() => false);
      if (stillDisabled) {
        this.logger.warn(`Surveillance: Confirm button still DISABLED after ${enabledTimeout}ms. Attempting click anyway...`);
      }

      // Click with retry and modal disappearance verification
      for (let attempt = 1; attempt <= MAX_CLICK_ATTEMPTS; attempt++) {
        this.logger.info(`Surveillance: Clicking confirm button (attempt ${attempt}/${MAX_CLICK_ATTEMPTS}) using ${usedSelector}`);

        // Scroll into view to ensure button is in viewport
        await confirmButton.scrollIntoViewIfNeeded();
        await this.page.waitForTimeout(200);

        // Click the button
        await confirmButton.click();
        this.logger.info(`Surveillance: Confirm button clicked for ${orderId} (attempt ${attempt})`);

        // Post-condition: verify the modal disappears
        try {
          await Promise.race([
            this.page.waitForSelector('div[role="dialog"]', { state: 'hidden', timeout: MODAL_DISAPPEAR_TIMEOUT }).catch(() => null),
            this.page.waitForSelector('div.bcc-modal.bcc-modal_show', { state: 'hidden', timeout: MODAL_DISAPPEAR_TIMEOUT }).catch(() => null),
            this.page.waitForSelector('div[data-pw="input-code-container"]', { state: 'hidden', timeout: MODAL_DISAPPEAR_TIMEOUT }).catch(() => null),
          ]);

          // Double-check: is the modal actually gone?
          const dialogVisible = await this.page.$('div[role="dialog"]').then(el => el?.isVisible()).catch(() => false);
          const modalVisible = await this.page.$('div.bcc-modal.bcc-modal_show').then(el => el?.isVisible()).catch(() => false);

          if (!dialogVisible && !modalVisible) {
            this.logger.info(`Surveillance: ✅ Modal disappeared after confirm click for ${orderId}`);
            return { success: true };
          }

          this.logger.warn(`Surveillance: Modal still visible after attempt ${attempt} for ${orderId}`);
        } catch (waitError) {
          this.logger.warn(`Surveillance: Modal disappearance check failed on attempt ${attempt}: ${waitError}`);
        }

        // After 2nd failed attempt — take debug screenshot for admin validation
        let failureScreenshot: Buffer | undefined;
        if (attempt === 2) {
          this.logger.warn(`Surveillance: 2 attempts failed for ${orderId}, capturing debug screenshot for admin...`);
          try {
            failureScreenshot = await this.page.screenshot({ type: 'png', fullPage: false });
            this.logger.info(`Surveillance: Debug screenshot captured after 2 failed attempts for ${orderId}`);
          } catch (screenshotErr) {
            this.logger.warn(`Surveillance: Failed to capture debug screenshot: ${screenshotErr}`);
          }
        }

        // Check for error modals before retrying
        const errorCheck = await this.checkSmsErrorModal();
        if (errorCheck.error) {
          this.logger.error(`Surveillance: Error modal detected after confirm click for ${orderId}, isBlocked: ${errorCheck.isBlocked}`);
          return { success: false, debugScreenshot: failureScreenshot };
        }

        // Re-find the button for next attempt (DOM may have changed)
        if (attempt < MAX_CLICK_ATTEMPTS) {
          this.logger.info(`Surveillance: Re-locating confirm button for retry...`);
          await this.page.waitForTimeout(500);

          confirmButton = null;
          for (const selector of buttonSelectors) {
            const btn = await this.page.$(selector);
            if (btn) {
              const isVisible = await btn.isVisible().catch(() => false);
              if (isVisible) {
                confirmButton = btn;
                usedSelector = selector;
                break;
              }
            }
          }

          if (!confirmButton) {
            // Button gone — check if modal also closed (success case)
            const finalDialogCheck = await this.page.$('div[role="dialog"]').then(el => el?.isVisible()).catch(() => false);
            const finalModalCheck = await this.page.$('div.bcc-modal.bcc-modal_show').then(el => el?.isVisible()).catch(() => false);

            if (!finalDialogCheck && !finalModalCheck) {
              this.logger.info(`Surveillance: ✅ Button and modal both gone — treating as success for ${orderId}`);
              return { success: true };
            }

            this.logger.error(`Surveillance: Confirm button disappeared but modal still visible for ${orderId}`);
            return { success: false };
          }
        }
      }

      // All attempts exhausted — take final screenshot for admin
      this.logger.error(`Surveillance: ❌ Failed to confirm after ${MAX_CLICK_ATTEMPTS} attempts for ${orderId}`);
      let finalScreenshot: Buffer | undefined;
      try {
        finalScreenshot = await this.page.screenshot({ type: 'png', fullPage: false });
      } catch (e) {
        this.logger.warn(`Surveillance: Failed to take final screenshot: ${e}`);
      }
      return { success: false, debugScreenshot: finalScreenshot };
    } catch (error) {
      this.logger.error(`Surveillance: Failed to click confirm button for ${orderId} - ${error}`);
      return { success: false };
    }
  }

  async verifySmsCompletion(orderId: string): Promise<boolean> {
    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    try {
      // Check 1: Modal disappeared
      const modalVisible = await this.page.$('.bcc-modal.bcc-modal_show').catch(() => null);
      if (modalVisible) {
        this.logger.debug(`Surveillance: Modal still visible for ${orderId}`);
        return false;
      }

      // Check 2: SMS input field disappeared
      const inputVisible = await this.page.$('input.bcc-input-code__input').catch(() => null);
      if (inputVisible) {
        this.logger.debug(`Surveillance: SMS input still visible for ${orderId}`);
        return false;
      }

      // Check 3: Refresh and check status changed to "Выдано"
      await this.softRefresh();
      await this.page.waitForTimeout(2000);

      const orders = await this.extractOrders();
      const order = orders.find(o => o.external_id === orderId);

      if (order && order.status === 'READY_FOR_QR') {
        this.logger.info(`Surveillance: SMS completion verified for ${orderId} - status is READY_FOR_QR`);
        return true;
      }

      this.logger.debug(`Surveillance: Order ${orderId} status not yet READY_FOR_QR`);
      return false;
    } catch (error) {
      this.logger.error(`Surveillance: Failed to verify SMS completion for ${orderId} - ${error}`);
      return false;
    }
  }

  async closeSidebar(orderId: string): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    try {
      // Try to click close button: div.bcc-fridge-header__close button
      const closeButton = await this.page.$('div.bcc-fridge-header__close button');
      if (closeButton) {
        await closeButton.click();
        this.logger.info(`[PROD] Order ${orderId} -> Sidebar closed`);
        await this.page.waitForTimeout(500);
        return;
      }
      
      // Fallback: try .bcc-button_iconOnly in header
      const iconButton = await this.page.$('.bcc-fridge-header .bcc-button_iconOnly');
      if (iconButton) {
        await iconButton.click();
        this.logger.info(`[PROD] Order ${orderId} -> Sidebar closed (icon button)`);
        await this.page.waitForTimeout(500);
        return;
      }
      
      // Last resort: Escape key
      await this.page.keyboard.press('Escape');
      this.logger.info(`[PROD] Order ${orderId} -> Sidebar closed (Escape)`);
      await this.page.waitForTimeout(500);
      
    } catch (error) {
      this.logger.warn(`[PROD] Order ${orderId} -> Error closing sidebar: ${error}`);
      // Try Escape as last resort
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(500);
    }
  }

  async parseInstallmentPeriodFromSidebar(orderId: string): Promise<string | null> {
    try {
      if (!this.page) {
        this.logger.warn(`[PROD] Order ${orderId} -> Page not available for sidebar parsing`);
        return null;
      }

      this.logger.info(`[PROD] Order ${orderId} -> Opening sidebar to parse installment period...`);
      
      // Use the existing openSidebarForOrder method for consistency
      const sidebarOpened = await this.openSidebarForOrder(orderId);
      if (!sidebarOpened) {
        this.logger.warn(`[PROD] Order ${orderId} -> Failed to open sidebar`);
        return null;
      }

      // Parse installment period using precise selector
      try {
        // Try precise selector first: div:has(> span:text("Рассрочка")) >> span.bcc-typography-paragraph_view_medium
        const installmentElement = await this.page.$('div:has(> span:text("Рассрочка")) span.bcc-typography-paragraph_view_medium');
        
        if (installmentElement) {
          const installmentText = await installmentElement.innerText();
          
          // Parse the value (e.g., "18 мес." -> "18 месяцев")
          const periodMatch = installmentText.match(/(\d+)\s*(месяц|месяца|месяцев|мес\.?)/i);
          if (periodMatch) {
            const installmentPeriod = `${periodMatch[1]} месяцев`;
            const bccCode = getBccCode(installmentPeriod);
            this.logger.info(`[PROD] Order ${orderId} -> Term: ${periodMatch[1]}m -> Code: ${bccCode}`);
            
            // Close sidebar using close button
            await this.closeSidebar(orderId);
            
            return installmentPeriod;
          }
        }
      } catch (selectorError) {
        this.logger.warn(`[PROD] Order ${orderId} -> Precise selector failed, trying fallback`);
      }

      // Fallback: search in all text
      const bodyText = await this.page.textContent('body');
      if (bodyText) {
        const periodMatch = bodyText.match(/(\d+)\s*(месяц|месяца|месяцев|мес\.?)/i);
        if (periodMatch) {
          const installmentPeriod = `${periodMatch[1]} месяцев`;
          const bccCode = getBccCode(installmentPeriod);
          this.logger.info(`[PROD] Order ${orderId} -> Term: ${periodMatch[1]}m (fallback) -> Code: ${bccCode}`);
          
          // Close sidebar
          await this.closeSidebar(orderId);
          
          return installmentPeriod;
        }
      }

      this.logger.warn(`[PROD] Order ${orderId} -> Installment period not found`);
      
      // Close sidebar anyway
      await this.closeSidebar(orderId);
      
      // Return null instead of default value
      return null;
      
    } catch (error) {
      this.logger.error(`[PROD] Order ${orderId} -> Failed to parse installment period: ${error}`);
      
      // Try to close sidebar
      try {
        if (this.page) await this.closeSidebar(orderId);
      } catch (closeError) {
        this.logger.warn(`[PROD] Order ${orderId} -> Could not close sidebar: ${closeError}`);
      }
      
      // Return null instead of default value
      return null;
    }
  }

  async checkSmsButtonExists(): Promise<boolean> {
    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    // Mock mode
    if (process.env.BROWSER_MOCK === 'true') {
      this.logger.info('[MOCK] checkSmsButtonExists — returning true');
      return true;
    }

    try {
      // Allow footer actions to render
      await this.page.waitForTimeout(1500);

      const smsButtonSelectors = [
        'div.bcc-fridge-footer button:has-text("Отправить SMS")',
        'button[data-pw="button"]:has-text("Отправить SMS")',
        'button:has-text("Отправить SMS")',
        'button.bcc-button:has-text("Отправить SMS")',
        'div.bcc-fridge button:has-text("Отправить")',
      ];

      // First attempt
      for (const selector of smsButtonSelectors) {
        const button = await this.page.$(selector);
        if (button) {
          const isVisible = await button.isVisible().catch(() => false);
          if (isVisible) {
            this.logger.info(`[INFO] ✅ SMS button FOUND with selector: ${selector}`);
            return true;
          }
        }
      }

      // Retry after short delay
      await this.page.waitForTimeout(500);
      for (const selector of smsButtonSelectors) {
        const button = await this.page.$(selector);
        if (button) {
          const isVisible = await button.isVisible().catch(() => false);
          if (isVisible) {
            this.logger.info(`[INFO] ✅ SMS button FOUND on retry with selector: ${selector}`);
            return true;
          }
        }
      }

      this.logger.warn('[INFO] ❌ SMS button NOT FOUND in sidebar');
      return false;
    } catch (error) {
      this.logger.error(`Surveillance: checkSmsButtonExists failed - ${error}`);
      return false;
    }
  }

  async prepareOrderData(orderId: string): Promise<OrderData> {
    const installmentPeriod = await this.parseInstallmentPeriodFromSidebar(orderId);
    return { installmentPeriod };
  }

  async openSidebarForOrder(orderId: string): Promise<boolean> {
    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    try {
      this.logger.info(`Surveillance: Opening sidebar for order ${orderId}`);

      // Find the order row by searching for the last 4 digits in any cell of the row
      const last4 = orderId.slice(-4);
      await this.page.waitForSelector('.bcc-table-body__row', { state: 'visible', timeout: 90000 });
      await this.page.waitForTimeout(2000);
      const rows = await this.page.$$('.bcc-table-body__row');
      for (const row of rows) {
        const rowText = await row.innerText();
        if (rowText.includes(last4)) {
          // Click the row to open the sidebar
          await row.click();
          await this.page.waitForTimeout(2000); // Wait for sidebar to open

          // Wait for the sidebar to be visible (using the open class)
          try {
            await this.page.waitForSelector('div.bcc-fridge_open', {
              state: 'visible',
              timeout: 30000
            });
            this.logger.info(`Surveillance: Sidebar opened for order ${orderId}`);
            return true;
          } catch (error) {
            this.logger.warn(`Surveillance: Sidebar not visible for order ${orderId}`);
            return false;
          }
        }
      }

      this.logger.warn(`Surveillance: Order ${orderId} not found in table (searched for last 4 digits: ${last4})`);
      return false;
    } catch (error) {
      this.logger.error(`Surveillance: Failed to open sidebar for order ${orderId} - ${error}`);
      return false;
    }
  }

  getRegistry(): RegistryAgent | null {
    return this.registry;
  }

  // Getters for callback functions to be used by Dispatcher
  getSkipCallback(): (() => Promise<string | null>) | null {
    return this.skipCallback || null;
  }

  getPauseCallback(): ((paused: boolean) => void) | null {
    return this.pauseCallback || null;
  }

  async getStatus(): Promise<{ isProcessingSms: boolean; currentSmsOrderId: string | null; isMonitoringPaused: boolean }> {
    if (!this.registry) {
      return { isProcessingSms: false, currentSmsOrderId: null, isMonitoringPaused: this.isMonitoringPaused };
    }
    
    try {
      const lockInfo = await this.registry.getSmsLockStatus();
      return {
        isProcessingSms: lockInfo.isLocked,
        currentSmsOrderId: lockInfo.orderId,
        isMonitoringPaused: this.isMonitoringPaused,
      };
    } catch (error) {
      this.logger.error(`Surveillance: Failed to get SMS lock status - ${error}`);
      return { isProcessingSms: false, currentSmsOrderId: null, isMonitoringPaused: this.isMonitoringPaused };
    }
  }

}
