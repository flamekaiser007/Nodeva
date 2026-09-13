# NODEVA frontend

React + Tailwind marketplace UI against the backend in `../backend`. Requirement-based
search, reserve, confirm & pay, submit a job, watch it run — the flow described in
`../README.md` and `../docs/reservation-protocol.md`.

## Running

Needs a backend and at least one connected worker (see `../scripts/e2e_demo.sh` for
how those are wired together, or run that script and query against the stack it
leaves running mid-execution).

```bash
npm install
npm run dev       # http://localhost:5173, proxies to VITE_API_URL (default :3100)
```

`VITE_API_URL` in `.env` (see `.env.example`) points at the backend if it's not on
the default port.

## What's real vs. a stand-in

- Sign-in is real: `UserBar.jsx` calls the backend's `POST /auth/signup` and
  `POST /auth/login`, which hash passwords with bcrypt and issue a JWT. The
  token is stored in `localStorage` and attached as a Bearer token to every
  subsequent request by `api.js` -- nothing in this app ever sees a password
  hash or reads/writes a `user_id` directly; the backend derives it from the
  token.
- Account recovery (forgot-password, email verification) is not built --
  that's the honest remaining gap, not sign-in itself.
- Everything past sign-in is real: the reservation, confirmation, and job
  submission all hit the actual backend, which talks to an actual worker process
  over a real signed WebSocket connection, which runs an actual sandboxed Docker
  container. The job output shown in the UI is the container's real stdout.

## Structure

- `src/api.js` — thin fetch wrapper, no generated client.
- `src/components/SearchForm.jsx` — requirement inputs (not a GPU-model picker).
- `src/components/ResultsList.jsx` — scheduler output, with score/reliability/
  expected-cost shown rather than hidden behind a ranking.
- `src/components/ActiveReservation.jsx` — the reservation lifecycle
  (held → confirmed → running → terminal), one at a time.
- `src/components/UserBar.jsx` — real signup/login form.
