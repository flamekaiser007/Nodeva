import sys, threading, tempfile, uuid
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from nodeva_worker.reservations import (
    ReservationStore, SlotUnavailable, HELD, CONFIRMED, RELEASED,
)

T0 = 1_789_000_000_000          # arbitrary epoch ms
HOUR = 3_600_000


@pytest.fixture
def store(tmp_path):
    return ReservationStore(tmp_path / "res.sqlite")


def test_first_lock_succeeds(store):
    body = store.try_lock("r1", T0, T0 + HOUR, 4300)
    assert body["reservation_id"] == "r1"
    assert body["hold_expires_at"] > body["issued_at"]
    assert store.status_of("r1") == HELD


def test_overlapping_lock_is_refused(store):
    store.try_lock("r1", T0, T0 + HOUR, 4300)
    with pytest.raises(SlotUnavailable):
        store.try_lock("r2", T0 + HOUR // 2, T0 + HOUR * 2, 4300)


def test_adjacent_slots_do_not_conflict(store):
    store.try_lock("r1", T0, T0 + HOUR, 4300)
    store.try_lock("r2", T0 + HOUR, T0 + HOUR * 2, 4300)   # must not raise
    assert store.live_count() == 2


def test_released_slot_can_be_rebooked(store):
    store.try_lock("r1", T0, T0 + HOUR, 4300)
    store.release("r1")
    store.try_lock("r2", T0, T0 + HOUR, 4300)
    assert store.status_of("r2") == HELD


def test_expired_hold_frees_the_slot(tmp_path):
    # TTL of 0 means the hold is stale the instant it is taken.
    s = ReservationStore(tmp_path / "res.sqlite", hold_ttl_seconds=0)
    s.try_lock("r1", T0, T0 + HOUR, 4300)
    s.try_lock("r2", T0, T0 + HOUR, 4300)      # platform never committed r1
    assert s.status_of("r1") == RELEASED
    assert s.status_of("r2") == HELD


def test_expired_hold_cannot_be_committed(tmp_path):
    # The "charged but not reserved" path. If the platform is late, it must not
    # be able to turn a lapsed hold into a confirmed booking.
    s = ReservationStore(tmp_path / "res.sqlite", hold_ttl_seconds=0)
    s.try_lock("r1", T0, T0 + HOUR, 4300)
    assert s.commit("r1") is False


def test_commit_makes_the_hold_permanent(store):
    store.try_lock("r1", T0, T0 + HOUR, 4300)
    assert store.commit("r1") is True
    assert store.status_of("r1") == CONFIRMED
    # A confirmed slot still blocks overlapping requests.
    with pytest.raises(SlotUnavailable):
        store.try_lock("r2", T0, T0 + HOUR, 4300)


def test_commit_is_not_replayable(store):
    store.try_lock("r1", T0, T0 + HOUR, 4300)
    assert store.commit("r1") is True
    assert store.commit("r1") is False, "second commit must be a no-op"


def test_concurrent_requests_for_the_same_slot_elect_one_winner(tmp_path):
    """The property the whole provider-authoritative design rests on.

    32 threads race for one window. If more than one wins, the node has
    double-booked and a user will arrive to find the GPU busy.
    """
    s = ReservationStore(tmp_path / "res.sqlite")
    barrier = threading.Barrier(32)
    winners, losers = [], []
    lock = threading.Lock()

    def attempt():
        rid = str(uuid.uuid4())
        barrier.wait()                      # maximize real contention
        try:
            s.try_lock(rid, T0, T0 + HOUR, 4300)
            with lock:
                winners.append(rid)
        except SlotUnavailable:
            with lock:
                losers.append(rid)

    threads = [threading.Thread(target=attempt) for _ in range(32)]
    for t in threads: t.start()
    for t in threads: t.join()

    assert len(winners) == 1, f"double-booked: {len(winners)} winners"
    assert len(losers) == 31
    assert s.live_count() == 1


def test_concurrent_requests_for_disjoint_slots_all_succeed(tmp_path):
    """Contention must not cause spurious rejections of bookable slots."""
    s = ReservationStore(tmp_path / "res.sqlite")
    barrier = threading.Barrier(16)
    ok = []
    lock = threading.Lock()

    def attempt(i):
        barrier.wait()
        try:
            s.try_lock(f"r{i}", T0 + i * HOUR, T0 + (i + 1) * HOUR, 4300)
            with lock:
                ok.append(i)
        except SlotUnavailable:
            pass

    threads = [threading.Thread(target=attempt, args=(i,)) for i in range(16)]
    for t in threads: t.start()
    for t in threads: t.join()

    assert len(ok) == 16, f"only {len(ok)}/16 disjoint slots booked"


def test_zero_length_window_rejected(store):
    with pytest.raises(ValueError):
        store.try_lock("r1", T0, T0, 4300)
