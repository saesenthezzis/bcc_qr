// Self-check for the "send SMS?" ask limit (no network). Part of `npm test`.
import assert from 'assert';
import { SmsAskTracker } from './smsAskTracker';

function main(): void {
  // Nobody answers: asked exactly 5 times, the 5th end parks the order and posts the button once
  let t = new SmsAskTracker(5);
  const ends: boolean[] = [];
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(t.canStart('A', 100), 'ASK');
    ends.push(t.finish('A', 100, 'NO_ANSWER'));
  }
  assert.deepStrictEqual(ends, [false, false, false, false, true]);
  assert.strictEqual(t.canStart('A', 100), 'NO');
  assert.strictEqual(t.canStart('A', 100), 'NO');

  // Same masked ИИН, other amount = other order, not affected (the case of ********0959)
  assert.strictEqual(t.canStart('A', 200), 'ASK');

  // Button pressed: next start sends the SMS without the question, then a new round of 5 asks
  t.resume('A', 100);
  assert.strictEqual(t.canStart('A', 100), 'RESUME');
  assert.strictEqual(t.finish('A', 100, 'NO_ANSWER'), false);
  assert.strictEqual(t.canStart('A', 100), 'ASK');

  // "Не отправлять", too many wrong codes, bank block: parked at once with the button
  for (const end of ['DECLINED', 'STOPPED'] as const) {
    t = new SmsAskTracker(5);
    assert.strictEqual(t.finish('B', 1, end), true);
    assert.strictEqual(t.canStart('B', 1), 'NO');
  }

  // Code accepted: never asked again, no button
  t = new SmsAskTracker(5);
  assert.strictEqual(t.finish('C', 1, 'CONFIRMED'), false);
  assert.strictEqual(t.canStart('C', 1), 'NO');

  console.log('smsAskTracker: all checks passed');
}

main();
