#!/usr/bin/env bash
# Real backup of the real Postgres database (docker-compose.yml's `postgres`
# service), using pg_dump's custom format (-Fc): compressed, and the only
# format pg_restore can selectively restore from or parallelize -- a plain
# SQL dump (`pg_dump > file.sql`) is a real alternative but loses both of
# those, and would need `psql < file.sql` instead of pg_restore below.
#
# HONEST LIMIT: this writes to a local directory. A real deployment ships
# the resulting file off-box immediately after (S3/GCS/etc.) -- a backup
# that lives only on the same disk as the database it backs up is not a
# backup against the failure mode that actually matters (disk/host loss),
# only against "I fat-fingered a DELETE". See docs/backup-restore.md.
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-backups}"
mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$BACKUP_DIR/nodeva-$TIMESTAMP.dump"

docker compose exec -T postgres pg_dump -U nodeva -d nodeva -Fc > "$OUT"

# pg_dump exits 0 even for some partial-failure cases (a permissions error
# on one object, for instance) if it can still produce output -- a dump
# that is 0 bytes or absent is the one failure mode worth checking for
# directly rather than trusting the exit code alone.
if [ ! -s "$OUT" ]; then
  echo "FAIL: backup produced an empty file: $OUT" >&2
  rm -f "$OUT"
  exit 1
fi

echo "$OUT"
