import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { confirmAndPay, RAZORPAY_HANDLED } from '../lib/confirmPayment'
import DisputeResolution from './DisputeResolution'

const STEP_LABEL = {
  held: 'Held — awaiting payment',
  confirmed: 'Confirmed',
  running: 'Job running',
  completed: 'Completed',
  failed_user: 'Failed (workload)',
  failed_provider: 'Failed (provider) — refunded',
  disputed: 'Disputed — refunded in full',
}

// The UI half of duplicate-execution verification (docs/security-model.md's
// Direction 2): TWO reservations booked together against different nodes
// (see ResultsList's "Verify with another node" flow), confirmed
// independently, then a single job submitted with
// verify_against_reservation_id so the backend runs it on both and compares
// results. Deliberately two separate "Confirm & Pay" steps rather than one
// combined button -- a user is genuinely paying twice for the extra
// assurance, and collapsing that into one click would misrepresent the
// cost they're accepting.
export default function VerifiedPairReservation({ pair, onSettled }) {
  const [a, setA] = useState(pair.a)
  const [b, setB] = useState(pair.b)
  const [busyA, setBusyA] = useState(false)
  const [busyB, setBusyB] = useState(false)
  const [errorA, setErrorA] = useState(null)
  const [errorB, setErrorB] = useState(null)

  const [image, setImage] = useState('alpine:3.20')
  const [command, setCommand] = useState('echo hello from your verified GPU nodes')
  const [submitBusy, setSubmitBusy] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [job, setJob] = useState(null)
  const [finalA, setFinalA] = useState(null) // authoritative reservation status once settled
  const [finalB, setFinalB] = useState(null)
  const [hydrating, setHydrating] = useState(true)
  const pollRef = useRef(null)

  useEffect(() => () => clearInterval(pollRef.current), [])

  // `pair` is a snapshot from the moment both reservations were booked. If
  // this component unmounts and remounts -- switching to "Share GPU" and
  // back does exactly that, since App only renders one of the two --
  // useState(pair.a) would silently re-seed from that stale snapshot,
  // showing "held" again for a reservation the backend already moved past.
  // Caught live: confirming both reservations, then tabbing to Share GPU
  // and back, showed both as unconfirmed again even though the backend had
  // long since captured payment for both. Re-fetch the authoritative
  // status on every mount instead of trusting the prop.
  //
  // KNOWN GAP: if a job was already submitted in an earlier mount, its
  // job_id is not recoverable here (nothing persists it outside this
  // component's own state) -- the job-progress view below cannot resume,
  // it can only report that a reservation moved past 'confirmed' without
  // being able to show what ran. See the `job === null && !bothConfirmed`
  // branch's rendering below for how that's surfaced honestly rather than
  // silently re-showing a submission form that would just fail.
  useEffect(() => {
    let cancelled = false
    Promise.all([
      api.getReservation(pair.a.reservation_id),
      api.getReservation(pair.b.reservation_id),
    ]).then(([ra, rb]) => {
      if (cancelled) return
      setA((r) => ({ ...r, status: ra.status }))
      setB((r) => ({ ...r, status: rb.status }))
    }).catch(() => { /* transient -- keep the snapshot, real actions below will surface real errors */ })
      .finally(() => { if (!cancelled) setHydrating(false) })
    return () => { cancelled = true }
  }, [pair.a.reservation_id, pair.b.reservation_id])

  async function confirmOne(which) {
    const res = which === 'a' ? a : b
    const setBusy = which === 'a' ? setBusyA : setBusyB
    const setErr = which === 'a' ? setErrorA : setErrorB
    const setRes = which === 'a' ? setA : setB
    setBusy(true); setErr(null)
    try {
      const status = await confirmAndPay(res.reservation_id, {
        description: `Verification node ${which.toUpperCase()} (${res.node_model})`,
        onError: setErr,
      })
      setRes((r) => ({ ...r, status }))
    } catch (e) {
      if (e.message !== RAZORPAY_HANDLED) setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function submitJob(e) {
    e.preventDefault()
    setSubmitBusy(true); setSubmitError(null)
    try {
      const { job_id } = await api.submitJob(a.reservation_id, {
        image, command: ['/bin/sh', '-c', command], timeout_seconds: 60,
        verify_against_reservation_id: b.reservation_id,
      })
      setA((r) => ({ ...r, status: 'running' }))
      setB((r) => ({ ...r, status: 'running' }))
      setJob({ job_id, status: 'running' })
      pollRef.current = setInterval(async () => {
        try {
          const j = await api.getJob(job_id)
          setJob(j)
          const jobDone = !['running', 'queued', 'starting'].includes(j.status)
          if (!jobDone) return
          // A job's own status is one node's individual outcome, not the
          // RESERVATION's -- a mismatch settles both reservations as
          // 'disputed' even though each job may separately report
          // 'succeeded'. The authoritative answer is the reservation
          // itself; settleVerificationGroup runs asynchronously and may
          // not have finished for both sides the instant this poll tick
          // sees the job as terminal, so keep polling both reservations
          // until neither is still 'running'.
          const [ra, rb] = await Promise.all([
            api.getReservation(a.reservation_id), api.getReservation(b.reservation_id),
          ])
          if (ra.status === 'running' || rb.status === 'running') return
          clearInterval(pollRef.current)
          setFinalA(ra.status); setFinalB(rb.status)
          setA((r) => ({ ...r, status: ra.status }))
          setB((r) => ({ ...r, status: rb.status }))
          if (ra.status !== 'disputed') setTimeout(() => onSettled?.(), 500)
        } catch { /* transient poll failure, try again next tick */ }
      }, 1000)
    } catch (e) {
      setSubmitError(e.message)
    } finally {
      setSubmitBusy(false)
    }
  }

  const bothConfirmed = a.status === 'confirmed' && b.status === 'confirmed'
  const disputed = finalA === 'disputed' && finalB === 'disputed'
  // True after hydration shows a reservation moved past 'confirmed' (a job
  // ran, in a PREVIOUS mount of this component) but this mount has no
  // `job` object to show progress for -- the job_id was never persisted
  // anywhere outside this component's own state. Rather than silently
  // re-showing the submission form (which would just fail: the backend
  // already has a job on this reservation) or the generic "confirm both"
  // message (misleading -- they're well past that), say so plainly.
  const jobUnrecoverable = !hydrating && !job && !['held', 'confirmed'].includes(a.status)

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
      <h3 className="mb-3 font-semibold text-neutral-800">Verified Reservation (2 nodes)</h3>

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <NodeCard label="Node A" res={a} busy={busyA} error={errorA} onConfirm={() => confirmOne('a')} />
        <NodeCard label="Node B" res={b} busy={busyB} error={errorB} onConfirm={() => confirmOne('b')} />
      </div>

      {hydrating && (
        <p className="text-sm text-neutral-500">Checking the current status of both reservations…</p>
      )}

      {!hydrating && !bothConfirmed && !job && !jobUnrecoverable && (
        <p className="text-sm text-neutral-500">
          Confirm &amp; pay for both reservations above, then submit one job to run on both.
        </p>
      )}

      {jobUnrecoverable && (
        <div className="rounded border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-600">
          A job already ran against these reservations (status: {STEP_LABEL[a.status] ?? a.status} /{' '}
          {STEP_LABEL[b.status] ?? b.status}) — this view can't resume showing its progress or, if it was
          disputed, offer a tiebreaker, since the job wasn't tracked outside this page. Search again to
          book a new job.
        </div>
      )}

      {bothConfirmed && !job && (
        <form onSubmit={submitJob} className="grid gap-2">
          <label className="text-sm">
            <span className="font-medium text-neutral-600">Docker image</span>
            <input value={image} onChange={(e) => setImage(e.target.value)}
              className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 font-mono text-sm" />
          </label>
          <label className="text-sm">
            <span className="font-medium text-neutral-600">Command (shell)</span>
            <input value={command} onChange={(e) => setCommand(e.target.value)}
              className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 font-mono text-sm" />
          </label>
          {submitError && <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{submitError}</div>}
          <button disabled={submitBusy}
            className="mt-1 rounded bg-neutral-800 px-4 py-2 font-medium text-white hover:bg-neutral-900 disabled:opacity-50">
            {submitBusy ? 'Submitting…' : 'Submit Job to Both Nodes'}
          </button>
        </form>
      )}

      {job && (
        <div className="mt-4 rounded border border-neutral-200 bg-neutral-50 p-3 text-sm">
          <div className="mb-1 font-medium text-neutral-700">
            Job {job.job_id?.slice(0, 8)} — {job.status}
          </div>
          {!finalA && <div className="text-neutral-500">Waiting for both nodes to finish and settle…</div>}
          {finalA && !disputed && (
            <div className="text-neutral-600">
              Node A: {STEP_LABEL[finalA] ?? finalA} · Node B: {STEP_LABEL[finalB] ?? finalB}
            </div>
          )}
          {job.stdout !== undefined && job.status !== 'running' && (
            <pre className="mt-2 max-h-40 overflow-auto rounded bg-neutral-900 p-2 text-xs text-neutral-100">
{job.stdout || '(no output)'}
            </pre>
          )}
        </div>
      )}

      {disputed && (
        <DisputeResolution groupId={job.verification_group_id} excludeNodeIds={[a.node_id, b.node_id]} />
      )}
    </div>
  )
}

function NodeCard({ label, res, busy, error, onConfirm }) {
  return (
    <div className="rounded border border-neutral-200 p-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-medium text-neutral-700">{label}: {res.node_model}</span>
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
          {STEP_LABEL[res.status] ?? res.status}
        </span>
      </div>
      <div className="mb-2 text-xs text-neutral-500">₹{(res.quoted_paise / 100).toFixed(2)}</div>
      {error && <div className="mb-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{error}</div>}
      {res.status === 'held' && (
        <button onClick={onConfirm} disabled={busy}
          className="w-full rounded bg-emerald-700 px-2 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50">
          {busy ? 'Confirming…' : 'Confirm & Pay'}
        </button>
      )}
    </div>
  )
}
