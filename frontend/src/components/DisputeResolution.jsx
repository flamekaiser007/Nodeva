import { useEffect, useState } from 'react'
import { api } from '../api'
import SearchForm from './SearchForm'
import { confirmAndPay, RAZORPAY_HANDLED } from '../lib/confirmPayment'

const VERDICT_LABEL = {
  attributed: 'Fault attributed',
  inconclusive: 'Inconclusive',
}

// docs/security-model.md's Direction 2, taken one step further than a plain
// 2-node mismatch can go: that only proves at least one node is wrong,
// never which. This lets the user book a THIRD, independent node, re-run
// the exact same disputed job, and majority-vote the result -- see
// jobs/verification.js's attributeFaultFromTiebreaker. The backend reuses
// the ORIGINAL job's image/command itself (not whatever this form might
// submit) specifically so "identical workload" is enforced server-side,
// not trusted from the client.
//
// Reputation-only, always: the dispute's full refund to both sides already
// happened and is never revisited here, no matter what this tiebreaker
// finds -- see api/server.js's resolveDisputeTiebreaker.
export default function DisputeResolution({ groupId, excludeNodeIds = [] }) {
  const [resolution, setResolution] = useState(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    let cancelled = false
    api.getDisputeResolution(groupId)
      .then((r) => { if (!cancelled) setResolution(r) })
      .catch(() => { /* not resolved yet -- expected the first time */ })
      .finally(() => { if (!cancelled) setChecking(false) })
    return () => { cancelled = true }
  }, [groupId])

  return (
    <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4">
      <div className="mb-2 font-semibold text-red-800">Dispute — results did not match</div>
      <p className="mb-3 text-sm text-red-700">
        The two nodes reported different results. Both bookings were refunded in full
        already — that is final and will not change below. What a third node CAN do is
        tell you which of the two nodes to trust going forward.
      </p>

      {checking ? (
        <div className="text-sm text-neutral-500">Checking for an existing resolution…</div>
      ) : resolution ? (
        <ResolutionSummary resolution={resolution} />
      ) : (
        <TiebreakerFlow groupId={groupId} excludeNodeIds={excludeNodeIds} onResolved={setResolution} />
      )}
    </div>
  )
}

function ResolutionSummary({ resolution }) {
  return (
    <div className="rounded border border-neutral-200 bg-white p-3 text-sm">
      <div className="font-medium text-neutral-800">
        {VERDICT_LABEL[resolution.verdict] ?? resolution.verdict}
      </div>
      {resolution.verdict === 'attributed' ? (
        <p className="mt-1 text-neutral-600">
          Reservation{' '}
          <span className="font-mono text-xs">{resolution.vindicated_reservation_id.slice(0, 8)}</span>{' '}
          was vindicated. Reservation{' '}
          <span className="font-mono text-xs">{resolution.at_fault_reservation_id.slice(0, 8)}</span>{' '}
          was found at fault, and its provider's reputation now reflects that.
        </p>
      ) : (
        <p className="mt-1 text-neutral-600">
          The tiebreaker disagreed with both original nodes too — fault still cannot be
          attributed to either one.
        </p>
      )}
    </div>
  )
}

function TiebreakerFlow({ groupId, excludeNodeIds, onResolved }) {
  const [lastQuery, setLastQuery] = useState(null)
  const [results, setResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const [reservingId, setReservingId] = useState(null)
  const [tiebreaker, setTiebreaker] = useState(null) // { reservation_id, status }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [polling, setPolling] = useState(false)

  async function handleSearch(req) {
    setSearching(true); setError(null); setLastQuery(req)
    try {
      const { results } = await api.search(req)
      setResults(results.filter((r) => !excludeNodeIds.includes(r.node.id)))
    } catch (e) { setError(e.message) } finally { setSearching(false) }
  }

  async function handleReserve(candidate) {
    setReservingId(candidate.node.id); setError(null)
    try {
      const r = await api.reserve(candidate.node.id, lastQuery.starts_at, lastQuery.ends_at)
      setTiebreaker({ reservation_id: r.reservation_id, status: r.status })
    } catch (e) {
      setError(e.message)
    } finally {
      setReservingId(null)
    }
  }

  async function handleConfirm() {
    setBusy(true); setError(null)
    try {
      const status = await confirmAndPay(tiebreaker.reservation_id, {
        description: 'Dispute tiebreaker reservation', onError: setError,
      })
      setTiebreaker((t) => ({ ...t, status }))
    } catch (e) {
      if (e.message !== RAZORPAY_HANDLED) setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function handleSubmitTiebreak() {
    setBusy(true); setError(null)
    try {
      await api.submitTiebreaker(groupId, tiebreaker.reservation_id)
      setPolling(true)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!polling) return
    const id = setInterval(async () => {
      try {
        const r = await api.getDisputeResolution(groupId)
        clearInterval(id);
        setPolling(false)
        onResolved(r)
      } catch { /* not resolved yet, the tiebreaker job is still running */ }
    }, 1500)
    return () => clearInterval(id)
  }, [polling, groupId, onResolved])

  if (polling) {
    return (
      <div className="text-sm text-neutral-600">
        Waiting for the tiebreaker job to finish and the vote to resolve…
      </div>
    )
  }

  const errorBanner = error && (
    <div className="mb-2 rounded bg-red-100 px-2 py-1 text-xs text-red-700">{error}</div>
  )

  if (tiebreaker?.status === 'confirmed') {
    return (
      <div className="rounded border border-neutral-200 bg-white p-3 text-sm">
        <p className="mb-2 text-neutral-600">
          Tiebreaker node confirmed. Run the disputed job on it to resolve the vote.
        </p>
        {errorBanner}
        <button disabled={busy} onClick={handleSubmitTiebreak}
          className="rounded bg-amber-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800 disabled:opacity-50">
          {busy ? 'Submitting…' : 'Run tiebreaker job'}
        </button>
      </div>
    )
  }

  if (tiebreaker) {
    return (
      <div className="rounded border border-neutral-200 bg-white p-3 text-sm">
        <p className="mb-2 text-neutral-600">Tiebreaker reservation booked, awaiting payment.</p>
        {errorBanner}
        <button disabled={busy} onClick={handleConfirm}
          className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50">
          {busy ? 'Confirming…' : 'Confirm & Pay'}
        </button>
      </div>
    )
  }

  return (
    <div>
      <p className="mb-2 text-sm font-medium text-neutral-700">
        Find a third, independent node to settle the vote. It must be different from both
        nodes already involved in the dispute.
      </p>
      {errorBanner}
      <SearchForm onSearch={handleSearch} busy={searching} />
      {results && (
        <div className="mt-3 grid gap-2">
          {results.length === 0 && (
            <p className="text-sm text-neutral-500">No other independent nodes match those requirements.</p>
          )}
          {results.map((r) => (
            <div key={r.node.id}
              className="flex items-center justify-between rounded border border-neutral-200 bg-white p-2 text-sm">
              <span>{r.node.gpu_model} — ₹{(r.quoted_paise / 100).toFixed(2)}</span>
              <button disabled={reservingId === r.node.id} onClick={() => handleReserve(r)}
                className="rounded bg-amber-700 px-2 py-1 text-xs font-medium text-white hover:bg-amber-800 disabled:opacity-50">
                {reservingId === r.node.id ? 'Reserving…' : 'Use this node'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
