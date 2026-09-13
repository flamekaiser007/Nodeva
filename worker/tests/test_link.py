"""Tests for WorkerLink's message handlers, against a real ReservationStore
(the local SQLite authority) and a fake `ws` that just records what got
sent -- no real network needed, since these handlers are pure
"read/mutate the local store, reply with JSON" logic.

Focused on the reconciliation handlers added alongside the platform's
RESERVATION_STATUS_QUERY / RESERVE_RELEASE messages (see
backend/src/ws/protocol.js and docs/reservation-protocol.md's failure
matrix, row 5) -- link.py's other handlers are already exercised live by
scripts/e2e_demo.sh.
"""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from nodeva_worker.link import WorkerLink
from nodeva_worker.reservations import ReservationStore, HELD, CONFIRMED, RELEASED

T0 = 1_800_000_000_000
HOUR = 3_600_000


class FakeWs:
    def __init__(self):
        self.sent = []

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    def last(self):
        return self.sent[-1]


class FakeIdentity:
    """link.py's constructor needs an identity object; these two handlers
    never touch it, so a stand-in that would loudly fail if it were called
    is more useful than a real keypair here."""
    def sign_body(self, body):
        raise AssertionError("status query / release must not sign anything")

    def sign_raw(self, data):
        raise AssertionError("status query / release must not sign anything")


@pytest.fixture
def link(tmp_path):
    store = ReservationStore(tmp_path / "res.sqlite")
    return WorkerLink(url="ws://unused", node_id="node-1", identity=FakeIdentity(),
                       store=store, price_paise_hr=4300)


def run(coro):
    return asyncio.run(coro)


def test_status_query_reports_held(link):
    link.store.try_lock("r1", T0, T0 + HOUR, 4300)
    ws = FakeWs()
    run(link._on_status_query(ws, {"reservation_id": "r1"}))
    assert ws.last() == {"type": "RESERVATION_STATUS", "reservation_id": "r1", "status": HELD}


def test_status_query_reports_confirmed_after_commit(link):
    link.store.try_lock("r1", T0, T0 + HOUR, 4300)
    link.store.commit("r1")
    ws = FakeWs()
    run(link._on_status_query(ws, {"reservation_id": "r1"}))
    assert ws.last()["status"] == CONFIRMED


def test_status_query_reports_null_for_an_unknown_reservation(link):
    # The exact scenario this protocol addition exists for: the platform
    # asks about a reservation_id it is unsure about. A clean null, not an
    # error, not a crash.
    ws = FakeWs()
    run(link._on_status_query(ws, {"reservation_id": "never-heard-of-it"}))
    assert ws.last() == {"type": "RESERVATION_STATUS", "reservation_id": "never-heard-of-it", "status": None}


def test_release_frees_a_confirmed_hold_unconditionally(link):
    link.store.try_lock("r1", T0, T0 + HOUR, 4300)
    link.store.commit("r1")
    assert link.store.status_of("r1") == CONFIRMED

    ws = FakeWs()
    run(link._on_release(ws, {"reservation_id": "r1"}))

    assert link.store.status_of("r1") == RELEASED
    assert ws.last() == {"type": "RELEASE_ACK", "reservation_id": "r1"}


def test_release_of_an_already_released_or_unknown_reservation_still_acks(link):
    # Unconditional per the handler's own contract -- the platform has
    # already decided this is over; the node's job is to agree, not argue,
    # even if there was nothing to release in the first place.
    ws = FakeWs()
    run(link._on_release(ws, {"reservation_id": "was-never-here"}))
    assert ws.last() == {"type": "RELEASE_ACK", "reservation_id": "was-never-here"}


def test_release_frees_the_slot_for_a_real_rebooking(link):
    # Proves the release actually has the effect the whole feature exists
    # for: an orphaned CONFIRMED hold released via this path must stop
    # blocking the window it occupied.
    link.store.try_lock("r1", T0, T0 + HOUR, 4300)
    link.store.commit("r1")

    run(link._on_release(FakeWs(), {"reservation_id": "r1"}))

    body = link.store.try_lock("r2", T0, T0 + HOUR, 4300)  # must not raise
    assert body["reservation_id"] == "r2"
