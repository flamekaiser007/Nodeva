// Duplicate-execution result verification -- docs/security-model.md's
// "Direction 2" (protecting the user from a malicious/lying provider),
// which nothing else in this project addresses. The master design's own
// answer to this is selective duplicate execution: run the same workload on
// two independent nodes and compare, rather than trusting either alone.
//
// HONEST LIMITS, stated up front rather than discovered later:
//   - two nodes can DETECT a disagreement, they cannot ATTRIBUTE it. If A
//     says "success, output X" and B says "success, output Y", exactly one
//     of them is lying (or one has a real, non-malicious bug), and nothing
//     here can tell you which. See reputation.js for why disputed jobs
//     carry no reputation signal for either node.
//   - this is opt-in, not automatic. Nothing currently decides FOR the user
//     that a given job is high-value or a given provider is under-trusted
//     enough to warrant the doubled cost of running it twice -- the caller
//     (today: whoever calls the API) makes that call explicitly. A policy
//     that triggers it automatically (new providers, expensive jobs) is
//     future work, not pretended to exist here.
//   - a match is not proof of correctness, only proof of AGREEMENT. Two
//     colluding malicious nodes would pass verification cleanly. This
//     raises the cost of cheating (compromising or colluding with two
//     independent operators instead of one); it does not eliminate it.

import crypto from 'node:crypto';

/** A canonical fingerprint of what a job actually did, independent of
 * everything about the reservation or node that ran it: two honest nodes
 * running the identical workload should produce the identical hash. */
export function computeResultHash({ status, exit_code, stdout, stderr }) {
  const canonical = JSON.stringify({
    status, exit_code: exit_code ?? null,
    stdout: stdout ?? '', stderr: stderr ?? '',
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** Compares two completed jobs in the same verification group.
 * Returns 'match' or 'mismatch' -- never a third "inconclusive" value,
 * because a settlement decision has to be made either way (see
 * server.js's onJobResult grouping logic), and treating an ambiguous case
 * as anything other than a mismatch would be the more exploitable default:
 * a dishonest node's easiest attack is to make its result LOOK ambiguous. */
export function compareJobResults(jobA, jobB) {
  if (jobA.result_hash && jobB.result_hash && jobA.result_hash === jobB.result_hash) {
    return 'match';
  }
  return 'mismatch';
}

/** True once every job in a group has reached a terminal status (the
 * group's shape does not know or care what the specific statuses are, only
 * that nothing is still running) -- the signal that it is time to compare. */
export function groupIsComplete(jobs, terminalStatuses) {
  return jobs.length >= 2 && jobs.every((j) => terminalStatuses.has(j.status));
}
