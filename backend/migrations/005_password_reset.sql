-- Password reset tokens.
--
-- The token itself is never stored -- only its SHA-256 hash, the same
-- principle as password_hash: if this table leaks, the tokens in it must
-- not be directly usable to reset anyone's password, exactly as a leaked
-- users.password_hash table must not hand over anyone's actual password.

BEGIN;

CREATE TABLE password_reset_tokens (
    token_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Looking up "does this user have a still-usable token" and cleanup sweeps
-- both filter on user_id and used_at/expires_at together.
CREATE INDEX ON password_reset_tokens (user_id, used_at, expires_at);

COMMIT;
