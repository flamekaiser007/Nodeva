import pg from 'pg';

// Postgres represents BIGINT as a JS string by default (it exceeds the safe
// integer range for some values), which would silently turn our paise amounts
// into strings and break arithmetic. We only ever store paise well within
// Number.isSafeInteger range, so parsing as JS numbers here is correct for
// this schema — just not pg's default.
pg.types.setTypeParser(20 /* int8 */, (val) => parseInt(val, 10));

export function createPool(connectionString = process.env.DATABASE_URL, options = {}) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  // Off by default -- local dev (docker-compose's postgres) and CI both
  // connect over a plaintext local link with no SSL certificate to
  // validate, and node-postgres does NOT infer `ssl` from a `sslmode=...`
  // query param in the URL the way `psql` does; it has to be passed
  // explicitly. Real managed Postgres hosts (Render, RDS, etc.) require
  // SSL and use a certificate this process has no independent way to
  // validate against, so `rejectUnauthorized: false` -- this still
  // encrypts the connection, it just doesn't pin the CA, the same
  // pragmatic tradeoff every "just give me DATABASE_URL and go" deploy
  // guide for node-postgres makes.
  const ssl = process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined;
  return new pg.Pool({ connectionString, ssl, ...options });
}
