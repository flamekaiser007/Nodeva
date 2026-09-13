// Thin fetch wrapper for the NODEVA backend. No SDK, no generated client --
// the API surface is small enough that a hand-written wrapper stays more
// readable than the machinery to generate one.

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3100';

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error ?? `request failed with ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

export const api = {
  // --- dev-only user seeding. See server.js's SCOPE NOTE: this stands in
  // for real signup/login, which is not built. ---------------------------
  createDevUser: (email, display_name) =>
    request('/dev/users', { method: 'POST', body: JSON.stringify({ email, display_name }) }),

  // --- marketplace --------------------------------------------------------
  search: (requirements) =>
    request('/search', { method: 'POST', body: JSON.stringify(requirements) }),

  listNodes: () => request('/nodes'),

  // --- reservations --------------------------------------------------------
  reserve: (node_id, user_id, starts_at, ends_at) =>
    request('/reservations', {
      method: 'POST',
      body: JSON.stringify({ node_id, user_id, starts_at, ends_at }),
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
};

export { ApiError };
