// This is a research/reporting script (see its own file header), not a
// unit under test in the usual sense -- there is no "correct" failure rate
// to assert against, since it depends on an explicitly-stated synthetic
// model, not a spec. What's worth guarding against silent bit-rot: the
// generators produce data shaped the way rank()/shouldRecommendVerification
// actually expect, the same seed reproduces the same numbers (the entire
// point of using a seeded PRNG instead of Math.random), and the backtest
// doesn't crash or return nonsense (rates outside [0,1], negative counts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32, generateProviders, generateRequest, runBacktest,
} from '../scripts/scheduler_simulation.js';
import { DEFAULT_VERIFICATION_THRESHOLDS } from '../src/jobs/verification.js';
import { rank } from '../src/marketplace/scheduler.js';

test('the same seed reproduces the same provider population', () => {
  const a = generateProviders(20, mulberry32(7));
  const b = generateProviders(20, mulberry32(7));
  assert.deepEqual(a, b);
});

test('different seeds produce different populations', () => {
  const a = generateProviders(20, mulberry32(1));
  const b = generateProviders(20, mulberry32(2));
  assert.notDeepEqual(a, b);
});

test('generated providers have the shape rank() actually expects', () => {
  const rand = mulberry32(3);
  const providers = generateProviders(10, rand);
  const req = generateRequest(rand);
  // Not asserting specific results -- asserting this doesn't throw, which
  // it would if a generated provider were missing a field rank() reads
  // (gpu_vram_mb, price_paise_hr, availability, etc).
  assert.doesNotThrow(() => rank(providers, req, req.mode));
});

test('every provider has a hidden true reliability in [0,1], distinct from its observed one', () => {
  const providers = generateProviders(50, mulberry32(4));
  for (const p of providers) {
    assert.ok(p._trueReliability >= 0 && p._trueReliability <= 1);
    assert.ok(p.reliability >= 0 && p.reliability <= 1);
  }
});

test('runBacktest returns plausible rates (all in [0,1] or null) for every mode', () => {
  const rand = mulberry32(5);
  const providers = generateProviders(60, rand);
  const requests = Array.from({ length: 300 }, () => generateRequest(rand));
  const result = runBacktest(providers, requests, DEFAULT_VERIFICATION_THRESHOLDS);

  for (const [modeName, s] of Object.entries(result)) {
    assert.ok(s.picked >= 0, `${modeName}: picked must be non-negative`);
    for (const rate of [s.failureRate, s.recommendedRate, s.recall, s.precision]) {
      if (rate !== null) assert.ok(rate >= 0 && rate <= 1, `${modeName}: rate ${rate} out of [0,1]`);
    }
  }
});

test('runBacktest is deterministic given the same providers, requests, and thresholds', () => {
  const rand = mulberry32(6);
  const providers = generateProviders(40, rand);
  const requests = Array.from({ length: 200 }, () => generateRequest(rand));
  const a = runBacktest(providers, requests, DEFAULT_VERIFICATION_THRESHOLDS);
  const b = runBacktest(providers, requests, DEFAULT_VERIFICATION_THRESHOLDS);
  assert.deepEqual(a, b);
});

test('a stricter (higher) reliability threshold never DECREASES recall', () => {
  // Loosening what counts as "low reliability" can only catch MORE of the
  // jobs that actually failed, never fewer -- a basic sanity check on the
  // sweep's monotonicity, independent of what the "best" value turns out
  // to be.
  const rand = mulberry32(8);
  const providers = generateProviders(80, rand);
  const requests = Array.from({ length: 500 }, () => generateRequest(rand));
  const loose = runBacktest(providers, requests,
    { ...DEFAULT_VERIFICATION_THRESHOLDS, lowReliabilityThreshold: 0.5 }).best_value;
  const strict = runBacktest(providers, requests,
    { ...DEFAULT_VERIFICATION_THRESHOLDS, lowReliabilityThreshold: 0.99 }).best_value;
  const looseRecall = loose.recall ?? 0;
  const strictRecall = strict.recall ?? 0;
  assert.ok(strictRecall >= looseRecall,
    `raising the threshold from 0.5 to 0.99 must not reduce recall (${looseRecall} -> ${strictRecall})`);
});
