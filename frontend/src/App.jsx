import { useState } from 'react'
import { api, ApiError, setToken } from './api'
import UserBar from './components/UserBar'
import SearchForm from './components/SearchForm'
import ResultsList from './components/ResultsList'
import ActiveReservation from './components/ActiveReservation'
import ProviderDashboard from './components/ProviderDashboard'

const STORAGE_KEY = 'nodeva_session' // { token, user }

export default function App() {
  const [session, setSession] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY))
      if (saved?.token) setToken(saved.token) // module-level api.js state, not React state
      return saved
    } catch { return null }
  })
  // One account, two roles (master design: "a user can potentially also
  // become a provider") -- this is a view toggle, not a different login.
  const [mode, setMode] = useState('rent') // 'rent' | 'share'
  const [lastQuery, setLastQuery] = useState(null)
  const [results, setResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const [reservingId, setReservingId] = useState(null)
  const [reservation, setReservation] = useState(null)
  const [error, setError] = useState(null)

  function handleAuth(token, user) {
    setToken(token)
    if (token) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, user }))
      setSession({ token, user })
    } else {
      localStorage.removeItem(STORAGE_KEY)
      setSession(null)
      setReservation(null) // a signed-out session should not keep showing someone else's booking
    }
  }

  async function handleSearch(req) {
    setSearching(true); setError(null); setResults(null)
    setLastQuery(req)
    try {
      const { results } = await api.search(req)
      setResults(results)
    } catch (e) {
      setError(e.message)
    } finally {
      setSearching(false)
    }
  }

  async function handleReserve(candidate) {
    if (!session) { setError('sign in first'); return }
    setReservingId(candidate.node.id); setError(null)
    try {
      const r = await api.reserve(candidate.node.id, lastQuery.starts_at, lastQuery.ends_at)
      setReservation(r)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // The token expired or was never valid for this request -- send the
        // user back to sign-in rather than showing a cryptic error over a
        // search form they can't act on anyway.
        handleAuth(null, null)
        setError('Your session expired. Please sign in again.')
      } else if (e instanceof ApiError && e.status === 409) {
        // Auto-refreshing the search here previously wiped this exact
        // message: handleSearch's own setError(null) ran before the user
        // could read it, so the error flashed and vanished instantly.
        // Show it and let the user re-search deliberately instead.
        setError(`That node just became unavailable (${e.body?.error}). Search again to see current availability.`)
      } else {
        setError(e.message)
      }
    } finally {
      setReservingId(null)
    }
  }

  return (
    <div className="min-h-screen bg-neutral-100">
      <header className="border-b border-neutral-200 bg-white px-4 py-3">
        <h1 className="text-xl font-bold text-neutral-800">NODEVA</h1>
        <p className="text-sm text-neutral-500">
          A compute marketplace for underutilized GPUs — identity and payments
          centralized, compute distributed across independent nodes.
        </p>
      </header>

      <UserBar user={session?.user} onAuth={handleAuth} />

      {session && (
        <div className="mx-auto flex max-w-3xl gap-2 px-4 pt-4">
          <ModeTab active={mode === 'rent'} onClick={() => setMode('rent')}>Rent GPU</ModeTab>
          <ModeTab active={mode === 'share'} onClick={() => setMode('share')}>Share GPU</ModeTab>
        </div>
      )}

      <main className="mx-auto max-w-3xl space-y-6 p-4">
        {error && (
          <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        {mode === 'share' && session ? (
          <ProviderDashboard />
        ) : reservation ? (
          <ActiveReservation
            reservation={reservation}
            onSettled={() => { setReservation(null); handleSearch(lastQuery) }}
          />
        ) : (
          <>
            <SearchForm onSearch={handleSearch} busy={searching} />
            <ResultsList results={results} onReserve={handleReserve} reservingId={reservingId} />
          </>
        )}
      </main>
    </div>
  )
}

function ModeTab({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      className={`rounded-t-lg px-4 py-2 text-sm font-medium ${
        active ? 'bg-white text-neutral-800' : 'bg-neutral-200 text-neutral-500 hover:text-neutral-700'
      }`}>
      {children}
    </button>
  )
}
