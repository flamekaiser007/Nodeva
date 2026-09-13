// Runs against a real Postgres (same pattern as reconciler.test.js) --
// backoff timing and the upsert-on-conflict behavior are properties of real
// rows and real constraints, not something a fake pool would exercise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPool } from '../src/db/pool.js';
import { issueRefund, processRefundRetries } from '../src/payments/refunds.js';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://nodeva:nodeva_dev@localhost:5433/nodeva';

let pool;
let dbAvailable = false;
try {
  pool = createPool(DATABASE_URL, { connectionTimeoutMillis: 2000 });
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch { /* skipped below */ }

const skip = !dbAvailable && 'requires a reachable Postgres (see docker-compose.yml)';
test.after(() => pool?.end());

// A gateway whose refund() can be told to fail N times then succeed, so
// tests control exactly when a retry resolves without waiting on real time.
class ScriptedGateway {
  constructor() { this.failuresRemaining = 0; this.calls = []; }
  get isConfigured() { return true; }
  async refund(gatewayRef, amountPaise) {
    this.calls.push({ gatewayRef, amountPaise });
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('simulated gateway failure');
    }
    return { id: `rfnd_${crypto.randomUUID()}`, status: 'processed' };
  }
}

async function seedPayment(status = 'captured') {
  const userId = (await pool.query(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1,'x','x') RETURNING user_id`,
    [`refund-${crypto.randomUUID()}@test.local`])).rows[0].user_id;
  const paymentId = (await pool.query(
    `INSERT INTO payments (user_id, gateway, gateway_ref, amount_paise, status)
     VALUES ($1,'razorpay',$2,4300,$3) RETURNING payment_id`,
    [userId, `pay_${crypto.randomUUID()}`, status])).rows[0].payment_id;
  return { userId, paymentId };
}

async function retryRow(paymentId) {
  const { rows } = await pool.query('SELECT * FROM refund_retries WHERE payment_id=$1', [paymentId]);
  return rows[0];
}

async function paymentStatus(paymentId) {
  const { rows } = await pool.query('SELECT status FROM payments WHERE payment_id=$1', [paymentId]);
  return rows[0].status;
}

test('a refund that succeeds immediately marks the payment refunded and queues nothing', { skip }, async () => {
  const { paymentId } = await seedPayment();
  const gateway = new ScriptedGateway();
  const result = await issueRefund(pool, gateway, {
    paymentId, reservationId: null, gatewayRef: 'pay_x', amountPaise: 4300,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(await paymentStatus(paymentId), 'refunded');
  assert.equal(await retryRow(paymentId), undefined);
});

test('a refund that fails is queued for retry, not just logged', { skip }, async () => {
  const { paymentId } = await seedPayment();
  const gateway = new ScriptedGateway();
  gateway.failuresRemaining = 999;
  const result = await issueRefund(pool, gateway, {
    paymentId, reservationId: null, gatewayRef: 'pay_x', amountPaise: 4300,
  });
  assert.deepEqual(result, { ok: false, queued: true });
  assert.equal(await paymentStatus(paymentId), 'captured', 'must not be marked refunded on failure');

  const row = await retryRow(paymentId);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.ok(row.last_error.includes('simulated gateway failure'));
  assert.ok(row.next_attempt_at > new Date(), 'must be scheduled in the future, not immediately');
});

test('calling issueRefund twice for the same payment updates one row, not two', { skip }, async () => {
  const { paymentId } = await seedPayment();
  const gateway = new ScriptedGateway();
  gateway.failuresRemaining = 999;
  await issueRefund(pool, gateway, { paymentId, reservationId: null, gatewayRef: 'pay_x', amountPaise: 4300 });
  await issueRefund(pool, gateway, { paymentId, reservationId: null, gatewayRef: 'pay_x', amountPaise: 4300 });

  const { rows } = await pool.query('SELECT * FROM refund_retries WHERE payment_id=$1', [paymentId]);
  assert.equal(rows.length, 1, 'one outstanding debt per payment, not one row per failed attempt');
  assert.equal(rows[0].attempts, 2);
});

test('processRefundRetries does nothing when the gateway is not configured', { skip }, async () => {
  const result = await processRefundRetries(pool, { isConfigured: false });
  assert.deepEqual(result, { processed: 0 });
});

test('a due retry that now succeeds marks the payment refunded and the retry succeeded', { skip }, async () => {
  const { paymentId } = await seedPayment();
  const gateway = new ScriptedGateway();
  gateway.failuresRemaining = 1; // fails once via issueRefund, succeeds on the sweep's attempt
  await issueRefund(pool, gateway, { paymentId, reservationId: null, gatewayRef: 'pay_retry_1', amountPaise: 4300 });
  // Force the row due now rather than waiting out the real backoff delay.
  await pool.query("UPDATE refund_retries SET next_attempt_at = now() WHERE payment_id=$1", [paymentId]);

  const result = await processRefundRetries(pool, gateway);
  // NOT asserting an exact result.processed count: this sweep scans the
  // WHOLE table (by design -- a real deployment has many rows due at once),
  // and this test file shares one persistent dev Postgres across repeated
  // runs, so a leftover 'pending' row from an earlier invocation of this
  // same suite can legitimately also be due and counted. What actually
  // matters -- THIS payment's own outcome -- is asserted below regardless
  // of how many other rows the sweep happened to touch.
  assert.ok(result.processed >= 1);
  assert.equal(await paymentStatus(paymentId), 'refunded');
  const row = await retryRow(paymentId);
  assert.equal(row.status, 'succeeded');
});

test('a retry that fails again stays pending with incremented attempts and a later next_attempt_at', { skip }, async () => {
  const { paymentId } = await seedPayment();
  const gateway = new ScriptedGateway();
  gateway.failuresRemaining = 999;
  await issueRefund(pool, gateway, { paymentId, reservationId: null, gatewayRef: 'pay_retry_2', amountPaise: 4300 });
  await pool.query("UPDATE refund_retries SET next_attempt_at = now() WHERE payment_id=$1", [paymentId]);

  const before = await retryRow(paymentId);
  await processRefundRetries(pool, gateway);
  const after = await retryRow(paymentId);

  assert.equal(after.status, 'pending');
  assert.equal(after.attempts, before.attempts + 1);
  assert.ok(after.next_attempt_at > before.next_attempt_at, 'backoff must push the next attempt further out');
});

test('a retry that keeps failing past the attempt ceiling is marked exhausted, not retried forever', { skip }, async () => {
  const { paymentId } = await seedPayment();
  const gateway = new ScriptedGateway();
  gateway.failuresRemaining = 999;
  await issueRefund(pool, gateway, { paymentId, reservationId: null, gatewayRef: 'pay_retry_3', amountPaise: 4300 });

  // Drive it past MAX_ATTEMPTS (10) by forcing next_attempt_at into the past
  // before each sweep -- this is exercising the ceiling, not real time.
  for (let i = 0; i < 15; i++) {
    await pool.query("UPDATE refund_retries SET next_attempt_at = now() WHERE payment_id=$1", [paymentId]);
    await processRefundRetries(pool, gateway);
    const row = await retryRow(paymentId);
    if (row.status === 'exhausted') break;
  }

  const finalRow = await retryRow(paymentId);
  assert.equal(finalRow.status, 'exhausted');
  assert.equal(await paymentStatus(paymentId), 'captured',
    'exhausting retries must not silently mark the payment refunded');
});

test('a not-yet-due retry is left alone by the sweep', { skip }, async () => {
  const { paymentId } = await seedPayment();
  const gateway = new ScriptedGateway();
  gateway.failuresRemaining = 999;
  await issueRefund(pool, gateway, { paymentId, reservationId: null, gatewayRef: 'pay_x', amountPaise: 4300 });
  // Real backoff already scheduled this in the future -- do NOT force it due.

  const beforeCalls = gateway.calls.length;
  await processRefundRetries(pool, gateway);
  // Scoped to THIS gateway instance (fresh per test) and THIS payment's own
  // row, rather than the sweep's global processed count -- see the previous
  // test's comment on why that count can't be pinned to an exact value in a
  // shared, repeatedly-run database.
  assert.equal(gateway.calls.length, beforeCalls, 'must not attempt a refund before its scheduled time');
  assert.equal((await retryRow(paymentId)).status, 'pending');
});
