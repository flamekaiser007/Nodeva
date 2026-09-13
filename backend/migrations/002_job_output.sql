-- Job output storage.
--
-- Caught late: onJobResult receives stdout/stderr from the worker's
-- JOB_RESULT message but 001_init.sql's jobs table has nowhere to put them,
-- so they were being silently discarded before the frontend even existed to
-- need them. Small text output goes inline here; input_ref/result_ref stay
-- reserved for large payloads (S3 now, IPFS later per the master design) --
-- this is not a replacement for that, just the missing piece for the common
-- case of a job that prints a few lines and exits.

BEGIN;

ALTER TABLE jobs
    ADD COLUMN stdout TEXT,
    ADD COLUMN stderr TEXT;

COMMIT;
