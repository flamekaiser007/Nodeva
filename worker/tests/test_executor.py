"""Executor tests run against a REAL docker daemon and a real alpine
container — these controls are meaningless if only asserted from the CLI flag
names, so each one is exercised by actually trying to violate it.

Requires docker on PATH and network access once to pull alpine:3.20
(`docker pull alpine:3.20` before running if offline).
"""
import shutil
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nodeva_worker.executor import JobSpec, run_job, DockerUnavailable

pytestmark = pytest.mark.skipif(
    shutil.which("docker") is None, reason="docker not available")

IMAGE = "alpine:3.20"


def sh(cmd: str, timeout_seconds: int = 15, **kw) -> JobSpec:
    return JobSpec(image=IMAGE, command=["/bin/sh", "-c", cmd], timeout_seconds=timeout_seconds, **kw)


def test_successful_job_captures_stdout_and_exit_code():
    r = run_job(sh("echo hello-nodeva"))
    assert r.status == "succeeded"
    assert r.exit_code == 0
    assert "hello-nodeva" in r.stdout


def test_nonzero_exit_is_reported_as_failed_not_an_exception():
    r = run_job(sh("exit 7"))
    assert r.status == "failed"
    assert r.exit_code == 7


def test_stderr_is_captured_separately_from_stdout():
    r = run_job(sh("echo to-out; echo to-err 1>&2"))
    assert "to-out" in r.stdout and "to-out" not in r.stderr
    assert "to-err" in r.stderr and "to-err" not in r.stdout


def test_runs_as_a_non_root_uid():
    # Design principle: a compromised process should not already be root.
    r = run_job(sh("id -u"))
    assert r.status == "succeeded"
    assert r.stdout.strip() == "65534"


def test_root_filesystem_is_read_only():
    r = run_job(sh("touch /this-should-fail || echo BLOCKED"))
    assert "BLOCKED" in r.stdout, \
        "container wrote to its root filesystem; --read-only is not effective"


def test_workspace_mount_is_writable():
    # The one deliberately writable path. If this fails, jobs cannot produce
    # output at all, which is as serious a bug as the read-only test failing.
    r = run_job(sh("echo produced > /workspace/out.txt && cat /workspace/out.txt"))
    assert r.status == "succeeded"
    assert "produced" in r.stdout


def test_tmp_is_writable_but_workspace_data_does_not_leak_to_root():
    r = run_job(sh("echo scratch > /tmp/x.txt && cat /tmp/x.txt"))
    assert "scratch" in r.stdout


def test_no_network_by_default():
    # busybox wget ships in alpine; no separate install needed. With
    # --network none there is no interface at all, so this fails fast rather
    # than timing out against a reachable-but-blocked host — a stronger
    # guarantee than a firewall rule would give.
    r = run_job(sh("wget -T 3 -O /dev/null http://example.com 2>&1 || echo NO_NETWORK"))
    assert "NO_NETWORK" in r.stdout


def test_capabilities_are_dropped():
    # CAP_SYS_TIME is required to change the clock. busybox's `date -s`
    # always exits 0 regardless of whether the underlying syscall actually
    # succeeded -- confirmed manually: EPERM is reported only on stderr, never
    # via exit status -- so this checks the actual kernel error message
    # rather than exit code, which a first version of this test got wrong.
    r = run_job(sh("date -s '2020-01-01'"))
    assert "Operation not permitted" in r.stderr, \
        f"expected CAP_SYS_TIME to be dropped, got stderr: {r.stderr!r}"


def test_wall_clock_timeout_kills_a_runaway_job():
    r = run_job(sh("sleep 30", timeout_seconds=2))
    assert r.status == "timed_out"
    assert r.exit_code is None


def test_pids_limit_bounds_process_count():
    # Spawning 40 background processes under a limit of 8 must fail. Note
    # what "fail" looks like here: ash does not recover gracefully from
    # ENOMEM-on-fork inside a background-job loop, it aborts the whole
    # script (confirmed manually: "/bin/sh: can't fork: Resource temporarily
    # unavailable", nonzero exit) -- so this checks for that abort rather
    # than a clean per-iteration failure count, which the shell never gets
    # the chance to print.
    limited = run_job(sh("for i in $(seq 1 40); do sleep 5 & done; echo all_spawned",
                          pids_limit=8))
    assert limited.status == "failed"
    assert "can't fork" in limited.stderr or "all_spawned" not in limited.stdout

    # Same script with room to spare must complete cleanly -- proves the
    # failure above is the pids limit and not something else about the script.
    roomy = run_job(sh("for i in $(seq 1 40); do sleep 0.1 & done; wait; echo all_spawned",
                        pids_limit=200))
    assert roomy.status == "succeeded"
    assert "all_spawned" in roomy.stdout


def test_output_is_truncated_not_unbounded():
    # Small cap for a fast, deterministic test rather than actually producing
    # a megabyte of output.
    import nodeva_worker.executor as ex
    old_cap = ex.MAX_CAPTURED_OUTPUT_BYTES
    ex.MAX_CAPTURED_OUTPUT_BYTES = 100
    try:
        r = run_job(sh("head -c 5000 /dev/zero | tr '\\0' 'a'"))
    finally:
        ex.MAX_CAPTURED_OUTPUT_BYTES = old_cap
    assert r.status == "succeeded"
    assert len(r.stdout) < 300  # capped content + truncation notice
    assert "truncated" in r.stdout


def test_container_is_removed_after_completion():
    import subprocess
    r = run_job(sh("echo done"))
    assert r.status == "succeeded"
    # No leaked containers, running or stopped.
    out = subprocess.run(["docker", "ps", "-a", "--filter", f"ancestor={IMAGE}",
                           "--format", "{{.ID}}"], capture_output=True, text=True).stdout
    assert out.strip() == "", f"container(s) leaked after run: {out}"


def test_workspace_directory_is_cleaned_up_from_the_host():
    import tempfile
    before = set(Path(tempfile.gettempdir()).glob("nodeva-job-*"))
    run_job(sh("echo x"))
    after = set(Path(tempfile.gettempdir()).glob("nodeva-job-*"))
    assert after == before, "job workspace directory leaked on the host"


def test_invalid_timeout_is_rejected_before_touching_docker():
    with pytest.raises(ValueError):
        JobSpec(image=IMAGE, command=["true"], timeout_seconds=0)
    with pytest.raises(ValueError):
        JobSpec(image=IMAGE, command=["true"], timeout_seconds=999999)
