// Razorpay integration.
//
// HONESTY NOTE, matching the precedent set by worker/nodeva_worker/executor.py's
// GPU passthrough: this file implements Razorpay's documented API contract
// correctly, but has never been run against a live account -- this project
// has no Razorpay credentials (a merchant/developer account is something only
// the project owner can create; it isn't something that can be signed up for
// on someone's behalf). What IS verified here, for real, with no external
// dependency needed:
//   - signature verification (verifyPaymentSignature, verifyWebhookSignature)
//     is pure HMAC-SHA256 math, tested against hand-constructed vectors using
//     Razorpay's documented algorithm exactly
//   - the shape of every outgoing request (URL, auth header, body) is tested
//     against a mocked fetch, so a typo in the endpoint or a wrong auth
//     scheme would be caught even without live credentials
// What is NOT verified: that Razorpay's actual API responds the way its docs
// say it will. Treat this the same way as the untested GPU code path --
// implemented in good faith against the spec, needs real-account validation
// before being trusted with real money.

import crypto from 'node:crypto';

const API_BASE = 'https://api.razorpay.com/v1';

export class RazorpayError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class RazorpayGateway {
  constructor({ keyId, keySecret }) {
    if (!keyId || !keySecret) {
      throw new Error('RazorpayGateway requires both keyId and keySecret');
    }
    this.keyId = keyId;
    this.keySecret = keySecret;
  }

  get isConfigured() { return true; }

  _authHeader() {
    return 'Basic ' + Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64');
  }

  /** Creates a Razorpay Order for a given amount. Razorpay orders are always
   * created server-side and their id handed to Checkout.js client-side --
   * the amount is never trusted from the browser after this point. */
  async createOrder(amountPaise, receipt) {
    const res = await fetch(`${API_BASE}/orders`, {
      method: 'POST',
      headers: { authorization: this._authHeader(), 'content-type': 'application/json' },
      // Razorpay's "paise" IS our paise for INR -- both are the currency's
      // smallest unit, so no conversion needed, which is a happy accident of
      // both using the same subdivision, not a coincidence to rely on if this
      // ever supports a currency where that is not true.
      body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new RazorpayError('order creation failed', res.status, body);
    return body; // { id, amount, currency, status, ... }
  }

  async refund(paymentId, amountPaise) {
    const res = await fetch(`${API_BASE}/payments/${paymentId}/refund`, {
      method: 'POST',
      headers: { authorization: this._authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ amount: amountPaise }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new RazorpayError('refund failed', res.status, body);
    return body; // { id, payment_id, amount, status, ... }
  }
}

/** Stand-in used when no Razorpay credentials are configured. Never makes a
 * network call, and is loud about why: a deployment running with this in
 * place is NOT taking real payments, no matter what the rest of the code
 * thinks is happening, and that must never be silent. */
export class UnconfiguredGateway {
  get isConfigured() { return false; }

  async createOrder(amountPaise, receipt) {
    console.warn(
      `[payments] no Razorpay credentials configured -- creating a LOCAL-ONLY ` +
      `pseudo-order for receipt ${receipt}. No real payment gateway is involved; ` +
      `this deployment cannot take real money.`);
    return { id: `local_${crypto.randomUUID()}`, amount: amountPaise, currency: 'INR', status: 'created' };
  }

  async refund(paymentId) {
    console.warn(
      `[payments] no Razorpay credentials configured -- refund for ${paymentId} ` +
      `recorded in the internal ledger only. No money actually moves.`);
    return { id: `local_refund_${crypto.randomUUID()}`, payment_id: paymentId, status: 'processed' };
  }
}

export function createGatewayFromEnv(env = process.env) {
  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = env;
  if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
    return new RazorpayGateway({ keyId: RAZORPAY_KEY_ID, keySecret: RAZORPAY_KEY_SECRET });
  }
  return new UnconfiguredGateway();
}

// --- signature verification --------------------------------------------
//
// Both of these are exactly Razorpay's documented algorithm. This is the
// part of the whole integration that is fully, genuinely verified: HMAC-SHA256
// has no "maybe the vendor's servers behave differently" risk the way an HTTP
// round trip does.

/** Verifies the payload Checkout.js hands back to the client after a
 * successful payment, per Razorpay's documented scheme:
 *   expected = HMAC_SHA256(order_id + "|" + payment_id, key_secret)
 * This is NOT optional -- Checkout.js's client-side callback firing is not
 * proof a payment happened; only this signature (or the webhook, which
 * carries the same guarantee from Razorpay's servers directly) is. */
export function verifyPaymentSignature({ orderId, paymentId, signature, keySecret }) {
  const expected = crypto
    .createHmac('sha256', keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return timingSafeEqualHex(expected, signature);
}

/** Verifies a webhook's X-Razorpay-Signature header against the raw request
 * body, per Razorpay's documented scheme:
 *   expected = HMAC_SHA256(raw_body, webhook_secret)
 * Must run against the RAW bytes as received, before any JSON parsing --
 * re-serializing a parsed body is not guaranteed to reproduce the exact
 * bytes Razorpay signed (key order, whitespace, number formatting can all
 * differ), the same class of problem this project already solved once for
 * node-to-platform receipts (see backend/src/lib/canonical.js). */
export function verifyWebhookSignature({ rawBody, signature, webhookSecret }) {
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody)
    .digest('hex');
  return timingSafeEqualHex(expected, signature);
}

function timingSafeEqualHex(a, b) {
  if (typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  // Different lengths would throw inside timingSafeEqual; treat as a clean
  // mismatch instead -- an attacker probing signature length must not get a
  // different error shape than one probing signature content.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
