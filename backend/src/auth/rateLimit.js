// Fixed-window rate limiting for the auth endpoints most exposed to abuse:
// signup (spam accounts), login (credential stuffing / brute force),
// forgot-password (email-bombing a stranger's inbox with reset links --
// see auth/email.js, which sends regardless of whether the account exists,
// by design, to avoid leaking which emails are registered; that same
// design means nothing else stops a stranger from spamming an inbox they
// don't own except this).
//
// HONEST LIMIT: this is in-memory, per-process state. Correct for the
// single backend instance this MVP actually runs; wrong the moment a
// second instance joins without a shared store. ws/clusterRelay.js has
// since taken the Hub through exactly this same in-memory-to-Redis move
// for cross-instance node routing -- this module would follow the same
// pattern (a Redis-backed counter instead of the local Map below) if and
// when rate limiting specifically needs to survive a second instance;
// not built ahead of that need, since a per-instance limit is still a
// real (if weaker) limit today, not a no-op.
//
// Thresholds below are illustrative starting points, not researched
// constants -- the same posture jobs/verification.js's thresholds take.

const buckets = new Map();

// Sweeps expired buckets periodically so a stream of one-off IPs/emails
// doesn't grow this Map forever. `unref()` so this timer alone never keeps
// the process alive (tests that don't explicitly close a server would
// otherwise hang on this).
const sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}, 5 * 60 * 1000);
sweepInterval.unref();

function hit(key, windowMs, max) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  return { limited: bucket.count > max, retryAfterMs: bucket.resetAt - now };
}

/** Express middleware: `keyFn(req)` names the bucket (e.g. by IP, by
 * email, or a composite) -- callers decide what "one client" means for
 * their endpoint. Returns 429 with a Retry-After header once `max` hits
 * land within `windowMs` for a given key; a falsy key (e.g. no email in
 * the body yet) is never rate-limited, since there's nothing meaningful to
 * key on -- the request will fail validation downstream instead. */
export function rateLimit({ windowMs, max, keyFn }) {
  return (req, res, next) => {
    const key = keyFn(req);
    if (!key) return next();
    const { limited, retryAfterMs } = hit(key, windowMs, max);
    if (limited) {
      res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return res.status(429).json({ error: 'too_many_requests' });
    }
    next();
  };
}

/** Test-only escape hatch: the module-level bucket map otherwise persists
 * for the lifetime of the process, which is correct in production but
 * would let one test's hits bleed into the next within the same file. */
export function _resetForTests() {
  buckets.clear();
}
