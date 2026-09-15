"""Sandboxed job execution.

Every flag here maps to a row in docs/security-model.md's control table.
This module does not attempt Direction 2 (protecting the user from the
provider) at all — see that document before treating anything here as more
than half the threat model.

Shells out to the `docker` CLI rather than the Docker Python SDK, matching
the choice made for GPU detection: fewer dependencies for a provider to
install, and behaviour identical to what a human operator would see running
these commands by hand, which makes this easier to audit.
"""

from __future__ import annotations

import dataclasses
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

# Hard ceiling regardless of what a job or reservation requests. Prevents a
# misconfigured caller from asking for an unbounded job; the reservation
# window is the real limit and should always be tighter than this.
MAX_TIMEOUT_S = 6 * 3600

# Output above this size is truncated, not buffered in full. A job that spams
# logs must not be able to exhaust the worker's own memory.
MAX_CAPTURED_OUTPUT_BYTES = 1_000_000

DOCKER_CLI_TIMEOUT_S = 30  # bounds `docker run`/`docker rm` themselves, not the job


class DockerUnavailable(Exception):
    pass


@dataclasses.dataclass(frozen=True)
class JobSpec:
    image: str
    command: list[str]
    timeout_seconds: int
    memory_mb: int = 2048
    cpus: float = 2.0
    pids_limit: int = 128
    # Environment is explicit and opt-in. Never the host's own environment —
    # that could leak the provider's own credentials into user workloads.
    env: dict[str, str] = dataclasses.field(default_factory=dict)
    # GPU passthrough. Empty means CPU-only. See security-model.md: this path
    # is implemented but unverified on hardware without an NVIDIA GPU.
    gpu_device_ids: list[str] = dataclasses.field(default_factory=list)
    network: bool = False  # deliberately hard to turn on; see security-model.md

    def __post_init__(self):
        if self.timeout_seconds <= 0 or self.timeout_seconds > MAX_TIMEOUT_S:
            raise ValueError(
                f"timeout_seconds must be in (0, {MAX_TIMEOUT_S}], got {self.timeout_seconds}")
        if self.memory_mb <= 0:
            raise ValueError("memory_mb must be positive")


@dataclasses.dataclass(frozen=True)
class JobResult:
    status: str  # succeeded | failed | timed_out | oom_killed | error
    exit_code: int | None
    stdout: str
    stderr: str
    duration_seconds: float


def _require_docker():
    if shutil.which("docker") is None:
        raise DockerUnavailable("docker CLI not found on PATH")


def _truncate(data: bytes) -> str:
    if len(data) <= MAX_CAPTURED_OUTPUT_BYTES:
        return data.decode("utf-8", errors="replace")
    head = data[:MAX_CAPTURED_OUTPUT_BYTES]
    return head.decode("utf-8", errors="replace") + \
        f"\n...[truncated, {len(data) - MAX_CAPTURED_OUTPUT_BYTES} more bytes]"


def run_job(spec: JobSpec) -> JobResult:
    """Run one job to completion (or timeout) and return its outcome.

    Synchronous and blocking by design — this does real wall-clock waiting
    for a container, potentially for a long time. Callers on an asyncio event
    loop (the worker's link.py) must run this via asyncio.to_thread so the
    heartbeat loop is not stalled for the job's whole duration.
    """
    _require_docker()

    workspace = Path(tempfile.mkdtemp(prefix="nodeva-job-"))
    # A real, live-caught, environment-dependent bug: tempfile.mkdtemp()
    # defaults to mode 0700, owned by whoever runs THIS process (root or a
    # CI runner's own user) -- but the container runs as UID 65534
    # (nobody), below, on a read-only root filesystem with /workspace as
    # its ONLY writable path. On a real Linux Docker host, UID 65534 is
    # neither the owner nor in the group of a 0700 directory it didn't
    # create, so every job failed to write anything at all. This passed
    # on macOS (Docker Desktop's VM-based bind-mount sharing doesn't
    # enforce the same host-UID-vs-container-UID check) and failed the
    # moment CI ran on a real Linux runner -- caught by
    # test_workspace_mount_is_writable, which is the one test whose
    # entire job is to catch exactly this. 0o777 is safe here specifically
    # because this is a private, randomly-named, single-job directory
    # deleted immediately after (see the `finally` block below), not
    # anything long-lived or shared.
    workspace.chmod(0o777)
    container_id = None
    started = time.monotonic()
    try:
        container_id = _start(spec, workspace)
        exit_code, hit_timeout = _wait(container_id, spec.timeout_seconds)
        stdout, stderr = _read_logs(container_id)
        oom = False if hit_timeout else _was_oom_killed(container_id)

        if hit_timeout:
            status = "timed_out"
        elif oom:
            status = "oom_killed"
        elif exit_code == 0:
            status = "succeeded"
        else:
            status = "failed"

        return JobResult(
            status=status, exit_code=exit_code, stdout=stdout, stderr=stderr,
            duration_seconds=time.monotonic() - started,
        )
    except subprocess.CalledProcessError as e:
        return JobResult(
            status="error", exit_code=None,
            stdout="", stderr=_truncate(e.stderr or b""),
            duration_seconds=time.monotonic() - started,
        )
    finally:
        if container_id:
            # -f: the container may still be running (timeout path). Best
            # effort — a failure to remove leaks a stopped container, which is
            # a cleanup nuisance, not a security hole, so it is logged by the
            # caller rather than raised.
            subprocess.run(["docker", "rm", "-f", container_id],
                            capture_output=True, timeout=DOCKER_CLI_TIMEOUT_S)
        shutil.rmtree(workspace, ignore_errors=True)


def _start(spec: JobSpec, workspace: Path) -> str:
    args = [
        "docker", "run", "-d",
        "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--memory", f"{spec.memory_mb}m",
        "--memory-swap", f"{spec.memory_mb}m",  # equal to memory: no swap growth
        "--cpus", str(spec.cpus),
        "--pids-limit", str(spec.pids_limit),
        "-u", "65534:65534",  # nobody:nogroup — never root
        "-v", f"{workspace}:/workspace",
        "-w", "/workspace",
    ]
    args += ["--network", "bridge" if spec.network else "none"]
    for k, v in spec.env.items():
        args += ["-e", f"{k}={v}"]
    for gpu_id in spec.gpu_device_ids:
        args += ["--gpus", f'"device={gpu_id}"']
    args.append(spec.image)
    args += spec.command

    proc = subprocess.run(args, capture_output=True, text=True,
                           timeout=DOCKER_CLI_TIMEOUT_S, check=True)
    return proc.stdout.strip()


def _wait(container_id: str, timeout_s: int) -> tuple[int | None, bool]:
    """Returns (exit_code, hit_timeout). exit_code is None if timed out."""
    try:
        proc = subprocess.run(
            ["docker", "wait", container_id],
            capture_output=True, text=True, timeout=timeout_s, check=True,
        )
        return int(proc.stdout.strip()), False
    except subprocess.TimeoutExpired:
        # The container is still running. Kill it — SIGKILL, not a polite
        # SIGTERM, because a hostile or hung job is not expected to cooperate,
        # and it must vacate the GPU before the next reservation starts.
        subprocess.run(["docker", "kill", container_id],
                        capture_output=True, timeout=DOCKER_CLI_TIMEOUT_S)
        return None, True


def _read_logs(container_id: str) -> tuple[str, str]:
    # Without -t at run time, docker keeps stdout/stderr separate; `docker
    # logs` reproduces that split onto its own stdout/stderr.
    proc = subprocess.run(["docker", "logs", container_id],
                           capture_output=True, timeout=DOCKER_CLI_TIMEOUT_S)
    return _truncate(proc.stdout), _truncate(proc.stderr)


def _was_oom_killed(container_id: str) -> bool:
    proc = subprocess.run(
        ["docker", "inspect", "--format={{.State.OOMKilled}}", container_id],
        capture_output=True, text=True, timeout=DOCKER_CLI_TIMEOUT_S)
    return proc.stdout.strip() == "true"
