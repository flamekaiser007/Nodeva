// HTTP + WebSocket server.
//
// SCOPE NOTE: this wires the reservation/payment core loop end to end --
// signup/login, account recovery, enroll a node, search, book, confirm,
// complete a job, settle. See src/auth/ for password hashing, session
// issuance, and password reset.

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
import { generateResetToken, hashResetToken } from '../auth/passwordReset.js';
import { rateLimit } from '../auth/rateLimit.js';
import { checkImageAllowed } from '../jobs/imageAllowlist.js';
import { createEmailSenderFromEnv, resetPasswordEmailBody } from '../auth/email.js';
import {
  createGatewayFromEnv, verifyPaymentSignature, verifyWebhookSignature,
} from '../payments/razorpay.js';
import { issueRefund } from '../payments/refunds.js';
import {
  computeResultHash, compareJobResults, groupIsComplete, attributeFaultFromTiebreaker,
} from '../jobs/verification.js';

// Job-level (not reservation-level) terminal statuses -- see the schema's
// CHECK constraint on jobs.status. Used only to decide when a verification
// group is ready to compare, not for any settlement logic itself.
const TERMINAL_JOB_STATUSES = new Set(
  ['succeeded', 'failed_user', 'failed_provider', 'timed_out', 'cancelled']);

// A REAL bcrypt hash of a fixed, never-used value -- not a made-up string.
// login compares against this when the email does not exist, so bcrypt does
// real work (and takes real, consistent time) either way. A syntactically
// invalid hash here would make bcrypt.compare's behavior on the "user does
// not exist" path unspecified, defeating the point.
const DUMMY_HASH_FOR_TIMING_SAFETY =
  '$2b$12$S166KyDHkghng0qE2TtfReFNZp3CAGlX/iFL1s1XgwlQrPyOrKtZi';

export function createApp(pool, { paymentGateway, emailSender } = {}) {
  const app = express();
  const jwtSecret = requireJwtSecret();
  const auth = requireAuth(jwtSecret);

  // Rate limits for the three auth endpoints exposed to abuse before a
  // session even exists (see auth/rateLimit.js for the honest per-process
  // limitation and why the thresholds are illustrative, not researched).
  // Login gets TWO limiters: by IP (a single source hammering many
  // accounts) and by email (one account targeted from many sources,
  // e.g. a botnet) -- either alone misses half the threat.
  const signupLimiter = rateLimit({ windowMs: 15 * 60_000, max: 100, keyFn: (req) => `signup:${req.ip}` });
  const loginLimiterByIp = rateLimit({ windowMs: 15 * 60_000, max: 50, keyFn: (req) => `login-ip:${req.ip}` });
  const loginLimiterByEmail = rateLimit({
    windowMs: 15 * 60_000, max: 8,
    keyFn: (req) => req.body?.email && `login-email:${String(req.body.email).toLowerCase()}`,
  });
  const forgotPasswordLimiter = rateLimit({
    windowMs: 15 * 60_000, max: 10, keyFn: (req) => `forgot-password:${req.ip}`,
  });
  // Injectable for tests; defaults to reading RAZORPAY_KEY_ID/SECRET from the
  // environment. Falls back to UnconfiguredGateway (loud, honest, ledger-only)
  // when they are absent -- see payments/razorpay.js's file header for what
  // that does and does not mean. Named distinctly from the existing local
  // `gateway` variable used elsewhere for the internal 'gateway_clearing'
  // LEDGER ACCOUNT -- same word, two different things, kept apart on purpose.
  const razorpay = paymentGateway ?? createGatewayFromEnv();
  // Same injectable/env-default pattern; falls back to ConsoleEmailSender
  // (logs the reset link instead of emailing it) when no SMTP is configured.
  // Named `mailer`, not `email` -- the forgot-password handler below also
  // destructures `email` from the request body, and shadowing this sender
  // instance with that string was a real bug caught before it shipped:
  // email.send(...) would have called .send() on a plain string address.
  const mailer = emailSender ?? createEmailSenderFromEnv();
  // Where a password-reset link should point. Defaults to the Vite dev
  // server's own origin so the flow works out of the box in local dev.
  const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:5173';
  // Dev-permissive CORS: the frontend runs on a different origin (Vite's
  // dev server). Not something to carry into a real deployment unchanged --
  // production should allow-list the actual frontend origin, not '*'.
  app.use(cors());
  // `verify` captures the exact raw bytes alongside the parsed body -- the
  // Razorpay webhook handler below needs those raw bytes for signature
  // verification (re-serializing req.body is not guaranteed to reproduce
  // what Razorpay actually signed; see razorpay.js's own note on this, which
  // is the same canonical-encoding lesson this project already learned once
  // for node-to-platform receipts).
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

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
    // same function the manual /complete endpoint uses. A job submitted with
    // duplicate-execution verification (jobs/verification.js) takes a
    // different path: settlement waits until BOTH nodes in its group have
    // reported in, then compares their results before either reservation
    // is allowed to settle.
    onJobResult: async (nodeId, msg) => {
      try {
        const resultHash = computeResultHash({
          status: mapJobStatus(msg.status), exit_code: msg.exit_code,
          stdout: msg.stdout, stderr: msg.stderr,
        });
        const { rows } = await pool.query(
          `UPDATE jobs SET status=$2, exit_code=$3, compute_seconds=$4,
                  stdout=$5, stderr=$6, completed_at=now(), result_hash=$7
             WHERE job_id=$1 RETURNING reservation_id, verification_group_id`,
          [msg.job_id, mapJobStatus(msg.status), msg.exit_code,
           Math.round(msg.duration_seconds ?? 0), msg.stdout ?? null, msg.stderr ?? null, resultHash]);
        const jobRow = rows[0];
        if (!jobRow) {
          console.error(`JOB_RESULT for unknown job ${msg.job_id}`);
          return;
        }

        if (!jobRow.verification_group_id) {
          const outcome = jobStatusToSettlement(msg.status);
          const result = await settleReservation(
            pool, jobRow.reservation_id, outcome, Math.round(msg.duration_seconds ?? 0), razorpay);
          // settleReservation reports problems by RETURNING an {error}
          // object, not by throwing -- the catch block below does not see
          // these. This is exactly the shape of bug that left a reservation
          // stuck at 'confirmed' forever with no log line the first time
          // this ran.
          if (result.error) {
            console.error(`settlement failed for reservation ${jobRow.reservation_id} (job ${msg.job_id}): ${result.error}`);
          }
          return;
        }

        // A group of 2 is the normal duplicate-execution case; it grows to
        // 3 only when a dispute tiebreaker was submitted against an already-
        // disputed group (POST /verification-groups/:id/tiebreak) -- that
        // needs fault-attribution logic instead of settleVerificationGroup's
        // match/mismatch settlement, since the two original reservations
        // are already terminal (DISPUTED) and must not be settled again.
        const { rows: groupCountRows } = await pool.query(
          'SELECT count(*)::int AS n FROM jobs WHERE verification_group_id = $1',
          [jobRow.verification_group_id]);
        if (groupCountRows[0].n >= 3) {
          await resolveDisputeTiebreaker(pool, razorpay, jobRow.verification_group_id);
        } else {
          await settleVerificationGroup(pool, razorpay, jobRow.verification_group_id);
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

  app.post('/auth/signup', signupLimiter, async (req, res, next) => {
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

  app.post('/auth/login', loginLimiterByIp, loginLimiterByEmail, async (req, res, next) => {
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

  // Always the same generic response whether the email exists or not --
  // the SAME email-enumeration reasoning as login's timing-safe compare,
  // applied to the response body instead of response time. A password-reset
  // endpoint that says "no account with that email" is a very convenient
  // oracle for finding out who has an account here.
  app.post('/auth/forgot-password', forgotPasswordLimiter, async (req, res, next) => {
    const GENERIC_RESPONSE = { message: 'If an account exists for that email, a reset link has been sent.' };
    try {
      const { email } = req.body;
      const { rows } = await pool.query('SELECT user_id FROM users WHERE email = $1', [email ?? '']);
      const user = rows[0];
      if (user) {
        const { token, tokenHash, expiresAt } = generateResetToken();
        // Invalidate any earlier outstanding token for this user first --
        // only the most recently requested reset link should ever work, so
        // an old email sitting in an inbox (or a mail server's logs) cannot
        // be used after the user has already asked for a newer one.
        await pool.query(
          "UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL",
          [user.user_id]);
        await pool.query(
          `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)`,
          [user.user_id, tokenHash, expiresAt]);
        const resetUrl = `${frontendUrl}/reset-password?token=${token}`;
        await mailer.send({
          to: email,
          subject: 'Reset your NODEVA password', text: resetPasswordEmailBody(resetUrl),
        }).catch((e) => console.error('failed to send password reset email:', e));
      }
      res.json(GENERIC_RESPONSE);
    } catch (e) { next(e); }
  });

  app.post('/auth/reset-password', async (req, res, next) => {
    try {
      const { token, new_password } = req.body;
      if (!token || !new_password) {
        return res.status(400).json({ error: 'token and new_password are required' });
      }
      const tokenHash = hashResetToken(token);
      const { rows } = await pool.query(
        `SELECT * FROM password_reset_tokens
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
        [tokenHash]);
      const resetRow = rows[0];
      // One generic error for "no such token", "already used", and
      // "expired" -- same reasoning as everywhere else in this file:
      // distinguishing them tells a prober which guesses are close.
      if (!resetRow) return res.status(400).json({ error: 'invalid_or_expired_token' });

      let hash;
      try {
        hash = await hashPassword(new_password);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }

      await pool.query('UPDATE users SET password_hash = $1 WHERE user_id = $2', [hash, resetRow.user_id]);
      await pool.query('UPDATE password_reset_tokens SET used_at = now() WHERE token_id = $1', [resetRow.token_id]);
      res.json({ message: 'password updated' });
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

      // A provider's rep_jobs_failed can move for a reason that never shows
      // up anywhere else on this dashboard: a duplicate-execution mismatch
      // on one of their nodes, resolved (or still pending resolution) via a
      // third-node tiebreaker (jobs/verification.js, resolveDisputeTiebreaker
      // in this file). Without this, a provider sees their reliability
      // number move and has no way to find out why. LEFT JOIN so a dispute
      // that hasn't been tiebroken yet still shows up, with resolution null.
      //
      // Joined via jobs.verification_group_id, NOT via
      // vindicated/at_fault_reservation_id -- caught live: an 'inconclusive'
      // verdict leaves BOTH of those columns NULL (nothing was attributed),
      // so a join keyed on them can never match an inconclusive resolution,
      // and a genuinely resolved dispute would sit forever labeled "awaiting
      // tiebreaker". The group id is the one thing every resolution always
      // has, resolved or not.
      const disputesResult = await pool.query(
        `SELECT r.reservation_id, r.node_id, r.updated_at AS disputed_at,
                dr.verdict, dr.vindicated_reservation_id, dr.at_fault_reservation_id
           FROM reservations r
           JOIN compute_nodes cn ON cn.node_id = r.node_id
           JOIN jobs j ON j.reservation_id = r.reservation_id
           LEFT JOIN dispute_resolutions dr ON dr.verification_group_id = j.verification_group_id
          WHERE cn.provider_id = $1 AND r.status = 'disputed'
          ORDER BY r.updated_at DESC
          LIMIT 20`,
        [provider.provider_id]);
      const disputes = disputesResult.rows.map((d) => ({
        reservation_id: d.reservation_id,
        node_id: d.node_id,
        disputed_at: d.disputed_at,
        resolution: d.verdict ? {
          verdict: d.verdict,
          outcome: d.at_fault_reservation_id === d.reservation_id ? 'at_fault'
            : d.vindicated_reservation_id === d.reservation_id ? 'vindicated'
              : null, // inconclusive: this reservation is named on neither side
        } : null, // no tiebreaker requested (yet) for this dispute
      }));

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
        disputes,
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

  // Read-only status check, ownership-scoped the same way every other
  // reservation route is (404, not 403, on mismatch -- see the comment
  // below on /confirm for why). Added specifically so a client can poll
  // whether a reservation reached 'disputed' -- a job's own GET /jobs/:id
  // still reports its own outcome (e.g. 'succeeded') even when the
  // RESERVATION was disputed by a verification mismatch, since the two are
  // genuinely different vocabularies (see jobRowStatusToOutcome's comment).
  // Includes the reservation's own job (if any), most-recent first -- a
  // client that remounts (a tab switch, a page reload) has no other way to
  // recover which job_id belongs to this reservation, since nothing else
  // persists that mapping outside whatever component last held it in
  // memory. Application logic (POST .../jobs) refuses a second job on an
  // already-jobbed reservation, so in practice this is always at most one
  // row; LIMIT 1 is defensive, not load-bearing.
  app.get('/reservations/:id', auth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM reservations WHERE reservation_id = $1 AND user_id = $2',
        [req.params.id, req.userId]);
      const resv = rows[0];
      if (!resv) return res.status(404).json({ error: 'not_found' });
      const jobRows = await pool.query(
        'SELECT * FROM jobs WHERE reservation_id = $1 ORDER BY created_at DESC LIMIT 1',
        [req.params.id]);
      res.json({ ...resv, job: jobRows.rows[0] ?? null });
    } catch (e) { next(e); }
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
  // Two phases when a live gateway is configured (Razorpay's own documented
  // integration model): this endpoint creates an ORDER and hands it to the
  // client for Checkout.js -- it does NOT touch the node or escrow yet, on
  // purpose. Only a verified payment signature (POST .../confirm/verify
  // below) or the webhook may do that. With no live gateway configured, it
  // falls back to the previous immediate behavior unchanged, so every
  // existing test and the e2e script keep working without needing real
  // Razorpay credentials.
  app.post('/reservations/:id/confirm', auth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM reservations WHERE reservation_id = $1', [req.params.id]);
      const resv = rows[0];
      if (!resv || resv.user_id !== req.userId) return res.status(404).json({ error: 'not_found' });
      if (!canTransition(resv.status, S.CONFIRMED)) {
        return res.status(409).json({ error: `cannot confirm from ${resv.status}` });
      }

      const order = await razorpay.createOrder(resv.quoted_paise, resv.reservation_id);
      await pool.query(
        `INSERT INTO payments (user_id, reservation_id, gateway, gateway_ref, amount_paise, status)
         VALUES ($1,$2,$3,$4,$5,'created')`,
        [resv.user_id, resv.reservation_id, razorpay.isConfigured ? 'razorpay' : 'none',
         order.id, resv.quoted_paise]);

      if (!razorpay.isConfigured) {
        const client = await pool.connect();
        try {
          const result = await commitNodeAndCapture(client, hub, resv);
          if (result.error) return res.status(result.status).json({ error: result.error });
          await pool.query(
            "UPDATE payments SET status='captured' WHERE reservation_id=$1 AND gateway_ref=$2",
            [resv.reservation_id, order.id]);
          return res.json(result);
        } finally {
          client.release();
        }
      }

      res.json({
        requires_payment: true, order_id: order.id,
        amount_paise: resv.quoted_paise, currency: 'INR', razorpay_key_id: razorpay.keyId,
      });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'already_captured' });
      next(e);
    }
  });

  // Checkout.js hands the client {order_id, payment_id, signature} after a
  // successful payment. The signature is the ONLY thing that turns "the
  // browser says it worked" into "Razorpay's servers say it worked" -- see
  // payments/razorpay.js's verifyPaymentSignature for why the callback firing
  // is not, on its own, proof of anything.
  app.post('/reservations/:id/confirm/verify', auth, async (req, res, next) => {
    if (!razorpay.isConfigured) {
      return res.status(400).json({ error: 'no_live_gateway_configured' });
    }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        'SELECT * FROM reservations WHERE reservation_id = $1 FOR UPDATE', [req.params.id]);
      const resv = rows[0];
      if (!resv || resv.user_id !== req.userId) return res.status(404).json({ error: 'not_found' });
      if (!canTransition(resv.status, S.CONFIRMED)) {
        return res.status(409).json({ error: `cannot confirm from ${resv.status}` });
      }

      const paymentRow = await client.query(
        `SELECT * FROM payments WHERE reservation_id=$1 AND gateway_ref=$2 AND status='created'`,
        [resv.reservation_id, razorpay_order_id]);
      if (!paymentRow.rows[0]) return res.status(404).json({ error: 'payment_order_not_found' });
      const payment = paymentRow.rows[0];

      const valid = verifyPaymentSignature({
        orderId: razorpay_order_id, paymentId: razorpay_payment_id,
        signature: razorpay_signature, keySecret: razorpay.keySecret,
      });
      if (!valid) {
        await client.query("UPDATE payments SET status='failed' WHERE payment_id=$1", [payment.payment_id]);
        return res.status(400).json({ error: 'invalid_payment_signature' });
      }

      // Past this point, real money has moved -- Razorpay's signature proves
      // Razorpay itself considers the payment captured. This is the fork the
      // no-gateway path never had to make: if the node turns out unreachable
      // NOW, we are not "safely never captured" any more, we are holding a
      // real charge for a slot we cannot deliver, and that needs an actual
      // refund through the gateway, not just an internal status flip.
      await client.query(
        "UPDATE payments SET status='captured', gateway_ref=$2 WHERE payment_id=$1",
        [payment.payment_id, razorpay_payment_id]);

      const result = await commitNodeAndCapture(client, hub, resv);
      if (result.error) {
        const refundResult = await issueRefund(pool, razorpay, {
          paymentId: payment.payment_id, reservationId: resv.reservation_id,
          gatewayRef: razorpay_payment_id, amountPaise: resv.quoted_paise,
        });
        return res.status(result.status).json({
          error: result.error,
          refund_status: refundResult.ok ? 'refunded' : 'queued_for_retry',
        });
      }
      res.json(result);
    } catch (e) {
      next(e);
    } finally {
      client.release();
    }
  });

  // Razorpay's server-to-server notification -- more authoritative than the
  // client-side callback above (it comes from Razorpay directly, not
  // relayed through a browser that could close, crash, or lie). Handles
  // payment.captured as a backstop for a verify call that never arrived
  // (e.g. the user closed the tab right after paying) -- idempotent, since a
  // webhook can be, and often is, delivered more than once by design.
  app.post('/webhooks/razorpay', async (req, res) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      // Distinct from "gateway not configured": a deployment could plausibly
      // take payments via Checkout+verify alone and skip webhooks, but a
      // webhook endpoint that accepts unsigned events is a way to inject
      // fake payment confirmations. Refuse outright rather than trusting it.
      return res.status(500).json({ error: 'RAZORPAY_WEBHOOK_SECRET not configured' });
    }
    const signature = req.get('x-razorpay-signature');
    if (!signature || !verifyWebhookSignature({ rawBody: req.rawBody, signature, webhookSecret })) {
      return res.status(400).json({ error: 'invalid_webhook_signature' });
    }

    const event = req.body?.event;
    const paymentEntity = req.body?.payload?.payment?.entity;
    if (event === 'payment.captured' && paymentEntity) {
      try {
        const orderId = paymentEntity.order_id;
        const paymentRow = await pool.query(
          `SELECT * FROM payments WHERE gateway_ref = $1 AND status = 'created'`, [orderId]);
        const payment = paymentRow.rows[0];
        if (payment) {
          // Same idempotent path the verify endpoint uses -- if verify
          // already ran (the common case), this UPDATE affects zero rows
          // and commitNodeAndCapture is never reached a second time,
          // because the reservation's own status is no longer transitionable.
          const client = await pool.connect();
          try {
            await client.query(
              "UPDATE payments SET status='captured', gateway_ref=$2 WHERE payment_id=$1",
              [payment.payment_id, paymentEntity.id]);
            const { rows } = await client.query(
              'SELECT * FROM reservations WHERE reservation_id = $1 FOR UPDATE',
              [payment.reservation_id]);
            const resv = rows[0];
            if (resv && canTransition(resv.status, S.CONFIRMED)) {
              const result = await commitNodeAndCapture(client, hub, resv);
              // Mirrors the /confirm/verify endpoint's compensating refund via
              // the same issueRefund() helper -- this branch was missing it
              // entirely on the first pass, which would have left a payment
              // captured-but-unrefunded for a slot the node never delivered
              // whenever the WEBHOOK (rather than the client callback) was the
              // path that observed the failure. Both paths now share one
              // implementation instead of two copies that could drift again.
              if (result.error) {
                await issueRefund(pool, razorpay, {
                  paymentId: payment.payment_id, reservationId: payment.reservation_id,
                  gatewayRef: paymentEntity.id, amountPaise: payment.amount_paise,
                });
              }
            }
          } finally {
            client.release();
          }
        }
      } catch (e) {
        console.error('failed to process payment.captured webhook:', e);
      }
    }
    // Razorpay only cares that this returns 2xx; the actual side effect
    // already happened (or didn't, and was logged) above.
    res.json({ received: true });
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
        pool, req.params.id, req.body.outcome, req.body.compute_seconds, razorpay);
      if (result.error) return res.status(result.status).json({ error: result.error });
      res.json(result);
    } catch (e) { next(e); }
  });

  // --- jobs ------------------------------------------------------------

  // Submit a job against a CONFIRMED reservation. Resolves once the node has
  // started the container -- not when the job finishes, which may be hours
  // later and arrives asynchronously via onJobResult below.
  // Pass verify_against_reservation_id (a second, separately booked and
  // confirmed reservation the SAME user already owns, on a DIFFERENT node)
  // to run this identical job on both and compare results --
  // docs/security-model.md's Direction 2 (protecting the user from a
  // malicious or lying provider). Opt-in and manual by design: nothing here
  // decides automatically that a job is worth the doubled cost of running
  // twice, see jobs/verification.js's file header for the honest limits of
  // what two-node comparison can and cannot prove.
  app.post('/reservations/:id/jobs', auth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM reservations WHERE reservation_id = $1', [req.params.id]);
      const resv = rows[0];
      if (!resv || resv.user_id !== req.userId) return res.status(404).json({ error: 'not_found' });
      if (resv.status !== S.CONFIRMED) {
        return res.status(409).json({ error: `reservation is ${resv.status}, not confirmed` });
      }

      const { image, command, env, gpu, verify_against_reservation_id } = req.body;

      // docs/security-model.md's Direction 1 supply-chain gap: `docker run`
      // pulls whatever image reference is given it, and a malicious image
      // is itself a payload independent of the sandbox flags around it.
      // Checked here, before anything else about this job is touched, so a
      // disallowed image never reaches hub.submitJob (and therefore never
      // reaches a worker's `docker run`) regardless of what else is true
      // about the request.
      const imageCheck = checkImageAllowed(image);
      if (!imageCheck.allowed) {
        return res.status(400).json({ error: `image_not_allowed: ${imageCheck.reason}` });
      }

      let sibling = null;
      if (verify_against_reservation_id) {
        const siblingRows = await pool.query(
          'SELECT * FROM reservations WHERE reservation_id = $1', [verify_against_reservation_id]);
        sibling = siblingRows.rows[0];
        if (!sibling || sibling.user_id !== req.userId) {
          return res.status(404).json({ error: 'verify_against_reservation_not_found' });
        }
        if (sibling.status !== S.CONFIRMED) {
          return res.status(409).json({ error: `verification reservation is ${sibling.status}, not confirmed` });
        }
        if (sibling.node_id === resv.node_id) {
          // Comparing a node against itself proves nothing -- a single
          // compromised or buggy node would agree with its own lie every time.
          return res.status(400).json({ error: 'verification requires two different nodes' });
        }
        const siblingJobRows = await pool.query(
          'SELECT 1 FROM jobs WHERE reservation_id = $1', [verify_against_reservation_id]);
        if (siblingJobRows.rows[0]) {
          return res.status(409).json({ error: 'verification reservation already has a job' });
        }
      }

      const jobId = crypto.randomUUID();
      const verificationGroupId = sibling ? crypto.randomUUID() : null;

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
        `INSERT INTO jobs (job_id, reservation_id, image, command, status, started_at, verification_group_id)
         VALUES ($1,$2,$3,$4,'running',now(),$5)`,
        [jobId, resv.reservation_id, image, command, verificationGroupId]);
      // The reservation lifecycle requires confirmed -> running -> completed
      // (see reservations/machine.js); settleReservation later transitions
      // FROM 'running', so skipping this step leaves it stuck at 'confirmed'
      // forever once the job finishes -- caught by the e2e script.
      await pool.query(
        "UPDATE reservations SET status='running', updated_at=now() WHERE reservation_id=$1",
        [resv.reservation_id]);

      let siblingJobId = null;
      let verificationDegraded = false;
      if (sibling) {
        siblingJobId = crypto.randomUUID();
        try {
          await hub.submitJob(sibling.node_id, {
            jobId: siblingJobId, reservationId: sibling.reservation_id, image, command, env, gpu,
          });
          await pool.query(
            `INSERT INTO jobs (job_id, reservation_id, image, command, status, started_at, verification_group_id)
             VALUES ($1,$2,$3,$4,'running',now(),$5)`,
            [siblingJobId, sibling.reservation_id, image, command, verificationGroupId]);
          await pool.query(
            "UPDATE reservations SET status='running', updated_at=now() WHERE reservation_id=$1",
            [sibling.reservation_id]);
        } catch (e) {
          // Graceful degradation, not a hard failure: the first job is
          // ALREADY running by this point (its JOB_ACCEPTED already came
          // back). Strip its verification_group_id so onJobResult settles
          // it normally, solo, once it finishes -- rather than leaving it
          // waiting forever for a sibling that will never arrive.
          await pool.query('UPDATE jobs SET verification_group_id = NULL WHERE job_id = $1', [jobId]);
          verificationDegraded = true;
          siblingJobId = null;
          console.warn(
            `verification sibling submission failed for reservation ${verify_against_reservation_id} -- ` +
            `job ${jobId} continues solo, unverified:`, e.message ?? e);
        }
      }

      res.status(202).json({
        job_id: jobId, status: 'running',
        ...(sibling ? { verification_degraded: verificationDegraded, sibling_job_id: siblingJobId } : {}),
      });
    } catch (e) { next(e); }
  });

  // Third-node fault attribution for a duplicate-execution group that came
  // back MISMATCHED (docs/security-model.md's Direction 2). This does NOT
  // touch money -- the dispute already refunded both original reservations
  // in full via settleVerificationGroup; this is purely about which node's
  // reputation should carry the disagreement, decided by a majority vote
  // against an independently-booked third node running the identical
  // workload. Like verify_against_reservation_id, this is opt-in: nothing
  // automatically books a tiebreaker on a dispute, since that would spend
  // the user's money a second time without their say-so.
  app.post('/verification-groups/:groupId/tiebreak', auth, async (req, res, next) => {
    try {
      // All rows in the group, whatever its current size -- a group already
      // carrying a resolved tiebreaker has grown to 3, and that must still
      // be detected as "already resolved" rather than falling through to
      // "not found" just because it no longer looks like a plain pair.
      const { rows: allGroupJobs } = await pool.query(
        `SELECT j.job_id, j.reservation_id, j.image, j.command,
                r.user_id, r.node_id, r.status AS reservation_status
           FROM jobs j JOIN reservations r ON r.reservation_id = j.reservation_id
          WHERE j.verification_group_id = $1`,
        [req.params.groupId]);
      if (allGroupJobs.length === 0 || allGroupJobs.some((j) => j.user_id !== req.userId)) {
        return res.status(404).json({ error: 'verification_group_not_found' });
      }
      const existingResolution = await pool.query(
        'SELECT 1 FROM dispute_resolutions WHERE verification_group_id = $1', [req.params.groupId]);
      if (existingResolution.rows[0]) {
        return res.status(409).json({ error: 'already_resolved' });
      }
      const groupJobs = allGroupJobs.filter((j) => j.reservation_status === S.DISPUTED);
      if (groupJobs.length !== 2) {
        return res.status(409).json({ error: 'verification_group_not_disputed' });
      }

      const { reservation_id: tiebreakerReservationId } = req.body;
      const { rows: tbRows } = await pool.query(
        'SELECT * FROM reservations WHERE reservation_id = $1', [tiebreakerReservationId]);
      const tiebreakerResv = tbRows[0];
      if (!tiebreakerResv || tiebreakerResv.user_id !== req.userId) {
        return res.status(404).json({ error: 'tiebreaker_reservation_not_found' });
      }
      if (tiebreakerResv.status !== S.CONFIRMED) {
        return res.status(409).json({ error: `tiebreaker reservation is ${tiebreakerResv.status}, not confirmed` });
      }
      if (groupJobs.some((j) => j.node_id === tiebreakerResv.node_id)) {
        // A tiebreaker run on either of the two disputing nodes proves
        // nothing -- it would just be that node agreeing with itself again.
        return res.status(400).json({ error: 'tiebreaker requires a third, different node' });
      }
      const alreadyHasJob = await pool.query(
        'SELECT 1 FROM jobs WHERE reservation_id = $1', [tiebreakerReservationId]);
      if (alreadyHasJob.rows[0]) {
        return res.status(409).json({ error: 'tiebreaker reservation already has a job' });
      }

      // Reuse the ORIGINAL workload's image/command rather than trusting the
      // client to resupply an "identical" one -- the whole point of a
      // tiebreaker is that it ran the same thing the disputing nodes did.
      const { image, command } = groupJobs[0];
      const jobId = crypto.randomUUID();
      try {
        await hub.submitJob(tiebreakerResv.node_id, {
          jobId, reservationId: tiebreakerResv.reservation_id, image, command,
        });
      } catch (e) {
        if (e instanceof NodeOffline) return res.status(409).json({ error: 'node_offline' });
        if (e instanceof NodeRefused) return res.status(409).json({ error: e.reason });
        if (e instanceof NodeTimeout) return res.status(504).json({ error: 'node_unresponsive' });
        throw e;
      }

      await pool.query(
        `INSERT INTO jobs (job_id, reservation_id, image, command, status, started_at, verification_group_id)
         VALUES ($1,$2,$3,$4,'running',now(),$5)`,
        [jobId, tiebreakerResv.reservation_id, image, command, req.params.groupId]);
      await pool.query(
        "UPDATE reservations SET status='running', updated_at=now() WHERE reservation_id=$1",
        [tiebreakerResv.reservation_id]);

      res.status(202).json({ job_id: jobId, status: 'running' });
    } catch (e) { next(e); }
  });

  app.get('/verification-groups/:groupId/resolution', auth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT dr.* FROM dispute_resolutions dr
           JOIN reservations r ON r.reservation_id = dr.tiebreaker_reservation_id
          WHERE dr.verification_group_id = $1 AND r.user_id = $2`,
        [req.params.groupId, req.userId]);
      if (!rows[0]) return res.status(404).json({ error: 'not_found' });
      res.json(rows[0]);
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

  // `razorpay` exposed so index.js can run the periodic refund-retry sweep
  // (payments/refunds.js's processRefundRetries) against the same gateway
  // instance the app itself uses -- not a second one reading env vars again.
  return { app, hub, paymentGateway: razorpay };
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

// A THIRD vocabulary, distinct from both of the above -- settleVerification
// Group reads jobs.status back OUT of the database, which already holds
// mapJobStatus's OUTPUT ('succeeded'/'failed_user'/'failed_provider'), not
// the raw executor status jobStatusToSettlement expects. Feeding
// jobs.status into jobStatusToSettlement would look up a key that function
// never defines ('failed_user' is not one of ITS keys) and silently fall
// through to 'failed_provider' regardless of what actually happened --
// caught here specifically because it is the same class of vocabulary-
// conflation bug documented above, not a new kind of mistake.
function jobRowStatusToOutcome(jobStatus) {
  return {
    succeeded: 'completed',
    failed_user: 'failed_user',
    failed_provider: 'failed_provider',
    timed_out: 'failed_user',
    cancelled: 'failed_provider',
  }[jobStatus] ?? 'failed_provider';
}

// Shared by settleReservation and resolveDisputeTiebreaker below -- one
// place that moves rep_jobs_total/rep_jobs_failed, so a settlement path and
// a fault-attribution path cannot drift into two different ideas of what
// counts as a "failure" for reputation purposes.
async function bumpReputation(client, providerId, effect) {
  if (!effect) return;
  await client.query(
    `UPDATE providers SET rep_jobs_total = rep_jobs_total + 1,
            rep_jobs_failed = rep_jobs_failed + $2
      WHERE provider_id = $1`,
    [providerId, effect === 'failure' ? 1 : 0]);
}

async function providerIdForNode(client, nodeId) {
  const { rows } = await client.query(
    'SELECT provider_id FROM compute_nodes WHERE node_id = $1', [nodeId]);
  return rows[0]?.provider_id ?? null;
}

// The settlement side of duplicate-execution verification
// (jobs/verification.js): once every job sharing a verification_group_id
// has reached a terminal status, compares their results and settles BOTH
// reservations together -- a match settles each on its own outcome (no
// different from an unverified job), a mismatch disputes both in full,
// since two nodes disagreeing proves at least one is wrong but not which
// (see machine.js's DISPUTED state and reputation.js's handling of it).
//
// Only ever called for a 2-job group. A group grows to 3 when a dispute
// tiebreaker is later submitted (see resolveDisputeTiebreaker) -- that path
// is deliberately kept separate rather than generalizing this function,
// since the two answer different questions (settle the money vs. attribute
// fault after money is already settled).
async function settleVerificationGroup(pool, paymentGateway, groupId) {
  const { rows: jobs } = await pool.query(
    'SELECT job_id, reservation_id, status, result_hash, compute_seconds FROM jobs WHERE verification_group_id = $1',
    [groupId]);
  if (!groupIsComplete(jobs, TERMINAL_JOB_STATUSES)) return; // the sibling hasn't finished yet

  const verdict = compareJobResults(jobs[0], jobs[1]);
  const settleAs = verdict === 'match'
    ? (job) => jobRowStatusToOutcome(job.status)
    : () => S.DISPUTED;

  if (verdict === 'mismatch') {
    console.warn(
      `verification group ${groupId} MISMATCHED (jobs ${jobs.map((j) => j.job_id).join(', ')}) ` +
      `-- disputing both reservations, refunding in full. Cannot attribute fault from two samples alone.`);
  }

  for (const job of jobs) {
    const result = await settleReservation(
      pool, job.reservation_id, settleAs(job), job.compute_seconds ?? 0, paymentGateway);
    if (result.error) {
      console.error(`verification-group settlement failed for reservation ${job.reservation_id}: ${result.error}`);
    }
  }
}

// Runs once a dispute tiebreaker job (see POST /verification-groups/:id/tiebreak
// below) reaches a terminal status -- the group is now 3 jobs, two of them
// already DISPUTED (settled, refunded in full by settleVerificationGroup
// above) and a third that just finished. This function does two genuinely
// separate things:
//   1. Settles the TIEBREAKER's own reservation normally, on its own
//      outcome -- whoever booked it is paying for a fresh, ordinary job,
//      not re-litigating the original dispute's money.
//   2. Majority-votes fault: if the tiebreaker agrees with exactly one of
//      the two original (disputed) nodes, that node is vindicated (no
//      reputation effect -- it was never charged with anything) and the
//      other is marked at-fault (a reputation failure, applied directly
//      since settleReservation cannot re-settle an already-terminal
//      DISPUTED reservation). A three-way split attributes nothing.
// Idempotent via dispute_resolutions' UNIQUE(verification_group_id): a
// duplicate JOB_RESULT delivery (see hub.js's at-least-once semantics)
// must not double-bump reputation or insert a second resolution row.
async function resolveDisputeTiebreaker(pool, paymentGateway, groupId) {
  const { rows: jobs } = await pool.query(
    `SELECT j.job_id, j.reservation_id, j.status, j.result_hash, j.compute_seconds,
            r.status AS reservation_status, r.node_id
       FROM jobs j JOIN reservations r ON r.reservation_id = j.reservation_id
      WHERE j.verification_group_id = $1`,
    [groupId]);
  if (!groupIsComplete(jobs, TERMINAL_JOB_STATUSES)) return; // tiebreaker hasn't finished yet

  const original = jobs.filter((j) => j.reservation_status === S.DISPUTED);
  const tiebreaker = jobs.find((j) => j.reservation_status !== S.DISPUTED);
  if (original.length !== 2 || !tiebreaker) {
    console.error(
      `verification group ${groupId} has 3 jobs but not the expected shape ` +
      `(2 disputed + 1 fresh) -- skipping fault attribution`, jobs.map((j) => j.reservation_status));
    return;
  }

  const result = await settleReservation(
    pool, tiebreaker.reservation_id, jobRowStatusToOutcome(tiebreaker.status),
    tiebreaker.compute_seconds ?? 0, paymentGateway);
  if (result.error) {
    console.error(`tiebreaker settlement failed for reservation ${tiebreaker.reservation_id}: ${result.error}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE-free: the UNIQUE constraint below is the actual guard
    // against a concurrent duplicate; this SELECT is just an early,
    // cheaper exit for the common case (one JOB_RESULT, not a race).
    const existing = await client.query(
      'SELECT 1 FROM dispute_resolutions WHERE verification_group_id = $1', [groupId]);
    if (existing.rows[0]) { await client.query('ROLLBACK'); return; }

    const verdict = attributeFaultFromTiebreaker(original, tiebreaker);
    if (verdict.verdict === 'attributed') {
      const atFaultProviderId = await providerIdForNode(client, verdict.atFault.node_id);
      await bumpReputation(client, atFaultProviderId, 'failure');
      console.warn(
        `verification group ${groupId}: tiebreaker attributes fault to reservation ` +
        `${verdict.atFault.reservation_id} (node ${verdict.atFault.node_id}); ` +
        `${verdict.vindicated.reservation_id} vindicated. No money moves -- both were already refunded in full.`);
    } else {
      console.warn(
        `verification group ${groupId}: tiebreaker result agrees with neither original node -- ` +
        `still inconclusive, no fault attributed.`);
    }

    await client.query(
      `INSERT INTO dispute_resolutions
         (verification_group_id, tiebreaker_reservation_id, tiebreaker_job_id, verdict,
          vindicated_reservation_id, at_fault_reservation_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [groupId, tiebreaker.reservation_id, tiebreaker.job_id, verdict.verdict,
        verdict.vindicated?.reservation_id ?? null, verdict.atFault?.reservation_id ?? null]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return; // lost the race to a concurrent resolution -- fine, already recorded
    throw e;
  } finally {
    client.release();
  }
}

// The node+escrow half of confirming a reservation: commit the node's hold
// permanently, then move the quoted amount from user_escrow into
// gateway_clearing. Shared by the no-live-gateway immediate path, the
// Razorpay signature-verify endpoint, and the webhook handler -- one
// implementation, so "does confirming actually move the ledger the same
// way regardless of which path got you there" is true by construction
// rather than something three copies could quietly drift apart on.
async function commitNodeAndCapture(client, hub, resv) {
  try {
    await hub.commitReservation(resv.node_id, resv.reservation_id);
  } catch (e) {
    if (e instanceof NodeOffline || e instanceof NodeTimeout) {
      // The hold likely lapsed on the node's side too. Do not capture money
      // for a slot we cannot prove the node still honours.
      await client.query('BEGIN');
      await client.query(
        "UPDATE reservations SET status='expired', updated_at=now() WHERE reservation_id=$1",
        [resv.reservation_id]);
      await client.query('COMMIT');
      return { error: 'node_unreachable_hold_not_confirmed', status: 409 };
    }
    throw e;
  }

  try {
    await client.query('BEGIN');
    await ensureAccounts(client, resv.user_id, null);
    const gatewayAcct = await accountId(client, 'gateway_clearing', null, null);
    const escrow = await accountId(client, 'user_escrow', resv.user_id, null);

    const txn = await client.query(
      `INSERT INTO ledger_transactions (kind, reservation_id, idempotency_key)
       VALUES ('capture', $1, $2) RETURNING txn_id`,
      [resv.reservation_id, `capture-${resv.reservation_id}`]);
    const txnId = txn.rows[0].txn_id;
    await client.query(
      'INSERT INTO ledger_entries (txn_id, account_id, amount_paise) VALUES ($1,$2,$3),($1,$4,$5)',
      [txnId, gatewayAcct, -resv.quoted_paise, escrow, resv.quoted_paise]);

    await client.query(
      "UPDATE reservations SET status='confirmed', updated_at=now() WHERE reservation_id=$1",
      [resv.reservation_id]);
    await client.query('COMMIT');

    return { reservation_id: resv.reservation_id, status: S.CONFIRMED };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return { error: 'already_captured', status: 409 };
    throw e;
  }
}

// Settlement, usable both from the manual /complete route and from
// onJobResult once a real job finishes. Returns a plain result object rather
// than writing to `res` directly, so callers that are not HTTP handlers (the
// hub's job-result callback) can use it identically.
export async function settleReservation(pool, reservationId, outcome, computeSeconds, paymentGateway) {
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
    await bumpReputation(client, providerId, reputationEffect(outcome));

    await client.query('COMMIT');

    // If real money was collected through a live gateway for this
    // reservation, a refund owed here must actually reach the user, not
    // just move numbers between internal ledger accounts -- the `refunds`
    // account above records that we OWE it; this is what actually pays it.
    // Best-effort: a failed gateway refund does not roll back the ledger
    // entries already committed (the internal accounting that we owe a
    // refund is correct regardless of whether the external call to give it
    // back succeeded yet), it is logged loudly for manual follow-up instead
    // -- the same posture as the verify endpoint's compensating-refund path.
    if (refund > 0 && paymentGateway?.isConfigured) {
      const paid = await pool.query(
        `SELECT payment_id, gateway_ref FROM payments WHERE reservation_id = $1 AND status = 'captured'
           AND gateway = 'razorpay' LIMIT 1`,
        [resv.reservation_id]);
      if (paid.rows[0]) {
        await issueRefund(pool, paymentGateway, {
          paymentId: paid.rows[0].payment_id, reservationId: resv.reservation_id,
          gatewayRef: paid.rows[0].gateway_ref, amountPaise: refund,
        });
      }
    }

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
