import { test } from 'node:test';
import assert from 'node:assert/strict';
import { S, canTransition, assertTransition, SETTLEMENT, TERMINAL } from '../src/reservations/machine.js';
import { split, quote, meteredCharge } from '../src/payments/settle.js';

test('money is never captured before the node has locked the slot', () => {
  assert.equal(canTransition(S.PENDING, S.CONFIRMED), false,
    'pending -> confirmed would charge a user for an unlocked slot');
  assert.equal(canTransition(S.HELD, S.CONFIRMED), true);
});

test('an expired hold cannot be revived into a paid booking', () => {
  assert.equal(canTransition(S.EXPIRED, S.CONFIRMED), false);
  assert.equal(canTransition(S.EXPIRED, S.HELD), false);
});

test('terminal states are truly terminal', () => {
  for (const s of TERMINAL) {
    for (const t of Object.values(S)) {
      assert.equal(canTransition(s, t), false, `${s} -> ${t} must be rejected`);
    }
  }
});

test('a job cannot run without confirmed payment', () => {
  assert.equal(canTransition(S.HELD, S.RUNNING), false);
  assert.equal(canTransition(S.CONFIRMED, S.RUNNING), true);
});

test('illegal transitions throw rather than silently no-op', () => {
  assert.throws(() => assertTransition(S.COMPLETED, S.RUNNING), /illegal/);
});

test('every terminal state has a defined settlement outcome', () => {
  for (const s of TERMINAL) {
    assert.ok(SETTLEMENT[s], `no settlement rule for terminal state ${s}`);
  }
});

test('provider failure refunds, user code failure does not', () => {
  assert.equal(SETTLEMENT[S.FAILED_PROVIDER], 'refund_full');
  assert.equal(SETTLEMENT[S.FAILED_USER], 'settle_metered');
});

test('90/10 split is exact on the spec example', () => {
  assert.deepEqual(split(4500), { provider: 4050, platform: 450, total: 4500 });
});

test('split never invents or destroys paise on odd amounts', () => {
  for (const t of [1, 3, 7, 99, 101, 4333, 999999]) {
    const s = split(t);
    assert.equal(s.provider + s.platform, t, `leak at ${t}`);
    assert.ok(s.provider >= 0 && s.platform >= 0);
  }
});

test('sub-hour reservations are billed pro rata, rounded up to the minute', () => {
  const t0 = new Date('2026-09-20T10:00:00Z'), t30 = new Date('2026-09-20T10:30:00Z');
  assert.equal(quote(4300, t0, t30), 2150);
});

test('metered charge on user failure is floored and capped', () => {
  const quoted = quote(4300, new Date('2026-09-20T10:00:00Z'), new Date('2026-09-20T11:00:00Z'));
  // Crashed after 2s: provider still held the GPU, bill the 5-minute floor.
  assert.equal(meteredCharge(quoted, 4300, 2), 359);
  // Ran nearly the full hour then failed: never exceed what was quoted.
  assert.equal(meteredCharge(quoted, 4300, 3599), quoted);
});
