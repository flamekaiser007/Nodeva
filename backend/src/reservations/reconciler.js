// Reconciles the platform's view of reservation state against the node's.
//
// The node is authoritative over its own slot (see docs/reservation-protocol.md),
// and its hold has a TTL: if we never confirm in time, the node frees the
// slot locally on its own. Nothing was doing the equivalent cleanup on the
// platform side -- a reservation left in 'held' or 'pending' past its
// hold_expires_at just sat there forever, and our GiST exclusion constraint
// then treated that stale row as still occupying the slot. A user trying to
// book that exact window would be rejected with a conflict even though the
// node itself would happily grant a fresh request for it (confirmed by hand:
// the node signs and returns a brand-new receipt for the "conflicting"
// window, which the platform then never uses).
//
// This is a plain expiry sweep, not a query to the node -- the node doesn't
// need to be asked, because it already told us exactly when it would give up
// on the hold (hold_expires_at), and that promise is unconditional: past that
// instant, the slot is free on the node's side regardless of whether the
// platform ever gets around to noticing.

// Small grace window so a request that is genuinely mid-flight (the platform
// is right at the edge of the node's TTL) is not expired by an over-eager
// sweep racing the confirm that is about to land.
const GRACE_MS = 500;

export async function expireStaleHolds(pool, { nodeId } = {}) {
  const { rows } = await pool.query(
    `UPDATE reservations
        SET status = 'expired', updated_at = now()
      WHERE status IN ('pending', 'held')
        AND hold_expires_at IS NOT NULL
        AND hold_expires_at < now() - ($2::bigint * interval '1 millisecond')
        AND ($1::uuid IS NULL OR node_id = $1)
      RETURNING reservation_id, node_id`,
    [nodeId ?? null, GRACE_MS],
  );
  return rows;
}
