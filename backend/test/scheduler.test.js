import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rank, feasible, coversWindow, expectedCostPaise, subtractBusy } from '../src/marketplace/scheduler.js';

const T = (s) => new Date(`2026-09-20T${s}:00+05:30`).getTime();

const req = {
  min_vram_mb: 20480, min_cpu_cores: 8, min_ram_mb: 16384,
  max_price_paise_hr: 4500,
  starts_at: T('10:00'), ends_at: T('11:00'),
};

const base = { status: 'online', gpu_vram_mb: 24576, cpu_cores: 16, ram_mb: 32768,
               perf_score: 95, reliability: 0.97, latency_ms: 40 };

// The scenario from the spec: three RTX 4090s, only one whose offered window
// actually contains 10:00-11:00.
const A = { ...base, id: 'A', price_paise_hr: 4300, availability: [{ start: T('09:00'), end: T('14:00') }] };
const B = { ...base, id: 'B', price_paise_hr: 4000, availability: [{ start: T('08:00'), end: T('09:30') }] };
const C = { ...base, id: 'C', price_paise_hr: 4500, availability: [{ start: T('11:00'), end: T('14:00') }] };

test('only the provider whose window contains the request is feasible', () => {
  assert.equal(feasible(A, req), true);
  assert.equal(feasible(B, req), false, 'B ends 09:30, before the slot');
  assert.equal(feasible(C, req), false, 'C starts 11:00, after the slot');
  assert.deepEqual(rank([A, B, C], req).map(r => r.node.id), ['A']);
});

test('cheaper-but-unavailable never outranks available', () => {
  // B is cheapest. It must not appear at all — price cannot buy feasibility.
  assert.equal(rank([B, A], req, 'cheapest').length, 1);
});

test('adjacent windows are not stitched across a gap', () => {
  const gapped = [{ start: T('09:00'), end: T('10:30') }, { start: T('10:30'), end: T('12:00') }];
  assert.equal(coversWindow(gapped, T('10:00'), T('11:00')), false,
    'two touching windows are still two separate offers');
});

test('VRAM shortfall is a hard filter, not a penalty', () => {
  const small = { ...A, id: 'small', gpu_vram_mb: 16384, price_paise_hr: 100, perf_score: 100 };
  assert.deepEqual(rank([small, A], req).map(r => r.node.id), ['A']);
});

test('budget ceiling is enforced', () => {
  const pricey = { ...A, id: 'pricey', price_paise_hr: 4600 };
  assert.equal(rank([pricey], req).length, 0);
});

test('reliability-adjusted cost beats sticker price', () => {
  const flaky  = { ...A, id: 'flaky',  price_paise_hr: 3500, reliability: 0.60 };
  const solid  = { ...A, id: 'solid',  price_paise_hr: 4000, reliability: 0.99 };
  assert.ok(expectedCostPaise(flaky, 1) > expectedCostPaise(solid, 1),
    'a 40% failure rate makes the cheap node more expensive in expectation');
  // Even in the most price-sensitive mode, the flaky node should not win.
  assert.equal(rank([flaky, solid], req, 'cheapest')[0].node.id, 'solid');
});

test('scoring is invariant to the unit money is expressed in', () => {
  const n1 = { ...A, id: 'n1', price_paise_hr: 4000 };
  const n2 = { ...A, id: 'n2', price_paise_hr: 4400, perf_score: 99 };
  const order = rank([n1, n2], req).map(r => r.node.id);
  // Re-express every price 100x larger; a correct normalization is unchanged.
  const scaled = [n1, n2].map(n => ({ ...n, price_paise_hr: n.price_paise_hr * 100 }));
  const scaledReq = { ...req, max_price_paise_hr: 450000 };
  assert.deepEqual(rank(scaled, scaledReq).map(r => r.node.id), order);
});

test('identical candidates do not divide by zero', () => {
  const twins = [{ ...A, id: 'x' }, { ...A, id: 'y' }];
  const out = rank(twins, req);
  assert.equal(out.length, 2);
  assert.ok(Number.isFinite(out[0].score));
});

test('empty pool returns empty, never a fallback suggestion', () => {
  // Never falsely show availability (design principle 14).
  assert.deepEqual(rank([], req), []);
});

test('a new/unproven provider is flagged for verification on its search result', () => {
  const newProvider = { ...A, id: 'new', rep_jobs_total: 0 };
  const result = rank([newProvider], req)[0];
  assert.equal(result.verification_recommended, true);
  assert.ok(result.verification_reasons.includes('new_provider'));
});

test('an established, reliable provider on an ordinary-priced job is not flagged', () => {
  const established = { ...A, id: 'established', rep_jobs_total: 500, reliability: 0.99 };
  const result = rank([established], req)[0];
  assert.equal(result.verification_recommended, false);
  assert.deepEqual(result.verification_reasons, []);
});

test('the recommendation is per-candidate, not a single value applied to the whole list', () => {
  const trusted = { ...A, id: 'trusted', rep_jobs_total: 500, reliability: 0.99 };
  const newOne = { ...B, id: 'newOne', rep_jobs_total: 0,
                   availability: [{ start: T('09:00'), end: T('14:00') }] };
  const results = rank([trusted, newOne], req);
  const byId = Object.fromEntries(results.map((r) => [r.node.id, r]));
  assert.equal(byId.trusted.verification_recommended, false);
  assert.equal(byId.newOne.verification_recommended, true);
});

// --- subtractBusy --------------------------------------------------------
// node_availability records when a provider SAYS the machine is free and is
// never amended when a booking lands on it, so advertising those windows raw
// offers time that is already sold. These are the shapes that matter.

test('a booking in the middle of a window leaves the free time on BOTH sides', () => {
  // Dropping the whole window would hide two genuinely bookable stretches.
  const free = subtractBusy(
    [{ start: T('09:00'), end: T('17:00') }],
    [{ start: T('12:00'), end: T('13:00') }]);

  assert.deepEqual(free, [
    { start: T('09:00'), end: T('12:00') },
    { start: T('13:00'), end: T('17:00') },
  ]);
});

test('a window booked end to end disappears rather than being advertised', () => {
  const free = subtractBusy(
    [{ start: T('09:00'), end: T('10:00') }],
    [{ start: T('09:00'), end: T('10:00') }]);
  assert.deepEqual(free, []);
});

test('a booking overlapping only the start trims the front', () => {
  const free = subtractBusy(
    [{ start: T('09:00'), end: T('12:00') }],
    [{ start: T('08:00'), end: T('10:00') }]);
  assert.deepEqual(free, [{ start: T('10:00'), end: T('12:00') }]);
});

test('a booking on another day leaves the window untouched', () => {
  const windows = [{ start: T('09:00'), end: T('12:00') }];
  assert.deepEqual(subtractBusy(windows, [{ start: T('14:00'), end: T('15:00') }]), windows);
});

test('overlapping bookings do not reopen time between them', () => {
  // A completed booking and a held one can overlap or nest. Walking them
  // naively would let the cursor move BACKWARDS and emit a free slot that
  // is actually sold.
  const free = subtractBusy(
    [{ start: T('09:00'), end: T('17:00') }],
    [
      { start: T('10:00'), end: T('14:00') },
      { start: T('11:00'), end: T('12:00') }, // nested inside the first
      { start: T('13:00'), end: T('15:00') }, // overlaps the first
    ]);
  assert.deepEqual(free, [
    { start: T('09:00'), end: T('10:00') },
    { start: T('15:00'), end: T('17:00') },
  ]);
});

test('bookings are handled in any order, not just sorted', () => {
  const free = subtractBusy(
    [{ start: T('09:00'), end: T('17:00') }],
    [
      { start: T('15:00'), end: T('16:00') },
      { start: T('10:00'), end: T('11:00') },
    ]);
  assert.deepEqual(free, [
    { start: T('09:00'), end: T('10:00') },
    { start: T('11:00'), end: T('15:00') },
    { start: T('16:00'), end: T('17:00') },
  ]);
});

test('an abutting booking is not an overlap and changes nothing', () => {
  // Ends exactly when the window starts. Treating touching as overlapping
  // would shave real time off every back-to-back booking.
  const windows = [{ start: T('10:00'), end: T('12:00') }];
  assert.deepEqual(subtractBusy(windows, [{ start: T('09:00'), end: T('10:00') }]), windows);
});

test('no bookings returns the windows unchanged', () => {
  const windows = [{ start: T('09:00'), end: T('12:00') }];
  assert.deepEqual(subtractBusy(windows, []), windows);
  assert.deepEqual(subtractBusy(windows, undefined), windows);
});

test('a request spanning a booking is no longer feasible', () => {
  // The point of all of this: coversWindow needs ONE window containing the
  // request, and splitting means a request straddling a booking finds none.
  const windows = subtractBusy(
    [{ start: T('09:00'), end: T('17:00') }],
    [{ start: T('10:30'), end: T('11:30') }]);

  assert.equal(coversWindow(windows, T('10:00'), T('12:00')), false, 'straddles the booking');
  assert.equal(coversWindow(windows, T('09:00'), T('10:00')), true, 'fits before it');
  assert.equal(coversWindow(windows, T('11:30'), T('13:00')), true, 'fits after it');
});
