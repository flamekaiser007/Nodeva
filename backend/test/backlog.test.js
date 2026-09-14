// observability/backlog.js against a real Postgres: proves the two backlog
// gauges (nodeva_refund_retries_pending, nodeva_disputes_awaiting_tiebreak)
// actually reflect real rows, not just that the query text parses.
//
// Assertions are DELTA-based (before vs. after this test's own action), not
// absolute counts -- this suite runs against a shared, long-lived dev
// Postgres that already carries rows from every earlier test run in this
// session (refunds.test.js and dispute-resolution.test.js both create real
// refund_retries/disputed rows and never delete them). An absolute-count
// assertion here would be asserting about the whole database's history, not
// about what THIS test did -- caught live on the first version of this
// file, which asserted `=== 1` and failed with `8 !== 1` the moment it ran
// after other suites had already left rows behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPool } from '../src/db/pool.js';
import { issueRefund, processRefundRetries } from '../src/payments/refunds.js';
import { refreshBacklogGauges } from '../src/observability/backlog.js';
import { registry, _resetMetricsForTests } from '../src/observability/metrics.js';

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
test.beforeEach(() => { if (dbAvailable) _resetMetricsForTests(); });

class ScriptedGateway {
  constructor() { this.failuresRemaining = 0; }
  get isConfigured() { return true; }
  async refund() {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('simulated gateway failure');
    }
    return { id: `rfnd_${crypto.randomUUID()}`, status: 'processed' };
  }
}

async function seedPayment() {
  const userId = (await pool.query(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1,'x','x') RETURNING user_id`,
    [`backlog-${crypto.randomUUID()}@test.local`])).rows[0].user_id;
  const paymentId = (await pool.query(
    `INSERT INTO payments (user_id, gateway, gateway_ref, amount_paise, status)
     VALUES ($1,'razorpay',$2,4300,'captured') RETURNING payment_id`,
    [userId, `pay_${crypto.randomUUID()}`])).rows[0].payment_id;
  return paymentId;
}

async function gaugeValue(name, labels = '') {
  await refreshBacklogGauges(pool);
  const text = await registry.metrics();
  const re = new RegExp(`${name}${labels} (-?[\\d.]+)`);
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}

test('a pending refund retry increments the pending gauge by exactly one', { skip }, async () => {
  const before = await gaugeValue('nodeva_refund_retries_pending', '\\{status="pending"\\}');
  const paymentId = await seedPayment();
  const gateway = new ScriptedGateway();
  gateway.failuresRemaining = 999;
  await issueRefund(pool, gateway, {
    paymentId, reservationId: null, gatewayRef: 'pay_x', amountPaise: 4300,
  });

  const after = await gaugeValue('nodeva_refund_retries_pending', '\\{status="pending"\\}');
  assert.equal(after - before, 1);
});

test('a refund retry that hits the ceiling moves from pending to exhausted, net zero on pending', { skip }, async () => {
  const beforePending = await gaugeValue('nodeva_refund_retries_pending', '\\{status="pending"\\}');
  const beforeExhausted = await gaugeValue('nodeva_refund_retries_pending', '\\{status="exhausted"\\}');

  const paymentId = await seedPayment();
  const gateway = new ScriptedGateway();
  gateway.failuresRemaining = 999;
  await issueRefund(pool, gateway, {
    paymentId, reservationId: null, gatewayRef: 'pay_x', amountPaise: 4300,
  });
  // Drive it past MAX_ATTEMPTS (10) -- backoff scheduling means most of
  // these calls are no-ops (next_attempt_at is in the future), so force it
  // by bumping next_attempt_at to now before each retry pass.
  for (let i = 0; i < 12; i++) {
    await pool.query("UPDATE refund_retries SET next_attempt_at = now() WHERE payment_id = $1", [paymentId]);
    await processRefundRetries(pool, gateway);
  }

  const afterPending = await gaugeValue('nodeva_refund_retries_pending', '\\{status="pending"\\}');
  const afterExhausted = await gaugeValue('nodeva_refund_retries_pending', '\\{status="exhausted"\\}');
  assert.equal(afterPending - beforePending, 0, 'the one retry this test created must have LEFT pending');
  assert.equal(afterExhausted - beforeExhausted, 1, 'and landed in exhausted, exactly once');
});

test('all three refund-retry statuses are always present in the scrape, even at zero', { skip }, async () => {
  // Not an absolute-zero check (the shared dev DB may genuinely have rows
  // in every status by now) -- the actual property under test is that the
  // metric series for a status EXISTS at all, rather than only appearing
  // once a row with that status has ever been seen. A missing series reads
  // to Prometheus as "no data", which would make an alert comparing
  // against a threshold silently stop evaluating instead of correctly
  // reading 0.
  await refreshBacklogGauges(pool);
  const text = await registry.metrics();
  for (const status of ['pending', 'succeeded', 'exhausted']) {
    assert.match(text, new RegExp(`nodeva_refund_retries_pending\\{status="${status}"\\} \\d`));
  }
});

async function seedDisputedGroupAwaitingTiebreak() {
  const userId = (await pool.query(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1,'x','x') RETURNING user_id`,
    [`backlog-buyer-${crypto.randomUUID()}@test.local`])).rows[0].user_id;
  const providerUserId = (await pool.query(
    `INSERT INTO users (email, password_hash, display_name) VALUES ($1,'x','x') RETURNING user_id`,
    [`backlog-provider-${crypto.randomUUID()}@test.local`])).rows[0].user_id;
  const providerId = (await pool.query(
    `INSERT INTO providers (user_id) VALUES ($1) RETURNING provider_id`, [providerUserId])).rows[0].provider_id;
  const groupId = crypto.randomUUID();
  const reservationIds = [];
  const jobIds = [];
  for (let i = 0; i < 2; i++) {
    const nodeId = (await pool.query(
      `INSERT INTO compute_nodes (provider_id, public_key, gpu_model, gpu_vram_mb, cpu_cores, ram_mb, price_paise_hr)
       VALUES ($1,$2,'RTX 4090',24576,16,32768,4300) RETURNING node_id`,
      [providerId, crypto.randomBytes(32)])).rows[0].node_id;
    const reservationId = (await pool.query(
      `INSERT INTO reservations (node_id, user_id, slot, price_paise_hr, quoted_paise, status)
       VALUES ($1,$2,tstzrange(now(), now() + interval '1 hour'),4300,4300,'disputed') RETURNING reservation_id`,
      [nodeId, userId])).rows[0].reservation_id;
    const jobId = (await pool.query(
      `INSERT INTO jobs (reservation_id, image, command, status, verification_group_id)
       VALUES ($1,'alpine:3.20','{"echo","x"}','succeeded',$2) RETURNING job_id`,
      [reservationId, groupId])).rows[0].job_id;
    reservationIds.push(reservationId);
    jobIds.push(jobId);
  }
  return { groupId, reservationIds, jobIds };
}

test('a disputed group with no dispute_resolutions row counts each of its two reservations', { skip }, async () => {
  // Matches admin/ops-summary's own definition exactly (both query the same
  // reservations-JOIN-jobs-LEFT JOIN-dispute_resolutions shape, deliberately
  // kept identical so the two never drift) -- a verification group always
  // has exactly two original reservations, and neither query deduplicates
  // by group, so one unresolved dispute is a delta of 2, not 1.
  const before = await gaugeValue('nodeva_disputes_awaiting_tiebreak');
  await seedDisputedGroupAwaitingTiebreak();
  const after = await gaugeValue('nodeva_disputes_awaiting_tiebreak');
  assert.equal(after - before, 2);
});

test('resolving a dispute (a real dispute_resolutions row) removes it from the backlog again', { skip }, async () => {
  const before = await gaugeValue('nodeva_disputes_awaiting_tiebreak');
  // The tiebreaker reservation/job FKs just need to point at SOME real row
  // -- reusing one of the two disputed ones is fine here since this test
  // only cares whether the gauge counts a group as resolved, not whether
  // the tiebreak verdict itself is realistic (that's dispute-resolution.test.js's job).
  const { groupId, reservationIds, jobIds } = await seedDisputedGroupAwaitingTiebreak();
  const afterSeeding = await gaugeValue('nodeva_disputes_awaiting_tiebreak');
  assert.equal(afterSeeding - before, 2, 'sanity check: both of the group\'s reservations were actually counted');

  await pool.query(
    `INSERT INTO dispute_resolutions
       (verification_group_id, tiebreaker_reservation_id, tiebreaker_job_id, verdict,
        vindicated_reservation_id, at_fault_reservation_id)
     VALUES ($1, $2, $3, 'inconclusive', NULL, NULL)`,
    [groupId, reservationIds[0], jobIds[0]]);

  const afterResolving = await gaugeValue('nodeva_disputes_awaiting_tiebreak');
  assert.equal(afterResolving - before, 0, 'back to the pre-test baseline once resolved');
});
