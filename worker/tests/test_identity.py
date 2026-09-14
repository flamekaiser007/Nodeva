"""Regression tests for a real, live-caught bug: NodeIdentity.load_or_create
never called .expanduser() on its path argument, so the literal
Path('~/.nodeva/node.pem') every doc and UI-printed CLI snippet in this
project uses was NEVER actually resolving to the real home directory --
pathlib does not expand `~` on its own. A provider running the printed
enrollment command from a different working directory each time silently
got a BRAND NEW random identity every time (a missing file at the
mis-resolved path is indistinguishable from "no identity yet"), not one
stable key -- defeating the entire point of a long-lived node identity.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nodeva_worker.identity import NodeIdentity


def test_a_tilde_path_resolves_under_the_real_home_directory(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    ident = NodeIdentity.load_or_create(Path("~/.nodeva/node.pem"))
    assert ident is not None
    # The key must actually land under $HOME, not a literal "~" directory
    # created in whatever the current working directory happened to be.
    assert (tmp_path / ".nodeva" / "node.pem").exists()
    assert not (Path.cwd() / "~").exists()


def test_the_same_tilde_path_returns_the_same_identity_regardless_of_cwd(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    first = NodeIdentity.load_or_create(Path("~/.nodeva/node.pem")).public_key_raw()

    # Simulate the exact real-world scenario that surfaced this bug: a
    # provider running the same copy-pasted command from a different shell
    # session, in a different directory.
    other_dir = tmp_path / "some" / "other" / "cwd"
    other_dir.mkdir(parents=True)
    monkeypatch.chdir(other_dir)

    second = NodeIdentity.load_or_create(Path("~/.nodeva/node.pem")).public_key_raw()
    assert first == second, "the same ~-prefixed path must be the same identity from any cwd"


def test_a_plain_absolute_path_is_unaffected(tmp_path):
    # expanduser() is a no-op on a path that never had a `~` in it --
    # existing callers passing an absolute Path (as every test fixture in
    # this suite already does) must keep working exactly as before.
    key_path = tmp_path / "node.pem"
    first = NodeIdentity.load_or_create(key_path).public_key_raw()
    second = NodeIdentity.load_or_create(key_path).public_key_raw()
    assert first == second
