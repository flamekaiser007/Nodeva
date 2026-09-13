# Reservation protocol

The central problem: **the provider node owns the slot, the platform owns the
money.** Two authorities, two independent failure modes. This protocol exists to
make sure they never disagree in a way that costs someone real money.

## Ordering rule

The node locks **first**, we capture money **second**.

A lost lock costs the provider an idle hour. A lost payment costs a user actual
money and a support ticket. The irreversible step goes last.

## Happy path

```
user            platform                     node
 │                 │                          │
 │─ reserve ──────▶│                          │
 │                 │─ RESERVE_REQUEST ───────▶│
 │                 │                          │ atomic local lock
 │                 │                          │ (overlap check in one txn)
 │                 │◀─ RECEIPT{sig, ttl} ─────│
 │                 │ verify sig vs registered pubkey
 │                 │ status: pending → held
 │                 │
 │                 │─ capture ──▶ gateway     │
 │                 │◀─ authorized ──          │
 │                 │ status: held → confirmed │
 │                 │─ RESERVE_COMMIT ────────▶│
 │◀─ confirmed ────│                          │ lock made permanent
```

## Why the node signs

Without a signature, a compromised or buggy platform could claim a node accepted
a booking it never agreed to, and the node would have no way to dispute it. The
receipt is the node's own attestation, verifiable by anyone holding the public
key registered at enrollment. It is also what makes the later move to real P2P
discovery cheap: the trust artifact does not change, only the transport.

## Why the hold has a TTL

If the platform crashes between `RESERVE_REQUEST` and `RESERVE_COMMIT`, a naive
lock pins the provider's GPU forever. The node sets `hold_expires_at` and is
entitled to release the slot once it passes.

The rule that keeps this safe: **the platform must not capture funds after the
TTL has elapsed.** If we are late, the booking expires and the user is not
charged. This is why `expired → confirmed` is an illegal transition in
`machine.js` — it is the edge that would produce "charged but not reserved".

## Failure matrix

| What broke | Node state | Platform state | User outcome |
|---|---|---|---|
| Node rejects (slot taken) | free | `pending → cancelled` | offered alternatives, never charged |
| Platform crashes pre-capture | lock expires via TTL | `held → expired` | not charged |
| Gateway declines | lock expires via TTL | `held → expired` | not charged |
| User abandons a `held` reservation (never confirms) | lock expires via TTL | **was stuck at `held` forever — see below** | not charged, but see below |
| `RESERVE_COMMIT` ack lost after the node applied it | **permanently confirmed, no TTL** | `held → expired` (the confirm handler treats any timeout/disconnect as failure) | not charged, but see below |
| Node vanishes mid-job | — | `running → failed_provider` | full refund |
| User's code throws | — | `running → failed_user` | billed for compute consumed |

Row four was a real, shipped bug, not a hypothetical: a reservation nobody
ever confirmed just sat in `held` in Postgres indefinitely, even after the
node's own hold TTL had elapsed and freed the slot locally. The GiST
exclusion constraint then treated that stale row as still occupying the
window — a second attempt to book the *same, actually-free* slot was
rejected with a false conflict, confirmed by hand: the node signed a brand
new receipt for the "conflicting" window, which the platform then discarded
because its own stale row blocked the insert. Fixed by
`backend/src/reservations/reconciler.js`'s `expireStaleHolds`, run
opportunistically (scoped to one node, right before a booking attempt that
might collide with a stale hold of its own) and on a periodic sweep (every
15s, unscoped, catching abandoned holds nobody happens to retry). Neither
path involves money — nothing is captured until `confirm`, so this is a slot
being falsely reported unavailable, not a billing error.

Row five is the case that would need a refund if it ever produced a mismatch
long enough to matter, but by construction it currently cannot silently cost
anyone money: the confirm handler treats *any* timeout or disconnect while
waiting for `COMMITTED` as a failure and marks the reservation `expired`
without ever capturing payment — see the `node_unreachable_hold_not_confirmed`
path in `server.js`. The residual risk is a pure state *mismatch*, not a
financial one: the node may have actually applied the commit permanently
(no TTL) while the platform believes the slot is free again. A second user
attempting to book that window is safely, correctly denied by the node
itself (a real conflict, not a false one this time) — the awkward outcome is
that the first user is told their booking expired when the node would in
fact have run their job, and has no way to retry it since the slot now
reads as taken. No money changes hands incorrectly, but the user experience
is broken. Resolving it needs the platform to be able to *ask* a node "is
reservation X actually confirmed on your side?" — a query this protocol does
not have yet, tracked in "what is not solved" below.

## What is NOT solved yet

- **Reconciliation query.** There is no `RESERVATION_STATUS?` message a
  platform can send a node to ask "what do you actually show for X" after a
  commit ack goes missing. Today that mismatch resolves itself safely
  (double-booking stays impossible) but leaves the affected user stuck with
  no path to their own confirmed slot. Low-frequency edge case, real UX cost
  when it happens.
- **Byzantine nodes.** A node can sign a receipt and then simply not run the
  job. Detection today is the heartbeat; the economic answer is reputation plus
  selective duplicate execution, not cryptography.
- **Clock skew.** Hold TTLs compare timestamps across machines. Currently
  assumes loose NTP sync; a node with a fast clock releases early. Needs a
  monotonic handshake or a generous safety margin before production.
- **NAT — solved for Phase 1, not for Phase 2.** The worker dials out over
  WebSocket and holds the connection open; the platform never opens a socket
  to a node. This works today because there is exactly one platform to
  connect to. It stops working once nodes need to reach each other directly
  for P2P discovery (Phase 2), which is a harder problem (relays, hole
  punching) than a single long-lived client connection to a known server.
