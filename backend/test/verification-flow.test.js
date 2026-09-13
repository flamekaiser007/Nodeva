// Result verification (duplicate execution) exercised through the REAL
// Express app AND the real Hub -- not a mocked hub -- using two scripted
// fake worker sockets that behave exactly like real nodes: they answer
// RESERVE_REQUEST with a genuinely signed receipt (the same canonical
// encoder and Ed25519 math the real worker uses), accept RESERVE_COMMIT,
// accept JOB_SUBMIT, and emit a scripted JOB_RESULT. This is the same
// FakeSocket approach ws-hub.test.js uses for the hub in isolation, now
// driving the full HTTP flow so the verification-group settlement logic in
// server.js runs for real, not against a stand-in.
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

// A fake worker that behaves like a real, honest node up through commit,
// then emits whatever JOB_RESULT the test scripts for it -- this is the
// hook that lets a test simulate two nodes agreeing or disagreeing.
class ScriptedWorker {
  constructor(nodeId, kp) {
    this.nodeId = nodeId;
    this.kp = kp;
    this.sock = new FakeSocket((msg) => this._onHubMessage(msg));
  }

  // real Postgres I/O sits behind lookupPublicKey (unlike ws-hub.test.js's
  // fake, which resolves instantly) -- waiting a fixed number of
  // setImmediate ticks assumes synchronous resolution and is exactly the
  // kind of timing bug that looks fine until the underlying call is
  // genuinely async. Wait on a real promise that resolves when the
  // expected message actually arrives instead of guessing how many ticks
  // that takes.
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

  scriptResult(forJobImage, result) {
    // Keyed by image+command isn't unique enough across two separate jobs in
    // a group (both get the SAME image/command by design) -- instead this
    // stores ONE result to use for whichever job_id this worker is asked to
    // run next, since each ScriptedWorker instance only ever runs one job
    // in these tests.
    this._scriptedResult = result;
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
      // A real race, caught here rather than assumed away: once hub.submitJob
      // resolves on JOB_ACCEPTED, the endpoint handler still has two AWAITED
      // Postgres round trips left (INSERT INTO jobs, then UPDATE reservations)
      // before that job_id actually exists in the database. A real Docker job
      // takes real seconds to run, so this race never happens outside a test
      // that fires JOB_RESULT deliberately fast -- but setImmediate ticks are
      // microtask-scheduling, not wall-clock time, and were not reliably
      // enough of it: the very first run of this test hit "JOB_RESULT for
      // unknown job" because the row genuinely did not exist yet. A short
      // real timer, not more ticks, is what actually waits long enough for
      // local Postgres I/O to finish.
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

async function setUpTwoConfirmedReservations(buyerToken, imageAndCommand) {
  // Two independent providers, two independent nodes, two independent
  // reservations for the SAME time window -- the shape verification
  // actually requires: two nodes that could not have colluded through a
  // shared booking.
  const results = [];
  for (const idx of [1, 2]) {
    const providerAuth = await json(await fetch(`${base}/auth/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `verify-provider-${idx}-${crypto.randomUUID()}@test.local`,
        password: 'correct horse battery staple', display_name: `Provider ${idx}`,
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
    await worker.connect(hub);

    const startsAt = Date.UTC(2029, 0, idx, 10, 0); // different day per node -> no cross-test collision
    const endsAt = startsAt + 3_600_000;
    const reserveRes = await json(await fetch(`${base}/reservations`, {
      method: 'POST', headers: { ...authed(buyerToken), 'content-type': 'application/json' },
      body: JSON.stringify({ node_id, starts_at: startsAt, ends_at: endsAt }),
    }));
    await fetch(`${base}/reservations/${reserveRes.reservation_id}/confirm`, {
      method: 'POST', headers: authed(buyerToken),
    });
    results.push({ worker, node_id, reservation_id: reserveRes.reservation_id });
  }
  void imageAndCommand;
  return results;
}

// Real Postgres I/O happens inside onJobResult -> settleReservation (and,
// for a verification group, settleVerificationGroup) after a JOB_RESULT is
// delivered -- counting a fixed number of setImmediate ticks to "wait" for
// that is the same timing mistake ScriptedWorker.connect made against
// lookupPublicKey. Poll the actual state instead of guessing how long it
// takes.
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
      email: `verify-buyer-${crypto.randomUUID()}@test.local`,
      password: 'correct horse battery staple', display_name: 'Verify Buyer',
    }),
  }));
}

test('two nodes agreeing settle both reservations normally, in full', { skip }, async () => {
  const buyer = await signupBuyer();
  const [a, b] = await setUpTwoConfirmedReservations(buyer.token);
  a.worker.scriptResult(null, { status: 'succeeded', exit_code: 0, stdout: 'hello\n', stderr: '' });
  b.worker.scriptResult(null, { status: 'succeeded', exit_code: 0, stdout: 'hello\n', stderr: '' });

  const submitRes = await json(await fetch(`${base}/reservations/${a.reservation_id}/jobs`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({
      image: 'alpine:3.20', command: ['echo', 'hello'],
      verify_against_reservation_id: b.reservation_id,
    }),
  }));
  assert.equal(submitRes.verification_degraded, false);

  assert.equal(await waitForTerminalStatus(a.reservation_id), 'completed');
  assert.equal(await waitForTerminalStatus(b.reservation_id), 'completed');
});

test('two nodes disagreeing dispute BOTH reservations and refund in full', { skip }, async () => {
  const buyer = await signupBuyer();
  const [a, b] = await setUpTwoConfirmedReservations(buyer.token);
  a.worker.scriptResult(null, { status: 'succeeded', exit_code: 0, stdout: 'REAL OUTPUT\n', stderr: '' });
  b.worker.scriptResult(null, { status: 'succeeded', exit_code: 0, stdout: 'FABRICATED OUTPUT\n', stderr: '' });

  await fetch(`${base}/reservations/${a.reservation_id}/jobs`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({
      image: 'alpine:3.20', command: ['echo', 'hello'],
      verify_against_reservation_id: b.reservation_id,
    }),
  });
  assert.equal(await waitForTerminalStatus(a.reservation_id), 'disputed');
  assert.equal(await waitForTerminalStatus(b.reservation_id), 'disputed');

  // Full refund for BOTH -- neither provider is paid when the platform
  // cannot tell which of them lied. Scoped to THIS test's own two
  // reservations (via ledger_transactions.reservation_id) rather than a
  // global SUM over the whole table -- the same test-isolation lesson
  // refunds.test.js's earlier fix already taught: this suite shares one
  // persistent, repeatedly-run dev Postgres, and a global aggregate picks
  // up every other test's rows too.
  const refundTotal = await pool.query(
    `SELECT COALESCE(SUM(e.amount_paise),0) AS total
       FROM ledger_entries e
       JOIN ledger_accounts a USING(account_id)
       JOIN ledger_transactions t ON t.txn_id = e.txn_id
      WHERE a.kind='refunds' AND t.reservation_id IN ($1,$2)`,
    [a.reservation_id, b.reservation_id]);
  assert.equal(Number(refundTotal.rows[0].total), 4300 * 2);

  const providerAId = (await pool.query(
    'SELECT provider_id FROM compute_nodes WHERE node_id=$1', [a.node_id])).rows[0].provider_id;
  const providerBId = (await pool.query(
    'SELECT provider_id FROM compute_nodes WHERE node_id=$1', [b.node_id])).rows[0].provider_id;
  const providerBalances = await pool.query(
    `SELECT COALESCE(SUM(e.amount_paise),0) AS total
       FROM ledger_entries e
       JOIN ledger_accounts a USING(account_id)
      WHERE a.kind='provider_balance' AND a.owner_provider_id IN ($1,$2)`,
    [providerAId, providerBId]);
  assert.equal(Number(providerBalances.rows[0].total), 0, 'neither provider should be paid on a dispute');
});

test('reputation is untouched for a disputed job -- fault cannot be attributed from two samples', { skip }, async () => {
  const buyer = await signupBuyer();
  const [a, b] = await setUpTwoConfirmedReservations(buyer.token);
  a.worker.scriptResult(null, { status: 'succeeded', exit_code: 0, stdout: 'X\n', stderr: '' });
  b.worker.scriptResult(null, { status: 'succeeded', exit_code: 0, stdout: 'Y\n', stderr: '' });

  const providerOf = async (nodeId) => (await pool.query(
    'SELECT provider_id FROM compute_nodes WHERE node_id=$1', [nodeId])).rows[0].provider_id;
  const beforeA = await pool.query('SELECT rep_jobs_total FROM providers WHERE provider_id=$1', [await providerOf(a.node_id)]);
  const beforeB = await pool.query('SELECT rep_jobs_total FROM providers WHERE provider_id=$1', [await providerOf(b.node_id)]);

  await fetch(`${base}/reservations/${a.reservation_id}/jobs`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({ image: 'x', command: ['x'], verify_against_reservation_id: b.reservation_id }),
  });
  await waitForTerminalStatus(a.reservation_id);

  const afterA = await pool.query('SELECT rep_jobs_total FROM providers WHERE provider_id=$1', [await providerOf(a.node_id)]);
  const afterB = await pool.query('SELECT rep_jobs_total FROM providers WHERE provider_id=$1', [await providerOf(b.node_id)]);
  assert.equal(afterA.rows[0].rep_jobs_total, beforeA.rows[0].rep_jobs_total);
  assert.equal(afterB.rows[0].rep_jobs_total, beforeB.rows[0].rep_jobs_total);
});

test('verification requires two DIFFERENT nodes -- a node cannot verify against itself', { skip }, async () => {
  const buyer = await signupBuyer();
  const [a] = await setUpTwoConfirmedReservations(buyer.token);
  const res = await fetch(`${base}/reservations/${a.reservation_id}/jobs`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({ image: 'x', command: ['x'], verify_against_reservation_id: a.reservation_id }),
  });
  assert.equal(res.status, 400);
});

test("a sibling reservation belonging to another user is rejected, not silently accepted", { skip }, async () => {
  const buyer = await signupBuyer();
  const otherBuyer = await signupBuyer();
  const [a, b] = await setUpTwoConfirmedReservations(buyer.token);
  void b;
  // Steal someone else's confirmed reservation id as the verification partner.
  const otherReservations = await setUpTwoConfirmedReservations(otherBuyer.token);
  const res = await fetch(`${base}/reservations/${a.reservation_id}/jobs`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({
      image: 'x', command: ['x'],
      verify_against_reservation_id: otherReservations[0].reservation_id,
    }),
  });
  assert.equal(res.status, 404);
});

test('a sibling submission failure degrades gracefully -- the first job still settles solo', { skip }, async () => {
  const buyer = await signupBuyer();
  const [a, b] = await setUpTwoConfirmedReservations(buyer.token);
  a.worker.scriptResult(null, { status: 'succeeded', exit_code: 0, stdout: 'solo\n', stderr: '' });
  // Disconnect B's socket right before the submission attempt -- the sibling
  // is now offline, forcing exactly the degradation path being tested.
  b.worker.sock.close(1000, 'test disconnect');
  await tick();

  const submitRes = await json(await fetch(`${base}/reservations/${a.reservation_id}/jobs`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({
      image: 'alpine:3.20', command: ['echo', 'solo'],
      verify_against_reservation_id: b.reservation_id,
    }),
  }));
  assert.equal(submitRes.verification_degraded, true);
  assert.equal(submitRes.sibling_job_id, null);

  assert.equal(await waitForTerminalStatus(a.reservation_id), 'completed',
    'the solo job must still settle normally, not hang forever');
});
