import { config } from 'dotenv';
import * as path from 'path';
import { Logger } from './utils/Logger';
import { RegistryAgent } from './agents/Registry';
import { SurveillanceAgent } from './agents/Surveillance';
import { GeneratorAgent } from './agents/Generator';
import { DispatcherAgent } from './agents/Dispatcher';
import { getBccCode } from './utils/InstallmentMapper';

// Load test environment
config({ path: path.join(process.cwd(), '.env.test') });

Logger.info('=== TEST MODE: Production-like flow with Installment Mapping ===');

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
    Logger.info(`Test: Parsing installment period for order ${orderId}...`);
    
    // Get page from surveillance (we need to access private page)
    const page = (surveillance as any).page;
    if (!page) {
      Logger.warn('Test: Page not available for sidebar parsing');
      return null;
    }

    // Click on the order row to open sidebar
    Logger.info(`Test: Looking for order ${orderId} in table...`);
    const rows = await page.$$('.bcc-table-body__row');
    
    for (const row of rows) {
      const cells = await row.$$('td');
      if (cells.length < 1) continue;
      
      const idCell = cells[0];
      const rowId = (await idCell.innerText()).trim();
      
      if (rowId === orderId) {
        Logger.info(`Test: Found order ${orderId}, clicking to open sidebar...`);
        await row.click();
        await page.waitForTimeout(3000); // Wait for sidebar to fully load
        break;
      }
    }

    // Wait for sidebar to appear
    await page.waitForTimeout(1000);

    // Parse installment period using precise selector
    Logger.info(`Test: Parsing installment period with precise selector...`);
    
    try {
      // Try precise selector first: div:has(> span:text("Рассрочка")) >> span.bcc-typography-paragraph_view_medium
      const installmentElement = await page.$('div:has(> span:text("Рассрочка")) span.bcc-typography-paragraph_view_medium');
      
      if (installmentElement) {
        const installmentText = await installmentElement.innerText();
        Logger.info(`Test: Found installment text with precise selector: "${installmentText}"`);
        
        // Parse the value (e.g., "18 мес." -> "18 месяцев")
        const periodMatch = installmentText.match(/(\d+)\s*(месяц|месяца|месяцев|мес\.?)/i);
        if (periodMatch) {
          const installmentPeriod = `${periodMatch[1]} месяцев`;
          const bccCode = getBccCode(installmentPeriod);
          Logger.info(`Test: ✅ Parsed: ${installmentText} -> ${installmentPeriod} -> Code: ${bccCode}`);
          
          // Close sidebar using close button
          await closeSidebar(page);
          
          return installmentPeriod;
        }
      }
    } catch (selectorError) {
      Logger.warn(`Test: Precise selector failed, trying fallback: ${selectorError}`);
    }

    // Fallback: search in all text
    Logger.info(`Test: Using fallback text search...`);
    const bodyText = await page.textContent('body');
    if (bodyText) {
      const periodMatch = bodyText.match(/(\d+)\s*(месяц|месяца|месяцев|мес\.?)/i);
      if (periodMatch) {
        const installmentPeriod = `${periodMatch[1]} месяцев`;
        const bccCode = getBccCode(installmentPeriod);
        Logger.info(`Test: ✅ Found with fallback: ${installmentPeriod} -> Code: ${bccCode}`);
        
        // Close sidebar
        await closeSidebar(page);
        
        return installmentPeriod;
      }
    }

    Logger.warn(`Test: ❌ Installment period not found for order ${orderId}`);
    
    // Close sidebar anyway
    await closeSidebar(page);
    
    // Return default value (6 months) as fallback
    Logger.warn(`Test: Using default value: 6 месяцев (KZ282)`);
    return '6 месяцев';
    
  } catch (error) {
    Logger.error(`Test: Failed to parse installment period for ${orderId}: ${error}`);
    
    // Try to close sidebar
    try {
      const page = (surveillance as any).page;
      if (page) await closeSidebar(page);
    } catch (closeError) {
      Logger.warn(`Test: Could not close sidebar: ${closeError}`);
    }
    
    // Return default value
    return '6 месяцев';
  }
}

async function closeSidebar(page: any): Promise<void> {
  try {
    Logger.info(`Test: Closing sidebar...`);
    
    // Try to click close button: div.bcc-fridge-header__close button
    const closeButton = await page.$('div.bcc-fridge-header__close button');
    if (closeButton) {
      await closeButton.click();
      Logger.info(`Test: Sidebar closed via close button`);
      await page.waitForTimeout(500);
      return;
    }
    
    // Fallback: try .bcc-button_iconOnly in header
    const iconButton = await page.$('.bcc-fridge-header .bcc-button_iconOnly');
    if (iconButton) {
      await iconButton.click();
      Logger.info(`Test: Sidebar closed via icon button`);
      await page.waitForTimeout(500);
      return;
    }
    
    // Last resort: Escape key
    Logger.info(`Test: Closing sidebar with Escape key`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    
  } catch (error) {
    Logger.warn(`Test: Error closing sidebar: ${error}`);
    // Try Escape as last resort
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  }
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
        // TEST MODE: Process ALL orders with "Выдано" status, ignore DB checks
        if (order.status === 'PENDING') {
          Logger.info(`Test: Skipping PENDING order ${order.external_id} (needs confirmation)`);
          pendingCount++;
          continue;
        }

        if (order.status === 'READY_FOR_QR') {
          Logger.info(`Test: Processing order ${order.external_id} (${order.amount} KZT, ${order.status})`);

          // Parse installment period from sidebar
          const installmentPeriod = await parseInstallmentPeriodFromSidebar(surveillance, order.external_id);
          
          if (!installmentPeriod) {
            Logger.warn(`Test: Could not parse installment period for ${order.external_id}, skipping`);
            continue;
          }

          // Generate QR with installment period
          const qrBuffer = await generator.generateQR(order.amount, installmentPeriod);
          await dispatcher.sendQRCode(qrBuffer, order.external_id, order.amount);

          processedCount++;
          Logger.info(`Test: ✅ Order ${order.external_id} processed (QR sent with installment: ${installmentPeriod})`);
          
          // Small delay between orders
          await new Promise(resolve => setTimeout(resolve, 1000));
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
  Logger.info('Test: Starting test run (single cycle)...');

  try {
    await surveillance.initBrowser();
    Logger.info('Test: Browser initialized');

    Logger.info('Test: Running single processing cycle...');
    await processOrders();

    Logger.info('Test: Cycle completed, keeping browser open for 10 seconds...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    Logger.info('Test: Completed successfully');
    await surveillance.close();
    await dispatcher.stop();
    process.exit(0);

  } catch (error) {
    Logger.error(`Test: Fatal error - ${error}`);
    await surveillance.close();
    await dispatcher.stop();
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  Logger.info('Test: Interrupted by user');
  await surveillance.close();
  await dispatcher.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  Logger.info('Test: Received SIGTERM, shutting down...');
  await surveillance.close();
  await dispatcher.stop();
  process.exit(0);
});

main().catch((error) => {
  Logger.error(`Test: Failed to start - ${error}`);
  process.exit(1);
});
