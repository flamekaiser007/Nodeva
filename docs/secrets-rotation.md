# Rotating secrets

Two shared secrets exist in this project: `JWT_SECRET` (signs every user
session) and `ADMIN_TOKEN` (gates `/metrics` and `/admin/ops-summary`).
Both support the same two-deploy rotation pattern, so a routine credential
rotation is not an instant mass-logout / broken-Prometheus-scrape event.

## Why this needed building

Before this existed, each was a single env var with no successor: rotating
either one meant every existing JWT became invalid the instant the new
process started (users logged out, no warning), and every Prometheus
scraper / dashboard using the old `ADMIN_TOKEN` started getting 404s until
someone updated it everywhere at once. That is a real operational risk for
something that should be routine hygiene (credentials should rotate
periodically, and immediately after any suspected leak) -- if rotating a
secret is scary and disruptive, it will happen less often than it should.

## How it works

- **Signing** always uses the single CURRENT secret (`JWT_SECRET` /
  `ADMIN_TOKEN`). A token or header value issued after a rotation always
  carries the new secret.
- **Verification** accepts the current secret PLUS whatever is listed in
  `JWT_SECRET_PREVIOUS` / `ADMIN_TOKEN_PREVIOUS` (comma-separated, for the
  rare case of overlapping rotations). See `auth/jwt.js`'s
  `requireJwtVerificationSecrets` and `auth/adminToken.js`'s
  `expectedTokens`.

This is deliberately asymmetric: if verification also preferred emitting
old secrets, rotation would never actually finish. New tokens always move
forward; only verification looks backward, and only for as long as you
keep the `_PREVIOUS` variable set.

## Runbook: rotating JWT_SECRET

1. Generate a new secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. **Deploy 1**: set `JWT_SECRET` to the new value, `JWT_SECRET_PREVIOUS`
   to the OLD value. Every existing session (issued under the old secret)
   keeps working; every new login uses the new secret.
3. Wait out the longest-lived token's expiry (currently a fixed 24h, see
   `auth/jwt.js`'s `EXPIRES_IN`) -- by then nothing still depends on the
   old secret.
4. **Deploy 2**: remove `JWT_SECRET_PREVIOUS` entirely. The old secret now
   genuinely stops working (see `scripts/secrets_rotation_demo.sh`'s third
   phase, which proves exactly this).

## Runbook: rotating ADMIN_TOKEN

Same two-deploy shape:

1. **Deploy 1**: set `ADMIN_TOKEN` to the new value, `ADMIN_TOKEN_PREVIOUS`
   to the old value. Update `alerting/prometheus.yml`'s `bearer_token` (and
   any dashboard/tooling holding the old value) to the new one at your own
   pace during this window -- both work simultaneously.
2. Once everything holding the old token has been updated, **Deploy 2**:
   remove `ADMIN_TOKEN_PREVIOUS`.

Unlike JWT rotation, there is no fixed expiry forcing deploy 2 -- it is
safe to leave `ADMIN_TOKEN_PREVIOUS` set indefinitely if convenient, though
a retired credential that still works is itself a small, avoidable risk
worth cleaning up once you've confirmed nothing still needs it.

## Verifying a rotation actually works

`scripts/secrets_rotation_demo.sh` runs all three phases (pre-rotation,
mid-rotation, post-rotation) against three real, separate backend
processes and a real JWT/admin-token issued by the first one -- not a
mocked timeline. Run it after changing anything in `auth/jwt.js` or
`auth/adminToken.js` before trusting that rotation still behaves as
described here.

## HONEST LIMIT

Nothing here automates the rotation itself -- these are manual runbooks,
not a scheduled job or a secrets-manager integration (Vault, AWS Secrets
Manager, etc.) that rotates and redeploys on its own. There is also no
detection for "a secret may have leaked" -- rotation here is something a
human decides to do, on their own schedule, for their own reasons.
