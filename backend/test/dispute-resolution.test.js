// Third-node fault attribution (docs/security-model.md's Direction 2,
// "real fault attribution needs a third node") exercised through the REAL
// Express app AND the real Hub, using three scripted fake worker sockets
// that behave exactly like real nodes -- the same FakeSocket/ScriptedWorker
// approach verification-flow.test.js uses for the 2-node case, extended to
// a third node so the majority-vote logic in resolveDisputeTiebreaker runs
// for real against real Postgres, not a stand-in.
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

  scriptResult(result) { this._scriptedResult = result; }

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
      // See verification-flow.test.js's identical comment: a real timer,
      // not more microtask ticks, is what actually waits long enough for
      // the endpoint's own awaited INSERT/UPDATE to land before JOB_RESULT
      // arrives for a job_id that doesn't exist in the DB yet.
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

async function signupBuyer() {
  return json(await fetch(`${base}/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `dispute-buyer-${crypto.randomUUID()}@test.local`,
      password: 'correct horse battery staple', display_name: 'Dispute Buyer',
    }),
  }));
}

// One provider + one node + one confirmed reservation for `dayOffset` days
// into a fixed future month -- distinct days keep every node's booking
// window from colliding with another test's.
async function setUpConfirmedReservation(buyerToken, dayOffset) {
  const providerAuth = await json(await fetch(`${base}/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `dispute-provider-${crypto.randomUUID()}@test.local`,
      password: 'correct horse battery staple', display_name: 'Dispute Provider',
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

  const startsAt = Date.UTC(2030, 0, dayOffset, 10, 0);
  const endsAt = startsAt + 3_600_000;
  const reserveRes = await json(await fetch(`${base}/reservations`, {
    method: 'POST', headers: { ...authed(buyerToken), 'content-type': 'application/json' },
    body: JSON.stringify({ node_id, starts_at: startsAt, ends_at: endsAt }),
  }));
  await fetch(`${base}/reservations/${reserveRes.reservation_id}/confirm`, {
    method: 'POST', headers: authed(buyerToken),
  });
  return { worker, node_id, reservation_id: reserveRes.reservation_id, providerToken: providerAuth.token };
}

// A second, independent booking against an ALREADY-ENROLLED node -- used to
// prove the tiebreak endpoint rejects a same-node candidate for being the
// same node, not merely for being unconfirmed (a disputed reservation on
// that node is both, which would leave the specific rejection reason untested).
async function bookAndConfirm(buyerToken, nodeId, dayOffset) {
  const startsAt = Date.UTC(2030, 0, dayOffset, 10, 0);
  const endsAt = startsAt + 3_600_000;
  const reserveRes = await json(await fetch(`${base}/reservations`, {
    method: 'POST', headers: { ...authed(buyerToken), 'content-type': 'application/json' },
    body: JSON.stringify({ node_id: nodeId, starts_at: startsAt, ends_at: endsAt }),
  }));
  await fetch(`${base}/reservations/${reserveRes.reservation_id}/confirm`, {
    method: 'POST', headers: authed(buyerToken),
  });
  return reserveRes.reservation_id;
}

async function providerIdForNode(nodeId) {
  return (await pool.query(
    'SELECT provider_id FROM compute_nodes WHERE node_id=$1', [nodeId])).rows[0].provider_id;
}

async function waitForTerminalStatus(reservationId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query('SELECT status FROM reservations WHERE reservation_id=$1', [reservationId]);
    if (rows[0] && rows[0].status !== 'running') return rows[0].status;
    await tick();
  }
  throw new Error(`reservation ${reservationId} did not reach a terminal status within ${timeoutMs}ms`);
}

async function waitForResolution(groupId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await pool.query(
      'SELECT * FROM dispute_resolutions WHERE verification_group_id=$1', [groupId]);
    if (rows[0]) return rows[0];
    await tick();
  }
  throw new Error(`no dispute_resolutions row for group ${groupId} within ${timeoutMs}ms`);
}

async function disputeTwoNodes(buyer, dayBase) {
  const a = await setUpConfirmedReservation(buyer.token, dayBase);
  const b = await setUpConfirmedReservation(buyer.token, dayBase + 1);
  a.worker.scriptResult({ status: 'succeeded', exit_code: 0, stdout: 'REAL OUTPUT\n', stderr: '' });
  b.worker.scriptResult({ status: 'succeeded', exit_code: 0, stdout: 'FABRICATED OUTPUT\n', stderr: '' });

  const submitRes = await json(await fetch(`${base}/reservations/${a.reservation_id}/jobs`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({
      image: 'alpine:3.20', command: ['echo', 'hello'],
      verify_against_reservation_id: b.reservation_id,
    }),
  }));
  await waitForTerminalStatus(a.reservation_id);
  await waitForTerminalStatus(b.reservation_id);

  const { rows } = await pool.query(
    'SELECT verification_group_id FROM jobs WHERE job_id = $1', [submitRes.job_id]);
  return { a, b, groupId: rows[0].verification_group_id };
}

test('a tiebreaker agreeing with one node vindicates it and attributes fault to the other',
  { skip }, async () => {
    const buyer = await signupBuyer();
    const { a, b, groupId } = await disputeTwoNodes(buyer, 1);
    const c = await setUpConfirmedReservation(buyer.token, 3);
    c.worker.scriptResult({ status: 'succeeded', exit_code: 0, stdout: 'REAL OUTPUT\n', stderr: '' });

    const beforeA = await pool.query(
      'SELECT rep_jobs_total, rep_jobs_failed FROM providers WHERE provider_id=$1', [await providerIdForNode(a.node_id)]);

    const tbRes = await fetch(`${base}/verification-groups/${groupId}/tiebreak`, {
      method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
      body: JSON.stringify({ reservation_id: c.reservation_id }),
    });
    assert.equal(tbRes.status, 202);

    assert.equal(await waitForTerminalStatus(c.reservation_id), 'completed',
      'the tiebreaker reservation settles normally on its own outcome');

    const resolution = await waitForResolution(groupId);
    assert.equal(resolution.verdict, 'attributed');
    assert.equal(resolution.vindicated_reservation_id, a.reservation_id);
    assert.equal(resolution.at_fault_reservation_id, b.reservation_id);

    const afterA = await pool.query(
      'SELECT rep_jobs_total, rep_jobs_failed FROM providers WHERE provider_id=$1', [await providerIdForNode(a.node_id)]);
    assert.deepEqual(afterA.rows[0], beforeA.rows[0], 'the vindicated node is not touched -- it was never charged with anything');

    const afterB = await pool.query(
      'SELECT rep_jobs_total, rep_jobs_failed FROM providers WHERE provider_id=$1', [await providerIdForNode(b.node_id)]);
    assert.equal(afterB.rows[0].rep_jobs_total, 1);
    assert.equal(afterB.rows[0].rep_jobs_failed, 1, 'the at-fault node takes a real reputation failure');

    // Money for the original dispute must not be re-litigated -- both
    // reservations stay in their already-refunded DISPUTED state.
    const stillDisputed = await pool.query(
      'SELECT status FROM reservations WHERE reservation_id IN ($1,$2)', [a.reservation_id, b.reservation_id]);
    assert.ok(stillDisputed.rows.every((r) => r.status === 'disputed'));
  });

test('a tiebreaker agreeing with neither node is inconclusive -- nothing is attributed',
  { skip }, async () => {
    const buyer = await signupBuyer();
    const { a, b, groupId } = await disputeTwoNodes(buyer, 10);
    const c = await setUpConfirmedReservation(buyer.token, 12);
    c.worker.scriptResult({ status: 'succeeded', exit_code: 0, stdout: 'A THIRD, DIFFERENT OUTPUT\n', stderr: '' });

    const providerAId = await providerIdForNode(a.node_id);
    const providerBId = await providerIdForNode(b.node_id);
    const before = await pool.query(
      'SELECT provider_id, rep_jobs_total, rep_jobs_failed FROM providers WHERE provider_id IN ($1,$2)',
      [providerAId, providerBId]);

    await fetch(`${base}/verification-groups/${groupId}/tiebreak`, {
      method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
      body: JSON.stringify({ reservation_id: c.reservation_id }),
    });
    await waitForTerminalStatus(c.reservation_id);
    const resolution = await waitForResolution(groupId);
    assert.equal(resolution.verdict, 'inconclusive');
    assert.equal(resolution.vindicated_reservation_id, null);
    assert.equal(resolution.at_fault_reservation_id, null);

    const after = await pool.query(
      'SELECT provider_id, rep_jobs_total, rep_jobs_failed FROM providers WHERE provider_id IN ($1,$2)',
      [providerAId, providerBId]);
    assert.deepEqual(
      after.rows.sort((x, y) => x.provider_id.localeCompare(y.provider_id)),
      before.rows.sort((x, y) => x.provider_id.localeCompare(y.provider_id)),
      'a three-way disagreement must not move either original node\'s reputation');
  });

test('tiebreak is refused on a group that never disputed (a plain match)', { skip }, async () => {
  const buyer = await signupBuyer();
  const a = await setUpConfirmedReservation(buyer.token, 20);
  const b = await setUpConfirmedReservation(buyer.token, 21);
  a.worker.scriptResult({ status: 'succeeded', exit_code: 0, stdout: 'same\n', stderr: '' });
  b.worker.scriptResult({ status: 'succeeded', exit_code: 0, stdout: 'same\n', stderr: '' });
  const submitRes = await json(await fetch(`${base}/reservations/${a.reservation_id}/jobs`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({
      image: 'x', command: ['x'], verify_against_reservation_id: b.reservation_id,
    }),
  }));
  await waitForTerminalStatus(a.reservation_id);
  const { rows } = await pool.query(
    'SELECT verification_group_id FROM jobs WHERE job_id = $1', [submitRes.job_id]);
  const groupId = rows[0].verification_group_id;

  const c = await setUpConfirmedReservation(buyer.token, 22);
  const res = await fetch(`${base}/verification-groups/${groupId}/tiebreak`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({ reservation_id: c.reservation_id }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'verification_group_not_disputed');
});

test('tiebreak is refused against one of the two disputing nodes', { skip }, async () => {
  const buyer = await signupBuyer();
  const { a, groupId } = await disputeTwoNodes(buyer, 30);
  // A fresh, CONFIRMED reservation on the same node as `a` -- isolates the
  // "must be a third, different node" rejection from the (also true, but
  // different) "must be confirmed" rejection a re-used disputed reservation
  // would also trigger.
  const sameNodeReservationId = await bookAndConfirm(buyer.token, a.node_id, 33);
  const res = await fetch(`${base}/verification-groups/${groupId}/tiebreak`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({ reservation_id: sameNodeReservationId }),
  });
  assert.equal(res.status, 400);
});

test('a tiebreak cannot be submitted twice against the same disputed group', { skip }, async () => {
  const buyer = await signupBuyer();
  const { groupId } = await disputeTwoNodes(buyer, 40);
  const c = await setUpConfirmedReservation(buyer.token, 42);
  c.worker.scriptResult({ status: 'succeeded', exit_code: 0, stdout: 'x\n', stderr: '' });
  await fetch(`${base}/verification-groups/${groupId}/tiebreak`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({ reservation_id: c.reservation_id }),
  });
  await waitForResolution(groupId);

  const d = await setUpConfirmedReservation(buyer.token, 43);
  const res = await fetch(`${base}/verification-groups/${groupId}/tiebreak`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({ reservation_id: d.reservation_id }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'already_resolved');
});

test('GET resolution 404s before a tiebreak resolves and returns the verdict after', { skip }, async () => {
  const buyer = await signupBuyer();
  const { groupId } = await disputeTwoNodes(buyer, 50);

  const before = await fetch(`${base}/verification-groups/${groupId}/resolution`, {
    headers: authed(buyer.token),
  });
  assert.equal(before.status, 404);

  const c = await setUpConfirmedReservation(buyer.token, 52);
  c.worker.scriptResult({ status: 'succeeded', exit_code: 0, stdout: 'x\n', stderr: '' });
  await fetch(`${base}/verification-groups/${groupId}/tiebreak`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({ reservation_id: c.reservation_id }),
  });
  await waitForResolution(groupId);

  const after = await fetch(`${base}/verification-groups/${groupId}/resolution`, {
    headers: authed(buyer.token),
  });
  assert.equal(after.status, 200);
  const body = await after.json();
  assert.equal(body.verification_group_id, groupId);
});

test("a disputed reservation appears on its node's provider dashboard, unresolved until tiebroken",
  { skip }, async () => {
    const buyer = await signupBuyer();
    const { a, b, groupId } = await disputeTwoNodes(buyer, 60);

    const dashA = await json(await fetch(`${base}/providers/me/dashboard`, { headers: authed(a.providerToken) }));
    assert.equal(dashA.disputes.length, 1);
    assert.equal(dashA.disputes[0].reservation_id, a.reservation_id);
    assert.equal(dashA.disputes[0].node_id, a.node_id);
    assert.equal(dashA.disputes[0].resolution, null, 'no tiebreaker has run yet');

    const dashB = await json(await fetch(`${base}/providers/me/dashboard`, { headers: authed(b.providerToken) }));
    assert.equal(dashB.disputes.length, 1);
    assert.equal(dashB.disputes[0].reservation_id, b.reservation_id);

    const c = await setUpConfirmedReservation(buyer.token, 63);
    c.worker.scriptResult({ status: 'succeeded', exit_code: 0, stdout: 'REAL OUTPUT\n', stderr: '' });
    await fetch(`${base}/verification-groups/${groupId}/tiebreak`, {
      method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
      body: JSON.stringify({ reservation_id: c.reservation_id }),
    });
    await waitForResolution(groupId);

    const dashAAfter = await json(await fetch(`${base}/providers/me/dashboard`, { headers: authed(a.providerToken) }));
    assert.equal(dashAAfter.disputes[0].resolution.verdict, 'attributed');
    assert.equal(dashAAfter.disputes[0].resolution.outcome, 'vindicated');

    const dashBAfter = await json(await fetch(`${base}/providers/me/dashboard`, { headers: authed(b.providerToken) }));
    assert.equal(dashBAfter.disputes[0].resolution.verdict, 'attributed');
    assert.equal(dashBAfter.disputes[0].resolution.outcome, 'at_fault');
  });

test('a provider with no disputes sees an empty disputes list, not an error', { skip }, async () => {
  const clean = await json(await fetch(`${base}/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `dispute-clean-provider-${crypto.randomUUID()}@test.local`,
      password: 'correct horse battery staple', display_name: 'Clean Provider',
    }),
  }));
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(clean.token) });
  const dash = await json(await fetch(`${base}/providers/me/dashboard`, { headers: authed(clean.token) }));
  assert.deepEqual(dash.disputes, []);
});

test("an inconclusive tiebreak still shows as resolved on the provider dashboard, not stuck 'awaiting'",
  { skip }, async () => {
    // Regression test: dispute_resolutions leaves BOTH
    // vindicated_reservation_id and at_fault_reservation_id NULL for an
    // inconclusive verdict, which broke a join keyed on those columns --
    // caught live in the browser, not by the earlier (attributed-only)
    // dashboard test, since that case happens to populate both columns.
    const buyer = await signupBuyer();
    const { a, groupId } = await disputeTwoNodes(buyer, 70);
    const c = await setUpConfirmedReservation(buyer.token, 73);
    c.worker.scriptResult({ status: 'succeeded', exit_code: 0, stdout: 'NEITHER ORIGINAL OUTPUT\n', stderr: '' });
    await fetch(`${base}/verification-groups/${groupId}/tiebreak`, {
      method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
      body: JSON.stringify({ reservation_id: c.reservation_id }),
    });
    const resolution = await waitForResolution(groupId);
    assert.equal(resolution.verdict, 'inconclusive');

    const dash = await json(await fetch(`${base}/providers/me/dashboard`, { headers: authed(a.providerToken) }));
    assert.equal(dash.disputes[0].resolution.verdict, 'inconclusive',
      'the dashboard must reflect the resolution, not report it as still pending');
    assert.equal(dash.disputes[0].resolution.outcome, null);
  });
