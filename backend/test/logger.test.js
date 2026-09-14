import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/observability/logger.js';

// Captures what a logger writes without touching the real stdout/stderr,
// by swapping process.stdout/stderr.write only for the duration of the
// callback -- createLogger always targets the real streams (every real
// call site should be able to call it with zero setup), so a test wraps
// the call being asserted on instead of the module accepting streams as a
// constructor argument.
function withCapturedStreams(fn) {
  const out = []; const err = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (line) => { out.push(line); return true; };
  process.stderr.write = (line) => { err.push(line); return true; };
  try {
    fn();
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { out, err };
}

test('info writes one JSON line to stdout with the message and timestamp', () => {
  const { out, err } = withCapturedStreams(() => {
    createLogger().info('reservation created', { reservation_id: 'r1' });
  });
  assert.equal(err.length, 0);
  assert.equal(out.length, 1);
  const parsed = JSON.parse(out[0]);
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, 'reservation created');
  assert.equal(parsed.reservation_id, 'r1');
  assert.ok(!Number.isNaN(Date.parse(parsed.timestamp)));
});

test('warn and error write to stderr, not stdout', () => {
  const { out, err } = withCapturedStreams(() => {
    createLogger().warn('a warning');
    createLogger().error('an error');
  });
  assert.equal(out.length, 0);
  assert.equal(err.length, 2);
});

test('an Error object passed as `error` is serialized with name, message, and stack', () => {
  const { err } = withCapturedStreams(() => {
    createLogger().error('settlement failed', { error: new TypeError('boom'), reservation_id: 'r2' });
  });
  const parsed = JSON.parse(err[0]);
  assert.equal(parsed.error.name, 'TypeError');
  assert.equal(parsed.error.message, 'boom');
  assert.ok(parsed.error.stack.includes('TypeError: boom'));
  assert.equal(parsed.reservation_id, 'r2');
});

test('a non-Error `error` field passes through unchanged', () => {
  const { err } = withCapturedStreams(() => {
    createLogger().error('failed', { error: { code: 'ECONNREFUSED' } });
  });
  const parsed = JSON.parse(err[0]);
  assert.deepEqual(parsed.error, { code: 'ECONNREFUSED' });
});

test('child() carries the parent\'s fields onto every subsequent line', () => {
  const { out } = withCapturedStreams(() => {
    const base = createLogger({ service: 'nodeva-backend' });
    const requestLogger = base.child({ request_id: 'req-123' });
    requestLogger.info('handling request');
  });
  const parsed = JSON.parse(out[0]);
  assert.equal(parsed.service, 'nodeva-backend');
  assert.equal(parsed.request_id, 'req-123');
});

test('per-call fields override child/base fields of the same name', () => {
  const { out } = withCapturedStreams(() => {
    createLogger({ status: 'pending' }).info('done', { status: 'completed' });
  });
  assert.equal(JSON.parse(out[0]).status, 'completed');
});

test('LOG_LEVEL suppresses lower-severity lines', () => {
  const original = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'warn';
  try {
    const { out, err } = withCapturedStreams(() => {
      const log = createLogger();
      log.info('should be suppressed');
      log.warn('should appear');
    });
    assert.equal(out.length, 0);
    assert.equal(err.length, 1);
  } finally {
    if (original === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = original;
  }
});
