// What a settlement outcome says about the PROVIDER, as opposed to the user's
// workload or a booking that never ran anything at all.
//
// The distinction that matters: reputation tracks whether the node upheld
// its end (accepted the job, ran it, stayed reachable) -- not whether the
// user's own code was any good. A node that faithfully runs a thousand jobs
// that all crash on bad user input is a perfectly reliable node; punishing
// it for that would make reliable providers indistinguishable from flaky
// ones and defeat the entire point of the scheduler's reliability-adjusted
// ranking (see marketplace/scheduler.js).
//
// 'expired' and 'cancelled' are booking-level outcomes where no job ever
// ran -- there is no signal about the node's behavior either way, so they
// are deliberately excluded rather than mapped to a default.
//
// 'disputed' (jobs/verification.js's duplicate-execution result) is
// excluded for a different reason: two independent nodes disagreeing PROVES
// at least one of them is wrong, but not which -- there is no principled
// way to move a specific node's counters from a two-sample disagreement
// alone. Punishing both would be unfair to whichever one was honest;
// punishing neither is the only defensible default from a settlement
// outcome alone. A real dispute-resolution process now exists as a
// SEPARATE, opt-in path -- see api/server.js's resolveDisputeTiebreaker,
// which applies a reputation failure directly to whichever node a
// third-node majority vote attributes fault to, bypassing this map
// entirely (it isn't a settlement outcome, so it was never going to fit
// the EFFECT table below).
const EFFECT = {
  completed: 'success',
  failed_user: 'success',       // the node did its job; the workload was bad
  failed_provider: 'failure',
};

/** Returns 'success', 'failure', or null (no reputation signal) for a
 * reservation settlement outcome. */
export function reputationEffect(outcome) {
  return EFFECT[outcome] ?? null;
}
