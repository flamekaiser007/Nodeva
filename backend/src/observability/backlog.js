// Periodic refresh of the backlog gauges (observability/metrics.js) --
// snapshotted on an interval (see index.js) rather than updated at a call
// site, because "how many are stuck right now" is exactly the kind of
// state a running counter can't answer: it only ever goes up. Reuses the
// same queries admin/ops-summary (api/server.js) already runs, so the two
// never quietly drift into disagreeing about what the backlog is.
import { refundRetriesPendingGauge, disputesAwaitingTiebreakGauge } from './metrics.js';

// The refund_retries.status CHECK constraint (migrations/003) -- listed
// explicitly, not derived from whatever the query happens to return, so a
// status with zero current rows still reports 0 instead of the metric
// series disappearing from the scrape entirely (Prometheus treats "no
// series" as "no data", not "zero", which would make an alert that
// compares against a threshold silently stop firing instead of correctly
// evaluating to false).
const REFUND_RETRY_STATUSES = ['pending', 'succeeded', 'exhausted'];

export async function refreshBacklogGauges(pool) {
  const { rows } = await pool.query(
    'SELECT status, count(*)::int AS n FROM refund_retries GROUP BY status');
  const counts = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  for (const status of REFUND_RETRY_STATUSES) {
    refundRetriesPendingGauge.set({ status }, counts[status] ?? 0);
  }

  const { rows: disputeRows } = await pool.query(
    `SELECT count(*)::int AS n
       FROM reservations r
       JOIN jobs j ON j.reservation_id = r.reservation_id
       LEFT JOIN dispute_resolutions dr ON dr.verification_group_id = j.verification_group_id
      WHERE r.status = 'disputed' AND dr.resolution_id IS NULL`);
  disputesAwaitingTiebreakGauge.set(disputeRows[0].n);
}
