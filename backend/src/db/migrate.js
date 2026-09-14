#!/usr/bin/env node
// A real migration runner -- package.json has referenced `npm run migrate`
// since the first commit, but the file it pointed at never existed;
// scripts/e2e_demo.sh and CI instead reapplied every migration file with
// raw psql against a freshly dropped schema every single run, which only
// works because those two call sites always start from nothing. Neither
// of them tracks WHICH migrations have already run, so neither could ever
// be pointed at a database that already has some (but not all) migrations
// applied -- which is exactly what a real deployment needs.
//
// This tracks applied migrations in a `schema_migrations` table and only
// runs the ones not yet recorded, each in its own transaction. Files in
// backend/migrations/ are applied in filename order (001_, 002_, ... --
// already the existing naming convention, just now load-bearing).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

/** Applies every migration in `dir` not already recorded in
 * schema_migrations, in filename order, each inside its own transaction.
 * Returns the list of filenames actually applied (empty if already
 * up to date). Throws on the first failure, leaving that one migration's
 * transaction rolled back and every later one un-attempted -- a migration
 * runner that kept going past a failure would leave the schema in an
 * unknown, undocumented state, which is worse than stopping. */
export async function migrate(pool, { dir = DEFAULT_MIGRATIONS_DIR, log = () => {} } = {}) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const alreadyApplied = new Set(rows.map((r) => r.filename));
  const pending = files.filter((f) => !alreadyApplied.has(f));

  for (const filename of pending) {
    const sql = readFileSync(path.join(dir, filename), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      log(`applied ${filename}`);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`migration ${filename} failed: ${e.message}`, { cause: e });
    } finally {
      client.release();
    }
  }

  return pending;
}

async function main() {
  const pool = createPool();
  try {
    const applied = await migrate(pool, { log: (msg) => console.log(msg) });
    if (applied.length === 0) console.log('database already up to date, nothing to apply');
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
