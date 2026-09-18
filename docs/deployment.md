# Deployment

## What actually gets deployed, and what doesn't

Per `docs/architecture.md`'s own honest framing -- **identity and money are
centralized, compute is not** -- exactly two things need real hosting:

1. **Postgres** -- the one source of truth (identity, money, the search index).
2. **The backend** -- a real, long-running process, not a serverless
   function. It holds a persistent WebSocket connection open to every
   online provider node (`backend/src/ws/protocol.js`'s whole design is
   built around this); a platform that scales the backend to zero between
   requests would drop every provider's connection.
3. **The frontend** -- a static build (Vite/React). Can go anywhere that
   serves static files.

**What does NOT get centrally deployed: `worker/run_worker.py`.** That
process runs on each provider's own machine, wherever their GPU physically
lives -- deploying it centrally would defeat the entire point of a
distributed-compute marketplace. See `docs/architecture.md`'s component
diagram.

## Render (this repo's `render.yaml`)

Render was chosen because it supports a real long-lived Node process (not
just serverless functions) and a managed Postgres in one place, with a
free tier for trying this out.

### One-time setup

1. Push this repo to GitHub if you haven't already (`git push`).
2. On [render.com](https://render.com), **New +** -> **Blueprint**, and
   point it at this GitHub repo. Render reads `render.yaml` from the repo
   root and provisions:
   - `nodeva-postgres` (managed Postgres, free plan)
   - `nodeva-backend` (a real Node web service -- runs migrations on every
     deploy, then starts the server)
   - `nodeva-frontend` (a static site build of the React app)
3. **The backend's URL isn't known until after its first deploy.** Once
   `nodeva-backend` finishes deploying, copy its real URL (something like
   `https://nodeva-backend-xxxx.onrender.com`) and update
   `render.yaml`'s `nodeva-frontend` service's `VITE_API_URL` to that exact
   value, then commit and push -- this triggers a rebuild of the frontend
   with the correct backend URL baked in. (Vite bakes `VITE_API_URL` into
   the built JavaScript at *build* time, not runtime, so this can't be a
   `fromService` reference the way `DATABASE_URL` is -- the backend has to
   exist first.)
4. Done. Visit the frontend's URL.

### What's deliberately NOT configured

- **No payment gateway.** `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` are left
  unset in `render.yaml` -- bookings go through the honest no-gateway
  fallback (`docs/payment-architecture.md`): confirmation succeeds
  instantly with no real charge. Add real keys as environment variables in
  the Render dashboard (never commit them to `render.yaml` or anywhere
  else in the repo) if real payments are ever wanted.
- **No `ADMIN_TOKEN`, `LOKI_URL`, or `REDIS_URL`.** Every one of these is
  off-by-default in the codebase itself (see `auth/adminToken.js`,
  `observability/lokiSink.js`, `ws/clusterRelay.js`'s own comments) and can
  be added later as plain Render environment variables with no code
  change and no redeploy of anything but the one env var.
- **No SMTP.** Password-reset emails go through the honest console
  fallback (`auth/email.js`'s `ConsoleEmailSender`) -- they get logged,
  not sent. Add `SMTP_HOST`/`PORT`/`USER`/`PASS` env vars for real email.

### A real, non-obvious fix this deployment needed

`backend/src/db/pool.js` never enabled SSL for any connection -- fine for
local dev and CI, both against a plaintext local Postgres, but Render's
(and most managed Postgres providers') connections require it. `render.yaml`
sets `PGSSL=true`, which `pool.js` now reads to enable
`ssl: { rejectUnauthorized: false }` (encrypts the connection; does not
pin the CA, since this process has no independent way to validate a
managed host's certificate -- the same pragmatic tradeoff most
"just give me DATABASE_URL" deploy guides for node-postgres make).

## For providers: running a worker against the deployed backend

Nothing about `worker/run_worker.py` changes -- a provider just points
`--url` at the real deployed backend's WebSocket endpoint instead of the
local dev default:

```bash
.venv/bin/python worker/run_worker.py \
  --node-id <the node_id from your dashboard> \
  --price-paise-hr <your price> \
  --url wss://nodeva-backend-xxxx.onrender.com/worker
```

`--url` defaults to a LOCAL dev backend, which is the single easiest thing
to get wrong here: omit it against a deployed platform and the worker
connects to localhost instead, whose database has never heard of that
node_id, and the handshake is refused (`does not recognise node ...`). Set
it once instead of remembering the flag every run:

```bash
export NODEVA_URL=wss://nodeva-backend-xxxx.onrender.com/worker
```

An explicit `--url` still overrides it, so a provider can point a worker at
a local backend for testing without unsetting anything.

(`wss://`, not `ws://` -- Render terminates TLS for you, and the browser's
own WebSocket connection to `/worker` needs to match the page's own
`https://` origin's security level.)

## Other platforms

`render.yaml` is Render-specific, but the shape is the same anywhere:

- **Railway** / **Fly.io**: same three pieces (managed Postgres, a
  persistent Node service, a static frontend build). Fly.io in particular
  is worth considering if you want the backend running physically closer
  to where most providers are, since every reservation/job round-trip
  crosses that connection.
- **A plain VPS**: works too -- `docker-compose.yml` already has the
  Postgres service; add the backend and a static file server (nginx,
  Caddy) alongside it, with `PGSSL` left unset if Postgres is local to the
  same box (no managed-host SSL requirement in that case).

## Honest limits

- **No zero-downtime migrations.** `startCommand: npm run migrate && node
  src/index.js` means a deploy briefly takes the backend down while
  migrations run. Fine at this project's current scale; a real concern
  once uptime matters more than deploy simplicity.
- **No horizontal scaling configured**, even though `ws/clusterRelay.js`
  supports it (see `scripts/scale_demo.sh`) -- `render.yaml` deploys
  exactly one backend instance. Scaling to more needs `REDIS_URL` set and
  Render's own instance-count setting increased; nothing here does that
  automatically.
- **No custom domain, CDN, or backup automation** configured by this
  Blueprint -- see `docs/backup-restore.md` for the backup story, which
  still applies unchanged to a Render-hosted Postgres (the connection
  string is different; the `pg_dump`/`pg_restore` commands are not).
