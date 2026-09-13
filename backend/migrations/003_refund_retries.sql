-- Durable retry queue for compensating refunds.
--
-- Before this migration, a failed gateway.refund() call (network blip,
-- Razorpay outage, rate limit) was handled with a single console.error
-- marked CRITICAL and nothing else -- a human had to notice the log line
-- and refund the user by hand. That is not durable: restart the process,
-- lose the log, lose the only record that money is owed. This table is the
-- record that survives a restart, and the thing a periodic sweep (see
-- reservations/refunds.js) works off instead of a fallible human reading logs.

BEGIN;

CREATE TABLE refund_retries (
    retry_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id     UUID NOT NULL REFERENCES payments(payment_id),
    reservation_id UUID REFERENCES reservations(reservation_id),
    gateway_ref    TEXT   NOT NULL, -- the Razorpay payment_id to refund
    amount_paise   BIGINT NOT NULL CHECK (amount_paise > 0),

    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- 'exhausted' means attempts hit the ceiling with no success -- this is
    -- the row a human actually needs to look at; everything before that is
    -- expected to resolve itself without anyone noticing.
    status TEXT NOT NULL DEFAULT 'pending'
           CHECK (status IN ('pending', 'succeeded', 'exhausted')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One outstanding retry per payment. A payment that failed to refund
    -- twice for two different reasons is still one debt, not two.
    UNIQUE (payment_id)
);
CREATE INDEX ON refund_retries (status, next_attempt_at) WHERE status = 'pending';

COMMIT;
