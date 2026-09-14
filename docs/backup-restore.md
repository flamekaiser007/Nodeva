# Backup and disaster recovery

The one authoritative store this project has is Postgres (see README.md's
own "The database is a search index over what nodes claim" framing --
still true, and still the thing that must survive a disk failure). Every
worker's SQLite reservation store is a LOCAL cache of its own commitments,
rebuildable by re-registering; losing one is an inconvenience for that
provider, not a platform-wide incident. This document is about the
Postgres database only.

## What exists today

- `scripts/db_backup.sh` -- runs `pg_dump -Fc` against the real
  `docker-compose.yml` `postgres` service, writing a timestamped file to
  `backups/` (gitignored -- these are real dumps of real data, plausibly
  containing real user emails and payment metadata, never something to
  commit).
- `scripts/db_restore.sh <dump-file>` -- drops and recreates the `public`
  schema, then `pg_restore`s the given file into it. Asks for an explicit
  `yes` unless called with `-y`, because this is one of the more dangerous
  commands in this repository: running it against the wrong database is a
  real, unrecoverable mistake.
- `scripts/backup_restore_demo.sh` -- the live proof that both of the above
  actually work: creates real data through the real HTTP API, backs it up,
  genuinely drops the schema (simulating a lost disk, not just "some rows
  deleted"), restores, and checks the exact same rows come back -- by
  value, not just by count -- and that the real dashboard endpoint can read
  them through the app's normal (unrestarted) connection pool.

## HONEST LIMIT: this is not yet a real disaster recovery posture

Running `db_backup.sh` writes a file next to the same database it backs
up. If the machine's disk fails, the backup fails with it -- this defends
against "someone ran a bad migration or a bad DELETE", not against the
failure mode DR actually exists for. A real deployment needs, at minimum:

1. **Off-box storage.** Ship the dump to S3/GCS/etc. immediately after
   `db_backup.sh` produces it, not manually and not later.
2. **A schedule.** Nothing here runs `db_backup.sh` on a cadence. A cron job
   or the hosting platform's own scheduled-task primitive, calling this
   script and then the upload step above.
3. **Retention.** How many backups to keep and for how long is a real
   decision (compliance, storage cost, how much data loss is tolerable)
   this project has not made yet.
4. **A tested RTO/RPO.** `backup_restore_demo.sh` proves the mechanism
   works on a small amount of data on one laptop in under a minute; it says
   nothing about how long a restore takes against a production-sized
   database, which is the number that actually matters when deciding how
   often to back up.
5. **Point-in-time recovery.** `pg_dump` only ever restores to the exact
   moment it ran. Recovering to "five minutes before the bad migration,
   not to last night's midnight dump" needs WAL archiving
   (`archive_command` + a base backup, or a managed service that already
   does this), which is a materially different and larger setup than what
   exists here.

None of the above is built. This document exists so that gap is written
down rather than discovered during an actual incident.

## Runbook: taking a backup

```bash
./scripts/db_backup.sh
# prints the path it wrote, e.g. backups/nodeva-20260101T120000Z.dump
```

Move that file off-box. What "off-box" means is deployment-specific and not
prescribed here.

## Runbook: restoring

**Before running this against anything but a local dev database, stop and
confirm you have the right target.** `db_restore.sh` drops the entire
`public` schema first.

```bash
./scripts/db_restore.sh backups/nodeva-20260101T120000Z.dump
# asks for confirmation; pass -y to skip it (e.g. from an already-reviewed
# automated runbook, never as a default habit)
```

After restoring, verify with a real read through the app (not just
`psql`) before declaring the incident over -- `backup_restore_demo.sh`'s
own last step, hitting `GET /providers/me/dashboard`, is the pattern to
follow: the database being queryable and the application being able to
correctly serve real requests off it are two different claims, and only
the second one is what users actually experience.
