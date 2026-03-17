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
  private readonly HARD_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
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

    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }
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
    if (fs.existsSync(sessionPath)) {
      try {
        storageState = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
        Logger.info('Surveillance: Loaded existing session');
      } catch (error) {
        Logger.warn('Surveillance: Failed to load session, will login fresh');
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
      await this.page!.goto('https://online.bcc.kz/cashier-cabinet/ru', { waitUntil: 'networkidle', timeout: 60000 });

      await this.page!.waitForTimeout(500);
      for (let i = 0; i < 3; i++) {
        await this.page!.keyboard.press('Enter').catch(() => {});
        await this.page!.waitForTimeout(200);
      }
      Logger.info('Surveillance: Certificate popup dismissal attempted');

      await this.ensureCorrectUrl();

      await this.page!.waitForTimeout(1000);
      await this.page!.waitForLoadState('networkidle');

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

      if (pageState === 'UNKNOWN') {
        const currentUrl = this.page!.url();
        Logger.warn(`Surveillance: Unknown page state. URL: ${currentUrl}`);
        
        const tableVisible = await this.page!.isVisible('.bcc-table-body').catch(() => false);
        if (tableVisible) {
          Logger.info('Surveillance: Table found, considering as logged in');
          await this.saveSession(sessionPath);
          return;
        }
        
        Logger.error('Surveillance: Cannot determine page state, table not found');
        throw new Error(`Unknown page state at URL: ${currentUrl}`);
      }

    } catch (error) {
      const errorMessage = String(error);
      if (this.isWaitingForSms && (errorMessage.includes('Timeout') || errorMessage.includes('timeout'))) {
        Logger.warn('Surveillance: Timeout while waiting, but SMS verification is in progress');
        throw error;
      }
      
      const isSessionValid = await this.checkSessionValid().catch(() => false);
      if (isSessionValid) {
        Logger.warn('Surveillance: Error occurred but session appears valid, continuing');
        return;
      }
      
      Logger.error(`Surveillance: Login failed - ${error}`);
      throw error;
    }
  }

  private async detectPageState(): Promise<'LOGGED_IN' | 'LOGIN_FORM' | 'UNKNOWN'> {
    try {
      const [hasTable, hasLoginField] = await Promise.all([
        this.page!.isVisible('.bcc-table-body').catch(() => false),
        this.page!.isVisible('input#username').catch(() => false),
      ]);

      if (hasTable && !hasLoginField) {
        return 'LOGGED_IN';
      }

      if (hasLoginField && !hasTable) {
        return 'LOGIN_FORM';
      }

      if (hasTable && hasLoginField) {
        Logger.warn('Surveillance: Both table and login field visible, prioritizing table');
        return 'LOGGED_IN';
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
      await this.page!.waitForSelector('.bcc-table-body', { timeout: 30000 });
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
      await this.page!.waitForSelector('input.bcc-input-code__input', { state: 'visible', timeout: 5000 });
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
        await this.page!.waitForSelector('.bcc-modal', { state: 'hidden', timeout: 10000 });
        Logger.info('Surveillance: SMS modal closed');
      } catch (modalError) {
        Logger.debug('Surveillance: SMS modal not found or already hidden');
      }

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
    if (this.context) {
      const state = await this.context.storageState();
      fs.writeFileSync(sessionPath, JSON.stringify(state, null, 2));
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
      await this.page.waitForSelector('.bcc-table-body', { timeout: 10000 });
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

      await this.page.waitForSelector('.bcc-table-body', { timeout: 10000 });
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
      await this.page.waitForSelector('.bcc-table-body__row', { timeout: 10000 });

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
