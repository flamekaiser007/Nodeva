#!/usr/bin/env bash
# Restores a backup produced by scripts/db_backup.sh into the real Postgres
# database. Destructive by nature -- this DROPs and recreates the public
# schema before restoring, the same "known clean slate" approach
# scripts/e2e_demo.sh and scripts/p2p_demo.sh already use before a fresh
# migration run, applied here to a fresh RESTORE instead. Requires
# explicit confirmation unless -y is passed, precisely because "restore a
# backup" is the kind of command that is very easy to run against the
# wrong environment by mistake.
#
# Usage: ./scripts/db_restore.sh path/to/nodeva-<timestamp>.dump [-y]
set -euo pipefail
cd "$(dirname "$0")/.."

DUMP_FILE="${1:?usage: db_restore.sh <dump-file> [-y]}"
[ -f "$DUMP_FILE" ] || { echo "FAIL: $DUMP_FILE does not exist" >&2; exit 1; }
CONFIRM="${2:-}"

if [ "$CONFIRM" != "-y" ]; then
  echo "This will DROP and replace every table in the 'nodeva' database with the contents of:"
  echo "  $DUMP_FILE"
  read -r -p "Type 'yes' to continue: " ANSWER
  [ "$ANSWER" = "yes" ] || { echo "Aborted."; exit 1; }
fi

docker compose exec -T postgres psql -U nodeva -d nodeva -q -c \
  "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

docker compose exec -T postgres pg_restore -U nodeva -d nodeva --no-owner --no-privileges \
  < "$DUMP_FILE"

echo "restored from $DUMP_FILE"
