// imageAllowlist.test.js proves checkImageAllowed's own logic; this proves
// it's actually wired into POST /reservations/:id/jobs, not just imported
// and forgotten -- exercised through the real app and a real Hub, same
// pattern as reservation-read.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import crypto from 'node:crypto';
import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/api/server.js';
import { TYPE } from '../src/ws/protocol.js';
import { encode } from '../src/lib/canonical.js';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://nodeva:nodeva_dev@localhost:5433/nodeva';
process.env.JWT_SECRET ??= crypto.randomBytes(32).toString('hex');

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

class HonestWorker {
  constructor(nodeId, kp) {
    this.nodeId = nodeId;
    this.kp = kp;
    this.sock = new FakeSocket((msg) => this._onHubMessage(msg));
    this.jobSubmitted = false;
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
    const sig = this.kp.sign(Buffer.from(challenge.nonce, 'utf8'));
    const welcomed = this._awaitMessage((m) => m.type === TYPE.WELCOME);
    this.sock.receive({ type: TYPE.CHALLENGE_RESPONSE, signature_hex: sig.toString('hex') });
    await welcomed;
  }

  async _onHubMessage(msg) {
    if (this._waiters?.length) {
      this._waiters = this._waiters.filter(({ predicate, resolve }) => {
        if (predicate(msg)) { resolve(msg); return false; }
        return true;
      });
    }
    if (msg.type === TYPE.CHALLENGE || msg.type === TYPE.WELCOME) return;
    if (msg.type === TYPE.RESERVE_REQUEST) {
      const body = {
        reservation_id: msg.reservation_id, node_id: this.nodeId,
        starts_at: msg.starts_at, ends_at: msg.ends_at,
        price_paise_hr: msg.price_paise_hr,
        hold_expires_at: Date.now() + 120_000, issued_at: Date.now(),
      };
      const sig = this.kp.sign(encode(body));
      await tick();
      this.sock.receive({
        type: TYPE.RECEIPT, reservation_id: msg.reservation_id,
        body, signature_hex: sig.toString('hex'),
      });
      return;
    }
    if (msg.type === TYPE.RESERVE_COMMIT) {
      await tick();
      this.sock.receive({ type: TYPE.COMMITTED, reservation_id: msg.reservation_id });
      return;
    }
    if (msg.type === TYPE.JOB_SUBMIT) {
      // Marks that the worker (i.e. `docker run`) was actually reached --
      // the assertion that matters most: a disallowed image must never get
      // this far, regardless of what HTTP status code comes back.
      this.jobSubmitted = true;
      await tick();
      this.sock.receive({ type: TYPE.JOB_ACCEPTED, job_id: msg.job_id });
    }
  }
}

let pool, server, base;
let dbAvailable = false;
try {
  pool = createPool(DATABASE_URL, { connectionTimeoutMillis: 2000 });
  await pool.query('SELECT 1');
  dbAvailable = true;
} catch { /* skipped below */ }

const skip = !dbAvailable && 'requires a reachable Postgres (see docker-compose.yml)';
let hub, app;
if (dbAvailable) {
  ({ app, hub } = createApp(pool));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
}
test.after(() => { server?.close(); pool?.end(); });

function authed(token) { return { authorization: `Bearer ${token}` }; }
async function json(res) { return res.json(); }

async function setUpConfirmedReservation(dayOffset) {
  const buyer = await json(await fetch(`${base}/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `allowlist-buyer-${crypto.randomUUID()}@test.local`,
      password: 'correct horse battery staple', display_name: 'Allowlist Buyer',
    }),
  }));
  const providerAuth = await json(await fetch(`${base}/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `allowlist-provider-${crypto.randomUUID()}@test.local`,
      password: 'correct horse battery staple', display_name: 'Allowlist Provider',
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
  const worker = new HonestWorker(node_id, kp);
  await worker.connect(hub);
  const startsAt = Date.UTC(2032, 0, dayOffset, 10, 0);
  const endsAt = startsAt + 3_600_000;
  const reserveRes = await json(await fetch(`${base}/reservations`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({ node_id, starts_at: startsAt, ends_at: endsAt }),
  }));
  await fetch(`${base}/reservations/${reserveRes.reservation_id}/confirm`, {
    method: 'POST', headers: authed(buyer.token),
  });
  return { buyer, worker, reservation_id: reserveRes.reservation_id };
}

test('a job with a disallowed image is rejected before it ever reaches the node', { skip }, async () => {
  const { buyer, worker, reservation_id } = await setUpConfirmedReservation(1);
  const res = await fetch(`${base}/reservations/${reservation_id}/jobs`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({ image: 'some-stranger/totally-safe-miner:latest', command: ['echo', 'hi'] }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /image_not_allowed/);
  assert.equal(worker.jobSubmitted, false, 'the worker must never see a disallowed image at all');
});

test('a job with an allowlisted image is accepted normally', { skip }, async () => {
  const { buyer, worker, reservation_id } = await setUpConfirmedReservation(2);
  const res = await fetch(`${base}/reservations/${reservation_id}/jobs`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({ image: 'alpine:3.20', command: ['echo', 'hi'] }),
  });
  assert.equal(res.status, 202);
  assert.equal(worker.jobSubmitted, true);
});
