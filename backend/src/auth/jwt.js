// Session tokens. HS256, one secret, short-ish expiry -- the simplest thing
// that is not wrong for an MVP. No refresh tokens, no rotation: sessions
// just expire and the user logs in again. Add refresh tokens when "log in
// again every day" is an actual user complaint, not before.

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

export function signSession(secret, { userId, email }) {
  return jwt.sign({ sub: userId, email }, secret, { expiresIn: EXPIRES_IN });
}

export function verifySession(secret, token) {
  const payload = jwt.verify(token, secret); // throws on invalid/expired/tampered
  return { userId: payload.sub, email: payload.email };
}
