// Proves /metrics is actually wired into the real app (gated the same way
// as /admin/ops-summary) and that the business counters increment at real
// call sites when real requests flow through -- not just that the
// observability/metrics.js module works in isolation (unit-tested
// separately would only prove the Counter/Histogram API is used
// correctly, not that anything in server.js actually calls .inc()).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import crypto from 'node:crypto';
import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/api/server.js';
import { TYPE, decodeEnvelope } from '../src/ws/protocol.js';
import { encode } from '../src/lib/canonical.js';
import { _resetMetricsForTests } from '../src/observability/metrics.js';

class FakeSocket extends EventEmitter {
  constructor() { super(); this.sent = []; }
  send(raw) { this.sent.push(decodeEnvelope(raw)); }
  close() { this.emit('close'); }
  lastSent() { return this.sent.at(-1); }
  receive(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
}

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { raw, sign: (buf) => crypto.sign(null, buf, privateKey) };
}

const tick = () => new Promise((r) => setImmediate(r));
// Wait for the message we actually need rather than for a fixed duration.
// These steps wait out a real Postgres round trip (async I/O, which
// setImmediate alone does not reliably cover -- the lesson
// verification-flow.test.js's identical comment documents), and a plain
// `setTimeout(50)` silently becomes a race the moment Postgres is slower
// than that: `node --test` runs test files in PARALLEL against one shared
// database, so under that contention 50ms was sometimes not enough and
// lastSent() returned the PREVIOUS message, producing a wrong
// reservation_id and a bogus failure. Caught live as a rare CI flake.
async function waitForSent(sock, type, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = sock.lastSent();
    if (msg?.type === type) return msg;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${type}; last was ${sock.lastSent()?.type}`);
}

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://nodeva:nodeva_dev@localhost:5433/nodeva';
process.env.JWT_SECRET ??= crypto.randomBytes(32).toString('hex');

let pool, server, base, hub;
let dbAvailable = false;
try {
  pool = createPool(DATABASE_URL, { connectionTimeoutMillis: 2000 });
  await pool.query('SELECT 1');
  const created = createApp(pool);
  hub = created.hub;
  server = http.createServer(created.app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
  dbAvailable = true;
} catch { /* skipped below */ }

const skip = !dbAvailable && 'requires a reachable Postgres (see docker-compose.yml)';
test.after(() => { server?.close(); pool?.end(); });
test.beforeEach(() => { if (dbAvailable) _resetMetricsForTests(); });

function authed(token) { return { authorization: `Bearer ${token}` }; }

test('metrics is disabled (404) without ADMIN_TOKEN set', { skip }, async () => {
  delete process.env.ADMIN_TOKEN;
  const res = await fetch(`${base}/metrics`);
  assert.equal(res.status, 404);
});

test('metrics rejects the wrong token even when one is configured', { skip }, async () => {
  process.env.ADMIN_TOKEN = 'test-metrics-secret';
  try {
    const res = await fetch(`${base}/metrics`, { headers: { 'x-admin-token': 'wrong' } });
    assert.equal(res.status, 404);
  } finally {
    delete process.env.ADMIN_TOKEN;
  }
});

test('with the correct token, returns real Prometheus exposition text', { skip }, async () => {
  process.env.ADMIN_TOKEN = 'test-metrics-secret';
  try {
    const res = await fetch(`${base}/metrics`, { headers: { 'x-admin-token': 'test-metrics-secret' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/plain/);
    const text = await res.text();
    assert.match(text, /# TYPE nodeva_http_requests_total counter/);
    assert.match(text, /# TYPE nodeva_reservations_created_total counter/);
    // Default Node.js process metrics (collectDefaultMetrics) should also
    // be present -- proves the registry isn't just this file's own custom
    // metrics with nothing else wired in.
    assert.match(text, /process_cpu_user_seconds_total/);
  } finally {
    delete process.env.ADMIN_TOKEN;
  }
});

test('a real request increments nodeva_http_requests_total for its own route, labeled by status', { skip }, async () => {
  process.env.ADMIN_TOKEN = 'test-metrics-secret';
  try {
    await fetch(`${base}/health`);
    const text = await (await fetch(`${base}/metrics`, { headers: { 'x-admin-token': 'test-metrics-secret' } })).text();
    assert.match(text, /nodeva_http_requests_total\{method="GET",route="\/health",status="200"\} 1/);
  } finally {
    delete process.env.ADMIN_TOKEN;
  }
});

test('a route with a UUID param is labeled by its ROUTE PATTERN, not the literal URL', { skip }, async () => {
  // The whole reason req.route.path is used instead of req.path: labeling
  // by the literal URL would create one label series per reservation ever
  // created, an unbounded-cardinality metric that can take down a real
  // Prometheus server.
  process.env.ADMIN_TOKEN = 'test-metrics-secret';
  try {
    await fetch(`${base}/reservations/${crypto.randomUUID()}`, { headers: authed('not-a-real-token') });
    const text = await (await fetch(`${base}/metrics`, { headers: { 'x-admin-token': 'test-metrics-secret' } })).text();
    assert.match(text, /route="\/reservations\/:id"/);
  } finally {
    delete process.env.ADMIN_TOKEN;
  }
});

test('an attempt against an unknown node (never actually creates a reservation) does not count', { skip }, async () => {
  process.env.ADMIN_TOKEN = 'test-metrics-secret';
  try {
    const buyer = await (await fetch(`${base}/auth/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `metrics-buyer-${crypto.randomUUID()}@test.local`,
        password: 'correct horse battery staple', display_name: 'Metrics Buyer',
      }),
    })).json();

    const res = await fetch(`${base}/reservations`, {
      method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
      body: JSON.stringify({ node_id: crypto.randomUUID(), starts_at: 0, ends_at: 1 }),
    });
    assert.equal(res.status, 404, 'unknown node -- confirms this attempt did NOT reach the counter');

    // prom-client always emits a Counter's line once constructed, even at
    // zero -- absence of the line is not the right check; the VALUE is.
    const after = await (await fetch(`${base}/metrics`, { headers: { 'x-admin-token': 'test-metrics-secret' } })).text();
    assert.match(after, /nodeva_reservations_created_total 0/);
  } finally {
    delete process.env.ADMIN_TOKEN;
  }
});

test('a genuinely created reservation (real node, real signed receipt) increments the counter to 1', { skip }, async () => {
  process.env.ADMIN_TOKEN = 'test-metrics-secret';
  try {
    const buyer = await (await fetch(`${base}/auth/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `metrics-buyer2-${crypto.randomUUID()}@test.local`,
        password: 'correct horse battery staple', display_name: 'Metrics Buyer 2',
      }),
    })).json();
    const providerAuth = await (await fetch(`${base}/auth/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `metrics-provider-${crypto.randomUUID()}@test.local`,
        password: 'correct horse battery staple', display_name: 'Metrics Provider',
      }),
    })).json();
    await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(providerAuth.token) });
    const kp = keypair();
    const { node_id } = await (await fetch(`${base}/nodes`, {
      method: 'POST', headers: { ...authed(providerAuth.token), 'content-type': 'application/json' },
      body: JSON.stringify({
        public_key_hex: kp.raw.toString('hex'), gpu_model: 'RTX 4090',
        gpu_vram_mb: 24576, cpu_cores: 16, ram_mb: 32768, price_paise_hr: 4300,
      }),
    })).json();

    const sock = new FakeSocket();
    hub.handleConnection(sock);
    sock.receive({ type: TYPE.HELLO, node_id });
    const challenge = await waitForSent(sock, TYPE.CHALLENGE);
    const sig = kp.sign(Buffer.from(challenge.nonce, 'utf8'));
    sock.receive({ type: TYPE.CHALLENGE_RESPONSE, signature_hex: sig.toString('hex') });
    await tick();

    const startsAt = Date.UTC(2035, 0, 1, 10, 0);
    const endsAt = startsAt + 3_600_000;
    const reservePromise = fetch(`${base}/reservations`, {
      method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
      body: JSON.stringify({ node_id, starts_at: startsAt, ends_at: endsAt }),
    });
    const request = await waitForSent(sock, TYPE.RESERVE_REQUEST);
    const body = {
      reservation_id: request.reservation_id, node_id,
      starts_at: startsAt, ends_at: endsAt, price_paise_hr: 4300,
      hold_expires_at: Date.now() + 120_000, issued_at: Date.now(),
    };
    sock.receive({
      type: TYPE.RECEIPT, reservation_id: body.reservation_id, body,
      signature_hex: kp.sign(encode(body)).toString('hex'),
    });
    const res = await reservePromise;
    assert.equal(res.status, 201, 'the reservation must have genuinely been created');

    const text = await (await fetch(`${base}/metrics`, { headers: { 'x-admin-token': 'test-metrics-secret' } })).text();
    assert.match(text, /nodeva_reservations_created_total 1/);
  } finally {
    delete process.env.ADMIN_TOKEN;
  }
});
