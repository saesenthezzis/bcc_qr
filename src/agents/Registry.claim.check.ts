// Self-check for RegistryAgent.claimOrderForQr (no network). Run: npx ts-node src/agents/Registry.claim.check.ts
import assert from 'assert';
import { RegistryAgent } from './Registry';
import { Logger } from '../utils/Logger';

interface FakeRow { status: string }

// Minimal fake of the supabase query chain used by claimOrderForQr; the UPDATE is check-and-set like Postgres
function fakeClient(rows: Map<string, FakeRow>, opts: { failUpdate?: boolean } = {}) {
  return {
    from: () => ({
      upsert: async (row: { external_id: string; amount: number; status: string }) => {
        const key = `${row.external_id}:${row.amount}`;
        if (!rows.has(key)) rows.set(key, { status: row.status });
        return { error: null };
      },
      update: (patch: { status: string }) => {
        const filter: Record<string, unknown> = {};
        let allowed: string[] = [];
        const builder = {
          eq: (col: string, val: unknown) => { filter[col] = val; return builder; },
          in: (_col: string, vals: string[]) => { allowed = vals; return builder; },
          select: async () => {
            if (opts.failUpdate) return { data: null, error: { message: 'db down' } };
            const row = rows.get(`${filter.external_id}:${filter.amount}`);
            if (!row || !allowed.includes(row.status)) return { data: [], error: null };
            row.status = patch.status;
            return { data: [{ external_id: filter.external_id }], error: null };
          },
        };
        return builder;
      },
    }),
  };
}

async function main(): Promise<void> {
  const registry = new RegistryAgent('http://localhost', 'test-key', new Logger());
  const setClient = (client: unknown) => { (registry as unknown as { client: unknown }).client = client; };

  // Concurrent claims of a new order: exactly one wins
  const rows = new Map<string, FakeRow>();
  setClient(fakeClient(rows));
  const results = await Promise.all([1, 2, 3].map(() => registry.claimOrderForQr('111', 1000)));
  assert.strictEqual(results.filter(Boolean).length, 1, 'only one concurrent claim may win');

  // Completed or in-flight orders are never claimed again
  rows.set('222:500', { status: 'COMPLETED' });
  assert.strictEqual(await registry.claimOrderForQr('222', 500), false);
  assert.strictEqual(await registry.claimOrderForQr('111', 1000), false, 'PROCESSING must block');

  // Existing PENDING row (alert already sent) is claimable once
  rows.set('333:700', { status: 'PENDING' });
  assert.strictEqual(await registry.claimOrderForQr('333', 700), true);

  // DB error means no QR
  setClient(fakeClient(new Map(), { failUpdate: true }));
  assert.strictEqual(await registry.claimOrderForQr('444', 100), false);

  console.log('claimOrderForQr: all checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
