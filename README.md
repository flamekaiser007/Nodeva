# NODEVA

A compute marketplace for underutilized GPUs: people with idle hardware rent it
out, people who need a GPU for an hour rent it in.

## Architecture, stated honestly

**This is not a decentralized system. It is a hybrid one.**

| Centralized | Distributed |
|---|---|
| identity, auth, accounts | provider machines and their GPUs |
| PostgreSQL | resource advertisements |
| payment gateway, escrow, settlement | availability and reservations (node-authoritative) |
| payouts, refunds, disputes | job execution and sandboxing |
| reputation (for now) | peer discovery (Phase 2) |

The claim worth defending is narrower and truer than "decentralized compute":
**compute and marketplace coordination are distributed across independently
owned nodes; identity and money are not.**

There is no blockchain in this system, deliberately. Payments run on
conventional rails because escrow, refunds, and chargebacks are the actual hard
part and a chain makes all three harder.

## The load-bearing idea

The provider node — not the central scheduler — is authoritative over its own
hardware. The database is a **search index over what nodes claim**, not a record
of what is true. Nothing is promised to a user without a signed receipt from the
node itself. See [docs/reservation-protocol.md](docs/reservation-protocol.md).

## Status

Phase 1, early. What exists and is tested:

- `backend/migrations/001_init.sql` — schema, with double-booking prevented by a
  GiST exclusion constraint and money held in a balanced double-entry ledger
  (integer paise; the balance invariant is enforced by a deferred trigger).
- `backend/src/reservations/machine.js` — reservation lifecycle as an explicit
  edge list. Illegal transitions throw.
- `backend/src/marketplace/scheduler.js` — requirement filtering and
  reliability-adjusted ranking.
- `backend/src/payments/settle.js` — exact 90/10 split, pro-rata quoting,
  metered billing for user-caused failures.
- `worker/nodeva_worker/reservations.py` — the node-side authoritative lock.
  32 threads racing for one slot elect exactly one winner.
- `worker/nodeva_worker/identity.py` — Ed25519 node identity; receipts signed
  here verify in the backend, proven by a cross-language test.
- `worker/nodeva_worker/hardware.py` — GPU detection, advertising only VRAM
  that is actually free.
- `backend/src/ws/hub.js` + `worker/nodeva_worker/link.py` — the transport.
  The worker dials **out** and stays connected, because most consumer GPUs
  sit behind NAT and cannot accept an inbound connection; the platform pushes
  reservation requests down that connection instead. Auth is
  challenge-response against the node's registered public key, not a bearer
  token — proving possession of the private key on every connection.
- `backend/src/api/server.js` — HTTP API: enroll a node, search, reserve,
  confirm (capture into escrow), submit a job, complete/settle (automatic on
  job result, or manual for testing).
- `worker/nodeva_worker/executor.py` — sandboxed Docker execution: read-only
  root filesystem, no capabilities, no network by default, memory/CPU/pid
  limits, non-root, wall-clock timeout. Every control is tested against a
  real container in `worker/tests/test_executor.py`, not just asserted from
  the flag name. See `docs/security-model.md` for what this does and does
  NOT protect against -- notably, nothing here protects the user from a
  malicious provider; that direction is unsolved.
- `scripts/e2e_demo.sh` — boots a real Postgres, backend, and Python worker
  and drives the full loop over an actual network connection: a live signed
  receipt, a denied double-booking from the running node, an exact ledger
  settlement, and detection of a killed worker process. Not mocked.

- `frontend/` — React + Tailwind marketplace UI: sign up / log in, requirement-based
  search (not a GPU-model picker), reserve, confirm & pay, submit a job, watch it
  run. Verified against the real running stack end to end -- a browser
  click produces a signed reservation receipt, runs a real Docker container
  on the worker, and settles the ledger, with the actual container stdout
  displayed back in the page.
- `backend/src/auth/` — real signup/login: bcrypt password hashing (cost 12),
  JWT sessions (HS256, 24h expiry, `JWT_SECRET` required at startup -- the
  server refuses to boot on a missing or short secret rather than silently
  generating one). Every endpoint that used to trust a client-supplied
  `user_id`/`provider_id` now derives it from the verified token instead;
  `/reservations/:id/confirm`, `/jobs`, and `/complete` also check that the
  caller owns the reservation before acting on it or returning its data.
- `backend/src/reservations/reconciler.js` — fixes a real shipped bug: a
  reservation nobody ever confirmed used to sit `held` in Postgres forever,
  even after the node's own hold TTL freed the slot locally, so the GiST
  exclusion constraint falsely rejected a later booking of that same,
  actually-free slot. Reproduced against a live worker, fixed, and pinned by
  a test that fails the same way the bug did before the fix (a real INSERT
  against a real exclusion constraint, not a mock). Runs opportunistically
  before a booking attempt and on a 15s sweep. The one related case this
  file's failure matrix once named as still open -- a lost `RESERVE_COMMIT`
  acknowledgment -- is also closed now; see the `RESERVATION_STATUS_QUERY`
  entry further down.
- `backend/src/providers/reputation.js` — another shipped-but-silent gap:
  `providers.rep_jobs_total`/`rep_jobs_failed` were read by the scheduler's
  reliability ranking (`marketplace/nodeStore.js`) but never written by
  anything, ever -- every provider's computed reliability was permanently
  stuck at the neutral 0.8 default regardless of actual outcomes. Fixed by
  updating both counters on every settlement, with a policy worth stating
  explicitly: the user's own workload failing does NOT count against the
  provider that faithfully ran it, and a booking that expires or is
  cancelled before any job runs carries no reputation signal at all --
  only `completed` and `failed_provider` move the numbers, in the direction
  that actually reflects whether the node upheld its end. Verified against
  real Postgres that the write path (settlement) and read path (the
  scheduler's reliability formula) agree exactly, and against the live e2e
  stack that a real container run moves a real counter for the first time.
- `frontend/src/components/ProviderDashboard.jsx` + `GET /providers/me/dashboard`
  — the provider side of the marketplace finally has a page: live node
  status/GPU telemetry (heartbeats were being received and discarded until
  this -- `onHeartbeat` only ever wrote `last_seen_at`), earnings broken
  into today/week/month/lifetime, reputation, and node enrollment (public
  key only -- the private key is generated and stays on the provider's own
  machine by the Compute Worker, never typed into a browser). One account,
  two roles: a `Rent GPU` / `Share GPU` toggle, not a second signup.
  Building the earnings query surfaced a real, easy-to-miss bug: Postgres
  promotes `SUM(bigint_column)` to `NUMERIC`, which the project's BIGINT
  type-parser override doesn't cover, so an uncast aggregate came back from
  node-pg as a **string** -- `'0' !== 0`, no error, no NaN, just silently
  wrong until something compared it. Fixed by casting every aggregate back
  to `::bigint` explicitly. Verified live: enrolled a real node through the
  UI, connected a real worker, and watched it flip from a grey OFFLINE dot
  to a green ONLINE one via the dashboard's own polling, no manual refresh.

- `backend/src/payments/razorpay.js` + the two-phase
  `/reservations/:id/confirm` → `/confirm/verify` flow + `POST /webhooks/razorpay`
  — real Razorpay integration: order creation, HMAC signature verification
  (both the client callback's and the webhook's), and gateway refunds. Falls
  back to the exact previous ledger-only behavior, loudly logged, when no
  credentials are configured (`RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` unset)
  -- which is the state every test and the e2e script run in, since **this
  project has no live Razorpay account** (creating one needs a real business
  identity; it isn't something that can be done on someone else's behalf).
  Signature math and outgoing-request shape are genuinely tested with no
  external dependency; the full order→verify→capture→compensating-refund
  orchestration is tested end to end against a fake gateway speaking the
  identical protocol. What's explicitly unverified: that Razorpay's real API
  responds the way its docs say it will. See
  [docs/payment-architecture.md](docs/payment-architecture.md) for the full
  picture, including the one gap surfaced while building this — an
  unreachable node discovered *after* a live gateway has already captured
  real money now needs an actual refund, not just an internal status flip,
  and the webhook path was initially missing that compensation (a fix
  informed by, not just followed by, the test that first proved the direct
  verify endpoint needed it).
- `backend/src/payments/refunds.js` — closes that same commit's own named
  gap: a compensating refund that fails is no longer just a `console.error`.
  `issueRefund` is now the single place all three refund call sites
  (direct-verify, webhook, `settleReservation`) go through, and a failure
  is recorded in a durable `refund_retries` table and retried with capped
  exponential backoff (1m → 1h, up to 10 attempts) by a periodic sweep,
  rather than depending on a human reading logs. Consolidating three
  near-duplicate implementations into one is also what closes the door on
  the exact bug the prior commit found (one copy silently missing the
  refund call) recurring a second time. See
  [docs/payment-architecture.md](docs/payment-architecture.md)'s "Refund
  retries" section.
- `RESERVATION_STATUS_QUERY` / `RESERVE_RELEASE` (protocol.js) +
  `hub.queryReservationStatus` / `hub.releaseReservation` +
  `reservations/reconciler.js`'s `reconcileExpiredMismatches` — closes the
  last gap `docs/reservation-protocol.md` named as unsolved since the
  project's first commit: after a `RESERVE_COMMIT` acknowledgment goes
  missing, the platform could not tell whether the node actually applied the
  commit before the ack was lost, leaving a slot permanently squatted on by
  a reservation nobody could act on. A periodic sweep now asks the node
  directly and, on a mismatch, tells the node to release rather than trying
  to resurrect the platform's own row -- which would reopen "charged but not
  reserved" risk from the other direction. Verified live: reproduced the
  exact scenario against a running backend and a real worker (had the
  worker apply a commit locally, forced the platform's row to `expired` to
  simulate the lost ack) and watched the sweep detect it, release the node's
  hold over the real socket, and free the slot for a genuine rebooking.
- `backend/src/auth/passwordReset.js` + `backend/src/auth/email.js` +
  `POST /auth/forgot-password` / `POST /auth/reset-password` — account
  recovery, closing the gap named in every earlier revision of this list.
  A raw, high-entropy token goes in the emailed link; only its SHA-256 hash
  is stored (same reasoning as bcrypt for passwords, applied to a bearer
  secret), single-use, expires in one hour, and requesting a new one
  invalidates any earlier unused one. `forgot-password` always returns the
  identical generic response whether the email is registered or not -- the
  same email-enumeration defense as login's timing-safe compare, applied to
  the response body instead of response time. Unlike the Razorpay
  integration, email delivery here is **genuinely verified end to end, not
  just implemented against a spec**: `nodemailer`'s Ethereal test accounts
  are provisioned live via a public API with no signup or credentials of
  ours required, and `test/email.test.js` sends a real message over real
  SMTP and reads it back through Ethereal's own preview API to confirm the
  token survived delivery byte-for-byte. No SMTP configured (this project's
  default state, same as no Razorpay keys) falls back to logging the reset
  link instead of emailing it -- loud and honest, the same posture as
  `UnconfiguredGateway`. Verified live end to end including the browser:
  signed up, triggered forgot-password, read the real link from the
  console-fallback log, opened it in the actual frontend (proving Vite's
  SPA fallback serves `index.html` for the extra `/reset-password` path
  this app recognizes with no router), submitted a new password through
  the real form, and confirmed via the API that the old password now
  fails and the new one works.
- `backend/src/jobs/verification.js` + `machine.js`'s `DISPUTED` state —
  result verification via duplicate execution, the master brief's own
  answer to `docs/security-model.md`'s previously-unaddressed "Direction 2"
  (a provider lying about a job's result). `POST /reservations/:id/jobs`
  takes an optional `verify_against_reservation_id` -- a second,
  independently booked reservation on a *different* node -- runs the
  identical job on both, and compares SHA-256 hashes of the results once
  both finish. A match settles normally; a mismatch disputes **both**
  reservations (full refund) rather than trusting either, since two nodes
  disagreeing proves at least one is wrong but never which -- reputation is
  deliberately left untouched for both on a dispute, stated explicitly
  rather than silently guessed at. Opt-in and manual, not automatic: this
  is the *mechanism*, not a policy that decides which jobs need it. Tested
  against a real `Hub` with genuine Ed25519-signed receipts and real
  Postgres (including graceful degradation when the second node's
  submission fails), and verified live with two real worker processes
  running two real Docker containers on independent nodes -- their
  matching output hashed identically and both bookings settled with the
  exact 90/10 split. See `docs/security-model.md`'s Direction 2 section for
  what this does and does not solve (it detects disagreement, not fault; a
  match is agreement, not proof of correctness; nothing here stops a node
  from reading a user's code, only from lying about the result undetected).
  Caught along the way: the Postgres CHECK constraint on
  `reservations.status` was a second, independent definition of "which
  states are legal" that had drifted from `machine.js`'s own list --
  adding `DISPUTED` to one without the other meant every dispute attempt
  failed with a constraint violation the first time it actually ran.
- `shouldRecommendVerification` (`jobs/verification.js`, wired into
  `scheduler.rank()`) — closes half of the previous commit's own named
  gap: search results now flag a node as worth verifying (new/unproven
  provider, below-threshold measured reliability, or a high-value booking
  -- the master brief's own "new providers, suspicious providers,
  high-value jobs" list), with the specific reason(s) shown, not just an
  unexplained badge. Deliberately a *recommendation surfaced to the user*,
  never an automatic second booking -- silently doubling someone's charge
  without consent would be worse than not verifying at all, exactly the
  same opt-in principle `verify_against_reservation_id` itself follows.
  Caught live, not by the unit tests first: a freshly enrolled node with
  zero jobs showed up flagged as *both* "new provider" and "below-average
  reliability" simultaneously, because a brand-new node's reliability is
  `nodeStore.js`'s neutral 0.8 default -- a placeholder meaning "no opinion
  yet," not a real measurement -- which happens to sit below the
  low-reliability threshold. The original unit test fixture used
  `reliability: 1` and never exercised this, which is exactly why it took
  a real browser check to surface it. Fixed so low_reliability is only
  ever evaluated for a provider with an actual track record, and a
  regression test now pins the realistic (0.8-default) case the first
  fixture missed.

Not built yet: P2P discovery beyond one platform-worker link, and a real
dispute-resolution process that can attribute fault beyond "at least one
of these two nodes is wrong" (a third-node majority vote, say).

## Running

```bash
# schema
docker compose up -d postgres
for f in backend/migrations/*.sql; do
  docker compose exec -T postgres psql -U nodeva -d nodeva < "$f"
done

# backend tests (172) -- JWT_SECRET only needed by tests that build the full
# app (server.js); the unit test files don't call createApp() so most pass
# without it, but set it anyway to be safe. Several suites (reconciler,
# reputation-integration, dashboard, payment-flow, account-recovery)
# additionally need a reachable Postgres (docker compose up -d postgres) and
# skip cleanly if there isn't one. email.test.js needs network access to
# ethereal.email (a live call, no credentials of ours) and skips cleanly
# without it. RAZORPAY_KEY_ID/SECRET and SMTP_HOST/PORT/USER/PASS are
# deliberately left UNSET here -- see docs/payment-architecture.md and
# src/auth/email.js for why, and what runs instead of a real send.
export JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
cd backend && node --test test/*.test.js

# worker tests (41)
python3 -m venv .venv && .venv/bin/pip install -r worker/requirements-dev.txt
.venv/bin/pip install websockets
.venv/bin/python -m pytest worker/tests -q

# executor tests against a real container (needs docker; pulls alpine:3.20 once)
.venv/bin/python -m pytest worker/tests/test_executor.py -q

# full network integration demo, including a real sandboxed job (needs docker)
./scripts/e2e_demo.sh

# frontend (needs the backend + a worker running -- see scripts/e2e_demo.sh
# for how to start one by hand, or just run that script and query the API
# it leaves in place while it's mid-run)
cd frontend && npm install && npm run dev
```

The signature fixtures shared by both suites are regenerated with
`.venv/bin/python worker/tools/gen_interop_fixture.py`.
