"""Deterministic serialization for signed messages.

A signature is over BYTES, not over a dict. If the node serializes a receipt
one way and the platform re-serializes it another, the signature fails to
verify and a legitimate booking is rejected. Python and JavaScript disagree by
default in at least three ways, so this module pins all of them:

  * key order      -- dict iteration order is insertion order in both, but
                      neither guarantees it survives a round-trip. Sort keys.
  * whitespace     -- json.dumps defaults to ", " and ": " separators;
                      JSON.stringify emits none. Emit none.
  * float encoding -- json.dumps(1.0) -> "1.0" but JSON.stringify(1.0) -> "1".
                      There is no fix, so floats are simply forbidden below.

Consequence for callers: money is integer paise and timestamps are integer
epoch milliseconds. Neither is ever a float, which is what we wanted anyway.
"""

import json


class NonCanonicalValue(ValueError):
    """Raised for a value that cannot serialize identically across languages."""


def _check(value, path="$"):
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return
    if isinstance(value, int):
        # JS numbers lose integer precision past 2^53. A value beyond that would
        # verify on one side and not the other.
        if abs(value) > 2**53 - 1:
            raise NonCanonicalValue(
                f"{path}: integer {value} exceeds JS safe range; use a string"
            )
        return
    if isinstance(value, float):
        raise NonCanonicalValue(
            f"{path}: float {value!r} is not canonical across languages; "
            "use integer paise or epoch milliseconds"
        )
    if isinstance(value, dict):
        for k, v in value.items():
            if not isinstance(k, str):
                raise NonCanonicalValue(f"{path}: non-string key {k!r}")
            _check(v, f"{path}.{k}")
        return
    if isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            _check(v, f"{path}[{i}]")
        return
    raise NonCanonicalValue(f"{path}: unsupported type {type(value).__name__}")


def encode(body) -> bytes:
    """Serialize to the exact bytes both sides will sign and verify."""
    _check(body)
    return json.dumps(
        body, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
