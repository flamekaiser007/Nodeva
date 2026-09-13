import http from 'node:http';
import { createPool } from './db/pool.js';
import { createApp, attachWebSocketServer } from './api/server.js';
import { expireStaleHolds } from './reservations/reconciler.js';

const pool = createPool();
const { app, hub } = createApp(pool);
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
  expireStaleHolds(pool).catch((e) => console.error('reconciler sweep failed:', e));
}, 15_000);

const port = process.env.PORT ?? 3000;
server.listen(port, () => console.log(`nodeva backend listening on :${port}`));
