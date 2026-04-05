import { config } from 'dotenv';
import express, { Express, Request, Response } from 'express';
import { Logger } from './utils/Logger';
import { RegistryAgent } from './agents/Registry';
import { SurveillanceAgent } from './agents/Surveillance';
import { GeneratorAgent } from './agents/Generator';
import { DispatcherAgent } from './agents/Dispatcher';

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

const CHECK_INTERVAL_MS = (parseInt(process.env.CHECK_INTERVAL_MINUTES || '1') * 60 * 1000);
const GRACEFUL_RESTART_HOURS = 3;

// Global monitoring pause flag
let isMonitoringPaused: boolean = false;

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

    for (const order of orders) {
      try {
        Logger.debug(`[DEBUG] Processing order ${order.external_id} with status: ${order.status}`);

        if (order.status === 'READY_FOR_QR') {
          const processResult = await registry.checkWithStatus(order.external_id);
          if (processResult.dbError) {
            Logger.warn(`Registry unavailable for order ${order.external_id}, skipping to prevent duplicates`);
            continue;
          }

          if (processResult.status === 'PROCESSING' || processResult.status === 'READY_FOR_QR' || processResult.status === 'COMPLETED') {
            Logger.debug(`Order ${order.external_id} already processed (${order.status}), skipping`);
            continue;
          }

          if (!processResult.exists) {
            const reserved = await registry.reserveOrder(order.external_id, order.amount);
            if (!reserved) {
              Logger.warn(`Order ${order.external_id} already reserved, skipping`);
              continue;
            }
          }

          const orderData = await surveillance.prepareOrderData(order.external_id);
          const qrBuffer = await generator.generateQR(order.amount, orderData.installmentPeriod || undefined);
          await dispatcher.sendQRCode(qrBuffer, order.external_id, order.amount);
          await registry.updateOrderStatus(order.external_id, 'COMPLETED');
          processedCount++;
          continue;
        }

        const processResult = await registry.shouldProcessOrder(order);
        if (!processResult.shouldProcess) {
          if (processResult.reason === 'DB_ERROR') {
            Logger.warn(`Registry unavailable for order ${order.external_id}, skipping to prevent duplicates`);
          } else {
            Logger.debug(`Order ${order.external_id} already processed (${order.status}), skipping`);
          }
          continue;
        }

        if (order.status === 'PENDING') {
          const requiresSms = await surveillance.checkSmsConfirmationRequired(order.external_id);
          if (requiresSms) {
            await dispatcher.performSmsFlow(order.external_id, order.amount);
            smsCount++;
            continue;
          }

          if (processResult.reason === 'NEW') {
            await registry.register(order.external_id, order.amount, 'PENDING');
          }

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
