// Settlement math. All amounts are integer paise.
//
// Two rules that are not negotiable:
//   1. No floats. 0.1 + 0.2 problems in a ledger become audit findings.
//   2. Splits must be exact: provider + platform === total, always. We give the
//      provider the floor and the platform the remainder, so rounding dust
//      lands on the platform rather than being invented or destroyed.

export const PLATFORM_FEE_BPS = 1000; // 10.00% in basis points

export function split(totalPaise, feeBps = PLATFORM_FEE_BPS) {
  if (!Number.isInteger(totalPaise) || totalPaise < 0) {
    throw new Error(`totalPaise must be a non-negative integer, got ${totalPaise}`);
  }
  const platform = Math.ceil((totalPaise * feeBps) / 10000);
  const provider = totalPaise - platform;
  return { provider, platform, total: totalPaise };
}

// Price a reservation up front. Billing granularity is the reservation window,
// not the job: booking 10:00-11:00 occupies the node for an hour whether or not
// the user uses it.
export function quote(pricePaiseHr, startsAt, endsAt) {
  const seconds = Math.round((endsAt - startsAt) / 1000);
  if (seconds <= 0) throw new Error('reservation window must be positive');
  // Round up to the minute — sub-minute slivers are not worth metering and
  // rounding down lets a user shave the provider.
  const minutes = Math.ceil(seconds / 60);
  return Math.ceil((pricePaiseHr * minutes) / 60);
}

// Billing when the USER's workload failed (bad code, missing dependency).
// The provider held and powered the GPU, so they are paid for what ran — but
// capped at the quote, and with a floor so a job that dies in 2 seconds does
// not bill zero while still having occupied the slot.
export function meteredCharge(quotedPaise, pricePaiseHr, computeSeconds, {
  minimumMinutes = 5,
} = {}) {
  const billableMinutes = Math.max(
    minimumMinutes,
    Math.ceil(computeSeconds / 60),
  );
  const metered = Math.ceil((pricePaiseHr * billableMinutes) / 60);
  return Math.min(metered, quotedPaise);
}
