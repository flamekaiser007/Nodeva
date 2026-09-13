import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

const STEP_LABEL = {
  held: 'Held — awaiting payment',
  confirmed: 'Confirmed — ready to run a job',
  running: 'Job running',
  completed: 'Completed',
  failed_user: 'Failed (your workload)',
  failed_provider: 'Failed (provider) — refunded',
}

// Mirrors reservations/machine.js's lifecycle on the client, one reservation
// at a time. This is deliberately not a generic "orders list" -- the point
// is to make the lock-then-capture sequence from
// docs/reservation-protocol.md visible as something that actually happens
// in order, not an implementation detail hidden behind a spinner.
export default function ActiveReservation({ reservation, onSettled }) {
  const [status, setStatus] = useState(reservation.status)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [job, setJob] = useState(null)
  const [image, setImage] = useState('alpine:3.20')
  const [command, setCommand] = useState('echo hello from your reserved GPU node')
  const pollRef = useRef(null)

  useEffect(() => () => clearInterval(pollRef.current), [])

  async function confirm() {
    setBusy(true); setError(null)
    try {
      const r = await api.confirmReservation(reservation.reservation_id)
      setStatus(r.status)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function submitJob(e) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const { job_id } = await api.submitJob(reservation.reservation_id, {
        image, command: ['/bin/sh', '-c', command], timeout_seconds: 60,
      })
      setStatus('running')
      setJob({ job_id, status: 'running' })
      pollRef.current = setInterval(async () => {
        try {
          const j = await api.getJob(job_id)
          setJob(j)
          if (j.status !== 'running' && j.status !== 'queued' && j.status !== 'starting') {
            clearInterval(pollRef.current)
            // The reservation settles server-side as soon as JOB_RESULT
            // arrives, which can beat this poll tick or lag slightly behind
            // it; a short delay avoids showing a stale 'running' reservation
            // status next to an already-terminal job status.
            setTimeout(() => onSettled?.(reservation.reservation_id), 500)
          }
        } catch { /* transient poll failure, try again next tick */ }
      }, 1000)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold text-neutral-800">Reservation</h3>
        <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-700">
          {STEP_LABEL[status] ?? status}
        </span>
      </div>

      <dl className="mb-4 grid grid-cols-2 gap-y-1 text-sm text-neutral-600">
        <dt>Reservation ID</dt><dd className="font-mono text-xs">{reservation.reservation_id}</dd>
        <dt>Quoted price</dt><dd>₹{(reservation.quoted_paise / 100).toFixed(2)}</dd>
      </dl>

      {error && <div className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {status === 'held' && (
        <button onClick={confirm} disabled={busy}
          className="rounded bg-emerald-700 px-4 py-2 font-medium text-white hover:bg-emerald-800 disabled:opacity-50">
          {busy ? 'Confirming…' : `Confirm & Pay ₹${(reservation.quoted_paise / 100).toFixed(2)}`}
        </button>
      )}

      {status === 'confirmed' && (
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
          <button disabled={busy}
            className="mt-1 rounded bg-neutral-800 px-4 py-2 font-medium text-white hover:bg-neutral-900 disabled:opacity-50">
            {busy ? 'Submitting…' : 'Submit Job'}
          </button>
        </form>
      )}

      {job && (
        <div className="mt-4 rounded border border-neutral-200 bg-neutral-50 p-3 text-sm">
          <div className="mb-1 font-medium text-neutral-700">
            Job {job.job_id?.slice(0, 8)} — {job.status}
          </div>
          {job.stdout !== undefined && job.status !== 'running' && (
            <pre className="mt-2 max-h-40 overflow-auto rounded bg-neutral-900 p-2 text-xs text-neutral-100">
{job.stdout || '(no output)'}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
