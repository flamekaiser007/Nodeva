// rateLimit.test.js proves the middleware itself works in isolation; this
// proves it is actually WIRED into the real app on the real routes, not
// just imported and forgotten -- exercised via real HTTP against the real
// Express app, same discipline as every other endpoint test in this suite.
// Only the login-by-email limiter (the smallest max) is exercised for
// real; server.js's other two (signup, login-by-IP) use a max in the
// dozens-to-hundreds, which would make this test slow for no extra
// confidence -- the middleware's own generic behavior is already proven
// by rateLimit.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/api/server.js';
import { _resetForTests } from '../src/auth/rateLimit.js';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://nodeva:nodeva_dev@localhost:5433/nodeva';
process.env.JWT_SECRET ??= crypto.randomBytes(32).toString('hex');

let pool, server, base;
let dbAvailable = false;
try {
  pool = createPool(DATABASE_URL, { connectionTimeoutMillis: 2000 });
  await pool.query('SELECT 1');
  const { app } = createApp(pool);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
  dbAvailable = true;
} catch { /* skipped below */ }

const skip = !dbAvailable && 'requires a reachable Postgres (see docker-compose.yml)';
test.after(() => { server?.close(); pool?.end(); });
test.beforeEach(() => { if (dbAvailable) _resetForTests(); });

function login(email) {
  return fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'definitely wrong' }),
  });
}

test('repeated login attempts for one email are rate-limited (server.js max is 8/15min)', { skip }, async () => {
  const email = `ratelimit-target-${crypto.randomUUID()}@test.local`;
  for (let i = 0; i < 8; i++) {
    const res = await login(email);
    assert.equal(res.status, 401, `attempt ${i + 1} of 8 should fail normally (wrong password), not be rate-limited yet`);
  }
  const res = await login(email);
  assert.equal(res.status, 429, 'the 9th attempt within the window must be rate-limited');
  assert.ok(res.headers.get('retry-after'));
});

test("rate-limiting one email's login attempts does not affect a different email", { skip }, async () => {
  const target = `ratelimit-target2-${crypto.randomUUID()}@test.local`;
  const bystander = `ratelimit-bystander-${crypto.randomUUID()}@test.local`;
  for (let i = 0; i < 9; i++) await login(target); // exhausts target's limit
  const targetRes = await login(target);
  assert.equal(targetRes.status, 429);
  const bystanderRes = await login(bystander);
  assert.equal(bystanderRes.status, 401, "a different email's login must not be blocked by someone else's limit");
});
