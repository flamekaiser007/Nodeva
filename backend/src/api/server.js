// HTTP + WebSocket server.
//
// SCOPE NOTE: this wires the reservation/payment core loop end to end --
// signup/login, enroll a node, search, book, confirm, complete a job,
// settle. Account recovery (forgot-password flows, email verification) is
// still not built; that gap is now the honest remainder, not the whole of
// auth. See src/auth/ for password hashing and session issuance.

import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import { Hub, NodeOffline, NodeRefused, NodeTimeout } from '../ws/hub.js';
import { admitReceipt } from '../lib/verify.js';
import { searchCandidates } from '../marketplace/nodeStore.js';
import { rank } from '../marketplace/scheduler.js';
import { quote, split, meteredCharge } from '../payments/settle.js';
import { S, canTransition, SETTLEMENT } from '../reservations/machine.js';
import { expireStaleHolds } from '../reservations/reconciler.js';
import { reputationEffect } from '../providers/reputation.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { requireJwtSecret, signSession } from '../auth/jwt.js';
import { requireAuth } from '../auth/middleware.js';

// A REAL bcrypt hash of a fixed, never-used value -- not a made-up string.
// login compares against this when the email does not exist, so bcrypt does
// real work (and takes real, consistent time) either way. A syntactically
// invalid hash here would make bcrypt.compare's behavior on the "user does
// not exist" path unspecified, defeating the point.
const DUMMY_HASH_FOR_TIMING_SAFETY =
  '$2b$12$S166KyDHkghng0qE2TtfReFNZp3CAGlX/iFL1s1XgwlQrPyOrKtZi';

export function createApp(pool) {
  const app = express();
  const jwtSecret = requireJwtSecret();
  const auth = requireAuth(jwtSecret);
  // Dev-permissive CORS: the frontend runs on a different origin (Vite's
  // dev server). Not something to carry into a real deployment unchanged --
  // production should allow-list the actual frontend origin, not '*'.
  app.use(cors());
  app.use(express.json());

  // In-memory only, deliberately: heartbeats arrive every 15s and are
  // superseded by the next one almost immediately, so persisting them to
  // Postgres would be a lot of writes for data nobody reads historically.
  // Lost on restart, which is fine -- the next heartbeat repopulates it
  // within 15s of a node reconnecting.
  const heartbeats = new Map(); // node_id -> { gpu, live_reservations, received_at }

  const hub = new Hub({
    lookupPublicKey: async (nodeId) => {
      const { rows } = await pool.query(
        'SELECT public_key FROM compute_nodes WHERE node_id = $1', [nodeId]);
      return rows[0]?.public_key ?? null;
    },
    onPresence: async (nodeId, online) => {
      await pool.query(
        "UPDATE compute_nodes SET status = $2, last_seen_at = now() WHERE node_id = $1",
        [nodeId, online ? 'online' : 'offline'],
      ).catch(() => {}); // presence bookkeeping must never crash the socket layer
    },
    onHeartbeat: (nodeId, msg) => {
      // Previously this discarded msg entirely -- the worker has been
      // sending real GPU utilization/temperature/VRAM every 15s since the
      // job-execution commit, and nothing ever stored or exposed it. A
      // provider dashboard showing live hardware state needs this cache;
      // without it there is no live data to show, only last_seen_at.
      heartbeats.set(nodeId, {
        gpu: msg.gpu ?? null,
        live_reservations: msg.live_reservations ?? null,
        received_at: Date.now(),
      });
      pool.query('UPDATE compute_nodes SET last_seen_at = now() WHERE node_id = $1',
        [nodeId]).catch(() => {});
    },
    // Arrives asynchronously, any time after JOB_ACCEPTED -- possibly hours
    // later for a real workload. Maps the executor's outcome to a reservation
    // settlement outcome and runs real money through settleReservation, the
    // same function the manual /complete endpoint uses.
    onJobResult: async (nodeId, msg) => {
      try {
        const { rows } = await pool.query(
          `UPDATE jobs SET status=$2, exit_code=$3, compute_seconds=$4,
                  stdout=$5, stderr=$6, completed_at=now()
             WHERE job_id=$1 RETURNING reservation_id`,
          [msg.job_id, mapJobStatus(msg.status), msg.exit_code,
           Math.round(msg.duration_seconds ?? 0), msg.stdout ?? null, msg.stderr ?? null]);
        const reservationId = rows[0]?.reservation_id;
        if (!reservationId) {
          console.error(`JOB_RESULT for unknown job ${msg.job_id}`);
          return;
        }
        const outcome = jobStatusToSettlement(msg.status);
        const result = await settleReservation(pool, reservationId, outcome, Math.round(msg.duration_seconds ?? 0));
        // settleReservation reports problems by RETURNING an {error} object,
        // not by throwing -- the catch block below does not see these. This
        // is exactly the shape of bug that left a reservation stuck at
        // 'confirmed' forever with no log line the first time this ran.
        if (result.error) {
          console.error(`settlement failed for reservation ${reservationId} (job ${msg.job_id}): ${result.error}`);
        }
      } catch (e) {
        // Money must not silently fail to settle. This is exactly the class
        // of drift docs/reservation-protocol.md's reconciler exists for; for
        // now, loud logging is the safety net until that reconciler exists.
        console.error(`failed to settle reservation for job ${msg.job_id} from node ${nodeId}:`, e);
      }
    },
  });

  // --- auth ------------------------------------------------------------

  app.post('/auth/signup', async (req, res, next) => {
    try {
      const { email, password, display_name } = req.body;
      if (!email || !password || !display_name) {
        return res.status(400).json({ error: 'email, password, and display_name are required' });
      }
      let hash;
      try {
        hash = await hashPassword(password);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, display_name)
         VALUES ($1,$2,$3) RETURNING user_id, email, display_name`,
        [email, hash, display_name]);
      const user = rows[0];
      const token = signSession(jwtSecret, { userId: user.user_id, email: user.email });
      res.status(201).json({
        token, user: { id: user.user_id, email: user.email, display_name: user.display_name },
      });
    } catch (e) {
      // Unique violation on email -- don't reveal via a different status code
      // whether an email is registered beyond what "signup failed" already
      // implies; 409 with a generic reason is enough for this MVP's threat
      // model (this is not trying to defend against email enumeration via
      // timing, only against a needlessly specific error message).
      if (e.code === '23505') return res.status(409).json({ error: 'email already registered' });
      next(e);
    }
  });

  app.post('/auth/login', async (req, res, next) => {
    try {
      const { email, password } = req.body;
      const { rows } = await pool.query(
        'SELECT user_id, email, display_name, password_hash, account_status FROM users WHERE email = $1',
        [email]);
      const user = rows[0];
      // Constant-shape response whether the email exists or the password is
      // wrong -- run verifyPassword against a hash either way (a real one, or
      // this fixed dummy) so a missing account does not respond measurably
      // faster than a wrong password, which would let an attacker enumerate
      // registered emails by timing.
      const hashToCheck = user?.password_hash ?? DUMMY_HASH_FOR_TIMING_SAFETY;
      const ok = await verifyPassword(password ?? '', hashToCheck);
      if (!user || !ok) {
        return res.status(401).json({ error: 'invalid email or password' });
      }
      if (user.account_status !== 'active') {
        return res.status(403).json({ error: `account is ${user.account_status}` });
      }
      const token = signSession(jwtSecret, { userId: user.user_id, email: user.email });
      res.json({
        token, user: { id: user.user_id, email: user.email, display_name: user.display_name },
      });
    } catch (e) { next(e); }
  });

  // --- providers ------------------------------------------------------------

  // Any authenticated user can become a provider -- matches the master
  // design's "a user can potentially also become a provider" (a single
  // account, not two separate signups). Idempotent: calling it again for an
  // already-provider user returns their existing provider_id rather than
  // erroring, since "become a provider" is a state, not a one-shot action.
  app.post('/providers/me', auth, async (req, res, next) => {
    try {
      const existing = await pool.query(
        'SELECT provider_id FROM providers WHERE user_id = $1', [req.userId]);
      if (existing.rows[0]) {
        return res.json({ provider_id: existing.rows[0].provider_id });
      }
      const { rows } = await pool.query(
        'INSERT INTO providers (user_id) VALUES ($1) RETURNING provider_id', [req.userId]);
      res.status(201).json({ provider_id: rows[0].provider_id });
    } catch (e) { next(e); }
  });

  // Everything a provider dashboard needs in one round trip: their nodes
  // (with live status merged from the hub -- compute_nodes.status is
  // advisory, updated on presence change, so it can lag a clean disconnect
  // by nothing but is still cross-checked against hub.isOnline() the same
  // way search does), live hardware telemetry from the last heartbeat,
  // reputation, and earnings broken into the buckets a real dashboard shows
  // (available/today/week/month) -- not just a lifetime total, which is not
  // what "how did I do today" actually asks.
  app.get('/providers/me/dashboard', auth, async (req, res, next) => {
    try {
      const providerRow = await pool.query(
        'SELECT provider_id, rep_jobs_total, rep_jobs_failed FROM providers WHERE user_id = $1',
        [req.userId]);
      if (!providerRow.rows[0]) {
        return res.status(404).json({ error: 'not a provider yet -- call POST /providers/me first' });
      }
      const provider = providerRow.rows[0];

      const nodesResult = await pool.query(
        `SELECT node_id, gpu_model, gpu_vram_mb, cpu_cores, ram_mb, price_paise_hr,
                status, cuda_version, last_seen_at, created_at
           FROM compute_nodes WHERE provider_id = $1 ORDER BY created_at DESC`,
        [provider.provider_id]);
      const nodes = nodesResult.rows.map((n) => {
        const hb = heartbeats.get(n.node_id);
        // hub.isOnline() reflects the live socket right now; n.status is the
        // last presence event Postgres was told about. They can disagree for
        // an instant around a reconnect -- report both rather than picking
        // one and hiding a real transient state from the person watching it.
        return {
          ...n,
          online: hub.isOnline(n.node_id),
          heartbeat: hb ? { ...hb, age_ms: Date.now() - hb.received_at } : null,
        };
      });

      // Buckets computed in one query rather than four round trips. FILTER
      // is the readable way to express "same aggregate, different WHERE" in
      // Postgres without four separate SUMs each needing their own subquery.
      // Postgres promotes SUM(bigint) to NUMERIC, not BIGINT -- our type
      // parser (db/pool.js) only overrides OID 20 (int8), so an uncast SUM
      // here comes back from node-pg as a STRING, silently, no error, no
      // NaN, just "0" !== 0 the first time anything compares it. Every
      // amount in this schema is documented to stay within
      // Number.isSafeInteger range, so casting back to bigint is exactly as
      // safe as the rest of the codebase already assumes.
      const earningsRow = await pool.query(
        `SELECT
            COALESCE(SUM(e.amount_paise), 0)::bigint AS available_paise,
            COALESCE(SUM(e.amount_paise) FILTER (WHERE e.created_at >= now() - interval '1 day'), 0)::bigint AS today_paise,
            COALESCE(SUM(e.amount_paise) FILTER (WHERE e.created_at >= now() - interval '7 days'), 0)::bigint AS week_paise,
            COALESCE(SUM(e.amount_paise) FILTER (WHERE e.created_at >= now() - interval '30 days'), 0)::bigint AS month_paise
           FROM ledger_entries e
           JOIN ledger_accounts a ON a.account_id = e.account_id
          WHERE a.kind = 'provider_balance' AND a.owner_provider_id = $1`,
        [provider.provider_id]);

      res.json({
        provider_id: provider.provider_id,
        reputation: {
          jobs_total: provider.rep_jobs_total,
          jobs_failed: provider.rep_jobs_failed,
          reliability: provider.rep_jobs_total > 0
            ? 1 - provider.rep_jobs_failed / provider.rep_jobs_total
            : null, // no jobs yet -- null, not a misleading 100% or 0%
        },
        earnings: earningsRow.rows[0],
        nodes,
      });
    } catch (e) { next(e); }
  });

  // --- node enrollment -------------------------------------------------------

  // Requires the caller to already be a provider (via /providers/me) and
  // derives provider_id from THEIR session -- previously this trusted a
  // provider_id sent in the request body, so anyone could enroll a node
  // under a provider account that was not theirs. The worker process is not
  // the one authenticating here; in practice a human enrolls the node's
  // public key through this endpoint (or a future provider dashboard) once,
  // then hands the worker its keypair to run with.
  app.post('/nodes', auth, async (req, res, next) => {
    try {
      const providerRow = await pool.query(
        'SELECT provider_id FROM providers WHERE user_id = $1', [req.userId]);
      if (!providerRow.rows[0]) {
        return res.status(403).json({ error: 'call POST /providers/me first' });
      }
      const { public_key_hex, gpu_model, gpu_vram_mb,
              cpu_cores, ram_mb, price_paise_hr, cuda_version } = req.body;
      const pub = Buffer.from(public_key_hex, 'hex');
      if (pub.length !== 32) {
        return res.status(400).json({ error: 'public_key_hex must decode to 32 bytes' });
      }
      const { rows } = await pool.query(
        `INSERT INTO compute_nodes
           (provider_id, public_key, gpu_model, gpu_vram_mb, cpu_cores, ram_mb,
            price_paise_hr, cuda_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING node_id`,
        [providerRow.rows[0].provider_id, pub, gpu_model, gpu_vram_mb, cpu_cores, ram_mb,
         price_paise_hr, cuda_version ?? null]);
      res.status(201).json({ node_id: rows[0].node_id });
    } catch (e) { next(e); }
  });

  app.get('/nodes', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT n.node_id, n.gpu_model, n.gpu_vram_mb, n.cpu_cores, n.ram_mb,
                n.price_paise_hr, n.status, n.last_seen_at, n.created_at,
                p.rep_jobs_total, p.rep_jobs_failed
           FROM compute_nodes n JOIN providers p ON p.provider_id = n.provider_id
          ORDER BY n.created_at DESC`);
      res.json({ nodes: rows });
    } catch (e) { next(e); }
  });

  // Previously anyone could add availability windows to ANY node -- e.g.
  // advertising a competitor's GPU as available 24/7 at a price the actual
  // owner never set, or the reverse (no direct exploit there, but no reason
  // to leave it open). Ownership check mirrors /nodes above.
  app.post('/nodes/:id/availability', auth, async (req, res, next) => {
    try {
      const owned = await pool.query(
        `SELECT 1 FROM compute_nodes n JOIN providers p ON p.provider_id = n.provider_id
          WHERE n.node_id = $1 AND p.user_id = $2`,
        [req.params.id, req.userId]);
      if (!owned.rows[0]) return res.status(404).json({ error: 'not_found' });
      const { window_start, window_end } = req.body;
      await pool.query(
        'INSERT INTO node_availability (node_id, window_start, window_end) VALUES ($1,$2,$3)',
        [req.params.id, new Date(window_start), new Date(window_end)]);
      res.status(201).end();
    } catch (e) { next(e); }
  });

  // --- search ------------------------------------------------------------

  app.post('/search', async (req, res, next) => {
    try {
      const req_ = req.body;
      const candidates = await searchCandidates(pool, hub, req_);
      const ranked = rank(candidates, req_, req_.mode ?? 'best_value');
      res.json({ results: ranked });
    } catch (e) { next(e); }
  });

  // --- reservations --------------------------------------------------------

  // Lock-then-capture, in that order (see docs/reservation-protocol.md).
  // Money is never touched until the node has signed a receipt.
  // user_id comes from the session, never the request body -- previously a
  // caller could book (and later confirm/run jobs on) a reservation under
  // ANY user_id they cared to type in, since nothing verified they owned it.
  app.post('/reservations', auth, async (req, res, next) => {
    const { node_id, starts_at, ends_at } = req.body;
    const user_id = req.userId;
    try {
      // Opportunistic reconciliation before touching the exclusion
      // constraint: a hold the node already gave up on (its TTL elapsed)
      // but that the platform never got around to expiring would otherwise
      // block this exact booking with a false conflict -- confirmed by
      // hand: the node happily signs a fresh receipt for the "conflicting"
      // window, which then goes nowhere because our own stale row rejects
      // the insert. Scoped to this node so it stays cheap on a hot path;
      // the periodic sweep in index.js catches everything else.
      await expireStaleHolds(pool, { nodeId: node_id });

      const nodeRow = await pool.query(
        'SELECT price_paise_hr FROM compute_nodes WHERE node_id = $1', [node_id]);
      if (!nodeRow.rows[0]) return res.status(404).json({ error: 'unknown node' });
      const pricePaiseHr = nodeRow.rows[0].price_paise_hr;
      const quotedPaise = quote(pricePaiseHr, new Date(starts_at), new Date(ends_at));

      const reservationId = crypto.randomUUID();

      let receiptMsg;
      try {
        receiptMsg = await hub.requestReservation(node_id, {
          reservationId, startsAt: starts_at, endsAt: ends_at, pricePaiseHr,
        });
      } catch (e) {
        if (e instanceof NodeOffline) return res.status(409).json({ error: 'node_offline' });
        if (e instanceof NodeRefused) return res.status(409).json({ error: e.reason });
        if (e instanceof NodeTimeout) return res.status(504).json({ error: 'node_unresponsive' });
        throw e;
      }

      const nodeKeyRow = await pool.query(
        'SELECT public_key FROM compute_nodes WHERE node_id = $1', [node_id]);
      const admission = admitReceipt({
        publicKeyRaw: nodeKeyRow.rows[0].public_key,
        body: receiptMsg.body,
        signature: Buffer.from(receiptMsg.signature_hex, 'hex'),
        expected: {
          node_id, reservation_id: reservationId,
          starts_at, ends_at, price_paise_hr: pricePaiseHr,
        },
      });
      if (!admission.ok) {
        // The node signed something, but not the thing we asked for. Treat as
        // a refusal rather than trusting a malformed or manipulated receipt.
        return res.status(502).json({ error: `invalid_receipt:${admission.reason}` });
      }

      await pool.query(
        `INSERT INTO reservations
           (reservation_id, node_id, user_id, slot, price_paise_hr, quoted_paise,
            status, receipt_sig, receipt_body, hold_expires_at)
         VALUES ($1,$2,$3, tstzrange($4,$5), $6,$7, 'held', $8,$9, $10)`,
        [reservationId, node_id, user_id, new Date(starts_at), new Date(ends_at),
         pricePaiseHr, quotedPaise,
         Buffer.from(receiptMsg.signature_hex, 'hex'), receiptMsg.body,
         new Date(receiptMsg.body.hold_expires_at)]);

      res.status(201).json({
        reservation_id: reservationId, status: S.HELD, quoted_paise: quotedPaise,
        hold_expires_at: receiptMsg.body.hold_expires_at,
      });
    } catch (e) {
      // A double-booking slipping past the node (shouldn't happen, but the DB
      // is the last line of defense) surfaces as our GiST exclusion violation.
      if (e.code === '23P01') return res.status(409).json({ error: 'slot_conflict' });
      next(e);
    }
  });

  // Payment capture + committing the node's hold. In production the capture
  // step calls a real gateway; here it is a stub that always succeeds, kept
  // separate from escrow bookkeeping on purpose (see docs/reservation-protocol.md's
  // distinction between gateway, escrow, and settlement).
  // Without an ownership check here, anyone who learned a reservation_id
  // (sequential-feeling UUIDs still leak via logs, referrers, browser
  // history) could pay for -- or worse, run arbitrary jobs against -- a
  // reservation that was not theirs. auth + the owner check below close
  // that; a 404 rather than 403 on mismatch avoids confirming to a prober
  // that the id exists at all.
  app.post('/reservations/:id/confirm', auth, async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        'SELECT * FROM reservations WHERE reservation_id = $1 FOR UPDATE',
        [req.params.id]);
      const resv = rows[0];
      if (!resv || resv.user_id !== req.userId) return res.status(404).json({ error: 'not_found' });
      if (!canTransition(resv.status, S.CONFIRMED)) {
        return res.status(409).json({ error: `cannot confirm from ${resv.status}` });
      }

      let committed;
      try {
        committed = await hub.commitReservation(resv.node_id, resv.reservation_id);
      } catch (e) {
        if (e instanceof NodeOffline || e instanceof NodeTimeout) {
          // The hold likely lapsed on the node's side too. Do not capture money
          // for a slot we cannot prove the node still honours.
          await client.query('BEGIN');
          await client.query(
            "UPDATE reservations SET status='expired', updated_at=now() WHERE reservation_id=$1",
            [resv.reservation_id]);
          await client.query('COMMIT');
          return res.status(409).json({ error: 'node_unreachable_hold_not_confirmed' });
        }
        throw e;
      }
      void committed;

      await client.query('BEGIN');
      await ensureAccounts(client, resv.user_id, null);
      const gateway = await accountId(client, 'gateway_clearing', null, null);
      const escrow = await accountId(client, 'user_escrow', resv.user_id, null);

      const txn = await client.query(
        `INSERT INTO ledger_transactions (kind, reservation_id, idempotency_key)
         VALUES ('capture', $1, $2) RETURNING txn_id`,
        [resv.reservation_id, `capture-${resv.reservation_id}`]);
      const txnId = txn.rows[0].txn_id;
      await client.query(
        'INSERT INTO ledger_entries (txn_id, account_id, amount_paise) VALUES ($1,$2,$3),($1,$4,$5)',
        [txnId, gateway, -resv.quoted_paise, escrow, resv.quoted_paise]);

      await client.query(
        "UPDATE reservations SET status='confirmed', updated_at=now() WHERE reservation_id=$1",
        [resv.reservation_id]);
      await client.query('COMMIT');

      res.json({ reservation_id: resv.reservation_id, status: S.CONFIRMED });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e.code === '23505') return res.status(409).json({ error: 'already_captured' });
      next(e);
    } finally {
      client.release();
    }
  });

  // Job completion + settlement, shared by the manual endpoint below and
  // by onJobResult once a real job actually finishes -- one settlement path,
  // not two copies that could drift apart.
  // MANUAL settlement override -- exists for driving the money side of the
  // pipeline without a real job (see scripts/e2e_demo.sh's fallback path,
  // and the tests that predate job execution entirely). This is NOT safe to
  // expose to arbitrary users in production as-is: a user could call it with
  // outcome='failed_provider' on their own reservation to claim a refund for
  // work that actually ran and succeeded, with nothing checking that against
  // reality the way onJobResult's automatic path does (it settles based on
  // what the sandboxed executor actually observed, not on a client's say-so).
  // Ownership is enforced here so at least a user cannot settle someone
  // ELSE's reservation; a real product should retire this endpoint or gate
  // it to admin/support roles once job execution is the only settlement path.
  app.post('/reservations/:id/complete', auth, async (req, res, next) => {
    try {
      const owned = await pool.query(
        'SELECT 1 FROM reservations WHERE reservation_id = $1 AND user_id = $2',
        [req.params.id, req.userId]);
      if (!owned.rows[0]) return res.status(404).json({ error: 'not_found' });
      const result = await settleReservation(
        pool, req.params.id, req.body.outcome, req.body.compute_seconds);
      if (result.error) return res.status(result.status).json({ error: result.error });
      res.json(result);
    } catch (e) { next(e); }
  });

  // --- jobs ------------------------------------------------------------

  // Submit a job against a CONFIRMED reservation. Resolves once the node has
  // started the container -- not when the job finishes, which may be hours
  // later and arrives asynchronously via onJobResult below.
  app.post('/reservations/:id/jobs', auth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM reservations WHERE reservation_id = $1', [req.params.id]);
      const resv = rows[0];
      if (!resv || resv.user_id !== req.userId) return res.status(404).json({ error: 'not_found' });
      if (resv.status !== S.CONFIRMED) {
        return res.status(409).json({ error: `reservation is ${resv.status}, not confirmed` });
      }

      const jobId = crypto.randomUUID();
      const { image, command, env, timeout_seconds, gpu } = req.body;

      try {
        await hub.submitJob(resv.node_id, {
          jobId, reservationId: resv.reservation_id, image, command, env, gpu,
        });
      } catch (e) {
        if (e instanceof NodeOffline) return res.status(409).json({ error: 'node_offline' });
        if (e instanceof NodeRefused) return res.status(409).json({ error: e.reason });
        if (e instanceof NodeTimeout) return res.status(504).json({ error: 'node_unresponsive' });
        throw e;
      }

      await pool.query(
        `INSERT INTO jobs (job_id, reservation_id, image, command, status, started_at)
         VALUES ($1,$2,$3,$4,'running',now())`,
        [jobId, resv.reservation_id, image, command]);
      // The reservation lifecycle requires confirmed -> running -> completed
      // (see reservations/machine.js); settleReservation later transitions
      // FROM 'running', so skipping this step leaves it stuck at 'confirmed'
      // forever once the job finishes -- caught by the e2e script.
      await pool.query(
        "UPDATE reservations SET status='running', updated_at=now() WHERE reservation_id=$1",
        [resv.reservation_id]);

      res.status(202).json({ job_id: jobId, status: 'running' });
    } catch (e) { next(e); }
  });

  app.get('/jobs/:id', auth, async (req, res, next) => {
    try {
      // A job's stdout/stderr can contain whatever the user's own code
      // printed -- possibly sensitive to THEM, not something another
      // authenticated user should be able to read by guessing/enumerating
      // job ids. Join to reservations to check ownership.
      const { rows } = await pool.query(
        `SELECT j.* FROM jobs j JOIN reservations r ON r.reservation_id = j.reservation_id
          WHERE j.job_id = $1 AND r.user_id = $2`,
        [req.params.id, req.userId]);
      if (!rows[0]) return res.status(404).json({ error: 'not_found' });
      res.json(rows[0]);
    } catch (e) { next(e); }
  });

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return { app, hub };
}

// executor.py's JobResult.status vocabulary -> jobs.status (schema-constrained).
function mapJobStatus(execStatus) {
  return {
    succeeded: 'succeeded',
    failed: 'failed_user',
    // A job that hit its own wall-clock timeout or was OOM-killed consumed
    // the resources it was given; that is the user's workload misbehaving,
    // not the provider's. Bill it, don't refund it.
    timed_out: 'failed_user',
    oom_killed: 'failed_user',
    // `error` means the EXECUTOR could not run the job at all -- docker
    // unavailable, or similar infrastructure failure on the node's side.
    // Simplification worth flagging: a job that fails because the user gave
    // a nonexistent image also surfaces as `error` today (docker run itself
    // fails), and gets refunded as if it were the provider's fault. That is
    // generous to the user rather than dangerous, so it is left as a known
    // gap rather than solved here -- distinguishing "bad image" from "no
    // docker" needs the executor to parse docker's stderr, which is not
    // done yet.
    error: 'failed_provider',
  }[execStatus] ?? 'failed_provider';
}

// A DIFFERENT vocabulary from mapJobStatus above, despite the overlap --
// jobs.status uses 'succeeded', but reservations.status (and SETTLEMENT's
// keys) use 'completed'. Conflating these two by reusing one function was a
// real bug caught by the e2e script: the job row updated correctly but
// settleReservation was then called with outcome='succeeded', which
// SETTLEMENT has no entry for, so canTransition/SETTLEMENT lookups silently
// no-op'd and the reservation was left stuck at 'confirmed' forever.
function jobStatusToSettlement(execStatus) {
  return {
    succeeded: 'completed',
    failed: 'failed_user',
    timed_out: 'failed_user',
    oom_killed: 'failed_user',
    error: 'failed_provider',
  }[execStatus] ?? 'failed_provider';
}

// Settlement, usable both from the manual /complete route and from
// onJobResult once a real job finishes. Returns a plain result object rather
// than writing to `res` directly, so callers that are not HTTP handlers (the
// hub's job-result callback) can use it identically.
export async function settleReservation(pool, reservationId, outcome, computeSeconds) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      'SELECT * FROM reservations WHERE reservation_id = $1 FOR UPDATE', [reservationId]);
    const resv = rows[0];
    if (!resv) return { error: 'not_found', status: 404 };
    if (!SETTLEMENT[outcome]) return { error: 'unknown_outcome', status: 400 };
    if (!canTransition(resv.status, outcome)) {
      // Most commonly: already settled. Idempotency-key uniqueness below is
      // the hard guarantee; this is a friendlier early exit for the common case.
      return { error: `cannot settle from ${resv.status}`, status: 409 };
    }

    await client.query('BEGIN');
    const escrow = await accountId(client, 'user_escrow', resv.user_id, null);
    const providerRow = await client.query(
      'SELECT provider_id FROM compute_nodes WHERE node_id = $1', [resv.node_id]);
    const providerId = providerRow.rows[0].provider_id;
    const providerAcct = await accountId(client, 'provider_balance', null, providerId);
    const platformAcct = await accountId(client, 'platform_revenue', null, null);
    const refundsAcct = await accountId(client, 'refunds', null, null);

    const rule = SETTLEMENT[outcome];
    let chargePaise = 0;
    if (rule === 'settle_full') chargePaise = resv.quoted_paise;
    else if (rule === 'settle_metered') {
      chargePaise = meteredCharge(resv.quoted_paise, resv.price_paise_hr, computeSeconds ?? 0);
    } // refund_full and refund_per_policy leave chargePaise at 0

    const txn = await client.query(
      `INSERT INTO ledger_transactions (kind, reservation_id, idempotency_key)
       VALUES ('settle', $1, $2) RETURNING txn_id`,
      [resv.reservation_id, `settle-${resv.reservation_id}`]);
    const txnId = txn.rows[0].txn_id;

    const entries = [[escrow, -resv.quoted_paise]];
    if (chargePaise > 0) {
      const { provider, platform } = split(chargePaise);
      entries.push([providerAcct, provider], [platformAcct, platform]);
    }
    const refund = resv.quoted_paise - chargePaise;
    if (refund > 0) entries.push([refundsAcct, refund]);

    for (const [acct, amt] of entries) {
      await client.query(
        'INSERT INTO ledger_entries (txn_id, account_id, amount_paise) VALUES ($1,$2,$3)',
        [txnId, acct, amt]);
    }

    await client.query(
      'UPDATE reservations SET status=$2, updated_at=now() WHERE reservation_id=$1',
      [resv.reservation_id, outcome]);

    // providers.rep_jobs_total/rep_jobs_failed were being read by the
    // scheduler (marketplace/nodeStore.js) and NEVER written anywhere --
    // every provider's computed reliability was permanently stuck at the
    // neutral default (0.8) regardless of how many jobs actually succeeded
    // or failed. See src/providers/reputation.js for the policy: only
    // outcomes where a job actually ran on the node move these counters,
    // and the user's own workload failing does not count against the
    // provider that faithfully ran it.
    const effect = reputationEffect(outcome);
    if (effect) {
      await client.query(
        `UPDATE providers SET rep_jobs_total = rep_jobs_total + 1,
                rep_jobs_failed = rep_jobs_failed + $2
          WHERE provider_id = $1`,
        [providerId, effect === 'failure' ? 1 : 0]);
    }

    await client.query('COMMIT');

    return { reservation_id: resv.reservation_id, status: outcome,
             charged_paise: chargePaise, refunded_paise: refund };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return { error: 'already_settled', status: 409 };
    throw e;
  } finally {
    client.release();
  }
}

async function accountId(client, kind, ownerUserId, ownerProviderId) {
  const { rows } = await client.query(
    `SELECT account_id FROM ledger_accounts
      WHERE kind=$1 AND owner_user_id IS NOT DISTINCT FROM $2
        AND owner_provider_id IS NOT DISTINCT FROM $3`,
    [kind, ownerUserId ?? null, ownerProviderId ?? null]);
  if (rows[0]) return rows[0].account_id;
  const ins = await client.query(
    `INSERT INTO ledger_accounts (kind, owner_user_id, owner_provider_id)
     VALUES ($1,$2,$3) RETURNING account_id`,
    [kind, ownerUserId ?? null, ownerProviderId ?? null]);
  return ins.rows[0].account_id;
}

async function ensureAccounts(client, userId) {
  await accountId(client, 'gateway_clearing', null, null);
  await accountId(client, 'user_escrow', userId, null);
  await accountId(client, 'platform_revenue', null, null);
  await accountId(client, 'refunds', null, null);
}

export function attachWebSocketServer(server, hub, path = '/worker') {
  const wss = new WebSocketServer({ server, path });
  wss.on('connection', (socket) => hub.handleConnection(socket));
  return wss;
}
