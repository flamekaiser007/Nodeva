import crypto from 'node:crypto';
import { encode } from './canonical.js';

// Ed25519 SPKI DER prefix. Node's createPublicKey has no raw-key input for
// Ed25519, so a 32-byte raw key is wrapped into the DER envelope it expects.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function publicKeyFromRaw(raw) {
  if (raw.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${raw.length}`);
  }
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

export function verifyBody(publicKeyRaw, body, signature) {
  return crypto.verify(null, encode(body),
    publicKeyFromRaw(publicKeyRaw), signature);
}

// Full receipt admission check. Signature validity is necessary but not
// sufficient: a node could sign a receipt for a slot we never asked about, or
// for a price higher than it advertised. Verify the CONTENT matches our request
// before this receipt is allowed to authorize a payment.
export function admitReceipt({ publicKeyRaw, body, signature, expected }) {
  if (!verifyBody(publicKeyRaw, body, signature)) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (body.node_id !== expected.node_id)   return { ok: false, reason: 'node_mismatch' };
  if (body.starts_at !== expected.starts_at ||
      body.ends_at !== expected.ends_at)   return { ok: false, reason: 'window_mismatch' };
  if (body.reservation_id !== expected.reservation_id) {
    return { ok: false, reason: 'reservation_mismatch' };
  }
  // A node quoting MORE than it advertised is repricing after the fact. Less is
  // fine — the provider is free to undercut their own ad.
  if (body.price_paise_hr > expected.price_paise_hr) {
    return { ok: false, reason: 'price_increased' };
  }
  // A hold that has already expired cannot authorize a capture: that is the
  // "charged but not reserved" path.
  if (body.hold_expires_at <= Date.now()) {
    return { ok: false, reason: 'hold_expired' };
  }
  return { ok: true };
}
