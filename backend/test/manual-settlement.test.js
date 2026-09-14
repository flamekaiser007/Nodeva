// POST /reservations/:id/complete lets a caller settle their OWN
// reservation with a client-supplied outcome -- useful for driving the
// money path without a real job (scripts/e2e_demo.sh's Docker-unavailable
// fallback, and tests written before job execution existed), but unsafe
// to expose by default: nothing checks a claimed outcome like
// 'failed_provider' against what actually happened, so an enabled
// deployment would let a user claim a refund for work that succeeded.
// ALLOW_MANUAL_SETTLEMENT gates it off by default; this proves both sides
// of that gate against the real app on a real port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import crypto from 'node:crypto';
import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/api/server.js';
import { TYPE } from '../src/ws/protocol.js';
import { encode } from '../src/lib/canonical.js';

class FakeSocket extends EventEmitter {
  constructor(onSend) { super(); this._onSend = onSend; }
  send(raw) { const msg = JSON.parse(raw); this._onSend?.(msg); }
  close() { this.emit('close'); }
  receive(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
}

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { raw, sign: (buf) => crypto.sign(null, buf, privateKey) };
}

const tick = () => new Promise((r) => setImmediate(r));

// Just enough of a worker to get a real HELD reservation row -- this test
// is about the /complete route's on/off gate, not the reservation
// lifecycle, so it never needs to answer JOB_SUBMIT or anything past a
// signed receipt.
class MinimalWorker {
  constructor(nodeId, kp) {
    this.nodeId = nodeId; this.kp = kp;
    this.sock = new FakeSocket((msg) => this._onMessage(msg));
  }
  _await(predicate) {
    return new Promise((resolve) => { this._waiters ??= []; this._waiters.push({ predicate, resolve }); });
  }
  async connect(hub) {
    const challenge = this._await((m) => m.type === TYPE.CHALLENGE);
    hub.handleConnection(this.sock);
    this.sock.receive({ type: TYPE.HELLO, node_id: this.nodeId });
    const c = await challenge;
    const sig = this.kp.sign(Buffer.from(c.nonce, 'utf8'));
    const welcomed = this._await((m) => m.type === TYPE.WELCOME);
    this.sock.receive({ type: TYPE.CHALLENGE_RESPONSE, signature_hex: sig.toString('hex') });
    await welcomed;
  }
  async _onMessage(msg) {
    if (this._waiters?.length) {
      this._waiters = this._waiters.filter(({ predicate, resolve }) => {
        if (predicate(msg)) { resolve(msg); return false; }
        return true;
      });
    }
    if (msg.type === TYPE.RESERVE_REQUEST) {
      const body = {
        reservation_id: msg.reservation_id, node_id: this.nodeId,
        starts_at: msg.starts_at, ends_at: msg.ends_at, price_paise_hr: msg.price_paise_hr,
        hold_expires_at: Date.now() + 120_000, issued_at: Date.now(),
      };
      const sig = this.kp.sign(encode(body));
      await tick();
      this.sock.receive({
        type: TYPE.RECEIPT, reservation_id: msg.reservation_id, body, signature_hex: sig.toString('hex'),
      });
    }
  }
}

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://nodeva:nodeva_dev@localhost:5433/nodeva';
process.env.JWT_SECRET ??= crypto.randomBytes(32).toString('hex');

let pool;
let dbAvailable = false;
try {
  pool = createPool(DATABASE_URL, { connectionTimeoutMillis: 2000 });
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch { /* skipped below */ }
const skip = !dbAvailable && 'requires a reachable Postgres (see docker-compose.yml)';
test.after(() => pool?.end());

function authed(token) { return { authorization: `Bearer ${token}` }; }
async function json(res) { return res.json(); }

async function startApp() {
  const { app, hub } = createApp(pool);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, hub, base: `http://localhost:${server.address().port}` };
}

async function signupAndReserve(base, hub, dayOffset) {
  const buyer = await json(await fetch(`${base}/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `manual-settle-buyer-${crypto.randomUUID()}@test.local`,
      password: 'correct horse battery staple', display_name: 'Manual Settle Buyer',
    }),
  }));
  const providerAuth = await json(await fetch(`${base}/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `manual-settle-provider-${crypto.randomUUID()}@test.local`,
      password: 'correct horse battery staple', display_name: 'Manual Settle Provider',
    }),
  }));
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(providerAuth.token) });
  const kp = keypair();
  const { node_id } = await json(await fetch(`${base}/nodes`, {
    method: 'POST', headers: { ...authed(providerAuth.token), 'content-type': 'application/json' },
    body: JSON.stringify({
      public_key_hex: kp.raw.toString('hex'), gpu_model: 'RTX 4090',
      gpu_vram_mb: 24576, cpu_cores: 16, ram_mb: 32768, price_paise_hr: 4300,
    }),
  }));
  const worker = new MinimalWorker(node_id, kp);
  await worker.connect(hub);
  const startsAt = Date.UTC(2033, 0, dayOffset, 10, 0);
  const reserveRes = await json(await fetch(`${base}/reservations`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({ node_id, starts_at: startsAt, ends_at: startsAt + 3_600_000 }),
  }));
  return { buyer, reservationId: reserveRes.reservation_id };
}

test('manual settlement is disabled by default -- 404, not exposing the route to a prober', { skip }, async () => {
  delete process.env.ALLOW_MANUAL_SETTLEMENT;
  const { server, hub, base } = await startApp();
  try {
    const { buyer, reservationId } = await signupAndReserve(base, hub, 1);
    const res = await fetch(`${base}/reservations/${reservationId}/complete`, {
      method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'failed_provider' }),
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'not_found');
  } finally {
    server.close();
  }
});

test('manual settlement works normally once explicitly enabled', { skip }, async () => {
  process.env.ALLOW_MANUAL_SETTLEMENT = 'true';
  const { server, hub, base } = await startApp();
  try {
    const { buyer, reservationId } = await signupAndReserve(base, hub, 2);
    const res = await fetch(`${base}/reservations/${reservationId}/complete`, {
      method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'failed_provider' }),
    });
    // Not necessarily 200 (the reservation may not be in a settleable
    // state, since no worker ever confirmed it) -- the point is it must NOT
    // be the blanket 404 the disabled gate returns; a real error from
    // settleReservation's own state-machine check is fine and expected.
    assert.notEqual(res.status, 404);
  } finally {
    server.close();
    delete process.env.ALLOW_MANUAL_SETTLEMENT;
  }
});
