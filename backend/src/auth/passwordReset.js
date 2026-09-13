// Password reset token generation and verification.
//
// The raw token goes in the email link; only its hash goes in the database
// -- same reasoning as bcrypt for passwords, applied to a bearer token
// instead: a leaked `password_reset_tokens` table (a DB backup, a stray
// log line, a misconfigured replica) must not itself be enough to reset
// anyone's password. SHA-256 (not bcrypt) is the right tool here because
// the token is already high-entropy random data, not a human-chosen
// password -- there is nothing for a slow hash to protect against that a
// fast one doesn't already, and a reset flow that has to hash-compare
// against every outstanding token needs the lookup to be cheap.

import crypto from 'node:crypto';

const TOKEN_BYTES = 32;      // 256 bits -- unguessable regardless of hash speed
export const RESET_TOKEN_TTL_MS = 60 * 60_000; // 1 hour

/** Returns { token, tokenHash, expiresAt } -- `token` is the only copy of
 * the raw secret and must go straight into the email link, never logged or
 * stored; `tokenHash` is what the database keeps. */
export function generateResetToken() {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  return { token, tokenHash: hashResetToken(token), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) };
}

export function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
