// Session tokens. HS256, short-ish expiry -- the simplest thing that is
// not wrong for an MVP. No refresh tokens: sessions just expire and the
// user logs in again. Add refresh tokens when "log in again every day" is
// an actual user complaint, not before.
//
// Rotation IS supported, though, and separately from refresh tokens: with
// a 24h expiry, rotating JWT_SECRET is already a bounded problem (worst
// case, everyone is logged out within a day), but "everyone logged out the
// moment ops rotates a secret" is still a real, avoidable disruption for
// something that should be routine. See requireJwtVerificationSecrets.

import jwt from 'jsonwebtoken';

const EXPIRES_IN = '24h';

export function requireJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    // A missing or short secret is not a warning-and-continue situation: a
    // guessable or absent secret means anyone can forge a session for any
    // user_id. Fail loudly at startup rather than generating an ephemeral
    // secret that "works" but silently invalidates every session on
    // restart and gives no indication anything is wrong.
    throw new Error(
      'JWT_SECRET must be set to a random string of at least 32 characters. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return secret;
}

// Verification accepts the CURRENT secret plus any still-valid PREVIOUS
// ones (JWT_SECRET_PREVIOUS, comma-separated) -- the mechanism that makes
// rotating JWT_SECRET a non-event instead of a mass logout. Signing
// (signSession, below) only ever uses the single current secret: a
// session issued mid-rotation should carry the NEW secret, so it is still
// valid once the previous one is finally retired -- carrying the OLD
// secret forward would just delay the same cutover, not avoid it.
//
// See docs/secrets-rotation.md for the actual rotation runbook (deploy
// with both set, wait out the longest-lived token's expiry, THEN remove
// JWT_SECRET_PREVIOUS in a second deploy).
export function requireJwtVerificationSecrets() {
  const current = requireJwtSecret();
  const previous = (process.env.JWT_SECRET_PREVIOUS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return [current, ...previous];
}

export function signSession(secret, { userId, email }) {
  return jwt.sign({ sub: userId, email }, secret, { expiresIn: EXPIRES_IN });
}

/** `secrets` may be a single string (unchanged call sites keep working) or
 * an array to try in order -- requireAuth (auth/middleware.js) passes
 * whatever it was constructed with straight through without needing to
 * know which. Throws the LAST secret's error if none verify, since that's
 * usually the most-current one and therefore the most useful to see in a
 * log line. */
export function verifySession(secrets, token) {
  const list = Array.isArray(secrets) ? secrets : [secrets];
  let lastError;
  for (const secret of list) {
    try {
      const payload = jwt.verify(token, secret);
      return { userId: payload.sub, email: payload.email };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}
