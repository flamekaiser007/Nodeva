// Drives the REAL Express app on a real port with real fetch calls, same
// pattern as dashboard.test.js -- but with a FAKE Razorpay gateway injected
// via createApp's second argument, so the two-phase confirm/verify
// orchestration, the webhook handler, and the compensating-refund path are
// all exercised for real. The fake implements the exact same interface as
// RazorpayGateway (see payments/razorpay.js's file header for what is and
// is not verified against a live account) and produces real, correctly
// signed callbacks using the same HMAC algorithm the real gateway's
// verifyPaymentSignature checks against -- so this proves the SERVER's
// logic is correct, even though it cannot prove Razorpay's actual API
// behaves the way its docs say it will.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/api/server.js';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://nodeva:nodeva_dev@localhost:5433/nodeva';
process.env.JWT_SECRET ??= crypto.randomBytes(32).toString('hex');

const KEY_ID = 'rzp_test_fake';
const KEY_SECRET = 'fake_secret_for_tests';
const WEBHOOK_SECRET = 'fake_webhook_secret';

// A fake gateway that behaves exactly like Razorpay's documented contract:
// real order ids, real HMAC signatures computable by the test, and a
// controllable failure mode for the refund path.
class FakeRazorpayGateway {
  constructor() { this.orders = new Map(); this.refunds = []; this.refundShouldFail = false; }
  get isConfigured() { return true; }
  get keyId() { return KEY_ID; }
  get keySecret() { return KEY_SECRET; }
  async createOrder(amountPaise, receipt) {
    const id = `order_${crypto.randomUUID()}`;
    this.orders.set(id, { amount: amountPaise, receipt });
    return { id, amount: amountPaise, currency: 'INR', status: 'created' };
  }
  async refund(paymentId, amountPaise) {
    if (this.refundShouldFail) throw new Error('simulated gateway outage');
    this.refunds.push({ paymentId, amountPaise });
    return { id: `rfnd_${crypto.randomUUID()}`, payment_id: paymentId, status: 'processed' };
  }
  signPayment(orderId, paymentId) {
    return crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  }
}

let pool, server, base, fakeGateway;
let dbAvailable = false;
try {
  pool = createPool(DATABASE_URL, { connectionTimeoutMillis: 2000 });
  await pool.query('SELECT 1');
  fakeGateway = new FakeRazorpayGateway();
  const { app } = createApp(pool, { paymentGateway: fakeGateway });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
  dbAvailable = true;
} catch { /* skipped below */ }

const skip = !dbAvailable && 'requires a reachable Postgres (see docker-compose.yml)';
test.after(() => { server?.close(); pool?.end(); });

function authed(token) { return { authorization: `Bearer ${token}` }; }
async function json(res) { return res.json(); }

async function setUpBookableReservation() {
  const buyer = await json(await fetch(`${base}/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `buyer-${crypto.randomUUID()}@test.local`,
      password: 'correct horse battery staple', display_name: 'Buyer',
    }),
  }));
  const providerAuth = await json(await fetch(`${base}/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `provider-${crypto.randomUUID()}@test.local`,
      password: 'correct horse battery staple', display_name: 'Provider',
    }),
  }));
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(providerAuth.token) });
  const pubKey = crypto.randomBytes(32).toString('hex');
  const { node_id } = await json(await fetch(`${base}/nodes`, {
    method: 'POST', headers: { ...authed(providerAuth.token), 'content-type': 'application/json' },
    body: JSON.stringify({
      public_key_hex: pubKey, gpu_model: 'RTX 4090',
      gpu_vram_mb: 24576, cpu_cores: 16, ram_mb: 32768, price_paise_hr: 4300,
    }),
  }));
  // No worker is connected in this test, so hub.commitReservation will
  // always throw NodeOffline -- deliberately: these tests are about the
  // PAYMENT orchestration, not the node round trip (already covered
  // end-to-end by scripts/e2e_demo.sh). A reservation row is inserted
  // directly rather than going through POST /reservations, which requires
  // a live signed receipt this test has no worker to produce.
  const reservationId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO reservations
       (reservation_id, node_id, user_id, slot, price_paise_hr, quoted_paise, status)
     VALUES ($1,$2,$3, tstzrange($4,$5), 4300, 4300, 'held')`,
    [reservationId, node_id, buyer.user.id,
     new Date('2028-02-01T10:00:00Z'), new Date('2028-02-01T11:00:00Z')]);
  return { buyer, reservationId };
}

test('confirm with a configured gateway creates an order and does NOT touch the ledger yet', { skip }, async () => {
  const { buyer, reservationId } = await setUpBookableReservation();
  const res = await fetch(`${base}/reservations/${reservationId}/confirm`, {
    method: 'POST', headers: authed(buyer.token),
  });
  const body = await res.json();
  assert.equal(body.requires_payment, true);
  assert.ok(body.order_id.startsWith('order_'));
  assert.equal(body.amount_paise, 4300);
  assert.equal(body.razorpay_key_id, KEY_ID);

  const resvStatus = await pool.query(
    'SELECT status FROM reservations WHERE reservation_id=$1', [reservationId]);
  assert.equal(resvStatus.rows[0].status, 'held',
    'creating the order must not confirm the reservation before payment is verified');

  const paymentRow = await pool.query(
    'SELECT status, gateway FROM payments WHERE reservation_id=$1', [reservationId]);
  assert.deepEqual(paymentRow.rows[0], { status: 'created', gateway: 'razorpay' });
});

test('a forged payment signature is rejected and never reaches the node or the ledger', { skip }, async () => {
  const { buyer, reservationId } = await setUpBookableReservation();
  const { order_id } = await json(await fetch(`${base}/reservations/${reservationId}/confirm`, {
    method: 'POST', headers: authed(buyer.token),
  }));

  const res = await fetch(`${base}/reservations/${reservationId}/confirm/verify`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({
      razorpay_order_id: order_id, razorpay_payment_id: 'pay_attacker',
      razorpay_signature: '0'.repeat(64), // well-formed hex, wrong value
    }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_payment_signature');

  const paymentRow = await pool.query(
    'SELECT status FROM payments WHERE reservation_id=$1', [reservationId]);
  assert.equal(paymentRow.rows[0].status, 'failed');
  const resvStatus = await pool.query(
    'SELECT status FROM reservations WHERE reservation_id=$1', [reservationId]);
  assert.equal(resvStatus.rows[0].status, 'held', 'must not have advanced past held');
});

test('a genuinely signed payment is accepted, and a subsequently unreachable node triggers a real compensating refund', { skip }, async () => {
  // No worker is connected to this test node, so commitNodeAndCapture WILL
  // fail with node_unreachable -- this is deliberately exercising the fork
  // this commit added: once Razorpay confirms payment, an unreachable node
  // is no longer "safely never captured", it is a real charge that must be
  // refunded through the gateway, not just marked internally.
  const { buyer, reservationId } = await setUpBookableReservation();
  const { order_id } = await json(await fetch(`${base}/reservations/${reservationId}/confirm`, {
    method: 'POST', headers: authed(buyer.token),
  }));
  const paymentId = `pay_${crypto.randomUUID()}`;
  const signature = fakeGateway.signPayment(order_id, paymentId);

  const res = await fetch(`${base}/reservations/${reservationId}/confirm/verify`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({
      razorpay_order_id: order_id, razorpay_payment_id: paymentId, razorpay_signature: signature,
    }),
  });
  assert.equal(res.status, 409, 'no worker connected -- the node commit must fail');
  const body = await res.json();
  assert.equal(body.refund_status, 'refunded');

  assert.equal(fakeGateway.refunds.length, 1);
  assert.deepEqual(fakeGateway.refunds[0], { paymentId, amountPaise: 4300 });

  const paymentRow = await pool.query(
    'SELECT status FROM payments WHERE reservation_id=$1', [reservationId]);
  assert.equal(paymentRow.rows[0].status, 'refunded');
  const resvStatus = await pool.query(
    'SELECT status FROM reservations WHERE reservation_id=$1', [reservationId]);
  assert.equal(resvStatus.rows[0].status, 'expired');
});

test('a valid signature for the WRONG order (id substitution) is rejected', { skip }, async () => {
  // Confirms the payment lookup is scoped to (reservation_id, order_id, 'created')
  // -- a signature valid for some OTHER order must not authorize this one,
  // even if it is cryptographically well-formed.
  const a = await setUpBookableReservation();
  const b = await setUpBookableReservation();
  const orderA = (await json(await fetch(`${base}/reservations/${a.reservationId}/confirm`, {
    method: 'POST', headers: authed(a.buyer.token),
  }))).order_id;
  await fetch(`${base}/reservations/${b.reservationId}/confirm`, {
    method: 'POST', headers: authed(b.buyer.token),
  });

  // A real payment for order A, replayed against reservation B's endpoint.
  const paymentId = `pay_${crypto.randomUUID()}`;
  const signature = fakeGateway.signPayment(orderA, paymentId);
  const res = await fetch(`${base}/reservations/${b.reservationId}/confirm/verify`, {
    method: 'POST', headers: { ...authed(b.buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({ razorpay_order_id: orderA, razorpay_payment_id: paymentId, razorpay_signature: signature }),
  });
  assert.equal(res.status, 404, "order A's payment record does not belong to reservation B");
});

test('the webhook is rejected without a valid signature', { skip }, async () => {
  const bodyObj = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', order_id: 'order_x' } } } };
  const res = await fetch(`${base}/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'deadbeef'.repeat(8) },
    body: JSON.stringify(bodyObj),
  });
  // RAZORPAY_WEBHOOK_SECRET is not set in this test's environment, so the
  // endpoint refuses outright rather than accepting an unsigned event --
  // the more dangerous of the two failure modes to get backwards.
  assert.equal(res.status, 500);
});

test('the webhook confirms a payment and, with no worker connected, also refunds it', { skip }, async () => {
  // No live Razorpay account exists to send this project a real webhook --
  // so this constructs exactly the payload shape Razorpay's docs specify
  // (event + payload.payment.entity.{id,order_id}) and signs it with the
  // real algorithm (HMAC-SHA256 over the raw body), the same way the
  // signature-verification unit tests in razorpay.test.js do. This proves
  // the SERVER's webhook logic end to end; it cannot prove Razorpay's real
  // webhook delivery matches this shape byte-for-byte, which is exactly the
  // untested-against-a-live-account gap this file's header and
  // razorpay.js's both already name.
  const savedSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  try {
    const { buyer, reservationId } = await setUpBookableReservation();
    const { order_id } = await json(await fetch(`${base}/reservations/${reservationId}/confirm`, {
      method: 'POST', headers: authed(buyer.token),
    }));
    const paymentId = `pay_${crypto.randomUUID()}`;

    const payload = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: paymentId, order_id, amount: 4300 } } },
    });
    const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');

    const res = await fetch(`${base}/webhooks/razorpay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature },
      body: payload,
    });
    assert.equal(res.status, 200);

    // No worker is connected to this node, so commitNodeAndCapture fails --
    // the webhook must compensate exactly like the direct-verify endpoint does.
    const paymentRow = await pool.query(
      'SELECT status FROM payments WHERE reservation_id=$1', [reservationId]);
    assert.equal(paymentRow.rows[0].status, 'refunded',
      'the webhook path must refund on node failure just like /confirm/verify does');
    assert.ok(fakeGateway.refunds.some((r) => r.paymentId === paymentId));

    const resvStatus = await pool.query(
      'SELECT status FROM reservations WHERE reservation_id=$1', [reservationId]);
    assert.equal(resvStatus.rows[0].status, 'expired');
  } finally {
    if (savedSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
    else process.env.RAZORPAY_WEBHOOK_SECRET = savedSecret;
  }
});

test('a webhook with a forged signature is rejected even with the secret configured', { skip }, async () => {
  const savedSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  try {
    const payload = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_forged', order_id: 'order_forged' } } },
    });
    const res = await fetch(`${base}/webhooks/razorpay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': '0'.repeat(64) },
      body: payload,
    });
    assert.equal(res.status, 400);
  } finally {
    if (savedSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
    else process.env.RAZORPAY_WEBHOOK_SECRET = savedSecret;
  }
});
