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
//   - RECOMMENDING verification is not the same as TRIGGERING it.
//     shouldRecommendVerification below flags a node as worth
//     double-checking (new/unproven, unreliable, or a high-value booking --
//     exactly the master brief's own "new providers, suspicious providers,
//     high-value jobs" list). It is surfaced to the caller as information,
//     never used to silently book a second reservation and double-charge
//     someone without their say-so -- that would violate the opt-in design
//     of verify_against_reservation_id as surely as skipping the
//     recommendation entirely would violate honesty about the risk. The
//     caller (today: the frontend, showing a badge) still decides.
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

// --- recommending, not triggering, verification ---------------------------
//
// Thresholds are illustrative starting points, not researched constants --
// exactly the kind of parameter the master brief's own scheduling research
// direction exists to tune with real data, not something to treat as
// settled because a number appears here.
const NEW_PROVIDER_JOB_THRESHOLD = 5;     // fewer completed jobs than this = unproven
const LOW_RELIABILITY_THRESHOLD = 0.9;    // below this = "suspicious" per the master brief
const HIGH_VALUE_PAISE_THRESHOLD = 10_000; // >= ₹100 quoted = worth the extra scrutiny

/** Whether a search result is worth flagging to the user as a candidate for
 * duplicate-execution verification -- new/unproven provider, below-threshold
 * reliability, or a high-value booking, matching the master brief's own
 * "new providers, suspicious providers, high-value jobs" criteria. Returns a
 * boolean plus the specific reason(s), so a UI can say WHY rather than just
 * showing an unexplained badge. */
export function shouldRecommendVerification({ repJobsTotal, reliability }, quotedPaise) {
  const reasons = [];
  const isNew = (repJobsTotal ?? 0) < NEW_PROVIDER_JOB_THRESHOLD;
  if (isNew) reasons.push('new_provider');
  // Only evaluated for a provider with an actual track record. A brand-new
  // node's reliability is nodeStore.js's neutral DEFAULT (0.8 -- "no
  // opinion yet"), not a measurement, and it happens to sit below this
  // threshold -- checking it unconditionally would flag every new_provider
  // as ALSO low_reliability, muddying two genuinely different signals: "we
  // don't know yet" is not the same claim as "we know, and it's bad."
  // Caught live: a freshly enrolled node with zero jobs showed both reasons
  // on the same badge before this guard existed.
  if (!isNew && (reliability ?? 1) < LOW_RELIABILITY_THRESHOLD) reasons.push('low_reliability');
  if ((quotedPaise ?? 0) >= HIGH_VALUE_PAISE_THRESHOLD) reasons.push('high_value_job');
  return { recommended: reasons.length > 0, reasons };
}
