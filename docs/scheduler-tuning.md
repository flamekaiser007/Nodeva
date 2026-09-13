# Scheduler and verification-threshold tuning: a synthetic backtest

`marketplace/scheduler.js`'s `MODES` weights and `jobs/verification.js`'s
`DEFAULT_VERIFICATION_THRESHOLDS` have always been documented in-code as
"illustrative starting points, not researched constants" — exactly the
parameter space the master brief's own scheduling-research direction calls
out for tuning with real data. This project has no real production traffic
to tune against yet. `backend/scripts/scheduler_simulation.js` is the
closest honest substitute available now: a reproducible Monte Carlo
backtest that runs the **actual** `rank()` and `shouldRecommendVerification()`
functions (not reimplementations) against a synthetic provider population
and job stream, so the current thresholds' behavior is *checkable* rather
than merely asserted.

Run it yourself: `node backend/scripts/scheduler_simulation.js
[--providers=N] [--jobs=N] [--seed=N]`.

## What this is and is not

This is a **sensitivity analysis under a stated model**, not a substitute
for production data. The model (see the script's own header comment for
the full assumption list) posits: 85% of providers are genuinely reliable
(mean ~95%), 15% are flaky (mean ~50%); 40% of providers are brand new
(zero job history); price is weakly anti-correlated with true reliability.
Every one of those is a plausible guess, not a measurement. If any of them
is wrong for a real marketplace — and the price/reliability correlation in
particular is the shakiest one — the numbers below shift. What the backtest
*can* say with confidence is how the current code's behavior responds to
that stated model, which is still strictly more than "we picked these
numbers because they seemed reasonable."

The full run below used the defaults: 200 providers, 5,000 job requests,
seed 42 (deterministic — rerunning with the same seed reproduces it
exactly).

## Finding 1: reliability-adjusted ranking helps, modestly

| mode | failure rate |
|---|---|
| cheapest | 3.6% |
| best_value | 3.4% |
| fastest | 6.4% |

`best_value`'s reliability-adjusted expected cost
(`scheduler.js`'s `expectedCostPaise`) gives only a **7% relative
reduction** in failure rate over `cheapest` under this model — real, but
smaller than the marketing pitch for the mechanism might suggest. More
strikingly, **`fastest` nearly doubles the failure rate of the other two
modes** (6.4% vs ~3.5%): weighting performance at 60% and reliability at
only 20% (`MODES.fastest`) measurably trades away reliability for speed.
This isn't necessarily wrong — a user who explicitly chose "fastest" may
be accepting that tradeoff — but it was not a previously *quantified*
tradeoff, and an operator or a future UI could reasonably decide 6.4% is
worth surfacing to a "fastest" user more explicitly than it currently is.

## Finding 2: the verification recommendation is nearly inert outside "cheapest" mode

| mode | recommended% | recall (of failures, % flagged) | precision (of flags, % that failed) |
|---|---|---|---|
| cheapest | 1.8% | 26.7% | 55.2% |
| best_value | 0.0% | 0.0% | n/a |
| fastest | 0.0% | 0.0% | n/a |

At the current defaults (`newProviderJobThreshold: 5`,
`lowReliabilityThreshold: 0.9`), the verification recommendation
essentially **never fires for `best_value` or `fastest`'s actual top
pick**. The reason is structural, not a bug: both modes weight reliability
heavily enough (25% and 20%) that among any reasonably sized feasible
pool, the single highest-scoring candidate is almost always already an
established, high-reliability provider — the scheduler's own ranking
formula is already filtering out exactly the candidates the verification
flag exists to catch, before the flag is ever evaluated on the winner.
`cheapest` mode weights reliability at only 20% behind a 70% cost term, so
its top pick is meaningfully more likely to be new or flaky — which is
exactly where the recommendation shows real recall (26.7%) and strong
precision (55.2%: more than half of what it flags actually would have
failed).

**Reading this finding correctly matters.** It is not evidence the
recommendation is broken — every individual *candidate* the scheduler
returns still carries its own `verification_recommended` flag (see
`ResultsList.jsx`), so a user comparing options still sees it on any
result that warrants it. What this shows is that the flag's practical
value concentrates in `cheapest` mode specifically, because that's the
one mode whose own ranking doesn't already do most of that filtering
itself.

## Finding 3: the current reliability threshold (0.9) is set below where it can act, for best_value

| newProviderJobThreshold | lowReliabilityThreshold | recall | precision | recommended% |
|---|---|---|---|---|
| any of 3/5/10/20 | 0.80 – 0.90 | 0.0% | n/a | 0.0% |
| any of 3/5/10/20 | 0.95 | 63.2% | 8.6% | 24.8% |
| any of 3/5/10/20 | 0.97 | 63.2% | 8.6% | 24.8% |

Two things stand out. First, **`newProviderJobThreshold` has no measurable
effect at all** on `best_value`'s top pick in this model — for the same
structural reason as Finding 2, the winning candidate is essentially never
a brand-new provider under this weighting, so the threshold that decides
"how many jobs counts as proven" never gets exercised. Second,
`lowReliabilityThreshold` behaves as a **hard cliff, not a gradient**:
nothing between 0.80 and 0.90 changes the outcome, then 0.95 unlocks 63.2%
recall at once. That cliff shape is itself informative — it means the
`best_value`-selected candidates' observed reliabilities cluster tightly
just above 0.90 in this population, so the threshold needs to cross that
specific cluster to have any effect at all.

The F1-optimal point in this sweep is `lowReliabilityThreshold: 0.95`
(recall 63.2%, precision 8.6%) — but precision of 8.6% means roughly 1 in
12 jobs flagged at that setting would actually have failed; the other 11
pay the verification cost (a second reservation) for no reason. Whether
that trade is worth it is a **product decision**, not something this
synthetic model alone can settle, and this document deliberately stops
short of recommending it be adopted outright.

## Recommendation

Given the above, the honest recommendation is:

1. **Do not silently change `DEFAULT_VERIFICATION_THRESHOLDS` based on this
   synthetic sweep alone.** Presenting a simulation-derived number as
   validated would overclaim what a stated-assumption model can prove —
   exactly the overclaiming this project has tried to avoid everywhere
   else. The defaults (5, 0.9) remain in place.
2. **`lowReliabilityThreshold` is worth revisiting once real usage data
   exists**, specifically checking whether real `best_value`/`fastest`
   winners' reliability distribution shows the same cliff around 0.90-0.95
   this synthetic population does. If so, raising it toward 0.93-0.95 (a
   smaller step than this sweep's optimum, given the precision cost) would
   meaningfully improve the recommendation's usefulness outside
   `cheapest` mode without needing to accept 91.4% false-positive risk.
3. **`fastest` mode's ~2x failure rate relative to the other two modes** is
   the more actionable, robust-to-assumptions finding here (it follows
   directly from the weights, not from the population model's specific
   shape) and is worth surfacing to a user choosing that mode, independent
   of anything about verification thresholds.
4. **Treat the price/reliability anti-correlation assumption as the
   weakest link** in this model. If real data ever shows prices and
   reliability are uncorrelated, or positively correlated, several of the
   numbers above would shift; re-running the backtest with that
   assumption removed or reversed would be the first thing to check.

Re-run `scheduler_simulation.js` whenever `MODES` or
`DEFAULT_VERIFICATION_THRESHOLDS` change, or whenever real traffic
provides a population to calibrate the generator against instead of the
stated assumptions.
