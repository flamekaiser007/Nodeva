import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { Hub, NodeOffline, NodeRefused, NodeTimeout } from '../src/ws/hub.js';
import { TYPE, decodeEnvelope } from '../src/ws/protocol.js';

// A fake `ws` socket good enough to drive the hub without a real network.
// Captures everything sent to it and lets the test inject inbound messages.
class FakeSocket extends EventEmitter {
  constructor() { super(); this.sent = []; this.closed = null; }
  send(raw) { this.sent.push(decodeEnvelope(raw)); }
  close(code, reason) { this.closed = { code, reason }; this.emit('close'); }
  lastSent() { return this.sent.at(-1); }
  receive(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
}

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { raw, sign: (buf) => crypto.sign(null, buf, privateKey) };
}

const tick = () => new Promise((r) => setImmediate(r));

async function authed(hub, nodeId, kp) {
  const sock = new FakeSocket();
  hub.handleConnection(sock);
  sock.receive({ type: TYPE.HELLO, node_id: nodeId });
  await tick(); // _handlePreAuth awaits lookupPublicKey before replying
  const challenge = sock.lastSent();
  assert.equal(challenge.type, TYPE.CHALLENGE);
  const sig = kp.sign(Buffer.from(challenge.nonce, 'utf8'));
  sock.receive({ type: TYPE.CHALLENGE_RESPONSE, signature_hex: sig.toString('hex') });
  await tick();
  return sock;
}

test('a node with an unregistered id is rejected before a challenge is issued', async () => {
  const hub = new Hub({ lookupPublicKey: async () => null });
  const sock = new FakeSocket();
  hub.handleConnection(sock);
  sock.receive({ type: TYPE.HELLO, node_id: 'ghost' });
  await tick();
  assert.equal(sock.lastSent().type, TYPE.REJECT);
  assert.equal(sock.closed.code, 4003);
});

test('possession of the private key is required, not just the claimed id', async () => {
  const kp = keypair();
  const attacker = keypair();
  const hub = new Hub({ lookupPublicKey: async () => kp.raw });
  const sock = new FakeSocket();
  hub.handleConnection(sock);
  sock.receive({ type: TYPE.HELLO, node_id: 'n1' });
  await tick();
  const { nonce } = sock.lastSent();
  // Attacker signs with the WRONG key.
  sock.receive({ type: TYPE.CHALLENGE_RESPONSE, signature_hex: attacker.sign(Buffer.from(nonce)).toString('hex') });
  await tick();
  assert.equal(sock.lastSent().type, TYPE.REJECT);
  assert.equal(hub.isOnline('n1'), false);
});

test('a replayed signature over a stale nonce does not authenticate a second time', async () => {
  // Not a full replay-across-sessions test (nonce is per-connection and
  // random), but pins that authentication actually depends on the nonce we
  // issued, not a fixed value — sign garbage, must fail.
  const kp = keypair();
  const hub = new Hub({ lookupPublicKey: async () => kp.raw });
  const sock = new FakeSocket();
  hub.handleConnection(sock);
  sock.receive({ type: TYPE.HELLO, node_id: 'n1' });
  await tick();
  sock.receive({ type: TYPE.CHALLENGE_RESPONSE, signature_hex: kp.sign(Buffer.from('not-the-nonce')).toString('hex') });
  await tick();
  assert.equal(sock.lastSent().type, TYPE.REJECT);
});

test('correct proof of possession authenticates and marks the node online', async () => {
  const kp = keypair();
  const hub = new Hub({ lookupPublicKey: async () => kp.raw });
  const sock = await authed(hub, 'n1', kp);
  assert.equal(sock.lastSent().type, TYPE.WELCOME);
  assert.equal(hub.isOnline('n1'), true);
});

test('a second connection for the same node id supersedes the first', async () => {
  const kp = keypair();
  const hub = new Hub({ lookupPublicKey: async () => kp.raw });
  const first = await authed(hub, 'n1', kp);
  const second = await authed(hub, 'n1', kp);
  assert.equal(first.closed.code, 4009);
  assert.equal(hub.isOnline('n1'), true);
  assert.equal(second.closed, null, 'the surviving connection is not closed');
});

test('requesting a reservation from an offline node fails fast, no hang', async () => {
  const hub = new Hub({ lookupPublicKey: async () => null });
  await assert.rejects(
    hub.requestReservation('nobody', { reservationId: 'r1', startsAt: 0, endsAt: 1, pricePaiseHr: 100 }),
    NodeOffline,
  );
});

test('a signed RECEIPT resolves requestReservation with the receipt', async () => {
  const kp = keypair();
  const hub = new Hub({ lookupPublicKey: async () => kp.raw });
  const sock = await authed(hub, 'n1', kp);

  const p = hub.requestReservation('n1', { reservationId: 'r1', startsAt: 0, endsAt: 3600000, pricePaiseHr: 4300 });
  const pushed = sock.lastSent();
  assert.equal(pushed.type, TYPE.RESERVE_REQUEST);
  assert.equal(pushed.reservation_id, 'r1');

  sock.receive({ type: TYPE.RECEIPT, reservation_id: 'r1', body: { ok: true }, signature_hex: 'ab' });
  const result = await p;
  assert.equal(result.type, TYPE.RECEIPT);
});

test('a DENY resolves to NodeRefused with the reason, not a hang or a generic error', async () => {
  const kp = keypair();
  const hub = new Hub({ lookupPublicKey: async () => kp.raw });
  const sock = await authed(hub, 'n1', kp);
  const p = hub.requestReservation('n1', { reservationId: 'r1', startsAt: 0, endsAt: 1, pricePaiseHr: 1 });
  sock.receive({ type: TYPE.DENY, reservation_id: 'r1', reason: 'slot_taken' });
  await assert.rejects(p, (e) => e instanceof NodeRefused && e.reason === 'slot_taken');
});

test('a node that never answers times out rather than hanging forever', async () => {
  const kp = keypair();
  const hub = new Hub({ lookupPublicKey: async () => kp.raw, reserveTimeoutMs: 20 });
  await authed(hub, 'n1', kp);
  await assert.rejects(
    hub.requestReservation('n1', { reservationId: 'r-timeout', startsAt: 0, endsAt: 1, pricePaiseHr: 1 }),
    NodeTimeout,
  );
});

test('a reply for an already-timed-out reservation id is ignored, not misdelivered', async () => {
  const kp = keypair();
  const hub = new Hub({ lookupPublicKey: async () => kp.raw, reserveTimeoutMs: 20 });
  const sock = await authed(hub, 'n1', kp);
  await assert.rejects(hub.requestReservation('n1', { reservationId: 'r1', startsAt: 0, endsAt: 1, pricePaiseHr: 1 }), NodeTimeout);
  // The late reply must not throw or resolve anything that no longer exists.
  assert.doesNotThrow(() => sock.receive({ type: TYPE.RECEIPT, reservation_id: 'r1', body: {}, signature_hex: '' }));
});

test('disconnecting takes the node offline and reservation requests fail fast again', async () => {
  const kp = keypair();
  const events = [];
  const hub = new Hub({ lookupPublicKey: async () => kp.raw, onPresence: (id, on) => events.push([id, on]) });
  const sock = await authed(hub, 'n1', kp);
  sock.close(1000, 'bye');
  assert.equal(hub.isOnline('n1'), false);
  assert.deepEqual(events, [['n1', true], ['n1', false]]);
  await assert.rejects(hub.requestReservation('n1', { reservationId: 'r2', startsAt: 0, endsAt: 1, pricePaiseHr: 1 }), NodeOffline);
});

test('heartbeats reset the miss counter and are forwarded', async () => {
  const kp = keypair();
  const seen = [];
  const hub = new Hub({ lookupPublicKey: async () => kp.raw, onHeartbeat: (id, hb) => seen.push([id, hb]) });
  const sock = await authed(hub, 'n1', kp);
  sock.receive({ type: TYPE.HEARTBEAT, gpu: { util: 42 } });
  assert.deepEqual(seen, [['n1', { type: TYPE.HEARTBEAT, gpu: { util: 42 } }]]);
});

test('sweepStale drops a node that misses too many heartbeats', async () => {
  const kp = keypair();
  const events = [];
  const hub = new Hub({ lookupPublicKey: async () => kp.raw, onPresence: (id, on) => events.push(on) });
  await authed(hub, 'n1', kp);
  hub.sweepStale(); hub.sweepStale(); hub.sweepStale();
  assert.equal(hub.isOnline('n1'), true, 'still within miss limit');
  hub.sweepStale();
  assert.equal(hub.isOnline('n1'), false, 'exceeded miss limit');
  assert.deepEqual(events, [true, false]);
});

test('a heartbeat in between sweeps resets the counter so the node is not dropped', async () => {
  const kp = keypair();
  const hub = new Hub({ lookupPublicKey: async () => kp.raw });
  const sock = await authed(hub, 'n1', kp);
  hub.sweepStale(); hub.sweepStale(); hub.sweepStale();
  sock.receive({ type: TYPE.HEARTBEAT });
  hub.sweepStale(); hub.sweepStale(); hub.sweepStale();
  assert.equal(hub.isOnline('n1'), true);
});

// --- reconciliation: querying and releasing a node's local reservation state ---

test('queryReservationStatus asks the node and resolves to whatever it reports', async () => {
  const kp = keypair();
  const hub = new Hub({ lookupPublicKey: async () => kp.raw });
  const sock = await authed(hub, 'n1', kp);
  const p = hub.queryReservationStatus('n1', 'r1');
  const pushed = sock.lastSent();
  assert.equal(pushed.type, TYPE.RESERVATION_STATUS_QUERY);
  assert.equal(pushed.reservation_id, 'r1');
  sock.receive({ type: TYPE.RESERVATION_STATUS, reservation_id: 'r1', status: 'confirmed' });
  assert.equal(await p, 'confirmed');
});

test('queryReservationStatus resolves to null, not a throw, when the node has never heard of the id', async () => {
  // A node correctly saying "I don't know this reservation" is a valid,
  // useful answer -- not the same thing as the node being unreachable.
  const kp = keypair();
  const hub = new Hub({ lookupPublicKey: async () => kp.raw });
  const sock = await authed(hub, 'n1', kp);
  const p = hub.queryReservationStatus('n1', 'r-unknown');
  sock.receive({ type: TYPE.RESERVATION_STATUS, reservation_id: 'r-unknown', status: null });
  assert.equal(await p, null);
});

test('queryReservationStatus rejects fast for an offline node, same as the other node-facing calls', async () => {
  const hub = new Hub({ lookupPublicKey: async () => null });
  await assert.rejects(hub.queryReservationStatus('nobody', 'r1'), NodeOffline);
});

test('queryReservationStatus times out rather than hanging if the node never answers', async () => {
  const kp = keypair();
  const hub = new Hub({ lookupPublicKey: async () => kp.raw, statusQueryTimeoutMs: 20 });
  await authed(hub, 'n1', kp);
  await assert.rejects(hub.queryReservationStatus('n1', 'r1'), NodeTimeout);
});

test('releaseReservation asks the node to give up its hold and resolves on RELEASE_ACK', async () => {
  const kp = keypair();
  const hub = new Hub({ lookupPublicKey: async () => kp.raw });
  const sock = await authed(hub, 'n1', kp);
  const p = hub.releaseReservation('n1', 'r1');
  const pushed = sock.lastSent();
  assert.equal(pushed.type, TYPE.RESERVE_RELEASE);
  assert.equal(pushed.reservation_id, 'r1');
  sock.receive({ type: TYPE.RELEASE_ACK, reservation_id: 'r1' });
  await p; // must resolve, not throw
});

test('releaseReservation rejects fast for an offline node', async () => {
  const hub = new Hub({ lookupPublicKey: async () => null });
  await assert.rejects(hub.releaseReservation('nobody', 'r1'), NodeOffline);
});
