#!/usr/bin/env node
// A Monte Carlo backtest of the real scheduler (marketplace/scheduler.js)
// and verification-recommendation logic (jobs/verification.js) against a
// synthetic provider population and job stream -- this is the master
// brief's own scheduling-research direction, done as far as it can go
// without real production traffic: MODES' weights and
// DEFAULT_VERIFICATION_THRESHOLDS have always been documented as
// "illustrative, not researched constants" (see both files' comments).
// This script makes that claim checkable instead of just asserted, and
// gives a concrete, reproducible basis for adjusting them -- or for
// leaving them alone with actual evidence they're already reasonable.
//
// HONEST LIMITS, stated up front:
//   - The population and failure model below are ASSUMPTIONS about what a
//     real provider base and job stream would look like (see "Assumptions"
//     below), not measurements. Real traffic would very likely look
//     different in ways that change the optimal thresholds. This is a
//     sensitivity analysis under a stated model, not a substitute for
//     production data -- it answers "given this model of the world, which
//     thresholds behave better than others", not "here are the correct
//     thresholds."
//   - It calls the REAL rank() and shouldRecommendVerification() from this
//     codebase, not a reimplementation -- so it can never silently drift
//     from what actually ships, but it also means a bug in those functions
//     would show up here as "realistic-looking" data rather than an error.
//   - Availability windows are not modeled (every provider is treated as
//     always online and available) -- that mechanism is a separately
//     solved, unrelated concern (reservations/machine.js, GiST exclusion
//     constraints); modeling it here would only add noise to what this
//     script is actually measuring.
//
// Usage: node scripts/scheduler_simulation.js [--providers=N] [--jobs=N] [--seed=N]

import { rank, MODES } from '../src/marketplace/scheduler.js';
import { shouldRecommendVerification, DEFAULT_VERIFICATION_THRESHOLDS } from '../src/jobs/verification.js';

// --- reproducible PRNG ------------------------------------------------------
// A real experiment needs the same run to produce the same numbers on
// re-run (for review, for comparing a code change's effect) -- Math.random
// can't offer that. mulberry32 is a small, fast, public-domain PRNG; not
// cryptographic, not needed to be.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseArgs(argv) {
  const out = { providers: 200, jobs: 5000, seed: 42 };
  for (const arg of argv) {
    const m = /^--(providers|jobs|seed)=(\d+)$/.exec(arg);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

// --- synthetic population ---------------------------------------------------
//
// Assumptions (the model this backtest is a sensitivity analysis UNDER, not
// a claim about the real world):
//   - True per-job reliability is a genuine hidden probability per provider,
//     drawn from a bimodal mix: 85% "normal" providers clustered high
//     (Beta(20,1), mean ~0.95) and 15% "flaky" providers spread wide
//     (Beta(2,2), mean ~0.5) -- modeling a marketplace where most providers
//     are fine and a meaningful minority genuinely are not.
//   - Job history length is itself bimodal: 40% of providers are brand new
//     (0 completed jobs -- exactly the case nodeStore.js's neutral 0.8
//     default and shouldRecommendVerification's new_provider path exist
//     for), the rest have between 1 and 300 jobs uniformly.
//   - Observed rep_jobs_failed is a real Binomial draw from that hidden true
//     reliability over that many jobs -- i.e. observed reliability is a
//     noisy ESTIMATE of true reliability, exactly as it would be for a real
//     provider, not the true value itself.
//   - Price is weakly anti-correlated with true reliability plus noise
//     (flakier hardware undercutting on price is a plausible, not
//     certain, market dynamic) -- this is the assumption most likely to be
//     wrong for a real marketplace and worth revisiting first if real data
//     becomes available.
function betaSample(rand, alpha, beta) {
  // Two Gamma(k,1) draws via Marsaglia-Tsang, ratio gives a Beta(alpha,beta)
  // sample -- good enough for alpha,beta in the small integer range used here.
  const gamma = (k) => {
    let x, v, u;
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      do { x = gaussian(rand); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      u = rand();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  const ga = gamma(alpha), gb = gamma(beta);
  return ga / (ga + gb);
}
function gaussian(rand) {
  const u1 = Math.max(rand(), 1e-12), u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function generateProviders(n, rand) {
  const providers = [];
  for (let i = 0; i < n; i++) {
    const isFlaky = rand() < 0.15;
    const trueReliability = isFlaky ? betaSample(rand, 2, 2) : betaSample(rand, 20, 1);

    const isNew = rand() < 0.4;
    const repJobsTotal = isNew ? 0 : Math.floor(rand() * 300) + 1;
    let repJobsFailed = 0;
    for (let j = 0; j < repJobsTotal; j++) if (rand() > trueReliability) repJobsFailed++;
    const observedReliability = repJobsTotal > 0 ? 1 - repJobsFailed / repJobsTotal : 0.8;

    const basePricePaiseHr = 2000 + Math.floor(rand() * 8000); // ₹20-100/hr
    const priceAdjustment = Math.round((1 - trueReliability) * -1500); // flakier -> cheaper, weakly
    const priceNoise = Math.floor((rand() - 0.5) * 1000);

    providers.push({
      id: i,
      status: 'online',
      gpu_vram_mb: [12288, 16384, 24576, 49152][Math.floor(rand() * 4)],
      cpu_cores: [8, 16, 32][Math.floor(rand() * 3)],
      ram_mb: [16384, 32768, 65536][Math.floor(rand() * 3)],
      price_paise_hr: Math.max(500, basePricePaiseHr + priceAdjustment + priceNoise),
      perf_score: Math.round(rand() * 100),
      latency_ms: Math.round(10 + rand() * 200),
      reliability: observedReliability,
      rep_jobs_total: repJobsTotal,
      availability: [{ start: 0, end: Infinity }],
      _trueReliability: trueReliability, // hidden -- only the simulator's "ground truth" reads this
    });
  }
  return providers;
}

export function generateRequest(rand) {
  const modeNames = Object.keys(MODES);
  return {
    min_vram_mb: [8192, 12288, 16384, 20480][Math.floor(rand() * 4)],
    min_cpu_cores: [4, 8, 16][Math.floor(rand() * 3)],
    min_ram_mb: [8192, 16384, 32768][Math.floor(rand() * 3)],
    max_price_paise_hr: 3000 + Math.floor(rand() * 9000),
    starts_at: 0,
    ends_at: 3_600_000, // 1 hour, fixed -- window logic isn't what's under test
    mode: modeNames[Math.floor(rand() * modeNames.length)],
  };
}

// --- one backtest pass, given a set of verification thresholds --------------
export function runBacktest(providers, requests, thresholds) {
  const perMode = {};
  for (const modeName of Object.keys(MODES)) {
    perMode[modeName] = {
      picked: 0, failed: 0, recommended: 0,
      recommendedAndFailed: 0, notRecommendedAndFailed: 0,
      totalQuotedPaise: 0, totalCheapestFeasiblePaise: 0,
    };
  }

  const failureRand = mulberry32(0xC0FFEE); // separate stream: outcomes must
  // not depend on which thresholds are being swept, so every threshold
  // config in one sweep sees the IDENTICAL sequence of job outcomes for the
  // identical sequence of picks -- otherwise a threshold's apparent effect
  // could just be noise from a different random draw, not the threshold.

  for (const req of requests) {
    const ranked = rank(providers, req, req.mode);
    if (ranked.length === 0) continue;
    const top = ranked[0];
    const stats = perMode[req.mode];

    stats.picked += 1;
    stats.totalQuotedPaise += top.quoted_paise;
    stats.totalCheapestFeasiblePaise += Math.min(...ranked.map((r) => r.quoted_paise));

    const outcomeRoll = failureRand();
    const failed = outcomeRoll > top.node._trueReliability;
    if (failed) stats.failed += 1;

    const verification = shouldRecommendVerification(
      { repJobsTotal: top.node.rep_jobs_total, reliability: top.node.reliability },
      top.quoted_paise, thresholds);
    if (verification.recommended) {
      stats.recommended += 1;
      if (failed) stats.recommendedAndFailed += 1;
    } else if (failed) {
      stats.notRecommendedAndFailed += 1;
    }
  }

  const summary = {};
  for (const [modeName, s] of Object.entries(perMode)) {
    const recall = s.failed > 0 ? s.recommendedAndFailed / s.failed : null;
    const precision = s.recommended > 0 ? s.recommendedAndFailed / s.recommended : null;
    summary[modeName] = {
      picked: s.picked,
      failureRate: s.picked > 0 ? s.failed / s.picked : null,
      recommendedRate: s.picked > 0 ? s.recommended / s.picked : null,
      recall, // of jobs that failed, what fraction were flagged beforehand
      precision, // of jobs flagged, what fraction actually failed
      avgCostPremiumPct: s.totalCheapestFeasiblePaise > 0
        ? ((s.totalQuotedPaise - s.totalCheapestFeasiblePaise) / s.totalCheapestFeasiblePaise) * 100
        : null,
    };
  }
  return summary;
}

function fmtPct(x) { return x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`; }

export function main() {
  const args = parseArgs(process.argv.slice(2));
  const rand = mulberry32(args.seed);
  const providers = generateProviders(args.providers, rand);
  const requests = Array.from({ length: args.jobs }, () => generateRequest(rand));

  console.log(`# Scheduler backtest -- ${args.providers} providers, ${args.jobs} requests, seed ${args.seed}\n`);

  console.log('## Baseline: current DEFAULT_VERIFICATION_THRESHOLDS, all three scheduler modes\n');
  const baseline = runBacktest(providers, requests, DEFAULT_VERIFICATION_THRESHOLDS);
  console.log('mode        picked  failure%  recommended%  recall  precision  cost premium vs cheapest');
  for (const [modeName, s] of Object.entries(baseline)) {
    console.log(
      `${modeName.padEnd(11)} ${String(s.picked).padStart(6)}  ${fmtPct(s.failureRate).padStart(8)}  `
      + `${fmtPct(s.recommendedRate).padStart(12)}  ${fmtPct(s.recall).padStart(6)}  `
      + `${fmtPct(s.precision).padStart(9)}  ${s.avgCostPremiumPct?.toFixed(1)}%`);
  }

  console.log('\n## Does reliability-adjusted ranking actually reduce failures vs "cheapest"?\n');
  console.log(
    `cheapest failure rate:   ${fmtPct(baseline.cheapest.failureRate)}\n`
    + `best_value failure rate: ${fmtPct(baseline.best_value.failureRate)} `
    + `(${((1 - baseline.best_value.failureRate / baseline.cheapest.failureRate) * 100).toFixed(0)}% relative reduction)\n`
    + `fastest failure rate:    ${fmtPct(baseline.fastest.failureRate)}`);

  console.log('\n## Threshold sweep (best_value mode only -- the default for a user who expresses no preference)\n');
  console.log('newProviderJobThreshold  lowReliabilityThreshold  recall  precision  recommended%');
  const jobThresholds = [3, 5, 10, 20];
  const reliabilityThresholds = [0.80, 0.85, 0.90, 0.95, 0.97];
  let best = null;
  for (const newProviderJobThreshold of jobThresholds) {
    for (const lowReliabilityThreshold of reliabilityThresholds) {
      const thresholds = {
        ...DEFAULT_VERIFICATION_THRESHOLDS, newProviderJobThreshold, lowReliabilityThreshold,
      };
      const result = runBacktest(providers, requests, thresholds).best_value;
      const f1 = result.recall && result.precision
        ? (2 * result.recall * result.precision) / (result.recall + result.precision) : 0;
      console.log(
        `${String(newProviderJobThreshold).padStart(23)}  ${lowReliabilityThreshold.toFixed(2).padStart(23)}  `
        + `${fmtPct(result.recall).padStart(6)}  ${fmtPct(result.precision).padStart(9)}  ${fmtPct(result.recommendedRate).padStart(12)}`);
      if (!best || f1 > best.f1) best = { newProviderJobThreshold, lowReliabilityThreshold, f1, ...result };
    }
  }
  console.log(
    `\nBest F1 (recall/precision balance) under this model: `
    + `newProviderJobThreshold=${best.newProviderJobThreshold}, lowReliabilityThreshold=${best.lowReliabilityThreshold} `
    + `(recall ${fmtPct(best.recall)}, precision ${fmtPct(best.precision)})`);
  console.log(
    `Current defaults: newProviderJobThreshold=${DEFAULT_VERIFICATION_THRESHOLDS.newProviderJobThreshold}, `
    + `lowReliabilityThreshold=${DEFAULT_VERIFICATION_THRESHOLDS.lowReliabilityThreshold} `
    + `(recall ${fmtPct(baseline.best_value.recall)}, precision ${fmtPct(baseline.best_value.precision)})`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
