// Candidate ranking for a compute request.
//
// NOTE ON THE OBVIOUS FORMULA: the tempting scoring function is
//     score = w1*perf + w2*price + w3*reliability + w4*latency
// That is wrong as written. Those terms carry incommensurate units — rupees,
// milliseconds, a 0-100 index, a probability — so the weights silently encode
// unit choices rather than preferences, and switching price from rupees to
// paise would reorder the results. Everything must be normalized to a common
// [0,1] scale, with direction applied, BEFORE weighting.
//
// Requirements are CONSTRAINTS, not preferences. A node with 16GB VRAM does not
// "score lower" for a job needing 20GB — it cannot run it at all. Hard-filter
// first, then rank only what is feasible.

export const MODES = {
  // Weights sum to 1 within each mode. Tuned by hand for the MVP; these are
  // exactly the parameters the scheduling evaluation is meant to learn.
  cheapest:   { cost: 0.70, perf: 0.05, reliability: 0.20, latency: 0.05 },
  best_value: { cost: 0.35, perf: 0.30, reliability: 0.25, latency: 0.10 },
  fastest:    { cost: 0.05, perf: 0.60, reliability: 0.20, latency: 0.15 },
};

export function feasible(node, req) {
  if (node.status !== 'online') return false;
  if (node.gpu_vram_mb < req.min_vram_mb) return false;
  if (node.cpu_cores  < req.min_cpu_cores) return false;
  if (node.ram_mb     < req.min_ram_mb) return false;
  if (req.max_price_paise_hr != null &&
      node.price_paise_hr > req.max_price_paise_hr) return false;
  return coversWindow(node.availability ?? [], req.starts_at, req.ends_at);
}

// The node must offer ONE window fully containing the request. Stitching two
// adjacent windows together would be a lie: a gap between them is a period the
// provider said they are unavailable.
export function coversWindow(windows, startsAt, endsAt) {
  return windows.some(w => w.start <= startsAt && w.end >= endsAt);
}

// Reliability-adjusted cost. A node at ₹35/hr that fails 20% of the time costs
// more in expectation than one at ₹40/hr that never fails, because a failure
// means re-running the job somewhere else. Ranking on sticker price alone
// systematically steers users toward flaky hardware — the single most useful
// correction this scheduler makes over "sort by price ascending".
export function expectedCostPaise(node, hours) {
  const r = clamp(node.reliability ?? 0.5, 0.01, 1);
  return (node.price_paise_hr * hours) / r;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// Min-max normalize to [0,1]. `lowerIsBetter` inverts so 1 is always good.
// A degenerate spread (every candidate identical) yields a neutral 0.5 rather
// than a divide-by-zero or a spurious winner.
function normalize(values, lowerIsBetter) {
  const min = Math.min(...values), max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map(v => {
    const t = (v - min) / (max - min);
    return lowerIsBetter ? 1 - t : t;
  });
}

export function rank(nodes, req, mode = 'best_value') {
  const w = MODES[mode];
  if (!w) throw new Error(`unknown optimization mode: ${mode}`);

  const pool = nodes.filter(n => feasible(n, req));
  if (pool.length === 0) return [];

  const hours = (req.ends_at - req.starts_at) / 3_600_000;

  const nCost = normalize(pool.map(n => expectedCostPaise(n, hours)), true);
  const nPerf = normalize(pool.map(n => n.perf_score ?? 0), false);
  const nRel  = normalize(pool.map(n => n.reliability ?? 0.5), false);
  const nLat  = normalize(pool.map(n => n.latency_ms ?? 0), true);

  return pool
    .map((n, i) => ({
      node: n,
      score: w.cost * nCost[i] + w.perf * nPerf[i]
           + w.reliability * nRel[i] + w.latency * nLat[i],
      quoted_paise: Math.ceil(n.price_paise_hr * hours),
      expected_cost_paise: Math.round(expectedCostPaise(n, hours)),
    }))
    .sort((a, b) => b.score - a.score);
}
