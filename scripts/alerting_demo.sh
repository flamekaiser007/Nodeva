#!/usr/bin/env bash
# Live proof of the observability profile (docker-compose.yml's prometheus +
# alertmanager services, alerting/*.yml): a real backend process, a real
# Prometheus scraping its real /metrics with a real bearer token, a real
# alert rule evaluating against real scraped data, and a real Alertmanager
# delivering a real HTTP POST to a webhook receiver -- not a config file
# that has never actually been loaded by the software that reads it.
#
# What it deliberately does NOT try to fabricate live: an actual exhausted
# refund retry needs a controllably-failing payment gateway wired into a
# live process, which is exactly what backend/test/backlog.test.js and
# refunds.test.js already exercise at the unit/integration level. This
# script instead fires the simplest, most reliably real signal -- stopping
# the backend and watching NodevaBackendDown actually travel the full
# Prometheus -> Alertmanager -> webhook path -- which is enough to prove the
# WIRING is real; the other rules in alerting/alert_rules.yml read metrics
# already proven correct by backlog.test.js/metrics.test.js.
#
# Usage: ./scripts/alerting_demo.sh   (needs docker; takes ~2 minutes,
# mostly spent waiting out the alert rules' own `for:` durations)
set -euo pipefail
cd "$(dirname "$0")/.."

BACKEND_LOG=$(mktemp)
WEBHOOK_LOG=$(mktemp)
WEBHOOK_SCRIPT=$(mktemp).js
ADMIN_TOKEN="nodeva-dev-observability-token" # must match alerting/prometheus.yml's bearer_token

cleanup() {
  [ -n "${BACKEND_PID:-}" ] && kill "$BACKEND_PID" 2>/dev/null || true
  [ -n "${WEBHOOK_PID:-}" ] && kill "$WEBHOOK_PID" 2>/dev/null || true
  docker compose --profile observability stop prometheus alertmanager >/dev/null 2>&1 || true
  rm -f "$WEBHOOK_SCRIPT"
}
trap cleanup EXIT

echo "== resetting schema =="
docker compose up -d postgres >/dev/null
for i in $(seq 1 25); do docker compose exec -T postgres pg_isready -U nodeva >/dev/null 2>&1 && break; sleep 1; done
docker compose exec -T postgres psql -U nodeva -d nodeva -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
( cd backend && DATABASE_URL="postgresql://nodeva:nodeva_dev@localhost:5433/nodeva" npm run migrate )

echo "== starting a tiny webhook receiver on :9099 (stands in for Slack/PagerDuty/email) =="
cat > "$WEBHOOK_SCRIPT" <<'JSEOF'
const http = require('node:http');
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    console.log('WEBHOOK RECEIVED:', body);
    res.writeHead(200); res.end('ok');
  });
}).listen(9099, () => console.log('webhook sink listening on :9099'));
JSEOF
node "$WEBHOOK_SCRIPT" > "$WEBHOOK_LOG" 2>&1 &
WEBHOOK_PID=$!
sleep 1

echo "== starting the real backend with ADMIN_TOKEN set (required for /metrics to be reachable at all) =="
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
( cd backend && exec env DATABASE_URL="postgresql://nodeva:nodeva_dev@localhost:5433/nodeva" \
    JWT_SECRET="$JWT_SECRET" ADMIN_TOKEN="$ADMIN_TOKEN" PORT=3100 node src/index.js ) > "$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
for i in $(seq 1 20); do curl -sf http://localhost:3100/health >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf http://localhost:3100/health >/dev/null || { echo "backend failed to start"; cat "$BACKEND_LOG"; exit 1; }

echo "== confirming /metrics is real and gated (404 without the token, real Prometheus text with it) =="
NO_TOKEN=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3100/metrics)
[ "$NO_TOKEN" = "404" ] || { echo "FAIL: expected 404 without ADMIN_TOKEN, got $NO_TOKEN"; exit 1; }
curl -sf http://localhost:3100/metrics -H "x-admin-token: $ADMIN_TOKEN" | grep -q nodeva_reservations_created_total \
  || { echo "FAIL: /metrics did not return real exposition text with the correct token"; exit 1; }
echo "OK"

echo "== starting Prometheus + Alertmanager (the observability compose profile) =="
docker compose --profile observability up -d prometheus alertmanager >/dev/null
for i in $(seq 1 20); do curl -sf http://localhost:9090/-/ready >/dev/null 2>&1 && break; sleep 1; done
for i in $(seq 1 20); do curl -sf http://localhost:9093/-/ready >/dev/null 2>&1 && break; sleep 1; done

echo "== waiting for Prometheus to actually scrape the real backend (not just start up) =="
for i in $(seq 1 30); do
  UP=$(curl -sf -G 'http://localhost:9090/api/v1/query' --data-urlencode 'query=up{job="nodeva-backend"}' 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); r=d['data']['result']; print(r[0]['value'][1] if r else 'none')" 2>/dev/null || echo none)
  [ "$UP" = "1" ] && break
  sleep 2
done
[ "$UP" = "1" ] || { echo "FAIL: Prometheus never successfully scraped the backend (up=$UP)"; exit 1; }
echo "OK: Prometheus is scraping the real /metrics endpoint with the real bearer token"

echo "== confirming the alert rules actually loaded =="
RULE_COUNT=$(curl -sf http://localhost:9090/api/v1/rules \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(len(g['rules']) for g in d['data']['groups']))")
[ "$RULE_COUNT" -ge 5 ] || { echo "FAIL: expected at least 5 alert rules loaded, got $RULE_COUNT"; exit 1; }
echo "OK: $RULE_COUNT alert rules loaded from alerting/alert_rules.yml"

echo "== killing the backend: NodevaBackendDown should fire for real =="
kill "$BACKEND_PID"; unset BACKEND_PID
echo "waiting out the rule's 'for: 1m' plus Alertmanager's group_wait (this takes about 90s)..."
for i in $(seq 1 60); do
  grep -q "NodevaBackendDown" "$WEBHOOK_LOG" 2>/dev/null && break
  sleep 2
done
grep -q "NodevaBackendDown" "$WEBHOOK_LOG" || {
  echo "FAIL: the webhook receiver never got a NodevaBackendDown alert"
  echo "--- prometheus alert state ---"
  curl -s http://localhost:9090/api/v1/alerts || true
  echo "--- webhook log ---"; cat "$WEBHOOK_LOG"
  exit 1
}
echo "OK: a real alert traveled Prometheus -> Alertmanager -> webhook end to end"
echo "--- the actual delivered payload ---"
grep "NodevaBackendDown" "$WEBHOOK_LOG" | tail -1

echo
echo "ALL ALERTING CHECKS PASSED"
