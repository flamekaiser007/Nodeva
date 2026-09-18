"""Hardware inventory and live telemetry.

Everything here is SELF-REPORTED, and the platform must treat it that way. A
node claiming an H100 it does not have is trivial; nothing in this file can
prevent that -- a deliberately malicious operator controls this very code and
can always report whatever number they want, however this is implemented.
What stops it is benchmark attestation on the platform side
(compute_nodes.perf_score stays NULL until the node passes), plus the fact that
a lying node fails jobs and loses reputation. Detection is a convenience for
honest providers, not a security control.

That convenience is worth having anyway: detect_cpu_cores/detect_ram_mb exist
so the backend can flag an HONEST mismatch (a provider's enrollment form
claim drifted from what their machine actually reports -- upgraded RAM
without updating the listing, fat-fingered a number, GPU swapped) as a
"self-reported, unverified" signal on the dashboard, exactly the case this
module's own docstring already anticipated for GPU model/VRAM before this
existed for CPU/RAM at all.

nvidia-smi is used rather than a Python NVML binding to keep the worker's
install footprint small: every machine with a usable NVIDIA GPU already has it.
CPU/RAM detection uses only the standard library for the same reason.
"""

import os
import shutil
import subprocess
from dataclasses import dataclass, asdict

# Queried in one call; order must match _parse_gpu_csv below.
_GPU_FIELDS = [
    "name", "memory.total", "memory.used", "utilization.gpu",
    "temperature.gpu", "power.draw", "driver_version",
]


@dataclass
class GpuInfo:
    model: str
    vram_total_mb: int
    vram_used_mb: int
    utilization_pct: int
    temperature_c: int
    power_w: int
    driver_version: str

    def as_dict(self):
        return asdict(self)


class NoGpu(Exception):
    """No usable NVIDIA GPU. The node can still offer CPU-only work."""


def _parse_int(raw: str) -> int:
    """nvidia-smi emits '24564 MiB', '31 %', '[N/A]', '371.22 W'."""
    token = raw.strip().split()[0] if raw.strip() else ""
    if token in ("", "[N/A]", "N/A"):
        return 0
    # Truncate rather than round: a reported 23.9 GB of VRAM must never be
    # advertised as 24, because a job sized to the advertisement would OOM.
    return int(float(token))


def _parse_gpu_csv(line: str) -> GpuInfo:
    parts = [p.strip() for p in line.split(",")]
    if len(parts) != len(_GPU_FIELDS):
        raise ValueError(
            f"expected {len(_GPU_FIELDS)} fields from nvidia-smi, got {len(parts)}: {line!r}")
    return GpuInfo(
        model=parts[0],
        vram_total_mb=_parse_int(parts[1]),
        vram_used_mb=_parse_int(parts[2]),
        utilization_pct=_parse_int(parts[3]),
        temperature_c=_parse_int(parts[4]),
        power_w=_parse_int(parts[5]),
        driver_version=parts[6],
    )


def detect_gpus(_runner=None) -> list[GpuInfo]:
    runner = _runner or _run_nvidia_smi
    out = runner()
    gpus = []
    for line in out.strip().splitlines():
        if line.strip():
            gpus.append(_parse_gpu_csv(line))
    if not gpus:
        raise NoGpu("nvidia-smi returned no devices")
    return gpus


def _run_nvidia_smi() -> str:
    exe = shutil.which("nvidia-smi")
    if exe is None:
        raise NoGpu("nvidia-smi not found on PATH")
    try:
        return subprocess.run(
            [exe, f"--query-gpu={','.join(_GPU_FIELDS)}",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout
    except subprocess.TimeoutExpired as e:
        # A hung nvidia-smi usually means a wedged driver. Treat as no GPU
        # rather than blocking the worker's startup forever.
        raise NoGpu("nvidia-smi timed out; driver may be unresponsive") from e
    except subprocess.CalledProcessError as e:
        raise NoGpu(f"nvidia-smi failed: {e.stderr.strip()}") from e


def detect_cpu_cores(_cpu_count=None) -> int | None:
    """Logical CPU count, or None if the platform genuinely can't say --
    same honest-failure posture as detect_gpus: a caller must handle
    "unknown", never assume a number came back."""
    counter = _cpu_count or os.cpu_count
    return counter()


def detect_ram_mb(_sysconf=None) -> int | None:
    """Total physical RAM via POSIX sysconf (Linux and macOS both support
    SC_PAGE_SIZE/SC_PHYS_PAGES) -- no extra dependency, same reasoning as
    nvidia-smi over an NVML binding. Windows has no sysconf at all; this
    returns None there rather than raising, since "we don't know" is an
    honest answer a CPU-only or misconfigured node can also legitimately
    give for cpu_cores above."""
    sysconf = _sysconf or os.sysconf
    try:
        page_size = sysconf('SC_PAGE_SIZE')
        phys_pages = sysconf('SC_PHYS_PAGES')
    except (ValueError, OSError, AttributeError):
        return None
    if page_size <= 0 or phys_pages <= 0:
        return None
    return (page_size * phys_pages) // (1024 * 1024)


def describe_this_machine() -> dict:
    """Everything the platform's node-enrollment form asks for (GPU model,
    VRAM, CPU cores, RAM), detected from THIS machine -- printed by the CLI
    snippet the frontend shows a provider (ProviderDashboard.jsx) so they
    can paste one blob instead of typing four numbers by hand and guessing
    (or, worse, leaving a stale/wrong value that immediately shows up as a
    hardware_mismatch on their own dashboard).

    Still purely a convenience, not a security boundary -- see this file's
    own header. A dishonest operator controls this exact code and can
    report whatever they want; what changes here is that an HONEST
    provider no longer has to manually transcribe numbers `nvidia-smi` or
    `free` would tell them anyway.

    GPU fields are None on a CPU-only node (NoGpu) or when nvidia-smi
    itself isn't reachable -- exactly the same honest-unknown posture
    detect_cpu_cores/detect_ram_mb already use, not a value of 0."""
    try:
        gpu = detect_gpus()[0]
        gpu_model, gpu_vram_gb = gpu.model, round(gpu.vram_total_mb / 1024)
    except NoGpu:
        gpu_model, gpu_vram_gb = None, None
    ram_mb = detect_ram_mb()
    return {
        "gpu_model": gpu_model,
        "gpu_vram_gb": gpu_vram_gb,
        "cpu_cores": detect_cpu_cores(),
        "ram_gb": round(ram_mb / 1024) if ram_mb else None,
    }


def offerable_memory_mb(total_mb: int, headroom_mb: int = 1024) -> int:
    """RAM we can hand to a job container, given this machine's total.

    The same reasoning as offerable_vram_mb below, for system memory: the
    provider's own OS, the Docker daemon, and this worker process all live
    in that total. A node enrolls advertising what detect_ram_mb() reports,
    which is TOTAL physical RAM -- handing 100% of it to a container does
    not give the buyer more, it just makes the machine thrash and start
    OOM-killing things (possibly this worker, losing the job anyway).
    """
    return max(0, total_mb - headroom_mb)


def offerable_vram_mb(gpu: GpuInfo, headroom_mb: int = 1024) -> int:
    """VRAM we can honestly advertise.

    Not total VRAM: the display, the provider's own browser, and the driver all
    hold some. Advertising the full 24 GB of a card driving a 4K monitor gets
    jobs OOM-killed and the provider blamed for it.
    """
    return max(0, gpu.vram_total_mb - gpu.vram_used_mb - headroom_mb)
