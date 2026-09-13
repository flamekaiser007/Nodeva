-- NODEVA — centralized schema.
--
-- SCOPE BOUNDARY: this database is authoritative for identity, money, and
-- accepted reservations. It is NOT authoritative for what hardware exists or
-- what is free right now — provider nodes own that. Tables below that merely
-- cache node-reported state are marked ADVISORY and must never be used to
-- promise a slot to a user without a signed receipt from the node itself.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- overlap exclusion on reservations

-- ---------------------------------------------------------------- identity --

CREATE TABLE users (
    user_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email          CITEXT      NOT NULL UNIQUE,
    password_hash  TEXT        NOT NULL,
    display_name   TEXT        NOT NULL,
    account_status TEXT        NOT NULL DEFAULT 'active'
                   CHECK (account_status IN ('active','suspended','closed')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE providers (
    provider_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE RESTRICT,
    payout_email TEXT,
    -- Reputation is derived from job outcomes; cached here for query speed.
    -- Recomputed by a job, never written ad hoc.
    rep_score       NUMERIC(3,2) NOT NULL DEFAULT 0,
    rep_jobs_total  INTEGER      NOT NULL DEFAULT 0,
    rep_jobs_failed INTEGER      NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------- compute inventory --

-- ADVISORY. A row here means "a node told us it has this hardware and intends
-- to offer it". It is a search index, not a source of truth. Allocation
-- decisions require a live signed reservation receipt from the node.
CREATE TABLE compute_nodes (
    node_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id   UUID NOT NULL REFERENCES providers(provider_id) ON DELETE CASCADE,

    -- Ed25519 public key. Every advertisement and reservation receipt this node
    -- emits is verified against it. Registered once at node enrollment.
    public_key    BYTEA NOT NULL UNIQUE,

    gpu_model     TEXT    NOT NULL,
    gpu_vram_mb   INTEGER NOT NULL CHECK (gpu_vram_mb > 0),
    cpu_cores     INTEGER NOT NULL CHECK (cpu_cores > 0),
    ram_mb        INTEGER NOT NULL CHECK (ram_mb > 0),
    cuda_version  TEXT,

    -- Provider's asking price, in paise per hour. Integer money only.
    price_paise_hr BIGINT NOT NULL CHECK (price_paise_hr > 0),

    -- Benchmarked, not self-reported. NULL until the node passes attestation.
    perf_score    NUMERIC(5,2),

    status        TEXT NOT NULL DEFAULT 'enrolling'
                  CHECK (status IN ('enrolling','online','draining','offline')),
    last_seen_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON compute_nodes (status, gpu_vram_mb, price_paise_hr);
CREATE INDEX ON compute_nodes (provider_id);

-- ADVISORY. Node-declared offer windows, mirrored so search can prefilter.
CREATE TABLE node_availability (
    availability_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id         UUID NOT NULL REFERENCES compute_nodes(node_id) ON DELETE CASCADE,
    window_start    TIMESTAMPTZ NOT NULL,
    window_end      TIMESTAMPTZ NOT NULL,
    CHECK (window_end > window_start)
);
CREATE INDEX ON node_availability (node_id, window_start, window_end);

COMMIT;

BEGIN;

-- ------------------------------------------------------------ reservations --

-- AUTHORITATIVE for "did we accept and bill this booking", but the node's
-- signed receipt is what proves the slot was actually locked. Both must agree;
-- reconcile_reservations() flags any that drift.
--
-- Lifecycle (see backend/src/reservations/machine.js for the enforced edges):
--   pending -> held -> confirmed -> running -> completed
--                 \        \           \-> failed_provider -> (refund)
--                  \        \-> cancelled                  -> failed_user
--                   \-> expired  (node lock TTL elapsed before payment)
CREATE TABLE reservations (
    reservation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_id        UUID NOT NULL REFERENCES compute_nodes(node_id) ON DELETE RESTRICT,
    user_id        UUID NOT NULL REFERENCES users(user_id)         ON DELETE RESTRICT,

    slot           TSTZRANGE NOT NULL,

    -- Price agreed at booking time. Frozen here so a node re-pricing mid-slot
    -- cannot change what the user owes.
    price_paise_hr BIGINT NOT NULL CHECK (price_paise_hr > 0),
    quoted_paise   BIGINT NOT NULL CHECK (quoted_paise > 0),

    status TEXT NOT NULL DEFAULT 'pending'
           CHECK (status IN ('pending','held','confirmed','running',
                             'completed','cancelled','expired',
                             'failed_provider','failed_user')),

    -- The node's Ed25519 signature over the canonical receipt body. Absent
    -- until the node confirms the lock; presence is the precondition for
    -- capturing money.
    receipt_sig    BYTEA,
    receipt_body   JSONB,

    -- Provider-side lock expiry. If we do not COMMIT before this, the node is
    -- entitled to release the slot and we must not charge the user.
    hold_expires_at TIMESTAMPTZ,

    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Defense in depth against double-booking in OUR records. The node enforces
    -- the real lock; this catches bugs on our side before they reach a user.
    EXCLUDE USING gist (
        node_id WITH =,
        slot    WITH &&
    ) WHERE (status IN ('held','confirmed','running','completed'))
);
CREATE INDEX ON reservations (user_id, created_at DESC);
CREATE INDEX ON reservations (status, hold_expires_at)
    WHERE status IN ('pending','held');

-- -------------------------------------------------------------------- jobs --

CREATE TABLE jobs (
    job_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reservation_id UUID NOT NULL REFERENCES reservations(reservation_id) ON DELETE RESTRICT,

    image          TEXT NOT NULL,
    command        TEXT[] NOT NULL DEFAULT '{}',
    -- Opaque to us. Points at user-supplied inputs (S3 now, IPFS CID later).
    input_ref      TEXT,
    result_ref     TEXT,

    status TEXT NOT NULL DEFAULT 'queued'
           CHECK (status IN ('queued','starting','running','succeeded',
                             'failed_user','failed_provider','timed_out','cancelled')),
    exit_code      INTEGER,
    -- Metered separately from the reservation window: a user who books an hour
    -- and runs for 10 minutes still occupied the slot, but failure billing
    -- depends on compute actually consumed.
    compute_seconds INTEGER NOT NULL DEFAULT 0,

    started_at     TIMESTAMPTZ,
    completed_at   TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON jobs (reservation_id);
CREATE INDEX ON jobs (status);

-- ------------------------------------------------------------------- money --

-- Double-entry. Every rupee is in exactly one account at all times, and every
-- movement writes balanced entries. Amounts are BIGINT paise — never floats,
-- never rupees.
CREATE TABLE ledger_accounts (
    account_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        TEXT NOT NULL
                CHECK (kind IN ('gateway_clearing','user_escrow',
                                'provider_balance','platform_revenue','refunds')),
    -- NULL for the singleton platform-owned accounts.
    owner_user_id     UUID REFERENCES users(user_id),
    owner_provider_id UUID REFERENCES providers(provider_id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (kind, owner_user_id, owner_provider_id)
);

CREATE TABLE ledger_transactions (
    txn_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind       TEXT NOT NULL
               CHECK (kind IN ('authorize','capture','settle','refund','payout')),
    reservation_id UUID REFERENCES reservations(reservation_id),
    -- Caller-supplied key making retries safe. The gateway will resend
    -- webhooks; settlement must never run twice.
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
    entry_id    BIGSERIAL PRIMARY KEY,
    txn_id      UUID   NOT NULL REFERENCES ledger_transactions(txn_id) ON DELETE RESTRICT,
    account_id  UUID   NOT NULL REFERENCES ledger_accounts(account_id) ON DELETE RESTRICT,
    -- Signed: debits negative, credits positive. Per txn these must sum to 0,
    -- asserted by assert_balanced() below.
    amount_paise BIGINT NOT NULL CHECK (amount_paise <> 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON ledger_entries (account_id);
CREATE INDEX ON ledger_entries (txn_id);

CREATE FUNCTION assert_balanced() RETURNS TRIGGER AS $$
DECLARE total BIGINT;
BEGIN
    SELECT COALESCE(SUM(amount_paise),0) INTO total
      FROM ledger_entries WHERE txn_id = NEW.txn_id;
    IF total <> 0 THEN
        RAISE EXCEPTION 'unbalanced ledger txn %: sums to % paise', NEW.txn_id, total;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- DEFERRABLE so a multi-entry transaction is checked once at COMMIT, not
-- after each individual INSERT.
CREATE CONSTRAINT TRIGGER ledger_balanced
    AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_balanced();

-- Gateway-facing record. Kept distinct from the ledger: this is what the PSP
-- thinks happened, the ledger is what we think happened, and they are
-- reconciled rather than assumed equal.
CREATE TABLE payments (
    payment_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES users(user_id),
    reservation_id UUID REFERENCES reservations(reservation_id),
    gateway        TEXT   NOT NULL,
    gateway_ref    TEXT   NOT NULL,
    amount_paise   BIGINT NOT NULL CHECK (amount_paise > 0),
    status TEXT NOT NULL
           CHECK (status IN ('created','authorized','captured','failed','refunded')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (gateway, gateway_ref)
);

COMMIT;
