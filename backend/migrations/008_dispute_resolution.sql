-- Third-node fault attribution for a duplicate-execution verification group
-- that came back MISMATCHED (jobs/verification.js, machine.js's DISPUTED
-- state). Two disagreeing nodes prove at least one of them is wrong but
-- never which -- this table records the outcome of asking a THIRD,
-- independently-booked node to run the identical workload and
-- majority-voting the result. It is purely a reputation record: the money
-- side of a dispute was already settled honestly (refund_full, both sides)
-- at dispute time and is never revisited here.
CREATE TABLE dispute_resolutions (
    resolution_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- One tiebreak per disputed group, enforced by the database rather than
    -- trusted to application logic alone.
    verification_group_id     UUID NOT NULL UNIQUE,
    tiebreaker_reservation_id UUID NOT NULL REFERENCES reservations(reservation_id),
    tiebreaker_job_id         UUID NOT NULL REFERENCES jobs(job_id),
    verdict                   TEXT NOT NULL CHECK (verdict IN ('attributed', 'inconclusive')),
    -- Populated only when verdict = 'attributed': the reservation whose node
    -- matched the tiebreaker (rep_jobs_failed untouched) and the one that
    -- did not (rep_jobs_failed incremented). Both NULL when verdict =
    -- 'inconclusive' -- a three-way disagreement still attributes nothing.
    vindicated_reservation_id UUID REFERENCES reservations(reservation_id),
    at_fault_reservation_id   UUID REFERENCES reservations(reservation_id),
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (verdict = 'attributed'
            AND vindicated_reservation_id IS NOT NULL
            AND at_fault_reservation_id IS NOT NULL)
        OR
        (verdict = 'inconclusive'
            AND vindicated_reservation_id IS NULL
            AND at_fault_reservation_id IS NULL)
    )
);
CREATE INDEX ON dispute_resolutions (verification_group_id);
