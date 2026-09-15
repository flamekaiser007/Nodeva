// createPool's SSL wiring, checked against the real pg.Pool's own stored
// config (p.options.ssl) rather than mocking pg -- no network connection
// needed to construct a Pool, only to actually query it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/db/pool.js';

const URL = 'postgresql://u:p@localhost:5432/d';

test('SSL is off by default -- local dev and CI connect over a plaintext link', () => {
  delete process.env.PGSSL;
  const pool = createPool(URL);
  assert.equal(pool.options.ssl, undefined);
  pool.end();
});

test('PGSSL=true enables SSL without cert validation, for a managed host (Render, RDS, etc.)', () => {
  process.env.PGSSL = 'true';
  try {
    const pool = createPool(URL);
    assert.deepEqual(pool.options.ssl, { rejectUnauthorized: false });
    pool.end();
  } finally {
    delete process.env.PGSSL;
  }
});

test('a caller-supplied ssl option in `options` is not silently overridden', () => {
  // createPool(connectionString, options) merges options AFTER the derived
  // ssl value -- a caller passing their own `ssl` (e.g. a test needing a
  // specific pool config) must win over the env-derived default.
  process.env.PGSSL = 'true';
  try {
    const pool = createPool(URL, { ssl: false });
    assert.equal(pool.options.ssl, false);
    pool.end();
  } finally {
    delete process.env.PGSSL;
  }
});

test('createPool throws without a connection string, same as before', () => {
  delete process.env.DATABASE_URL;
  assert.throws(() => createPool(undefined), /DATABASE_URL is not set/);
});
