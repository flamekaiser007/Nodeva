// GET /nodes -- the browse catalogue backing the "Browse" tab, which lets a
// buyer see what is rentable without first stating requirements the way
// /search demands.
//
// The property that matters: the catalogue must never advertise something a
// buyer cannot actually book. It applies the same bar /search does (online
// per the DB AND per the hub, not retired) plus a live availability window,
// since a node with no window cannot be booked for any time at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import crypto from 'node:crypto';
import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/api/server.js';
import { TYPE } from '../src/ws/protocol.js';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://nodeva:nodeva_dev@localhost:5433/nodeva';
process.env.JWT_SECRET ??= crypto.randomBytes(32).toString('hex');

class FakeSocket extends EventEmitter {
  constructor(onSend) { super(); this._onSend = onSend; }
  send(raw) { this._onSend?.(JSON.parse(raw)); }
  close() { this.emit('close'); }
  receive(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
}

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { raw, sign: (buf) => crypto.sign(null, buf, privateKey) };
}

/** Just enough worker to get the hub to consider this node online. */
class PresentWorker {
  constructor(nodeId, kp) {
    this.nodeId = nodeId;
    this.kp = kp;
    this.sock = new FakeSocket((msg) => this._onHubMessage(msg));
  }

  _awaitMessage(predicate) {
    return new Promise((resolve) => {
      this._waiters ??= [];
      this._waiters.push({ predicate, resolve });
    });
  }

  async connect(hub) {
    const challengeReceived = this._awaitMessage((m) => m.type === TYPE.CHALLENGE);
    hub.handleConnection(this.sock);
    this.sock.receive({ type: TYPE.HELLO, node_id: this.nodeId });
    const challenge = await challengeReceived;
    const welcomed = this._awaitMessage((m) => m.type === TYPE.WELCOME);
    this.sock.receive({
      type: TYPE.CHALLENGE_RESPONSE,
      signature_hex: this.kp.sign(Buffer.from(challenge.nonce, 'utf8')).toString('hex'),
    });
    await welcomed;
  }

  _onHubMessage(msg) {
    this._waiters = (this._waiters ?? []).filter(({ predicate, resolve }) => {
      if (predicate(msg)) { resolve(msg); return false; }
      return true;
    });
  }
}

let pool, server, base, hub, app;
let dbAvailable = false;
try {
  pool = createPool(DATABASE_URL, { connectionTimeoutMillis: 2000 });
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch { /* skipped below */ }

const skip = !dbAvailable && 'requires a reachable Postgres (see docker-compose.yml)';
if (dbAvailable) {
  ({ app, hub } = createApp(pool));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
}
test.after(() => { server?.close(); pool?.end(); });

function authed(token) { return { authorization: `Bearer ${token}` }; }
const json = (res) => res.json();

async function newProvider() {
  const auth = await json(await fetch(`${base}/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `browse-${crypto.randomUUID()}@test.local`,
      password: 'correct horse battery staple', display_name: 'Browse Provider',
    }),
  }));
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(auth.token) });
  return auth;
}

/** Enrolls a node; optionally brings it online and gives it a window. */
async function enrollNode({ online = true, availability = true, pricePaiseHr = 4300 } = {}) {
  const auth = await newProvider();
  const kp = keypair();
  const { node_id } = await json(await fetch(`${base}/nodes`, {
    method: 'POST', headers: { ...authed(auth.token), 'content-type': 'application/json' },
    body: JSON.stringify({
      public_key_hex: kp.raw.toString('hex'), gpu_model: 'RTX 4090',
      gpu_vram_mb: 24576, cpu_cores: 16, ram_mb: 32768, price_paise_hr: pricePaiseHr,
    }),
  }));

  if (online) await new PresentWorker(node_id, kp).connect(hub);
  if (availability) {
    const start = Date.now() + 3_600_000;
    await fetch(`${base}/nodes/${node_id}/availability`, {
      method: 'POST', headers: { ...authed(auth.token), 'content-type': 'application/json' },
      body: JSON.stringify({ window_start: start, window_end: start + 7_200_000 }),
    });
  }
  return { node_id, auth, kp };
}

const catalogue = async () => (await json(await fetch(`${base}/nodes`))).nodes;
const idsIn = (nodes) => nodes.map((n) => n.id);

test('a bookable node appears in the catalogue with its specs and windows', { skip }, async () => {
  const { node_id } = await enrollNode();
  const nodes = await catalogue();

  const mine = nodes.find((n) => n.id === node_id);
  assert.ok(mine, 'an online node with an availability window must be listed');
  assert.equal(mine.gpu_model, 'RTX 4090');
  assert.equal(mine.ram_mb, 32768);
  assert.equal(mine.cpu_cores, 16);
  // The browse page's whole point: you can see WHEN it is bookable without
  // having guessed a time window first.
  assert.equal(mine.availability.length, 1);
  assert.ok(mine.availability[0].start < mine.availability[0].end);
});

test('a node with no availability window is not advertised', { skip }, async () => {
  // It is online, but cannot be booked for any time at all -- listing it
  // would be advertising something nobody can buy. This is the exact case
  // that made "no provider currently matches" so confusing in search.
  const { node_id } = await enrollNode({ availability: false });
  assert.ok(!idsIn(await catalogue()).includes(node_id));
});

test('an offline node is not advertised', { skip }, async () => {
  const { node_id } = await enrollNode({ online: false });
  assert.ok(!idsIn(await catalogue()).includes(node_id));
});

test('a retired node disappears from the catalogue', { skip }, async () => {
  // The old raw-dump version of this endpoint listed 'draining' nodes, so a
  // provider who had retired a machine kept seeing it offered for rent.
  const { node_id, auth } = await enrollNode();
  assert.ok(idsIn(await catalogue()).includes(node_id), 'listed before retiring');

  await fetch(`${base}/nodes/${node_id}/retire`, { method: 'POST', headers: authed(auth.token) });
  assert.ok(!idsIn(await catalogue()).includes(node_id), 'gone after retiring');
});

test('a window that has already ended does not make a node bookable', { skip }, async () => {
  const auth = await newProvider();
  const kp = keypair();
  const { node_id } = await json(await fetch(`${base}/nodes`, {
    method: 'POST', headers: { ...authed(auth.token), 'content-type': 'application/json' },
    body: JSON.stringify({
      public_key_hex: kp.raw.toString('hex'), gpu_model: 'RTX 4090',
      gpu_vram_mb: 24576, cpu_cores: 16, ram_mb: 32768, price_paise_hr: 4300,
    }),
  }));
  await new PresentWorker(node_id, kp).connect(hub);
  await fetch(`${base}/nodes/${node_id}/availability`, {
    method: 'POST', headers: { ...authed(auth.token), 'content-type': 'application/json' },
    body: JSON.stringify({
      window_start: Date.now() - 7_200_000, window_end: Date.now() - 3_600_000,
    }),
  });

  assert.ok(!idsIn(await catalogue()).includes(node_id), 'a past window is not availability');
});

test('the catalogue is ordered cheapest first', { skip }, async () => {
  await enrollNode({ pricePaiseHr: 9900 });
  await enrollNode({ pricePaiseHr: 1100 });
  const prices = (await catalogue()).map((n) => n.price_paise_hr);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
});
