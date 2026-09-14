import { useEffect, useState } from 'react'
import { api } from '../api'

function paise(p) { return `₹${(p / 100).toFixed(2)}` }

// Mirrors GET /providers/me/dashboard exactly -- one fetch, one render.
// Node enrollment here only accepts a PUBLIC key: the private key is
// generated and stays on the provider's own machine by the Compute Worker
// (worker/nodeva_worker/identity.py), never typed into a browser. This
// dashboard is the provider's view of what their worker(s) report, not a
// way to create or hold key material.
export default function ProviderDashboard() {
  const [dashboard, setDashboard] = useState(null)
  const [needsProvider, setNeedsProvider] = useState(false)
  const [error, setError] = useState(null)
  const [becoming, setBecoming] = useState(false)
  const [showEnroll, setShowEnroll] = useState(false)

  async function load() {
    try {
      setDashboard(await api.providerDashboard())
      setNeedsProvider(false)
    } catch (e) {
      if (e.status === 404) setNeedsProvider(true)
      else setError(e.message)
    }
  }

  useEffect(() => {
    // This IS the standard fetch-on-mount-and-poll shape (React's own docs
    // use this exact pattern for an effect synchronizing with a remote data
    // source) -- load()'s eventual setState is not a cascading-render bug,
    // it's the effect doing its job. The disable comment must sit directly
    // above the call itself; placed above trailing explanatory comments
    // instead, it silences the wrong line and does nothing (caught by
    // re-running the linter after adding it the first time).
    // eslint-disable-next-line react/set-state-in-effect
    load()
    // Heartbeats land every 15s; refresh often enough that "live" GPU
    // utilization actually looks live, not so often it hammers the API.
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [])

  async function handleBecomeProvider() {
    setBecoming(true); setError(null)
    try {
      await api.becomeProvider()
      await load()
    } catch (e) {
      setError(e.message)
    } finally {
      setBecoming(false)
    }
  }

  if (error) {
    return <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
  }

  if (needsProvider) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-6 text-center">
        <p className="mb-3 text-neutral-600">
          You're not sharing compute yet. One account, two roles -- becoming a
          provider doesn't change how you rent GPUs.
        </p>
        <button onClick={handleBecomeProvider} disabled={becoming}
          className="rounded bg-emerald-700 px-4 py-2 font-medium text-white hover:bg-emerald-800 disabled:opacity-50">
          {becoming ? 'Setting up…' : 'Share your GPU'}
        </button>
      </div>
    )
  }

  if (!dashboard) return <div className="text-neutral-500">Loading…</div>

  const { reputation, earnings, nodes, disputes } = dashboard

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Today" value={paise(earnings.today_paise)} />
        <Stat label="This week" value={paise(earnings.week_paise)} />
        <Stat label="This month" value={paise(earnings.month_paise)} />
        <Stat label="All time" value={paise(earnings.available_paise)} />
      </div>

      <div className="rounded-lg border border-neutral-200 bg-white p-4">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium text-neutral-700">Reputation</span>
          <span className="text-neutral-500">
            {reputation.jobs_total} jobs
            {reputation.reliability !== null && (
              <> · {(reputation.reliability * 100).toFixed(0)}% reliable</>
            )}
          </span>
        </div>
      </div>

      {disputes.length > 0 && <DisputeHistory disputes={disputes} />}

      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-neutral-800">My Machines</h3>
        <button onClick={() => setShowEnroll((s) => !s)}
          className="text-sm text-emerald-700 hover:underline">
          {showEnroll ? 'cancel' : '+ enroll a node'}
        </button>
      </div>

      {showEnroll && <EnrollNodeForm onEnrolled={() => { setShowEnroll(false); load() }} />}

      {nodes.length === 0 && !showEnroll && (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-6 text-center text-neutral-500">
          No machines enrolled yet.
        </div>
      )}

      <div className="grid gap-3">
        {nodes.map((n) => <NodeCard key={n.node_id} node={n} onRetired={load} />)}
      </div>
    </div>
  )
}

const DISPUTE_OUTCOME = {
  at_fault: { label: 'Fault attributed to this node', className: 'bg-red-50 text-red-700' },
  vindicated: { label: 'Vindicated', className: 'bg-emerald-50 text-emerald-700' },
}

// Surfaces WHY rep_jobs_failed moved for a reason nothing else on this
// dashboard explains: a duplicate-execution mismatch on one of this
// provider's nodes (docs/security-model.md's Direction 2). Without this, a
// provider watching their reliability number drop has no way to find out
// it was a dispute, let alone whether a third-node tiebreaker later
// vindicated them or found them at fault -- see GET
// /providers/me/dashboard's `disputes` field and api/server.js's
// resolveDisputeTiebreaker.
function DisputeHistory({ disputes }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <h3 className="mb-2 text-sm font-semibold text-amber-900">Disputes on your nodes</h3>
      <div className="grid gap-2">
        {disputes.map((d) => {
          const outcome = d.resolution ? DISPUTE_OUTCOME[d.resolution.outcome] : null
          return (
            <div key={d.reservation_id}
              className="flex items-center justify-between rounded border border-amber-200 bg-white px-3 py-2 text-sm">
              <span className="font-mono text-xs text-neutral-500">
                {d.reservation_id.slice(0, 8)} · {new Date(d.disputed_at).toLocaleDateString()}
              </span>
              {outcome ? (
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${outcome.className}`}>
                  {outcome.label}
                </span>
              ) : d.resolution ? (
                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
                  Inconclusive
                </span>
              ) : (
                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600">
                  Awaiting tiebreaker
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-3 text-center">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="text-lg font-semibold text-neutral-800">{value}</div>
    </div>
  )
}

function NodeCard({ node, onRetired }) {
  const gpu = node.heartbeat?.gpu
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function handleRemove() {
    // A node with a live reservation is refused server-side (409) rather
    // than silently orphaning a paying user's in-progress booking -- see
    // api/server.js's POST /nodes/:id/retire. window.confirm here is a
    // deliberately cheap guard against a stray click; the real safety
    // check is the backend's, not this one.
    if (!window.confirm(`Remove ${node.gpu_model}? This machine will stop appearing to renters.`)) return
    setBusy(true); setError(null)
    try {
      await api.retireNode(node.node_id)
      onRetired?.()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${node.online ? 'bg-emerald-500' : 'bg-neutral-300'}`} />
          <span className="font-semibold text-neutral-800">{node.gpu_model}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-neutral-500">{node.online ? 'ONLINE' : 'OFFLINE'}</span>
          <button onClick={handleRemove} disabled={busy}
            className="text-xs font-medium text-red-600 hover:underline disabled:opacity-40">
            {busy ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </div>
      {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
      <div className="mt-1 text-sm text-neutral-500">
        {(node.gpu_vram_mb / 1024).toFixed(0)} GB VRAM · {node.cpu_cores} cores ·{' '}
        {(node.ram_mb / 1024).toFixed(0)} GB RAM · {paise(node.price_paise_hr)}/hr
      </div>
      {gpu ? (
        <div className="mt-2 flex gap-4 text-xs text-neutral-500">
          <span>GPU util: {gpu.utilization_pct ?? '—'}%</span>
          <span>Free VRAM: {gpu.vram_free_mb != null ? `${(gpu.vram_free_mb / 1024).toFixed(1)} GB` : '—'}</span>
          <span>Temp: {gpu.temperature_c ?? '—'}°C</span>
        </div>
      ) : node.heartbeat ? (
        // A heartbeat DID arrive -- confirmed against the real API response
        // (age_ms present, non-null) -- but its `gpu` field is null, which
        // is the correct, expected shape for a CPU-only worker or one where
        // nvidia-smi found nothing (see worker/nodeva_worker/hardware.py's
        // NoGpu path). Showing "waiting for first heartbeat" here would have
        // been permanently wrong for any such node -- it already reported in,
        // it just has no GPU to report on.
        <div className="mt-2 text-xs text-neutral-400">
          CPU-only node · {node.heartbeat.live_reservations ?? 0} active reservation(s)
        </div>
      ) : node.online ? (
        <div className="mt-2 text-xs text-neutral-400">waiting for first heartbeat…</div>
      ) : null}
      {node.hardware_mismatch && <HardwareMismatchNotice mismatches={node.hardware_mismatch} />}
    </div>
  )
}

const MISMATCH_FIELD = {
  cpu_cores: { label: 'CPU cores', format: (v) => `${v} cores` },
  ram_mb: { label: 'RAM', format: (v) => `${(v / 1024).toFixed(0)} GB` },
  gpu_vram_mb: { label: 'GPU VRAM', format: (v) => `${(v / 1024).toFixed(0)} GB` },
}

// Self-reported, both sides -- see api/server.js's checkHardwareMismatch
// for why this can never be a security check (a dishonest operator can
// make both numbers agree by lying consistently). This exists to catch an
// HONEST drift: upgraded hardware without updating the listing, a typo at
// enrollment, a swapped GPU -- so it's framed as a listing discrepancy for
// the provider to fix, not an accusation.
function HardwareMismatchNotice({ mismatches }) {
  return (
    <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
      <div className="font-medium">Listing doesn't match what this node reports:</div>
      <ul className="mt-1 space-y-0.5">
        {mismatches.map((m) => {
          const field = MISMATCH_FIELD[m.field] ?? { label: m.field, format: (v) => v }
          return (
            <li key={m.field}>
              {field.label}: listed {field.format(m.declared)}, node reports {field.format(m.reported)}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function EnrollNodeForm({ onEnrolled }) {
  const [pubKey, setPubKey] = useState('')
  // Empty, not pre-filled with a plausible-looking example -- these used to
  // default to 'RTX 4090' / 24 / 16 / 32 / 43, real values a provider could
  // submit by clicking "Enroll" without touching a single field. That's
  // exactly the failure mode api/server.js's checkHardwareMismatch exists
  // to catch (a node's DECLARED specs not matching what its own worker
  // heartbeat later reports), except here the form itself was the thing
  // inviting a mismatch, not provider dishonesty. See LabeledInput's
  // `placeholder` for where the example values still live, correctly
  // grayed-out and never submitted unless typed.
  const [gpuModel, setGpuModel] = useState('')
  const [vram, setVram] = useState('')
  const [cores, setCores] = useState('')
  const [ram, setRam] = useState('')
  const [price, setPrice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [detected, setDetected] = useState(null) // which fields the pasted JSON actually filled in, for the confirmation note below
  const [noGpuDetected, setNoGpuDetected] = useState(false) // real hardware.py output, gpu_model: null -- worth explaining, not a silent blank

  // The CLI snippet below prints a JSON blob (public key + real detected
  // hardware, see worker/nodeva_worker/hardware.py's describe_this_machine)
  // instead of a bare hex string. Pasting the whole blob here auto-fills
  // the fields it could detect; pasting a bare hex string (or a GPU-less
  // node reporting nulls for those fields) still works exactly as before
  // -- this only ever ADDS values, never blocks manual entry or overrides
  // something the provider already typed for a field.
  function handlePaste(raw) {
    setPubKey(raw)
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return // not JSON -- treat as a bare public key, nothing else to fill
    }
    if (!parsed.public_key_hex) return
    setPubKey(parsed.public_key_hex)
    const filled = []
    if (parsed.gpu_model) { setGpuModel(parsed.gpu_model); filled.push('GPU model') }
    if (parsed.gpu_vram_gb != null) { setVram(String(parsed.gpu_vram_gb)); filled.push('VRAM') }
    if (parsed.cpu_cores != null) { setCores(String(parsed.cpu_cores)); filled.push('CPU cores') }
    if (parsed.ram_gb != null) { setRam(String(parsed.ram_gb)); filled.push('RAM') }
    setDetected(filled)
    // hardware.py's own honest-unknown posture: gpu_model: null means the
    // worker genuinely found no nvidia-smi-visible GPU on this machine
    // (a CPU-only box, or a non-NVIDIA GPU like Apple Silicon or an AMD
    // card -- nvidia-smi can't see either). Worth saying outright, since
    // leaving GPU model blank with no explanation just looks broken.
    setNoGpuDetected('gpu_model' in parsed && parsed.gpu_model == null)
  }

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      await api.enrollNode({
        public_key_hex: pubKey.trim(),
        gpu_model: gpuModel,
        gpu_vram_mb: Number(vram) * 1024,
        cpu_cores: Number(cores),
        ram_mb: Number(ram) * 1024,
        price_paise_hr: Math.round(Number(price) * 100),
      })
      onEnrolled()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-lg border border-neutral-200 bg-white p-4">
      <p className="text-xs text-neutral-500">
        From the <code>NODEVA</code> project folder you cloned on the
        machine you're sharing, set up the worker's environment ONCE:
      </p>
      <pre className="overflow-x-auto rounded bg-neutral-900 p-2 text-xs text-neutral-100">
{`python3 -m venv .venv
.venv/bin/pip install -r worker/requirements.txt`}
      </pre>
      <p className="text-xs text-neutral-500">
        Then run this and paste its output below (the worker generates and
        keeps the private key -- it never leaves that machine). This also
        detects and fills in your real GPU model, VRAM, CPU cores, and
        RAM, so you don't have to type them in by hand:
      </p>
      <pre className="overflow-x-auto rounded bg-neutral-900 p-2 text-xs text-neutral-100">
{`.venv/bin/python -c "
import sys; sys.path.insert(0, 'worker')
import json
from pathlib import Path
from nodeva_worker.identity import NodeIdentity
from nodeva_worker.hardware import describe_this_machine
ident = NodeIdentity.load_or_create(Path('~/.nodeva/node.pem'))
print(json.dumps({'public_key_hex': ident.public_key_raw().hex(), **describe_this_machine()}))
"`}
      </pre>
      <input required placeholder="paste the command's output here" value={pubKey}
        onChange={(e) => handlePaste(e.target.value)}
        className="rounded border border-neutral-300 px-2 py-1 font-mono text-sm" />
      {detected?.length > 0 && (
        <p className="text-xs text-emerald-700">
          ✓ Detected from your machine: {detected.join(', ')}. Double-check
          below before enrolling.
        </p>
      )}
      {noGpuDetected && (
        <p className="text-xs text-amber-700">
          ⚠ No NVIDIA GPU was detected on this machine (nvidia-smi found
          nothing -- true for a CPU-only box, and also for a Mac or an AMD
          card, which nvidia-smi can't see either way). This marketplace
          currently lists NVIDIA GPUs only, so GPU model and VRAM need a
          real value greater than 0 to enroll.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <LabeledInput label="GPU model" value={gpuModel} onChange={setGpuModel} placeholder="e.g. RTX 4090" required />
        <LabeledInput label="VRAM (GB)" type="number" min="1" value={vram} onChange={setVram} placeholder="e.g. 24" required />
        <LabeledInput label="CPU cores" type="number" min="1" value={cores} onChange={setCores} placeholder="e.g. 16" required />
        <LabeledInput label="RAM (GB)" type="number" min="1" value={ram} onChange={setRam} placeholder="e.g. 32" required />
      </div>
      <LabeledInput label="Price (₹/hr)" type="number" min="1" step="0.01" value={price} onChange={setPrice} placeholder="e.g. 43" required />
      {error && <div className="text-sm text-red-600">{error}</div>}
      <button disabled={busy}
        className="rounded bg-neutral-800 px-4 py-2 font-medium text-white hover:bg-neutral-900 disabled:opacity-50">
        {busy ? 'Enrolling…' : 'Enroll this machine'}
      </button>
    </form>
  )
}

function LabeledInput({ label, value, onChange, type = 'text', placeholder, required, min, step }) {
  return (
    <label className="text-sm">
      <span className="font-medium text-neutral-600">{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder} required={required} min={min} step={step}
        className="mt-1 w-full rounded border border-neutral-300 px-2 py-1" />
    </label>
  )
}
