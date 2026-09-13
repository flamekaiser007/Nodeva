import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeResultHash, compareJobResults, groupIsComplete } from '../src/jobs/verification.js';

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
