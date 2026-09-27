import { SmsConfirmation } from '../types';

/** How long after an accepted code an order in «В обработке» may still get its QR from the regular cycle. */
export const IN_PROCESSING_QR_WINDOW_MS = 60 * 60 * 1000;

/**
 * «В обработке» alone does not say who confirmed the order. The QR is sent only when the bot itself
 * got the SMS code accepted within the window — older or manually handled orders never get a second QR.
 */
export function shouldSendQrForInProcessing(smsRec: SmsConfirmation | null, now: number): boolean {
  if (!smsRec || smsRec.status !== 'SMS_CONFIRMED') return false;
  // last_sent_at is written by the bot at the start of every SMS flow; updated_at depends on a DB trigger
  const flowAt = new Date(smsRec.last_sent_at ?? smsRec.updated_at).getTime();
  if (Number.isNaN(flowAt)) return false;
  return now - flowAt <= IN_PROCESSING_QR_WINDOW_MS;
}
