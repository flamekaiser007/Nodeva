// A small, dependency-free structured logger -- JSON lines to stdout/stderr,
// not a formatting library. The project's own stated philosophy (see
// worker/hardware.py's file header on nvidia-smi over an NVML binding, or
// stdlib-only CPU/RAM detection) is to keep the dependency footprint small
// when the stdlib already does the job; a JSON.stringify call and a level
// check is not something that needs a logging framework.
//
// Every line is a single JSON object: { timestamp, level, msg, ...fields }.
// That shape is what actually matters for observability -- it's what makes
// a log line grep-able, parseable by a real log aggregator (CloudWatch,
// Loki, anything that ingests JSON lines), and consistent regardless of
// which module emits it, unlike the free-form `console.error(...)` calls
// this replaces at the highest-value sites (see api/server.js and
// index.js) without attempting to rewrite every log line in the codebase
// in one pass.

import { createLokiSink } from './lokiSink.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// Off by default -- read once at module load, same posture as
// ALLOW_MANUAL_SETTLEMENT/ADMIN_TOKEN/REDIS_URL elsewhere in this project.
// Every existing test runs with LOKI_URL unset, so this is a no-op for all
// of them; see lokiSink.test.js for the sink itself and
// scripts/log_aggregation_demo.sh for a real Loki container actually
// receiving these lines.
const lokiSink = process.env.LOKI_URL
  ? createLokiSink({
    url: process.env.LOKI_URL,
    onError: (e) => process.stderr.write(`[logger] failed to ship logs to Loki: ${e.message}\n`),
  })
  : null;

// LOG_LEVEL defaults to 'info' -- debug-level detail (none emitted yet at
// call sites, but the threshold exists so adding some later doesn't
// require inventing the filtering mechanism at the same time) is opt-in
// via the environment, not something every deployment pays for by default.
function currentThreshold() {
  return LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
}

function write(stream, level, msg, fields) {
  if (LEVELS[level] < currentThreshold()) return;
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  stream.write(line + '\n');
  lokiSink?.push(line);
}

/** Creates a logger. `fields` are attached to every line this instance (or
 * any child derived from it) emits -- the mechanism `.child()` uses to
 * carry a request id through every log line touched during one request
 * without every call site needing to remember to pass it explicitly. */
export function createLogger(fields = {}) {
  return {
    debug: (msg, extra) => write(process.stdout, 'debug', msg, { ...fields, ...extra }),
    info: (msg, extra) => write(process.stdout, 'info', msg, { ...fields, ...extra }),
    warn: (msg, extra) => write(process.stderr, 'warn', msg, { ...fields, ...extra }),
    // Errors get their own serialization: a bare `Error` object passed as a
    // field would JSON.stringify to `{}` (its own properties are
    // non-enumerable), silently losing the message and stack -- exactly
    // the kind of gap that makes a real incident's log line useless.
    error: (msg, extra = {}) => {
      const { error, ...rest } = extra;
      const serializedError = error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : error;
      write(process.stderr, 'error', msg, {
        ...fields, ...rest, ...(error !== undefined ? { error: serializedError } : {}),
      });
    },
    child: (childFields) => createLogger({ ...fields, ...childFields }),
  };
}

export const logger = createLogger();
export const LOG_LEVELS = LEVELS;
