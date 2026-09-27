import { Logger } from './Logger';
import { SmsCodeLoopOutcome, SmsCodeResult } from '../types';

export type CodeRequestKind = 'FIRST' | 'WRONG';

/** Only what the code loop needs — Telegram and the browser are behind these three calls. */
export interface SmsCodeLoopDeps {
  /** Asks the staff for the code; resolves with the digits, 'CANCELLED', or null when nobody answered in time. */
  askCode: (kind: CodeRequestKind, attempt: number) => Promise<string | null>;
  enterCode: (code: string) => Promise<boolean>;
  submitCode: () => Promise<SmsCodeResult>;
  onWrongCode?: (attempt: number) => Promise<void>;
  /** The bank's code dialog is still on screen (a slow bank may close it after we called the code wrong). */
  isDialogOpen: () => Promise<boolean>;
}

/**
 * One SMS code dialog on the bank page. A wrong code leaves the dialog open, so the bot asks
 * the staff again (up to maxAttempts) instead of giving up after the first mistake.
 */
export async function runSmsCodeLoop(
  deps: SmsCodeLoopDeps,
  orderId: string,
  maxAttempts: number
): Promise<SmsCodeLoopOutcome> {
  let kind: CodeRequestKind = 'FIRST';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (kind === 'WRONG' && !(await deps.isDialogOpen())) {
      Logger.info(`[SMS] Code dialog closed late for ${orderId}, the previous code was accepted`);
      return 'ACCEPTED';
    }

    const code = await deps.askCode(kind, attempt);
    if (code === null) return 'NO_CODE';
    if (code === 'CANCELLED') return 'CANCELLED';

    if (!(await deps.enterCode(code))) {
      Logger.warn(`[SMS] Could not type the code for ${orderId} (attempt ${attempt})`);
      return 'FAILED';
    }

    const result = await deps.submitCode();
    Logger.info(`[SMS] Code attempt ${attempt}/${maxAttempts} for ${orderId}: ${result}`);
    if (result === 'ACCEPTED') return 'ACCEPTED';
    if (result === 'BLOCKED') return 'BLOCKED';
    if (result === 'FAILED') return 'FAILED';

    kind = 'WRONG';
    if (!(await deps.isDialogOpen())) {
      Logger.info(`[SMS] Code dialog closed late for ${orderId}, the code was accepted`);
      return 'ACCEPTED';
    }
    await deps.onWrongCode?.(attempt).catch(() => {});
  }

  return 'TOO_MANY_WRONG';
}
