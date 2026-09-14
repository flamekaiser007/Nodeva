// Proves ws/clusterRelay.js actually does what it claims: a node connected
// to ONE Hub instance is reachable by node-facing calls made against a
// COMPLETELY SEPARATE Hub instance, as long as both are attached to the
// same real Redis (docker-compose.yml's `redis` service) -- not a mocked
// pub/sub, since the whole point is proving the relay works over the real
// transport a second backend process would actually use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import Redis from 'ioredis';
import { Hub, NodeOffline } from '../src/ws/hub.js';
import { TYPE, decodeEnvelope } from '../src/ws/protocol.js';
import { encode } from '../src/lib/canonical.js';
import { attachClusterRelay } from '../src/ws/clusterRelay.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

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
async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}

async function authed(hub, nodeId, kp) {
  const sock = new FakeSocket();
  hub.handleConnection(sock);
  sock.receive({ type: TYPE.HELLO, node_id: nodeId });
  await tick();
  const challenge = sock.lastSent();
  assert.equal(challenge.type, TYPE.CHALLENGE);
  const sig = kp.sign(Buffer.from(challenge.nonce, 'utf8'));
  sock.receive({ type: TYPE.CHALLENGE_RESPONSE, signature_hex: sig.toString('hex') });
  await tick();
  return sock;
}

// A single shared registry standing in for `compute_nodes` -- both hub
// instances need to answer the same "who owns this public key" question,
// exactly as two backend processes sharing one Postgres would.
function makeRegistry() {
  const keys = new Map();
  return {
    register: (nodeId, kp) => keys.set(nodeId, kp.raw),
    lookupPublicKey: async (nodeId) => keys.get(nodeId) ?? null,
  };
}

let redisAvailable = false;
try {
  const probe = new Redis(REDIS_URL, { lazyConnect: true, retryStrategy: () => null });
  await probe.connect();
  await probe.ping();
  await probe.quit();
  redisAvailable = true;
} catch { /* skipped below */ }
const skip = !redisAvailable && `requires a reachable Redis at ${REDIS_URL} (see docker-compose.yml)`;

// Every test gets its OWN namespace -- attachClusterRelay's channel names
// are namespaced specifically so sibling test cases (and unrelated real
// deployments sharing one Redis) can never cross-talk. Caught live: a
// shared fixed channel name across this file's own test cases produced a
// genuine, intermittent (never reproducing in isolation) race between
// sibling tests' presence broadcasts before the namespace existed.
async function makeClusteredHub(namespace, registry, onPresence) {
  const raw = new Hub({ lookupPublicKey: registry.lookupPublicKey, onPresence });
  const wrapped = attachClusterRelay(raw, {
    redisUrl: REDIS_URL, instanceId: crypto.randomUUID(), namespace,
  });
  await wrapped.ready;
  return wrapped;
}

test('a request made on one instance reaches a node connected only to another instance', { skip }, async () => {
  const ns = crypto.randomUUID();
  const registry = makeRegistry();
  const hubA = await makeClusteredHub(ns, registry, () => {});
  const hubB = await makeClusteredHub(ns, registry, () => {});
  try {
    const kp = keypair();
    registry.register('node-1', kp);
    const sockA = await authed(hubA, 'node-1', kp);

    await waitFor(() => hubB.isOnline('node-1'), { timeoutMs: 2000 });

    const requestPromise = hubB.requestReservation('node-1', {
      reservationId: 'res-1', startsAt: 0, endsAt: 3_600_000, pricePaiseHr: 4300,
    });

    await waitFor(() => sockA.lastSent()?.type === TYPE.RESERVE_REQUEST);
    const receiptBody = {
      reservation_id: 'res-1', node_id: 'node-1', starts_at: 0, ends_at: 3_600_000,
      price_paise_hr: 4300, hold_expires_at: Date.now() + 120_000, issued_at: Date.now(),
    };
    const sig = kp.sign(encode(receiptBody));
    sockA.receive({ type: TYPE.RECEIPT, reservation_id: 'res-1', body: receiptBody, signature_hex: sig.toString('hex') });

    const result = await requestPromise;
    assert.equal(result.type, TYPE.RECEIPT);
    assert.equal(result.body.reservation_id, 'res-1');
  } finally {
    await hubA.close();
    await hubB.close();
  }
});

test('isOnline reflects a node connected to a different instance', { skip }, async () => {
  const ns = crypto.randomUUID();
  const registry = makeRegistry();
  const hubA = await makeClusteredHub(ns, registry, () => {});
  const hubB = await makeClusteredHub(ns, registry, () => {});
  try {
    assert.equal(hubB.isOnline('node-2'), false);

    const kp = keypair();
    registry.register('node-2', kp);
    await authed(hubA, 'node-2', kp);

    await waitFor(() => hubB.isOnline('node-2'));
  } finally {
    await hubA.close();
    await hubB.close();
  }
});

test('disconnecting from the owning instance is reflected as offline everywhere', { skip }, async () => {
  const ns = crypto.randomUUID();
  const registry = makeRegistry();
  const hubA = await makeClusteredHub(ns, registry, () => {});
  const hubB = await makeClusteredHub(ns, registry, () => {});
  try {
    const kp = keypair();
    registry.register('node-3', kp);
    const sockA = await authed(hubA, 'node-3', kp);
    await waitFor(() => hubB.isOnline('node-3'));

    sockA.close(1000, 'test disconnect');
    await waitFor(() => !hubB.isOnline('node-3'));
  } finally {
    await hubA.close();
    await hubB.close();
  }
});

test('a request for a node online nowhere in the cluster rejects with NodeOffline', { skip }, async () => {
  const ns = crypto.randomUUID();
  const registry = makeRegistry();
  const hubB = await makeClusteredHub(ns, registry, () => {});
  try {
    await assert.rejects(
      () => hubB.requestReservation('never-connected', { reservationId: 'r', startsAt: 0, endsAt: 1, pricePaiseHr: 1 }),
      NodeOffline);
  } finally {
    await hubB.close();
  }
});

test('a newly attached instance learns about ALREADY-connected nodes via the startup snapshot', { skip }, async () => {
  const ns = crypto.randomUUID();
  const registry = makeRegistry();
  const hubA = await makeClusteredHub(ns, registry, () => {});
  try {
    const kp = keypair();
    registry.register('node-4', kp);
    await authed(hubA, 'node-4', kp);

    // hubC attaches AFTER node-4 already connected to hubA -- the
    // connect/disconnect broadcast alone would never teach hubC about it;
    // only the snapshot exchange at attach time does.
    const hubC = await makeClusteredHub(ns, registry, () => {});
    try {
      await waitFor(() => hubC.isOnline('node-4'));
    } finally {
      await hubC.close();
    }
  } finally {
    await hubA.close();
  }
});

test('with REDIS_URL unset, attachClusterRelay returns the hub completely unchanged', () => {
  const registry = makeRegistry();
  const raw = new Hub({ lookupPublicKey: registry.lookupPublicKey });
  const result = attachClusterRelay(raw, { redisUrl: undefined });
  assert.equal(result, raw, 'clustering disabled must be a true no-op, not even a thin wrapper');
});
