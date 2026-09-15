"""Backend connection: the worker's half of the wire protocol.

Dials OUT to the platform and stays connected — see backend/src/ws/protocol.js
for why. Everything here is one asyncio task per concern (connection loop,
heartbeat loop) so a stuck reservation handler cannot silently stop
heartbeats, which would make an online node look dead.
"""

import asyncio
import json
import logging
import time

import websockets

from .canonical import encode
from .executor import JobSpec, run_job, DockerUnavailable
from .hardware import detect_gpus, offerable_vram_mb, detect_cpu_cores, detect_ram_mb, NoGpu
from .reservations import ReservationStore, SlotUnavailable, CONFIRMED, RUNNING
from .peer import PeerServer, PeerDirectory

log = logging.getLogger("nodeva.worker.link")

HEARTBEAT_INTERVAL_S = 15
RECONNECT_BACKOFF_S = (1, 2, 5, 10, 30)  # capped exponential-ish backoff


class WorkerLink:
    def __init__(self, *, url: str, node_id: str, identity, store: ReservationStore,
                 price_paise_hr: int, peer_port: int | None = None):
        """`peer_port` opts this node into direct peer connections (Phase 2
        P2P discovery, see peer.py) -- None (the default) means this node
        never listens for one and is only ever discoverable by identity, not
        dialable. Pass 0 to let the OS pick a free port, or a specific port
        if it needs to match a router's port-forwarding rule."""
        self.url = url
        self.node_id = node_id
        self.identity = identity
        self.store = store
        self.price_paise_hr = price_paise_hr
        self.peer_port = peer_port
        self.peer_directory = PeerDirectory()
        self._peer_server = PeerServer(identity=identity, node_id=node_id, directory=self.peer_directory) \
            if peer_port is not None else None
        self._peer_server_bound_port: int | None = None
        self._stop = asyncio.Event()

    def stop(self):
        self._stop.set()

    async def run_forever(self):
        if self._peer_server is not None:
            # Started once, independent of the platform connection's own
            # reconnect loop below -- a peer that already has our address
            # from an earlier introduction should still be able to reach us
            # while we're between platform reconnect attempts.
            self._peer_server_bound_port = await self._peer_server.start(port=self.peer_port)
            log.info("listening for direct peer connections on port %s", self._peer_server_bound_port)
        try:
            attempt = 0
            while not self._stop.is_set():
                try:
                    async with websockets.connect(self.url, ping_interval=20) as ws:
                        log.info("connected to %s", self.url)
                        attempt = 0
                        await self._session(ws)
                except (websockets.ConnectionClosed, OSError) as e:
                    log.warning("connection lost: %s", e)
                if self._stop.is_set():
                    break
                delay = RECONNECT_BACKOFF_S[min(attempt, len(RECONNECT_BACKOFF_S) - 1)]
                attempt += 1
                log.info("reconnecting in %ss", delay)
                await asyncio.sleep(delay)
        finally:
            if self._peer_server is not None:
                await self._peer_server.stop()

    async def _session(self, ws):
        await self._authenticate(ws)
        async with asyncio.TaskGroup() as tg:
            tg.create_task(self._heartbeat_loop(ws))
            tg.create_task(self._message_loop(ws))
            tg.create_task(self._stop_waiter(ws))

    async def _stop_waiter(self, ws):
        await self._stop.wait()
        await ws.close()

    async def _authenticate(self, ws):
        await ws.send(json.dumps({"type": "HELLO", "node_id": self.node_id}))
        challenge = json.loads(await ws.recv())
        if challenge["type"] != "CHALLENGE":
            raise RuntimeError(f"expected CHALLENGE, got {challenge['type']}")
        # Sign the raw nonce bytes as sent, not a re-encoded copy — the backend
        # verifies against exactly the string it generated.
        sig = self.identity.sign_raw(challenge["nonce"].encode("utf-8"))
        await ws.send(json.dumps({"type": "CHALLENGE_RESPONSE", "signature_hex": sig.hex()}))
        reply = json.loads(await ws.recv())
        if reply["type"] != "WELCOME":
            raise RuntimeError(f"auth rejected: {reply.get('reason', reply['type'])}")
        log.info("authenticated as %s", self.node_id)

        if self._peer_server_bound_port is not None:
            # Resent on every (re)connect: a fresh WebSocket is a fresh
            # source address as far as the platform's own observation of us
            # is concerned (see hub.js's remoteAddress), even though the
            # port we listen on ourselves hasn't changed.
            await ws.send(json.dumps({"type": "PEER_ADDR", "peer_port": self._peer_server_bound_port}))

    def _build_heartbeat(self):
        """Pulled out of the send/sleep loop below so it's directly
        testable -- a `while True` body has no way to assert against a
        single message without either mocking asyncio.sleep or letting a
        test hang. Self-reported, same as everything else in hardware.py --
        lets the platform flag an HONEST mismatch against the enrollment
        form's claim (upgraded hardware, a typo, a swapped GPU), not a
        security check (see hardware.py's file header for why one isn't
        possible here)."""
        gpu = None
        try:
            gpus = detect_gpus()
            g = gpus[0]
            gpu = {
                "model": g.model,
                "vram_total_mb": g.vram_total_mb,
                "vram_free_mb": offerable_vram_mb(g),
                "utilization_pct": g.utilization_pct,
                "temperature_c": g.temperature_c,
            }
        except NoGpu:
            pass  # CPU-only node; heartbeat still proves liveness
        return {
            "type": "HEARTBEAT", "gpu": gpu,
            "cpu_cores": detect_cpu_cores(),
            "ram_mb": detect_ram_mb(),
            "live_reservations": self.store.live_count(),
        }

    async def _heartbeat_loop(self, ws):
        # A real, live-caught bug (found running run_worker.py as an actual
        # long-lived process for the first time, not a short-lived test):
        # _stop_waiter closing `ws` races this loop's own sleep/send cycle.
        # _message_loop's `async for raw in ws` ends silently when that
        # happens, but this loop's next ws.send() raises ConnectionClosedOK
        # instead -- and because both run inside the same TaskGroup
        # (_session), that one exception turned every clean Ctrl+C shutdown
        # into an ugly ExceptionGroup traceback. A closed connection here
        # is exactly as expected an outcome as it is in _message_loop; it
        # ends this task the same quiet way.
        while True:
            try:
                await ws.send(json.dumps(self._build_heartbeat()))
            except websockets.ConnectionClosed:
                return
            await asyncio.sleep(HEARTBEAT_INTERVAL_S)

    async def _message_loop(self, ws):
        async for raw in ws:
            msg = json.loads(raw)
            handler = {
                "RESERVE_REQUEST": self._on_reserve_request,
                "RESERVE_COMMIT": self._on_reserve_commit,
                "JOB_SUBMIT": self._on_job_submit,
                "RESERVATION_STATUS_QUERY": self._on_status_query,
                "RESERVE_RELEASE": self._on_release,
                "PEER_INFO": self._on_peer_info,
            }.get(msg["type"])
            if handler is None:
                log.warning("unhandled message type %s", msg["type"])
                continue
            await handler(ws, msg)

    async def _on_reserve_request(self, ws, msg):
        rid = msg["reservation_id"]
        try:
            body = self.store.try_lock(
                rid, msg["starts_at"], msg["ends_at"], self.price_paise_hr)
        except SlotUnavailable as e:
            await ws.send(json.dumps({
                "type": "DENY", "reservation_id": rid, "reason": "slot_taken"}))
            log.info("denied %s: %s", rid, e)
            return
        except ValueError as e:
            await ws.send(json.dumps({
                "type": "DENY", "reservation_id": rid, "reason": "invalid_window"}))
            log.info("denied %s: %s", rid, e)
            return

        body["node_id"] = self.node_id
        sig = self.identity.sign_body(body)
        await ws.send(json.dumps({
            "type": "RECEIPT", "reservation_id": rid,
            "body": body, "signature_hex": sig.hex(),
        }))
        log.info("locked and signed receipt for %s", rid)

    async def _on_reserve_commit(self, ws, msg):
        rid = msg["reservation_id"]
        ok = self.store.commit(rid)
        await ws.send(json.dumps({
            "type": "COMMITTED" if ok else "COMMIT_FAILED",
            "reservation_id": rid,
            **({} if ok else {"reason": "hold_expired_or_unknown"}),
        }))
        log.info("commit %s for %s", "accepted" if ok else "REJECTED", rid)

    async def _on_status_query(self, ws, msg):
        rid = msg["reservation_id"]
        status = self.store.status_of(rid)
        await ws.send(json.dumps({
            "type": "RESERVATION_STATUS", "reservation_id": rid, "status": status,
        }))
        log.info("reported status %s for %s", status, rid)

    async def _on_release(self, ws, msg):
        # Unconditional, deliberately: the platform asking for a release
        # means it has already decided this reservation is not going
        # forward on its side (see docs/reservation-protocol.md's failure
        # matrix, row 5). The node's job here is to agree, not to argue --
        # refusing would leave the slot permanently squatted on by a
        # reservation the platform has no way to act on any more.
        rid = msg["reservation_id"]
        self.store.release(rid)
        await ws.send(json.dumps({"type": "RELEASE_ACK", "reservation_id": rid}))
        log.info("released %s on platform request", rid)

    async def _on_peer_info(self, ws, msg):
        # Unsolicited, pushed only when the platform has a concrete reason
        # (today: a duplicate-execution verification pairing) -- this node
        # never asked for it and cannot ask for one about an arbitrary
        # node_id. Recording it is all this does; nothing here dials out on
        # its own, since not every caller wants that (see peer.py's
        # connect_to_peer for the piece that actually would).
        self.peer_directory.introduce(
            msg["node_id"], bytes.fromhex(msg["public_key_hex"]), msg.get("host"), msg.get("port"))
        log.info("introduced to peer %s (%s)", msg["node_id"],
                  f"{msg.get('host')}:{msg.get('port')}" if msg.get("port") else "no direct route")

    async def _on_job_submit(self, ws, msg):
        job_id = msg["job_id"]
        rid = msg["reservation_id"]

        # Refuse to run anything against a reservation this node has not
        # itself confirmed as paid -- the local reservation ledger is the
        # authority here too, exactly as it is for booking. A platform bug
        # (or a compromised platform) asking us to run a job for a
        # reservation we never confirmed must not be honoured just because
        # it arrived over an authenticated connection.
        status = self.store.status_of(rid)
        if status not in (CONFIRMED, RUNNING):
            await ws.send(json.dumps({
                "type": "JOB_REJECTED", "job_id": job_id,
                "reason": f"reservation not confirmed locally (status={status})",
            }))
            log.warning("rejected job %s: reservation %s status=%s", job_id, rid, status)
            return

        await ws.send(json.dumps({"type": "JOB_ACCEPTED", "job_id": job_id}))
        log.info("accepted job %s for reservation %s", job_id, rid)

        # Run in a worker thread: run_job() blocks on real wall-clock time
        # waiting for the container, potentially for hours, and must not
        # stall the heartbeat loop on this same event loop.
        asyncio.create_task(self._run_and_report(ws, job_id, msg))

    async def _run_and_report(self, ws, job_id, msg):
        spec = JobSpec(
            image=msg["image"],
            command=msg["command"],
            timeout_seconds=msg.get("timeout_seconds", 3600),
            env=msg.get("env") or {},
            gpu_device_ids=msg.get("gpu") or [],
        )
        try:
            result = await asyncio.to_thread(run_job, spec)
            payload = {
                "type": "JOB_RESULT", "job_id": job_id,
                "status": result.status, "exit_code": result.exit_code,
                "stdout": result.stdout, "stderr": result.stderr,
                "duration_seconds": result.duration_seconds,
            }
        except DockerUnavailable as e:
            payload = {
                "type": "JOB_RESULT", "job_id": job_id,
                "status": "error", "exit_code": None,
                "stdout": "", "stderr": str(e), "duration_seconds": 0,
            }
        try:
            await ws.send(json.dumps(payload))
        except Exception:
            # Connection dropped mid-job. The platform's own reconciliation
            # (heartbeat/offline detection) is what recovers from this, not
            # a retry here -- by the time we could retry, a fresh connection
            # would need re-authentication anyway.
            log.exception("failed to report result for job %s; connection likely dropped", job_id)
        log.info("job %s finished: %s", job_id, payload["status"])
