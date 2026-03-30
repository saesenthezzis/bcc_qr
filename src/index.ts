import { config } from 'dotenv';
import express, { Express, Request, Response } from 'express';
import { Logger } from './utils/Logger';
import { RegistryAgent } from './agents/Registry';
import { SurveillanceAgent } from './agents/Surveillance';
import { GeneratorAgent } from './agents/Generator';
import { DispatcherAgent } from './agents/Dispatcher';
import { getBccCode } from './utils/InstallmentMapper';

config();

Logger.info('CreditBridge RPA Engine starting...');

const isProduction = process.env.NODE_ENV === 'production';
const isRender = process.env.RENDER === 'true' || !!process.env.PORT;
const isMockMode = process.env.BROWSER_MOCK === 'true';

Logger.info(`Environment: NODE_ENV=${process.env.NODE_ENV || 'development'}, isRender=${isRender}`);

if (isMockMode) {
  Logger.warn('⚠️  MOCK MODE ENABLED - Browser actions will be simulated');
  Logger.warn('⚠️  Set BROWSER_MOCK=false in .env for production use');
} else {
  Logger.info('✅ [LIVE] Bot running in LIVE mode - monitoring real orders from bank');
  Logger.info('✅ [LIVE] Mock mode disabled - all browser actions are real');
}

const requiredEnvVars = ['BANK_URL', 'BANK_LOGIN', 'BANK_PASSWORD', 'SUPABASE_URL', 'SUPABASE_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_IDS'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    Logger.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const registry = new RegistryAgent(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);
const surveillance = new SurveillanceAgent(
  process.env.BANK_URL!,
  process.env.BANK_LOGIN!,
  process.env.BANK_PASSWORD!,
  registry
);
const generator = new GeneratorAgent();
const dispatcher = new DispatcherAgent(
  process.env.TELEGRAM_BOT_TOKEN!,
  process.env.TELEGRAM_CHAT_IDS!.split(','),
  process.env.TELEGRAM_ADMIN_ID,
  surveillance
);

surveillance.on('smsRequired', async ({ screenshot, timestamp }) => {
  Logger.info('Event: SMS required, notifying admin...');
  await dispatcher.sendSmsRequest(screenshot, timestamp);
});

const CHECK_INTERVAL_MS = (parseInt(process.env.CHECK_INTERVAL_MINUTES || '1') * 60 * 1000);
const GRACEFUL_RESTART_HOURS = 3;

// Global SMS processing lock
let isProcessingSms = false;
let currentSmsOrderId: string | null = null;

async function retryRegistryOperation<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  delayMs = 2000
): Promise<T> {
  let lastError: unknown;

  for (let i = 1; i <= maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (i === maxRetries) {
        throw error;
      }
      Logger.warn(`DB operation failed, retry ${i}/${maxRetries}...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Unknown registry operation error');
}

async function parseInstallmentPeriodFromSidebar(surveillance: SurveillanceAgent, orderId: string): Promise<string | null> {
  try {
    Logger.info(`[PROD] Order ${orderId} -> Opening sidebar to parse installment period...`);
    
    // Get page from surveillance (we need to access private page)
    const page = (surveillance as any).page;
    if (!page) {
      Logger.warn(`[PROD] Order ${orderId} -> Page not available for sidebar parsing`);
      return null;
    }

    // Click on the order row to open sidebar
    const rows = await page.$$('.bcc-table-body__row');
    
    for (const row of rows) {
      const cells = await row.$$('td');
      if (cells.length < 1) continue;
      
      const idCell = cells[0];
      const rowId = (await idCell.innerText()).trim();
      
      if (rowId === orderId) {
        Logger.info(`[PROD] Order ${orderId} -> Sidebar Open`);
        await row.click();
        await page.waitForTimeout(3000); // Wait for sidebar to fully load
        break;
      }
    }

    // Wait for sidebar to appear
    await page.waitForTimeout(1000);

    // Parse installment period using precise selector
    try {
      // Try precise selector first: div:has(> span:text("Рассрочка")) >> span.bcc-typography-paragraph_view_medium
      const installmentElement = await page.$('div:has(> span:text("Рассрочка")) span.bcc-typography-paragraph_view_medium');
      
      if (installmentElement) {
        const installmentText = await installmentElement.innerText();
        
        // Parse the value (e.g., "18 мес." -> "18 месяцев")
        const periodMatch = installmentText.match(/(\d+)\s*(месяц|месяца|месяцев|мес\.?)/i);
        if (periodMatch) {
          const installmentPeriod = `${periodMatch[1]} месяцев`;
          const bccCode = getBccCode(installmentPeriod);
          Logger.info(`[PROD] Order ${orderId} -> Term: ${periodMatch[1]}m -> Code: ${bccCode}`);
          
          // Close sidebar using close button
          await closeSidebar(page, orderId);
          
          return installmentPeriod;
        }
      }
    } catch (selectorError) {
      Logger.warn(`[PROD] Order ${orderId} -> Precise selector failed, trying fallback`);
    }

    // Fallback: search in all text
    const bodyText = await page.textContent('body');
    if (bodyText) {
      const periodMatch = bodyText.match(/(\d+)\s*(месяц|месяца|месяцев|мес\.?)/i);
      if (periodMatch) {
        const installmentPeriod = `${periodMatch[1]} месяцев`;
        const bccCode = getBccCode(installmentPeriod);
        Logger.info(`[PROD] Order ${orderId} -> Term: ${periodMatch[1]}m (fallback) -> Code: ${bccCode}`);
        
        // Close sidebar
        await closeSidebar(page, orderId);
        
        return installmentPeriod;
      }
    }

    Logger.warn(`[PROD] Order ${orderId} -> Installment period not found, using default`);
    
    // Close sidebar anyway
    await closeSidebar(page, orderId);
    
    // Return default value (6 months) as fallback
    Logger.warn(`[PROD] Order ${orderId} -> Using default: 6m -> Code: KZ282`);
    return '6 месяцев';
    
  } catch (error) {
    Logger.error(`[PROD] Order ${orderId} -> Failed to parse installment period: ${error}`);
    
    // Try to close sidebar
    try {
      const page = (surveillance as any).page;
      if (page) await closeSidebar(page, orderId);
    } catch (closeError) {
      Logger.warn(`[PROD] Order ${orderId} -> Could not close sidebar: ${closeError}`);
    }
    
    // Return default value
    return '6 месяцев';
  }
}

async function closeSidebar(page: any, orderId: string): Promise<void> {
  try {
    // Try to click close button: div.bcc-fridge-header__close button
    const closeButton = await page.$('div.bcc-fridge-header__close button');
    if (closeButton) {
      await closeButton.click();
      Logger.info(`[PROD] Order ${orderId} -> Sidebar closed`);
      await page.waitForTimeout(500);
      return;
    }
    
    // Fallback: try .bcc-button_iconOnly in header
    const iconButton = await page.$('.bcc-fridge-header .bcc-button_iconOnly');
    if (iconButton) {
      await iconButton.click();
      Logger.info(`[PROD] Order ${orderId} -> Sidebar closed (icon button)`);
      await page.waitForTimeout(500);
      return;
    }
    
    // Last resort: Escape key
    await page.keyboard.press('Escape');
    Logger.info(`[PROD] Order ${orderId} -> Sidebar closed (Escape)`);
    await page.waitForTimeout(500);
    
  } catch (error) {
    Logger.warn(`[PROD] Order ${orderId} -> Error closing sidebar: ${error}`);
    // Try Escape as last resort
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function startKeepAliveServer(): Promise<void> {
  const app: Express = express();
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = '0.0.0.0';

  app.get('/', (req: Request, res: Response) => {
    res.status(200).json({
      status: 'Bot is running',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
    });
  });

  app.get('/health', (req: Request, res: Response) => {
    res.status(200).send('OK');
  });

  app.listen(port, host, () => {
    Logger.info(`Keep-Alive server listening on ${host}:${port}`);
  });
}

async function processSmsConfirmation(orderId: string, amount: number): Promise<boolean> {
  // Set global lock
  isProcessingSms = true;
  currentSmsOrderId = orderId;
  Logger.info(`[LOCK] SMS processing started for order ${orderId}`);

  try {
    Logger.info(`[SMS] Processing SMS confirmation for order ${orderId}`);

    // Check if SMS confirmation is required
    const requiresSms = await surveillance.checkSmsConfirmationRequired(orderId);
    if (!requiresSms) {
      Logger.info(`[SMS] Order ${orderId} does not require SMS confirmation`);
      return false;
    }

    // Check SMS attempts limit
    const attemptsCheck = await registry.checkSmsAttempts(orderId);
    if (attemptsCheck.limitExceeded) {
      Logger.warn(`[SMS] Order ${orderId} exceeded SMS attempts limit (${attemptsCheck.attempts})`);
      await dispatcher.sendSmsLimitExceeded(orderId, attemptsCheck.attempts);
      return false;
    }

    // Send confirmation request to admin with Cancel button
    const messageId = await dispatcher.sendSmsConfirmationRequest(orderId, amount);
    if (!messageId) {
      Logger.warn(`[SMS] Failed to send confirmation request for ${orderId}`);
      return false;
    }

    // Update telegram_message_id in DB
    await registry.updateTelegramMessageId(orderId, messageId);

    // Countdown configuration for admin decision
    const DECISION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const DECISION_UPDATE_INTERVAL_MS = 60 * 1000; // 1 minute
    let decisionRemainingMinutes = 5;

    // Start countdown interval for admin decision
    const decisionCountdownInterval = setInterval(async () => {
      decisionRemainingMinutes--;
      if (decisionRemainingMinutes > 0 && messageId) {
        const countdownText = `⏳ Ожидание решения... Осталось ${decisionRemainingMinutes} мин.`;
        await dispatcher.updateDecisionCountdown(orderId, messageId, countdownText);
      }
    }, DECISION_UPDATE_INTERVAL_MS);

    // Wait for admin confirmation (with cancellation support)
    const confirmed = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        clearInterval(decisionCountdownInterval);
        dispatcher.unregisterSmsCodeCallback(orderId);
        resolve(false);
      }, DECISION_TIMEOUT_MS);

      dispatcher.registerSmsCodeCallback(orderId, (response) => {
        clearTimeout(timeout);
        clearInterval(decisionCountdownInterval);
        if (response === 'CANCELLED') {
          Logger.info(`[SMS] Admin cancelled SMS sending for ${orderId}`);
          // Update status in DB
          registry.updateSmsStatus(orderId, 'USER_REFUSED_SMS').catch((err) => {
            Logger.error(`[SMS] Failed to update status to USER_REFUSED_SMS: ${err}`);
          });
          resolve(false);
        } else {
          resolve(response === 'CONFIRMED');
        }
      });
    });

    if (!confirmed) {
      Logger.warn(`[SMS] Admin did not confirm SMS sending for ${orderId}`);
      return false;
    }

    // Click "Send SMS" button
    const clicked = await surveillance.clickSendSmsButton(orderId);
    if (!clicked) {
      Logger.error(`[SMS] Failed to click Send SMS button for ${orderId}`);
      return false;
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check for blocked modal
    const isBlocked = await surveillance.checkSmsBlockedModal();
    if (isBlocked) {
      Logger.warn(`[SMS] SMS blocked for order ${orderId}`);
      const screenshot = await surveillance.takeSmsScreenshot(orderId, 'blocked');
      if (screenshot) {
        await dispatcher.sendSmsBlockedAlert(orderId, screenshot);
      }
      await surveillance.closeSmsBlockedModal();
      await registry.updateSmsStatus(orderId, 'SMS_BLOCKED');
      await surveillance.hardRefresh();
      return false;
    }

    // Take screenshot of SMS input field
    const screenshot = await surveillance.takeSmsScreenshot(orderId, 'input');
    if (!screenshot) {
      Logger.error(`[SMS] Failed to take screenshot for ${orderId}`);
      return false;
    }

    // Send SMS code request to admin
    const codeMessageId = await dispatcher.sendSmsCodeRequest(orderId, screenshot);
    await registry.updateSmsStatus(orderId, 'SMS_SENT');

    // Countdown configuration
    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const UPDATE_INTERVAL_MS = 60 * 1000; // 1 minute
    let remainingMinutes = 5;

    // Start countdown interval
    const countdownInterval = setInterval(async () => {
      remainingMinutes--;
      if (remainingMinutes > 0 && codeMessageId) {
        const countdownText = `⏳ Ожидание кода... Осталось ${remainingMinutes} мин.`;
        await dispatcher.updateCountdownMessage(orderId, codeMessageId, countdownText);
      }
    }, UPDATE_INTERVAL_MS);

    // Wait for SMS code from admin with timeout
    const smsCode = await Promise.race([
      new Promise<string | null>((resolve) => {
        dispatcher.registerSmsCodeCallback(orderId, (code) => {
          resolve(code);
        });
      }),
      new Promise<string | null>((resolve) => {
        setTimeout(() => {
          dispatcher.unregisterSmsCodeCallback(orderId);
          resolve(null);
        }, TIMEOUT_MS);
      })
    ]);

    // Clear countdown interval
    clearInterval(countdownInterval);

    if (!smsCode) {
      Logger.warn(`[SMS] No SMS code received for ${orderId} (timeout after 5 minutes)`);
      await registry.updateSmsStatus(orderId, 'SMS_TIMEOUT');
      await dispatcher.sendTimeoutAlert(orderId);
      return false;
    }

    // Enter SMS code
    const entered = await surveillance.enterSmsCode(smsCode, orderId);
    if (!entered) {
      Logger.error(`[SMS] Failed to enter SMS code for ${orderId}`);
      return false;
    }

    // Increment attempts
    await registry.updateSmsAttempts(orderId);

    // Increment sent_count
    await registry.incrementSentCount(orderId);

    // Force refresh to check new status
    await surveillance.hardRefresh();
    Logger.info(`[SMS] SMS confirmation completed for ${orderId}`);

    return true;
  } catch (error) {
    Logger.error(`[SMS] Error processing SMS confirmation for ${orderId}: ${error}`);
    return false;
  } finally {
    // Always release lock
    isProcessingSms = false;
    currentSmsOrderId = null;
    Logger.info(`[LOCK] SMS processing lock released for order ${orderId}`);
  }
}

async function processOrders(): Promise<void> {
  try {
    // Check if SMS processing is in progress - BLOCK cycle if true
    if (isProcessingSms) {
      Logger.info(`[LOCK] SMS processing in progress for order ${currentSmsOrderId}, skipping this cycle`);
      return;
    }

    Logger.info('--- Starting order processing cycle ---');

    const orders = await surveillance.runRotation();
    Logger.info(`Extracted ${orders.length} orders from bank`);

    let processedCount = 0;
    let pendingCount = 0;
    let smsCount = 0;

    for (const order of orders) {
      try {
        // DEBUG: Log order status
        Logger.debug(`[DEBUG] Processing order ${order.external_id} with status: ${order.status}`);
        
        // PRIORITY: For ALL PENDING orders, ALWAYS check for SMS button on site
        if (order.status === 'PENDING') {
          Logger.info(`[INFO] Order ${order.external_id} has PENDING status. Checking for SMS button...`);
          
          // Skip Logic: Check if SMS already processed (sent_count > 0)
          const smsConfirmation = await registry.getSmsConfirmation(order.external_id);
          if (smsConfirmation && smsConfirmation.sent_count > 0) {
            Logger.debug(`[SKIP] Order ${order.external_id} already processed SMS (sent_count: ${smsConfirmation.sent_count}), skipping`);
            continue;
          }
          
          // Step 1: Open sidebar and verify SMS button exists
          const requiresSms = await surveillance.checkSmsConfirmationRequired(order.external_id);
          
          if (requiresSms) {
            Logger.info(`[INFO] Order ${order.external_id} needs confirmation. SMS button found in sidebar.`);
            
            // Step 2: Check if Telegram notification was already sent
            const existingSmsConfirmation = await registry.getSmsConfirmation(order.external_id);
            
            if (!existingSmsConfirmation || !existingSmsConfirmation.telegram_message_id) {
              // Step 3: Register in DB if not exists
              if (!existingSmsConfirmation) {
                Logger.info(`[SMS] Registering SMS confirmation for order ${order.external_id}`);
                await registry.registerSmsConfirmation(order.external_id, order.amount, 'WAITING_FOR_USER_ACTION');
              }
              
              // Step 4: Process SMS confirmation
              Logger.info(`[SMS] Processing SMS confirmation for order ${order.external_id}`);
              const smsSuccess = await processSmsConfirmation(order.external_id, order.amount);
              
              if (smsSuccess) {
                smsCount++;
                Logger.info(`[SMS] Order ${order.external_id} SMS confirmation successful`);
              } else {
                Logger.warn(`[SMS] Order ${order.external_id} SMS confirmation failed or timed out`);
              }
            } else {
              Logger.debug(`Order ${order.external_id} SMS request already sent to Telegram (message_id: ${existingSmsConfirmation.telegram_message_id}), waiting for response`);
            }
            continue; // Skip further processing for this order
          } else {
            // No SMS button - regular PENDING order
            Logger.info(`Order ${order.external_id} is PENDING but no SMS button found - treating as regular PENDING`);
            
            // Check if already registered in main orders table
            const processResult = await registry.shouldProcessOrder(order);
            
            if (!processResult.shouldProcess) {
              Logger.debug(`Order ${order.external_id} already registered as PENDING, skipping`);
              continue;
            }
            
            // New PENDING order without SMS - send regular alert
            Logger.info(`Processing new PENDING order ${order.external_id} without SMS requirement`);
            await dispatcher.sendConfirmationAlert(order.external_id, order.amount);
            await retryRegistryOperation(() =>
              registry.register(order.external_id, order.amount, 'PENDING')
            );
            pendingCount++;
            Logger.info(`Order ${order.external_id} registered as PENDING, alert sent`);
            continue; // Skip further processing for this order
          }
        }

        // Standard processing logic
        const processResult = await registry.shouldProcessOrder(order);

        if (!processResult.shouldProcess) {
          if (processResult.reason === 'DB_ERROR') {
            Logger.warn(`Registry unavailable for order ${order.external_id}, skipping to prevent duplicates`);
          } else {
            Logger.debug(`Order ${order.external_id} already processed (${order.status}), skipping`);
          }
          continue;
        }

        if (processResult.reason === 'NEW') {
          Logger.info(`Processing new order ${order.external_id} (${order.amount} KZT, ${order.status})`);

          if (order.status === 'READY_FOR_QR') {

            const reserved = await retryRegistryOperation(() =>
              registry.reserveOrder(order.external_id, order.amount)
            );
            if (!reserved) {
              Logger.warn(`Order ${order.external_id} already reserved, skipping`);
              continue;
            }

            // Parse installment period from sidebar
            const installmentPeriod = await parseInstallmentPeriodFromSidebar(surveillance, order.external_id);
            
            // Generate QR with dynamic installment code
            const qrBuffer = await generator.generateQR(order.amount, installmentPeriod || undefined);
            Logger.info(`[PROD] Order ${order.external_id} -> QR Generated`);
            
            await dispatcher.sendQRCode(qrBuffer, order.external_id, order.amount);

            await retryRegistryOperation(() =>
              registry.updateOrderStatus(order.external_id, 'COMPLETED')
            );
            processedCount++;
            Logger.info(`[PROD] Order ${order.external_id} -> Completed (QR sent to Telegram, DB updated)`);
          }
        }

        if (processResult.reason === 'STATUS_CHANGED') {
          Logger.info(`Order ${order.external_id} status changed to READY_FOR_QR`);

          // Parse installment period from sidebar
          const installmentPeriod = await parseInstallmentPeriodFromSidebar(surveillance, order.external_id);
          
          // Generate QR with dynamic installment code
          const qrBuffer = await generator.generateQR(order.amount, installmentPeriod || undefined);
          Logger.info(`[PROD] Order ${order.external_id} -> QR Generated`);
          
          await dispatcher.sendQRCode(qrBuffer, order.external_id, order.amount);

          await retryRegistryOperation(() =>
            registry.updateOrderStatus(order.external_id, 'COMPLETED')
          );
          processedCount++;
          Logger.info(`[PROD] Order ${order.external_id} -> Completed (QR sent to Telegram, DB updated)`);
        }

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        Logger.error(`Failed to process order ${order.external_id}: ${errorMsg}`);
      }
    }

    Logger.info(`--- Cycle complete: ${processedCount} QR sent, ${pendingCount} pending alerts ---`);

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    const isTimeoutError = errorMsg.includes('Timeout') || errorMsg.includes('timeout');
    const isWaitingForSms = surveillance.getIsWaitingForSms();
    const isSessionValid = await surveillance.checkSessionValid().catch(() => false);

    if (isTimeoutError) {
      if (isWaitingForSms) {
        Logger.debug(`[DEBUG] Timeout during SMS waiting, this is expected`);
        return;
      }

      if (isSessionValid) {
        Logger.debug(`[DEBUG] Timeout error but session is valid, skipping Telegram alert`);
        return;
      }
    }

    Logger.error(`Critical error in processing cycle: ${errorMsg}`);
    await dispatcher.sendErrorMessage(errorMsg);
    throw error;
  }
}

async function main(): Promise<void> {
  await startKeepAliveServer();
  Logger.info(`Health check server is live on port ${process.env.PORT || 3000}`);

  Logger.info(`Starting scheduler with ${CHECK_INTERVAL_MS / 1000}s interval`);

  const restartTimeout = GRACEFUL_RESTART_HOURS * 60 * 60 * 1000;

  try {
    // Safety Check 1: Verify Supabase connection
    Logger.info('[STARTUP] Verifying Supabase connection...');
    try {
      const testCheck = await registry.checkWithStatus('STARTUP_TEST');
      Logger.info('[STARTUP] ✅ Supabase connection verified');
    } catch (dbError) {
      Logger.error(`[STARTUP] ❌ Supabase connection failed: ${dbError}`);
      throw new Error('Cannot start without database connection');
    }

    // Safety Check 2: Initialize browser and validate session
    Logger.info('[STARTUP] Initializing browser...');
    await surveillance.initBrowser();
    Logger.info('[STARTUP] ✅ Browser initialized');

    // Safety Check 3: Validate bank session
    Logger.info('[STARTUP] Validating bank session...');
    const sessionValid = await surveillance.checkSessionValid().catch(() => false);
    if (sessionValid) {
      Logger.info('[STARTUP] ✅ Bank session is valid');
    } else {
      Logger.warn('[STARTUP] ⚠️ Bank session needs login (will authenticate on first cycle)');
    }

    if (isRender) {
      Logger.info('Running on Render cloud, sending startup notification...');
      await dispatcher.sendStartupNotification();
    }

    Logger.info('[STARTUP] ✅ All systems ready - CreditBridge RPA Engine is running!');

    const startTime = Date.now();

    while (true) {
      try {
        await processOrders();

        await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL_MS));

        const elapsed = Date.now() - startTime;
        if (elapsed >= restartTimeout) {
          Logger.info(`Graceful restart after ${GRACEFUL_RESTART_HOURS} hours`);
          await surveillance.close();
          await dispatcher.stop();
          process.exit(0);
        }
      } catch (error) {
        Logger.error(`Scheduler error: ${error}`);
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
    }
  } catch (error) {
    Logger.error(`Fatal error: ${error}`);
    await surveillance.close();
    await dispatcher.stop();
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  Logger.info('Received SIGINT, shutting down...');
  await dispatcher.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  Logger.info('Received SIGTERM, shutting down...');
  await dispatcher.stop();
  process.exit(0);
});

main().catch((error) => {
  Logger.error(`Failed to start: ${error}`);
  process.exit(1);
});
