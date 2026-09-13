import { useState } from 'react'
import { api } from '../api'

// Dev-only stand-in for real sign-in. Backed by POST /dev/users, which the
// backend marks explicitly as not-for-production (see server.js). A real
// build replaces this component with actual signup/login; nothing else in
// this app should need to change when that happens, since everything else
// only depends on having a `userId`.
export default function UserBar({ user, onUser }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function createUser(e) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const { user_id } = await api.createDevUser(email, name)
      const u = { id: user_id, email, name }
      localStorage.setItem('nodeva_dev_user', JSON.stringify(u))
      onUser(u)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (user) {
    return (
      <div className="flex items-center justify-between border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm">
        <span>
          Signed in as <strong>{user.name}</strong> ({user.email})
          <span className="ml-2 rounded bg-amber-200 px-1.5 py-0.5 text-xs font-medium text-amber-900">
            dev mode — not real auth
          </span>
        </span>
        <button
          className="text-xs text-neutral-500 underline hover:text-neutral-800"
          onClick={() => { localStorage.removeItem('nodeva_dev_user'); onUser(null) }}
        >
          sign out
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={createUser} className="flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-4 py-3 text-sm">
      <span className="font-medium text-neutral-600">Dev sign-in:</span>
      <input required type="email" placeholder="email" value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="rounded border border-neutral-300 px-2 py-1" />
      <input required placeholder="display name" value={name}
        onChange={(e) => setName(e.target.value)}
        className="rounded border border-neutral-300 px-2 py-1" />
      <button disabled={busy} className="rounded bg-neutral-800 px-3 py-1 text-white disabled:opacity-50">
        {busy ? 'creating…' : 'Continue'}
      </button>
      {error && <span className="text-red-600">{error}</span>}
    </form>
  )
}
