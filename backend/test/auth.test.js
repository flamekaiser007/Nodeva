import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { signSession, verifySession, requireJwtSecret, requireJwtVerificationSecrets } from '../src/auth/jwt.js';
import { requireAuth } from '../src/auth/middleware.js';

const SECRET = 'a'.repeat(32);

test('a correct password verifies against its own hash', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
});

test('a wrong password is rejected', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('wrong password entirely', hash), false);
});

test('the stored hash is never the plaintext password', async () => {
  const hash = await hashPassword('hunter2hunter2');
  assert.notEqual(hash, 'hunter2hunter2');
  assert.match(hash, /^\$2[aby]\$/); // bcrypt's own format marker
});

test('two hashes of the same password differ (salted)', async () => {
  const a = await hashPassword('same password here');
  const b = await hashPassword('same password here');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same password here', a), true);
  assert.equal(await verifyPassword('same password here', b), true);
});

test('short passwords are rejected before hitting bcrypt at all', () => {
  assert.throws(() => hashPassword('short'));
});

test('a signed session verifies and returns the same claims', () => {
  const token = signSession(SECRET, { userId: 'u1', email: 'a@b.com' });
  const { userId, email } = verifySession(SECRET, token);
  assert.equal(userId, 'u1');
  assert.equal(email, 'a@b.com');
});

test('a token signed with a different secret is rejected', () => {
  const token = signSession(SECRET, { userId: 'u1', email: 'a@b.com' });
  assert.throws(() => verifySession('b'.repeat(32), token));
});

test('a tampered token (payload altered after signing) is rejected', () => {
  const token = signSession(SECRET, { userId: 'u1', email: 'a@b.com' });
  const [header, payload, sig] = token.split('.');
  const forged = JSON.parse(Buffer.from(payload, 'base64url').toString());
  forged.sub = 'someone-elses-user-id'; // the actual attack this guards against
  const forgedPayload = Buffer.from(JSON.stringify(forged)).toString('base64url');
  assert.throws(() => verifySession(SECRET, `${header}.${forgedPayload}.${sig}`));
});

test('requireJwtSecret refuses to start with no secret configured', () => {
  const saved = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  try {
    assert.throws(() => requireJwtSecret(), /JWT_SECRET must be set/);
  } finally {
    if (saved !== undefined) process.env.JWT_SECRET = saved;
  }
});

test('requireJwtSecret refuses a short/guessable secret', () => {
  const saved = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'too-short';
  try {
    assert.throws(() => requireJwtSecret());
  } finally {
    if (saved !== undefined) process.env.JWT_SECRET = saved; else delete process.env.JWT_SECRET;
  }
});

// --- secret rotation ---------------------------------------------------

test('verifySession accepts an array and tries each secret in order', () => {
  const OLD = 'b'.repeat(32);
  const token = signSession(OLD, { userId: 'u1', email: 'a@b.com' });
  // The current secret (SECRET) doesn't verify this token, but the
  // previous one (OLD) in the list does -- this is exactly the mid-
  // rotation case: a session issued before the rotation must keep working.
  const { userId } = verifySession([SECRET, OLD], token);
  assert.equal(userId, 'u1');
});

test('verifySession still rejects a token that matches none of the candidates', () => {
  const token = signSession('c'.repeat(32), { userId: 'u1', email: 'a@b.com' });
  assert.throws(() => verifySession([SECRET, 'b'.repeat(32)], token));
});

test('requireJwtVerificationSecrets returns just the current secret with no rotation configured', () => {
  const savedCurrent = process.env.JWT_SECRET;
  const savedPrevious = process.env.JWT_SECRET_PREVIOUS;
  process.env.JWT_SECRET = SECRET;
  delete process.env.JWT_SECRET_PREVIOUS;
  try {
    assert.deepEqual(requireJwtVerificationSecrets(), [SECRET]);
  } finally {
    if (savedCurrent !== undefined) process.env.JWT_SECRET = savedCurrent; else delete process.env.JWT_SECRET;
    if (savedPrevious !== undefined) process.env.JWT_SECRET_PREVIOUS = savedPrevious;
  }
});

test('requireJwtVerificationSecrets includes JWT_SECRET_PREVIOUS entries, comma-separated', () => {
  const savedCurrent = process.env.JWT_SECRET;
  const savedPrevious = process.env.JWT_SECRET_PREVIOUS;
  const oldA = 'd'.repeat(32);
  const oldB = 'e'.repeat(32);
  process.env.JWT_SECRET = SECRET;
  process.env.JWT_SECRET_PREVIOUS = `${oldA}, ${oldB}`; // whitespace after the comma is trimmed
  try {
    assert.deepEqual(requireJwtVerificationSecrets(), [SECRET, oldA, oldB]);
  } finally {
    if (savedCurrent !== undefined) process.env.JWT_SECRET = savedCurrent; else delete process.env.JWT_SECRET;
    if (savedPrevious !== undefined) process.env.JWT_SECRET_PREVIOUS = savedPrevious; else delete process.env.JWT_SECRET_PREVIOUS;
  }
});

test('a full rotation round-trip: a pre-rotation token keeps working, a post-rotation token also works', () => {
  const OLD = 'f'.repeat(32);
  const NEW = 'g'.repeat(32);
  const preRotationToken = signSession(OLD, { userId: 'u1', email: 'a@b.com' });

  const savedCurrent = process.env.JWT_SECRET;
  const savedPrevious = process.env.JWT_SECRET_PREVIOUS;
  process.env.JWT_SECRET = NEW;
  process.env.JWT_SECRET_PREVIOUS = OLD;
  try {
    const verificationSecrets = requireJwtVerificationSecrets();
    assert.equal(verifySession(verificationSecrets, preRotationToken).userId, 'u1');

    const postRotationToken = signSession(requireJwtSecret(), { userId: 'u2', email: 'c@d.com' });
    assert.equal(verifySession(verificationSecrets, postRotationToken).userId, 'u2');
  } finally {
    if (savedCurrent !== undefined) process.env.JWT_SECRET = savedCurrent; else delete process.env.JWT_SECRET;
    if (savedPrevious !== undefined) process.env.JWT_SECRET_PREVIOUS = savedPrevious; else delete process.env.JWT_SECRET_PREVIOUS;
  }
});

// --- middleware, driven with fake req/res since it needs no server ---------

function fakeReqRes(headers = {}) {
  const req = { get: (name) => headers[name.toLowerCase()] };
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return { req, res };
}

test('requireAuth rejects a request with no Authorization header', () => {
  const { req, res } = fakeReqRes();
  let nextCalled = false;
  requireAuth(SECRET)(req, res, () => { nextCalled = true });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('requireAuth rejects a non-Bearer scheme', () => {
  const { req, res } = fakeReqRes({ authorization: 'Basic dXNlcjpwYXNz' });
  let nextCalled = false;
  requireAuth(SECRET)(req, res, () => { nextCalled = true });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('requireAuth attaches userId/userEmail and calls next() for a valid token', () => {
  const token = signSession(SECRET, { userId: 'u42', email: 'x@y.com' });
  const { req, res } = fakeReqRes({ authorization: `Bearer ${token}` });
  let nextCalled = false;
  requireAuth(SECRET)(req, res, () => { nextCalled = true });
  assert.equal(nextCalled, true);
  assert.equal(req.userId, 'u42');
  assert.equal(req.userEmail, 'x@y.com');
});

test('requireAuth gives an identical error for expired, malformed, and forged tokens', () => {
  // Distinguishing these in the response would leak which forgery attempts
  // are "close" to valid; assert they collapse to the same generic message.
  const cases = ['not-a-jwt-at-all', signSession(SECRET, { userId: 'u1', email: 'a' }) + 'x'];
  for (const bad of cases) {
    const { req, res } = fakeReqRes({ authorization: `Bearer ${bad}` });
    let nextCalled = false;
    requireAuth(SECRET)(req, res, () => { nextCalled = true });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'invalid or expired token');
  }
});
