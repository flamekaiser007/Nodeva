# Payment architecture

Matches the master design's non-negotiable: **payments are fully centralized,
conventional rails, no blockchain.** This document is the honest account of
what that looks like once it touches a real gateway.

## Why Razorpay, and the one thing this project cannot do

Razorpay was chosen because it matches the brief exactly (UPI, cards,
netbanking, INR-native) and because its documented API is simple enough to
implement correctly without a live account to test against.

**This project has no Razorpay credentials, and cannot get any on its own.**
Creating a merchant/developer account is an action that belongs to whoever
actually runs this platform — it needs a real business identity, phone/email
verification, and eventually settlement bank details. No amount of code can
substitute for that. Everything below is implemented against Razorpay's
*published* API contract, in good faith, and has never made a real HTTP call
to Razorpay's servers. Treat it the way `docs/security-model.md` treats GPU
passthrough on a machine with no NVIDIA card: written correctly against the
spec, unverified against the real thing, needs validation with actual test
keys before it is trusted with real money.

What **is** genuinely verified, with no external account needed:

- **Signature verification is pure HMAC-SHA256 math.** `verifyPaymentSignature`
  and `verifyWebhookSignature` in `backend/src/payments/razorpay.js` implement
  Razorpay's documented algorithms exactly, and are tested against
  hand-constructed vectors — tampering, wrong secrets, malformed input, all
  covered the same way `lib/verify.js`'s receipt signatures were.
- **The shape of every outgoing request** (endpoint, Basic-auth header,
  body) is tested against a mocked `fetch` in `test/razorpay.test.js`.
- **The full server-side orchestration** — order creation, signature
  verification, commit-and-capture, the compensating refund when a node
  turns out unreachable after payment — is tested end to end in
  `test/payment-flow.test.js` against a **fake gateway that speaks the
  identical wire protocol**, driven through the real Express app on a real
  port. This proves the platform's own logic is correct; it cannot prove
  Razorpay's real API responds the way its docs promise.

## The two-phase confirm, and why it's two phases

`POST /reservations/:id/confirm` used to do everything in one step: commit
the node's hold, capture the quoted amount from escrow. With a live gateway
that single step splits in two, because real money changing hands is not
something a browser callback alone can prove happened.

```
Buyer clicks "Confirm & Pay"
        │
        ▼
POST /reservations/:id/confirm
        │  creates a Razorpay Order for the quoted amount
        │  inserts a `payments` row, status='created'
        │  does NOT touch the node or escrow yet
        ▼
Frontend opens Razorpay Checkout.js with {order_id, key_id}
        │  buyer pays (UPI / card / netbanking, in test mode: a test card)
        ▼
Checkout.js's client-side handler fires with
  {razorpay_order_id, razorpay_payment_id, razorpay_signature}
        │
        ▼
POST /reservations/:id/confirm/verify
        │  verifies the signature -- NOT optional; a client callback firing
        │  is not proof a payment happened, only Razorpay's signature is
        │  (or the webhook below, which carries the same guarantee)
        │
        ├── invalid ──► payments.status='failed', reservation untouched
        │
        └── valid ──► payments.status='captured' (real money HAS moved now)
                       │
                       ▼
                  commitNodeAndCapture (the same node-commit + escrow
                  capture the no-gateway path always did)
                       │
                       ├── node reachable ──► reservation confirmed
                       │
                       └── node unreachable ──► **the fork the no-gateway
                            path never had to make**: this is no longer
                            "safely never captured", it is a real charge for
                            a slot that cannot be delivered. A compensating
                            refund is issued through the gateway
                            automatically, and payments.status becomes
                            'refunded'. If the refund call itself fails, that
                            is logged as CRITICAL for manual follow-up
                            rather than silently lost -- there is no retry
                            queue yet (see "what's not solved" below).
```

The **webhook** (`POST /webhooks/razorpay`) exists because the path above has
a gap: a buyer who closes the browser tab immediately after paying, before
Checkout.js's callback fires or before the `verify` request completes, has
paid Razorpay but the platform never finds out. Razorpay's webhook is sent
from their servers directly, independent of that browser tab, and carries
the same cryptographic guarantee as the client-side signature (a different
HMAC secret, but the same idea). The webhook handler runs the identical
`commitNodeAndCapture` + compensating-refund logic — confirmed by
`payment-flow.test.js` to behave the same way the direct-verify path does,
which is the property that matters: **it must not matter which of the two
paths is the one that actually reaches a given payment.**

## Falling back honestly when no gateway is configured

`createGatewayFromEnv()` returns an `UnconfiguredGateway` when
`RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` are unset — which is the state every
test, the e2e script, and this whole project have run in so far. It:

- never makes a network call
- creates a `local_<uuid>`-prefixed pseudo-order, visibly distinguishable
  from a real Razorpay id
- logs a loud warning naming exactly what is and isn't happening, every time
- proceeds straight to `commitNodeAndCapture`, matching the platform's
  behavior before this feature existed, so nothing that worked before
  regressed

A `payments` row is still inserted in this mode (`gateway='none'`) — the
table (defined since the very first migration, unused until this) is now the
single audit trail regardless of which mode produced a given charge.

## What's not solved yet

- **No retry queue for a failed compensating refund.** If the gateway's
  refund call itself fails right after a node turns out unreachable, the
  current answer is a `console.error` marked CRITICAL and a human has to
  notice it. A real deployment needs this to be a durable, retried job, not
  a log line.
- **Live-account validation.** Everything named above as "not verified"
  needs a real Razorpay test-mode account (free to create, requires no
  business verification for test keys) before this should be trusted beyond
  a demo. The integration is written to make that a matter of setting two
  environment variables and running the existing test suite again, not a
  rewrite.
- **Idempotency under true concurrency.** The webhook and the direct-verify
  path are both idempotent against the reservation's own state machine
  (`canTransition` refuses a second `CONFIRMED` transition), but a genuine
  race between them landing in the same instant has not been stress-tested.
