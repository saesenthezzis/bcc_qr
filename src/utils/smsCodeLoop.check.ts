// Self-check for the SMS code dialog loop and the «В обработке» QR rule (no network). Part of `npm test`.
import assert from 'assert';
import { runSmsCodeLoop, SmsCodeLoopDeps } from './smsCodeLoop';
import { shouldSendQrForInProcessing, IN_PROCESSING_QR_WINDOW_MS } from './inProcessingRule';
import { SmsCodeResult, SmsConfirmation } from '../types';

interface Script {
  codes: (string | null)[];          // what the staff answers on each request
  results: SmsCodeResult[];          // what the bank page shows after each submit
  dialogOpen?: boolean[];            // isDialogOpen answers, in call order (default: open)
  enterFails?: boolean;
}

function fake(script: Script) {
  const log = { asked: [] as string[], entered: [] as string[], wrong: 0 };
  let dialogCall = 0;
  const deps: SmsCodeLoopDeps = {
    askCode: async (kind, attempt) => { log.asked.push(`${kind}:${attempt}`); return script.codes.shift() ?? null; },
    enterCode: async (code) => { log.entered.push(code); return !script.enterFails; },
    submitCode: async () => script.results.shift() ?? 'FAILED',
    onWrongCode: async () => { log.wrong++; },
    isDialogOpen: async () => script.dialogOpen?.[dialogCall++] ?? true,
  };
  return { deps, log };
}

async function checkCodeLoop(): Promise<void> {
  // Right code at once
  let f = fake({ codes: ['1111'], results: ['ACCEPTED'] });
  assert.strictEqual(await runSmsCodeLoop(f.deps, 'A', 3), 'ACCEPTED');
  assert.deepStrictEqual(f.log.asked, ['FIRST:1']);

  // Wrong code -> the staff is asked again, second code accepted (the case from the chat)
  f = fake({ codes: ['1111', '2222'], results: ['WRONG', 'ACCEPTED'] });
  assert.strictEqual(await runSmsCodeLoop(f.deps, 'A', 3), 'ACCEPTED');
  assert.deepStrictEqual([f.log.asked, f.log.entered, f.log.wrong], [['FIRST:1', 'WRONG:2'], ['1111', '2222'], 1]);

  // Wrong every time -> stops after maxAttempts
  f = fake({ codes: ['1', '2', '3'], results: ['WRONG', 'WRONG', 'WRONG'] });
  assert.strictEqual(await runSmsCodeLoop(f.deps, 'A', 3), 'TOO_MANY_WRONG');
  assert.strictEqual(f.log.asked.length, 3);

  // Slow bank: called WRONG, but the dialog closed afterwards -> accepted, nobody is asked again
  f = fake({ codes: ['1111'], results: ['WRONG'], dialogOpen: [false] });
  assert.strictEqual(await runSmsCodeLoop(f.deps, 'A', 3), 'ACCEPTED');
  assert.deepStrictEqual([f.log.asked.length, f.log.wrong], [1, 0]);

  // Bank blocked the input
  f = fake({ codes: ['1111'], results: ['BLOCKED'] });
  assert.strictEqual(await runSmsCodeLoop(f.deps, 'A', 3), 'BLOCKED');

  // No answer / cancelled / could not type
  assert.strictEqual(await runSmsCodeLoop(fake({ codes: [null], results: [] }).deps, 'A', 3), 'NO_CODE');
  assert.strictEqual(await runSmsCodeLoop(fake({ codes: ['CANCELLED'], results: [] }).deps, 'A', 3), 'CANCELLED');
  assert.strictEqual(await runSmsCodeLoop(fake({ codes: ['1111'], results: [], enterFails: true }).deps, 'A', 3), 'FAILED');

  // Page misbehaved after submit
  assert.strictEqual(await runSmsCodeLoop(fake({ codes: ['1111'], results: ['FAILED'] }).deps, 'A', 3), 'FAILED');
}

function smsRec(status: SmsConfirmation['status'], lastSentAt?: string): SmsConfirmation {
  return {
    external_id: 'A', amount: 100, status, sms_attempts: 0, sent_count: 1,
    last_sent_at: lastSentAt, created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z',
  };
}

function checkInProcessingRule(): void {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const recent = new Date(now - 5 * 60 * 1000).toISOString();
  const old = new Date(now - IN_PROCESSING_QR_WINDOW_MS - 1000).toISOString();

  assert.strictEqual(shouldSendQrForInProcessing(smsRec('SMS_CONFIRMED', recent), now), true);
  // Old confirmation, manual confirmation (no record) or a code that was not accepted -> no QR
  assert.strictEqual(shouldSendQrForInProcessing(smsRec('SMS_CONFIRMED', old), now), false);
  assert.strictEqual(shouldSendQrForInProcessing(null, now), false);
  assert.strictEqual(shouldSendQrForInProcessing(smsRec('SMS_TIMEOUT', recent), now), false);
  assert.strictEqual(shouldSendQrForInProcessing(smsRec('SMS_BLOCKED', recent), now), false);
}

async function main(): Promise<void> {
  await checkCodeLoop();
  checkInProcessingRule();
  console.log('smsCodeLoop: all checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
