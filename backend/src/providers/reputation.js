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
