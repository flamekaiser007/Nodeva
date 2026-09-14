#!/usr/bin/env bash
# Live proof of secret rotation (auth/jwt.js's requireJwtVerificationSecrets,
# auth/adminToken.js's ADMIN_TOKEN_PREVIOUS): three real backend PROCESSES
# in sequence (old secret, mid-rotation with both, new-only), a real JWT
# issued by the FIRST process, and a real ADMIN_TOKEN header -- proving a
# session/token issued before a rotation survives it, and that a retired
# secret actually stops working once the rotation is declared complete.
#
# Usage: ./scripts/secrets_rotation_demo.sh   (needs docker)
set -euo pipefail
cd "$(dirname "$0")/.."

BACKEND_LOG=$(mktemp)
cleanup() { [ -n "${BACKEND_PID:-}" ] && kill "$BACKEND_PID" 2>/dev/null || true; }
trap cleanup EXIT

echo "== resetting schema =="
docker compose up -d postgres >/dev/null
for i in $(seq 1 25); do docker compose exec -T postgres pg_isready -U nodeva >/dev/null 2>&1 && break; sleep 1; done
docker compose exec -T postgres psql -U nodeva -d nodeva -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" >/dev/null
( cd backend && DATABASE_URL="postgresql://nodeva:nodeva_dev@localhost:5433/nodeva" npm run migrate )

json() { python3 -c "import sys,json; print(json.load(sys.stdin)$1)"; }
auth_header() { echo "Authorization: Bearer $1"; }
DB="DATABASE_URL=postgresql://nodeva:nodeva_dev@localhost:5433/nodeva"

start_backend() {
  ( cd backend && exec env $DB "$@" PORT=3100 node src/index.js ) > "$BACKEND_LOG" 2>&1 &
  BACKEND_PID=$!
  for i in $(seq 1 20); do curl -sf http://localhost:3100/health >/dev/null 2>&1 && break; sleep 0.5; done
  curl -sf http://localhost:3100/health >/dev/null || { echo "backend failed to start"; cat "$BACKEND_LOG"; exit 1; }
}
stop_backend() { kill "$BACKEND_PID" 2>/dev/null || true; wait "$BACKEND_PID" 2>/dev/null || true; unset BACKEND_PID; sleep 0.5; }

OLD_JWT_SECRET="old-secret-$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
NEW_JWT_SECRET="new-secret-$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
OLD_ADMIN_TOKEN="old-admin-token"
NEW_ADMIN_TOKEN="new-admin-token"

echo "== phase 1: pre-rotation process, issues a real JWT with the OLD secret =="
start_backend JWT_SECRET="$OLD_JWT_SECRET" ADMIN_TOKEN="$OLD_ADMIN_TOKEN"
SIGNUP=$(curl -sf -X POST http://localhost:3100/auth/signup -H 'content-type: application/json' \
  -d '{"email":"rotation-demo@nodeva.test","password":"correct horse battery staple","display_name":"Rotation Demo"}')
PRE_ROTATION_JWT=$(echo "$SIGNUP" | json "['token']")
[ -n "$PRE_ROTATION_JWT" ] || { echo "FAIL: signup did not return a token"; exit 1; }
echo "OK: got a real JWT signed with the pre-rotation secret"
stop_backend

echo "== phase 2: mid-rotation process, BOTH secrets configured =="
start_backend JWT_SECRET="$NEW_JWT_SECRET" JWT_SECRET_PREVIOUS="$OLD_JWT_SECRET" \
  ADMIN_TOKEN="$NEW_ADMIN_TOKEN" ADMIN_TOKEN_PREVIOUS="$OLD_ADMIN_TOKEN"

echo "-- the OLD JWT, issued by a DIFFERENT process before rotation, must still authenticate --"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3100/reservations/00000000-0000-0000-0000-000000000000 -H "$(auth_header "$PRE_ROTATION_JWT")")
[ "$STATUS" != "401" ] || { echo "FAIL: pre-rotation JWT was rejected mid-rotation (got 401)"; exit 1; }
echo "OK: got $STATUS (not 401)"

echo "-- a FRESH login during the rotation also works (signed with the new secret) --"
LOGIN=$(curl -sf -X POST http://localhost:3100/auth/login -H 'content-type: application/json' \
  -d '{"email":"rotation-demo@nodeva.test","password":"correct horse battery staple"}')
MID_ROTATION_JWT=$(echo "$LOGIN" | json "['token']")
STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3100/reservations/00000000-0000-0000-0000-000000000000 -H "$(auth_header "$MID_ROTATION_JWT")")
[ "$STATUS" != "401" ] || { echo "FAIL: a token signed with the NEW secret was rejected"; exit 1; }
echo "OK: got $STATUS (not 401)"

echo "-- the OLD admin token still works mid-rotation --"
OLD_ADMIN_STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3100/metrics -H "x-admin-token: $OLD_ADMIN_TOKEN")
[ "$OLD_ADMIN_STATUS" = "200" ] || { echo "FAIL: expected 200 for the old admin token mid-rotation, got $OLD_ADMIN_STATUS"; exit 1; }
echo "OK"

echo "-- the NEW admin token also works mid-rotation --"
NEW_ADMIN_STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3100/metrics -H "x-admin-token: $NEW_ADMIN_TOKEN")
[ "$NEW_ADMIN_STATUS" = "200" ] || { echo "FAIL: expected 200 for the new admin token mid-rotation, got $NEW_ADMIN_STATUS"; exit 1; }
echo "OK"
stop_backend

echo "== phase 3: post-rotation process, previous secrets REMOVED -- rotation actually completes =="
start_backend JWT_SECRET="$NEW_JWT_SECRET" ADMIN_TOKEN="$NEW_ADMIN_TOKEN"

echo "-- the OLD JWT must now be rejected --"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3100/reservations/00000000-0000-0000-0000-000000000000 -H "$(auth_header "$PRE_ROTATION_JWT")")
[ "$STATUS" = "401" ] || { echo "FAIL: expected the retired JWT secret to be rejected post-rotation, got $STATUS"; exit 1; }
echo "OK: got 401 -- the retired secret genuinely stopped working"

echo "-- the NEW JWT (issued mid-rotation) still works --"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3100/reservations/00000000-0000-0000-0000-000000000000 -H "$(auth_header "$MID_ROTATION_JWT")")
[ "$STATUS" != "401" ] || { echo "FAIL: a token signed with the (still current) new secret was rejected post-rotation"; exit 1; }
echo "OK: got $STATUS (not 401)"

echo "-- the OLD admin token must now be rejected --"
OLD_ADMIN_STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3100/metrics -H "x-admin-token: $OLD_ADMIN_TOKEN")
[ "$OLD_ADMIN_STATUS" = "404" ] || { echo "FAIL: expected the retired admin token to 404 post-rotation, got $OLD_ADMIN_STATUS"; exit 1; }
echo "OK: got 404 -- the retired admin token genuinely stopped working"
stop_backend

echo
echo "ALL SECRET ROTATION CHECKS PASSED"
