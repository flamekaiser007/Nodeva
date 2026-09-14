// Real, scrapeable Prometheus metrics -- the actual observability gap
// admin/ops-summary (a single hand-built SQL query, GET on demand) never
// closed: nothing here answers "how many reservations/hour", "what's the
// job-submission error rate", or "is search latency creeping up" without
// someone remembering to query Postgres by hand.
//
// prom-client is the long-standing official Prometheus client for
// Node.js -- despite carrying a "replaced by @prometheus-io/client"
// deprecation notice as of this writing, that successor is pre-1.0 and a
// few weeks old; picking it over a mature, widely-deployed library for a
// production observability dependency would be exactly the kind of
// premature dependency risk this project has avoided elsewhere (stdlib
// over psutil, nvidia-smi over an NVML binding). Revisit once the
// successor has an actual track record.
import client from 'prom-client';

export const registry = new client.Registry();

// Node.js process metrics (heap, event loop lag, GC, fd count) -- the
// baseline every Prometheus-monitored Node service exposes, not specific
// to this project's own business logic.
client.collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new client.Counter({
  name: 'nodeva_http_requests_total',
  help: 'Total HTTP requests, labeled by method, route, and status code.',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: 'nodeva_http_request_duration_seconds',
  help: 'HTTP request duration in seconds, labeled by method, route, and status code.',
  labelNames: ['method', 'route', 'status'],
  // Tuned for a request path dominated by fast Postgres queries with a few
  // genuinely slow ones (a live WebSocket round trip to a worker can take
  // seconds -- see ws/hub.js's *_TIMEOUT_MS constants) rather than assuming
  // every request is sub-100ms.
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// Business metrics -- the numbers an operator actually wants to graph or
// alert on, not just "is the process up". Each is incremented at exactly
// one call site in api/server.js, right where the outcome it counts is
// already being decided, rather than inferred after the fact from logs.
export const reservationsCreatedTotal = new client.Counter({
  name: 'nodeva_reservations_created_total',
  help: 'Reservations created (held), regardless of what happens to them afterward.',
  registers: [registry],
});

export const reservationsSettledTotal = new client.Counter({
  name: 'nodeva_reservations_settled_total',
  help: 'Reservations reaching a terminal settlement outcome, labeled by outcome.',
  labelNames: ['outcome'],
  registers: [registry],
});

export const jobsSubmittedTotal = new client.Counter({
  name: 'nodeva_jobs_submitted_total',
  help: 'Jobs submitted to a node, labeled by whether verification was requested.',
  labelNames: ['verified'],
  registers: [registry],
});

export const disputeResolutionsTotal = new client.Counter({
  name: 'nodeva_dispute_resolutions_total',
  help: 'Third-node dispute tiebreakers resolved, labeled by verdict.',
  labelNames: ['verdict'],
  registers: [registry],
});

export const refundRetriesExhaustedTotal = new client.Counter({
  name: 'nodeva_refund_retries_exhausted_total',
  help: 'Refund retries that hit the retry ceiling with no success -- the row a human needs to look at.',
  registers: [registry],
});

// Express middleware: records one HTTP request's count and duration once
// the response finishes. Uses the matched Express ROUTE pattern (e.g.
// '/reservations/:id/jobs'), not req.path/req.originalUrl, so a UUID in
// the URL doesn't explode this into one label series per reservation ever
// created -- an unbounded label cardinality is a real, well-known way to
// quietly take down a Prometheus server, not a hypothetical concern.
export function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path ?? req.baseUrl ?? 'unmatched';
    const labels = { method: req.method, route, status: String(res.statusCode) };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSeconds);
  });
  next();
}

/** Test-only escape hatch: registries otherwise accumulate for the life of
 * the process, which is correct in production but would let one test's
 * counts bleed into the next within the same file. */
export function _resetMetricsForTests() {
  registry.resetMetrics();
}
