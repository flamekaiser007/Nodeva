import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeResultHash, compareJobResults, groupIsComplete, shouldRecommendVerification,
} from '../src/jobs/verification.js';

test('two identical results hash identically', () => {
  const a = computeResultHash({ status: 'succeeded', exit_code: 0, stdout: 'hello\n', stderr: '' });
  const b = computeResultHash({ status: 'succeeded', exit_code: 0, stdout: 'hello\n', stderr: '' });
  assert.equal(a, b);
});

test('a single differing byte of output changes the hash', () => {
  const a = computeResultHash({ status: 'succeeded', exit_code: 0, stdout: 'hello\n', stderr: '' });
  const b = computeResultHash({ status: 'succeeded', exit_code: 0, stdout: 'hellp\n', stderr: '' });
  assert.notEqual(a, b);
});

test('a different exit code changes the hash even with identical output', () => {
  const a = computeResultHash({ status: 'failed', exit_code: 1, stdout: 'x', stderr: '' });
  const b = computeResultHash({ status: 'failed', exit_code: 2, stdout: 'x', stderr: '' });
  assert.notEqual(a, b);
});

test('a different status changes the hash even with identical exit code and output', () => {
  // Guards against a node reporting "succeeded" with exit_code 0 while the
  // other reports "timed_out" but happens to also show exit_code null/0 --
  // status itself is part of what must agree.
  const a = computeResultHash({ status: 'succeeded', exit_code: 0, stdout: '', stderr: '' });
  const b = computeResultHash({ status: 'timed_out', exit_code: 0, stdout: '', stderr: '' });
  assert.notEqual(a, b);
});

test('missing/null fields are treated consistently, not as a wildcard', () => {
  const a = computeResultHash({ status: 'succeeded', exit_code: null, stdout: undefined, stderr: undefined });
  const b = computeResultHash({ status: 'succeeded', exit_code: null, stdout: '', stderr: '' });
  assert.equal(a, b, 'undefined and empty-string output must hash the same way, not differently');
});

test('matching hashes compare as a match', () => {
  const jobA = { result_hash: 'abc' };
  const jobB = { result_hash: 'abc' };
  assert.equal(compareJobResults(jobA, jobB), 'match');
});

test('differing hashes compare as a mismatch', () => {
  assert.equal(compareJobResults({ result_hash: 'abc' }, { result_hash: 'def' }), 'mismatch');
});

test('a missing hash on either side is a mismatch, never treated as inconclusive-therefore-ok', () => {
  // The exploitable failure mode this guards against: a node that crashes
  // before producing a hash must not get the benefit of the doubt.
  assert.equal(compareJobResults({ result_hash: null }, { result_hash: 'abc' }), 'mismatch');
  assert.equal(compareJobResults({ result_hash: null }, { result_hash: null }), 'mismatch');
});

test('a group is not complete while any member is still running', () => {
  const terminal = new Set(['succeeded', 'failed']);
  const jobs = [{ status: 'succeeded' }, { status: 'running' }];
  assert.equal(groupIsComplete(jobs, terminal), false);
});

test('a group of two terminal jobs is complete', () => {
  const terminal = new Set(['succeeded', 'failed']);
  const jobs = [{ status: 'succeeded' }, { status: 'failed' }];
  assert.equal(groupIsComplete(jobs, terminal), true);
});

test('a group with fewer than two jobs is never complete, regardless of status', () => {
  // A verification group with only one job on record means the sibling
  // submission never landed -- there is nothing to compare against yet.
  const terminal = new Set(['succeeded']);
  assert.equal(groupIsComplete([{ status: 'succeeded' }], terminal), false);
  assert.equal(groupIsComplete([], terminal), false);
});

// --- shouldRecommendVerification -------------------------------------------

test('a brand-new provider (zero jobs) is recommended for verification', () => {
  const { recommended, reasons } = shouldRecommendVerification(
    { repJobsTotal: 0, reliability: 1 }, 4300);
  assert.equal(recommended, true);
  assert.ok(reasons.includes('new_provider'));
});

test('a brand-new provider is NOT also flagged low_reliability from the neutral default alone', () => {
  // The real bug, caught live in the browser, not by this suite first: a
  // freshly enrolled node has no track record, so nodeStore.js gives it a
  // neutral DEFAULT reliability of 0.8 -- a "no opinion yet" placeholder,
  // not a measurement. 0.8 happens to sit below LOW_RELIABILITY_THRESHOLD
  // (0.9), so checking it unconditionally flagged every brand-new provider
  // as ALSO "low_reliability", double-counting one signal ("we don't know
  // yet") as if it were a second, different one ("we know, and it's bad").
  const { reasons } = shouldRecommendVerification(
    { repJobsTotal: 0, reliability: 0.8 }, 4300);
  assert.deepEqual(reasons, ['new_provider'],
    'the neutral default must not also trigger low_reliability');
});

test('an established, reliable provider on a cheap job is NOT recommended', () => {
  const { recommended, reasons } = shouldRecommendVerification(
    { repJobsTotal: 500, reliability: 0.99 }, 4300);
  assert.equal(recommended, false);
  assert.deepEqual(reasons, []);
});

test('low reliability is flagged even for an established provider', () => {
  const { recommended, reasons } = shouldRecommendVerification(
    { repJobsTotal: 500, reliability: 0.7 }, 4300);
  assert.equal(recommended, true);
  assert.deepEqual(reasons, ['low_reliability']);
});

test('a high-value booking is flagged even for a trusted provider', () => {
  const { recommended, reasons } = shouldRecommendVerification(
    { repJobsTotal: 500, reliability: 0.99 }, 50_000);
  assert.equal(recommended, true);
  assert.deepEqual(reasons, ['high_value_job']);
});

test('multiple reasons can apply at once, and all are reported', () => {
  // An ESTABLISHED provider (repJobsTotal well past the new-provider
  // threshold) with a genuinely measured bad reliability, on a high-value
  // job -- unlike a brand-new provider, low_reliability here reflects a
  // real track record, not the neutral "no opinion yet" default, so it
  // correctly applies alongside high_value_job.
  const { recommended, reasons } = shouldRecommendVerification(
    { repJobsTotal: 200, reliability: 0.5 }, 50_000);
  assert.equal(recommended, true);
  assert.deepEqual(reasons.sort(), ['high_value_job', 'low_reliability']);
});

test('new_provider and low_reliability are mutually exclusive by construction', () => {
  // A provider is either too new to have a meaningful reliability score, or
  // established enough that its score means something -- never both
  // reasons on the same node, which would double-count one underlying
  // signal ("we don't have enough data") as two.
  for (const repJobsTotal of [0, 1, 4]) {
    const { reasons } = shouldRecommendVerification({ repJobsTotal, reliability: 0.1 }, 100);
    assert.ok(!reasons.includes('low_reliability'), `repJobsTotal=${repJobsTotal} is still "new"`);
  }
  const established = shouldRecommendVerification({ repJobsTotal: 5, reliability: 0.1 }, 100);
  assert.ok(established.reasons.includes('low_reliability'), 'repJobsTotal=5 has crossed into "established"');
});

test('missing reliability/repJobsTotal fields do not crash and default sensibly', () => {
  // A defensive check, not an expected real input -- searchCandidates
  // always supplies both -- but a policy function should not throw on
  // partial data, it should degrade to its safest assumption.
  assert.doesNotThrow(() => shouldRecommendVerification({}, 4300));
  const { reasons } = shouldRecommendVerification({}, 100);
  assert.ok(reasons.includes('new_provider'), 'missing repJobsTotal must not be treated as proven');
});
