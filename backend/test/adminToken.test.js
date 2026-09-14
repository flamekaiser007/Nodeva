import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireAdminToken } from '../src/auth/adminToken.js';

function fakeReq(headers = {}) { return { get: (name) => headers[name.toLowerCase()] }; }
function fakeRes() {
  const res = {
    statusCode: null, body: null,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
  };
  return res;
}

test.beforeEach(() => { delete process.env.ADMIN_TOKEN; });

test('disabled (no ADMIN_TOKEN set) 404s regardless of what header is sent', () => {
  const req = fakeReq({ 'x-admin-token': 'anything' });
  const res = fakeRes();
  let called = false;
  requireAdminToken(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'not_found');
});

test('the correct token passes through', () => {
  process.env.ADMIN_TOKEN = 'a-long-random-admin-secret';
  const req = fakeReq({ 'x-admin-token': 'a-long-random-admin-secret' });
  const res = fakeRes();
  let called = false;
  requireAdminToken(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('a wrong token 404s, not 401/403 -- do not confirm the route exists', () => {
  process.env.ADMIN_TOKEN = 'a-long-random-admin-secret';
  const req = fakeReq({ 'x-admin-token': 'guessed-wrong' });
  const res = fakeRes();
  let called = false;
  requireAdminToken(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 404);
});

test('a missing header is rejected the same way as a wrong one', () => {
  process.env.ADMIN_TOKEN = 'a-long-random-admin-secret';
  const req = fakeReq({});
  const res = fakeRes();
  let called = false;
  requireAdminToken(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 404);
});

test('a token of a different length than expected does not crash', () => {
  process.env.ADMIN_TOKEN = 'a-long-random-admin-secret';
  const req = fakeReq({ 'x-admin-token': 'short' });
  const res = fakeRes();
  assert.doesNotThrow(() => requireAdminToken(req, res, () => {}));
  assert.equal(res.statusCode, 404);
});

// A real, live-caught bug: Prometheus's own `bearer_token` scrape option
// (alerting/prometheus.yml) sends `Authorization: Bearer <token>`, not
// `x-admin-token` -- a real Prometheus container scraping a real running
// backend 404'd every time until this was fixed.
test('a standard "Authorization: Bearer <token>" header also passes -- what Prometheus actually sends', () => {
  process.env.ADMIN_TOKEN = 'a-long-random-admin-secret';
  const req = fakeReq({ authorization: 'Bearer a-long-random-admin-secret' });
  const res = fakeRes();
  let called = false;
  requireAdminToken(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('a wrong bearer token 404s the same way as a wrong x-admin-token', () => {
  process.env.ADMIN_TOKEN = 'a-long-random-admin-secret';
  const req = fakeReq({ authorization: 'Bearer guessed-wrong' });
  const res = fakeRes();
  let called = false;
  requireAdminToken(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 404);
});

test('x-admin-token takes precedence when both headers are somehow present', () => {
  process.env.ADMIN_TOKEN = 'a-long-random-admin-secret';
  const req = fakeReq({
    'x-admin-token': 'a-long-random-admin-secret',
    authorization: 'Bearer garbage-that-would-otherwise-fail',
  });
  const res = fakeRes();
  let called = false;
  requireAdminToken(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('a malformed Authorization header (no "Bearer " prefix) is rejected, not crashed on', () => {
  process.env.ADMIN_TOKEN = 'a-long-random-admin-secret';
  const req = fakeReq({ authorization: 'a-long-random-admin-secret' }); // missing "Bearer " prefix
  const res = fakeRes();
  assert.doesNotThrow(() => requireAdminToken(req, res, () => {}));
  assert.equal(res.statusCode, 404);
});
