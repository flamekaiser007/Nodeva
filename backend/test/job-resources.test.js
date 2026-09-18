// A reserved node's advertised ram_mb/cpu_cores must actually reach the
// worker that runs the container. ws-hub.test.js proves the Hub forwards
// whatever it is handed; this proves POST /reservations/:id/jobs actually
// LOOKS THEM UP for the reserved node and hands them over -- through the
// real app, a real Hub, and real Postgres rows, same pattern as
// imageAllowlist-integration.test.js.
//
// The bug this exists to prevent: submitJob originally sent no limits at
// all, so every job on every node ran at the worker's JobSpec defaults of
// 2048MB and 2 cores. /search filters on ram_mb/cpu_cores and the booking
// is priced from them, so the marketplace was selling numbers it never
// delivered -- a buyer renting a 32GB/16-core machine got 2GB/2 cores.
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
  send(raw) { this._onSend?.(JSON.parse(raw)); }
  close() { this.emit('close'); }
  receive(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
}

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { raw, sign: (buf) => crypto.sign(null, buf, privateKey) };
}

class HonestWorker {
  constructor(nodeId, kp) {
    this.nodeId = nodeId;
    this.kp = kp;
    this.sock = new FakeSocket((msg) => this._onHubMessage(msg));
    this.jobSubmit = null; // the JOB_SUBMIT message, verbatim
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
    if (msg.type === TYPE.RESERVE_REQUEST) {
      const body = {
        reservation_id: msg.reservation_id, node_id: this.nodeId,
        starts_at: msg.starts_at, ends_at: msg.ends_at,
        price_paise_hr: msg.price_paise_hr,
        hold_expires_at: Date.now() + 120_000, issued_at: Date.now(),
      };
      this.sock.receive({
        type: TYPE.RECEIPT, reservation_id: msg.reservation_id,
        body, signature_hex: this.kp.sign(encode(body)).toString('hex'),
      });
      return;
    }
    if (msg.type === TYPE.RESERVE_COMMIT) {
      this.sock.receive({ type: TYPE.COMMITTED, reservation_id: msg.reservation_id });
      return;
    }
    if (msg.type === TYPE.JOB_SUBMIT) {
      this.jobSubmit = msg;
      this.sock.receive({ type: TYPE.JOB_ACCEPTED, job_id: msg.job_id });
    }
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

async function signUp(label) {
  return json(await fetch(`${base}/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `jobres-${label}-${crypto.randomUUID()}@test.local`,
      password: 'correct horse battery staple', display_name: `Job Res ${label}`,
    }),
  }));
}

/** Enrolls a node with the given specs and books+confirms an hour on it. */
async function setUpConfirmedReservation({ dayOffset, cpuCores, ramMb }) {
  const buyer = await signUp('buyer');
  const providerAuth = await signUp('provider');
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(providerAuth.token) });

  const kp = keypair();
  const { node_id } = await json(await fetch(`${base}/nodes`, {
    method: 'POST', headers: { ...authed(providerAuth.token), 'content-type': 'application/json' },
    body: JSON.stringify({
      public_key_hex: kp.raw.toString('hex'), gpu_model: 'RTX 4090',
      gpu_vram_mb: 24576, cpu_cores: cpuCores, ram_mb: ramMb, price_paise_hr: 4300,
    }),
  }));

  const worker = new HonestWorker(node_id, kp);
  await worker.connect(hub);

  const startsAt = Date.UTC(2033, 0, dayOffset, 10, 0);
  const reserveRes = await json(await fetch(`${base}/reservations`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({ node_id, starts_at: startsAt, ends_at: startsAt + 3_600_000 }),
  }));
  await fetch(`${base}/reservations/${reserveRes.reservation_id}/confirm`, {
    method: 'POST', headers: authed(buyer.token),
  });
  return { buyer, worker, reservation_id: reserveRes.reservation_id };
}

async function submitJob(buyer, reservationId) {
  return fetch(`${base}/reservations/${reservationId}/jobs`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({ image: 'alpine:3.20', command: ['echo', 'hi'] }),
  });
}

test('a job carries the reserved node\'s own advertised RAM and CPU limits', { skip }, async () => {
  const { buyer, worker, reservation_id } = await setUpConfirmedReservation({
    dayOffset: 1, cpuCores: 16, ramMb: 32768,
  });

  const res = await submitJob(buyer, reservation_id);
  assert.equal(res.status, 202);

  assert.ok(worker.jobSubmit, 'the node must actually have received the job');
  assert.equal(worker.jobSubmit.memory_mb, 32768, 'must be the node\'s enrolled ram_mb');
  assert.equal(worker.jobSubmit.cpus, 16, 'must be the node\'s enrolled cpu_cores');
});

test('a differently specced node gets its OWN limits, not a shared constant', { skip }, async () => {
  // The regression that would otherwise hide here: any hardcoded value
  // passes the test above on its own. Two nodes with different specs must
  // produce two different limits.
  const { buyer, worker, reservation_id } = await setUpConfirmedReservation({
    dayOffset: 2, cpuCores: 4, ramMb: 8192,
  });

  const res = await submitJob(buyer, reservation_id);
  assert.equal(res.status, 202);

  assert.equal(worker.jobSubmit.memory_mb, 8192);
  assert.equal(worker.jobSubmit.cpus, 4);
});
