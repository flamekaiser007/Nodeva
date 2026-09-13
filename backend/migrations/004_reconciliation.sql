-- Tracks which 'expired' reservations have already been checked against
-- their node's own ground truth (see reservations/reconciler.js's
-- reconcileExpiredMismatches). Without this, the same sweep would re-query
-- every online node about every expired reservation with a receipt on file,
-- forever, even after confirming there is nothing wrong with most of them.

BEGIN;

ALTER TABLE reservations ADD COLUMN reconciled_at TIMESTAMPTZ;

COMMIT;
