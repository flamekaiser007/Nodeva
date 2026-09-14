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
- `POST /verification-groups/:groupId/tiebreak` (`jobs/verification.js`'s
  `attributeFaultFromTiebreaker`, `api/server.js`'s
  `resolveDisputeTiebreaker`) — the third-node dispute-resolution mechanism
  the previous commit named as the remaining gap in Direction 2. Once a
  duplicate-execution group comes back `disputed` (two nodes disagreed,
  both already refunded in full), a user can book a third, independent
  reservation and re-run the identical workload; if the tiebreaker agrees
  with exactly one of the two original nodes, that node is vindicated (no
  reputation effect) and the other takes a real `rep_jobs_failed` hit. A
  three-way disagreement is `inconclusive` and attributes nothing. This is
  strictly reputation, never money: the original dispute's refund is
  final and is never revisited, by design -- re-litigating a settled
  refund because a third sample showed up later would make refunds feel
  provisional, which is a worse property than the one already shipped.
  One resolution per group is enforced by a real Postgres `UNIQUE`
  constraint (`dispute_resolutions.verification_group_id`), not just
  application logic, so a duplicate `JOB_RESULT` delivery (`hub.js`'s
  at-least-once semantics) can't double-attribute fault. Verified against
  a real Hub, real Postgres, and three scripted worker sockets exercising
  all three verdicts (vindicated/at-fault, inconclusive, and the endpoint's
  own validation: refusing a tiebreak against a still-matched group,
  against a reservation on one of the two disputing nodes, and a second
  tiebreak attempt against an already-resolved group).
- **Frontend UI for verification and dispute resolution** -- until now the
  backend's verification and tiebreak endpoints had no way to reach them
  except curl; `ResultsList`'s "Verify with another node" button puts the
  list into a partner-picking mode, `VerifiedPairReservation` drives two
  independent "Confirm & Pay" steps and one joint job submission, and
  `DisputeResolution` (mounted automatically when both reservations settle
  `disputed`) walks the user through booking, confirming, and running a
  third-node tiebreaker, then shows the verdict. Added `GET
  /reservations/:id` (ownership-scoped, 404 on mismatch like every other
  reservation route) specifically because a job's own status doesn't say
  whether its RESERVATION ended up disputed -- see `jobRowStatusToOutcome`'s
  comment for why those are different vocabularies.

  Caught live, not by a unit test: switching to "Share GPU" and back
  unmounts `VerifiedPairReservation` (App only renders one view at a time),
  and it was re-seeding its status from the original booking-time prop
  snapshot on remount -- a reservation confirmed minutes earlier silently
  showed "held" again, with a stale error banner from an unrelated earlier
  double-click still attached. Fixed by re-fetching both reservations'
  authoritative status from the backend on every mount via the new GET
  route, instead of trusting the prop. A related, deliberately UNFIXED gap
  is noted in the code: if a job was already submitted in an earlier mount,
  its `job_id` is not persisted anywhere outside that mount's own state, so
  a remount can't resume showing its progress -- surfaced as an honest
  message rather than silently re-showing a submission form that would
  just fail against a reservation that already has a job.

  Verified end-to-end against three real worker processes, three real
  Docker-sandboxed nodes, and a real Razorpay-unconfigured backend in an
  actual browser: booked and confirmed a verified pair, survived the
  mount/remount bug being fixed live, submitted a matching job (both
  settled `completed`, ledger and reputation correct), then forced a
  genuine mismatch with a nondeterministic command
  (`cat /proc/sys/kernel/random/uuid`, run identically on both nodes) to
  get a REAL dispute — no scripted/fake worker involved — booked a real
  third node as tiebreaker, and confirmed the resulting `inconclusive`
  verdict (the random tiebreaker output agreed with neither original,
  correctly) matched exactly between the UI and the `dispute_resolutions`
  table. The `attributed` (fault-to-one-side) verdict path is exercised by
  `dispute-resolution.test.js`'s scripted-worker tests rather than live
  here, since manufacturing a live one requires an intentionally lying
  worker -- the same honest tradeoff the automated suite exists to cover.
- **Closed the job-recovery gap the previous commit left open.** `GET
  /reservations/:id` now also returns the reservation's own job (most
  recent, if any), so `VerifiedPairReservation`'s remount-hydration effect
  can recover an in-flight or finished job's `job_id` instead of just its
  reservation status -- a mount that finds the job still running resumes
  polling it (shared `pollJob` helper, used by both a fresh submission and
  recovery so the two paths can't drift); one that finds it already
  terminal shows the result directly. Verified live: submitted a job with
  a 5-second `sleep`, switched to "Share GPU" and back mid-run, and watched
  it correctly resume tracking to a `completed` settlement with the real
  stdout, where before this fix the same sequence would have shown "can't
  resume showing its progress."

- **Provider-side dispute visibility.** `GET /providers/me/dashboard` now
  returns a `disputes` array: every `disputed` reservation on one of the
  provider's own nodes, joined to its `dispute_resolutions` row (if a
  tiebreaker has run) via `jobs.verification_group_id`. Before this, a
  provider watching `rep_jobs_failed` move had no way to find out a
  duplicate-execution mismatch caused it, let alone whether a later
  tiebreaker vindicated them or found them at fault. `ProviderDashboard`
  renders it as a `DisputeHistory` panel with three states per dispute:
  "Awaiting tiebreaker", "Vindicated", "Fault attributed to this node", or
  "Inconclusive".

  **A real bug, caught only by checking this live in the browser, not by
  the first version of the automated test:** the dashboard query originally
  joined `dispute_resolutions` on `vindicated_reservation_id` /
  `at_fault_reservation_id`. An `inconclusive` verdict leaves BOTH of those
  columns NULL by design (nothing gets attributed) -- so that join could
  never match an inconclusive resolution, and a dispute that had genuinely
  already been resolved sat forever mislabeled "awaiting tiebreaker". The
  first test I wrote only exercised the `attributed` case, which happens to
  populate both columns and passed cleanly, hiding the bug. Fixed by
  joining through `jobs.verification_group_id` instead -- the one field
  every resolution always has -- and added a dedicated regression test for
  the inconclusive case specifically so this class of "only the common case
  is tested" gap doesn't recur. Backend suite is now 191 tests.

- **Rate limiting on the three auth endpoints exposed before a session
  exists** (`auth/rateLimit.js`): `/auth/signup` (spam accounts),
  `/auth/forgot-password` (email-bombing a stranger's inbox -- the
  endpoint deliberately sends regardless of whether the account exists, to
  avoid leaking which emails are registered, which means nothing else
  stopped this), and `/auth/login` gets TWO limiters at once -- by IP (one
  source hammering many accounts) and by email (one account targeted from
  many sources) -- since either alone misses half the threat. In-memory,
  fixed-window, honestly labeled as per-process state: correct for the
  single backend instance this MVP runs, wrong the moment a second
  instance joins without a shared store. Redis is already sitting unused in
  `docker-compose.yml`; that would be the natural next step, not something
  to build ahead of the actual need. Thresholds (100/15min signup by IP,
  50/15min login by IP, 8/15min login by email, 10/15min forgot-password by
  IP) are illustrative starting points, the same posture
  `jobs/verification.js`'s thresholds already take.

  Tested at two levels: `rateLimit.test.js` proves the middleware itself
  (independent keys don't interfere, a falsy key is never limited, the
  window actually resets) against a fake req/res, no HTTP needed;
  `rate-limit-integration.test.js` proves it's actually wired into the real
  app on a real route, hitting `/auth/login` for real until the 429 lands.
  Full suite is now 198 tests.

- **Closed the image-allowlist gap `docs/security-model.md` named since
  its first draft.** `jobs/imageAllowlist.js` rejects (400, before the
  worker ever sees it) any job whose image repository isn't on a
  configured allowlist (`ALLOWED_IMAGE_REPOS`, defaulting to a handful of
  Docker Hub official images). This stops a wholly arbitrary,
  attacker-controlled image -- the direct supply-chain attack the doc
  named -- but does not pin digests, a deliberate, explicitly-stated scope
  cut (a real deployment's own decision to make, trading usability for a
  stronger guarantee). Tested at the unit level (`imageAllowlist.test.js`
  -- reference parsing including registry-port edge cases, allowlist
  override via env) and via a real end-to-end check
  (`imageAllowlist-integration.test.js`) proving a disallowed image never
  reaches the worker's `docker run` at all, using a scripted worker that
  records whether `JOB_SUBMIT` ever arrived. Full suite is now 211 tests.

- **A reproducible scheduler/verification-threshold backtest** --
  `backend/scripts/scheduler_simulation.js` -- the master brief's own
  scheduling-research direction, done as far as it can go without real
  production traffic. Runs the REAL `rank()` and
  `shouldRecommendVerification()` (not reimplementations) against a
  synthetic provider population and job stream, under an explicitly stated
  and honestly-flagged-as-guesswork model (85%/15% reliable/flaky mix, 40%
  brand-new providers, price weakly anti-correlated with reliability).
  `jobs/verification.js`'s thresholds became an overridable
  `DEFAULT_VERIFICATION_THRESHOLDS` object (backward compatible -- every
  real call site still gets the exact same defaults) specifically so the
  sweep can vary them without forking the decision logic.

  Findings, written up in `docs/scheduler-tuning.md`: reliability-adjusted
  ranking (`best_value`) only modestly beats `cheapest` on failure rate
  (7% relative reduction) under this model, while `fastest` mode nearly
  doubles the failure rate of the other two (weighting reliability at only
  20%) -- a real, assumption-robust cost of that mode's tradeoff that
  wasn't previously quantified anywhere. More surprising: the verification
  recommendation is close to inert for `best_value`/`fastest`'s actual top
  pick, because those modes' own reliability weighting already filters out
  the new/flaky candidates the flag exists to catch -- its practical value
  concentrates almost entirely in `cheapest` mode. The doc deliberately
  stops short of changing the shipped defaults from a synthetic sweep
  alone (that would overclaim what a stated-assumption model can prove);
  it recommends specifically what to re-check once real traffic exists.
  Tested with a reproducible-seed smoke suite (`scheduler_simulation.test.js`)
  rather than fixed-output assertions, since there's no "correct" failure
  rate to assert against for a stated-assumption model -- only that it
  doesn't crash, stays internally consistent, and reproduces exactly given
  the same seed. Full suite is now 220 tests.

- **Extended rate limiting to `/search`, `/reservations`, and
  `/reservations/:id/jobs`** -- previously only the three pre-session auth
  endpoints were throttled. `/search` (unauthenticated) is limited by IP
  (120/min); reservation creation and job submission run AFTER `auth`, so
  they're limited per authenticated user (30/15min, 60/15min) rather than
  by IP, since the concern there is a runaway or malicious client hammering
  its OWN account, not credential-style abuse. All three reuse the same
  `rateLimit()` factory from the auth work, wired the same way. Verified
  live against the real app for the two cheapest-to-trip limiters
  (login-by-email, search); the reservation and job-submit limiters share
  the same already-tested factory and would need a full reservation per
  hit to trip for real, which wasn't worth the test runtime for no
  additional confidence. Full suite is now 223 tests.

- **CI and the first admin-tooling surface** -- closing the "ops surface"
  gap from the "is project ready" review.
  `.github/workflows/ci.yml` runs the same three suites this project has
  relied on throughout (backend against a real Postgres service container,
  worker against real Docker, frontend build+lint) on every push and PR --
  no new testing strategy, just running what already existed on every
  change instead of only when someone remembers to.

  `GET /admin/ops-summary` surfaces the two categories of row this project
  has always needed a human to look at but never exposed anywhere:
  `refund_retries` rows that hit the retry ceiling (the migration's own
  comment already called this out) and disputes still waiting on a
  tiebreaker. There's still no role system (see the manual-settlement
  gate for the same honest gap), so this sits behind a separate shared
  secret (`auth/adminToken.js`'s `ADMIN_TOKEN`, timing-safe compared, 404
  rather than 401/403 when disabled or wrong) rather than a normal
  session's JWT -- an ordinary user's own token must never be able to read
  every user's stuck refunds and every provider's open disputes just
  because JWT auth happens to be checked first.

  Tested at the unit level (`adminToken.test.js`: disabled-by-default,
  wrong token, missing header, mismatched-length token) and via a full
  live dispute+tiebreak cycle (`dispute-resolution.test.js`) proving a
  fresh dispute appears under `awaiting_tiebreak` and moves out of it once
  actually resolved. Full suite is now 231 tests.

- **A real `npm run migrate`** -- `package.json` had referenced it since
  the first commit, but `backend/src/db/migrate.js` never existed;
  `scripts/e2e_demo.sh` and CI instead reapplied every migration file with
  raw psql against a freshly dropped schema every run, which only worked
  because those two call sites always start from nothing and neither
  tracks which migrations already ran. `migrate.js` tracks applied
  migrations in a `schema_migrations` table and only runs what's pending,
  each file in its own transaction -- the thing an actual deployment (not
  a from-scratch demo) needs. `e2e_demo.sh` and CI now both call it
  instead of the raw-psql loop, so there's one path that applies
  migrations, not two that could drift.

  Tested against a real Postgres in a throwaway schema per test (not
  `public`, which the rest of the suite's app instances depend on):
  in-order application, a second run applying nothing, a later-added file
  being the only one that runs, and -- the case raw psql's
  `ON_ERROR_STOP=1` never really covered -- a failing migration rolling
  back and stopping before any later file is even attempted. Full suite
  is now 236 tests.

- **Honest hardware-mismatch detection.** Provider specs (`gpu_model`,
  `cpu_cores`, `ram_mb`) were self-reported at enrollment with nothing
  cross-checking them against what a node's own worker actually has --
  `worker/hardware.py`'s own file header already named this as
  unverifiable in principle ("a deliberately malicious operator... can
  always report whatever number they want"), but CPU/RAM had no
  detection at all until now, not even the honest-provider convenience the
  file's own reasoning called for. Added `detect_cpu_cores`/`detect_ram_mb`
  (stdlib only -- `os.cpu_count()` and POSIX `sysconf`, no new dependency,
  same reasoning as `nvidia-smi` over an NVML binding) and `vram_total_mb`
  to the existing GPU heartbeat field. `api/server.js`'s
  `checkHardwareMismatch` compares a node's live heartbeat against its
  enrollment claim (exact for CPU cores, 10%-tolerant for RAM/VRAM since a
  heartbeat reports what the OS actually sees while an enrollment value is
  often a rounded marketing number) and surfaces it on the provider
  dashboard as a listing-discrepancy notice -- explicitly framed as
  "your listing doesn't match what your machine reports," never phrased as
  an accusation, since both numbers come from the same operator and a
  dishonest one can always make them agree by lying consistently. This is
  the same "detection is a convenience, not a security control" posture
  `hardware.py` already stated for GPU model, now actually implemented for
  the fields that previously had none.

  Tested at the worker level (`detect_cpu_cores`/`detect_ram_mb` unit
  tests including "platform genuinely doesn't know," and a
  `_build_heartbeat` unit extracted specifically so the heartbeat's exact
  message shape is directly testable rather than living only inside an
  infinite `while True` loop) and at the backend level (a real worker
  authenticating over the real Hub and hand-sending a heartbeat, proving
  match/no-tolerance-CPU-mismatch/beyond-tolerance-RAM-mismatch/no-heartbeat-yet
  all read correctly through the real dashboard endpoint). Verified live
  end to end: enrolled a node claiming 64 cores / 128 GB RAM, connected a
  REAL worker on this actual dev machine (8 cores / 8 GB, genuinely
  detected), and watched the real mismatch appear on the dashboard in an
  actual browser. Worker suite is now 48 tests (+8), backend suite 240
  (+4).

- **A real frontend test suite.** Every UI claim in this project had been
  verified live in a browser -- valuable, but not repeatable, and exactly
  the kind of gap that let the `VerifiedPairReservation` remount bug ship
  in the first place (nothing would have caught a regression of it
  automatically). Added Vitest + React Testing Library
  (`frontend/vitest.config.js`, `npm test`) and 30 real component tests
  across the components with actual async/state complexity:
  `VerifiedPairReservation` (6 tests, including a direct regression test
  for the remount-hydration bug and the in-flight-job-recovery polling
  path using fake timers), `ActiveReservation` (5, including job-polling
  stop conditions), `ResultsList` (9, the partner-picking state machine),
  `DisputeResolution` (5, resolution states and the full tiebreaker flow
  search→reserve→confirm→submit→resolved), and `confirmPayment` (5, every
  Razorpay Checkout callback path -- success, dismiss, payment.failed,
  rejected signature -- against a fake `window.Razorpay` constructor, no
  live account needed). All mock `../api`/`../lib/confirmPayment` at the
  module boundary rather than real fetch calls, matching where this
  project's own trust boundary already sits.

  One real, non-project bug surfaced while wiring this up: `npm install`
  hit an npm/arborist crash (`Cannot read properties of null (reading
  'edgesOut')`) resolving vitest's peer tree on this machine's npm
  version -- a bug in npm's resolver, not a conflict in this project's
  dependencies. Worked around with `frontend/.npmrc`'s
  `legacy-peer-deps=true`, documented in place so the reason doesn't get
  rediscovered the hard way later. CI's frontend job now runs `npm test`
  between lint and build.

Not built yet: P2P discovery beyond one platform-worker link. This is
Phase 2 scope per the master brief's own phasing ("Phase 1 doesn't need
libp2p, and shouldn't have it") and is deliberately not started early.

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
