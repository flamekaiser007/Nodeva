-- Adds 'disputed' to reservations.status's CHECK constraint.
--
-- Caught by an integration test, not by inspection: machine.js's EDGES/
-- SETTLEMENT maps were updated to include DISPUTED (duplicate-execution
-- verification, jobs/verification.js) but the actual Postgres CHECK
-- constraint on this column -- an independent definition of the same "which
-- values are legal" rule -- was not. The two are two separate sources of
-- truth for the same thing and had drifted; a real settleReservation call
-- failed with "violates check constraint reservations_status_check" the
-- first time a dispute was ever exercised end to end.

BEGIN;

ALTER TABLE reservations DROP CONSTRAINT reservations_status_check;
ALTER TABLE reservations ADD CONSTRAINT reservations_status_check
    CHECK (status IN ('pending','held','confirmed','running',
                       'completed','cancelled','expired',
                       'failed_provider','failed_user','disputed'));

COMMIT;
