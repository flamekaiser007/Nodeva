"""Direct node-to-node channel: Phase 2 P2P discovery, rendezvous style.

The platform is a signaling server here, nothing more: it tells two nodes
about each other (identity + a dialable address it observed, see
backend/src/ws/hub.js#introducePeers and protocol.js's PEER_INFO comment) and
then gets out of the way. The two nodes then talk to each other directly,
mutually authenticating with the SAME Ed25519 identity each already
registered with the platform -- "the trust artifact does not change, only
the transport" (docs/reservation-protocol.md).

Opt-in on both ends: a node that never configures a peer port never starts
PeerServer and never advertises one (see link.py), and is simply left out of
introductions (host/port: null) -- everything upstream of this module already
treats that as the normal, unremarkable case.

HONEST LIMIT, stated up front: this solves discovery and gives you a real,
authenticated socket to a peer that is directly reachable -- a public IP, a
port-forwarded home router, or another node on the same LAN/dev network. It
does NOT solve NAT traversal. A node behind a typical residential/CGNAT with
no port forwarding will simply fail to accept an inbound connection here,
the same way it always could not accept one from the platform (see
protocol.js's file header on why the worker dials OUT). Real NAT traversal
needs STUN/TURN-style relays and hole punching, which is a materially harder
problem this module does not attempt.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

log = logging.getLogger("nodeva.worker.peer")

NONCE_BYTES = 24
DEFAULT_TIMEOUT_S = 5.0


class PeerAuthError(Exception):
    """Raised when a would-be peer fails to prove the identity the platform
    said it should have. Always closes the connection; never partially
    trusted."""


def _verify(public_key_raw: bytes, message: bytes, signature_hex: str) -> bool:
    try:
        Ed25519PublicKey.from_public_bytes(public_key_raw).verify(
            bytes.fromhex(signature_hex), message
        )
        return True
    except (InvalidSignature, ValueError):
        return False


async def _read_json(reader: asyncio.StreamReader) -> dict | None:
    line = await reader.readline()
    if not line:
        return None
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return None


async def _write_json(writer: asyncio.StreamWriter, obj: dict) -> None:
    writer.write((json.dumps(obj) + "\n").encode("utf-8"))
    await writer.drain()


class PeerDirectory:
    """What the platform has told this node about other nodes, via PEER_INFO
    (see link.py's message-loop handler). This node never discovers a peer
    any other way -- no scanning, no gossip, no DHT. If the platform hasn't
    vouched for a node_id, PeerServer refuses a connection claiming to be it,
    full stop.
    """

    def __init__(self):
        self._peers: dict[str, dict] = {}

    def introduce(self, node_id: str, public_key_raw: bytes, host: str | None, port: int | None):
        self._peers[node_id] = {"public_key": public_key_raw, "host": host, "port": port}

    def get(self, node_id: str) -> dict | None:
        return self._peers.get(node_id)


class PeerConnection:
    """A live, mutually-authenticated channel to one specific peer node."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self._reader = reader
        self._writer = writer

    async def ping(self, timeout: float = DEFAULT_TIMEOUT_S) -> bool:
        await _write_json(self._writer, {"type": "PEER_PING"})
        resp = await asyncio.wait_for(_read_json(self._reader), timeout)
        return resp is not None and resp.get("type") == "PEER_PONG"

    async def close(self):
        self._writer.close()
        try:
            await self._writer.wait_closed()
        except Exception:
            pass


class PeerServer:
    """Accepts direct connections from other nodes the platform has
    introduced to this one. Never trusts a bare claim of identity: a
    connecting node must sign a fresh nonce with the private key matching
    whatever public key the platform already handed this node for that
    node_id.
    """

    def __init__(self, *, identity, node_id: str, directory: PeerDirectory):
        self._identity = identity
        self._node_id = node_id
        self._directory = directory
        self._servers: list[asyncio.base_events.Server] = []

    async def start(self, port: int = 0) -> int:
        """Starts listening on the SAME port on both IPv4 and IPv6; returns
        that port (useful when port=0 lets the OS pick one, both in
        production and in tests).

        Two separate sockets, not one dual-stack `host=None` bind -- a real,
        live-caught bug: `asyncio.start_server(host=None, port=0)` hands
        back one socket per address family, but with port=0 the OS assigns
        each socket an INDEPENDENT ephemeral port (confirmed on macOS: the
        IPv4 and IPv6 sockets got different port numbers), and there is
        only one `port` field in PEER_INFO to advertise. Binding only
        "0.0.0.0" (IPv4-only) was the first fix attempted here and is
        exactly as broken: the platform's own observed remoteAddress for a
        loopback connection on a dual-stack machine is "::1" (IPv6), which
        an IPv4-only listener silently refuses. This binds IPv4 first to
        learn (or accept) one concrete port, then binds IPv6 explicitly to
        that SAME port, so whichever family a peer's connection actually
        arrives over lands on a listener that is actually there."""
        s4 = await asyncio.start_server(self._handle, '0.0.0.0', port)
        bound_port = s4.sockets[0].getsockname()[1]
        self._servers = [s4]
        try:
            s6 = await asyncio.start_server(self._handle, '::', bound_port)
            self._servers.append(s6)
        except OSError:
            # Best-effort: a node with no IPv6 stack at all still works for
            # IPv4 peers, which is the common case this project's other NAT
            # discussion (docs/reservation-protocol.md) already centers on.
            log.warning("could not also bind IPv6 on port %s; IPv6 peers will not reach this node", bound_port)
        return bound_port

    async def stop(self):
        for server in self._servers:
            server.close()
            await server.wait_closed()
        self._servers = []

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        peer_addr = writer.get_extra_info("peername")
        try:
            hello = await asyncio.wait_for(_read_json(reader), DEFAULT_TIMEOUT_S)
            if hello is None or hello.get("type") != "PEER_HELLO":
                return
            claimed_id = hello.get("node_id")
            known = self._directory.get(claimed_id)
            if known is None:
                # The platform never introduced us to this node_id -- refuse
                # before spending a single cryptographic operation on it.
                log.warning("peer connection from %s claiming unknown node_id %s", peer_addr, claimed_id)
                return

            nonce1 = os.urandom(NONCE_BYTES)
            await _write_json(writer, {"type": "PEER_CHALLENGE", "nonce_hex": nonce1.hex()})
            resp1 = await asyncio.wait_for(_read_json(reader), DEFAULT_TIMEOUT_S)
            if resp1 is None or resp1.get("type") != "PEER_CHALLENGE_RESPONSE":
                return
            if not _verify(known["public_key"], nonce1, resp1.get("signature_hex", "")):
                log.warning("peer %s failed to prove claimed identity", claimed_id)
                return

            await _write_json(writer, {"type": "PEER_WELCOME", "node_id": self._node_id})

            # Mutual auth: the connector now challenges US, so it isn't just
            # trusting whoever answered on that host/port.
            their_challenge = await asyncio.wait_for(_read_json(reader), DEFAULT_TIMEOUT_S)
            if their_challenge is not None and their_challenge.get("type") == "PEER_CHALLENGE":
                sig = self._identity.sign_raw(bytes.fromhex(their_challenge["nonce_hex"]))
                await _write_json(writer, {"type": "PEER_CHALLENGE_RESPONSE", "signature_hex": sig.hex()})

            log.info("authenticated direct peer connection from %s", claimed_id)
            while True:
                msg = await _read_json(reader)
                if msg is None:
                    break
                if msg.get("type") == "PEER_PING":
                    await _write_json(writer, {"type": "PEER_PONG"})
        except (ConnectionError, asyncio.IncompleteReadError, asyncio.TimeoutError):
            pass
        finally:
            writer.close()


async def connect_to_peer(
    *, identity, my_node_id: str, peer_node_id: str, directory: PeerDirectory,
    timeout: float = DEFAULT_TIMEOUT_S,
) -> PeerConnection:
    """Dials a peer this node has already been introduced to (via PEER_INFO
    -> directory.introduce). Raises PeerAuthError if the peer cannot prove
    it is who the platform said it would be, or if there is nothing to dial
    (no host/port -- the peer never advertised one)."""
    known = directory.get(peer_node_id)
    if known is None:
        raise PeerAuthError(f"never introduced to {peer_node_id}")
    if known["host"] is None or known["port"] is None:
        raise PeerAuthError(f"no dialable address known for {peer_node_id}")

    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(known["host"], known["port"]), timeout)
    try:
        await _write_json(writer, {"type": "PEER_HELLO", "node_id": my_node_id})
        challenge = await asyncio.wait_for(_read_json(reader), timeout)
        if challenge is None or challenge.get("type") != "PEER_CHALLENGE":
            raise PeerAuthError("peer did not challenge us")
        sig = identity.sign_raw(bytes.fromhex(challenge["nonce_hex"]))
        await _write_json(writer, {"type": "PEER_CHALLENGE_RESPONSE", "signature_hex": sig.hex()})

        welcome = await asyncio.wait_for(_read_json(reader), timeout)
        if welcome is None or welcome.get("type") != "PEER_WELCOME" or welcome.get("node_id") != peer_node_id:
            raise PeerAuthError("peer did not welcome us as the node we expected")

        nonce2 = os.urandom(NONCE_BYTES)
        await _write_json(writer, {"type": "PEER_CHALLENGE", "nonce_hex": nonce2.hex()})
        resp2 = await asyncio.wait_for(_read_json(reader), timeout)
        if resp2 is None or resp2.get("type") != "PEER_CHALLENGE_RESPONSE":
            raise PeerAuthError("peer did not answer our challenge")
        if not _verify(known["public_key"], nonce2, resp2.get("signature_hex", "")):
            raise PeerAuthError("peer failed to prove its identity")

        return PeerConnection(reader, writer)
    except Exception:
        writer.close()
        raise
