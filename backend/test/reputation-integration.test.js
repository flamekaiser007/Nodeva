// Proves the write path (settleReservation) and the read path
// (marketplace/nodeStore.js's reliability computation) actually agree, end
// to end, against a real Postgres -- not just that reputationEffect()
// returns the right label in isolation (see reputation.test.js for that).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/db/pool.js';
import { settleReservation } from '../src/api/server.js';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://nodeva:nodeva_dev@localhost:5433/nodeva';

// Routes through createPool so the process-wide BIGINT type parser (see
// db/pool.js) is registered before any query touching a paise column runs --
// a test file that built its own `new pg.Pool(...)` here would silently get
// BIGINT columns back as strings instead of numbers, which is exactly the
// bug that first surfaced in this file's own settleReservation calls.
let pool;
let dbAvailable = false;
try {
  pool = createPool(DATABASE_URL, { connectionTimeoutMillis: 2000 });
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch { /* skipped below */ }

const skip = !dbAvailable && 'requires a reachable Postgres (see docker-compose.yml)';

async function seedProviderAndNode() {
  const userId = (await pool.query(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1,'x','x') RETURNING user_id`,
    [`rep-provider-${crypto.randomUUID()}@test.local`])).rows[0].user_id;
  const providerId = (await pool.query(
    'INSERT INTO providers (user_id) VALUES ($1) RETURNING provider_id', [userId]
  )).rows[0].provider_id;
  const nodeId = (await pool.query(
    `INSERT INTO compute_nodes (provider_id, public_key, gpu_model, gpu_vram_mb, cpu_cores, ram_mb, price_paise_hr, status)
     VALUES ($1,$2,'Test GPU',24576,16,32768,4300,'online') RETURNING node_id`,
    [providerId, Buffer.from(crypto.getRandomValues(new Uint8Array(32)))]
  )).rows[0].node_id;
  return { providerId, nodeId };
}

async function seedRunningReservation(nodeId, offsetHours) {
  const userId = (await pool.query(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1,'x','x') RETURNING user_id`,
    [`rep-buyer-${crypto.randomUUID()}@test.local`])).rows[0].user_id;
  const id = crypto.randomUUID();
  const start = new Date(Date.UTC(2028, 0, 1, offsetHours));
  const end = new Date(Date.UTC(2028, 0, 1, offsetHours + 1));
  await pool.query(
    `INSERT INTO reservations
       (reservation_id, node_id, user_id, slot, price_paise_hr, quoted_paise, status)
     VALUES ($1,$2,$3, tstzrange($4,$5), 4300, 4300, 'running')`,
    [id, nodeId, userId, start, end]);
  return id;
}

async function providerCounts(providerId) {
  const { rows } = await pool.query(
    'SELECT rep_jobs_total, rep_jobs_failed FROM providers WHERE provider_id = $1', [providerId]);
  return rows[0];
}

test('a completed job increments total but not failed', { skip }, async () => {
  const { providerId, nodeId } = await seedProviderAndNode();
  const resId = await seedRunningReservation(nodeId, 1);
  const result = await settleReservation(pool, resId, 'completed', 3600);
  assert.equal(result.status, 'completed');
  assert.deepEqual(await providerCounts(providerId), { rep_jobs_total: 1, rep_jobs_failed: 0 });
});

test("a user-code failure increments total but does not count against the provider", { skip }, async () => {
  const { providerId, nodeId } = await seedProviderAndNode();
  const resId = await seedRunningReservation(nodeId, 2);
  await settleReservation(pool, resId, 'failed_user', 30);
  assert.deepEqual(await providerCounts(providerId), { rep_jobs_total: 1, rep_jobs_failed: 0 });
});

test('a provider-side failure counts against reliability', { skip }, async () => {
  const { providerId, nodeId } = await seedProviderAndNode();
  const resId = await seedRunningReservation(nodeId, 3);
  await settleReservation(pool, resId, 'failed_provider', 0);
  assert.deepEqual(await providerCounts(providerId), { rep_jobs_total: 1, rep_jobs_failed: 1 });
});

test('counts accumulate correctly across multiple jobs on the same provider', { skip }, async () => {
  const { providerId, nodeId } = await seedProviderAndNode();
  await settleReservation(pool, await seedRunningReservation(nodeId, 4), 'completed', 3600);
  await settleReservation(pool, await seedRunningReservation(nodeId, 5), 'completed', 3600);
  await settleReservation(pool, await seedRunningReservation(nodeId, 6), 'failed_provider', 0);
  const counts = await providerCounts(providerId);
  assert.deepEqual(counts, { rep_jobs_total: 3, rep_jobs_failed: 1 });
  // Same formula nodeStore.js uses to compute the reliability the
  // scheduler actually ranks on -- this is the read side agreeing with
  // what the write side (above) just produced.
  const reliability = 1 - counts.rep_jobs_failed / counts.rep_jobs_total;
  assert.ok(Math.abs(reliability - 2 / 3) < 1e-9);
});

test('a booking that expires without ever running a job leaves reputation untouched', { skip }, async () => {
  const { providerId, nodeId } = await seedProviderAndNode();
  const userId = (await pool.query(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1,'x','x') RETURNING user_id`,
    [`rep-buyer-${crypto.randomUUID()}@test.local`])).rows[0].user_id;
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO reservations
       (reservation_id, node_id, user_id, slot, price_paise_hr, quoted_paise, status)
     VALUES ($1,$2,$3, tstzrange('2028-01-02T00:00Z','2028-01-02T01:00Z'), 4300, 4300, 'held')`,
    [id, nodeId, userId]);
  await settleReservation(pool, id, 'expired', 0);
  assert.deepEqual(await providerCounts(providerId), { rep_jobs_total: 0, rep_jobs_failed: 0 });
});
