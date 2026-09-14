// migrate() is exercised against a real Postgres, in its own throwaway
// schema (not `public`, which every other test file's app instance
// depends on staying intact) -- creating and dropping a schema is cheap
// and keeps this file from racing the rest of the suite over shared state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://nodeva:nodeva_dev@localhost:5433/nodeva';

let pool;
let dbAvailable = false;
try {
  pool = createPool(DATABASE_URL, { connectionTimeoutMillis: 2000 });
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch { /* skipped below */ }
const skip = !dbAvailable && 'requires a reachable Postgres (see docker-compose.yml)';
test.after(() => pool?.end());

function writeMigrations(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nodeva-migrate-test-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(path.join(dir, name), sql);
  return dir;
}

async function inSchema(fn) {
  const schema = `test_migrate_${crypto.randomUUID().replace(/-/g, '_')}`;
  await pool.query(`CREATE SCHEMA "${schema}"`);
  // `options` is passed as a libpq startup-packet parameter for every
  // physical connection the pool opens (not a query run afterward), so
  // search_path is set correctly regardless of pool size or which
  // underlying connection a given query happens to land on.
  const scopedPool = createPool(DATABASE_URL, { options: `-c search_path=${schema}` });
  try {
    await fn(scopedPool);
  } finally {
    await scopedPool.end();
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
}

test('applies every migration file in filename order and records each one', { skip }, async () => {
  await inSchema(async (scopedPool) => {
    const dir = writeMigrations({
      '001_a.sql': 'CREATE TABLE a (id INT);',
      '002_b.sql': 'CREATE TABLE b (id INT);',
    });
    const applied = await migrate(scopedPool, { dir });
    assert.deepEqual(applied, ['001_a.sql', '002_b.sql']);

    const tables = await scopedPool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name IN ('a','b') ORDER BY table_name`);
    assert.deepEqual(tables.rows.map((r) => r.table_name), ['a', 'b']);

    const recorded = await scopedPool.query('SELECT filename FROM schema_migrations ORDER BY filename');
    assert.deepEqual(recorded.rows.map((r) => r.filename), ['001_a.sql', '002_b.sql']);
    rmSync(dir, { recursive: true, force: true });
  });
});

test('a second run applies nothing -- already-recorded migrations are skipped', { skip }, async () => {
  await inSchema(async (scopedPool) => {
    const dir = writeMigrations({ '001_a.sql': 'CREATE TABLE a (id INT);' });
    const first = await migrate(scopedPool, { dir });
    assert.deepEqual(first, ['001_a.sql']);
    const second = await migrate(scopedPool, { dir });
    assert.deepEqual(second, [], 're-running must find nothing pending');
    rmSync(dir, { recursive: true, force: true });
  });
});

test('adding a new migration file later only applies the new one', { skip }, async () => {
  await inSchema(async (scopedPool) => {
    const dir = writeMigrations({ '001_a.sql': 'CREATE TABLE a (id INT);' });
    await migrate(scopedPool, { dir });
    writeFileSync(path.join(dir, '002_b.sql'), 'CREATE TABLE b (id INT);');
    const second = await migrate(scopedPool, { dir });
    assert.deepEqual(second, ['002_b.sql'], 'only the newly added file should run');
    rmSync(dir, { recursive: true, force: true });
  });
});

test('a failing migration rolls back and stops -- later migrations are never attempted', { skip }, async () => {
  await inSchema(async (scopedPool) => {
    const dir = writeMigrations({
      '001_a.sql': 'CREATE TABLE a (id INT);',
      '002_broken.sql': 'CREATE TABLE this is not valid SQL(',
      '003_c.sql': 'CREATE TABLE c (id INT);',
    });
    await assert.rejects(
      () => migrate(scopedPool, { dir }),
      /002_broken\.sql failed/);

    const recorded = await scopedPool.query('SELECT filename FROM schema_migrations');
    assert.deepEqual(recorded.rows.map((r) => r.filename), ['001_a.sql'],
      'the failed migration must not be recorded, and the one after it must never run');
    const cTable = await scopedPool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'c'`);
    assert.equal(cTable.rows.length, 0, "003_c.sql must never have run after 002 failed");
    rmSync(dir, { recursive: true, force: true });
  });
});

test('an empty migrations directory on a fresh schema applies nothing and does not throw', { skip }, async () => {
  await inSchema(async (scopedPool) => {
    const dir = writeMigrations({});
    const applied = await migrate(scopedPool, { dir });
    assert.deepEqual(applied, []);
    rmSync(dir, { recursive: true, force: true });
  });
});
