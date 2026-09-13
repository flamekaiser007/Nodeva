import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImageRef, checkImageAllowed } from '../src/jobs/imageAllowlist.js';

test.afterEach(() => { delete process.env.ALLOWED_IMAGE_REPOS; });

// --- parseImageRef -----------------------------------------------------

test('a bare repo with no tag defaults to "latest"', () => {
  assert.deepEqual(parseImageRef('alpine'), { repo: 'alpine', ref: 'latest', pinned: false });
});

test('a repo:tag splits on the tag separator', () => {
  assert.deepEqual(parseImageRef('alpine:3.20'), { repo: 'alpine', ref: '3.20', pinned: false });
});

test('a namespaced repo:tag splits correctly', () => {
  assert.deepEqual(parseImageRef('pytorch/pytorch:2.4.0'),
    { repo: 'pytorch/pytorch', ref: '2.4.0', pinned: false });
});

test('a digest reference is recognized as pinned', () => {
  const ref = parseImageRef('alpine@sha256:' + 'a'.repeat(64));
  assert.equal(ref.repo, 'alpine');
  assert.equal(ref.pinned, true);
});

test('a registry port is not mistaken for a tag separator', () => {
  // "localhost:5000/alpine" has a colon, but it belongs to the registry
  // host, not a tag -- the whole thing (no tag) must be treated as the repo.
  assert.deepEqual(parseImageRef('localhost:5000/alpine'),
    { repo: 'localhost:5000/alpine', ref: 'latest', pinned: false });
});

test('a registry port WITH a tag still finds the real tag separator', () => {
  assert.deepEqual(parseImageRef('localhost:5000/alpine:3.20'),
    { repo: 'localhost:5000/alpine', ref: '3.20', pinned: false });
});

test('an empty or non-string image is not parseable', () => {
  assert.equal(parseImageRef(''), null);
  assert.equal(parseImageRef(undefined), null);
  assert.equal(parseImageRef(null), null);
});

// --- checkImageAllowed ---------------------------------------------------

test('a default-allowlisted repo is allowed regardless of tag', () => {
  assert.equal(checkImageAllowed('alpine:3.20').allowed, true);
  assert.equal(checkImageAllowed('python:3.12-slim').allowed, true);
  assert.equal(checkImageAllowed('pytorch/pytorch:2.4.0').allowed, true);
});

test('an arbitrary, non-allowlisted repo is rejected with a reason naming it', () => {
  const { allowed, reason } = checkImageAllowed('some-stranger/totally-safe-miner:latest');
  assert.equal(allowed, false);
  assert.match(reason, /some-stranger\/totally-safe-miner/);
});

test('a missing image is rejected without crashing', () => {
  assert.equal(checkImageAllowed(undefined).allowed, false);
  assert.equal(checkImageAllowed('').allowed, false);
});

test('ALLOWED_IMAGE_REPOS overrides the default list', () => {
  process.env.ALLOWED_IMAGE_REPOS = 'my-org/approved-image';
  assert.equal(checkImageAllowed('my-org/approved-image:v1').allowed, true);
  assert.equal(checkImageAllowed('alpine:3.20').allowed, false,
    'the default list must not still apply once an override is set');
});
