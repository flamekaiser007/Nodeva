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

  // Always resolves with the same generic message whether the email exists
  // or not -- the backend deliberately never reveals which, see server.js.
  forgotPassword: (email) =>
    request('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),

  resetPassword: (token, new_password) =>
    request('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, new_password }) }),

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

  // Returns either {status:'confirmed', ...} directly (no live gateway
  // configured on the backend) or {requires_payment:true, order_id,
  // amount_paise, currency, razorpay_key_id} (a live gateway IS configured
  // -- the caller must run Checkout.js and then call verifyPayment).
  confirmReservation: (reservationId) =>
    request(`/reservations/${reservationId}/confirm`, { method: 'POST' }),

  verifyPayment: (reservationId, { razorpay_order_id, razorpay_payment_id, razorpay_signature }) =>
    request(`/reservations/${reservationId}/confirm/verify`, {
      method: 'POST',
      body: JSON.stringify({ razorpay_order_id, razorpay_payment_id, razorpay_signature }),
    }),

  // --- jobs --------------------------------------------------------
  submitJob: (reservationId, { image, command, timeout_seconds }) =>
    request(`/reservations/${reservationId}/jobs`, {
      method: 'POST',
      body: JSON.stringify({ image, command, timeout_seconds }),
    }),

  getJob: (jobId) => request(`/jobs/${jobId}`),

  // --- provider --------------------------------------------------------
  becomeProvider: () => request('/providers/me', { method: 'POST' }),

  providerDashboard: () => request('/providers/me/dashboard'),

  enrollNode: (node) => request('/nodes', { method: 'POST', body: JSON.stringify(node) }),

  addAvailability: (nodeId, window_start, window_end) =>
    request(`/nodes/${nodeId}/availability`, {
      method: 'POST', body: JSON.stringify({ window_start, window_end }),
    }),
}

export { ApiError }
