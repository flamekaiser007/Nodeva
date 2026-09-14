// createLokiSink (observability/lokiSink.js) against a FAKE fetch -- proves
// batching, flush timing, and error containment without needing a real
// Loki container for every test run. A real Loki container is exercised
// separately by scripts/log_aggregation_demo.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLokiSink } from '../src/observability/lokiSink.js';

function fakeFetch(calls, { fail = false } = {}) {
  return async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (fail) return { ok: false, status: 500 };
    return { ok: true, status: 204 };
  };
}

test('a pushed line is not sent immediately -- it waits for the batch timer', async () => {
  const calls = [];
  const sink = createLokiSink({ url: 'http://loki.test', fetchImpl: fakeFetch(calls), batchIntervalMs: 100_000 });
  sink.push('line one');
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 0);
  sink.stop();
});

test('flush() sends everything buffered so far in one request', async () => {
  const calls = [];
  const sink = createLokiSink({ url: 'http://loki.test', fetchImpl: fakeFetch(calls), batchIntervalMs: 100_000 });
  sink.push('line one');
  sink.push('line two');
  await sink.flush();
  assert.equal(calls.length, 1);
  const stream = calls[0].body.streams[0];
  assert.deepEqual(stream.values.map((v) => v[1]), ['line one', 'line two']);
  sink.stop();
});

test('the timestamp on each entry is a real Unix-epoch nanosecond string, not process.hrtime', async () => {
  const calls = [];
  const sink = createLokiSink({ url: 'http://loki.test', fetchImpl: fakeFetch(calls), batchIntervalMs: 100_000 });
  const before = BigInt(Date.now()) * 1_000_000n;
  sink.push('x');
  await sink.flush();
  const after = BigInt(Date.now()) * 1_000_000n;
  const ts = BigInt(calls[0].body.streams[0].values[0][0]);
  assert.ok(ts >= before && ts <= after, 'timestamp must fall within this test\'s own real-time window');
  sink.stop();
});

test('flushing an empty buffer sends nothing', async () => {
  const calls = [];
  const sink = createLokiSink({ url: 'http://loki.test', fetchImpl: fakeFetch(calls), batchIntervalMs: 100_000 });
  await sink.flush();
  assert.equal(calls.length, 0);
  sink.stop();
});

test('the buffer auto-flushes once it hits maxBatch, without waiting for the timer', async () => {
  const calls = [];
  const sink = createLokiSink({
    url: 'http://loki.test', fetchImpl: fakeFetch(calls), batchIntervalMs: 100_000, maxBatch: 3,
  });
  sink.push('a'); sink.push('b');
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 0, 'not yet at maxBatch');
  sink.push('c'); // hits maxBatch=3
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.streams[0].values.length, 3);
  sink.stop();
});

test('a failed push calls onError and does not throw, and the failed batch is NOT retried', async () => {
  const calls = [];
  const errors = [];
  const sink = createLokiSink({
    url: 'http://loki.test', fetchImpl: fakeFetch(calls, { fail: true }),
    batchIntervalMs: 100_000, onError: (e) => errors.push(e),
  });
  sink.push('will be lost');
  await sink.flush();
  assert.equal(calls.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /500/);

  // A second flush with nothing newly pushed sends nothing -- proves the
  // failed batch wasn't silently requeued for another attempt. This sink
  // is fire-and-lose on failure, not fire-and-retry: logs are a
  // best-effort observability signal, not the durable record
  // payments/refunds.js's retry queue exists for.
  await sink.flush();
  assert.equal(calls.length, 1, 'no second network call for a batch that already failed and was dropped');
  sink.stop();
});

test('a network exception (not just a non-ok response) is also caught, not thrown', async () => {
  const errors = [];
  const sink = createLokiSink({
    url: 'http://loki.test',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    batchIntervalMs: 100_000,
    onError: (e) => errors.push(e),
  });
  sink.push('x');
  await assert.doesNotReject(() => sink.flush());
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /ECONNREFUSED/);
  sink.stop();
});
