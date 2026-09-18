import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest
import nodeva_worker.hardware as hardware_module
from nodeva_worker.hardware import (
    detect_gpus, offerable_vram_mb, offerable_memory_mb, NoGpu, _parse_int, GpuInfo,
    detect_cpu_cores, detect_ram_mb, describe_this_machine,
)

# Real nvidia-smi --format=csv,noheader,nounits output shapes.
SINGLE = "NVIDIA GeForce RTX 4090, 24564, 1832, 31, 47, 371.22, 550.54.14\n"
DUAL = SINGLE + "NVIDIA GeForce RTX 3090, 24576, 402, 0, 35, 102.50, 550.54.14\n"
IDLE_NA = "NVIDIA GeForce RTX 3060, 12288, 0, [N/A], [N/A], [N/A], 535.129.03\n"


def test_parses_a_single_gpu():
    g = detect_gpus(_runner=lambda: SINGLE)[0]
    assert g.model == "NVIDIA GeForce RTX 4090"
    assert g.vram_total_mb == 24564
    assert g.temperature_c == 47
    assert g.power_w == 371          # truncated from 371.22


def test_parses_multiple_gpus():
    gs = detect_gpus(_runner=lambda: DUAL)
    assert [g.model.split()[-1] for g in gs] == ["4090", "3090"]


def test_na_telemetry_does_not_crash_the_worker():
    # Laptop GPUs and some drivers report [N/A] for power and temperature.
    # A worker that crashes here takes the whole node offline for a cosmetic
    # field.
    g = detect_gpus(_runner=lambda: IDLE_NA)[0]
    assert g.power_w == 0 and g.temperature_c == 0
    assert g.vram_total_mb == 12288


def test_no_gpu_is_reported_not_faked():
    def boom(): raise NoGpu("nvidia-smi not found on PATH")
    with pytest.raises(NoGpu):
        detect_gpus(_runner=boom)


def test_empty_output_is_not_silently_an_empty_node():
    with pytest.raises(NoGpu):
        detect_gpus(_runner=lambda: "\n  \n")


def test_malformed_output_raises_rather_than_guessing():
    with pytest.raises(ValueError, match="expected 7 fields"):
        detect_gpus(_runner=lambda: "RTX 4090, 24564\n")


def test_vram_is_truncated_never_rounded_up():
    # 23.9 GB must not become 24 GB: a job sized to the advertisement would OOM.
    assert _parse_int("23.9") == 23


def test_offerable_vram_excludes_in_use_memory_and_headroom():
    g = detect_gpus(_runner=lambda: SINGLE)[0]
    # 24564 total - 1832 used by the desktop - 1024 headroom
    assert offerable_vram_mb(g) == 21708


def test_offerable_vram_never_goes_negative():
    g = GpuInfo("x", 4096, 4000, 90, 70, 100, "1")
    assert offerable_vram_mb(g) == 0


def test_offerable_memory_leaves_headroom_for_the_provider_s_own_system():
    # Same reasoning as VRAM above, for system RAM: the OS, the Docker
    # daemon and the worker process all live in that total.
    assert offerable_memory_mb(32768) == 31744


def test_offerable_memory_never_goes_negative():
    # A machine smaller than the headroom itself offers nothing, rather
    # than a negative limit Docker would reject.
    assert offerable_memory_mb(512) == 0


# --- detect_cpu_cores / detect_ram_mb ---------------------------------------

def test_detect_cpu_cores_reports_a_real_count():
    assert detect_cpu_cores(_cpu_count=lambda: 16) == 16


def test_detect_cpu_cores_can_report_unknown():
    # os.cpu_count() itself can return None on a platform that genuinely
    # can't say -- this must pass that through honestly, not fabricate 1.
    assert detect_cpu_cores(_cpu_count=lambda: None) is None


def test_detect_ram_mb_computes_from_page_size_and_phys_pages():
    sysconf_values = {'SC_PAGE_SIZE': 4096, 'SC_PHYS_PAGES': 8_388_608}  # 32 GiB
    assert detect_ram_mb(_sysconf=lambda name: sysconf_values[name]) == 32768


def test_detect_ram_mb_returns_none_when_sysconf_is_unavailable():
    # Windows has no os.sysconf at all -- AttributeError is the real
    # failure mode there, not something to let crash the heartbeat loop.
    def boom(name):
        raise AttributeError("module 'os' has no attribute 'sysconf'")
    assert detect_ram_mb(_sysconf=boom) is None


def test_detect_ram_mb_returns_none_on_nonsensical_values():
    assert detect_ram_mb(_sysconf=lambda name: 0) is None
    assert detect_ram_mb(_sysconf=lambda name: -1) is None


# --- describe_this_machine ---------------------------------------------
# What the CLI snippet ProviderDashboard.jsx prints actually calls -- a
# real, live-caught UX gap: the snippet used to print ONLY the public key,
# so a provider had no way to get GPU model/VRAM/cores/RAM other than
# typing them in by hand and guessing. This is the single function that
# closes that gap; wrong output here means the enrollment form silently
# gets fed wrong numbers.

def test_describe_this_machine_reports_a_real_gpu(monkeypatch):
    monkeypatch.setattr(
        hardware_module, "detect_gpus",
        lambda: [GpuInfo("NVIDIA GeForce RTX 4090", 24564, 1832, 31, 47, 371, "550.54.14")])
    monkeypatch.setattr(hardware_module, "detect_cpu_cores", lambda: 16)
    monkeypatch.setattr(hardware_module, "detect_ram_mb", lambda: 32768)

    info = describe_this_machine()
    assert info == {
        "gpu_model": "NVIDIA GeForce RTX 4090",
        "gpu_vram_gb": 24,  # 24564 MB rounds to 24 GB, matching the form's GB unit
        "cpu_cores": 16,
        "ram_gb": 32,
    }


def test_describe_this_machine_reports_none_for_gpu_fields_on_a_cpu_only_node(monkeypatch):
    # None, not 0 -- a CPU-only node genuinely has no GPU to report, which
    # is a different claim than "0 GB of VRAM" (a form value that would
    # fail compute_nodes' own CHECK (gpu_vram_mb > 0) constraint anyway).
    def no_gpu():
        raise NoGpu("nvidia-smi not found on PATH")
    monkeypatch.setattr(hardware_module, "detect_gpus", no_gpu)
    monkeypatch.setattr(hardware_module, "detect_cpu_cores", lambda: 8)
    monkeypatch.setattr(hardware_module, "detect_ram_mb", lambda: 16384)

    info = describe_this_machine()
    assert info["gpu_model"] is None
    assert info["gpu_vram_gb"] is None
    assert info["cpu_cores"] == 8
    assert info["ram_gb"] == 16


def test_describe_this_machine_reports_none_ram_when_genuinely_unknown(monkeypatch):
    monkeypatch.setattr(hardware_module, "detect_gpus", lambda: (_ for _ in ()).throw(NoGpu("none")))
    monkeypatch.setattr(hardware_module, "detect_cpu_cores", lambda: None)
    monkeypatch.setattr(hardware_module, "detect_ram_mb", lambda: None)

    info = describe_this_machine()
    assert info["cpu_cores"] is None
    assert info["ram_gb"] is None
