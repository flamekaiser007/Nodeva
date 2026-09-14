#!/usr/bin/env bash
# Live proof of horizontal scaling (ws/clusterRelay.js): THREE real,
# independent backend processes sharing one real Postgres and one real
# Redis, one real worker connected to only ONE of them, and a real buyer
# hammering all three instances concurrently for the same node -- proving
# the exclusion-constraint-backed booking guarantee holds even when the
# request that reaches the worker has to be relayed cross-process over
# Redis, not handled in-memory by whichever instance happens to hold the
# live socket.
#
# What this does NOT do: a real load/throughput benchmark (requests/sec
# under sustained load, latency percentiles, resource usage). It proves
# CORRECTNESS under concurrency across instances, which is the property
# that actually breaks silently and dangerously if clusterRelay.js has a
# race in it -- a throughput number alone would not have caught that.
#
# Usage: ./scripts/scale_demo.sh   (needs docker)
set -euo pipefail
cd "$(dirname "$0")/.."

BACKEND_LOGS=()
WORKER_LOG=$(mktemp)
WORKER_SCRIPT=$(mktemp).py
KEY_PEM=$(mktemp); rm -f "$KEY_PEM"
SQLITE_DB=$(mktemp); rm -f "$SQLITE_DB"

cleanup() {
  for pid in "${BACKEND_PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  [ -n "${WORKER_PID:-}" ] && kill "$WORKER_PID" 2>/dev/null || true
  rm -f "$WORKER_SCRIPT" "$KEY_PEM" "$SQLITE_DB"*
}
trap cleanup EXIT

echo "== resetting schema, starting postgres + redis =="
docker compose up -d postgres redis >/dev/null
for i in $(seq 1 25); do docker compose exec -T postgres pg_isready -U nodeva >/dev/null 2>&1 && break; sleep 1; done
docker compose exec -T postgres psql -U nodeva -d nodeva -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
( cd backend && DATABASE_URL="postgresql://nodeva:nodeva_dev@localhost:5433/nodeva" npm run migrate )

JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
DB="DATABASE_URL=postgresql://nodeva:nodeva_dev@localhost:5433/nodeva"
REDIS="REDIS_URL=redis://localhost:6380"

PORTS=(3111 3112 3113)
BACKEND_PIDS=()
echo "== starting 3 independent backend instances (ports ${PORTS[*]}), sharing one Postgres and one Redis =="
for p in "${PORTS[@]}"; do
  LOG=$(mktemp)
  BACKEND_LOGS+=("$LOG")
  ( cd backend && exec env $DB $REDIS JWT_SECRET="$JWT_SECRET" PORT="$p" node src/index.js ) > "$LOG" 2>&1 &
  BACKEND_PIDS+=("$!")
done
for p in "${PORTS[@]}"; do
  for i in $(seq 1 20); do curl -sf "http://localhost:$p/health" >/dev/null 2>&1 && break; sleep 0.5; done
  curl -sf "http://localhost:$p/health" >/dev/null || { echo "backend on :$p failed to start"; cat "${BACKEND_LOGS[0]}"; exit 1; }
done
echo "OK: all 3 instances are up"

json() { python3 -c "import sys,json; print(json.load(sys.stdin)$1)"; }
auth_header() { echo "Authorization: Bearer $1"; }

echo "== enrolling one node, worker connects ONLY to instance 0 (:${PORTS[0]}) =="
PROVIDER=$(curl -sf -X POST "http://localhost:${PORTS[0]}/auth/signup" -H 'content-type: application/json' \
  -d '{"email":"scale-provider@nodeva.test","password":"correct horse battery staple","display_name":"Scale Provider"}')
PROVIDER_TOKEN=$(echo "$PROVIDER" | json "['token']")
curl -sf -X POST "http://localhost:${PORTS[0]}/providers/me" -H "$(auth_header "$PROVIDER_TOKEN")" >/dev/null
PUB=$(.venv/bin/python -c "
import sys; sys.path.insert(0,'worker')
from pathlib import Path
from nodeva_worker.identity import NodeIdentity
print(NodeIdentity.load_or_create(Path('$KEY_PEM')).public_key_raw().hex())
")
NODE=$(curl -sf -X POST "http://localhost:${PORTS[0]}/nodes" -H "$(auth_header "$PROVIDER_TOKEN")" -H 'content-type: application/json' -d "{
  \"public_key_hex\":\"$PUB\",\"gpu_model\":\"RTX 4090\",
  \"gpu_vram_mb\":24576,\"cpu_cores\":16,\"ram_mb\":32768,\"price_paise_hr\":4300}" | json "['node_id']")
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
link = WorkerLink(url="ws://localhost:${PORTS[0]}/worker", node_id="$NODE", identity=ident,
                   store=store, price_paise_hr=4300)
asyncio.run(link.run_forever())
PYEOF
.venv/bin/python "$WORKER_SCRIPT" > "$WORKER_LOG" 2>&1 &
WORKER_PID=$!
sleep 2
grep -q authenticated "$WORKER_LOG" || { echo "worker failed to authenticate"; cat "$WORKER_LOG"; exit 1; }
echo "OK: worker is connected to instance 0 only"

echo "== a real buyer hammers all 3 DIFFERENT instances concurrently for the SAME overlapping slot =="
BUYER=$(curl -sf -X POST "http://localhost:${PORTS[0]}/auth/signup" -H 'content-type: application/json' \
  -d '{"email":"scale-buyer@nodeva.test","password":"correct horse battery staple","display_name":"Scale Buyer"}')
BUYER_TOKEN=$(echo "$BUYER" | json "['token']")

STARTS=1799996400000  # far future, unique to this script
ENDS=$((STARTS + 3600000))

RESULTS_DIR=$(mktemp -d)
attempt() {
  local port="$1" idx="$2"
  curl -s -o "$RESULTS_DIR/body-$idx" -w '%{http_code}' -X POST "http://localhost:$port/reservations" \
    -H "$(auth_header "$BUYER_TOKEN")" -H 'content-type: application/json' \
    -d "{\"node_id\":\"$NODE\",\"starts_at\":$STARTS,\"ends_at\":$ENDS}" > "$RESULTS_DIR/status-$idx"
}
# 9 concurrent attempts for the identical slot, round-robined across the 3
# instances -- instance 0 owns the worker's live socket; instances 1 and 2
# can only reach it by relaying over Redis (clusterRelay.js).
PIDS=()
for i in $(seq 0 8); do
  PORT="${PORTS[$((i % 3))]}"
  attempt "$PORT" "$i" &
  PIDS+=("$!")
done
for pid in "${PIDS[@]}"; do wait "$pid"; done

SUCCESSES=0
for i in $(seq 0 8); do
  STATUS=$(cat "$RESULTS_DIR/status-$i")
  [ "$STATUS" = "201" ] && SUCCESSES=$((SUCCESSES + 1))
done
echo "9 concurrent cross-instance attempts for the same slot -> $SUCCESSES succeeded (201), $((9 - SUCCESSES)) correctly rejected"
[ "$SUCCESSES" -eq 1 ] || { echo "FAIL: expected exactly 1 success across 3 instances, got $SUCCESSES"; for i in $(seq 0 8); do echo "attempt $i ($(cat "$RESULTS_DIR/status-$i")): $(cat "$RESULTS_DIR/body-$i")"; done; exit 1; }
echo "OK: exactly one booking succeeded despite 3 separate backend processes racing for it"

DB_COUNT=$(docker compose exec -T postgres psql -U nodeva -d nodeva -t -A -c \
  "SELECT count(*) FROM reservations WHERE node_id='$NODE';")
[ "$DB_COUNT" = "1" ] || { echo "FAIL: expected exactly 1 reservation row, found $DB_COUNT"; exit 1; }
echo "OK: exactly 1 reservation row in Postgres -- no double-booking slipped through at the database level either"

echo "== distinct, non-overlapping bookings across all 3 instances all succeed concurrently =="
DISTINCT_DIR=$(mktemp -d)
DISTINCT_PIDS=()
for i in $(seq 0 5); do
  PORT="${PORTS[$((i % 3))]}"
  SLOT_START=$((STARTS + 7200000 * (i + 1)))
  SLOT_END=$((SLOT_START + 3600000))
  ( curl -s -o "$DISTINCT_DIR/body-$i" -w '%{http_code}' -X POST "http://localhost:$PORT/reservations" \
      -H "$(auth_header "$BUYER_TOKEN")" -H 'content-type: application/json' \
      -d "{\"node_id\":\"$NODE\",\"starts_at\":$SLOT_START,\"ends_at\":$SLOT_END}" > "$DISTINCT_DIR/status-$i" ) &
  DISTINCT_PIDS+=("$!")
done
for pid in "${DISTINCT_PIDS[@]}"; do wait "$pid"; done
DISTINCT_OK=0
for i in $(seq 0 5); do
  [ "$(cat "$DISTINCT_DIR/status-$i")" = "201" ] && DISTINCT_OK=$((DISTINCT_OK + 1))
done
[ "$DISTINCT_OK" = "6" ] || { echo "FAIL: expected all 6 non-overlapping cross-instance bookings to succeed, got $DISTINCT_OK"; exit 1; }
echo "OK: all 6 non-overlapping bookings, spread across all 3 instances, succeeded"

rm -rf "$RESULTS_DIR" "$DISTINCT_DIR"
echo
echo "ALL HORIZONTAL SCALING CHECKS PASSED"
