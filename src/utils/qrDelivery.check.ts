// Self-check for QR delivery flow (no network, fake agents). Run: npx ts-node src/utils/qrDelivery.check.ts
import assert from 'assert';
import { QrDeliveryDeps, sendQrOnce, sendQrWhenBankConfirms } from './qrDelivery';

interface FakeOptions {
  claim?: boolean;
  sendFails?: boolean;
  completeFails?: boolean;
  openSidebarPeriod?: string | null;
  bankConfirmsAfter?: number; // verifySmsCompletion returns true on this call (1-based); undefined = never
}

function fakeDeps(opts: FakeOptions = {}) {
  const calls = { sent: 0, statuses: [] as string[], periods: [] as (string | undefined)[], verifies: 0, prepared: 0 };
  const deps: QrDeliveryDeps = {
    registry: {
      claimOrderForQr: async () => opts.claim ?? true,
      updateOrderStatus: async (_id, status) => {
        calls.statuses.push(status);
        if (status === 'COMPLETED' && opts.completeFails) throw new Error('db down');
      },
    },
    generator: {
      generateQR: async (_amount, period) => { calls.periods.push(period); return Buffer.from('qr'); },
    },
    dispatcher: {
      sendQRCode: async () => {
        if (opts.sendFails) throw new Error('telegram down');
        calls.sent++;
      },
    },
    surveillance: {
      getInstallmentPeriodFromCurrentSidebar: async () => opts.openSidebarPeriod ?? null,
      prepareOrderData: async () => { calls.prepared++; return { installmentPeriod: '6 месяцев' }; },
      closeSidebar: async () => {},
      verifySmsCompletion: async () => ++calls.verifies === opts.bankConfirmsAfter,
    },
  };
  return { deps, calls };
}

async function main(): Promise<void> {
  // Claim lost (duplicate or DB error) -> nothing is generated or sent
  let f = fakeDeps({ claim: false });
  assert.strictEqual(await sendQrOnce(f.deps, 'A', 100), false);
  assert.deepStrictEqual([f.calls.sent, f.calls.periods.length], [0, 0]);

  // Happy path: period from this order's open sidebar, row marked COMPLETED
  f = fakeDeps({ openSidebarPeriod: '12 месяцев' });
  assert.strictEqual(await sendQrOnce(f.deps, 'A', 100), true);
  assert.deepStrictEqual([f.calls.sent, f.calls.periods, f.calls.statuses], [1, ['12 месяцев'], ['COMPLETED']]);
  assert.strictEqual(f.calls.prepared, 0);

  // No open sidebar for this order -> period read by opening the order's sidebar
  f = fakeDeps();
  await sendQrOnce(f.deps, 'A', 100);
  assert.deepStrictEqual([f.calls.prepared, f.calls.periods], [1, ['6 месяцев']]);

  // Delivery failed everywhere -> claim released for retry, not COMPLETED
  f = fakeDeps({ sendFails: true });
  assert.strictEqual(await sendQrOnce(f.deps, 'A', 100), false);
  assert.deepStrictEqual(f.calls.statuses, ['PENDING']);

  // QR delivered but COMPLETED write failed -> still reported as sent, no throw, no release
  f = fakeDeps({ completeFails: true });
  assert.strictEqual(await sendQrOnce(f.deps, 'A', 100), true);
  assert.deepStrictEqual(f.calls.statuses, ['COMPLETED']);

  // Bank confirms on 3rd poll -> exactly one QR
  const fast = { pollMs: 1, timeoutMs: 1000 };
  f = fakeDeps({ bankConfirmsAfter: 3 });
  assert.strictEqual(await sendQrWhenBankConfirms(f.deps, 'A', 100, fast), true);
  assert.deepStrictEqual([f.calls.verifies, f.calls.sent], [3, 1]);

  // Bank never confirms -> no QR, regular cycle takes over
  f = fakeDeps();
  assert.strictEqual(await sendQrWhenBankConfirms(f.deps, 'A', 100, { pollMs: 1, timeoutMs: 30 }), false);
  assert.strictEqual(f.calls.sent, 0);

  console.log('qrDelivery: all checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
