import { chromium, Browser, BrowserContext, ElementHandle, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import { Logger } from '../utils/Logger';
import { sanitizeAmount } from '../utils/Sanitizer';
import { Order, OrderStatus, OrderData, SmsCodeResult } from '../types';
import { getBccCode } from '../utils/InstallmentMapper';
import { EventEmitter } from 'events';
import { RegistryAgent } from './Registry';

const SMS_CODE_DIALOG = 'div[data-pw="input-code-container"]';
const SMS_BLOCKED_MARKERS = ['несколько раз ввели неверно', 'заблокир'];
const ACCESS_DENIED_MARKERS = ['доступ ограничен', 'не верифицирован как кассир', 'кассир', 'not verified as cashier', 'access denied'];
const CONFIRM_BUTTON_SELECTORS = [
  'div[role="dialog"] button:has-text("Подтвердить")',
  'div.bcc-modal_show button:has-text("Подтвердить")',
  'button[data-pw="submit-button"]',
  'div[role="dialog"] button[type="submit"]',
  'div.bcc-modal_show button[type="submit"]',
];

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
    const targetUrl = 'https://online.bcc.kz/cashier-cabinet';

    if (currentUrl.includes('/en') || currentUrl.includes('404')) {
      this.logger.info(`Surveillance: Wrong URL (${currentUrl}), redirecting to /cashier-cabinet`);
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

      // Access denied page = invalid session (cashier not verified)
      if (bodyText.toLowerCase().includes('доступ ограничен') || bodyText.toLowerCase().includes('не верифицирован')) {
        this.logger.warn('Surveillance: Access denied page detected in session check');
        return false;
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
        await this.page.keyboard.press('Enter').catch(() => { });
      }
    });

    this.isBrowserInitialized = true;
    this.logger.info('Surveillance: Browser initialized (1920x1080)');
    await this.takeDebugScreenshot('browser_initialized');
  }

  async login(): Promise<void> {
    this.logger.info('Surveillance: Starting login...');

    if (!this.isBrowserInitialized) {
      await this.initBrowser();
    }

    const sessionPath = path.join(this.storagePath, 'session.json');

    try {
      // Patience Mode: ждем полную загрузку страницы
      await this.page!.goto('https://online.bcc.kz/cashier-cabinet', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });

      // Ждём появления ключевых элементов (таблица или форма логина)
      await this.waitForPageReady();

      await this.page!.waitForTimeout(500);
      for (let i = 0; i < 3; i++) {
        await this.page!.keyboard.press('Enter').catch(() => { });
        await this.page!.waitForTimeout(200);
      }
      this.logger.info('Surveillance: Certificate popup dismissal attempted');

      await this.ensureCorrectUrl();

      // Даем время на рендеринг после certificate popup
      await this.page!.waitForTimeout(2000);

      const pageState = await this.detectPageState();

      if (pageState === 'LOGGED_IN') {
        this.logger.info('Surveillance: Already logged in (session restored)');
        await this.saveSession(sessionPath);
        await this.takeDebugScreenshot('login_restored');
        return;
      }

      if (pageState === 'LOGIN_FORM') {
        this.logger.info('Surveillance: Login form detected, entering credentials');
        await this.performLogin(sessionPath);
        await this.takeDebugScreenshot('login_performed');
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

      if (pageState === 'ACCESS_DENIED') {
        this.logger.warn('Surveillance: Access denied — cashier not verified, reloading...');
        await this.takeDebugScreenshot('access_denied');
        // Attempt 1: hard reload
        await this.page!.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.page!.waitForTimeout(5000);
        const retryState = await this.detectPageState();
        if (retryState !== 'ACCESS_DENIED') {
          // Page recovered, continue with normal flow
          if (retryState === 'LOGGED_IN') { await this.saveSession(sessionPath); return; }
          if (retryState === 'LOGIN_FORM') { await this.performLogin(sessionPath); return; }
        }
        // Attempt 2: reload again
        this.logger.warn('Surveillance: Still ACCESS_DENIED after reload, retrying...');
        await this.page!.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.page!.waitForTimeout(5000);
        const retryState2 = await this.detectPageState();
        if (retryState2 !== 'ACCESS_DENIED') {
          if (retryState2 === 'LOGGED_IN') { await this.saveSession(sessionPath); return; }
          if (retryState2 === 'LOGIN_FORM') { await this.performLogin(sessionPath); return; }
        }
        // Both attempts failed — reinitialize browser and re-login
        this.logger.warn('Surveillance: ACCESS_DENIED persists after 2 reloads, reinitializing browser');
        await this.restartBrowser();
        await this.performLogin(sessionPath);
        return;
      }

      if (pageState === 'UNKNOWN') {
        const currentUrl = this.page!.url();
        this.logger.warn(`Surveillance: Unknown page state. URL: ${currentUrl}`);
        await this.takeDebugScreenshot('unknown_page');

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

  private async waitForPageReady(): Promise<void> {
    try {
      // Ждём появления любого из ключевых элементов: таблица, форма логина, или скелетон
      await Promise.race([
        this.page!.waitForSelector('.bcc-table-body', { state: 'visible', timeout: 60000 }),
        this.page!.waitForSelector('input#username', { state: 'visible', timeout: 60000 }),
        this.page!.waitForSelector('[class*="skeleton"]', { state: 'visible', timeout: 60000 }),
        this.page!.waitForSelector('[class*="loading"]', { state: 'visible', timeout: 60000 }),
      ]);
      this.logger.info('Surveillance: Page ready - key element detected');
    } catch {
      this.logger.warn('Surveillance: No key elements found within 60s, proceeding anyway');
    }
  }

  private async detectPageState(): Promise<'LOGGED_IN' | 'LOGIN_FORM' | 'SKELETON' | 'ACCESS_DENIED' | 'UNKNOWN'> {
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

      // Проверяем "Доступ ограничен" — страница блокировки кассира
      const bodyText = await this.page!.textContent('body').catch(() => '');
      if (bodyText) {
        const lower = bodyText.toLowerCase();
        if (ACCESS_DENIED_MARKERS.some(m => lower.includes(m))) {
          this.logger.warn('Surveillance: ACCESS_DENIED page detected (not a cashier)');
          return 'ACCESS_DENIED';
        }
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
          await button.click().catch(() => { });
          this.logger.info(`Surveillance: Submit button clicked (${selector})`);
          break;
        }
      }

      this.logger.info('Surveillance: SMS code submitted');

      // Code input closed → then dismiss any success modal that appeared
      try {
        await this.page!.waitForSelector(SMS_CODE_DIALOG, { state: 'hidden', timeout: 15000 });
        this.logger.info('Surveillance: Code dialog closed');
      } catch {
        this.logger.debug('Surveillance: Code dialog not found');
      }
      await this.dismissLeftoverModal();

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
      await this.takeDebugScreenshot('hard_refresh_done');
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
      await this.takeDebugScreenshot('soft_refresh_done');
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
      await this.takeDebugScreenshot('table_ready');

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
          if (trimmedStatus === 'Подтверждено') {
            orderStatus = 'READY_FOR_QR';
          } else if (trimmedStatus === 'Подтвердить') {
            orderStatus = 'PENDING';
          } else if (trimmedStatus === 'В обработке') {
            orderStatus = 'IN_PROCESSING';
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

  /** Debug screenshot for diagnostics — emits 'debugScreenshot' event for admin delivery. */
  async takeDebugScreenshot(label = 'debug'): Promise<Buffer | null> {
    if (!this.page) {
      this.logger.warn(`Surveillance: No page for debug screenshot (${label})`);
      return null;
    }
    try {
      const buf = await this.page.screenshot({ type: 'png', fullPage: true });
      this.logger.debug(`Surveillance: Debug screenshot #${label}`);
      this.emit('debugScreenshot', { label, buffer: buf, timestamp: new Date().toISOString() });
      return buf;
    } catch (error) {
      this.logger.error(`Surveillance: Failed debug screenshot (${label}) - ${error}`);
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

  async clickSendSmsButton(orderId: string): Promise<boolean> {
    // Mock mode
    if (process.env.BROWSER_MOCK === 'true') {
      this.logger.info(`[MOCK] Кнопка "Подтвердить заявку через SMS" нажата для ${orderId}`);
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
        'div.bcc-fridge-footer button:has-text("Подтвердить заявку через SMS")',
        'div.bcc-fridge-footer button[data-pw="button"]',
        'div.bcc-fridge-footer .bcc-button',
        '.bcc-fridge_open button[data-pw="button"]',
        'button:has-text("Подтвердить заявку через SMS")',
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
      this.logger.info(`[MOCK] Статус заявки ${orderId} изменен на "Подтверждено"`);
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

      // A retry after a wrong code may leave the old digits in the fields
      for (const input of inputs) {
        await input.fill('').catch(() => {});
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

  /** The SMS code dialog of the bank page is still on screen. */
  async isSmsCodeDialogOpen(): Promise<boolean> {
    if (process.env.BROWSER_MOCK === 'true') return false;
    if (!this.page) return false;
    return this.page.$(SMS_CODE_DIALOG).then(el => el?.isVisible() ?? false).catch(() => false);
  }

  private async isSmsCodeBlocked(): Promise<boolean> {
    if (!this.page) return false;
    const modals = await this.page.$$('.bcc-modal.bcc-modal_show, div[role="dialog"]').catch(() => []);
    for (const modal of modals) {
      if (!(await modal.isVisible().catch(() => false))) continue;
      // The code dialog's own hint text may mention blocking; only a separate modal counts
      if (await modal.$(SMS_CODE_DIALOG).catch(() => null)) continue;
      const text = ((await modal.textContent().catch(() => '')) ?? '').toLowerCase();
      if (SMS_BLOCKED_MARKERS.some(marker => text.includes(marker))) return true;
    }
    return false;
  }

  private async findConfirmButton(): Promise<ElementHandle | null> {
    if (!this.page) return null;
    for (const selector of CONFIRM_BUTTON_SELECTORS) {
      const button = await this.page.$(selector).catch(() => null);
      if (button && await button.isVisible().catch(() => false)) return button;
    }
    return null;
  }

  /** Polls until the code dialog closes (accepted) or the bank shows the block message. null = still open. */
  private async waitSmsCodeOutcome(timeoutMs: number): Promise<SmsCodeResult | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isSmsCodeBlocked()) return 'BLOCKED';
      if (!(await this.isSmsCodeDialogOpen())) return 'ACCEPTED';
      await this.page!.waitForTimeout(300);
    }
    return null;
  }

  private async waitUntilEnabled(button: ElementHandle, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await button.isDisabled().catch(() => true))) return;
      await this.page!.waitForTimeout(300);
    }
  }

  /**
   * Submits the entered code and reads the bank's answer from the page:
   * the code dialog closes -> ACCEPTED; it stays open and asks for the code again -> WRONG.
   * Words inside the dialog are not used: its static text also contains "неверно"/"ошибка".
   */
  async confirmSmsCode(orderId: string): Promise<SmsCodeResult> {
    if (process.env.BROWSER_MOCK === 'true') return 'ACCEPTED';
    if (!this.page) return 'FAILED';

    try {
      // The bank may submit by itself after the last digit
      const early = await this.waitSmsCodeOutcome(1500);
      if (early) {
        if (early === 'ACCEPTED') await this.dismissLeftoverModal();
        return this.logSmsCodeResult(orderId, early);
      }

      const button = await this.findConfirmButton();
      if (!button) {
        this.logger.warn(`Surveillance: Confirm button not found for ${orderId}`);
        return this.logSmsCodeResult(orderId, (await this.waitSmsCodeOutcome(3000)) ?? 'FAILED');
      }

      await this.waitUntilEnabled(button, 10000);
      await button.scrollIntoViewIfNeeded().catch(() => {});
      await button.click({ timeout: 5000 }).catch((error) => {
        this.logger.warn(`Surveillance: Confirm click failed for ${orderId} - ${error}`);
      });

      const result = await this.waitSmsCodeOutcome(15000) ?? 'WRONG';
      if (result === 'ACCEPTED') await this.dismissLeftoverModal();
      return this.logSmsCodeResult(orderId, result);
    } catch (error) {
      this.logger.error(`Surveillance: Failed to submit SMS code for ${orderId} - ${error}`);
      return 'FAILED';
    }
  }

  private logSmsCodeResult(orderId: string, result: SmsCodeResult): SmsCodeResult {
    this.logger.info(`Surveillance: SMS code result for ${orderId}: ${result}`);
    return result;
  }

  async verifySmsCompletion(orderId: string): Promise<boolean> {
    if (!this.page) {
      throw new Error('Page not initialized. Call login() first.');
    }

    try {
      // The table status is the only proof; a leftover info modal must not block the refresh click
      const modalVisible = await this.page.$('.bcc-modal.bcc-modal_show').then(el => el?.isVisible() ?? false).catch(() => false);
      if (modalVisible) {
        await this.page.keyboard.press('Escape').catch(() => {});
        await this.page.waitForTimeout(500);
      }

      await this.softRefresh();
      await this.page.waitForTimeout(2000);

      const orders = await this.extractOrders();
      const order = orders.find(o => o.external_id === orderId);

      // After an SMS confirmation the bank shows «В обработке» first, «Подтверждено» later
      if (order && (order.status === 'READY_FOR_QR' || order.status === 'IN_PROCESSING')) {
        this.logger.info(`Surveillance: Bank confirmed ${orderId} - status is ${order.status}`);
        return true;
      }

      this.logger.debug(`Surveillance: Order ${orderId} not confirmed by bank yet (status ${order?.status ?? 'not found'})`);
      return false;
    } catch (error) {
      this.logger.error(`Surveillance: Failed to verify SMS completion for ${orderId} - ${error}`);
      return false;
    }
  }

  /** Dismisses a leftover bank modal after SMS code acceptance (success / return button). Returns true if dismissed. */
  private async dismissLeftoverModal(): Promise<boolean> {
    if (!this.page) return false;
    try {
      const modal = await this.page.$('div.bcc-modal.bcc-modal_show, div[role="dialog"]').catch(() => null);
      if (!modal || !(await modal.isVisible().catch(() => false))) return true;

      const returnSelectors = [
        'button:has-text("Return to Cashier\'s Cabinet")',
        'button:has-text("Вернуться в кабинет")',
        'button:has-text("Return")',
        'button.bcc-button:has-text("Кабинет")',
        'div.bcc-modal_container button',
      ];
      for (const selector of returnSelectors) {
        const btn = await this.page.$(selector).catch(() => null);
        if (btn && await btn.isVisible().catch(() => false)) {
          await btn.click({ timeout: 5000 });
          this.logger.info('Surveillance: Success modal dismissed via button');
          await this.page.waitForTimeout(1000);
          return true;
        }
      }

      await this.page.keyboard.press('Escape');
      this.logger.info('Surveillance: Success modal dismissed via Escape');
      await this.page.waitForTimeout(1000);
      return true;
    } catch (e) {
      this.logger.warn(`Surveillance: Failed to dismiss leftover modal - ${e}`);
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
      await this.page.keyboard.press('Escape').catch(() => { });
      await this.page.waitForTimeout(500);
    }
  }

  /**
   * Visible sidebar that shows this order (its ИИН is in the sidebar text), otherwise null.
   * A closed sidebar stays in the DOM with the previous order's data, so visibility and ИИН are both required.
   */
  private async getOpenSidebarFor(orderId: string): Promise<ElementHandle | null> {
    if (!this.page) return null;
    const sidebar = await this.page.$('div.bcc-fridge_open');
    if (!sidebar || !(await sidebar.isVisible().catch(() => false))) return null;
    const text = await sidebar.textContent().catch(() => '');
    return text && text.includes(orderId.trim()) ? sidebar : null;
  }

  async getInstallmentPeriodFromCurrentSidebar(orderId: string): Promise<string | null> {
    if (!this.page) return null;
    try {
      const sidebar = await this.getOpenSidebarFor(orderId);
      if (!sidebar) {
        this.logger.info(`[SIDEBAR] No open sidebar for ${orderId}, installment period not read`);
        return null;
      }

      const installmentElement = await this.page.$('div:has(> span:text("Рассрочка")) span.bcc-typography-paragraph_view_medium');
      if (installmentElement) {
        const installmentText = await installmentElement.innerText().catch(() => '');
        const periodMatch = installmentText.match(/(\d+)\s*(месяц|месяца|месяцев|мес\.?)/i);
        if (periodMatch) {
          const installmentPeriod = `${periodMatch[1]} месяцев`;
          this.logger.info(`[SIDEBAR] Installment period extracted from open sidebar: ${installmentPeriod}`);
          return installmentPeriod;
        }
      }

      const sidebarText = await sidebar.textContent().catch(() => '');
      if (sidebarText) {
        const periodMatch = sidebarText.match(/Рассрочка[\s\S]*?(\d+)\s*(месяц|месяца|месяцев|мес\.?)/i);
        if (periodMatch) {
          const installmentPeriod = `${periodMatch[1]} месяцев`;
          this.logger.info(`[SIDEBAR] Installment period (fallback) from open sidebar: ${installmentPeriod}`);
          return installmentPeriod;
        }
      }
    } catch (e) {
      this.logger.warn(`[SIDEBAR] Failed to get installment from current sidebar: ${e}`);
    }
    return null;
  }

  async parseInstallmentPeriodFromSidebar(orderId: string): Promise<string | null> {
    try {
      if (!this.page) {
        this.logger.warn(`[PROD] Order ${orderId} -> Page not available for sidebar parsing`);
        return null;
      }

      const isAlreadyOpen = (await this.getOpenSidebarFor(orderId)) !== null;
      if (!isAlreadyOpen) {
        // A sidebar of another order may still be open — close it so the row click is not blocked
        const otherSidebarOpen = await this.page.$('div.bcc-fridge_open').then(el => el?.isVisible() ?? false).catch(() => false);
        if (otherSidebarOpen) {
          await this.closeSidebar(orderId);
        }
        this.logger.info(`[PROD] Order ${orderId} -> Opening sidebar to parse installment period...`);
        const sidebarOpened = await this.openSidebarForOrder(orderId);
        if (!sidebarOpened) {
          this.logger.warn(`[PROD] Order ${orderId} -> Failed to open sidebar`);
          return null;
        }
      } else {
        this.logger.info(`[PROD] Order ${orderId} -> Sidebar is already open, reading installment period directly`);
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

      // Diagnostic: log ALL buttons in sidebar to detect UI changes
      try {
        const allFooterButtons = await this.page.$$('div.bcc-fridge-footer button, div.bcc-fridge button, .bcc-fridge_open button');
        const buttonTexts: string[] = [];
        for (const btn of allFooterButtons) {
          const text = await btn.innerText().catch(() => '');
          const isVis = await btn.isVisible().catch(() => false);
          if (text.trim()) {
            buttonTexts.push(`"${text.trim()}" (visible=${isVis})`);
          }
        }
        this.logger.info(`[DIAG] Sidebar buttons found: [${buttonTexts.join(', ')}]`);
      } catch (diagError) {
        this.logger.warn(`[DIAG] Failed to enumerate sidebar buttons: ${diagError}`);
      }

      const smsButtonSelectors = [
        'div.bcc-fridge-footer button:has-text("Подтвердить заявку через SMS")',
        'button[data-pw="button"]:has-text("Подтвердить заявку через SMS")',
        'button:has-text("Подтвердить заявку через SMS")',
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

      // Exact match on the ИИН cell (same as extractOrders/checkSmsConfirmationRequired).
      // A substring match on the last 4 digits also hit date-group rows ("… 2026") for ИИН ending in a year.
      // Duplicate ИИН rows: the first (newest) one wins.
      const targetId = orderId.trim();
      await this.page.waitForSelector('.bcc-table-body__row', { state: 'visible', timeout: 90000 });
      await this.page.waitForTimeout(2000);
      const rows = await this.page.$$('.bcc-table-body__row');
      for (const row of rows) {
        const idCell = await row.$('td');
        const rowId = idCell ? (await idCell.innerText()).trim() : '';
        if (rowId === targetId) {
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
            await this.takeDebugScreenshot(`sidebar_${orderId}`);
            return true;
          } catch (error) {
            this.logger.warn(`Surveillance: Sidebar not visible for order ${orderId}`);
            return false;
          }
        }
      }

      this.logger.warn(`Surveillance: Order ${orderId} not found in table (exact ИИН match)`);
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
