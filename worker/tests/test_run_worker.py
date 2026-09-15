"""Tests for run_worker.py's argument parsing and object wiring -- the part
that can be tested without a real event loop or a real network connection.
main()'s own run_forever()/signal-handling loop is exercised live instead
(see scripts/e2e_demo.sh and friends, which all construct a WorkerLink the
same way this CLI does now); it is not something a unit test meaningfully
covers beyond what build_link already does.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
from run_worker import parse_args, build_link
from nodeva_worker.link import WorkerLink


def test_required_arguments_are_actually_required():
    with pytest.raises(SystemExit):
        parse_args([])  # missing --node-id and --price-paise-hr


def test_defaults_match_the_enrollment_snippet_the_dashboard_prints():
    # worker/nodeva_worker/hardware.py and the "My Machines" CLI snippet
    # both use ~/.nodeva/node.pem -- these two must never drift apart, or
    # a provider following the enrollment instructions and then this
    # script's --help would end up with two DIFFERENT identity files.
    args = parse_args(["--node-id", "abc", "--price-paise-hr", "4300"])
    assert args.identity_path == str(Path.home() / ".nodeva" / "node.pem")
    assert args.url == "ws://localhost:3100/worker"
    assert args.peer_port is None


def test_build_link_wires_a_real_identity_and_store_at_the_given_paths(tmp_path):
    args = parse_args([
        "--node-id", "test-node-123", "--price-paise-hr", "4300",
        "--identity-path", str(tmp_path / "node.pem"),
        "--store-path", str(tmp_path / "res.sqlite"),
    ])
    link = build_link(args)
    assert isinstance(link, WorkerLink)
    assert link.node_id == "test-node-123"
    assert link.price_paise_hr == 4300
    assert (tmp_path / "node.pem").exists(), "a real identity must actually be created at the given path"
    assert link.peer_port is None


def test_build_link_expands_a_tilde_path_the_same_way_the_dashboard_snippet_does(tmp_path, monkeypatch):
    # Regression coverage tying this CLI to the same ~-expansion fix
    # identity.py got: this script must resolve `--identity-path
    # ~/.nodeva/node.pem` under the real home directory, not a literal
    # `~` folder in whatever directory it happens to be run from.
    monkeypatch.setenv("HOME", str(tmp_path))
    args = parse_args(["--node-id", "n1", "--price-paise-hr", "100"])
    build_link(args)
    assert (tmp_path / ".nodeva" / "node.pem").exists()
    assert not (Path.cwd() / "~").exists()


def test_peer_port_is_off_by_default_but_wired_through_when_given(tmp_path):
    args = parse_args([
        "--node-id", "n1", "--price-paise-hr", "100",
        "--identity-path", str(tmp_path / "node.pem"),
        "--store-path", str(tmp_path / "res.sqlite"),
        "--peer-port", "41000",
    ])
    link = build_link(args)
    assert link.peer_port == 41000
    assert link._peer_server is not None
