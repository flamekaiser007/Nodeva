import { useState } from 'react'
import { api, ApiError, setToken } from './api'
import UserBar from './components/UserBar'
import SearchForm from './components/SearchForm'
import ResultsList from './components/ResultsList'
import ActiveReservation from './components/ActiveReservation'
import VerifiedPairReservation from './components/VerifiedPairReservation'
import ProviderDashboard from './components/ProviderDashboard'
import ResetPassword from './components/ResetPassword'

const STORAGE_KEY = 'nodeva_session' // { token, user }

// No client-side router in this app -- one extra path is not worth pulling
// one in. The backend builds reset links as `${frontendUrl}/reset-password
// ?token=...` (see server.js), so this is the one other "page" the app
// needs to recognize, checked once at load.
const RESET_PASSWORD_PATH = '/reset-password'

export default function App() {
  const [session, setSession] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY))
      if (saved?.token) setToken(saved.token) // module-level api.js state, not React state
      return saved
    } catch { return null }
  })
  const [resetToken] = useState(() =>
    window.location.pathname === RESET_PASSWORD_PATH
      ? new URLSearchParams(window.location.search).get('token')
      : undefined) // undefined = not on the reset-password path at all; null/string = on it, with or without a token
  // One account, two roles (master design: "a user can potentially also
  // become a provider") -- this is a view toggle, not a different login.
  const [mode, setMode] = useState('rent') // 'rent' | 'share'
  const [lastQuery, setLastQuery] = useState(null)
  const [results, setResults] = useState(null)
  const [searching, setSearching] = useState(false)
  const [reservingId, setReservingId] = useState(null)
  const [reservation, setReservation] = useState(null)
  // A candidate awaiting a verification partner pick (docs/security-model.md's
  // Direction 2) -- set while ResultsList is in "choose a second node"
  // mode, null the rest of the time. Once a partner is picked, this
  // resolves into `verifiedPair` below rather than `reservation`, since a
  // verified booking is genuinely two reservations, not one.
  const [verifyPrimary, setVerifyPrimary] = useState(null)
  const [verifiedPair, setVerifiedPair] = useState(null)
  const [error, setError] = useState(null)

  // Short-circuits the whole normal app -- someone landing here clicked a
  // password-reset link and is not expected to be signed in or mid-booking.
  // Placed after every hook above so the branch it skips never has a hook
  // of its own to worry about ordering with.
  if (resetToken !== undefined) {
    return (
      <div className="min-h-screen bg-neutral-100 p-4">
        <ResetPassword token={resetToken} onDone={() => { window.location.href = '/' }} />
      </div>
    )
  }

  function handleAuth(token, user) {
    setToken(token)
    if (token) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ token, user }))
      setSession({ token, user })
    } else {
      localStorage.removeItem(STORAGE_KEY)
      setSession(null)
      setReservation(null) // a signed-out session should not keep showing someone else's booking
      setVerifiedPair(null)
      setVerifyPrimary(null)
    }
  }

  async function handleSearch(req) {
    setSearching(true); setError(null); setResults(null)
    setLastQuery(req)
    setVerifyPrimary(null) // a fresh search invalidates whatever candidate was mid-pick
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

  // Enters "pick a verification partner" mode -- ResultsList itself
  // decides how that's presented, this just records which candidate needs
  // one. Nothing is reserved yet: a hold ticking down while the user is
  // still choosing a partner would waste it for no reason.
  function handleStartVerification(candidate) {
    setError(null)
    setVerifyPrimary(candidate)
  }

  function handleCancelVerification() {
    setVerifyPrimary(null)
  }

  // Books BOTH nodes for the same window once a partner is chosen --
  // verify_against_reservation_id (used once the job is submitted, see
  // VerifiedPairReservation) requires two reservations that already exist,
  // not one reservation plus a promise to add a second later.
  async function handlePickPartner(partnerCandidate) {
    if (!session) { setError('sign in first'); return }
    const primaryCandidate = verifyPrimary
    setError(null)
    try {
      setReservingId(primaryCandidate.node.id)
      const resA = await api.reserve(primaryCandidate.node.id, lastQuery.starts_at, lastQuery.ends_at)
      setReservingId(partnerCandidate.node.id)
      const resB = await api.reserve(partnerCandidate.node.id, lastQuery.starts_at, lastQuery.ends_at)
      setVerifiedPair({
        a: { ...resA, node_id: primaryCandidate.node.id, node_model: primaryCandidate.node.gpu_model },
        b: { ...resB, node_id: partnerCandidate.node.id, node_model: partnerCandidate.node.gpu_model },
      })
      setVerifyPrimary(null)
    } catch (e) {
      // If the primary reservation succeeded but the partner failed, the
      // primary is left as an orphaned 'held' row -- there is no
      // client-facing release endpoint for an unconfirmed hold, so it
      // simply expires on its own via the node's hold TTL, the same as any
      // other abandoned held reservation in this app.
      if (e instanceof ApiError && e.status === 401) {
        handleAuth(null, null)
        setError('Your session expired. Please sign in again.')
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
        ) : verifiedPair ? (
          <VerifiedPairReservation
            pair={verifiedPair}
            onSettled={() => { setVerifiedPair(null); handleSearch(lastQuery) }}
          />
        ) : reservation ? (
          <ActiveReservation
            reservation={reservation}
            onSettled={() => { setReservation(null); handleSearch(lastQuery) }}
          />
        ) : (
          <>
            <SearchForm onSearch={handleSearch} busy={searching} />
            <ResultsList
              results={results} onReserve={handleReserve} reservingId={reservingId}
              verifyPrimary={verifyPrimary}
              onStartVerification={handleStartVerification}
              onPickPartner={handlePickPartner}
              onCancelVerification={handleCancelVerification}
            />
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
