// Connection hub: tracks which nodes are online and turns the "request a
// reservation from a specific node" problem into a promise, even though the
// actual conversation happens async over a socket the node opened.
//
// AUTHENTICATION: challenge-response against the node's registered public key,
// not a bearer token or API key. A token can be copied off a compromised
// machine and replayed from anywhere; proving possession of the private key
// on every connection means the key must be exfiltrated, not just a token
// file. The private key never crosses the wire (see worker/identity.py).
//
// This module holds no knowledge of Postgres. It is handed a `verifyChallenge`
// function and a `onHeartbeat` callback so it can be unit-tested with fake
// sockets and no database — see test/ws-hub.test.js.

import crypto from 'node:crypto';
import {
  TYPE, AUTH_TIMEOUT_MS, RESERVE_TIMEOUT_MS, COMMIT_TIMEOUT_MS,
  HEARTBEAT_MISS_LIMIT,
  encodeEnvelope, decodeEnvelope,
} from './protocol.js';
import { publicKeyFromRaw } from '../lib/verify.js';

export class NodeOffline extends Error {}
export class NodeRefused extends Error {
  constructor(reason) { super(`node refused: ${reason}`); this.reason = reason; }
}
export class NodeTimeout extends Error {}

export class Hub {
  /**
   * @param {object} deps
   * @param {(nodeId: string) => Promise<Buffer|null>} deps.lookupPublicKey -
   *   resolve a claimed node_id to its registered raw Ed25519 public key, or
   *   null if unknown. Rejecting HELLO for an unknown node_id happens here,
   *   not by trusting whatever the socket claims.
   * @param {(nodeId: string, heartbeat: object) => void} [deps.onHeartbeat]
   * @param {(nodeId: string, online: boolean) => void} [deps.onPresence]
   */
  constructor({
    lookupPublicKey, onHeartbeat, onPresence,
    authTimeoutMs = AUTH_TIMEOUT_MS,
    reserveTimeoutMs = RESERVE_TIMEOUT_MS,
    commitTimeoutMs = COMMIT_TIMEOUT_MS,
  } = {}) {
    this._lookupPublicKey = lookupPublicKey;
    this._onHeartbeat = onHeartbeat ?? (() => {});
    this._onPresence = onPresence ?? (() => {});
    this._authTimeoutMs = authTimeoutMs;
    this._reserveTimeoutMs = reserveTimeoutMs;
    this._commitTimeoutMs = commitTimeoutMs;
    // nodeId -> connection state. One live socket per node; a second HELLO
    // for the same node_id replaces the first (the old one is presumed dead
    // or a stale reconnect race, and we trust the newest proof of possession).
    this._nodes = new Map();
    // reservation_id -> pending { resolve, reject, timer }, regardless of
    // which node it was sent to — reservation ids are UUIDs, globally unique.
    this._pending = new Map();
  }

  isOnline(nodeId) {
    return this._nodes.has(nodeId);
  }

  /** Wire a freshly-accepted socket into the hub. Handles its whole lifecycle. */
  handleConnection(socket) {
    const state = { nodeId: null, publicKey: null, missedBeats: 0, authTimer: null };

    state.authTimer = setTimeout(() => {
      this._safeClose(socket, 4001, 'auth timeout');
    }, this._authTimeoutMs);

    socket.on('message', (raw) => this._onMessage(socket, state, raw));
    socket.on('close', () => this._onClose(state));
    socket.on('error', () => {}); // 'close' still fires; avoid unhandled 'error' crashing the process
  }

  async _onMessage(socket, state, raw) {
    let msg;
    try {
      msg = decodeEnvelope(raw.toString());
    } catch {
      return this._send(socket, { type: TYPE.ERROR, message: 'malformed envelope' });
    }

    if (state.nodeId === null) {
      return this._handlePreAuth(socket, state, msg);
    }

    switch (msg.type) {
      case TYPE.HEARTBEAT:
        state.missedBeats = 0;
        this._onHeartbeat(state.nodeId, msg);
        return;
      case TYPE.RECEIPT:
      case TYPE.DENY:
      case TYPE.COMMITTED:
      case TYPE.COMMIT_FAILED:
        return this._resolvePending(msg);
      default:
        return this._send(socket, { type: TYPE.ERROR, message: `unexpected type ${msg.type}` });
    }
  }

  async _handlePreAuth(socket, state, msg) {
    if (msg.type === TYPE.HELLO) {
      const pub = await this._lookupPublicKey(msg.node_id);
      if (!pub) {
        this._send(socket, { type: TYPE.REJECT, reason: 'unknown node_id' });
        return this._safeClose(socket, 4003, 'unknown node');
      }
      state._pendingNodeId = msg.node_id;
      state._pendingPublicKey = pub;
      state._nonce = crypto.randomBytes(24).toString('hex');
      return this._send(socket, { type: TYPE.CHALLENGE, nonce: state._nonce });
    }

    if (msg.type === TYPE.CHALLENGE_RESPONSE) {
      if (!state._nonce) {
        this._send(socket, { type: TYPE.REJECT, reason: 'no challenge issued' });
        return this._safeClose(socket, 4002, 'protocol violation');
      }
      const ok = crypto.verify(
        null, Buffer.from(state._nonce, 'utf8'),
        publicKeyFromRaw(state._pendingPublicKey),
        Buffer.from(msg.signature_hex, 'hex'),
      );
      if (!ok) {
        this._send(socket, { type: TYPE.REJECT, reason: 'bad signature' });
        return this._safeClose(socket, 4003, 'auth failed');
      }
      clearTimeout(state.authTimer);
      state.nodeId = state._pendingNodeId;
      state.publicKey = state._pendingPublicKey;
      state.socket = socket;

      // Replace any prior connection for this node — see constructor note.
      const prior = this._nodes.get(state.nodeId);
      if (prior) this._safeClose(prior.socket, 4009, 'superseded by new connection');

      this._nodes.set(state.nodeId, state);
      this._onPresence(state.nodeId, true);
      return this._send(socket, { type: TYPE.WELCOME, node_id: state.nodeId });
    }

    this._send(socket, { type: TYPE.ERROR, message: 'expected HELLO' });
    this._safeClose(socket, 4002, 'protocol violation');
  }

  _onClose(state) {
    if (state.authTimer) clearTimeout(state.authTimer);
    if (state.nodeId && this._nodes.get(state.nodeId) === state) {
      this._nodes.delete(state.nodeId);
      this._onPresence(state.nodeId, false);
    }
  }

  _resolvePending(msg) {
    const p = this._pending.get(msg.reservation_id);
    if (!p) return; // late/duplicate reply after we already timed out or resolved
    clearTimeout(p.timer);
    this._pending.delete(msg.reservation_id);
    p.resolve(msg);
  }

  /** Ask a specific online node to lock a slot. Resolves to the RECEIPT or DENY message. */
  requestReservation(nodeId, { reservationId, startsAt, endsAt, pricePaiseHr }) {
    const conn = this._nodes.get(nodeId);
    if (!conn) return Promise.reject(new NodeOffline(nodeId));
    return this._sendAwait(conn.socket, reservationId, this._reserveTimeoutMs, {
      type: TYPE.RESERVE_REQUEST,
      reservation_id: reservationId,
      starts_at: startsAt,
      ends_at: endsAt,
      price_paise_hr: pricePaiseHr,
    }).then((msg) => {
      if (msg.type === TYPE.DENY) throw new NodeRefused(msg.reason);
      return msg; // RECEIPT
    });
  }

  /** Tell a node its hold is paid for and permanent. */
  commitReservation(nodeId, reservationId) {
    const conn = this._nodes.get(nodeId);
    if (!conn) return Promise.reject(new NodeOffline(nodeId));
    return this._sendAwait(conn.socket, reservationId, this._commitTimeoutMs, {
      type: TYPE.RESERVE_COMMIT, reservation_id: reservationId,
    }).then((msg) => {
      if (msg.type === TYPE.COMMIT_FAILED) throw new NodeRefused(msg.reason);
      return msg; // COMMITTED
    });
  }

  _sendAwait(socket, correlationId, timeoutMs, payload) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(correlationId);
        reject(new NodeTimeout(`no response for ${correlationId} within ${timeoutMs}ms`));
      }, timeoutMs);
      this._pending.set(correlationId, { resolve, reject, timer });
      this._send(socket, payload);
    });
  }

  _send(socket, obj) {
    try { socket.send(encodeEnvelope(obj)); } catch { /* socket already gone */ }
  }

  _safeClose(socket, code, reason) {
    try { socket.close(code, reason); } catch { /* already closed */ }
  }

  /** Sweep nodes that have missed too many heartbeats. Call on an interval.
   *
   * Only closes the socket here — does NOT delete from `_nodes` or fire
   * `onPresence` itself. That bookkeeping belongs solely to `_onClose`, which
   * runs when the socket's `close` event fires. Duplicating it here raced with
   * `_onClose` and fired `onPresence(id, false)` twice for one disconnect
   * whenever `close()` happened to complete synchronously (a real `ws` socket
   * always closes asynchronously, but a test double or a fast local
   * loopback need not) — a double offline notification is a real bug, not
   * just a test artifact, since callers may use presence events to
   * decrement a counter or free a slot exactly once.
   */
  sweepStale() {
    for (const [, state] of this._nodes) {
      state.missedBeats += 1;
      if (state.missedBeats > HEARTBEAT_MISS_LIMIT) {
        this._safeClose(state.socket, 4008, 'heartbeat timeout');
      }
    }
  }
}
