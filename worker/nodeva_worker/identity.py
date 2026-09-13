"""Node identity: a long-lived Ed25519 keypair.

The private key never leaves the provider's machine. The public key is
registered with the platform once at enrollment, and every receipt the node
signs afterwards is verifiable against it.

This is what lets a provider dispute a booking they never agreed to: without a
node signature, a buggy or compromised platform could assert any reservation it
liked and the provider would have no evidence to the contrary.
"""

import os
import stat
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from .canonical import encode


class NodeIdentity:
    def __init__(self, private_key: Ed25519PrivateKey):
        self._sk = private_key

    @classmethod
    def load_or_create(cls, path: Path) -> "NodeIdentity":
        path = Path(path)
        if path.exists():
            # Refuse to use a key other users on the box can read. On a shared
            # workstation this is the difference between a node identity and a
            # stolen one.
            mode = stat.S_IMODE(path.stat().st_mode)
            if mode & 0o077:
                raise PermissionError(
                    f"{path} is mode {mode:o}; private key must not be "
                    f"group/world readable (chmod 600)"
                )
            sk = serialization.load_pem_private_key(path.read_bytes(), password=None)
            if not isinstance(sk, Ed25519PrivateKey):
                raise TypeError(f"{path} is not an Ed25519 private key")
            return cls(sk)

        sk = Ed25519PrivateKey.generate()
        pem = sk.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        # Create with restrictive permissions from the start rather than
        # chmod-ing after: no window where the key sits world-readable.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(pem)
        return cls(sk)

    def public_key_raw(self) -> bytes:
        """32 raw bytes, the form stored in compute_nodes.public_key."""
        return self._sk.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )

    def sign_body(self, body: dict) -> bytes:
        return self._sk.sign(encode(body))

    def sign_raw(self, data: bytes) -> bytes:
        """Sign bytes directly, bypassing canonical encoding.

        For values that are not themselves a canonical JSON body — the auth
        challenge nonce is a bare string the backend generates and compares
        byte-for-byte, not a dict, so running it through encode() would sign
        the wrong bytes (a quoted JSON string) and fail to verify.
        """
        return self._sk.sign(data)


def verify_body(public_key_raw: bytes, body: dict, signature: bytes) -> bool:
    from cryptography.exceptions import InvalidSignature

    try:
        Ed25519PublicKey.from_public_bytes(public_key_raw).verify(
            signature, encode(body)
        )
        return True
    except InvalidSignature:
        return False
