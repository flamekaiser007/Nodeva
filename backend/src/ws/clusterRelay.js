// Makes the Hub work across MULTIPLE backend processes, not just one.
//
// THE GAP THIS CLOSES: Hub keeps every worker's live WebSocket connection
// in that one process's memory (`_nodes`, a plain Map -- see hub.js's own
// comment). A worker dials into whichever backend instance it happened to
// connect to; an HTTP request for that node can land on a SIBLING instance
// via a load balancer and find no local socket at all, even though the
// node is genuinely online -- it would see NodeOffline and the reservation
// would fail for a node that was never actually offline. rateLimit.js has
// carried the identical honest caveat ("in-memory, per-process... correct
// for the single backend instance this MVP runs, wrong the moment a second
// instance joins") since it was written; this is the Hub's version of
// closing that same gap, using the Redis this project has always shipped
// unused in docker-compose.yml for exactly this purpose.
//
// HOW IT WORKS: every instance publishes its own connect/disconnect events
// on a shared pub/sub channel, so every instance keeps a live, in-memory
// map of "which instance currently holds node X's socket" -- no per-call
// Redis round trip needed to answer isOnline(). When an instance needs to
// send a node-facing message (RESERVE_REQUEST, JOB_SUBMIT, ...) for a node
// it doesn't hold locally, it relays the request to the OWNING instance
// over a second channel, correlates the reply by a random id, and resolves
// or rejects the caller's promise exactly as if the socket were local --
// hub.js's callers (api/server.js) never need to know whether a request
// went out over a real socket or got relayed through Redis first.
//
// OFF BY DEFAULT: activated only when REDIS_URL is set (see
// createApp/index.js) -- unset, this module is never imported into the
// request path at all, and behavior is byte-identical to a bare Hub.
// Matches the same opt-in posture as ALLOW_MANUAL_SETTLEMENT, ADMIN_TOKEN,
// and image allowlist overrides: a real capability, never forced on an
// MVP that doesn't need it running as a single instance yet.
//
// A NEWLY STARTED instance would otherwise know nothing about nodes that
// connected to OTHER instances before it came up -- the connect/disconnect
// broadcast alone only teaches it about presence CHANGES from here on.
// Closed with a one-time snapshot exchange at startup: this instance asks
// "who's online", every peer replies with its own connected node list, and
// the answers are merged into the local map before anything is considered
// ready.

import crypto from 'node:crypto';
import Redis from 'ioredis';
import { NodeOffline, NodeRefused, NodeTimeout } from './hub.js';

// Namespaced (default 'nodeva') rather than fixed strings, for two
// independent reasons: a real Redis is often shared across unrelated
// deployments, where a fixed channel name would let two completely
// different NODEVA clusters cross-talk if they happened to point at the
// same Redis; and test/clusterRelay.test.js needs every test case fully
// isolated from every other -- caught live in that suite: sibling test
// cases sharing one fixed channel name raced each other's presence
// broadcasts, causing a real, intermittent (not deterministic) failure
// that only reproduced running the full file, never a single test in
// isolation, which is exactly the signature of a shared-channel race
// rather than a logic bug.
function channels(namespace) {
  return {
    presence: `${namespace}:hub:presence`,
    snapshotRequest: `${namespace}:hub:snapshot-request`,
    snapshotReply: `${namespace}:hub:snapshot-reply`,
    request: (instanceId) => `${namespace}:hub:requests:${instanceId}`,
    reply: `${namespace}:hub:replies`,
  };
}

// Every method here takes (nodeId, ...args) and is safe to relay: none of
// them touch anything outside the Hub instance itself (no closures over
// per-request Express state), so calling them on a REMOTE instance with
// the same arguments produces the same effect as calling them locally.
const RELAYABLE_METHODS = [
  'requestReservation', 'submitJob', 'commitReservation',
  'queryReservationStatus', 'releaseReservation',
];

// Reconstructs a thrown error's TYPE across the Redis boundary -- a plain
// `throw err` from the relay's message handler would only ever produce a
// generic Error on the other side, losing exactly the distinction
// (NodeOffline vs NodeRefused vs NodeTimeout) every caller in api/server.js
// already branches on.
const ERROR_CLASSES = { NodeOffline, NodeRefused, NodeTimeout };

/**
 * Wraps a real Hub so its node-facing methods transparently relay to
 * whichever backend instance actually holds the target node's socket.
 * `redisFactory` defaults to `ioredis`'s constructor but is injectable so
 * tests (and this module's own tests) never need a real Redis server for
 * the parts of this that don't specifically need one.
 */
export function attachClusterRelay(hub, {
  redisUrl, instanceId = crypto.randomUUID(), redisFactory,
  requestTimeoutMs = 5000, namespace = 'nodeva',
} = {}) {
  if (!redisUrl) return hub; // clustering disabled -- return the bare Hub, untouched

  const CH = channels(namespace);
  const makeClient = redisFactory ?? (() => new Redis(redisUrl));

  const pub = makeClient();
  const sub = makeClient();

  // nodeId -> instanceId, for every node currently online ANYWHERE in the
  // cluster (including this instance -- kept in sync with hub._nodes via
  // the same broadcast every other instance reacts to, rather than reading
  // two different sources of truth for "is this node online").
  const remoteOwner = new Map();
  const pending = new Map(); // correlationId -> { resolve, reject, timer }
  const startupSnapshotRequestId = crypto.randomUUID();

  function publish(channel, payload) {
    pub.publish(channel, JSON.stringify(payload)).catch(() => {
      // Best-effort: a lost presence broadcast self-heals on the next
      // connect/disconnect or the periodic snapshot a restarting peer
      // requests; a lost relay reply surfaces to the ORIGINAL caller as a
      // NodeTimeout, the same as a real network partition to the node
      // itself would.
    });
  }

  sub.on('message', (channel, raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (channel === CH.presence) {
      if (msg.instanceId === instanceId) return; // our own broadcast, echoed back
      if (msg.online) remoteOwner.set(msg.nodeId, msg.instanceId);
      else if (remoteOwner.get(msg.nodeId) === msg.instanceId) remoteOwner.delete(msg.nodeId);
      return;
    }

    if (channel === CH.snapshotRequest) {
      if (msg.instanceId === instanceId) return;
      publish(CH.snapshotReply, {
        instanceId, forRequestId: msg.requestId, nodeIds: [...hub._nodes.keys()],
      });
      return;
    }

    if (channel === CH.snapshotReply) {
      if (msg.forRequestId !== startupSnapshotRequestId) return;
      for (const nodeId of msg.nodeIds) remoteOwner.set(nodeId, msg.instanceId);
      return;
    }

    if (channel === CH.request(instanceId)) {
      return handleRelayedRequest(msg);
    }

    if (channel === CH.reply) {
      const p = pending.get(msg.correlationId);
      if (!p) return; // not ours, or already timed out
      clearTimeout(p.timer);
      pending.delete(msg.correlationId);
      if (msg.ok) return p.resolve(msg.result);
      const ErrorClass = ERROR_CLASSES[msg.errorType] ?? Error;
      const err = msg.errorType === 'NodeRefused' ? new NodeRefused(msg.reason) : new ErrorClass(msg.message);
      return p.reject(err);
    }
  });

  async function handleRelayedRequest({ correlationId, method, nodeId, args }) {
    try {
      // Calls the underlying Hub's OWN method (not this wrapper's), since
      // the whole point is to run it against the real local socket this
      // instance actually holds.
      const result = await hub[method](nodeId, ...args);
      publish(CH.reply, { correlationId, ok: true, result });
    } catch (e) {
      const errorType = Object.keys(ERROR_CLASSES).find((name) => e instanceof ERROR_CLASSES[name]) ?? 'Error';
      publish(CH.reply, {
        correlationId, ok: false, errorType, message: e.message, reason: e.reason,
      });
    }
  }

  function relay(method, nodeId, ownerInstanceId, args) {
    return new Promise((resolve, reject) => {
      const correlationId = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(correlationId);
        reject(new NodeTimeout(`relayed ${method} for ${nodeId} timed out`));
      }, requestTimeoutMs);
      pending.set(correlationId, { resolve, reject, timer });
      publish(CH.request(ownerInstanceId), { correlationId, method, nodeId, args });
    });
  }

  // Broadcast this instance's own presence changes -- wraps rather than
  // replaces onPresence, since the caller (api/server.js) still needs its
  // own callback (updating compute_nodes.status) to keep firing exactly as
  // before.
  const originalOnPresence = hub._onPresence;
  hub._onPresence = (nodeId, online) => {
    publish(CH.presence, { instanceId, nodeId, online });
    return originalOnPresence(nodeId, online);
  };

  // Subscribing is asynchronous -- publishing this instance's own presence
  // (or requesting a snapshot) before the SUBSCRIBE actually lands on the
  // Redis server would mean sibling instances miss it entirely. `ready`
  // is exposed so a test can await full readiness deterministically;
  // production code doesn't need to (a real deployment's brief startup
  // window before subscriptions land is an acceptable, self-healing gap --
  // the next connect/disconnect or a peer's own snapshot request converges
  // it), but the snapshot REQUEST below is deliberately still sequenced
  // after subscribe completes, since sending it any earlier would guarantee
  // missing every reply.
  const ready = sub.subscribe(
    CH.presence, CH.snapshotRequest, CH.snapshotReply, CH.request(instanceId), CH.reply,
  ).then(() => {
    publish(CH.snapshotRequest, { instanceId, requestId: startupSnapshotRequestId });
  });

  const wrapped = Object.create(hub);
  wrapped.ready = ready;
  wrapped.isOnline = (nodeId) => hub.isOnline(nodeId) || remoteOwner.has(nodeId);
  for (const method of RELAYABLE_METHODS) {
    wrapped[method] = (nodeId, ...args) => {
      if (hub.isOnline(nodeId)) return hub[method](nodeId, ...args);
      const ownerInstanceId = remoteOwner.get(nodeId);
      if (!ownerInstanceId) return Promise.reject(new NodeOffline(nodeId));
      return relay(method, nodeId, ownerInstanceId, args);
    };
  }
  wrapped.close = async () => {
    await Promise.all([pub.quit().catch(() => {}), sub.quit().catch(() => {})]);
  };
  return wrapped;
}
