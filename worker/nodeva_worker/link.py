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
from .hardware import detect_gpus, offerable_vram_mb, NoGpu
from .reservations import ReservationStore, SlotUnavailable

log = logging.getLogger("nodeva.worker.link")

HEARTBEAT_INTERVAL_S = 15
RECONNECT_BACKOFF_S = (1, 2, 5, 10, 30)  # capped exponential-ish backoff


class WorkerLink:
    def __init__(self, *, url: str, node_id: str, identity, store: ReservationStore,
                 price_paise_hr: int):
        self.url = url
        self.node_id = node_id
        self.identity = identity
        self.store = store
        self.price_paise_hr = price_paise_hr
        self._stop = asyncio.Event()

    def stop(self):
        self._stop.set()

    async def run_forever(self):
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

    async def _heartbeat_loop(self, ws):
        while True:
            gpu = None
            try:
                gpus = detect_gpus()
                g = gpus[0]
                gpu = {
                    "model": g.model,
                    "vram_free_mb": offerable_vram_mb(g),
                    "utilization_pct": g.utilization_pct,
                    "temperature_c": g.temperature_c,
                }
            except NoGpu:
                pass  # CPU-only node; heartbeat still proves liveness
            await ws.send(json.dumps({
                "type": "HEARTBEAT", "gpu": gpu,
                "live_reservations": self.store.live_count(),
            }))
            await asyncio.sleep(HEARTBEAT_INTERVAL_S)

    async def _message_loop(self, ws):
        async for raw in ws:
            msg = json.loads(raw)
            handler = {
                "RESERVE_REQUEST": self._on_reserve_request,
                "RESERVE_COMMIT": self._on_reserve_commit,
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
