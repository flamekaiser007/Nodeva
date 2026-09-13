const VERIFICATION_REASON_LABEL = {
  new_provider: 'new provider',
  low_reliability: 'below-average reliability',
  high_value_job: 'higher-value booking',
}

// Renders scheduler.js's ranked output. `score` and `expected_cost_paise`
// are shown so the ranking is legible, not a black box -- a user should be
// able to see WHY the top result is the top result.
export default function ResultsList({ results, onReserve, reservingId }) {
  if (results === null) return null

  if (results.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-6 text-center text-neutral-500">
        No provider currently matches those requirements for that window.
        <div className="mt-1 text-sm">
          Try a wider budget, a different time window, or lower requirements.
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-3">
      {results.map((r, i) => (
        <div key={r.node.id}
          className="flex items-center justify-between rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-neutral-800">{r.node.gpu_model}</span>
              {i === 0 && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                  ⭐ top match
                </span>
              )}
            </div>
            <div className="mt-1 text-sm text-neutral-500">
              {(r.node.gpu_vram_mb / 1024).toFixed(0)} GB VRAM · {r.node.cpu_cores} cores ·{' '}
              {(r.node.ram_mb / 1024).toFixed(0)} GB RAM
            </div>
            <div className="mt-1 text-xs text-neutral-400">
              reliability {(r.node.reliability * 100).toFixed(0)}% · score {r.score.toFixed(2)} ·
              {' '}expected cost ₹{(r.expected_cost_paise / 100).toFixed(2)}
            </div>
            {r.verification_recommended && (
              <div className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700"
                title="This platform can run your job on two independent nodes and compare results -- ask for it when submitting a job.">
                🔍 verification suggested
                <span className="text-amber-500">
                  ({r.verification_reasons.map((x) => VERIFICATION_REASON_LABEL[x] ?? x).join(', ')})
                </span>
              </div>
            )}
          </div>
          <div className="text-right">
            <div className="text-lg font-semibold text-neutral-800">
              ₹{(r.node.price_paise_hr / 100).toFixed(2)}/hr
            </div>
            <div className="text-xs text-neutral-500 mb-2">
              quote: ₹{(r.quoted_paise / 100).toFixed(2)}
            </div>
            <button
              disabled={reservingId === r.node.id}
              onClick={() => onReserve(r)}
              className="rounded bg-neutral-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-900 disabled:opacity-50">
              {reservingId === r.node.id ? 'Reserving…' : 'Reserve'}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
