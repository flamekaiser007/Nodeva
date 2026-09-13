"""Emit signed-receipt fixtures for the Node-side interop test.

Regenerate with:
    .venv/bin/python worker/tools/gen_interop_fixture.py

If a change to either canonical encoder breaks interop, the Node test that
consumes this file fails — which is the point. The fixture is committed so the
backend test suite does not need a Python toolchain to run.
"""
import json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nodeva_worker.identity import NodeIdentity
from nodeva_worker.canonical import encode
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

# Fixed seed so the fixture is reproducible and diffs stay readable.
sk = Ed25519PrivateKey.from_private_bytes(bytes(range(32)))
ident = NodeIdentity(sk)

body = {
    "reservation_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    "node_id": "44444444-4444-4444-4444-444444444444",
    "starts_at": 1789000000000,
    "ends_at": 1789003600000,
    "price_paise_hr": 4300,
    "hold_expires_at": 1789000120000,
    "issued_at": 1789000000000,
}

# Non-ASCII and key-ordering torture case: if either side mishandles unicode
# escaping or sorts differently, these signatures will not verify.
tricky = {
    "z_last": 1,
    "a_first": "ok",
    "unicode": "प्रदाता ₹43 — naïve",
    "nested": {"b": [1, 2, {"d": False, "c": None}], "a": True},
    "big_int": 9007199254740991,
}

out = {
    "public_key_hex": ident.public_key_raw().hex(),
    "cases": [
        {"name": "reservation_receipt", "body": body,
         "canonical": encode(body).decode(),
         "signature_hex": ident.sign_body(body).hex()},
        {"name": "unicode_and_ordering", "body": tricky,
         "canonical": encode(tricky).decode(),
         "signature_hex": ident.sign_body(tricky).hex()},
    ],
}
dest = Path(__file__).resolve().parents[2] / "backend/test/fixtures/interop.json"
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
print(f"wrote {dest}")
