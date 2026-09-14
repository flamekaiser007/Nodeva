import http from 'node:http';
import { createPool } from './db/pool.js';
import { createApp, attachWebSocketServer } from './api/server.js';
import { expireStaleHolds, reconcileExpiredMismatches } from './reservations/reconciler.js';
import { processRefundRetries } from './payments/refunds.js';
import { logger } from './observability/logger.js';
import { refreshBacklogGauges } from './observability/backlog.js';

const pool = createPool();
const { app, hub, paymentGateway } = createApp(pool);
const server = http.createServer(app);
attachWebSocketServer(server, hub);

// Detect nodes that have gone dark without a clean disconnect (crash, network
// drop). A clean close is handled immediately by the hub; this catches the
// unclean case.
setInterval(() => hub.sweepStale(), 15_000);

// Backstop for abandoned reservations -- server.js also runs this
// opportunistically, scoped to one node, right before a booking attempt that
// might collide with a stale hold. This periodic, unscoped sweep is what
// catches everything else: a hold nobody ever tries to rebook just sits
// expired-but-marked-held forever without it, permanently squatting on that
// time window for no reason.
setInterval(() => {
  expireStaleHolds(pool).catch((e) => logger.error('reconciler sweep failed', { error: e }));
}, 15_000);

// The reservation-status-query reconciliation: for the narrower, rarer case
// where the platform lost a RESERVE_COMMIT acknowledgment and marked a
// reservation 'expired' without knowing whether the node actually applied
// it (docs/reservation-protocol.md's failure matrix, row 5). Runs less
// often than the others -- it involves a network round trip PER candidate
// reservation, unlike the other two sweeps which are pure SQL.
setInterval(() => {
  reconcileExpiredMismatches(pool, hub).catch((e) => logger.error('mismatch reconciliation sweep failed', { error: e }));
}, 60_000);

// Retries a compensating refund that failed on its first attempt (gateway
// outage, network blip, rate limit) -- see payments/refunds.js. A no-op
// (processRefundRetries checks isConfigured itself) when no live gateway is
// configured, since there is nothing to retry against.
setInterval(() => {
  processRefundRetries(pool, paymentGateway).catch((e) => logger.error('refund retry sweep failed', { error: e }));
}, 30_000);

// Keeps the backlog gauges (observability/metrics.js) fresh for whoever
// scrapes /metrics -- a snapshot query, same cadence as the refund retry
// sweep since they read overlapping tables. Failing to refresh must not
// crash the process; a stale gauge value for 30s is a far smaller problem
// than the backend going down over an observability query.
refreshBacklogGauges(pool).catch((e) => logger.error('backlog gauge refresh failed', { error: e }));
setInterval(() => {
  refreshBacklogGauges(pool).catch((e) => logger.error('backlog gauge refresh failed', { error: e }));
}, 30_000);

const port = process.env.PORT ?? 3000;
server.listen(port, () => logger.info('nodeva backend listening', { port }));
