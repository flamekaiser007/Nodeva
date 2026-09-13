import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  RazorpayGateway, UnconfiguredGateway, createGatewayFromEnv,
  verifyPaymentSignature, verifyWebhookSignature, RazorpayError,
} from '../src/payments/razorpay.js';

// --- signature verification: pure math, no external dependency needed -----

function razorpaySign(orderId, paymentId, keySecret) {
  return crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
}

test('a correctly signed payment callback verifies', () => {
  const keySecret = 'test_secret_abc';
  const sig = razorpaySign('order_1', 'pay_1', keySecret);
  assert.equal(
    verifyPaymentSignature({ orderId: 'order_1', paymentId: 'pay_1', signature: sig, keySecret }),
    true);
});

test('a tampered order id in the callback fails verification', () => {
  // The exact attack this exists to stop: a client claims a DIFFERENT,
  // possibly-unpaid order succeeded by reusing a signature meant for another.
  const keySecret = 'test_secret_abc';
  const sig = razorpaySign('order_1', 'pay_1', keySecret);
  assert.equal(
    verifyPaymentSignature({ orderId: 'order_ATTACKER', paymentId: 'pay_1', signature: sig, keySecret }),
    false);
});

test('a signature from the wrong key secret fails verification', () => {
  const sig = razorpaySign('order_1', 'pay_1', 'real_secret');
  assert.equal(
    verifyPaymentSignature({ orderId: 'order_1', paymentId: 'pay_1', signature: sig, keySecret: 'guessed_secret' }),
    false);
});

test('a malformed (non-hex, wrong length) signature is rejected, not thrown on', () => {
  assert.equal(
    verifyPaymentSignature({ orderId: 'o', paymentId: 'p', signature: 'not-hex-at-all', keySecret: 'k' }),
    false);
  assert.equal(
    verifyPaymentSignature({ orderId: 'o', paymentId: 'p', signature: undefined, keySecret: 'k' }),
    false);
});

test('webhook signature verifies against the exact raw body bytes', () => {
  const webhookSecret = 'whsec_test';
  const rawBody = '{"event":"payment.captured","payload":{"id":"pay_1"}}';
  const sig = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  assert.equal(verifyWebhookSignature({ rawBody, signature: sig, webhookSecret }), true);
});

test('webhook signature check fails if even whitespace in the body differs', () => {
  // This is exactly the canonical-encoding lesson from lib/canonical.js
  // applied to a different vendor's contract: re-serializing JSON is not
  // guaranteed to reproduce the bytes that were actually signed.
  const webhookSecret = 'whsec_test';
  const original = '{"event":"payment.captured"}';
  const reserialized = '{"event": "payment.captured"}'; // one extra space
  const sig = crypto.createHmac('sha256', webhookSecret).update(original).digest('hex');
  assert.equal(verifyWebhookSignature({ rawBody: reserialized, signature: sig, webhookSecret }), false);
});

// --- createGatewayFromEnv: the fork between real and honest-fake ----------

test('missing credentials produce the unconfigured gateway, not a crash', () => {
  const gw = createGatewayFromEnv({});
  assert.ok(gw instanceof UnconfiguredGateway);
  assert.equal(gw.isConfigured, false);
});

test('both credentials present produce the real gateway', () => {
  const gw = createGatewayFromEnv({ RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 'secret' });
  assert.ok(gw instanceof RazorpayGateway);
  assert.equal(gw.isConfigured, true);
});

test('only one of the two credentials is treated as unconfigured, not a half-broken real gateway', () => {
  assert.ok(createGatewayFromEnv({ RAZORPAY_KEY_ID: 'rzp_test_x' }) instanceof UnconfiguredGateway);
  assert.ok(createGatewayFromEnv({ RAZORPAY_KEY_SECRET: 'secret' }) instanceof UnconfiguredGateway);
});

test('the unconfigured gateway never touches the network and says so loudly', async () => {
  const gw = new UnconfiguredGateway();
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const order = await gw.createOrder(4300, 'receipt-1');
    assert.equal(order.amount, 4300);
    assert.ok(order.id.startsWith('local_'), 'must be visibly distinguishable from a real Razorpay id');
    assert.ok(warnings.some((w) => w.includes('no Razorpay credentials')));
  } finally {
    console.warn = originalWarn;
  }
});

// --- request SHAPE, verified against a mocked fetch -----------------------
// Cannot verify Razorpay's actual response without live credentials (see the
// file header) -- this verifies the OUTGOING request is correct per their
// documented API, which is the half of the contract under this code's control.

function withMockedFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts);
  };
  return fn(calls).finally(() => { globalThis.fetch = original; });
}

test('createOrder posts to the documented endpoint with Basic auth and the right body', () =>
  withMockedFetch(
    () => ({ ok: true, json: async () => ({ id: 'order_abc', amount: 4300, currency: 'INR' }) }),
    async (calls) => {
      const gw = new RazorpayGateway({ keyId: 'rzp_test_key', keySecret: 'rzp_test_secret' });
      const order = await gw.createOrder(4300, 'reservation-123');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://api.razorpay.com/v1/orders');
      assert.equal(calls[0].opts.method, 'POST');
      const expectedAuth = 'Basic ' + Buffer.from('rzp_test_key:rzp_test_secret').toString('base64');
      assert.equal(calls[0].opts.headers.authorization, expectedAuth);
      const body = JSON.parse(calls[0].opts.body);
      assert.deepEqual(body, { amount: 4300, currency: 'INR', receipt: 'reservation-123' });
      assert.equal(order.id, 'order_abc');
    }));

test('refund posts to the payment-scoped refund endpoint with the amount', () =>
  withMockedFetch(
    () => ({ ok: true, json: async () => ({ id: 'rfnd_1', payment_id: 'pay_1', status: 'processed' }) }),
    async (calls) => {
      const gw = new RazorpayGateway({ keyId: 'k', keySecret: 's' });
      await gw.refund('pay_1', 4300);
      assert.equal(calls[0].url, 'https://api.razorpay.com/v1/payments/pay_1/refund');
      assert.deepEqual(JSON.parse(calls[0].opts.body), { amount: 4300 });
    }));

test('a non-OK response raises RazorpayError with the response body attached, not a generic throw', () =>
  withMockedFetch(
    () => ({ ok: false, status: 400, json: async () => ({ error: { description: 'amount too small' } }) }),
    async () => {
      const gw = new RazorpayGateway({ keyId: 'k', keySecret: 's' });
      await assert.rejects(gw.createOrder(1, 'r'), (e) => {
        assert.ok(e instanceof RazorpayError);
        assert.equal(e.status, 400);
        assert.equal(e.body.error.description, 'amount too small');
        return true;
      });
    }));
