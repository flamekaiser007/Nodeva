# Contributing

## What this project actually expects of a change

Read `README.md`'s "Architecture, stated honestly" section first -- it's
not marketing copy, it's the design constraint every change here is judged
against. A few things that follow from it, and that this codebase has
consistently held itself to:

- **Real dependencies over mocks, wherever practical.** Tests hit a real
  Postgres (`docker compose up -d postgres`), a real SQLite file, real
  Ed25519 signatures, and where the feature warrants it, a real Docker
  container or a real second OS process. A mocked test proves your code
  calls the mock correctly; it doesn't prove the thing works. See
  `docs/architecture.md` and any `scripts/*_demo.sh` for what "live
  verified" means in this repo's commit history -- an actual running
  process, not a code review claim.
- **Illustrative thresholds are labeled as such, not treated as settled.**
  `jobs/verification.js`'s `DEFAULT_VERIFICATION_THRESHOLDS` and
  `alerting/alert_rules.yml`'s alert thresholds both say outright that
  they're starting points, not researched constants, because neither has
  real production traffic behind it yet. If you tune one of these with an
  actual argument (a simulation, a real incident, real usage data), say so
  in the commit and update the comment; don't quietly change a number
  without explaining why the new one is better.
- **Honest limits get written down, not hidden.** Search this repo for
  "HONEST LIMIT" and "what is NOT solved" -- `docs/reservation-protocol.md`,
  `docs/backup-restore.md`, `docs/secrets-rotation.md`, `peer.py`'s file
  header. If your change has a real gap (it usually does), document it in
  the same style: what specifically doesn't work, and what it would take
  to fix. A gap that's written down is a known trade-off; a gap that isn't
  is a surprise for whoever hits it next.
- **No abstraction ahead of a real need.** This project has repeatedly
  deferred work explicitly (P2P discovery until a verification pairing
  needed it, NAT traversal, most of the original research-question
  backlog) rather than build for a hypothetical future. If you're adding a
  configuration knob, a generic interface, or a new layer "in case it's
  needed later," it probably isn't needed yet.
- **Comments explain WHY, not WHAT.** The code should already say what it
  does. A comment earns its place by capturing a non-obvious constraint, a
  workaround for a specific bug, or a decision that would otherwise look
  arbitrary -- most of the comments in this codebase do exactly that, and
  new ones should match.

## Getting a dev environment running

```bash
git clone <this repo> && cd NODEVA
docker compose up -d postgres

for f in backend/migrations/*.sql; do
  docker compose exec -T postgres psql -U nodeva -d nodeva < "$f"
done
# or, once you have a JWT_SECRET set (below): cd backend && npm run migrate

export JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
cd backend && npm install && node src/index.js   # backend on :3000 by default

python3 -m venv .venv && .venv/bin/pip install -r worker/requirements-dev.txt
# a real worker process needs a node enrolled first -- see scripts/e2e_demo.sh
# for the exact curl sequence (signup, enroll, connect)

cd frontend && npm install && npm run dev        # :5173, needs VITE_API_URL if backend isn't on :3100
```

RAZORPAY_KEY_ID/SECRET and SMTP_HOST/PORT/USER/PASS are deliberately left
unset in local dev -- see `docs/payment-architecture.md` and
`backend/src/auth/email.js` for the honest fallbacks that run instead.

## Running the tests

```bash
# backend (331 tests as of this writing; several suites need Postgres and
# skip cleanly without it -- see the comment block in README.md's own
# "Running" section for exactly which)
cd backend && npm test

# worker (59 tests; some need a real GPU or network access and skip
# cleanly without either)
.venv/bin/python -m pytest worker/tests -q

# frontend unit/component tests (Vitest + Testing Library, mocked ../api)
cd frontend && npm test

# frontend E2E (real Chromium via Playwright, against a real backend +
# worker + Postgres + Docker container -- see e2e/run_e2e.sh's own header
# for exactly what this proves that the component tests can't)
npx playwright install chromium   # once
./e2e/run_e2e.sh
```

`npm test` runs the backend suite with `--test-concurrency=1`, which is
slower (about 100s instead of 20s) and deliberate. These suites share ONE
Postgres, and several of the functions they exercise are global sweeps by
design -- `processRefundRetries` and `reconcileExpiredMismatches` both scan
the whole table with a `LIMIT` rather than filtering to one caller's rows,
because that is what a real deployment needs. Two such files running
concurrently therefore consume each other's rows and each other's batch
limits, producing failures that have nothing to do with the code under
test. Three separate tests were patched for this before the pattern was
worth naming; serializing removes the whole class instead of the next
instance of it.

## The live-verification scripts

Several features in this project are proven with a script that boots real
processes and checks a real outcome, not just a unit test. Run the
relevant one after touching the area it covers:

| Script | Proves |
|---|---|
| `scripts/e2e_demo.sh` | The full curl-level booking/payment/job loop against a real backend + worker |
| `e2e/run_e2e.sh` | The same golden path, driven through the real rendered UI in a real browser |
| `scripts/p2p_demo.sh` | Two real worker processes discovering and directly connecting to each other |
| `scripts/alerting_demo.sh` | A real alert traveling Prometheus -> Alertmanager -> a webhook |
| `scripts/log_aggregation_demo.sh` | A real log line shipped to and queried back from a real Loki container |
| `scripts/backup_restore_demo.sh` | A real backup, a real simulated disaster, a real restore |
| `scripts/secrets_rotation_demo.sh` | A rotated secret working mid-rotation and correctly failing post-rotation |
| `scripts/scale_demo.sh` | No double-booking across 3 real backend processes sharing one Redis |

If you add a feature in this category -- something that only really proves
itself with more than one live process, or a real external dependency --
add a script here in the same style rather than only unit-testing it.

## Commit messages

Look at `git log` before writing one. The convention in this repo is a
concise summary line, then a body explaining the WHY (not a restatement of
the diff), any real bug caught along the way and how it was found, and
what was verified and how (test counts, live scripts run). If you didn't
run the tests or the relevant live-verification script, say so rather than
implying you did.

## Before opening a PR

- [ ] Relevant tests pass locally (backend/worker/frontend, whichever your
      change touches).
- [ ] If your change is the kind this section describes as needing live
      verification, you ran the relevant script (or wrote a new one) and
      it passed against a real running stack.
- [ ] Any new illustrative threshold, off-by-default flag, or honest gap
      is documented the way the rest of the codebase documents them (see
      above) -- not left as a bare number or a silent TODO.
