// Boots the REAL Express app on a real port and drives it with real fetch
// calls -- this endpoint composes auth, provider/node ownership, and a
// hand-written earnings query, and the seams between those are exactly
// where a unit test of any one piece would miss a real bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import crypto from 'node:crypto';
import { createPool } from '../src/db/pool.js';
import { createApp } from '../src/api/server.js';
import { TYPE } from '../src/ws/protocol.js';
import { encode } from '../src/lib/canonical.js';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://nodeva:nodeva_dev@localhost:5433/nodeva';
process.env.JWT_SECRET ??= crypto.randomBytes(32).toString('hex');

class FakeSocket extends EventEmitter {
  constructor(onSend) { super(); this._onSend = onSend; }
  send(raw) { const msg = JSON.parse(raw); this._onSend?.(msg); }
  close() { this.emit('close'); }
  receive(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
}

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { raw, sign: (buf) => crypto.sign(null, buf, privateKey) };
}

let pool, server, base, hub;
let dbAvailable = false;
try {
  pool = createPool(DATABASE_URL, { connectionTimeoutMillis: 2000 });
  await pool.query('SELECT 1');
  const created = createApp(pool);
  hub = created.hub;
  server = http.createServer(created.app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
  dbAvailable = true;
} catch { /* skipped below */ }

const skip = !dbAvailable && 'requires a reachable Postgres (see docker-compose.yml)';
test.after(() => { server?.close(); pool?.end(); });

const tick = () => new Promise((r) => setImmediate(r));

// Just enough of a worker to authenticate and then hand-send whatever
// HEARTBEAT this test wants -- checkHardwareMismatch only cares about the
// message content, not anything about reservations or jobs.
class MinimalWorker {
  constructor(nodeId, kp) {
    this.nodeId = nodeId; this.kp = kp;
    this.sock = new FakeSocket(() => {});
  }
  _await(predicate) {
    return new Promise((resolve) => {
      this.sock._onSend = (msg) => { if (predicate(msg)) resolve(msg); };
    });
  }
  async connect(hubInstance) {
    const challenge = this._await((m) => m.type === TYPE.CHALLENGE);
    hubInstance.handleConnection(this.sock);
    this.sock.receive({ type: TYPE.HELLO, node_id: this.nodeId });
    const c = await challenge;
    const sig = this.kp.sign(Buffer.from(c.nonce, 'utf8'));
    const welcomed = this._await((m) => m.type === TYPE.WELCOME);
    this.sock.receive({ type: TYPE.CHALLENGE_RESPONSE, signature_hex: sig.toString('hex') });
    await welcomed;
  }
  heartbeat(msg) {
    this.sock.receive({ type: TYPE.HEARTBEAT, ...msg });
  }
  // Opt-in: only the retire-with-a-live-reservation test needs a real
  // booking to go through, so this installs a persistent RESERVE_REQUEST
  // handler rather than making every other test in this file pay for one.
  answerReservationRequests() {
    this.sock._onSend = (msg) => {
      if (msg.type !== TYPE.RESERVE_REQUEST) return;
      const body = {
        reservation_id: msg.reservation_id, node_id: this.nodeId,
        starts_at: msg.starts_at, ends_at: msg.ends_at,
        price_paise_hr: msg.price_paise_hr,
        hold_expires_at: Date.now() + 120_000, issued_at: Date.now(),
      };
      const sig = this.kp.sign(encode(body));
      this.sock.receive({
        type: TYPE.RECEIPT, reservation_id: msg.reservation_id,
        body, signature_hex: sig.toString('hex'),
      });
    };
  }
}

async function signup(displayName) {
  const res = await fetch(`${base}/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `dash-${crypto.randomUUID()}@test.local`,
      password: 'correct horse battery staple', display_name: displayName,
    }),
  });
  return res.json();
}

function authed(token) { return { authorization: `Bearer ${token}` }; }

test('the dashboard 404s for a user who is not a provider yet', { skip }, async () => {
  const { token } = await signup('Not A Provider');
  const res = await fetch(`${base}/providers/me/dashboard`, { headers: authed(token) });
  assert.equal(res.status, 404);
});

test('a fresh provider sees zero nodes, null reliability, zero earnings', { skip }, async () => {
  const { token } = await signup('Fresh Provider');
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(token) });
  const res = await fetch(`${base}/providers/me/dashboard`, { headers: authed(token) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.nodes, []);
  assert.equal(body.reputation.reliability, null,
    'no jobs yet must read as unknown, not a misleading 0% or 100%');
  assert.equal(body.earnings.available_paise, 0);
  assert.deepEqual(body.disputes, [],
    'a provider with no jobs has had no disputes -- see dispute-resolution.test.js for the populated case');
});

test('an enrolled node appears in the dashboard, offline (no worker connected)', { skip }, async () => {
  const { token } = await signup('Provider With A Node');
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(token) });
  const pubKeyHex = crypto.randomBytes(32).toString('hex');
  const enrollRes = await fetch(`${base}/nodes`, {
    method: 'POST', headers: { ...authed(token), 'content-type': 'application/json' },
    body: JSON.stringify({
      public_key_hex: pubKeyHex, gpu_model: 'RTX 4090',
      gpu_vram_mb: 24576, cpu_cores: 16, ram_mb: 32768, price_paise_hr: 4300,
    }),
  });
  const { node_id } = await enrollRes.json();

  const res = await fetch(`${base}/providers/me/dashboard`, { headers: authed(token) });
  const body = await res.json();
  assert.equal(body.nodes.length, 1);
  assert.equal(body.nodes[0].node_id, node_id);
  assert.equal(body.nodes[0].online, false, 'no worker connected in this test -- must not claim online');
  assert.equal(body.nodes[0].heartbeat, null);
});

test("a provider cannot see another provider's dashboard via their own token", { skip }, async () => {
  // Not a shared/global dashboard -- /providers/me derives the provider
  // strictly from the caller's own session, same ownership discipline as
  // reservations. Two different providers, two different dashboards.
  const a = await signup('Provider A');
  const b = await signup('Provider B');
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(a.token) });
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(b.token) });
  await fetch(`${base}/nodes`, {
    method: 'POST', headers: { ...authed(a.token), 'content-type': 'application/json' },
    body: JSON.stringify({
      public_key_hex: crypto.randomBytes(32).toString('hex'), gpu_model: 'A',
      gpu_vram_mb: 1, cpu_cores: 1, ram_mb: 1, price_paise_hr: 1,
    }),
  });
  const bDash = await (await fetch(`${base}/providers/me/dashboard`, { headers: authed(b.token) })).json();
  assert.deepEqual(bDash.nodes, [], "B's dashboard must not include A's node");
});

test('earnings buckets reflect real ledger entries, not just a lifetime total', { skip }, async () => {
  const { token } = await signup('Earning Provider');
  const providerId = (await (await fetch(`${base}/providers/me`, {
    method: 'POST', headers: authed(token),
  })).json()).provider_id;

  // Seed ledger entries directly with explicit created_at timestamps --
  // this is the only way to control "how long ago" without waiting for
  // real time to pass, and the point of this test is the bucket boundary
  // logic in the SQL, not the settlement path that normally produces these
  // rows (already covered by reputation-integration.test.js).
  const txn = crypto.randomUUID();
  await pool.query(
    `INSERT INTO ledger_transactions (txn_id, kind, idempotency_key) VALUES ($1,'settle',$2)`,
    [txn, txn]);
  const acct = (await pool.query(
    `INSERT INTO ledger_accounts (kind, owner_provider_id) VALUES ('provider_balance',$1)
     RETURNING account_id`, [providerId])).rows[0].account_id;
  // A lone credit with no offsetting debit is exactly what the deferred
  // balance trigger (from the very first migration) exists to reject --
  // confirmed the hard way when this test's first draft omitted the
  // counter-entry and the transaction correctly failed to commit. A
  // throwaway platform_revenue account plays the counterparty here, mirroring
  // real settlement's shape without needing a whole reservation fixture.
  // platform_revenue is a platform-wide singleton (see ledger_accounts'
  // NULLS NOT DISTINCT unique constraint) -- other tests and e2e runs
  // sharing this database may have already created it, so look it up
  // instead of assuming a fresh INSERT will succeed.
  const existingCounter = await pool.query(
    `SELECT account_id FROM ledger_accounts WHERE kind = 'platform_revenue'`);
  const counterAcct = existingCounter.rows[0]
    ? existingCounter.rows[0].account_id
    : (await pool.query(
        `INSERT INTO ledger_accounts (kind) VALUES ('platform_revenue') RETURNING account_id`
      )).rows[0].account_id;
  // One entry 2 days ago (inside the week bucket, outside today),
  // one entry 40 days ago (outside every bucket except lifetime).
  await pool.query(
    `INSERT INTO ledger_entries (txn_id, account_id, amount_paise, created_at) VALUES
       ($1,$2, 1000, now() - interval '2 days'), ($1,$3, -1000, now() - interval '2 days'),
       ($1,$2,  500, now() - interval '40 days'), ($1,$3,  -500, now() - interval '40 days')`,
    [txn, acct, counterAcct]);

  const body = await (await fetch(`${base}/providers/me/dashboard`, { headers: authed(token) })).json();
  assert.equal(body.earnings.available_paise, 1500, 'lifetime total includes everything');
  assert.equal(body.earnings.today_paise, 0, 'neither entry is from the last 24h');
  assert.equal(body.earnings.week_paise, 1000, 'only the 2-day-old entry is within 7 days');
  assert.equal(body.earnings.month_paise, 1000, 'the 40-day-old entry is outside the 30-day bucket');
});

// --- hardware mismatch (self-reported, honest-drift detection) ---------

async function enrollAndConnect(token, declared) {
  const kp = keypair();
  const { node_id } = await (await fetch(`${base}/nodes`, {
    method: 'POST', headers: { ...authed(token), 'content-type': 'application/json' },
    body: JSON.stringify({ public_key_hex: kp.raw.toString('hex'), ...declared }),
  })).json();
  const worker = new MinimalWorker(node_id, kp);
  await worker.connect(hub);
  return { node_id, worker };
}

test('a node reporting specs matching its enrollment shows no hardware_mismatch',
  { skip }, async () => {
    const { token } = await signup('Honest Provider');
    await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(token) });
    const { node_id, worker } = await enrollAndConnect(token, {
      gpu_model: 'RTX 4090', gpu_vram_mb: 24576, cpu_cores: 16, ram_mb: 32768, price_paise_hr: 4300,
    });
    worker.heartbeat({
      gpu: { model: 'RTX 4090', vram_total_mb: 24564, vram_free_mb: 20000 }, // within 10% tolerance
      cpu_cores: 16, ram_mb: 32000, // within 10% tolerance of 32768
      live_reservations: 0,
    });
    await tick();

    const body = await (await fetch(`${base}/providers/me/dashboard`, { headers: authed(token) })).json();
    const node = body.nodes.find((n) => n.node_id === node_id);
    assert.equal(node.hardware_mismatch, null);
  });

test('a node reporting fewer CPU cores than enrolled is flagged, exactly (no tolerance)',
  { skip }, async () => {
    const { token } = await signup('Overclaiming Provider');
    await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(token) });
    const { node_id, worker } = await enrollAndConnect(token, {
      gpu_model: 'RTX 4090', gpu_vram_mb: 24576, cpu_cores: 32, ram_mb: 32768, price_paise_hr: 4300,
    });
    worker.heartbeat({ gpu: null, cpu_cores: 8, ram_mb: 32768, live_reservations: 0 });
    await tick();

    const body = await (await fetch(`${base}/providers/me/dashboard`, { headers: authed(token) })).json();
    const node = body.nodes.find((n) => n.node_id === node_id);
    assert.ok(node.hardware_mismatch);
    const cpuMismatch = node.hardware_mismatch.find((m) => m.field === 'cpu_cores');
    assert.deepEqual(cpuMismatch, { field: 'cpu_cores', declared: 32, reported: 8 });
  });

test('a node reporting far less RAM than enrolled (beyond tolerance) is flagged',
  { skip }, async () => {
    const { token } = await signup('Ram Mismatch Provider');
    await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(token) });
    const { node_id, worker } = await enrollAndConnect(token, {
      gpu_model: 'RTX 4090', gpu_vram_mb: 24576, cpu_cores: 16, ram_mb: 65536, price_paise_hr: 4300,
    });
    worker.heartbeat({ gpu: null, cpu_cores: 16, ram_mb: 16384, live_reservations: 0 }); // way under 65536
    await tick();

    const body = await (await fetch(`${base}/providers/me/dashboard`, { headers: authed(token) })).json();
    const node = body.nodes.find((n) => n.node_id === node_id);
    assert.ok(node.hardware_mismatch);
    assert.ok(node.hardware_mismatch.some((m) => m.field === 'ram_mb'));
  });

test('a node before its first heartbeat has hardware_mismatch: null, not a false flag',
  { skip }, async () => {
    const { token } = await signup('No Heartbeat Yet Provider');
    await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(token) });
    const pubKeyHex = crypto.randomBytes(32).toString('hex');
    const { node_id } = await (await fetch(`${base}/nodes`, {
      method: 'POST', headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        public_key_hex: pubKeyHex, gpu_model: 'RTX 4090',
        gpu_vram_mb: 24576, cpu_cores: 16, ram_mb: 32768, price_paise_hr: 4300,
      }),
    })).json();

    const body = await (await fetch(`${base}/providers/me/dashboard`, { headers: authed(token) })).json();
    const node = body.nodes.find((n) => n.node_id === node_id);
    assert.equal(node.hardware_mismatch, null, 'no data yet must not be reported as a mismatch');
  });

// --- retiring a node (POST /nodes/:id/retire) ---------------------------

test('retiring a node removes it from the dashboard list', { skip }, async () => {
  const { token } = await signup('Retiring Provider');
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(token) });
  const { node_id } = await (await fetch(`${base}/nodes`, {
    method: 'POST', headers: { ...authed(token), 'content-type': 'application/json' },
    body: JSON.stringify({
      public_key_hex: crypto.randomBytes(32).toString('hex'), gpu_model: 'RTX 4090',
      gpu_vram_mb: 24576, cpu_cores: 16, ram_mb: 32768, price_paise_hr: 4300,
    }),
  })).json();

  const retireRes = await fetch(`${base}/nodes/${node_id}/retire`, {
    method: 'POST', headers: authed(token),
  });
  assert.equal(retireRes.status, 200);

  const body = await (await fetch(`${base}/providers/me/dashboard`, { headers: authed(token) })).json();
  assert.equal(body.nodes.find((n) => n.node_id === node_id), undefined,
    'a retired node must not still show up as one of "my machines"');
});

test('retiring is idempotent -- the row is never deleted, just marked draining', { skip }, async () => {
  const { token } = await signup('Idempotent Retire Provider');
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(token) });
  const { node_id } = await (await fetch(`${base}/nodes`, {
    method: 'POST', headers: { ...authed(token), 'content-type': 'application/json' },
    body: JSON.stringify({
      public_key_hex: crypto.randomBytes(32).toString('hex'), gpu_model: 'RTX 4090',
      gpu_vram_mb: 24576, cpu_cores: 16, ram_mb: 32768, price_paise_hr: 4300,
    }),
  })).json();

  const first = await fetch(`${base}/nodes/${node_id}/retire`, { method: 'POST', headers: authed(token) });
  const second = await fetch(`${base}/nodes/${node_id}/retire`, { method: 'POST', headers: authed(token) });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200, 'retiring an already-retired node must not error');

  const row = await pool.query('SELECT status FROM compute_nodes WHERE node_id=$1', [node_id]);
  assert.equal(row.rows[0].status, 'draining', 'the row itself survives -- never a real DELETE');
});

test('a provider cannot retire another provider\'s node', { skip }, async () => {
  const a = await signup('Retire Owner A');
  const b = await signup('Retire Attacker B');
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(a.token) });
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(b.token) });
  const { node_id } = await (await fetch(`${base}/nodes`, {
    method: 'POST', headers: { ...authed(a.token), 'content-type': 'application/json' },
    body: JSON.stringify({
      public_key_hex: crypto.randomBytes(32).toString('hex'), gpu_model: 'RTX 4090',
      gpu_vram_mb: 24576, cpu_cores: 16, ram_mb: 32768, price_paise_hr: 4300,
    }),
  })).json();

  const res = await fetch(`${base}/nodes/${node_id}/retire`, { method: 'POST', headers: authed(b.token) });
  assert.equal(res.status, 404, 'hide existence from a non-owner, same as every other ownership check in this file');

  const stillThere = await (await fetch(`${base}/providers/me/dashboard`, { headers: authed(a.token) })).json();
  assert.ok(stillThere.nodes.find((n) => n.node_id === node_id), "the real owner's node must be untouched");
});

test('retiring a node with a live reservation is refused, not silently orphaning a booking', { skip }, async () => {
  const buyer = await signup('Retire Buyer');
  const { token: providerToken } = await signup('Retire Provider With Live Reservation');
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(providerToken) });
  const { node_id, worker } = await enrollAndConnect(providerToken, {
    gpu_model: 'RTX 4090', gpu_vram_mb: 24576, cpu_cores: 16, ram_mb: 32768, price_paise_hr: 4300,
  });
  worker.answerReservationRequests();

  const startsAt = Date.UTC(2033, 0, 1, 10, 0);
  const endsAt = startsAt + 3_600_000;
  const reserveRes = await (await fetch(`${base}/reservations`, {
    method: 'POST', headers: { ...authed(buyer.token), 'content-type': 'application/json' },
    body: JSON.stringify({ node_id, starts_at: startsAt, ends_at: endsAt }),
  })).json();
  assert.ok(reserveRes.reservation_id, 'the booking must have genuinely gone through for this test to mean anything');

  const retireRes = await fetch(`${base}/nodes/${node_id}/retire`, {
    method: 'POST', headers: authed(providerToken),
  });
  assert.equal(retireRes.status, 409);

  const dash = await (await fetch(`${base}/providers/me/dashboard`, { headers: authed(providerToken) })).json();
  assert.ok(dash.nodes.find((n) => n.node_id === node_id), 'must still be listed -- the retire was refused');
  worker.sock.close();
});

// --- re-enrolling with an already-registered public key -----------------

test('enrolling a node with a public key that is already registered gives a clean 409, not a raw 500', { skip }, async () => {
  const { token } = await signup('Duplicate Key Provider');
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(token) });
  const publicKeyHex = crypto.randomBytes(32).toString('hex');
  const body = JSON.stringify({
    public_key_hex: publicKeyHex, gpu_model: 'RTX 4090',
    gpu_vram_mb: 24576, cpu_cores: 16, ram_mb: 32768, price_paise_hr: 4300,
  });
  const first = await fetch(`${base}/nodes`, {
    method: 'POST', headers: { ...authed(token), 'content-type': 'application/json' }, body,
  });
  assert.equal(first.status, 201);

  // Exactly the real-world scenario the NodeIdentity ~-expansion bug used
  // to cause: re-running the enrollment CLI snippet is now correctly
  // idempotent about which key it returns, so re-enrolling the SAME
  // physical machine hits this constraint for real.
  const second = await fetch(`${base}/nodes`, {
    method: 'POST', headers: { ...authed(token), 'content-type': 'application/json' }, body,
  });
  assert.equal(second.status, 409);
  const secondBody = await second.json();
  assert.match(secondBody.error, /already enrolled/);
  assert.doesNotMatch(secondBody.error, /constraint|pg-pool|duplicate key value/,
    'must not leak the raw Postgres error message to the client');
});

// --- presence must never resurrect a retired node ------------------------

test('a retired node stays retired even after its worker disconnects and reconnects', { skip }, async () => {
  // Real, live-caught bug: onPresence unconditionally wrote 'online'/
  // 'offline' on every connect/disconnect, so a retired ('draining') node
  // whose worker process was still running (or simply reconnected after a
  // network blip) got silently resurrected back into search results and
  // "My Machines" the moment it reconnected.
  const { token } = await signup('Resurrection Provider');
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(token) });
  const kp = keypair();
  const { node_id } = await (await fetch(`${base}/nodes`, {
    method: 'POST', headers: { ...authed(token), 'content-type': 'application/json' },
    body: JSON.stringify({
      public_key_hex: kp.raw.toString('hex'), gpu_model: 'RTX 4090',
      gpu_vram_mb: 24576, cpu_cores: 16, ram_mb: 32768, price_paise_hr: 4300,
    }),
  })).json();

  const firstConnection = new MinimalWorker(node_id, kp);
  await firstConnection.connect(hub);

  const retireRes = await fetch(`${base}/nodes/${node_id}/retire`, { method: 'POST', headers: authed(token) });
  assert.equal(retireRes.status, 200);

  // Disconnect (fires onPresence(false)) and reconnect with a FRESH socket
  // using the same identity (fires onPresence(true)) -- exactly what a
  // real worker process does on a network blip or restart.
  firstConnection.sock.close();
  await tick();
  const secondConnection = new MinimalWorker(node_id, kp);
  await secondConnection.connect(hub);
  await tick();

  const row = await pool.query('SELECT status FROM compute_nodes WHERE node_id=$1', [node_id]);
  assert.equal(row.rows[0].status, 'draining', 'reconnecting must not resurrect a retired node');

  const dash = await (await fetch(`${base}/providers/me/dashboard`, { headers: authed(token) })).json();
  assert.equal(dash.nodes.find((n) => n.node_id === node_id), undefined,
    'still must not appear in "My Machines" after the worker reconnects');
});

// --- enrollment field validation (0 or negative values) -----------------

test('enrolling a node with gpu_vram_mb: 0 gives a clean 400, not a raw 500', { skip }, async () => {
  // Real, live-caught case: a CPU-only machine's hardware.py detection
  // correctly reports gpu_vram_gb: null (no NVIDIA GPU -- true for a
  // CPU-only box, a Mac, or an AMD card), which a provider then left as
  // 0 in the form. Postgres's own CHECK (gpu_vram_mb > 0) rejected the
  // INSERT with a raw constraint-violation message before this validation
  // existed.
  const { token } = await signup('Zero VRAM Provider');
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(token) });
  const res = await fetch(`${base}/nodes`, {
    method: 'POST', headers: { ...authed(token), 'content-type': 'application/json' },
    body: JSON.stringify({
      public_key_hex: crypto.randomBytes(32).toString('hex'), gpu_model: 'Apple silicon',
      gpu_vram_mb: 0, cpu_cores: 8, ram_mb: 8192, price_paise_hr: 4300,
    }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /gpu_vram_mb must be greater than 0/);
});

test('the same validation applies to cpu_cores, ram_mb, and price_paise_hr', { skip }, async () => {
  const { token } = await signup('Other Zero Fields Provider');
  await fetch(`${base}/providers/me`, { method: 'POST', headers: authed(token) });
  const base_node = {
    public_key_hex: crypto.randomBytes(32).toString('hex'), gpu_model: 'RTX 4090',
    gpu_vram_mb: 24576, cpu_cores: 16, ram_mb: 32768, price_paise_hr: 4300,
  };
  for (const [field, badValue] of [['cpu_cores', 0], ['ram_mb', -1], ['price_paise_hr', 0]]) {
    const res = await fetch(`${base}/nodes`, {
      method: 'POST', headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({ ...base_node, public_key_hex: crypto.randomBytes(32).toString('hex'), [field]: badValue }),
    });
    assert.equal(res.status, 400, `expected 400 for ${field}=${badValue}`);
    const body = await res.json();
    assert.match(body.error, new RegExp(`${field} must be greater than 0`));
  }
});
