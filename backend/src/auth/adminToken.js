import crypto from 'node:crypto';

// Admin-only routes have no role system to sit behind (see
// api/server.js's manual-settlement gate for the same honest gap) --
// building one for a single ops-summary endpoint would be scope creep the
// MVP doesn't need yet. A separate shared-secret header is the smallest
// thing that is still actually safe: it does NOT reuse a normal user's
// JWT, because every authenticated user already HAS a valid JWT, and this
// endpoint returns cross-tenant data (every user's disputes, every user's
// stuck refunds) that no ordinary session should be able to read.
//
// Disabled entirely (404, not 401/403, so a prober can't even confirm the
// route exists) unless ADMIN_TOKEN is set -- the same off-by-default
// posture as ALLOW_MANUAL_SETTLEMENT. A real deployment sets ADMIN_TOKEN
// to a long random value and keeps it as secret as the JWT signing key.
// Accepts either a bare `x-admin-token` header (the original, simplest
// shape) OR a standard `Authorization: Bearer <token>` header -- the
// latter is what Prometheus's own `bearer_token` scrape option sends (see
// alerting/prometheus.yml), and a real, live-caught bug the first version
// of this middleware had: /metrics's own file comment in api/server.js
// claimed a Prometheus bearer_token scrape would "authenticate against it
// like any other client", but this function only ever checked
// `x-admin-token` -- a real Prometheus container scraping a real running
// backend got a real 404 every time until this was fixed.
function extractProvidedToken(req) {
  const bare = req.get('x-admin-token');
  if (bare) return bare;
  const auth = req.get('authorization') ?? '';
  const match = auth.match(/^Bearer (.+)$/);
  return match ? match[1] : '';
}

export function requireAdminToken(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return res.status(404).json({ error: 'not_found' });

  const provided = extractProvidedToken(req);
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  // timingSafeEqual throws on a length mismatch rather than returning
  // false -- pad the comparison so a wrong-length token doesn't leak
  // length via a thrown-vs-compared timing difference, then check length
  // separately so equal-length garbage still correctly fails.
  const padded = Buffer.alloc(expectedBuf.length);
  providedBuf.copy(padded);
  const matches = providedBuf.length === expectedBuf.length
    && crypto.timingSafeEqual(padded, expectedBuf);
  if (!matches) return res.status(404).json({ error: 'not_found' });
  next();
}
