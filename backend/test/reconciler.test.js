// Runs against a REAL Postgres (the same one scripts/e2e_demo.sh and manual
// testing use) rather than a fake -- the bug this fixes is a property of the
// GiST exclusion constraint interacting with real rows, which nothing short
// of a real database actually exercises.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/db/pool.js';
import { expireStaleHolds } from '../src/reservations/reconciler.js';

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
} catch {
  // Skipped below rather than failing the whole suite -- matches
  // test_executor.py's pattern of skipping when its real dependency
  // (docker) is unavailable, rather than pretending to pass.
}

const skip = !dbAvailable && 'requires a reachable Postgres (see docker-compose.yml)';

// Minimal fixtures, created fresh per test and cleaned up after -- this file
// does not reset the whole schema, so it must not assume an empty database.
async function seed(overrides = {}) {
  const client = await pool.connect();
  const userId = (await client.query(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1,'x','x') RETURNING user_id`,
    [`reconciler-${crypto.randomUUID()}@test.local`])).rows[0].user_id;
  const providerUserId = (await client.query(
    `INSERT INTO users (email, password_hash, display_name)
     VALUES ($1,'x','x') RETURNING user_id`,
    [`reconciler-provider-${crypto.randomUUID()}@test.local`])).rows[0].user_id;
  const providerId = (await client.query(
    'INSERT INTO providers (user_id) VALUES ($1) RETURNING provider_id', [providerUserId]
  )).rows[0].provider_id;
  const nodeId = (await client.query(
    `INSERT INTO compute_nodes (provider_id, public_key, gpu_model, gpu_vram_mb, cpu_cores, ram_mb, price_paise_hr, status)
     VALUES ($1,$2,'Test GPU',24576,16,32768,4300,'online') RETURNING node_id`,
    [providerId, Buffer.from(crypto.getRandomValues(new Uint8Array(32)))]
  )).rows[0].node_id;
  client.release();
  return { userId, nodeId, ...overrides };
}

async function insertReservation(pool, { userId, nodeId, status, holdExpiresAt, start, end }) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO reservations
       (reservation_id, node_id, user_id, slot, price_paise_hr, quoted_paise, status, hold_expires_at)
     VALUES ($1,$2,$3, tstzrange($4,$5), 4300, 4300, $6, $7)`,
    [id, nodeId, userId, start, end, status, holdExpiresAt]);
  return id;
}

async function statusOf(pool, id) {
  const { rows } = await pool.query('SELECT status FROM reservations WHERE reservation_id=$1', [id]);
  return rows[0]?.status;
}

test('a held reservation past its hold_expires_at is expired', { skip }, async () => {
  const { userId, nodeId } = await seed();
  const id = await insertReservation(pool, {
    userId, nodeId, status: 'held',
    holdExpiresAt: new Date(Date.now() - 10_000), // 10s in the past
    start: new Date('2027-01-01T10:00:00Z'), end: new Date('2027-01-01T11:00:00Z'),
  });
  await expireStaleHolds(pool);
  assert.equal(await statusOf(pool, id), 'expired');
});

test('a held reservation still within its hold window is left alone', { skip }, async () => {
  const { userId, nodeId } = await seed();
  const id = await insertReservation(pool, {
    userId, nodeId, status: 'held',
    holdExpiresAt: new Date(Date.now() + 60_000), // 60s in the future
    start: new Date('2027-01-02T10:00:00Z'), end: new Date('2027-01-02T11:00:00Z'),
  });
  await expireStaleHolds(pool);
  assert.equal(await statusOf(pool, id), 'held');
});

test('a confirmed reservation (no TTL) is never touched by the sweep', { skip }, async () => {
  const { userId, nodeId } = await seed();
  const id = await insertReservation(pool, {
    userId, nodeId, status: 'confirmed',
    holdExpiresAt: null, // commit() clears this on the node; mirrored here
    start: new Date('2027-01-03T10:00:00Z'), end: new Date('2027-01-03T11:00:00Z'),
  });
  await expireStaleHolds(pool);
  assert.equal(await statusOf(pool, id), 'confirmed',
    'a confirmed booking must never be swept regardless of any stale timestamp');
});

test('scoping to one node does not touch a stale hold on a different node', { skip }, async () => {
  const a = await seed();
  const b = await seed();
  const staleOnA = await insertReservation(pool, {
    userId: a.userId, nodeId: a.nodeId, status: 'held',
    holdExpiresAt: new Date(Date.now() - 10_000),
    start: new Date('2027-01-04T10:00:00Z'), end: new Date('2027-01-04T11:00:00Z'),
  });
  const staleOnB = await insertReservation(pool, {
    userId: b.userId, nodeId: b.nodeId, status: 'held',
    holdExpiresAt: new Date(Date.now() - 10_000),
    start: new Date('2027-01-04T10:00:00Z'), end: new Date('2027-01-04T11:00:00Z'),
  });
  await expireStaleHolds(pool, { nodeId: a.nodeId });
  assert.equal(await statusOf(pool, staleOnA), 'expired');
  assert.equal(await statusOf(pool, staleOnB), 'held', 'sweep scoped to node A must not touch node B');
});

// The actual bug this fixes, reproduced at the database level: an abandoned
// hold must not permanently block the slot it occupied. Confirmed originally
// by hand against a live worker (the node happily re-signed the "conflicting"
// window; only the platform's own stale row rejected it) -- this pins the
// same fix at the level the exclusion constraint actually operates on.
test('expiring a stale hold frees the slot for a real overlapping insert', { skip }, async () => {
  const { userId, nodeId } = await seed();
  const start = new Date('2027-01-05T10:00:00Z');
  const end = new Date('2027-01-05T11:00:00Z');
  await insertReservation(pool, {
    userId, nodeId, status: 'held',
    holdExpiresAt: new Date(Date.now() - 10_000),
    start, end,
  });

  // Before reconciliation: exactly the bug. The old hold still blocks it.
  await assert.rejects(
    insertReservation(pool, { userId, nodeId, status: 'held', holdExpiresAt: new Date(Date.now() + 60_000), start, end }),
    /exclusion constraint/,
  );

  await expireStaleHolds(pool, { nodeId });

  // After reconciliation: the identical booking now succeeds.
  const secondId = await insertReservation(pool, {
    userId, nodeId, status: 'held', holdExpiresAt: new Date(Date.now() + 60_000), start, end,
  });
  assert.equal(await statusOf(pool, secondId), 'held');
});
