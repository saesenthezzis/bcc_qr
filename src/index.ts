import { config } from 'dotenv';
import express, { Express, Request, Response } from 'express';
import { Logger } from './utils/Logger';
import { RegistryAgent } from './agents/Registry';
import { SurveillanceAgent } from './agents/Surveillance';
import { GeneratorAgent } from './agents/Generator';
import { DispatcherAgent } from './agents/Dispatcher';

config();

Logger.info('CreditBridge RPA Engine starting...');

const isProduction = process.env.NODE_ENV === 'production';
const isRender = process.env.RENDER === 'true' || !!process.env.PORT;

Logger.info(`Environment: NODE_ENV=${process.env.NODE_ENV || 'development'}, isRender=${isRender}`);

const requiredEnvVars = ['BANK_URL', 'BANK_LOGIN', 'BANK_PASSWORD', 'SUPABASE_URL', 'SUPABASE_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_IDS'];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    Logger.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const registry = new RegistryAgent(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!);
const surveillance = new SurveillanceAgent(process.env.BANK_URL!, process.env.BANK_LOGIN!, process.env.BANK_PASSWORD!);
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
    let pendingCount = 0;

    for (const order of orders) {
      try {
        const processResult = await registry.shouldProcessOrder(order);

        if (!processResult.shouldProcess) {
          Logger.debug(`Order ${order.external_id} already processed (${order.status}), skipping`);
          continue;
        }

        if (processResult.reason === 'NEW') {
          Logger.info(`Processing new order ${order.external_id} (${order.amount} KZT, ${order.status})`);

          if (order.status === 'PENDING') {
            await dispatcher.sendConfirmationAlert(order.external_id, order.amount);
            await registry.register(order.external_id, order.amount, 'PENDING');
            pendingCount++;
            Logger.info(`Order ${order.external_id} registered as PENDING, alert sent`);
          } else if (order.status === 'READY_FOR_QR') {
            const qrBuffer = await generator.generateQR(order.amount);
            await dispatcher.sendQRCode(qrBuffer, order.external_id, order.amount);
            await registry.register(order.external_id, order.amount, 'READY_FOR_QR');
            processedCount++;
            Logger.info(`Order ${order.external_id} processed successfully (QR sent)`);
          }
        }

        if (processResult.reason === 'STATUS_CHANGED') {
          Logger.info(`Order ${order.external_id} status changed to READY_FOR_QR`);

          const qrBuffer = await generator.generateQR(order.amount);
          await dispatcher.sendQRCode(qrBuffer, order.external_id, order.amount);

          await registry.updateOrderStatus(order.external_id, 'READY_FOR_QR');
          processedCount++;
          Logger.info(`Order ${order.external_id} QR sent, status updated`);
        }

      } catch (error) {
        Logger.error(`Failed to process order ${order.external_id}: ${error}`);
      }
    }

    Logger.info(`--- Cycle complete: ${processedCount} QR sent, ${pendingCount} pending alerts ---`);

  } catch (error) {
    const errorMessage = String(error);

    const isTimeoutError = errorMessage.includes('Timeout') || errorMessage.includes('timeout');
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

    Logger.error(`Critical error in processing cycle: ${error}`);
    await dispatcher.sendErrorMessage(error);
    throw error;
  }
}

async function main(): Promise<void> {
  await startKeepAliveServer();
  Logger.info(`Health check server is live on port ${process.env.PORT || 3000}`);

  Logger.info(`Starting scheduler with ${CHECK_INTERVAL_MS / 1000}s interval`);

  const restartTimeout = GRACEFUL_RESTART_HOURS * 60 * 60 * 1000;

  try {
    await surveillance.initBrowser();

    if (isRender) {
      Logger.info('Running on Render cloud, sending startup notification...');
      await dispatcher.sendStartupNotification();
    }

    Logger.info('CreditBridge RPA Engine is ready and running!');

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
