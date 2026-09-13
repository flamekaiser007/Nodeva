import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode } from '../src/lib/canonical.js';
import { verifyBody, admitReceipt } from '../src/lib/verify.js';

// Fixtures are produced by the Python worker:
//   .venv/bin/python worker/tools/gen_interop_fixture.py
// This suite is the contract between the two canonical encoders. If it fails,
// real nodes cannot book real slots.
const fx = JSON.parse(readFileSync(new URL('./fixtures/interop.json', import.meta.url)));
const pub = Buffer.from(fx.public_key_hex, 'hex');

for (const c of fx.cases) {
  test(`canonical bytes match Python exactly: ${c.name}`, () => {
    assert.equal(encode(c.body).toString('utf8'), c.canonical);
  });

  test(`Python-signed receipt verifies in Node: ${c.name}`, () => {
    assert.equal(verifyBody(pub, c.body, Buffer.from(c.signature_hex, 'hex')), true);
  });

  test(`tampering is detected: ${c.name}`, () => {
    const tampered = structuredClone(c.body);
    // Flip whichever field a malicious platform would most want to change.
    if ('price_paise_hr' in tampered) tampered.price_paise_hr += 1;
    else tampered.z_last += 1;
    assert.equal(verifyBody(pub, tampered, Buffer.from(c.signature_hex, 'hex')), false);
  });
}

test('a signature from a different key is rejected', () => {
  const other = Buffer.from(fx.public_key_hex, 'hex');
  other[0] ^= 0xff;
  const c = fx.cases[0];
  assert.equal(verifyBody(other, c.body, Buffer.from(c.signature_hex, 'hex')), false);
});

// --- admission checks beyond signature validity ---------------------------

const receipt = fx.cases[0];
const sig = Buffer.from(receipt.signature_hex, 'hex');
const expected = {
  node_id: receipt.body.node_id,
  reservation_id: receipt.body.reservation_id,
  starts_at: receipt.body.starts_at,
  ends_at: receipt.body.ends_at,
  price_paise_hr: receipt.body.price_paise_hr,
};
// The fixture's hold has long since expired in wall-clock terms, so freeze
// "now" just before it for the checks that are not about expiry.
const FRESH = receipt.body.hold_expires_at - 1000;

function admit(overrides = {}, now = FRESH) {
  const realNow = Date.now;
  Date.now = () => now;
  try {
    return admitReceipt({
      publicKeyRaw: pub, body: receipt.body, signature: sig,
      expected: { ...expected, ...overrides },
    });
  } finally { Date.now = realNow; }
}

test('a valid, fresh receipt for the expected slot is admitted', () => {
  assert.deepEqual(admit(), { ok: true });
});

test('a receipt for a different node is rejected even though it is validly signed', () => {
  assert.equal(admit({ node_id: 'some-other-node' }).reason, 'node_mismatch');
});

test('a receipt for a different time window is rejected', () => {
  assert.equal(admit({ ends_at: receipt.body.ends_at + 1 }).reason, 'window_mismatch');
});

test('a node repricing above its advertisement is rejected', () => {
  // Node signed 4300; we only advertised 4200 to the user. Honouring this would
  // let a node quietly charge more than the price the user agreed to.
  assert.equal(admit({ price_paise_hr: 4200 }).reason, 'price_increased');
});

test('a node undercutting its own advertisement is allowed', () => {
  assert.deepEqual(admit({ price_paise_hr: 9999 }), { ok: true });
});

test('an expired hold cannot authorize a capture', () => {
  // This is the charged-but-not-reserved path, blocked at the door.
  assert.equal(admit({}, receipt.body.hold_expires_at + 1).reason, 'hold_expired');
});
