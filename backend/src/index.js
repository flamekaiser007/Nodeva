import http from 'node:http';
import { createPool } from './db/pool.js';
import { createApp, attachWebSocketServer } from './api/server.js';

const pool = createPool();
const { app, hub } = createApp(pool);
const server = http.createServer(app);
attachWebSocketServer(server, hub);

// Detect nodes that have gone dark without a clean disconnect (crash, network
// drop). A clean close is handled immediately by the hub; this catches the
// unclean case.
setInterval(() => hub.sweepStale(), 15_000);

const port = process.env.PORT ?? 3000;
server.listen(port, () => console.log(`nodeva backend listening on :${port}`));
