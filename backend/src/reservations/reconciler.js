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

// --- the reservation-status-query reconciliation --------------------------
//
// A DIFFERENT gap than the one above, and the last one docs/reservation-
// protocol.md's failure matrix named as unsolved: a reservation only ends up
// 'expired' WITH a receipt_sig on file when the platform got as far as
// receiving a signed receipt from the node, then lost the RESERVE_COMMIT
// acknowledgment (network drop, timeout) and marked it 'expired' out of an
// abundance of caution -- WITHOUT knowing whether the node actually applied
// the commit before the ack was lost. This queries the node directly to find
// out, and fixes the one case that matters: the node believing it is still
// CONFIRMED for a slot the platform has already given up on and never
// charged for.
//
// Deliberately does NOT try to resurrect the platform's own reservation back
// to 'confirmed' -- that would reopen "charged but not reserved" risk from
// the other direction (see machine.js's illegal expired->confirmed
// transition). Instead it tells the node to release, so both sides agree the
// slot is free again and it becomes bookable -- the user's inconvenience
// (told it failed when it might have run) is real but does not involve
// money, since nothing was ever captured for an 'expired' reservation.
const MISMATCH_BATCH_SIZE = 20;

export async function reconcileExpiredMismatches(pool, hub) {
  const { rows } = await pool.query(
    `SELECT reservation_id, node_id FROM reservations
      WHERE status = 'expired' AND receipt_sig IS NOT NULL AND reconciled_at IS NULL
      LIMIT $1`,
    [MISMATCH_BATCH_SIZE],
  );

  let checked = 0;
  let mismatchesReleased = 0;

  for (const { reservation_id, node_id } of rows) {
    // An offline node cannot be asked anything right now. Leave
    // reconciled_at null so the next sweep tries again once it reconnects,
    // rather than giving up on a node that is simply asleep.
    if (!hub.isOnline(node_id)) continue;

    try {
      const status = await hub.queryReservationStatus(node_id, reservation_id);
      if (status === 'confirmed') {
        await hub.releaseReservation(node_id, reservation_id);
        mismatchesReleased += 1;
        console.warn(
          `reconciliation: node ${node_id} was still CONFIRMED for expired ` +
          `reservation ${reservation_id} -- released it so the slot is bookable again`);
      }
      await pool.query('UPDATE reservations SET reconciled_at = now() WHERE reservation_id = $1',
        [reservation_id]);
      checked += 1;
    } catch (e) {
      // Timed out or went offline mid-query -- leave reconciled_at null,
      // try again next sweep. Not logged as an error: a node dropping mid
      // -query is an ordinary, expected event, not a bug.
      void e;
    }
  }

  return { checked, mismatchesReleased };
}
