import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit, _resetForTests } from '../src/auth/rateLimit.js';

// A minimal fake Express req/res -- this middleware only ever reads
// nothing off req except what keyFn extracts, and only ever calls
// res.set/status/json, so a full app isn't needed to exercise it for real.
function fakeReq() { return {}; }
function fakeRes() {
  const res = {
    statusCode: null, headers: {}, body: null,
    set(name, value) { res.headers[name] = value; return res; },
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
  };
  return res;
}

test.beforeEach(() => _resetForTests());

test('requests under the limit all pass through', () => {
  const mw = rateLimit({ windowMs: 60_000, max: 3, keyFn: () => 'k' });
  for (let i = 0; i < 3; i++) {
    let called = false;
    mw(fakeReq(), fakeRes(), () => { called = true; });
    assert.equal(called, true, `request ${i + 1} of 3 should pass`);
  }
});

test('the request that exceeds the limit is rejected with 429 and Retry-After', () => {
  const mw = rateLimit({ windowMs: 60_000, max: 2, keyFn: () => 'k' });
  mw(fakeReq(), fakeRes(), () => {});
  mw(fakeReq(), fakeRes(), () => {});
  let called = false;
  const res = fakeRes();
  mw(fakeReq(), res, () => { called = true; });
  assert.equal(called, false, 'the 3rd request must not reach the route handler');
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, 'too_many_requests');
  assert.ok(Number(res.headers['Retry-After']) > 0);
});

test('different keys are limited independently -- one IP hitting its limit does not affect another', () => {
  const mw = rateLimit({ windowMs: 60_000, max: 1, keyFn: (req) => req.key });
  let aCalled = false, bCalled = false;
  const a1 = fakeReq(); a1.key = 'a';
  mw(a1, fakeRes(), () => { aCalled = true; });
  const a2 = fakeReq(); a2.key = 'a';
  const resA2 = fakeRes();
  mw(a2, resA2, () => {});
  const b1 = fakeReq(); b1.key = 'b';
  mw(b1, fakeRes(), () => { bCalled = true; });
  assert.equal(aCalled, true);
  assert.equal(resA2.statusCode, 429, "a's second request should be blocked");
  assert.equal(bCalled, true, "b's first request must not be blocked by a's limit");
});

test('a falsy key is never rate-limited -- nothing meaningful to key on yet', () => {
  const mw = rateLimit({ windowMs: 60_000, max: 1, keyFn: () => null });
  for (let i = 0; i < 10; i++) {
    let called = false;
    mw(fakeReq(), fakeRes(), () => { called = true; });
    assert.equal(called, true, `request ${i + 1} with no key must always pass through`);
  }
});

test('the window resets after it elapses, without waiting for real time to pass', async () => {
  const mw = rateLimit({ windowMs: 10, max: 1, keyFn: () => 'k' });
  mw(fakeReq(), fakeRes(), () => {});
  const blocked = fakeRes();
  mw(fakeReq(), blocked, () => {});
  assert.equal(blocked.statusCode, 429);

  await new Promise((resolve) => setTimeout(resolve, 20));

  let calledAfterReset = false;
  mw(fakeReq(), fakeRes(), () => { calledAfterReset = true; });
  assert.equal(calledAfterReset, true, 'a new window must allow requests again');
});
