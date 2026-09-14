// Optional shipping of this project's structured logs (logger.js) to a
// real log aggregator (Grafana Loki), off by default. Uses the platform's
// built-in `fetch` rather than a new HTTP client dependency -- the same
// stdlib-first reasoning as worker/hardware.py's nvidia-smi-over-NVML-binding
// choice, just applied to Node instead of Python.
//
// Batches lines and flushes on a timer instead of one HTTP request per log
// line: a push-per-line design would mean a busy period (the exact moment
// operators most want their logs) turns logging itself into a source of
// load, which is backwards for an observability feature.
const DEFAULT_BATCH_INTERVAL_MS = 2000;
const DEFAULT_MAX_BATCH = 500;

export function createLokiSink({
  url,
  labels = { service: 'nodeva-backend' },
  batchIntervalMs = DEFAULT_BATCH_INTERVAL_MS,
  maxBatch = DEFAULT_MAX_BATCH,
  fetchImpl = fetch,
  onError,
} = {}) {
  let buffer = [];

  async function flush() {
    if (buffer.length === 0) return;
    const values = buffer;
    buffer = [];
    try {
      const res = await fetchImpl(`${url}/loki/api/v1/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streams: [{ stream: labels, values }] }),
      });
      if (!res.ok) throw new Error(`Loki push responded ${res.status}`);
    } catch (e) {
      // Shipping logs must never crash or block the process emitting them
      // -- a Loki outage should degrade to "logs still went to
      // stdout/stderr, just didn't get aggregated," not take the backend
      // down with it.
      onError?.(e);
    }
  }

  function push(line) {
    // Loki's push API wants Unix-epoch NANOSECONDS as a string per entry --
    // Date.now() is milliseconds, so this is milliseconds * 1e6, not
    // process.hrtime (which is monotonic-since-an-arbitrary-origin, not a
    // real timestamp, and would make every shipped line appear to have
    // happened in 1970 or whenever the process booted).
    buffer.push([String(BigInt(Date.now()) * 1_000_000n), line]);
    if (buffer.length >= maxBatch) flush();
  }

  const timer = setInterval(flush, batchIntervalMs);
  timer.unref?.(); // never itself keeps the process alive

  return { push, flush, stop: () => clearInterval(timer) };
}
