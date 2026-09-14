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
export function requireAdminToken(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return res.status(404).json({ error: 'not_found' });

  const provided = req.get('x-admin-token') ?? '';
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
