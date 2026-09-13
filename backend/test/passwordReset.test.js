import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateResetToken, hashResetToken, RESET_TOKEN_TTL_MS } from '../src/auth/passwordReset.js';

test('a generated token hashes to the value stored alongside it', () => {
  const { token, tokenHash } = generateResetToken();
  assert.equal(hashResetToken(token), tokenHash);
});

test('the raw token is never equal to its own hash', () => {
  const { token, tokenHash } = generateResetToken();
  assert.notEqual(token, tokenHash,
    'if these were ever equal, the database would be storing the usable secret, not just its hash');
});

test('two generated tokens are different (real randomness, not a fixture)', () => {
  const a = generateResetToken();
  const b = generateResetToken();
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.tokenHash, b.tokenHash);
});

test('the token is high-entropy hex, not a short or predictable value', () => {
  const { token } = generateResetToken();
  assert.match(token, /^[0-9a-f]{64}$/, '32 bytes hex-encoded');
});

test('expiresAt is set roughly one hour out', () => {
  const before = Date.now();
  const { expiresAt } = generateResetToken();
  const delta = expiresAt.getTime() - before;
  assert.ok(Math.abs(delta - RESET_TOKEN_TTL_MS) < 1000, `expected ~${RESET_TOKEN_TTL_MS}ms, got ${delta}ms`);
});

test('hashing the same token twice is deterministic', () => {
  const { token } = generateResetToken();
  assert.equal(hashResetToken(token), hashResetToken(token));
});
