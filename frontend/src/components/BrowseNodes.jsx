import { useEffect, useState } from 'react'
import { api } from '../api'

// The browse catalogue: everything rentable right now, without having to
// state requirements first. /search answers "what fits THIS job in THIS
// window"; this answers "what is on offer at all" -- the question a new
// user actually has before they know what to ask for.
//
// Every node listed here is genuinely bookable (GET /nodes applies the same
// online/not-retired bar /search does, plus a live availability window), so
// this never advertises something that would then refuse to book.

function formatWindow(ms) {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

function durationHours(start, end) {
  return Math.round(((end - start) / 3_600_000) * 10) / 10
}

export default function BrowseNodes({ onReserve, reservingId }) {
  const [nodes, setNodes] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  async function load() {
    setLoading(true); setError(null)
    try {
      const { nodes } = await api.listNodes()
      setNodes(nodes)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // Same fetch-on-mount shape (and the same linter exemption) as
    // ProviderDashboard -- see its own comment for why load()'s eventual
    // setState is the effect doing its job, not a cascading-render bug.
    // eslint-disable-next-line react/set-state-in-effect
    load()
  }, [])

  if (error) {
    return (
      <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
        Could not load the catalogue: {error}
        <button onClick={load} className="ml-2 font-medium underline">Retry</button>
      </div>
    )
  }

  if (nodes === null) {
    return <div className="p-6 text-center text-neutral-500">Loading available machines…</div>
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-neutral-800">
          Available machines{nodes.length > 0 && ` (${nodes.length})`}
        </h2>
        <button onClick={load} disabled={loading}
          className="rounded px-2 py-1 text-sm font-medium text-neutral-600 hover:bg-neutral-100 disabled:opacity-50">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {nodes.length === 0 ? (
        // Deliberately explains WHY rather than just saying "none" -- a node
        // being enrolled but unlisted is almost always one of these two
        // things, and not knowing which was a real source of confusion.
        <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-6 text-center text-neutral-500">
          No machines are available to rent right now.
          <div className="mt-1 text-sm">
            A machine is listed here once its provider is running the worker
            and has set an availability window for it.
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          {nodes.map((n) => (
            <div key={n.id} className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-semibold text-neutral-800">{n.gpu_model}</div>
                  <div className="mt-1 text-sm text-neutral-500">
                    {(n.gpu_vram_mb / 1024).toFixed(0)} GB VRAM · {n.cpu_cores} cores ·{' '}
                    {(n.ram_mb / 1024).toFixed(0)} GB RAM
                  </div>
                  <div className="mt-1 text-xs text-neutral-400">
                    reliability {(n.reliability * 100).toFixed(0)}%
                    {n.rep_jobs_total === 0
                      ? ' (no track record yet)'
                      : ` over ${n.rep_jobs_total} job${n.rep_jobs_total === 1 ? '' : 's'}`}
                  </div>
                </div>
                <div className="text-lg font-semibold text-neutral-800">
                  ₹{(n.price_paise_hr / 100).toFixed(2)}/hr
                </div>
              </div>

              <div className="mt-3 border-t border-neutral-100 pt-3">
                <div className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                  Available
                </div>
                <div className="mt-1.5 grid gap-1.5">
                  {n.availability.map((w) => (
                    <div key={`${w.start}-${w.end}`}
                      className="flex items-center justify-between text-sm">
                      <span className="text-neutral-600">
                        {formatWindow(w.start)} → {formatWindow(w.end)}
                        <span className="ml-1 text-neutral-400">
                          ({durationHours(w.start, w.end)}h)
                        </span>
                      </span>
                      <button
                        disabled={reservingId === n.id}
                        onClick={() => onReserve(n, w)}
                        className="rounded bg-neutral-800 px-3 py-1 text-sm font-medium text-white hover:bg-neutral-900 disabled:opacity-50">
                        {reservingId === n.id ? 'Reserving…' : 'Rent this window'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
