import { useState } from 'react'
import { api } from '../api'

// Real signup/login against POST /auth/signup and /auth/login -- bcrypt
// hashing and JWT issuance happen server-side; this component only ever
// sees the token back, never touches a password hash.
export default function UserBar({ user, onAuth }) {
  const [mode, setMode] = useState('login') // 'login' | 'signup'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const result = mode === 'signup'
        ? await api.signup(email, password, name)
        : await api.login(email, password)
      onAuth(result.token, result.user)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (user) {
    return (
      <div className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-2 text-sm">
        <span>
          Signed in as <strong>{user.display_name}</strong> ({user.email})
        </span>
        <button
          className="text-xs text-neutral-500 underline hover:text-neutral-800"
          onClick={() => onAuth(null, null)}
        >
          sign out
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-4 py-3 text-sm">
      <div className="mr-2 flex overflow-hidden rounded border border-neutral-300">
        <button type="button" onClick={() => setMode('login')}
          className={`px-2 py-1 ${mode === 'login' ? 'bg-neutral-800 text-white' : 'bg-white text-neutral-600'}`}>
          Log in
        </button>
        <button type="button" onClick={() => setMode('signup')}
          className={`px-2 py-1 ${mode === 'signup' ? 'bg-neutral-800 text-white' : 'bg-white text-neutral-600'}`}>
          Sign up
        </button>
      </div>
      <input required type="email" placeholder="email" value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="rounded border border-neutral-300 px-2 py-1" />
      {mode === 'signup' && (
        <input required placeholder="display name" value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded border border-neutral-300 px-2 py-1" />
      )}
      <input required type="password" placeholder="password" value={password}
        minLength={mode === 'signup' ? 8 : undefined}
        onChange={(e) => setPassword(e.target.value)}
        className="rounded border border-neutral-300 px-2 py-1" />
      <button disabled={busy} className="rounded bg-neutral-800 px-3 py-1 text-white disabled:opacity-50">
        {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Log in'}
      </button>
      {error && <span className="text-red-600">{error}</span>}
    </form>
  )
}
