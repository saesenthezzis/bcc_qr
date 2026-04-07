import { config } from 'dotenv';
import express, { Express, Request, Response } from 'express';
import { Logger } from './utils/Logger';
import { RegistryAgent } from './agents/Registry';
import { SurveillanceAgent } from './agents/Surveillance';
import { GeneratorAgent } from './agents/Generator';
import { DispatcherAgent } from './agents/Dispatcher';
import { SmsStatus } from './types';
import { SmsFlowStatus } from './types/SmsFlowStatus';

config();

Logger.info('CreditBridge RPA Engine starting...');

const runtimeLogger = new Logger();

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

const registry = new RegistryAgent(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!, runtimeLogger);
const surveillance = new SurveillanceAgent(
  process.env.BANK_URL!,
  process.env.BANK_LOGIN!,
  process.env.BANK_PASSWORD!,
  runtimeLogger,
  registry
);
const generator = new GeneratorAgent(runtimeLogger);
const dispatcher = new DispatcherAgent(
  process.env.TELEGRAM_BOT_TOKEN!,
  process.env.TELEGRAM_CHAT_IDS!.split(','),
  runtimeLogger,
  process.env.TELEGRAM_ADMIN_ID,
  surveillance
);

surveillance.on('smsRequired', async ({ screenshot, timestamp }) => {
  Logger.info('Event: SMS required, notifying admin...');
  await dispatcher.sendSmsRequest(screenshot, timestamp);
});

surveillance.on('smsButtonNotFound', async ({ orderId, screenshotPath }) => {
  Logger.warn(`[SMS] SMS button not found for ${orderId}, sending screenshot to Telegram`);
  const fs = await import('fs');
  const buffer = fs.readFileSync(screenshotPath);
  await dispatcher.sendSmsBlockedAlert(orderId, buffer);
});

const CHECK_INTERVAL_MS = (parseInt(process.env.CHECK_INTERVAL_MINUTES || '1') * 60 * 1000);
const GRACEFUL_RESTART_HOURS = 3;

// Global monitoring pause flag
let isMonitoringPaused: boolean = false;
let isProcessingSms: boolean = false;
let currentSmsOrderId: string | null = null;

surveillance.setPauseCallback((paused: boolean) => {
  isMonitoringPaused = paused;
  Logger.info(`[CYCLE] Monitoring ${paused ? 'paused' : 'resumed'}`);
});

async function processSmsConfirmation(
  orderId: string,
  amount: number,
  order: { external_id: string; amount: number }
): Promise<void> {
  isProcessingSms = true;
  isMonitoringPaused = true;
  currentSmsOrderId = orderId;
  Logger.info(`[LOCK] SMS lock acquired for ${orderId}`);
  Logger.info(`[CYCLE] Monitoring paused for SMS flow of ${orderId}`);

  try {
    const result = await dispatcher.performSmsFlow(orderId, amount);
    Logger.info(`[SMS] Flow finished for ${order.external_id} with status ${result}`);

    if (result === SmsFlowStatus.SUCCESS) {
      Logger.info(`[SMS] Order ${order.external_id} confirmed successfully`);
    } else if (result === SmsFlowStatus.CANCELLED) {
      Logger.info(`[SMS] Order ${order.external_id} SMS flow cancelled by user`);
    } else {
      Logger.warn(`[SMS] Order ${order.external_id} SMS flow finished with timeout`);
    }
  } catch (error) {
    Logger.error(`[SMS] Failed to process SMS confirmation for ${order.external_id}: ${error}`);
  } finally {
    isProcessingSms = false;
    isMonitoringPaused = false;
    currentSmsOrderId = null;
    Logger.info(`[LOCK] SMS lock released for ${orderId}`);
    Logger.info(`[CYCLE] Monitoring resumed after SMS flow of ${orderId}`);

    try {
      const rec = await registry.getSmsConfirmation(orderId);
      const incompleteStatuses: SmsStatus[] = ['WAITING_FOR_USER_ACTION', 'SMS_SENT'];
      if (rec && incompleteStatuses.includes(rec.status)) {
        await registry.updateSmsStatus(orderId, 'SMS_TIMEOUT');
        Logger.warn(`[SMS] Auto-updated status to SMS_TIMEOUT for ${orderId}`);
      }
    } catch (e) {
      Logger.error(`[SMS] Failed to auto-update status in finally: ${e}`);
    }
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

async function processOrders(): Promise<void> {
  try {
    Logger.info('--- Starting order processing cycle ---');

    const orders = await surveillance.runRotation();
    Logger.info(`Extracted ${orders.length} orders from bank`);

    let processedCount = 0;
    let smsCount = 0;
    const finalSmsStatuses: SmsStatus[] = [
      'SMS_CONFIRMED',
      'USER_REFUSED_SMS',
      'SMS_BLOCKED',
      'COMPLETED_EXTERNALLY',
    ];

    for (const order of orders) {
      try {
        Logger.debug(`[DEBUG] Processing order ${order.external_id} with status: ${order.status}`);

        if (order.status === 'READY_FOR_QR') {
          const rec = await registry.checkWithStatus(order.external_id);
          if (rec.dbError) {
            Logger.info(`[SKIP] Order ${order.external_id}: reason=DB_ERROR status=READY_FOR_QR`);
            continue;
          }

          if (rec.status === 'COMPLETED') {
            Logger.info(`[SKIP] Order ${order.external_id}: reason=ALREADY_COMPLETED status=READY_FOR_QR`);
            continue;
          }

          const reserved = await registry.reserveOrder(order.external_id, order.amount);
          if (!reserved) {
            Logger.info(`[SKIP] Order ${order.external_id}: reason=RESERVE_FAILED status=READY_FOR_QR`);
            continue;
          }

          Logger.info(`[READY_FOR_QR] Processing order ${order.external_id}`);
          const orderData = await surveillance.prepareOrderData(order.external_id);
          const qrBuffer = await generator.generateQR(order.amount, orderData.installmentPeriod || undefined);
          try {
            await dispatcher.sendQRCode(qrBuffer, order.external_id, order.amount);
            await registry.updateOrderStatus(order.external_id, 'COMPLETED');
            Logger.info(`[COMPLETED] Order ${order.external_id} marked as COMPLETED after QR send`);
            processedCount++;
          } catch (error) {
            Logger.error(`[QR] Failed for ${order.external_id}: ${error}`);
          }
          continue;
        }

        if (order.status === 'PENDING') {
          const rec = await registry.checkWithStatus(order.external_id);
          if (rec.dbError) {
            Logger.info(`[SKIP] Order ${order.external_id}: reason=DB_ERROR status=PENDING`);
            continue;
          }

          if (rec.status === 'COMPLETED') {
            Logger.info(`[SKIP] Order ${order.external_id}: reason=ALREADY_COMPLETED status=PENDING`);
            continue;
          }

          const isFirstPendingAlert = !rec.exists || rec.status !== 'PENDING';
          if (isFirstPendingAlert) {
            Logger.info(`[PENDING] Sending confirmation alert for ${order.external_id}`);
            try {
              await dispatcher.sendConfirmationAlert(order.external_id, order.amount);
              await registry.register(order.external_id, order.amount, 'PENDING');
            } catch (error) {
              Logger.error(`[PENDING] Failed to send alert for ${order.external_id}: ${error}`);
              continue;
            }
          } else {
            Logger.info(`[PENDING] Confirmation alert already sent for ${order.external_id}, skipping duplicate alert`);
          }

          if (isProcessingSms) {
            Logger.info(`[SMS] Lock active, skipping SMS flow for this cycle (current=${currentSmsOrderId || 'unknown'})`);
            continue;
          }

          const smsRec = await registry.getSmsConfirmation(order.external_id);
          if (smsRec && finalSmsStatuses.includes(smsRec.status)) {
            Logger.debug(`[SMS] Order ${order.external_id} has final SMS status ${smsRec.status}, skip`);
            continue;
          }

          const requiresSms = await surveillance.checkSmsConfirmationRequired(order.external_id);
          if (requiresSms) {
            Logger.info(`[SMS] Starting SMS flow for ${order.external_id}`);
            void processSmsConfirmation(order.external_id, order.amount, {
              external_id: order.external_id,
              amount: order.amount,
            });
            smsCount++;
            break;
          }

          Logger.info(`[SMS] Order ${order.external_id} does not require SMS flow`);
          continue;
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        Logger.error(`Failed to process order ${order.external_id}: ${errorMsg}`);
      }
    }

    Logger.info(`--- Cycle complete: ${processedCount} QR sent, ${smsCount} SMS flows started ---`);
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
    throw error;
  }
}

async function handleCriticalFailure(error: unknown): Promise<never> {
  const screenshot = await surveillance.takeErrorScreenshot('critical_failure');
  await dispatcher.sendErrorMessage(error, screenshot);
  return await shutdown(1);
}

async function shutdown(exitCode: number): Promise<never> {
  await surveillance.close();
  await dispatcher.stop();
  process.exit(exitCode);
  throw new Error(`Process exiting with code ${exitCode}`);
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

    let restartWindowStartedAt = Date.now();
    try {
      while (true) {
        // Check if monitoring is paused
        if (isMonitoringPaused) {
          Logger.info('[CYCLE] Monitoring is paused, skipping cycle');
          await new Promise(resolve => setTimeout(resolve, 60000));
          continue;
        }

        await processOrders();

        await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL_MS));

        const elapsed = Date.now() - restartWindowStartedAt;
        if (elapsed >= restartTimeout) {
          Logger.info(`Restarting browser after ${GRACEFUL_RESTART_HOURS} hours`);
          await surveillance.restartBrowser();
          restartWindowStartedAt = Date.now();
        }
      }
    } catch (error) {
      Logger.error(`Critical scheduler failure: ${error}`);
      await handleCriticalFailure(error);
    }
  } catch (error) {
    Logger.error(`Fatal error: ${error}`);
    await handleCriticalFailure(error);
  }
}

process.on('SIGINT', async () => {
  Logger.info('Received SIGINT, shutting down...');
  await shutdown(0);
});

process.on('SIGTERM', async () => {
  Logger.info('Received SIGTERM, shutting down...');
  await shutdown(0);
});

main().catch(async (error) => {
  Logger.error(`Failed to start: ${error}`);
  await handleCriticalFailure(error);
});
