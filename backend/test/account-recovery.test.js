// Boots the REAL Express app on a real port (same pattern as
// dashboard.test.js and payment-flow.test.js) with a FAKE email sender
// injected via createApp's second argument -- real SMTP delivery is already
// proven for real in email.test.js against a live Ethereal account; what
// this file proves is the SERVER's own logic: token generation, single-use
// enforcement, expiry, and that a forgotten-password request never reveals
// whether an email is registered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/api/server.js';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://nodeva:nodeva_dev@localhost:5433/nodeva';
process.env.JWT_SECRET ??= crypto.randomBytes(32).toString('hex');

class FakeEmailSender {
  constructor() { this.sent = []; }
  async send(msg) { this.sent.push(msg); return { messageId: 'fake', accepted: [msg.to] }; }
  lastToken() {
    const last = this.sent.at(-1);
    return last?.text.match(/token=([0-9a-f]+)/)?.[1];
  }
}

let pool, server, base, mailer;
let dbAvailable = false;
try {
  pool = createPool(DATABASE_URL, { connectionTimeoutMillis: 2000 });
  await pool.query('SELECT 1');
  mailer = new FakeEmailSender();
  const { app } = createApp(pool, { emailSender: mailer });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
  dbAvailable = true;
} catch { /* skipped below */ }

const skip = !dbAvailable && 'requires a reachable Postgres (see docker-compose.yml)';
test.after(() => { server?.close(); pool?.end(); });

async function signup(email, password = 'correct horse battery staple') {
  const res = await fetch(`${base}/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, display_name: 'Test User' }),
  });
  return res.json();
}

async function login(email, password) {
  return fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

async function forgotPassword(email) {
  const res = await fetch(`${base}/auth/forgot-password`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  return { status: res.status, body: await res.json() };
}

async function resetPassword(token, new_password) {
  const res = await fetch(`${base}/auth/reset-password`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, new_password }),
  });
  return { status: res.status, body: await res.json() };
}

test('forgot-password for a real account sends an email with a working reset link', { skip }, async () => {
  const email = `recover-${crypto.randomUUID()}@test.local`;
  await signup(email);
  const before = mailer.sent.length;
  const { status, body } = await forgotPassword(email);
  assert.equal(status, 200);
  assert.match(body.message, /reset link has been sent/i);
  assert.equal(mailer.sent.length, before + 1);
  assert.equal(mailer.sent.at(-1).to, email);
  assert.ok(mailer.lastToken(), 'the email body must contain a usable reset link');
});

test('forgot-password for a NONEXISTENT email returns the identical response, revealing nothing', { skip }, async () => {
  const before = mailer.sent.length;
  const { status, body } = await forgotPassword(`nobody-${crypto.randomUUID()}@test.local`);
  assert.equal(status, 200);
  assert.match(body.message, /reset link has been sent/i);
  assert.equal(mailer.sent.length, before, 'no email should actually be sent for an unknown address');
});

test('a valid token resets the password, and the old password stops working', { skip }, async () => {
  const email = `recover-${crypto.randomUUID()}@test.local`;
  await signup(email, 'old password here');
  await forgotPassword(email);
  const token = mailer.lastToken();

  const { status, body } = await resetPassword(token, 'brand new password here');
  assert.equal(status, 200);
  assert.match(body.message, /updated/i);

  assert.equal((await login(email, 'old password here')).status, 401);
  assert.equal((await login(email, 'brand new password here')).status, 200);
});

test('a reset token can only be used once', { skip }, async () => {
  const email = `recover-${crypto.randomUUID()}@test.local`;
  await signup(email);
  await forgotPassword(email);
  const token = mailer.lastToken();

  assert.equal((await resetPassword(token, 'first new password')).status, 200);
  const second = await resetPassword(token, 'second new password');
  assert.equal(second.status, 400);
  assert.equal(second.body.error, 'invalid_or_expired_token');
});

test('requesting a second reset invalidates the first, unused token', { skip }, async () => {
  const email = `recover-${crypto.randomUUID()}@test.local`;
  await signup(email);
  await forgotPassword(email);
  const firstToken = mailer.lastToken();
  await forgotPassword(email);
  const secondToken = mailer.lastToken();
  assert.notEqual(firstToken, secondToken);

  const usingFirst = await resetPassword(firstToken, 'whatever');
  assert.equal(usingFirst.status, 400, 'an old email\'s link must stop working once a newer one is issued');

  const usingSecond = await resetPassword(secondToken, 'a genuinely new password');
  assert.equal(usingSecond.status, 200);
});

test('an expired token is rejected', { skip }, async () => {
  const email = `recover-${crypto.randomUUID()}@test.local`;
  await signup(email);
  await forgotPassword(email);
  const token = mailer.lastToken();
  await pool.query("UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = $1",
    [crypto.createHash('sha256').update(token).digest('hex')]);

  const { status, body } = await resetPassword(token, 'new password');
  assert.equal(status, 400);
  assert.equal(body.error, 'invalid_or_expired_token');
});

test('a garbage token is rejected with the same generic error as an expired one', { skip }, async () => {
  const { status, body } = await resetPassword('0'.repeat(64), 'new password');
  assert.equal(status, 400);
  assert.equal(body.error, 'invalid_or_expired_token');
});

test('reset-password requires both fields', { skip }, async () => {
  assert.equal((await resetPassword(undefined, 'x')).status, 400);
  assert.equal((await resetPassword('sometoken', undefined)).status, 400);
});

test('resetting to a too-short password is rejected the same way signup would reject it', { skip }, async () => {
  const email = `recover-${crypto.randomUUID()}@test.local`;
  await signup(email);
  await forgotPassword(email);
  const token = mailer.lastToken();
  const { status } = await resetPassword(token, 'short');
  assert.equal(status, 400);
});
