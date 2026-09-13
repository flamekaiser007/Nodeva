// GET /reservations/:id -- added specifically so a client can poll whether
// a reservation reached 'disputed' (a job's own status doesn't tell you
// that; see jobRowStatusToOutcome's comment on why the two vocabularies
// diverge). Exercised through the real app and a real Hub, same pattern as
// verification-flow.test.js, kept minimal since this route has no side
// effects to verify beyond ownership and status visibility.
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
      await tick();
      this.sock.receive({ type: TYPE.JOB_ACCEPTED, job_id: msg.job_id });
      await new Promise((resolve) => setTimeout(resolve, 50)); // see verification-flow.test.js's identical comment
      this.sock.receive({
        type: TYPE.JOB_RESULT, job_id: msg.job_id, duration_seconds: 1,
        status: 'succeeded', exit_code: 0, stdout: 'ok\n', stderr: '',
      });
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

async function signup(prefix) {
  return json(await fetch(`${base}/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `${prefix}-${crypto.randomUUID()}@test.local`,
      password: 'correct horse battery staple', display_name: prefix,
    }),
  }));
}

async function enrollNodeAndReserve(buyerToken, dayOffset) {
  const providerAuth = await signup('reservation-read-provider');
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
  const startsAt = Date.UTC(2031, 0, dayOffset, 10, 0);
  const endsAt = startsAt + 3_600_000;
  const reserveRes = await json(await fetch(`${base}/reservations`, {
    method: 'POST', headers: { ...authed(buyerToken), 'content-type': 'application/json' },
    body: JSON.stringify({ node_id, starts_at: startsAt, ends_at: endsAt }),
  }));
  return reserveRes.reservation_id;
}

test('the owner can read their own reservation and sees its status change on confirm', { skip }, async () => {
  const buyer = await signup('reservation-read-buyer');
  const reservationId = await enrollNodeAndReserve(buyer.token, 1);

  const held = await json(await fetch(`${base}/reservations/${reservationId}`, { headers: authed(buyer.token) }));
  assert.equal(held.status, 'held');
  assert.equal(held.reservation_id, reservationId);

  await fetch(`${base}/reservations/${reservationId}/confirm`, { method: 'POST', headers: authed(buyer.token) });
  const confirmed = await json(await fetch(`${base}/reservations/${reservationId}`, { headers: authed(buyer.token) }));
  assert.equal(confirmed.status, 'confirmed');
});

test('a reservation belonging to someone else 404s, not 403 -- do not confirm the id exists', { skip }, async () => {
  const buyer = await signup('reservation-read-buyer');
  const otherUser = await signup('reservation-read-other');
  const reservationId = await enrollNodeAndReserve(buyer.token, 2);

  const res = await fetch(`${base}/reservations/${reservationId}`, { headers: authed(otherUser.token) });
  assert.equal(res.status, 404);
});

test('an unknown reservation id 404s', { skip }, async () => {
  const buyer = await signup('reservation-read-buyer');
  const res = await fetch(`${base}/reservations/${crypto.randomUUID()}`, { headers: authed(buyer.token) });
  assert.equal(res.status, 404);
});

test('a reservation with no job yet reports job: null', { skip }, async () => {
  const buyer = await signup('reservation-read-buyer');
  const reservationId = await enrollNodeAndReserve(buyer.token, 4);
  const held = await json(await fetch(`${base}/reservations/${reservationId}`, { headers: authed(buyer.token) }));
  assert.equal(held.job, null);
});

test('a reservation with a job includes it -- the job_id a client would otherwise lose on remount', { skip }, async () => {
  const buyer = await signup('reservation-read-buyer');
  const reservationId = await enrollNodeAndReserve(buyer.token, 5);
  await fetch(`${base}/reservations/${reservationId}/confirm`, { method: 'POST', headers: authed(buyer.token) });
  const submitRes = await json(await fetch(`${base}/reservations/${reservationId}/jobs`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({ image: 'alpine:3.20', command: ['echo', 'ok'] }),
  }));

  const deadline = Date.now() + 3000;
  let withJob;
  while (Date.now() < deadline) {
    withJob = await json(await fetch(`${base}/reservations/${reservationId}`, { headers: authed(buyer.token) }));
    if (withJob.job) break;
    await tick();
  }
  assert.ok(withJob.job, 'expected the job to appear on the reservation');
  assert.equal(withJob.job.job_id, submitRes.job_id);
  assert.equal(withJob.job.reservation_id, reservationId);
});

test('an unauthenticated request is rejected', { skip }, async () => {
  const buyer = await signup('reservation-read-buyer');
  const reservationId = await enrollNodeAndReserve(buyer.token, 3);
  const res = await fetch(`${base}/reservations/${reservationId}`);
  assert.equal(res.status, 401);
});
