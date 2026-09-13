// Reservation lifecycle.
//
// The hard part of this system is that two authorities must agree: the provider
// node owns the slot lock, we own the money. Either can fail independently, so
// every edge here is written to leave the pair in a state we can reconcile —
// never "charged but not reserved", never "reserved but free to rebook".
//
// Ordering rule: the node locks FIRST, we capture money SECOND. A lost lock
// costs the provider an idle hour; a lost payment costs a user real money, so
// the irreversible step goes last.

export const S = {
  PENDING: 'pending',                   // we intend to book; node not yet asked
  HELD: 'held',                         // node locked the slot and signed a receipt
  CONFIRMED: 'confirmed',               // funds captured into escrow; slot ours
  RUNNING: 'running',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',                   // node's hold TTL elapsed before we paid
  FAILED_PROVIDER: 'failed_provider',
  FAILED_USER: 'failed_user',
  // Reached only by a job submitted with duplicate-execution verification
  // (see jobs/verification.js) whose two independent nodes disagreed on the
  // result. Deliberately NOT the same as failed_provider: that state
  // asserts we know the node is at fault; a two-node disagreement only
  // proves at least one of them is wrong, not which -- see
  // docs/security-model.md's "Direction 2" section for why this is an
  // honest half-measure, not a solved problem.
  DISPUTED: 'disputed',
};

// Explicit edge list. Anything absent is a bug, not an edge case — we would
// rather throw than silently advance money-bearing state.
const EDGES = {
  [S.PENDING]:   [S.HELD, S.EXPIRED, S.CANCELLED],
  [S.HELD]:      [S.CONFIRMED, S.EXPIRED, S.CANCELLED],
  [S.CONFIRMED]: [S.RUNNING, S.CANCELLED, S.FAILED_PROVIDER],
  [S.RUNNING]:   [S.COMPLETED, S.FAILED_PROVIDER, S.FAILED_USER, S.DISPUTED],
  [S.COMPLETED]: [],
  [S.CANCELLED]: [],
  [S.EXPIRED]: [],
  [S.FAILED_PROVIDER]: [],
  [S.FAILED_USER]: [],
  [S.DISPUTED]: [],
};

export const TERMINAL = new Set(
  Object.entries(EDGES).filter(([, to]) => to.length === 0).map(([s]) => s),
);

export function canTransition(from, to) {
  return (EDGES[from] ?? []).includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`illegal reservation transition ${from} -> ${to}`);
  }
  return to;
}

// What each terminal state means for the user's money. Kept beside the machine
// so a new state cannot be added without deciding who pays.
//
// The distinction that matters commercially: a job that failed because the
// user's own code threw still consumed the provider's GPU, so the provider is
// paid. A job that failed because the node vanished did not, so it is refunded
// in full. Conflating these either defrauds providers or defrauds users.
export const SETTLEMENT = {
  [S.COMPLETED]:       'settle_full',
  [S.FAILED_USER]:     'settle_metered', // bill compute actually consumed
  [S.FAILED_PROVIDER]: 'refund_full',
  [S.EXPIRED]:         'refund_full',    // never charged; release authorization
  [S.CANCELLED]:       'refund_per_policy',
  // A disputed result is refunded in full on the same reasoning as
  // failed_provider: the user did not get a workload they can trust, and
  // with only two samples we cannot bill them for a result that might be
  // the fabricated one. This is deliberately generous to the user over the
  // (possibly innocent) provider, which is the correct default until a
  // real dispute-resolution process can attribute fault.
  [S.DISPUTED]:        'refund_full',
};
