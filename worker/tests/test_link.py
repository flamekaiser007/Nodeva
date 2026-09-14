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


# --- heartbeat content -------------------------------------------------

def test_heartbeat_reports_real_cpu_and_ram_alongside_gpu_and_liveness(link, monkeypatch):
    # Proves the message WorkerLink actually sends has the shape
    # api/server.js's onHeartbeat expects -- a unit test on hardware.py's
    # detect_cpu_cores/detect_ram_mb alone wouldn't catch a mistake in how
    # link.py wires them into this message.
    import nodeva_worker.link as link_module
    monkeypatch.setattr(link_module, "detect_cpu_cores", lambda: 16)
    monkeypatch.setattr(link_module, "detect_ram_mb", lambda: 32768)
    monkeypatch.setattr(link_module, "detect_gpus", lambda: (_ for _ in ()).throw(link_module.NoGpu("no gpu")))

    msg = link._build_heartbeat()
    assert msg["type"] == "HEARTBEAT"
    assert msg["cpu_cores"] == 16
    assert msg["ram_mb"] == 32768
    assert msg["gpu"] is None
    assert msg["live_reservations"] == 0


def test_heartbeat_includes_total_vram_alongside_free_vram(link, monkeypatch):
    # vram_free_mb already existed for live availability; vram_total_mb is
    # what lets the backend compare against the node's ENROLLED
    # gpu_vram_mb claim, which free VRAM alone can't do (free VRAM is
    # always less than total, by design -- comparing it to the enrollment
    # claim would flag every honest node as a mismatch).
    import nodeva_worker.link as link_module
    from nodeva_worker.hardware import GpuInfo
    monkeypatch.setattr(link_module, "detect_cpu_cores", lambda: 8)
    monkeypatch.setattr(link_module, "detect_ram_mb", lambda: 16384)
    monkeypatch.setattr(
        link_module, "detect_gpus",
        lambda: [GpuInfo("RTX 4090", 24564, 1832, 31, 47, 371, "550.54.14")])

    msg = link._build_heartbeat()
    assert msg["gpu"]["vram_total_mb"] == 24564
    assert msg["gpu"]["vram_free_mb"] == 24564 - 1832 - 1024


# --- P2P discovery (peer.py) wiring -------------------------------------

def test_peer_discovery_is_off_by_default(link):
    # peer_port defaults to None -- a node that never opts in never listens
    # for direct connections at all, matching the off-by-default pattern
    # every other opt-in capability in this project follows.
    assert link.peer_port is None
    assert link._peer_server is None


def test_configuring_a_peer_port_creates_a_server_but_does_not_start_it_yet():
    from pathlib import Path
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        store = ReservationStore(Path(d) / "res.sqlite")
        l = WorkerLink(url="ws://unused", node_id="node-1", identity=FakeIdentity(),
                        store=store, price_paise_hr=4300, peer_port=0)
        assert l._peer_server is not None
        # start() itself is only called from run_forever -- constructing a
        # WorkerLink must never open a socket as a side effect.
        assert l._peer_server_bound_port is None


def test_peer_info_from_the_platform_is_recorded_in_the_directory(link):
    ws = FakeWs()
    run(link._on_peer_info(ws, {
        "node_id": "node-2", "public_key_hex": "ab" * 32, "host": "203.0.113.5", "port": 41000,
    }))
    known = link.peer_directory.get("node-2")
    assert known == {"public_key": bytes.fromhex("ab" * 32), "host": "203.0.113.5", "port": 41000}
    # A pure record -- nothing is sent back to the platform for this.
    assert ws.sent == []


def test_peer_info_with_no_dialable_route_is_still_recorded(link):
    # host/port: null means "we know who this node is, but not how to reach
    # it directly" -- e.g. the sibling never advertised a peer port. Still
    # worth recording: connect_to_peer's own job is to fail fast on this,
    # not this handler's.
    run(link._on_peer_info(FakeWs(), {
        "node_id": "node-3", "public_key_hex": "cd" * 32, "host": None, "port": None,
    }))
    assert link.peer_directory.get("node-3")["port"] is None
