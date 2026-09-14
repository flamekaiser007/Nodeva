#!/usr/bin/env bash
# Live proof of Phase 2 P2P discovery (backend/src/ws/hub.js#introducePeers,
# worker/nodeva_worker/peer.py): a real backend, two real Python worker
# processes with a real TCP peer listener each, a real Postgres-backed
# verification pairing, and a real direct socket between the two workers
# that never touches the backend once it's open.
#
# What this proves that the unit/integration tests alone cannot:
#   - the backend really observes each worker's own source address (not
#     anything either worker claims) and hands it to the OTHER worker
#   - two independent OS processes, never told about each other except via
#     that platform-relayed introduction, open a real TCP connection and
#     mutually authenticate with their existing Ed25519 identities
#   - a PEER_PING/PEER_PONG round trip happens entirely over that direct
#     socket -- killing the backend after introduction does not break it
#
# What this does NOT prove (see peer.py's file header): NAT traversal. Both
# workers run on localhost here, which has no NAT to get through.
#
# Usage: ./scripts/p2p_demo.sh   (needs docker; starts/reuses postgres on 5433)
set -euo pipefail
cd "$(dirname "$0")/.."

BACKEND_LOG=$(mktemp)
WORKER_A_LOG=$(mktemp)
WORKER_B_LOG=$(mktemp)
WORKER_A_SCRIPT=$(mktemp).py
WORKER_B_SCRIPT=$(mktemp).py
KEY_A_PEM=$(mktemp); rm -f "$KEY_A_PEM"
KEY_B_PEM=$(mktemp); rm -f "$KEY_B_PEM"
SQLITE_A=$(mktemp); rm -f "$SQLITE_A"
SQLITE_B=$(mktemp); rm -f "$SQLITE_B"

cleanup() {
  [ -n "${WORKER_A_PID:-}" ] && kill "$WORKER_A_PID" 2>/dev/null || true
  [ -n "${WORKER_B_PID:-}" ] && kill "$WORKER_B_PID" 2>/dev/null || true
  [ -n "${BACKEND_PID:-}" ] && kill "$BACKEND_PID" 2>/dev/null || true
  rm -f "$WORKER_A_SCRIPT" "$WORKER_B_SCRIPT" "$KEY_A_PEM" "$KEY_B_PEM" "$SQLITE_A"* "$SQLITE_B"*
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
    JWT_SECRET="$JWT_SECRET" PORT=3101 node src/index.js ) > "$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
for i in $(seq 1 20); do curl -sf http://localhost:3101/health >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf http://localhost:3101/health >/dev/null || { echo "backend failed to start"; cat "$BACKEND_LOG"; exit 1; }

json() { python3 -c "import sys,json; print(json.load(sys.stdin)$1)"; }
auth_header() { echo "Authorization: Bearer $1"; }

pubkey_of() {
  .venv/bin/python -c "
import sys; sys.path.insert(0,'worker')
from pathlib import Path
from nodeva_worker.identity import NodeIdentity
print(NodeIdentity.load_or_create(Path('$1')).public_key_raw().hex())
"
}
PUB_A=$(pubkey_of "$KEY_A_PEM")
PUB_B=$(pubkey_of "$KEY_B_PEM")

echo "== enrolling two independent nodes on two independent provider accounts =="
enroll() {
  local email="$1" pub="$2"
  local signup token provider node
  signup=$(curl -sf -X POST http://localhost:3101/auth/signup -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"correct horse battery staple\",\"display_name\":\"$email\"}")
  token=$(echo "$signup" | json "['token']")
  curl -sf -X POST http://localhost:3101/providers/me -H "$(auth_header "$token")" >/dev/null
  node=$(curl -sf -X POST http://localhost:3101/nodes -H "$(auth_header "$token")" -H 'content-type: application/json' -d "{
    \"public_key_hex\":\"$pub\",\"gpu_model\":\"RTX 4090\",
    \"gpu_vram_mb\":24576,\"cpu_cores\":16,\"ram_mb\":32768,\"price_paise_hr\":4300}" | json "['node_id']")
  echo "$token $node"
}
read -r PROVIDER_A_TOKEN NODE_A <<< "$(enroll p2p-provider-a@nodeva.test "$PUB_A")"
read -r PROVIDER_B_TOKEN NODE_B <<< "$(enroll p2p-provider-b@nodeva.test "$PUB_B")"
echo "node_a=$NODE_A node_b=$NODE_B"

cat > "$WORKER_A_SCRIPT" <<PYEOF
import asyncio, logging, sys
sys.path.insert(0, "worker")
from pathlib import Path
from nodeva_worker.identity import NodeIdentity
from nodeva_worker.reservations import ReservationStore
from nodeva_worker.link import WorkerLink
from nodeva_worker.peer import connect_to_peer
logging.basicConfig(level=logging.INFO, format="%(asctime)s A %(message)s")
ident = NodeIdentity.load_or_create(Path("$KEY_A_PEM"))
store = ReservationStore(Path("$SQLITE_A"))
link = WorkerLink(url="ws://localhost:3101/worker", node_id="$NODE_A", identity=ident,
                   store=store, price_paise_hr=4300, peer_port=0)

async def dial_sibling_once_introduced():
    while link.peer_directory.get("$NODE_B") is None:
        await asyncio.sleep(0.2)
    conn = await connect_to_peer(identity=ident, my_node_id="$NODE_A",
                                  peer_node_id="$NODE_B", directory=link.peer_directory)
    ok = await conn.ping()
    print(f"PEER PING RESULT: {ok}", flush=True)
    await conn.close()

async def main():
    async with asyncio.TaskGroup() as tg:
        tg.create_task(link.run_forever())
        tg.create_task(dial_sibling_once_introduced())
asyncio.run(main())
PYEOF

cat > "$WORKER_B_SCRIPT" <<PYEOF
import asyncio, logging, sys
sys.path.insert(0, "worker")
from pathlib import Path
from nodeva_worker.identity import NodeIdentity
from nodeva_worker.reservations import ReservationStore
from nodeva_worker.link import WorkerLink
logging.basicConfig(level=logging.INFO, format="%(asctime)s B %(message)s")
ident = NodeIdentity.load_or_create(Path("$KEY_B_PEM"))
store = ReservationStore(Path("$SQLITE_B"))
link = WorkerLink(url="ws://localhost:3101/worker", node_id="$NODE_B", identity=ident,
                   store=store, price_paise_hr=4300, peer_port=0)
asyncio.run(link.run_forever())
PYEOF

echo "== connecting two real workers, each with its own direct-peer listener =="
.venv/bin/python "$WORKER_A_SCRIPT" > "$WORKER_A_LOG" 2>&1 &
WORKER_A_PID=$!
.venv/bin/python "$WORKER_B_SCRIPT" > "$WORKER_B_LOG" 2>&1 &
WORKER_B_PID=$!
sleep 2
grep -q authenticated "$WORKER_A_LOG" || { echo "worker A failed to authenticate"; cat "$WORKER_A_LOG"; exit 1; }
grep -q authenticated "$WORKER_B_LOG" || { echo "worker B failed to authenticate"; cat "$WORKER_B_LOG"; exit 1; }
grep -q "listening for direct peer connections" "$WORKER_A_LOG" || { echo "worker A never started its peer listener"; cat "$WORKER_A_LOG"; exit 1; }
echo "OK: both workers authenticated and are listening for direct peer connections"

BOOK() { # email token node day
  local token="$1" node="$2" starts ends rid
  starts=$(node -e "console.log(Date.UTC(2032,0,$3,10,0))")
  ends=$(node -e "console.log(Date.UTC(2032,0,$3,11,0))")
  rid=$(curl -sf -X POST http://localhost:3101/reservations -H "$(auth_header "$token")" -H 'content-type: application/json' \
    -d "{\"node_id\":\"$node\",\"starts_at\":$starts,\"ends_at\":$ends}" | json "['reservation_id']")
  curl -sf -X POST "http://localhost:3101/reservations/$rid/confirm" -H "$(auth_header "$token")" >/dev/null
  echo "$rid"
}

echo "== a real buyer books BOTH nodes and submits a duplicate-execution verification job =="
BUYER_SIGNUP=$(curl -sf -X POST http://localhost:3101/auth/signup -H 'content-type: application/json' \
  -d '{"email":"p2p-buyer@nodeva.test","password":"correct horse battery staple","display_name":"P2P Buyer"}')
BUYER_TOKEN=$(echo "$BUYER_SIGNUP" | json "['token']")

RID_A=$(BOOK "$BUYER_TOKEN" "$NODE_A" 5)
RID_B=$(BOOK "$BUYER_TOKEN" "$NODE_B" 6)
echo "reservation_a=$RID_A reservation_b=$RID_B"

curl -sf -X POST "http://localhost:3101/reservations/$RID_A/jobs" -H "$(auth_header "$BUYER_TOKEN")" \
  -H 'content-type: application/json' \
  -d "{\"image\":\"alpine:3.20\",\"command\":[\"/bin/sh\",\"-c\",\"echo p2p-demo\"],\"verify_against_reservation_id\":\"$RID_B\"}" >/dev/null
echo "OK: verification job submitted -- backend should now introduce the two nodes"

echo "== waiting for the platform-mediated introduction and the direct peer connection =="
for i in $(seq 1 20); do
  grep -q "introduced to peer $NODE_B" "$WORKER_A_LOG" 2>/dev/null && break
  sleep 0.5
done
grep -q "introduced to peer $NODE_B" "$WORKER_A_LOG" || { echo "FAIL: worker A was never introduced to worker B"; cat "$WORKER_A_LOG"; exit 1; }
INTRO_LINE=$(grep "introduced to peer $NODE_B" "$WORKER_A_LOG")
echo "OK: $INTRO_LINE"
echo "$INTRO_LINE" | grep -vq "no direct route" || { echo "FAIL: introduction carried no dialable address"; exit 1; }

for i in $(seq 1 20); do
  grep -q "PEER PING RESULT: True" "$WORKER_A_LOG" 2>/dev/null && break
  sleep 0.5
done
grep -q "PEER PING RESULT: True" "$WORKER_A_LOG" || { echo "FAIL: direct peer ping did not succeed"; cat "$WORKER_A_LOG"; exit 1; }
echo "OK: a real direct, mutually-authenticated TCP connection between two independent worker processes carried a real ping/pong"

grep -q "authenticated direct peer connection from $NODE_A" "$WORKER_B_LOG" || { echo "FAIL: worker B's listener never logged the authenticated connection"; cat "$WORKER_B_LOG"; exit 1; }
echo "OK: worker B's own listener independently confirms it authenticated worker A before answering"

echo
echo "ALL P2P DISCOVERY CHECKS PASSED"
