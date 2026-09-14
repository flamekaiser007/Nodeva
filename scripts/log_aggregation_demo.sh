#!/usr/bin/env bash
# Live proof of log aggregation (observability/lokiSink.js, docker-compose's
# `loki` service): a real backend process shipping real structured log
# lines over a real HTTP push to a real Loki container, then queried back
# out of Loki itself -- not just that the sink's own unit tests pass
# against a fake fetch.
#
# Usage: ./scripts/log_aggregation_demo.sh   (needs docker)
set -euo pipefail
cd "$(dirname "$0")/.."

BACKEND_LOG=$(mktemp)

cleanup() {
  [ -n "${BACKEND_PID:-}" ] && kill "$BACKEND_PID" 2>/dev/null || true
  docker compose --profile observability stop loki >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== resetting schema =="
docker compose up -d postgres >/dev/null
for i in $(seq 1 25); do docker compose exec -T postgres pg_isready -U nodeva >/dev/null 2>&1 && break; sleep 1; done
docker compose exec -T postgres psql -U nodeva -d nodeva -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
( cd backend && DATABASE_URL="postgresql://nodeva:nodeva_dev@localhost:5433/nodeva" npm run migrate )

echo "== starting Loki =="
docker compose --profile observability up -d loki >/dev/null
for i in $(seq 1 30); do curl -sf http://localhost:3300/ready >/dev/null 2>&1 && break; sleep 1; done
curl -sf http://localhost:3300/ready >/dev/null || { echo "Loki never became ready"; exit 1; }
echo "OK"

echo "== starting the real backend with LOKI_URL set =="
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
MARKER="log-agg-demo-$(date +%s)"
( cd backend && exec env DATABASE_URL="postgresql://nodeva:nodeva_dev@localhost:5433/nodeva" \
    JWT_SECRET="$JWT_SECRET" PORT=3100 LOKI_URL="http://localhost:3300" node src/index.js ) > "$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
for i in $(seq 1 20); do curl -sf http://localhost:3100/health >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf http://localhost:3100/health >/dev/null || { echo "backend failed to start"; cat "$BACKEND_LOG"; exit 1; }

echo "== triggering a real log line carrying a unique marker =="
# Most successful requests never call logger.* at all (there's no
# per-request access-log middleware), and the one obvious candidate --
# auth/forgot-password's failure path -- goes through ConsoleEmailSender's
# own bare console.warn (email.js), not the structured logger, so it would
# never reach the Loki sink either. The one thing guaranteed to call
# logger.error with an identifiable field is the top-level error-handling
# middleware (api/server.js, `app.use((err, req, res, _next) => ...)`),
# triggered here by a deliberately malformed JSON body (express.json()
# throws a SyntaxError, which Express routes to that 4-arg handler). The
# request-id middleware runs BEFORE express.json(), so req.log already
# carries our custom x-request-id as its `request_id` field when the error
# is logged -- that's the marker this script actually greps for in Loki.
curl -s -X POST http://localhost:3100/auth/signup \
  -H 'content-type: application/json' -H "x-request-id: $MARKER" \
  -d '{not valid json' >/dev/null

echo "== waiting for the sink's batch interval to actually flush to Loki (up to ~10s) =="
FOUND=""
for i in $(seq 1 10); do
  sleep 1
  FOUND=$(curl -s -G http://localhost:3300/loki/api/v1/query_range \
    --data-urlencode 'query={service="nodeva-backend"}' \
    --data-urlencode "start=$(( $(date +%s) - 60 ))000000000" \
    --data-urlencode "end=$(( $(date +%s) + 5 ))000000000" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
for result in d.get('data', {}).get('result', []):
    for ts, line in result.get('values', []):
        if '$MARKER' in line:
            print(line)
" 2>/dev/null || true)
  [ -n "$FOUND" ] && break
done

[ -n "$FOUND" ] || { echo "FAIL: the marker never showed up in a real Loki query"; cat "$BACKEND_LOG"; exit 1; }
echo "OK: a real log line shipped by this exact backend process was queried back out of a real Loki container"
echo "--- the actual line, as stored in Loki ---"
echo "$FOUND"

echo
echo "ALL LOG AGGREGATION CHECKS PASSED"
