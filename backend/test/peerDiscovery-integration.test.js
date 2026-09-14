// Proves rendezvous discovery is wired end-to-end through the REAL Express
// app, the real Hub, and a real Postgres-backed verification pairing --
// not just that Hub#introducePeers works in isolation (peerDiscovery.test.js
// already covers that). Uses the same FakeSocket/ScriptedWorker pattern as
// dispute-resolution.test.js and verification-flow.test.js.
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
  constructor(onSend) { super(); this._onSend = onSend; this.closed = null; }
  send(raw) { const msg = JSON.parse(raw); this._onSend?.(msg); }
  close(code, reason) { this.closed = { code, reason }; this.emit('close'); }
  receive(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
}

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { raw, sign: (buf) => crypto.sign(null, buf, privateKey) };
}

const tick = () => new Promise((r) => setImmediate(r));

class ScriptedWorker {
  constructor(nodeId, kp) {
    this.nodeId = nodeId;
    this.kp = kp;
    this.sock = new FakeSocket((msg) => this._onHubMessage(msg));
    this.received = [];
  }

  _awaitMessage(predicate) {
    return new Promise((resolve) => {
      this._waiters ??= [];
      this._waiters.push({ predicate, resolve });
    });
  }

  async connect(hub, { remoteAddress = null, peerPort = null } = {}) {
    const challengeReceived = this._awaitMessage((m) => m.type === TYPE.CHALLENGE);
    hub.handleConnection(this.sock, { remoteAddress });
    this.sock.receive({ type: TYPE.HELLO, node_id: this.nodeId });
    const challenge = await challengeReceived;
    const sig = this.kp.sign(Buffer.from(challenge.nonce, 'utf8'));
    const welcomed = this._awaitMessage((m) => m.type === TYPE.WELCOME);
    this.sock.receive({ type: TYPE.CHALLENGE_RESPONSE, signature_hex: sig.toString('hex') });
    await welcomed;
    if (peerPort !== null) this.sock.receive({ type: TYPE.PEER_ADDR, peer_port: peerPort });
    await tick();
  }

  scriptResult(result) { this._scriptedResult = result; }

  async _onHubMessage(msg) {
    this.received.push(msg);
    if (this._waiters?.length) {
      this._waiters = this._waiters.filter(({ predicate, resolve }) => {
        if (predicate(msg)) { resolve(msg); return false; }
        return true;
      });
    }
    if (msg.type === TYPE.CHALLENGE || msg.type === TYPE.WELCOME || msg.type === TYPE.PEER_INFO) return;
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
      await new Promise((resolve) => setTimeout(resolve, 50));
      this.sock.receive({
        type: TYPE.JOB_RESULT, job_id: msg.job_id,
        duration_seconds: 1, ...this._scriptedResult,
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

// Drains the scripted job results (settlement, dispute money) before the
// test ends -- otherwise they land after test.after() has torn down the
// pool, logging harmless-but-noisy "pool after end" errors that would
// otherwise pollute every subsequent test file's output for no reason.
async function waitForTerminalStatus(reservationId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query('SELECT status FROM reservations WHERE reservation_id=$1', [reservationId]);
    if (rows[0] && rows[0].status !== 'running') return rows[0].status;
    await tick();
  }
  throw new Error(`reservation ${reservationId} did not reach a terminal status within ${timeoutMs}ms`);
}

async function signupBuyer() {
  return json(await fetch(`${base}/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `peer-buyer-${crypto.randomUUID()}@test.local`,
      password: 'correct horse battery staple', display_name: 'Peer Buyer',
    }),
  }));
}

async function setUpConfirmedReservation(buyerToken, dayOffset, connectOpts) {
  const providerAuth = await json(await fetch(`${base}/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `peer-provider-${crypto.randomUUID()}@test.local`,
      password: 'correct horse battery staple', display_name: 'Peer Provider',
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
  const worker = new ScriptedWorker(node_id, kp);
  await worker.connect(hub, connectOpts);

  const startsAt = Date.UTC(2031, 0, dayOffset, 10, 0);
  const endsAt = startsAt + 3_600_000;
  const reserveRes = await json(await fetch(`${base}/reservations`, {
    method: 'POST', headers: { ...authed(buyerToken), 'content-type': 'application/json' },
    body: JSON.stringify({ node_id, starts_at: startsAt, ends_at: endsAt }),
  }));
  await fetch(`${base}/reservations/${reserveRes.reservation_id}/confirm`, {
    method: 'POST', headers: authed(buyerToken),
  });
  return { worker, kp, node_id, reservation_id: reserveRes.reservation_id };
}

test('a real verification pairing introduces both real sockets to each other',
  { skip }, async () => {
    const buyer = await signupBuyer();
    const a = await setUpConfirmedReservation(buyer.token, 1, { remoteAddress: '198.51.100.10', peerPort: 41000 });
    const b = await setUpConfirmedReservation(buyer.token, 2, { remoteAddress: '198.51.100.20', peerPort: 42000 });
    a.worker.scriptResult({ status: 'succeeded', exit_code: 0, stdout: 'x\n', stderr: '' });
    b.worker.scriptResult({ status: 'succeeded', exit_code: 0, stdout: 'x\n', stderr: '' });

    await fetch(`${base}/reservations/${a.reservation_id}/jobs`, {
      method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
      body: JSON.stringify({
        image: 'alpine:3.20', command: ['echo', 'x'],
        verify_against_reservation_id: b.reservation_id,
      }),
    });
    await tick();

    const infoAtA = a.worker.received.find((m) => m.type === TYPE.PEER_INFO);
    const infoAtB = b.worker.received.find((m) => m.type === TYPE.PEER_INFO);
    assert.ok(infoAtA, 'node a was never introduced to its verification sibling');
    assert.ok(infoAtB, 'node b was never introduced to its verification sibling');

    assert.equal(infoAtA.node_id, b.node_id);
    assert.equal(infoAtA.public_key_hex, b.kp.raw.toString('hex'));
    assert.equal(infoAtA.host, '198.51.100.20');
    assert.equal(infoAtA.port, 42000);

    assert.equal(infoAtB.node_id, a.node_id);
    assert.equal(infoAtB.host, '198.51.100.10');
    assert.equal(infoAtB.port, 41000);

    await waitForTerminalStatus(a.reservation_id);
    await waitForTerminalStatus(b.reservation_id);
  });

test('a node submitting a job with no verification partner is never introduced to anyone',
  { skip }, async () => {
    const buyer = await signupBuyer();
    const a = await setUpConfirmedReservation(buyer.token, 3, { remoteAddress: '198.51.100.30', peerPort: 43000 });
    a.worker.scriptResult({ status: 'succeeded', exit_code: 0, stdout: 'x\n', stderr: '' });

    await fetch(`${base}/reservations/${a.reservation_id}/jobs`, {
      method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
      body: JSON.stringify({ image: 'alpine:3.20', command: ['echo', 'x'] }),
    });
    await tick();

    assert.equal(a.worker.received.some((m) => m.type === TYPE.PEER_INFO), false);
    await waitForTerminalStatus(a.reservation_id);
  });
