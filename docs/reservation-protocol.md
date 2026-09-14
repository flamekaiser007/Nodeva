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
| `RESERVE_COMMIT` ack lost after the node applied it | permanently confirmed, no TTL — **until the reconciler queries and releases it** | `held → expired` (the confirm handler treats any timeout/disconnect as failure) | not charged; slot recovers within one reconciliation sweep instead of staying stuck forever |
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

Row five was also a real, shipped, then-unsolved gap — the last thing this
document named as missing, now fixed. By construction it never risked money:
the confirm handler treats *any* timeout or disconnect while waiting for
`COMMITTED` as a failure and marks the reservation `expired` without ever
capturing payment — see the `node_unreachable_hold_not_confirmed` path in
`server.js`. What it left was a pure state *mismatch*: the node may have
actually applied the commit permanently (no TTL) while the platform believed
the slot was free again. A second user attempting to book that window was
safely, correctly denied by the node itself (a real conflict, not a false
one) — but the first user was told their booking expired when the node would
in fact have run their job, with no path to retry since the slot read as
taken, and the slot itself stayed permanently squatted on by a reservation
nobody could act on.

Fixed with the query this section used to say the protocol didn't have:
`RESERVATION_STATUS_QUERY` (backend → node, "what do you show for X?") and
`RESERVE_RELEASE` (backend → node, "give it up"), both in
`backend/src/ws/protocol.js`, driven by `hub.queryReservationStatus` /
`hub.releaseReservation` and a periodic sweep,
`reservations/reconciler.js`'s `reconcileExpiredMismatches` (every 60s in
`index.js` — less often than the other sweeps, since this one costs a real
network round trip per candidate row, not pure SQL). It deliberately does
**not** resurrect the platform's own reservation back to `confirmed` — that
would reopen "charged but not reserved" risk from the other direction, the
exact thing `machine.js`'s illegal `expired → confirmed` transition exists
to prevent. Instead it tells the *node* to release, so both sides agree the
slot is free and it becomes bookable again; the first user's inconvenience
is real but no longer permanent, and involves no money either way.

Verified live, not just in tests: reproduced the exact scenario against a
running backend and a real worker process (had the worker apply a commit
locally via its normal code path, then forced the platform's row to
`expired` to simulate the lost acknowledgment) and confirmed the periodic
sweep found the mismatch, sent a real `RESERVE_RELEASE` over the actual
socket, the worker's local status flipped from `confirmed` to `released`,
the platform's row correctly stayed `expired` rather than being resurrected,
and the identical slot could genuinely be rebooked afterward.

## What is NOT solved yet

- **Byzantine nodes.** A node can sign a receipt and then simply not run the
  job. Detection today is the heartbeat; the economic answer is reputation plus
  selective duplicate execution, not cryptography.
- **Clock skew.** Hold TTLs compare timestamps across machines. Currently
  assumes loose NTP sync; a node with a fast clock releases early. Needs a
  monotonic handshake or a generous safety margin before production.
- **NAT traversal — still not solved.** Phase 2 P2P discovery now exists
  (`backend/src/ws/hub.js#introducePeers`, `worker/nodeva_worker/peer.py`):
  when the platform pairs two nodes for duplicate-execution verification, it
  introduces them to each other by identity (public key) and by the
  platform's own OBSERVED address for each node's existing connection, not
  anything either node claims about itself. If both nodes have opted into a
  local peer listener, they open a real, mutually-authenticated direct TCP
  connection to each other, reusing their existing Ed25519 identities --
  "the trust artifact does not change, only the transport" turned out to be
  true. What this does NOT do is get through a NAT that isn't already
  forwarding the advertised port: a node behind a typical residential or
  CGNAT setup with no port forwarding still cannot accept an inbound
  connection, direct or otherwise, for the exact reason described above (the
  platform itself has never been able to open a socket to a node either).
  Solving that needs STUN/TURN-style relays and hole punching, which is a
  harder problem this does not attempt. See `scripts/p2p_demo.sh` for a live
  run proving the discovery + direct-connection half against two real
  worker processes.
