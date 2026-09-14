#!/usr/bin/env bash
# Boots the real stack (Postgres, backend, one real Python worker, the Vite
# dev server) and then runs the real-Chromium Playwright suite against it --
# the browser-level equivalent of scripts/e2e_demo.sh's curl-level check.
# Confirms the actual rendered UI, not just that the HTTP API responds
# correctly underneath it.
#
# Usage: ./e2e/run_e2e.sh   (needs docker, and `npx playwright install
# chromium` once beforehand)
set -euo pipefail
cd "$(dirname "$0")/.."

BACKEND_LOG=$(mktemp)
WORKER_LOG=$(mktemp)
FRONTEND_LOG=$(mktemp)
WORKER_SCRIPT=$(mktemp).py
KEY_PEM=$(mktemp); rm -f "$KEY_PEM"
SQLITE_DB=$(mktemp); rm -f "$SQLITE_DB"

cleanup() {
  [ -n "${FRONTEND_PID:-}" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  [ -n "${WORKER_PID:-}" ] && kill "$WORKER_PID" 2>/dev/null || true
  [ -n "${BACKEND_PID:-}" ] && kill "$BACKEND_PID" 2>/dev/null || true
  rm -f "$WORKER_SCRIPT" "$KEY_PEM" "$SQLITE_DB"*
}
trap cleanup EXIT

echo "== resetting schema =="
docker compose up -d postgres >/dev/null
for i in $(seq 1 25); do docker compose exec -T postgres pg_isready -U nodeva >/dev/null 2>&1 && break; sleep 1; done
docker compose exec -T postgres psql -U nodeva -d nodeva -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
( cd backend && DATABASE_URL="postgresql://nodeva:nodeva_dev@localhost:5433/nodeva" npm run migrate )

echo "== starting backend =="
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
( cd backend && exec env DATABASE_URL="postgresql://nodeva:nodeva_dev@localhost:5433/nodeva" \
    JWT_SECRET="$JWT_SECRET" PORT=3100 node src/index.js ) > "$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
for i in $(seq 1 20); do curl -sf http://localhost:3100/health >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf http://localhost:3100/health >/dev/null || { echo "backend failed to start"; cat "$BACKEND_LOG"; exit 1; }

json() { python3 -c "import sys,json; print(json.load(sys.stdin)$1)"; }
auth_header() { echo "Authorization: Bearer $1"; }

echo "== enrolling a real node that matches the search form's own defaults =="
PROVIDER=$(curl -sf -X POST http://localhost:3100/auth/signup -H 'content-type: application/json' \
  -d '{"email":"e2e-provider@nodeva.test","password":"correct horse battery staple","display_name":"E2E Provider"}')
PROVIDER_TOKEN=$(echo "$PROVIDER" | json "['token']")
curl -sf -X POST http://localhost:3100/providers/me -H "$(auth_header "$PROVIDER_TOKEN")" >/dev/null
PUB=$(.venv/bin/python -c "
import sys; sys.path.insert(0,'worker')
from pathlib import Path
from nodeva_worker.identity import NodeIdentity
print(NodeIdentity.load_or_create(Path('$KEY_PEM')).public_key_raw().hex())
")
# SearchForm.jsx's own defaults: 20GB VRAM, 8 cores, 16GB RAM, <=Rs50/hr,
# now+1h..now+2h -- this node comfortably satisfies all of them so the
# test never has to fight the UI's own default values.
NODE=$(curl -sf -X POST http://localhost:3100/nodes -H "$(auth_header "$PROVIDER_TOKEN")" -H 'content-type: application/json' -d '{
  "public_key_hex":"'"$PUB"'","gpu_model":"RTX 4090 (E2E)",
  "gpu_vram_mb":24576,"cpu_cores":16,"ram_mb":32768,"price_paise_hr":4300}' | json "['node_id']")
WINDOW_START=$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc)).isoformat())")
WINDOW_END=$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=1)).isoformat())")
curl -sf -X POST "http://localhost:3100/nodes/$NODE/availability" -H "$(auth_header "$PROVIDER_TOKEN")" -H 'content-type: application/json' \
  -d "{\"window_start\":\"$WINDOW_START\",\"window_end\":\"$WINDOW_END\"}" >/dev/null
echo "node=$NODE"

cat > "$WORKER_SCRIPT" <<PYEOF
import asyncio, logging, sys
sys.path.insert(0, "worker")
from pathlib import Path
from nodeva_worker.identity import NodeIdentity
from nodeva_worker.reservations import ReservationStore
from nodeva_worker.link import WorkerLink
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
ident = NodeIdentity.load_or_create(Path("$KEY_PEM"))
store = ReservationStore(Path("$SQLITE_DB"))
link = WorkerLink(url="ws://localhost:3100/worker", node_id="$NODE", identity=ident,
                   store=store, price_paise_hr=4300)
asyncio.run(link.run_forever())
PYEOF
echo "== connecting the real worker =="
.venv/bin/python "$WORKER_SCRIPT" > "$WORKER_LOG" 2>&1 &
WORKER_PID=$!
sleep 2
grep -q authenticated "$WORKER_LOG" || { echo "worker failed to authenticate"; cat "$WORKER_LOG"; exit 1; }
echo "OK"

echo "== starting the real Vite dev server for the frontend =="
( cd frontend && exec env VITE_API_URL=http://localhost:3100 npx vite --port 5173 ) > "$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!
for i in $(seq 1 30); do curl -sf http://localhost:5173 >/dev/null 2>&1 && break; sleep 1; done
curl -sf http://localhost:5173 >/dev/null || { echo "frontend dev server failed to start"; cat "$FRONTEND_LOG"; exit 1; }
echo "OK"

echo "== running the real-browser Playwright suite =="
( cd e2e && npx playwright test )
