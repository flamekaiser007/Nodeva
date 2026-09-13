# Job execution: threat model

Two directions of attack exist, and containerization only addresses one of
them. Conflating the two is how a project ends up believing it is safer than
it is — design principle #10 in the master brief exists for exactly this
reason.

## Direction 1: the user's workload attacks the provider

A user submits `{image, command}`. That workload runs on a stranger's
computer, next to their personal files, browser profile, and home network.
This is the direction Docker genuinely helps with, and `executor.py`
implements the controls below — each one verified against a real container in
`worker/tests/test_executor.py`, not assumed from the flag name.

| Control | Flag | What it stops |
|---|---|---|
| No root inside the container | `-u 65534:65534` | A root-owned process escaping a kernel bug has less to work with than one that was root already |
| All Linux capabilities dropped | `--cap-drop=ALL` | `CAP_SYS_ADMIN`-class escapes, raw sockets, mount manipulation |
| No privilege escalation | `--security-opt=no-new-privileges` | setuid binaries inside the image granting root |
| Read-only root filesystem | `--read-only` | Persisting a backdoor, tampering with the runtime |
| Writable space is scoped and capped | `--tmpfs /tmp:size=64m` + one bind-mounted workspace dir | Filling the provider's disk; anything written outside `/workspace` simply fails |
| No network | `--network none` | Exfiltrating data, scanning the provider's LAN, joining a botnet, reaching other tenants |
| Memory ceiling, no swap growth | `--memory` + equal `--memory-swap` | One job swamping host RAM and swap, degrading every other job and the provider's own use of the machine |
| CPU share cap | `--cpus` | Starving the host and other jobs |
| Process count cap | `--pids-limit` | A fork bomb |
| Wall-clock timeout | `docker kill` after the reservation window elapses | A runaway or intentionally-infinite job holding the GPU past what was paid for |

**What this table does NOT claim:** Docker containers share the host kernel.
A kernel or NVIDIA driver vulnerability can still escape a correctly-configured
container — this is a mitigation of blast radius, not a formal isolation
boundary. Production-grade providers should evaluate gVisor or Kata
Containers (a real VM boundary) before onboarding providers who did not
explicitly accept the residual risk.

**Known, currently unmitigated gaps in this direction:**

- **GPU isolation is the weakest link.** `--gpus` passes the device through
  the shared NVIDIA driver; there is no per-tenant VRAM enforcement at the
  container level (this is why `hardware.py` under-advertises free VRAM
  rather than relying on a hard limit — it reduces the chance of contention,
  it does not prevent a deliberately hostile job from reading another
  process's VRAM if the driver allows it). **Untested on this development
  machine, which has no NVIDIA GPU** — the code path exists behind a flag but
  needs validation on real GPU hardware before it is trusted.
- **Image pulls are a supply-chain risk.** `docker run` pulls whatever image
  reference the user supplies. A malicious image is itself a payload,
  independent of anything the sandbox does at runtime. MVP has no image
  allowlist or digest-pinning requirement; this needs a policy decision
  before opening the platform to arbitrary images.
- **Side channels** (cache timing, power analysis) are not addressed and are
  not currently considered in scope for the MVP threat model.

## Direction 2: the provider attacks the user

A provider that controls the machine can read the user's code and input
data in full, tamper with results before returning them, or simply lie
about having run the job at all. This direction has **no sandbox-side
mitigation at all** — nothing in Direction 1's controls touches it, since
they all assume the node itself is the thing being defended against a
hostile *workload*, not a node that is itself hostile.

**Partially addressed now**, not solved: `backend/src/jobs/verification.js`
implements the master brief's own answer — selective duplicate execution.
`POST /reservations/:id/jobs` accepts an optional
`verify_against_reservation_id`: a second, independently booked and
confirmed reservation on a *different* node, given the identical workload,
with results compared by SHA-256 hash once both finish. A match settles
both normally; a mismatch disputes both (full refund, see `machine.js`'s
`DISPUTED` state) rather than trusting either.

State the limits precisely, because they are easy to overstate:

- **This detects disagreement. It does not attribute fault.** Two nodes
  disagreeing proves at least one is wrong, never which — `reputation.js`
  deliberately leaves both untouched on a dispute rather than guessing.
  Real fault attribution needs a third node (majority vote) or a much
  harder verifiable-computation approach; neither exists here.
- **A match is agreement, not proof of correctness.** Two colluding
  malicious nodes pass cleanly. This raises the cost of cheating
  (compromise or collude with two independent operators, not one) — it does
  not eliminate it.
- **Triggering is opt-in and manual; recommending is not.**
  `shouldRecommendVerification` (`jobs/verification.js`, surfaced on every
  search result via `scheduler.rank()`) does flag new/unproven providers,
  below-threshold measured reliability, and high-value bookings
  automatically — the master brief's own "selective" criteria. But it only
  ever *recommends*: nothing books a second reservation or doubles a
  charge without the user explicitly asking for it via
  `verify_against_reservation_id`. Silently spending someone's money on
  their behalf would be worse than not verifying at all, so the line is
  drawn at "tell them," not "decide for them."
- **It doubles cost and still doesn't cover reading.** A malicious node can
  still read a user's code and input data even if verification later
  catches it lying about the output — nothing here is confidentiality.
  Verifiable computation (Phase 4/5 per the master roadmap) is the only
  real answer to that, and is not attempted.

Verified: the comparison and settlement logic is proven against a real
`Hub` with genuinely Ed25519-signed receipts and real Postgres
(`test/verification-flow.test.js`), and separately against two actual
worker processes running two actual Docker containers on independent
nodes, whose real (matching) `stdout` hashed identically and settled
correctly with the exact 90/10 split on both bookings.

## What this means for the MVP

Ship Direction 1's controls now (they are cheap, mechanical, and testable).
Direction 2 is now partially, honestly addressed for the specific case of
"can I tell if a provider lied about a result" — not for confidentiality,
not automatically, and not with fault attribution. Do not describe the
platform as "secure" without naming which direction, and how much of it,
that claim covers.
