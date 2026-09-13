// HTTP + WebSocket server.
//
// SCOPE NOTE: this wires the reservation/payment core loop end to end —
// enroll a node, search, book, confirm, complete a job, settle. It does NOT
// implement user signup/login. Building real auth (password hashing, session
// or JWT issuance, account recovery) properly is its own unit of work; a
// corner-cut version here would look done while being a security liability,
// which is worse than an honest gap. `POST /dev/users` exists ONLY to seed a
// user row for exercising the reservation flow and must not ship as-is.

import express from 'express';
import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import { Hub, NodeOffline, NodeRefused, NodeTimeout } from '../ws/hub.js';
import { admitReceipt } from '../lib/verify.js';
import { searchCandidates } from '../marketplace/nodeStore.js';
import { rank } from '../marketplace/scheduler.js';
import { quote, split, meteredCharge } from '../payments/settle.js';
import { S, canTransition, SETTLEMENT } from '../reservations/machine.js';

export function createApp(pool) {
  const app = express();
  app.use(express.json());

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
    onHeartbeat: (nodeId) => {
      pool.query('UPDATE compute_nodes SET last_seen_at = now() WHERE node_id = $1',
        [nodeId]).catch(() => {});
    },
  });

  // --- dev-only seeding, see SCOPE NOTE above -------------------------------
  app.post('/dev/users', async (req, res, next) => {
    try {
      const { email, display_name } = req.body;
      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, display_name)
         VALUES ($1, 'dev-stub-not-a-real-hash', $2) RETURNING user_id`,
        [email, display_name]);
      res.status(201).json({ user_id: rows[0].user_id });
    } catch (e) { next(e); }
  });

  app.post('/dev/providers', async (req, res, next) => {
    try {
      const { user_id } = req.body;
      const { rows } = await pool.query(
        'INSERT INTO providers (user_id) VALUES ($1) RETURNING provider_id', [user_id]);
      res.status(201).json({ provider_id: rows[0].provider_id });
    } catch (e) { next(e); }
  });

  // --- node enrollment -------------------------------------------------------

  app.post('/nodes', async (req, res, next) => {
    try {
      const { provider_id, public_key_hex, gpu_model, gpu_vram_mb,
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
        [provider_id, pub, gpu_model, gpu_vram_mb, cpu_cores, ram_mb,
         price_paise_hr, cuda_version ?? null]);
      res.status(201).json({ node_id: rows[0].node_id });
    } catch (e) { next(e); }
  });

  app.post('/nodes/:id/availability', async (req, res, next) => {
    try {
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
  app.post('/reservations', async (req, res, next) => {
    const { node_id, user_id, starts_at, ends_at } = req.body;
    try {
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
  app.post('/reservations/:id/confirm', async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        'SELECT * FROM reservations WHERE reservation_id = $1 FOR UPDATE',
        [req.params.id]);
      const resv = rows[0];
      if (!resv) return res.status(404).json({ error: 'not_found' });
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

  // Job completion + settlement. Job execution itself (Docker, sandboxing)
  // is not built yet — this endpoint accepts the OUTCOME a worker would report
  // and runs the money side of it, so the settlement math is exercised for
  // real rather than only in unit tests.
  app.post('/reservations/:id/complete', async (req, res, next) => {
    const { outcome, compute_seconds } = req.body; // 'completed' | 'failed_user' | 'failed_provider'
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        'SELECT * FROM reservations WHERE reservation_id = $1 FOR UPDATE', [req.params.id]);
      const resv = rows[0];
      if (!resv) return res.status(404).json({ error: 'not_found' });
      if (!SETTLEMENT[outcome]) return res.status(400).json({ error: 'unknown_outcome' });

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
        chargePaise = meteredCharge(resv.quoted_paise, resv.price_paise_hr, compute_seconds ?? 0);
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
      await client.query('COMMIT');

      res.json({ reservation_id: resv.reservation_id, status: outcome,
                 charged_paise: chargePaise, refunded_paise: refund });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e.code === '23505') return res.status(409).json({ error: 'already_settled' });
      next(e);
    } finally {
      client.release();
    }
  });

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return { app, hub };
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
