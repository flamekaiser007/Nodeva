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
| `RESERVE_COMMIT` lost in flight | lock expires via TTL | `confirmed` | **drift — reconciler must refund** |
| Node vanishes mid-job | — | `running → failed_provider` | full refund |
| User's code throws | — | `running → failed_user` | billed for compute consumed |

The fourth row is the one that matters. It is the only state where we hold money
for a slot the node has released, so it cannot be left to chance: a reconciler
sweeps `confirmed` reservations whose node never acknowledged the commit and
refunds them. Everything else is self-healing.

## What is NOT solved yet

- **Byzantine nodes.** A node can sign a receipt and then simply not run the
  job. Detection today is the heartbeat; the economic answer is reputation plus
  selective duplicate execution, not cryptography.
- **Clock skew.** Hold TTLs compare timestamps across machines. Currently
  assumes loose NTP sync; a node with a fast clock releases early. Needs a
  monotonic handshake or a generous safety margin before production.
- **NAT.** This diagram assumes the platform can reach the node. Most consumer
  GPUs are behind CGNAT and cannot accept inbound connections. Phase 1 sidesteps
  it with node-initiated WebSocket; Phase 2 needs relays.
