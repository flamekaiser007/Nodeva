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

Not built yet: HTTP API, worker, frontend, P2P.

## Running

```bash
docker compose up -d postgres
docker compose exec -T postgres psql -U nodeva -d nodeva < backend/migrations/001_init.sql
cd backend && npm test
```
