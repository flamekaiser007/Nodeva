// Boots the REAL Express app on a real port and drives it with real fetch
// calls -- this endpoint composes auth, provider/node ownership, and a
// hand-written earnings query, and the seams between those are exactly
// where a unit test of any one piece would miss a real bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/api/server.js';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://nodeva:nodeva_dev@localhost:5433/nodeva';
process.env.JWT_SECRET ??= crypto.randomBytes(32).toString('hex');

let pool, server, base;
let dbAvailable = false;
try {
  pool = createPool(DATABASE_URL, { connectionTimeoutMillis: 2000 });
  await pool.query('SELECT 1');
  const { app } = createApp(pool);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
  dbAvailable = true;
} catch { /* skipped below */ }

const skip = !dbAvailable && 'requires a reachable Postgres (see docker-compose.yml)';
test.after(() => { server?.close(); pool?.end(); });

async function signup(displayName) {
  const res = await fetch(`${base}/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `dash-${crypto.randomUUID()}@test.local`,
      password: 'correct horse battery staple', display_name: displayName,
    }),
  });
  return res.json();
}

function authed(token) { return { authorization: `Bearer ${token}` }; }

test('the dashboard 404s for a user who is not a provider yet', { skip }, async () => {
  const { token } = await signup('Not A Provider');
  const res = await fetch(`${base}/providers/me/dashboard`, { headers: authed(token) });
  assert.equal(res.status, 404);
});

test('a fresh provider sees zero nodes, null reliability, zero earnings', { skip }, async () => {
  const { token } = await signup('Fresh Provider');
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(token) });
  const res = await fetch(`${base}/providers/me/dashboard`, { headers: authed(token) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.nodes, []);
  assert.equal(body.reputation.reliability, null,
    'no jobs yet must read as unknown, not a misleading 0% or 100%');
  assert.equal(body.earnings.available_paise, 0);
});

test('an enrolled node appears in the dashboard, offline (no worker connected)', { skip }, async () => {
  const { token } = await signup('Provider With A Node');
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(token) });
  const pubKeyHex = crypto.randomBytes(32).toString('hex');
  const enrollRes = await fetch(`${base}/nodes`, {
    method: 'POST', headers: { ...authed(token), 'content-type': 'application/json' },
    body: JSON.stringify({
      public_key_hex: pubKeyHex, gpu_model: 'RTX 4090',
      gpu_vram_mb: 24576, cpu_cores: 16, ram_mb: 32768, price_paise_hr: 4300,
    }),
  });
  const { node_id } = await enrollRes.json();

  const res = await fetch(`${base}/providers/me/dashboard`, { headers: authed(token) });
  const body = await res.json();
  assert.equal(body.nodes.length, 1);
  assert.equal(body.nodes[0].node_id, node_id);
  assert.equal(body.nodes[0].online, false, 'no worker connected in this test -- must not claim online');
  assert.equal(body.nodes[0].heartbeat, null);
});

test("a provider cannot see another provider's dashboard via their own token", { skip }, async () => {
  // Not a shared/global dashboard -- /providers/me derives the provider
  // strictly from the caller's own session, same ownership discipline as
  // reservations. Two different providers, two different dashboards.
  const a = await signup('Provider A');
  const b = await signup('Provider B');
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(a.token) });
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(b.token) });
  await fetch(`${base}/nodes`, {
    method: 'POST', headers: { ...authed(a.token), 'content-type': 'application/json' },
    body: JSON.stringify({
      public_key_hex: crypto.randomBytes(32).toString('hex'), gpu_model: 'A',
      gpu_vram_mb: 1, cpu_cores: 1, ram_mb: 1, price_paise_hr: 1,
    }),
  });
  const bDash = await (await fetch(`${base}/providers/me/dashboard`, { headers: authed(b.token) })).json();
  assert.deepEqual(bDash.nodes, [], "B's dashboard must not include A's node");
});

test('earnings buckets reflect real ledger entries, not just a lifetime total', { skip }, async () => {
  const { token } = await signup('Earning Provider');
  const providerId = (await (await fetch(`${base}/providers/me`, {
    method: 'POST', headers: authed(token),
  })).json()).provider_id;

  // Seed ledger entries directly with explicit created_at timestamps --
  // this is the only way to control "how long ago" without waiting for
  // real time to pass, and the point of this test is the bucket boundary
  // logic in the SQL, not the settlement path that normally produces these
  // rows (already covered by reputation-integration.test.js).
  const txn = crypto.randomUUID();
  await pool.query(
    `INSERT INTO ledger_transactions (txn_id, kind, idempotency_key) VALUES ($1,'settle',$2)`,
    [txn, txn]);
  const acct = (await pool.query(
    `INSERT INTO ledger_accounts (kind, owner_provider_id) VALUES ('provider_balance',$1)
     RETURNING account_id`, [providerId])).rows[0].account_id;
  // A lone credit with no offsetting debit is exactly what the deferred
  // balance trigger (from the very first migration) exists to reject --
  // confirmed the hard way when this test's first draft omitted the
  // counter-entry and the transaction correctly failed to commit. A
  // throwaway platform_revenue account plays the counterparty here, mirroring
  // real settlement's shape without needing a whole reservation fixture.
  // platform_revenue is a platform-wide singleton (see ledger_accounts'
  // NULLS NOT DISTINCT unique constraint) -- other tests and e2e runs
  // sharing this database may have already created it, so look it up
  // instead of assuming a fresh INSERT will succeed.
  const existingCounter = await pool.query(
    `SELECT account_id FROM ledger_accounts WHERE kind = 'platform_revenue'`);
  const counterAcct = existingCounter.rows[0]
    ? existingCounter.rows[0].account_id
    : (await pool.query(
        `INSERT INTO ledger_accounts (kind) VALUES ('platform_revenue') RETURNING account_id`
      )).rows[0].account_id;
  // One entry 2 days ago (inside the week bucket, outside today),
  // one entry 40 days ago (outside every bucket except lifetime).
  await pool.query(
    `INSERT INTO ledger_entries (txn_id, account_id, amount_paise, created_at) VALUES
       ($1,$2, 1000, now() - interval '2 days'), ($1,$3, -1000, now() - interval '2 days'),
       ($1,$2,  500, now() - interval '40 days'), ($1,$3,  -500, now() - interval '40 days')`,
    [txn, acct, counterAcct]);

  const body = await (await fetch(`${base}/providers/me/dashboard`, { headers: authed(token) })).json();
  assert.equal(body.earnings.available_paise, 1500, 'lifetime total includes everything');
  assert.equal(body.earnings.today_paise, 0, 'neither entry is from the last 24h');
  assert.equal(body.earnings.week_paise, 1000, 'only the 2-day-old entry is within 7 days');
  assert.equal(body.earnings.month_paise, 1000, 'the 40-day-old entry is outside the 30-day bucket');
});
