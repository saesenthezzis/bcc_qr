import { Logger } from './Logger';
import type { RegistryAgent } from '../agents/Registry';
import type { GeneratorAgent } from '../agents/Generator';
import type { DispatcherAgent } from '../agents/Dispatcher';
import type { SurveillanceAgent } from '../agents/Surveillance';

/** Only the agent methods QR delivery needs — keeps the flow testable with fakes. */
export interface QrDeliveryDeps {
  registry: Pick<RegistryAgent, 'claimOrderForQr' | 'updateOrderStatus'>;
  generator: Pick<GeneratorAgent, 'generateQR'>;
  dispatcher: Pick<DispatcherAgent, 'sendQRCode'>;
  surveillance: Pick<
    SurveillanceAgent,
    'getInstallmentPeriodFromCurrentSidebar' | 'prepareOrderData' | 'closeSidebar' | 'verifySmsCompletion'
  >;
}

export interface BankConfirmOptions {
  pollMs: number;
  timeoutMs: number;
}

export async function resolveInstallmentPeriod(deps: QrDeliveryDeps, orderId: string): Promise<string | null> {
  const fromOpenSidebar = await deps.surveillance.getInstallmentPeriodFromCurrentSidebar(orderId).catch(() => null);
  if (fromOpenSidebar) return fromOpenSidebar;
  const orderData = await deps.surveillance.prepareOrderData(orderId).catch(() => ({ installmentPeriod: null }));
  return orderData.installmentPeriod;
}

/**
 * Single entry point for QR delivery. The atomic DB claim guarantees at most one QR per order,
 * and a DB error means no QR ("не уверен — не стреляй").
 */
export async function sendQrOnce(deps: QrDeliveryDeps, orderId: string, amount: number): Promise<boolean> {
  const claimed = await deps.registry.claimOrderForQr(orderId, amount);
  if (!claimed) {
    Logger.info(`[QR] Skip ${orderId}: already claimed/completed or DB unavailable`);
    return false;
  }

  try {
    const installmentPeriod = await resolveInstallmentPeriod(deps, orderId);
    const qrBuffer = await deps.generator.generateQR(amount, installmentPeriod || undefined);
    await deps.dispatcher.sendQRCode(qrBuffer, orderId, amount);
  } catch (error) {
    // sendQRCode throws only if no chat received the QR, so releasing the claim cannot cause a duplicate
    Logger.error(`[QR] Failed for ${orderId}, releasing claim: ${error}`);
    await deps.registry.updateOrderStatus(orderId, 'PENDING', amount).catch(() => {});
    return false;
  }

  // ponytail: if this write fails the row stays PROCESSING and blocks resends — manual check via logs
  await deps.registry.updateOrderStatus(orderId, 'COMPLETED', amount).catch((error) => {
    Logger.error(`[QR] Sent for ${orderId} but failed to mark COMPLETED (row left PROCESSING): ${error}`);
  });
  Logger.info(`[QR] Sent for ${orderId}`);
  return true;
}

/**
 * A closed SMS modal does not mean the bank approved the order. The QR is sent only after the table
 * shows "Подтверждено" (same rule as the regular READY_FOR_QR path), polled briefly to avoid the cycle delay.
 * If the bank has not confirmed within the window, the regular cycle picks the order up later.
 */
export async function sendQrWhenBankConfirms(
  deps: QrDeliveryDeps,
  orderId: string,
  amount: number,
  options: BankConfirmOptions
): Promise<boolean> {
  await deps.surveillance.closeSidebar(orderId).catch(() => {});

  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (await deps.surveillance.verifySmsCompletion(orderId)) {
      Logger.info(`[SMS->QR] Bank confirmed ${orderId}, sending QR`);
      return await sendQrOnce(deps, orderId, amount);
    }
    await new Promise(resolve => setTimeout(resolve, options.pollMs));
  }

  Logger.info(`[SMS->QR] ${orderId} not confirmed by bank within ${options.timeoutMs / 1000}s, leaving to regular cycle`);
  return false;
}
