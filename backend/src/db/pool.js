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
  return new pg.Pool({ connectionString, ...options });
}
