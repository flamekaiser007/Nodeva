// Wire protocol between backend and worker.
//
// Design constraint: the WORKER DIALS OUT. Most consumer GPUs sit behind
// residential NAT/CGNAT and cannot accept an inbound connection from the
// platform, so the platform can never open a socket to a node — it can only
// push messages down a connection the node initiated and kept alive. Every
// message below is designed around that: RESERVE_REQUEST is a server->client
// push over a connection the client opened first.
//
// Envelope is a flat JSON object with `type` and a `reservation_id` or
// `nonce` for correlating requests to responses. The AUTH envelope also
// carries a signature; everything else is envelope-only (unsigned) except the
// receipt body itself, which uses the canonical encoder because that is what
// both sides independently verify.

export const TYPE = {
  // worker -> backend
  HELLO: 'HELLO',                       // { node_id, public_key_hex }
  CHALLENGE_RESPONSE: 'CHALLENGE_RESPONSE', // { signature_hex }
  HEARTBEAT: 'HEARTBEAT',               // { gpu: {...} | null, live_reservations }
  RECEIPT: 'RECEIPT',                   // { reservation_id, body, signature_hex }
  DENY: 'DENY',                         // { reservation_id, reason }
  COMMITTED: 'COMMITTED',               // { reservation_id }
  COMMIT_FAILED: 'COMMIT_FAILED',       // { reservation_id, reason }

  // backend -> worker
  CHALLENGE: 'CHALLENGE',               // { nonce }
  WELCOME: 'WELCOME',                   // { node_id }
  REJECT: 'REJECT',                     // { reason }
  RESERVE_REQUEST: 'RESERVE_REQUEST',   // { reservation_id, starts_at, ends_at, price_paise_hr }
  RESERVE_COMMIT: 'RESERVE_COMMIT',     // { reservation_id }
  ERROR: 'ERROR',                       // { message }
};

// How long a node has to answer the auth challenge before we drop it.
export const AUTH_TIMEOUT_MS = 5_000;
// How long we wait for a signed receipt before treating the node as having
// silently refused. Generous: try_lock is a local SQLite transaction, this is
// really bounding network + scheduling jitter, not disk time.
export const RESERVE_TIMEOUT_MS = 8_000;
export const COMMIT_TIMEOUT_MS = 8_000;
// A node that misses this many heartbeat intervals is presumed offline. The
// platform's `online` flag is a cache of this, never the reverse.
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_MISS_LIMIT = 3;

export function encodeEnvelope(obj) {
  return JSON.stringify(obj);
}

export function decodeEnvelope(raw) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error('malformed JSON envelope');
  }
  if (typeof obj !== 'object' || obj === null || typeof obj.type !== 'string') {
    throw new Error('envelope missing string `type`');
  }
  return obj;
}
