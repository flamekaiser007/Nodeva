"""Provider-local reservation ledger.

This is the authoritative record of what this node has committed to. The
platform's database is a cache of what we told it; THIS is the truth. If the
two disagree, this wins and the platform reconciles.

Concurrency is the whole point of this module. Two reservation requests for
overlapping slots can arrive at the same instant from different connections;
exactly one must win. That is enforced with a single IMMEDIATE transaction
wrapping the overlap check and the insert, so the check cannot go stale between
reading and writing.
"""

import sqlite3
import threading
import time
from pathlib import Path

HELD = "held"
CONFIRMED = "confirmed"
RUNNING = "running"
COMPLETED = "completed"
RELEASED = "released"

# States that occupy the slot. A released or completed reservation frees it.
LIVE = (HELD, CONFIRMED, RUNNING)

SCHEMA = """
CREATE TABLE IF NOT EXISTS local_reservations (
    reservation_id  TEXT PRIMARY KEY,
    starts_at       INTEGER NOT NULL,   -- epoch ms
    ends_at         INTEGER NOT NULL,
    price_paise_hr  INTEGER NOT NULL,
    status          TEXT    NOT NULL,
    -- After this instant we are entitled to release the slot, because the
    -- platform failed to commit. Only meaningful while status = 'held'.
    hold_expires_at INTEGER,
    created_at      INTEGER NOT NULL,
    CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_slot ON local_reservations (status, starts_at, ends_at);
"""


class SlotUnavailable(Exception):
    """The requested window overlaps something this node already committed to."""


class ReservationStore:
    """Thread-safe. One SQLite connection PER THREAD, never shared.

    A transaction is a property of a connection, not of a statement, so two
    threads issuing BEGIN IMMEDIATE on one shared connection collide with
    "cannot start a transaction within a transaction" — the second thread
    joins the first one's transaction instead of waiting for it. Sharing a
    connection with check_same_thread=False looks like it works right up until
    two reservations arrive at once, which is precisely the case that must not
    break. Hence thread-local connections and real SQLite file locking.
    """

    def __init__(self, db_path: Path, hold_ttl_seconds: int = 120):
        self.hold_ttl_ms = hold_ttl_seconds * 1000
        self._path = str(db_path)
        self._local = threading.local()
        self._connect().executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self._path, isolation_level=None, timeout=10.0)
            # WAL lets the heartbeat and status readers work while a reservation
            # write is in flight, instead of serializing everything.
            conn.execute("PRAGMA journal_mode=WAL")
            # Without this, a crash mid-transaction can leave a slot locked or
            # free depending on what the OS flushed. Durability matters more
            # than the write throughput we give up; this table sees a few
            # writes an hour.
            conn.execute("PRAGMA synchronous=FULL")
            # Contending writers wait for the lock rather than failing fast.
            conn.execute("PRAGMA busy_timeout=10000")
            self._local.conn = conn
        return conn

    @property
    def _db(self) -> sqlite3.Connection:
        return self._connect()

    @staticmethod
    def _now_ms() -> int:
        return int(time.time() * 1000)

    def _expire_stale(self, cur, now_ms: int) -> None:
        """Release holds the platform never committed. Called inside the lock."""
        cur.execute(
            "UPDATE local_reservations SET status=? "
            " WHERE status=? AND hold_expires_at IS NOT NULL AND hold_expires_at<=?",
            (RELEASED, HELD, now_ms),
        )

    def try_lock(self, reservation_id: str, starts_at: int, ends_at: int,
                 price_paise_hr: int) -> dict:
        """Atomically claim a window. Returns the receipt body to sign.

        Raises SlotUnavailable if it overlaps a live reservation.
        """
        if ends_at <= starts_at:
            raise ValueError("reservation window must be positive")
        now = self._now_ms()
        cur = self._db.cursor()
        # IMMEDIATE takes the write lock up front. With a deferred transaction,
        # two writers could both pass the overlap SELECT and then one would fail
        # at upgrade time — same outcome, but only by luck of retry behaviour.
        cur.execute("BEGIN IMMEDIATE")
        try:
            self._expire_stale(cur, now)

            # Half-open intervals: a booking ending at 11:00 does not conflict
            # with one starting at 11:00.
            conflict = cur.execute(
                f"SELECT reservation_id FROM local_reservations "
                f" WHERE status IN ({','.join('?' * len(LIVE))}) "
                f"   AND starts_at < ? AND ends_at > ? LIMIT 1",
                (*LIVE, ends_at, starts_at),
            ).fetchone()
            if conflict:
                raise SlotUnavailable(
                    f"window overlaps live reservation {conflict[0]}")

            hold_expires = now + self.hold_ttl_ms
            cur.execute(
                "INSERT INTO local_reservations "
                "(reservation_id,starts_at,ends_at,price_paise_hr,status,"
                " hold_expires_at,created_at) VALUES (?,?,?,?,?,?,?)",
                (reservation_id, starts_at, ends_at, price_paise_hr, HELD,
                 hold_expires, now),
            )
            cur.execute("COMMIT")
        except Exception:
            cur.execute("ROLLBACK")
            raise

        # Every field the platform checks in admitReceipt(). Integers only —
        # see canonical.py for why floats cannot appear in a signed body.
        return {
            "reservation_id": reservation_id,
            "starts_at": starts_at,
            "ends_at": ends_at,
            "price_paise_hr": price_paise_hr,
            "hold_expires_at": hold_expires,
            "issued_at": now,
        }

    def commit(self, reservation_id: str) -> bool:
        """Platform captured payment. Make the hold permanent.

        Refuses to commit an expired hold: by then we may have already given the
        slot away, and confirming would double-book.
        """
        now = self._now_ms()
        cur = self._db.cursor()
        cur.execute("BEGIN IMMEDIATE")
        try:
            row = cur.execute(
                "SELECT status,hold_expires_at FROM local_reservations "
                " WHERE reservation_id=?", (reservation_id,)).fetchone()
            if row is None or row[0] != HELD or (row[1] is not None and row[1] <= now):
                cur.execute("ROLLBACK")
                return False
            cur.execute(
                "UPDATE local_reservations SET status=?,hold_expires_at=NULL "
                " WHERE reservation_id=?", (CONFIRMED, reservation_id))
            cur.execute("COMMIT")
            return True
        except Exception:
            cur.execute("ROLLBACK")
            raise

    def release(self, reservation_id: str) -> None:
        self._db.execute(
            "UPDATE local_reservations SET status=? WHERE reservation_id=?",
            (RELEASED, reservation_id))

    def status_of(self, reservation_id: str):
        row = self._db.execute(
            "SELECT status FROM local_reservations WHERE reservation_id=?",
            (reservation_id,)).fetchone()
        return row[0] if row else None

    def live_count(self) -> int:
        now = self._now_ms()
        cur = self._db.cursor()
        cur.execute("BEGIN IMMEDIATE")
        self._expire_stale(cur, now)
        cur.execute("COMMIT")
        return self._db.execute(
            f"SELECT COUNT(*) FROM local_reservations "
            f" WHERE status IN ({','.join('?' * len(LIVE))})", LIVE).fetchone()[0]
