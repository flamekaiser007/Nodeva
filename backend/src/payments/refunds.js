import { logger } from '../observability/logger.js';
import { refundRetriesExhaustedTotal } from '../observability/metrics.js';

// Compensating refunds: the single place that issues a refund through the
// gateway and records what happens. Before this module existed, the same
// try/refund/catch-and-log shape was duplicated three times across
// server.js (settleReservation, the /confirm/verify endpoint, and the
// webhook handler) -- each a slightly different copy, which is exactly how
// one of them ends up missing a step the others have (see the prior commit,
// where the webhook's copy was missing the refund call entirely).

// Capped exponential backoff: 1m, 2m, 4m, ... up to 1h. A transient gateway
// blip resolves in the first couple of retries; anything still failing
// after that is not going to be fixed by trying faster.
const BASE_DELAY_MS = 60_000;
const MAX_DELAY_MS = 60 * 60_000;
const MAX_ATTEMPTS = 10;

function backoffMs(attempts) {
  return Math.min(BASE_DELAY_MS * 2 ** attempts, MAX_DELAY_MS);
}

/**
 * Attempts a refund now. On success, marks the payment 'refunded'. On
 * failure, queues (or updates) a durable retry row instead of only logging
 * -- the retry sweep below is what actually gives that row a second chance,
 * a log line by itself gives it none.
 */
export async function issueRefund(pool, gateway, { paymentId, reservationId, gatewayRef, amountPaise }) {
  try {
    await gateway.refund(gatewayRef, amountPaise);
    await pool.query("UPDATE payments SET status='refunded' WHERE payment_id=$1", [paymentId]);
    return { ok: true };
  } catch (e) {
    console.error(
      `refund failed for payment ${paymentId} (${amountPaise} paise) -- queuing for retry:`, e);
    await pool.query(
      `INSERT INTO refund_retries (payment_id, reservation_id, gateway_ref, amount_paise, attempts, last_error, next_attempt_at)
       VALUES ($1,$2,$3,$4,1,$5, now() + ($6::bigint * interval '1 millisecond'))
       ON CONFLICT (payment_id) DO UPDATE SET
         attempts = refund_retries.attempts + 1,
         last_error = EXCLUDED.last_error,
         next_attempt_at = now() + ($6::bigint * interval '1 millisecond'),
         status = 'pending'`,
      [paymentId, reservationId, gatewayRef, amountPaise, String(e.message ?? e), backoffMs(0)]);
    return { ok: false, queued: true };
  }
}

/**
 * Run periodically (see index.js). Picks up due retries and tries again;
 * a row that keeps failing past MAX_ATTEMPTS is marked 'exhausted' rather
 * than retried forever -- that is the row that actually needs a human,
 * everything before it is expected to resolve on its own.
 */
export async function processRefundRetries(pool, gateway) {
  if (!gateway?.isConfigured) return { processed: 0 };
  const { rows } = await pool.query(
    `SELECT * FROM refund_retries WHERE status='pending' AND next_attempt_at <= now()
     ORDER BY next_attempt_at LIMIT 20`);

  for (const row of rows) {
    try {
      await gateway.refund(row.gateway_ref, row.amount_paise);
      await pool.query('BEGIN');
      await pool.query("UPDATE payments SET status='refunded' WHERE payment_id=$1", [row.payment_id]);
      await pool.query("UPDATE refund_retries SET status='succeeded', updated_at=now() WHERE retry_id=$1",
        [row.retry_id]);
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK').catch(() => {});
      const attempts = row.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        logger.error('refund retries exhausted -- manual refund required', {
          payment_id: row.payment_id, amount_paise: row.amount_paise, attempts, error: e,
        });
        refundRetriesExhaustedTotal.inc();
        await pool.query(
          "UPDATE refund_retries SET status='exhausted', attempts=$2, last_error=$3, updated_at=now() WHERE retry_id=$1",
          [row.retry_id, attempts, String(e.message ?? e)]);
      } else {
        await pool.query(
          `UPDATE refund_retries SET attempts=$2, last_error=$3,
                  next_attempt_at = now() + ($4::bigint * interval '1 millisecond'), updated_at=now()
            WHERE retry_id=$1`,
          [row.retry_id, attempts, String(e.message ?? e), backoffMs(attempts)]);
      }
    }
  }
  return { processed: rows.length };
}
