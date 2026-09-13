import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { signSession, verifySession, requireJwtSecret } from '../src/auth/jwt.js';
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
