-- Duplicate-execution result verification (docs/security-model.md's
-- "Direction 2": protecting the user from a malicious or lying provider).
--
-- Two jobs sharing a verification_group_id are the SAME workload submitted
-- to two independently reserved nodes. Once both reach a terminal status,
-- their result_hash values are compared -- a match settles both normally,
-- a mismatch disputes both reservations (full refund; see machine.js's
-- DISPUTED state for why fault cannot be attributed from two samples alone).

BEGIN;

ALTER TABLE jobs
    ADD COLUMN verification_group_id UUID,
    ADD COLUMN result_hash TEXT;

CREATE INDEX ON jobs (verification_group_id) WHERE verification_group_id IS NOT NULL;

COMMIT;
