"""Hardware inventory and live telemetry.

Everything here is SELF-REPORTED, and the platform must treat it that way. A
node claiming an H100 it does not have is trivial; nothing in this file can
prevent that. What stops it is benchmark attestation on the platform side
(compute_nodes.perf_score stays NULL until the node passes), plus the fact that
a lying node fails jobs and loses reputation. Detection is a convenience for
honest providers, not a security control.

nvidia-smi is used rather than a Python NVML binding to keep the worker's
install footprint small: every machine with a usable NVIDIA GPU already has it.
"""

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


def offerable_vram_mb(gpu: GpuInfo, headroom_mb: int = 1024) -> int:
    """VRAM we can honestly advertise.

    Not total VRAM: the display, the provider's own browser, and the driver all
    hold some. Advertising the full 24 GB of a card driving a 4K monitor gets
    jobs OOM-killed and the provider blamed for it.
    """
    return max(0, gpu.vram_total_mb - gpu.vram_used_mb - headroom_mb)
