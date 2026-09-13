// Thin fetch wrapper for the NODEVA backend. No SDK, no generated client --
// the API surface is small enough that a hand-written wrapper stays more
// readable than the machinery to generate one.

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3100'

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `request failed with ${status}`)
    this.status = status
    this.body = body
  }
}

// The session token lives here, not scattered through call sites -- one
// place to read it, one place to clear it, one place a future refresh-token
// scheme would hook into.
let token = null
export function setToken(t) { token = t }

async function request(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...options.headers }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { ...options, headers })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, body)
  return body
}

export const api = {
  // --- auth --------------------------------------------------------
  signup: (email, password, display_name) =>
    request('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, display_name }) }),

  login: (email, password) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),

  // --- marketplace --------------------------------------------------------
  search: (requirements) =>
    request('/search', { method: 'POST', body: JSON.stringify(requirements) }),

  listNodes: () => request('/nodes'),

  // --- reservations --------------------------------------------------------
  // No user_id parameter: the backend derives the owner from the bearer
  // token, never from a client-supplied field (see server.js's ownership
  // checks -- that used to be a real authorization hole).
  reserve: (node_id, starts_at, ends_at) =>
    request('/reservations', {
      method: 'POST',
      body: JSON.stringify({ node_id, starts_at, ends_at }),
    }),

  confirmReservation: (reservationId) =>
    request(`/reservations/${reservationId}/confirm`, { method: 'POST' }),

  // --- jobs --------------------------------------------------------
  submitJob: (reservationId, { image, command, timeout_seconds }) =>
    request(`/reservations/${reservationId}/jobs`, {
      method: 'POST',
      body: JSON.stringify({ image, command, timeout_seconds }),
    }),

  getJob: (jobId) => request(`/jobs/${jobId}`),
}

export { ApiError }
