"""Real localhost TCP connections between two PeerServer/connect_to_peer
pairs -- not mocked sockets. This is the same trust level as the rest of
this project's "live verified" claims: two real asyncio servers, real
Ed25519 signatures, a real accept() and connect(). What it deliberately does
NOT prove is NAT traversal (see peer.py's own file header) -- localhost has
no NAT to traverse, which is exactly the honest boundary of what this module
solves.
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from nodeva_worker.peer import (
    PeerServer, PeerDirectory, PeerAuthError, connect_to_peer,
)


class FakeIdentity:
    """Same shape as NodeIdentity (identity.py) but without touching disk --
    peer.py only ever calls sign_raw on whatever identity it's given."""

    def __init__(self):
        self._sk = Ed25519PrivateKey.generate()

    def public_key_raw(self) -> bytes:
        from cryptography.hazmat.primitives import serialization
        return self._sk.public_key().public_bytes(
            encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw)

    def sign_raw(self, data: bytes) -> bytes:
        return self._sk.sign(data)


def run(coro):
    return asyncio.run(coro)


async def _make_pair():
    """Two identities, each told (via a PeerDirectory, standing in for the
    platform's PEER_INFO push) about the other -- the precondition for
    either side to accept or dial the other at all."""
    id_a, id_b = FakeIdentity(), FakeIdentity()
    dir_a, dir_b = PeerDirectory(), PeerDirectory()
    server_b = PeerServer(identity=id_b, node_id="node-b", directory=dir_b)
    port_b = await server_b.start(port=0)
    dir_a.introduce("node-b", id_b.public_key_raw(), "127.0.0.1", port_b)
    dir_b.introduce("node-a", id_a.public_key_raw(), None, None)  # b never dials out in these tests
    return id_a, dir_a, server_b


def test_a_real_direct_connection_authenticates_both_ways_and_pings():
    async def scenario():
        id_a, dir_a, server_b = await _make_pair()
        try:
            conn = await connect_to_peer(
                identity=id_a, my_node_id="node-a", peer_node_id="node-b", directory=dir_a)
            try:
                assert await conn.ping() is True
            finally:
                await conn.close()
        finally:
            await server_b.stop()
    run(scenario())


def test_connector_is_refused_if_the_listener_never_heard_of_it():
    async def scenario():
        id_a = FakeIdentity()
        id_b = FakeIdentity()
        dir_a, dir_b = PeerDirectory(), PeerDirectory()
        # b's directory has nothing about "node-a" -- the platform never
        # introduced them, unlike the happy path above.
        server_b = PeerServer(identity=id_b, node_id="node-b", directory=dir_b)
        port_b = await server_b.start(port=0)
        dir_a.introduce("node-b", id_b.public_key_raw(), "127.0.0.1", port_b)
        try:
            with pytest.raises(PeerAuthError):
                await connect_to_peer(
                    identity=id_a, my_node_id="node-a", peer_node_id="node-b", directory=dir_a)
        finally:
            await server_b.stop()
    run(scenario())


def test_an_impostor_who_knows_the_node_id_but_not_the_private_key_is_rejected():
    async def scenario():
        id_a = FakeIdentity()
        impostor = FakeIdentity()  # claims to be node-a but signs with the wrong key
        id_b = FakeIdentity()
        dir_a, dir_b = PeerDirectory(), PeerDirectory()
        server_b = PeerServer(identity=id_b, node_id="node-b", directory=dir_b)
        port_b = await server_b.start(port=0)
        dir_a.introduce("node-b", id_b.public_key_raw(), "127.0.0.1", port_b)
        # b was told the REAL node-a's public key, not the impostor's.
        dir_b.introduce("node-a", id_a.public_key_raw(), None, None)
        try:
            with pytest.raises(PeerAuthError):
                await connect_to_peer(
                    identity=impostor, my_node_id="node-a", peer_node_id="node-b", directory=dir_a)
        finally:
            await server_b.stop()
    run(scenario())


def test_dialing_a_peer_with_no_known_address_fails_fast_without_a_socket():
    async def scenario():
        id_a = FakeIdentity()
        dir_a = PeerDirectory()
        dir_a.introduce("node-b", b"\x00" * 32, None, None)  # never advertised a port
        with pytest.raises(PeerAuthError):
            await connect_to_peer(
                identity=id_a, my_node_id="node-a", peer_node_id="node-b", directory=dir_a)
    run(scenario())


def test_dialing_a_peer_never_introduced_fails_fast():
    async def scenario():
        id_a = FakeIdentity()
        dir_a = PeerDirectory()
        with pytest.raises(PeerAuthError):
            await connect_to_peer(
                identity=id_a, my_node_id="node-a", peer_node_id="node-b", directory=dir_a)
    run(scenario())


def test_the_same_advertised_port_accepts_both_an_ipv4_and_an_ipv6_loopback_connection():
    # The real bug caught by scripts/p2p_demo.sh: a listener bound only to
    # 0.0.0.0 silently refused a peer whose platform-observed address was
    # "::1" (IPv6 loopback) -- which is exactly what happens on a
    # dual-stack machine, not an exotic edge case.
    async def scenario():
        identity = FakeIdentity()
        directory = PeerDirectory()
        server = PeerServer(identity=identity, node_id="node-b", directory=directory)
        port = await server.start(port=0)
        try:
            r4, w4 = await asyncio.open_connection("127.0.0.1", port)
            w4.close()
            await w4.wait_closed()
            r6, w6 = await asyncio.open_connection("::1", port)
            w6.close()
            await w6.wait_closed()
        finally:
            await server.stop()
    run(scenario())


def test_two_independent_direct_connections_can_both_ping_concurrently():
    """Not just one request-response -- proves the listener's accept loop
    keeps serving after the first connection, and that ping/pong survives
    two peers hammering it at once."""
    async def scenario():
        id_a, dir_a, server_b = await _make_pair()
        try:
            conns = await asyncio.gather(*[
                connect_to_peer(identity=id_a, my_node_id="node-a", peer_node_id="node-b", directory=dir_a)
                for _ in range(3)
            ])
            results = await asyncio.gather(*[c.ping() for c in conns])
            assert results == [True, True, True]
            await asyncio.gather(*[c.close() for c in conns])
        finally:
            await server_b.stop()
    run(scenario())
