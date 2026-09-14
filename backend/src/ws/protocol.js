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
  JOB_ACCEPTED: 'JOB_ACCEPTED',         // { job_id } -- node started the container
  JOB_REJECTED: 'JOB_REJECTED',         // { job_id, reason } -- e.g. reservation not confirmed locally
  JOB_RESULT: 'JOB_RESULT',             // { job_id, status, exit_code, stdout, stderr, duration_seconds } -- unsolicited, sent whenever the job finishes
  RESERVATION_STATUS: 'RESERVATION_STATUS', // { reservation_id, status } -- status is one of the node's own local vocabulary (held/confirmed/running/completed/released), or null if the node has never heard of this reservation_id
  RELEASE_ACK: 'RELEASE_ACK',           // { reservation_id } -- the node has released its local hold, regardless of what it was
  // Opt-in: a node only sends this if it chose to open a local listener for
  // direct peer connections (see worker/nodeva_worker/peer.py). Absent this,
  // the platform has no port to hand out and PEER_INFO below simply carries
  // host/port: null -- the node is still discoverable by identity, just not
  // dialable directly. Resent after every reconnect, since a fresh TCP
  // connection has a fresh (possibly NATed) source address on the platform's
  // side of things.
  PEER_ADDR: 'PEER_ADDR',               // { peer_port }

  // backend -> worker
  CHALLENGE: 'CHALLENGE',               // { nonce }
  WELCOME: 'WELCOME',                   // { node_id }
  REJECT: 'REJECT',                     // { reason }
  RESERVE_REQUEST: 'RESERVE_REQUEST',   // { reservation_id, starts_at, ends_at, price_paise_hr }
  RESERVE_COMMIT: 'RESERVE_COMMIT',     // { reservation_id }
  JOB_SUBMIT: 'JOB_SUBMIT',             // { job_id, reservation_id, image, command, env, gpu }
  // The reconciliation query this protocol was missing (see
  // docs/reservation-protocol.md's failure matrix, row 5): after a
  // RESERVE_COMMIT ack goes missing, the platform marks the reservation
  // 'expired' without knowing whether the node actually applied the commit
  // before the ack was lost. This asks the node directly.
  RESERVATION_STATUS_QUERY: 'RESERVATION_STATUS_QUERY', // { reservation_id }
  // If the query reveals the node believes it is CONFIRMED for a
  // reservation the platform has already marked 'expired' (and therefore
  // never captured payment for), the platform does not try to resurrect its
  // own row -- that reopens exactly the "charged but not reserved" risk
  // machine.js's illegal transitions exist to prevent, just from the other
  // direction. Instead it tells the node to give the slot back, so the two
  // sides agree again and the window becomes bookable rather than
  // permanently squatted on by a reservation nobody can act on.
  RESERVE_RELEASE: 'RESERVE_RELEASE',   // { reservation_id }
  // Rendezvous, not a general directory: sent only when the platform has a
  // concrete reason to introduce two specific nodes (today: they were just
  // paired for duplicate-execution verification, see
  // jobs/verification.js's file header). Never a lookup a node can trigger
  // for an arbitrary other node_id -- that would leak provider network
  // topology to anyone who asks. `host` is the platform's OWN observed
  // remote address for that node's socket (not self-reported -- a node
  // cannot spoof this to point a peer at a victim's IP), `port` is whatever
  // that node last advertised via PEER_ADDR, or null if it never did (no
  // direct route known; see docs/reservation-protocol.md's "what is NOT
  // solved yet" for the NAT case this does not cover).
  PEER_INFO: 'PEER_INFO',               // { node_id, public_key_hex, host, port }
  ERROR: 'ERROR',                       // { message }
};

// How long a node has to answer the auth challenge before we drop it.
export const AUTH_TIMEOUT_MS = 5_000;
// How long we wait for a signed receipt before treating the node as having
// silently refused. Generous: try_lock is a local SQLite transaction, this is
// really bounding network + scheduling jitter, not disk time.
export const RESERVE_TIMEOUT_MS = 8_000;
export const COMMIT_TIMEOUT_MS = 8_000;
// A status query or release is a cheap local SQLite read/write on the
// node's side, same order of magnitude as RESERVE_TIMEOUT_MS.
export const STATUS_QUERY_TIMEOUT_MS = 8_000;
export const RELEASE_TIMEOUT_MS = 8_000;
// How long we wait for JOB_ACCEPTED/JOB_REJECTED -- just an ack that the
// container started, NOT the job's own runtime. JOB_RESULT arrives later,
// unsolicited, whenever the job actually finishes (which may be hours).
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
