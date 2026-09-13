import { useState } from 'react'
import { api, ApiError } from './api'
import UserBar from './components/UserBar'
import SearchForm from './components/SearchForm'
import ResultsList from './components/ResultsList'
import ActiveReservation from './components/ActiveReservation'

export default function App() {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('nodeva_dev_user')) } catch { return null }
  })
  const [lastQuery, setLastQuery] = useState(null)
  const [results, setResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const [reservingId, setReservingId] = useState(null)
  const [reservation, setReservation] = useState(null)
  const [error, setError] = useState(null)

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
    if (!user) { setError('sign in first'); return }
    setReservingId(candidate.node.id); setError(null)
    try {
      const r = await api.reserve(candidate.node.id, user.id, lastQuery.starts_at, lastQuery.ends_at)
      setReservation(r)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
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

      <UserBar user={user} onUser={setUser} />

      <main className="mx-auto max-w-3xl space-y-6 p-4">
        {error && (
          <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}

        {reservation ? (
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
