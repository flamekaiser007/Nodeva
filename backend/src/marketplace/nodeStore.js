import { subtractBusy } from './scheduler.js';

// Postgres-backed view of compute_nodes, joined with live hub presence.
//
// Reiterating the design boundary: this is a SEARCH INDEX. `status='online'`
// here means "the node's last heartbeat said so", not "the node is reachable
// right now" — the hub's in-memory presence is closer to ground truth than
// this column is, which is why searchCandidates cross-checks both.

// Time already sold on these nodes, so it can be removed from what we
// advertise. The status set is not a judgement call: it is exactly the set
// reservations' own EXCLUDE constraint refuses to double-book
// (migrations/001_init.sql), so the catalogue offers precisely what the
// database would actually accept a booking for. 'pending' is absent there
// and here alike -- the node has not locked that slot yet, and holding it
// against everyone else on the strength of an intent would let a
// never-completed booking quietly fence off a provider's whole day.
async function busySlotsByNode(pool, nodeIds, from) {
  if (!nodeIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT node_id, lower(slot) AS starts_at, upper(slot) AS ends_at
       FROM reservations
      WHERE node_id = ANY($1::uuid[])
        AND status IN ('held','confirmed','running','completed')
        AND upper(slot) >= $2`,
    [nodeIds, from]);

  const byNode = new Map();
  for (const r of rows) {
    const list = byNode.get(r.node_id) ?? [];
    list.push({ start: r.starts_at.getTime(), end: r.ends_at.getTime() });
    byNode.set(r.node_id, list);
  }
  return byNode;
}

/**
 * Everything a buyer could actually rent right now, with no requirements to
 * state up front -- the browse view's counterpart to searchCandidates.
 *
 * "Bookable" is deliberately the SAME bar search applies, so the catalogue
 * can never advertise something search would refuse to return:
 *   - status='online' (which also excludes 'draining', i.e. retired nodes)
 *   - the hub agrees the socket is actually up, not just the last heartbeat
 *   - at least one availability window that has not already ended
 *
 * That last one is the difference between this and a raw node dump: a node
 * with no availability window cannot be booked for any time at all, so
 * listing it would be advertising something nobody can buy.
 */
export async function browseCatalogue(pool, hub, { now = new Date() } = {}) {
  const { rows } = await pool.query(
    `SELECT n.node_id, n.gpu_model, n.gpu_vram_mb, n.cpu_cores, n.ram_mb,
            n.price_paise_hr, n.perf_score, n.status,
            p.rep_jobs_total, p.rep_jobs_failed
       FROM compute_nodes n
       JOIN providers p ON p.provider_id = n.provider_id
      WHERE n.status = 'online'`);

  const nodeIds = rows.map((r) => r.node_id);
  const availability = nodeIds.length
    ? await pool.query(
        `SELECT node_id, window_start, window_end FROM node_availability
          WHERE node_id = ANY($1::uuid[]) AND window_end >= $2
          ORDER BY window_start`,
        [nodeIds, now],
      )
    : { rows: [] };

  const busyByNode = await busySlotsByNode(pool, nodeIds, now);

  const windowsByNode = new Map();
  for (const a of availability.rows) {
    const list = windowsByNode.get(a.node_id) ?? [];
    list.push({ start: a.window_start.getTime(), end: a.window_end.getTime() });
    windowsByNode.set(a.node_id, list);
  }
  // What is left after existing bookings -- a node whose declared windows are
  // entirely sold has nothing to advertise and drops out below.
  for (const [nodeId, windows] of windowsByNode) {
    const free = subtractBusy(windows, busyByNode.get(nodeId));
    if (free.length) windowsByNode.set(nodeId, free);
    else windowsByNode.delete(nodeId);
  }

  return rows
    .filter((r) => hub.isOnline(r.node_id))
    .filter((r) => windowsByNode.has(r.node_id))
    .map((r) => ({
      id: r.node_id,
      gpu_model: r.gpu_model,
      gpu_vram_mb: r.gpu_vram_mb,
      cpu_cores: r.cpu_cores,
      ram_mb: r.ram_mb,
      price_paise_hr: r.price_paise_hr,
      perf_score: r.perf_score,
      // Same neutral prior as searchCandidates -- a brand-new provider must
      // not read as either proven or terrible. See its comment for why.
      reliability: r.rep_jobs_total > 0
        ? 1 - r.rep_jobs_failed / r.rep_jobs_total
        : 0.8,
      rep_jobs_total: r.rep_jobs_total,
      availability: windowsByNode.get(r.node_id),
    }))
    .sort((a, b) => a.price_paise_hr - b.price_paise_hr);
}

export async function searchCandidates(pool, hub, req) {
  // Broad SQL prefilter (index-friendly columns), fine-grained window and
  // scoring logic stays in scheduler.js so it is shared with tests that don't
  // touch a database at all.
  const { rows } = await pool.query(
    `SELECT n.node_id, n.gpu_model, n.gpu_vram_mb, n.cpu_cores, n.ram_mb,
            n.price_paise_hr, n.perf_score, n.status,
            p.rep_jobs_total, p.rep_jobs_failed
       FROM compute_nodes n
       JOIN providers p ON p.provider_id = n.provider_id
       WHERE n.status = 'online'
         AND n.gpu_vram_mb >= $1 AND n.cpu_cores >= $2 AND n.ram_mb >= $3
         AND ($4::bigint IS NULL OR n.price_paise_hr <= $4)`,
    [req.min_vram_mb, req.min_cpu_cores, req.min_ram_mb, req.max_price_paise_hr ?? null],
  );

  const nodeIds = rows.map((r) => r.node_id);
  const availability = nodeIds.length
    ? await pool.query(
        `SELECT node_id, window_start, window_end FROM node_availability
          WHERE node_id = ANY($1::uuid[])
            AND window_end >= $2 AND window_start <= $3`,
        [nodeIds, new Date(req.starts_at), new Date(req.ends_at)],
      )
    : { rows: [] };

  const busyByNode = await busySlotsByNode(pool, nodeIds, new Date(req.starts_at));

  const windowsByNode = new Map();
  for (const a of availability.rows) {
    const list = windowsByNode.get(a.node_id) ?? [];
    list.push({ start: a.window_start.getTime(), end: a.window_end.getTime() });
    windowsByNode.set(a.node_id, list);
  }
  // Same correction as browseCatalogue: a window with a booking already in it
  // is not free time. Without this, feasible()/coversWindow would match a
  // request against a slot that reservations' EXCLUDE constraint then
  // refuses -- the node looks available right up until booking fails.
  for (const [nodeId, windows] of windowsByNode) {
    windowsByNode.set(nodeId, subtractBusy(windows, busyByNode.get(nodeId)));
  }

  return rows
    // The database's `online` is advisory; require the hub to agree the
    // socket is actually up before we let a user try to book it.
    .filter((r) => hub.isOnline(r.node_id))
    .map((r) => ({
      id: r.node_id,
      status: r.status,
      gpu_model: r.gpu_model,
      gpu_vram_mb: r.gpu_vram_mb,
      cpu_cores: r.cpu_cores,
      ram_mb: r.ram_mb,
      price_paise_hr: r.price_paise_hr,
      perf_score: r.perf_score,
      // No verified track record yet defaults to a neutral prior rather than
      // 0 (which would bury every new provider under the reliability term)
      // or 1 (which would let a brand-new node masquerade as proven).
      reliability: r.rep_jobs_total > 0
        ? 1 - r.rep_jobs_failed / r.rep_jobs_total
        : 0.8,
      // Kept alongside the derived reliability score (not folded into it)
      // because scheduler.js's shouldRecommendVerification needs to tell
      // "zero jobs" apart from "jobs whose reliability happens to compute
      // to the same neutral default" -- reliability alone can't distinguish
      // those two cases.
      rep_jobs_total: r.rep_jobs_total,
      latency_ms: 50, // placeholder until real RTT measurement lands (Phase 2)
      availability: windowsByNode.get(r.node_id) ?? [],
    }));
}
