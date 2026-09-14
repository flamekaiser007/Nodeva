// Rendezvous-style P2P discovery groundwork (ws/hub.js#introducePeers):
// proves the platform can hand two online nodes each other's identity and a
// dialable address WITHOUT relaying their traffic, and that it degrades to a
// no-op (never throws, never sends something undialable) whenever either
// side hasn't opted in. What this does NOT prove -- deliberately out of
// scope here -- is that the resulting connection survives a real NAT; see
// docs/reservation-protocol.md's "what is NOT solved yet" for that gap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { Hub } from '../src/ws/hub.js';
import { TYPE, decodeEnvelope } from '../src/ws/protocol.js';

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

async function authed(hub, nodeId, kp, { remoteAddress = '203.0.113.1' } = {}) {
  const sock = new FakeSocket();
  hub.handleConnection(sock, { remoteAddress });
  sock.receive({ type: TYPE.HELLO, node_id: nodeId });
  await tick();
  const challenge = sock.lastSent();
  const sig = kp.sign(Buffer.from(challenge.nonce, 'utf8'));
  sock.receive({ type: TYPE.CHALLENGE_RESPONSE, signature_hex: sig.toString('hex') });
  await tick();
  return sock;
}

function hubWith(keys) {
  return new Hub({ lookupPublicKey: async (id) => keys.get(id) ?? null });
}

test('two nodes that both advertised a peer port are introduced to each other', async () => {
  const kpA = keypair(); const kpB = keypair();
  const hub = hubWith(new Map([['a', kpA.raw], ['b', kpB.raw]]));
  const sockA = await authed(hub, 'a', kpA, { remoteAddress: '203.0.113.10' });
  const sockB = await authed(hub, 'b', kpB, { remoteAddress: '203.0.113.20' });
  sockA.receive({ type: TYPE.PEER_ADDR, peer_port: 41000 });
  sockB.receive({ type: TYPE.PEER_ADDR, peer_port: 42000 });
  await tick();

  const result = hub.introducePeers('a', 'b');
  assert.deepEqual(result, { a: true, b: true });

  const infoForA = sockA.lastSent();
  assert.equal(infoForA.type, TYPE.PEER_INFO);
  assert.equal(infoForA.node_id, 'b');
  assert.equal(infoForA.public_key_hex, kpB.raw.toString('hex'));
  // host comes from the platform's OWN observation of b's socket, not
  // anything b claimed about itself.
  assert.equal(infoForA.host, '203.0.113.20');
  assert.equal(infoForA.port, 42000);

  const infoForB = sockB.lastSent();
  assert.equal(infoForB.node_id, 'a');
  assert.equal(infoForB.host, '203.0.113.10');
  assert.equal(infoForB.port, 41000);
});

test('a node that never sent PEER_ADDR is not introduced (nothing dialable to hand out)', async () => {
  const kpA = keypair(); const kpB = keypair();
  const hub = hubWith(new Map([['a', kpA.raw], ['b', kpB.raw]]));
  const sockA = await authed(hub, 'a', kpA);
  const sockB = await authed(hub, 'b', kpB);
  sockA.receive({ type: TYPE.PEER_ADDR, peer_port: 41000 });
  await tick(); // only a advertised a port

  const result = hub.introducePeers('a', 'b');
  // b has no port -> a is never told about b. a DOES have a port, so b is
  // told about a -- b just can't reciprocate.
  assert.deepEqual(result, { a: false, b: true });
  assert.equal(sockA.sent.some((m) => m.type === TYPE.PEER_INFO), false);
  assert.equal(sockB.lastSent().type, TYPE.PEER_INFO);
});

test('neither side advertised a port: silent no-op, no PEER_INFO sent at all', async () => {
  const kpA = keypair(); const kpB = keypair();
  const hub = hubWith(new Map([['a', kpA.raw], ['b', kpB.raw]]));
  const sockA = await authed(hub, 'a', kpA);
  const sockB = await authed(hub, 'b', kpB);

  const result = hub.introducePeers('a', 'b');
  assert.deepEqual(result, { a: false, b: false });
  assert.equal(sockA.sent.some((m) => m.type === TYPE.PEER_INFO), false);
  assert.equal(sockB.sent.some((m) => m.type === TYPE.PEER_INFO), false);
});

test('introducing a node that is offline is a no-op, not a throw', async () => {
  const kpA = keypair(); const kpB = keypair();
  const hub = hubWith(new Map([['a', kpA.raw], ['b', kpB.raw]]));
  const sockA = await authed(hub, 'a', kpA);
  sockA.receive({ type: TYPE.PEER_ADDR, peer_port: 41000 });
  await tick();

  assert.doesNotThrow(() => hub.introducePeers('a', 'b'));
  const result = hub.introducePeers('a', 'ghost-node-never-connected');
  assert.deepEqual(result, { a: false, b: false });
});

test('a bogus (non-integer) advertised port is dropped, not forwarded as-is', async () => {
  const kpA = keypair(); const kpB = keypair();
  const hub = hubWith(new Map([['a', kpA.raw], ['b', kpB.raw]]));
  const sockA = await authed(hub, 'a', kpA);
  const sockB = await authed(hub, 'b', kpB);
  sockA.receive({ type: TYPE.PEER_ADDR, peer_port: 'not-a-port' });
  sockB.receive({ type: TYPE.PEER_ADDR, peer_port: 41000 });
  await tick();

  const result = hub.introducePeers('a', 'b');
  assert.deepEqual(result, { a: true, b: false });
});
