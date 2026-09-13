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

- `frontend/` — React + Tailwind marketplace UI: requirement-based search
  (not a GPU-model picker), reserve, confirm & pay, submit a job, watch it
  run. Verified against the real running stack end to end -- a browser
  click produces a signed reservation receipt, runs a real Docker container
  on the worker, and settles the ledger, with the actual container stdout
  displayed back in the page.

Not built yet: user auth (the API has a dev-only user-seeding stub, clearly
marked, not real signup/login), P2P discovery beyond one platform-worker
link, protecting users from malicious providers (no result verification /
duplicate execution yet).

## Running

```bash
# schema
docker compose up -d postgres
for f in backend/migrations/*.sql; do
  docker compose exec -T postgres psql -U nodeva -d nodeva < "$f"
done

# backend tests (33)
cd backend && node --test test/*.test.js

# worker tests (20)
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
