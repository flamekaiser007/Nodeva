import { useState } from 'react'
import { api } from '../api'

// Rendered when the URL is /reset-password?token=... -- the link the
// backend puts in the email it sends (or logs, if no SMTP is configured;
// see backend/src/auth/email.js). The token itself is opaque to this
// component; it only ever gets handed straight back to POST
// /auth/reset-password, never inspected or decoded client-side.
export default function ResetPassword({ token, onDone }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError(null)
    if (password !== confirm) { setError("Passwords don't match."); return }
    setBusy(true)
    try {
      await api.resetPassword(token, password)
      setDone(true)
    } catch (err) {
      // The backend deliberately returns one generic error for "no such
      // token", "already used", and "expired" -- see server.js -- so this
      // component has nothing more specific to say either.
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (!token) {
    return (
      <div className="mx-auto max-w-sm rounded-lg border border-neutral-200 bg-white p-6 text-center text-neutral-600">
        This reset link is missing its token. Check the link from your email, or request a new one.
      </div>
    )
  }

  if (done) {
    return (
      <div className="mx-auto max-w-sm rounded-lg border border-neutral-200 bg-white p-6 text-center">
        <p className="mb-4 text-neutral-700">Password updated. You can log in with it now.</p>
        <button onClick={onDone}
          className="rounded bg-neutral-800 px-4 py-2 font-medium text-white hover:bg-neutral-900">
          Go to log in
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-sm rounded-lg border border-neutral-200 bg-white p-6">
      <h2 className="mb-4 text-lg font-semibold text-neutral-800">Set a new password</h2>
      <label className="mb-3 block text-sm">
        <span className="font-medium text-neutral-600">New password</span>
        <input required type="password" minLength={8} value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded border border-neutral-300 px-2 py-1" />
      </label>
      <label className="mb-4 block text-sm">
        <span className="font-medium text-neutral-600">Confirm password</span>
        <input required type="password" minLength={8} value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="mt-1 w-full rounded border border-neutral-300 px-2 py-1" />
      </label>
      {error && <div className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <button disabled={busy}
        className="w-full rounded bg-emerald-700 px-4 py-2 font-medium text-white hover:bg-emerald-800 disabled:opacity-50">
        {busy ? 'Updating…' : 'Update password'}
      </button>
    </form>
  )
}
