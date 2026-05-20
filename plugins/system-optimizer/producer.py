"""The Realm Optimizer — system-state auditors.

Migrated from os.realm.watch/servers/plugins/realm_optimizer.py 2026-05-19.

Each check_* function inspects one system signal and returns either None
(healthy) or a finding dict shaped like a realm event payload. The plugin
wraps these in a periodic background sweep; the producer itself does no
I/O beyond reading /proc, /tmp, and running ps / systemctl. All checks
short-circuit on error and never raise to the caller.
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess


# Default node id all optimizer events are pinned to — JP's desktop.
# Override per-call via the `node` arg.
DEFAULT_NODE = "katana"


def _finding(node: str, event_type: str, severity: int, text: str,
             payload: dict) -> dict:
    """Build a realm-event-shaped dict for a finding.

    Severity 1..5 → color hint; severity ≥ 4 promoted to type=alert.
    """
    color = {
        1: "#80ff80",
        2: "#a0c0ff",
        3: "#ffaa00",
        4: "#ff8040",
        5: "#ff4040",
    }.get(severity, "#ffaa00")
    return {
        "type": "alert" if severity >= 4 else "speech",
        "node": node,
        "text": text,
        "color": color,
        "optimizer_event_type": event_type,
        "severity": severity,
        "source": "realm-optimizer",
        **payload,
    }


def check_disk_space(node: str = DEFAULT_NODE,
                     threshold_percent: int = 85) -> dict | None:
    """Root filesystem usage above threshold."""
    usage = shutil.disk_usage("/")
    percent = (usage.used / usage.total) * 100
    if percent < threshold_percent:
        return None
    severity = 3 if percent < 95 else 4
    text = f"The vaults of {node} swell — {percent:.0f}% full, {usage.free / (1024**3):.1f}GB free"
    return _finding(node, "disk_space_low", severity, text, {
        "percent_used": round(percent, 1),
        "free_gb": round(usage.free / (1024**3), 1),
    })


def check_pip_cache(node: str = DEFAULT_NODE,
                    threshold_mb: int = 500) -> dict | None:
    """pip cache size above threshold."""
    cache_path = os.path.expanduser("~/.cache/pip")
    if not os.path.isdir(cache_path):
        return None
    try:
        total = sum(
            os.path.getsize(os.path.join(d, f))
            for d, _, files in os.walk(cache_path) for f in files
        )
    except OSError:
        return None
    mb = total / (1024 * 1024)
    if mb < threshold_mb:
        return None
    text = f"The pip cache hoard grows heavy on {node} — {mb:.0f}MB"
    return _finding(node, "cache_bloat", 2, text, {
        "target": "pip_cache",
        "size_mb": round(mb, 1),
        "path": cache_path,
    })


def check_journal_size(node: str = DEFAULT_NODE,
                       threshold_mb: int = 200) -> dict | None:
    """systemd journal size above threshold."""
    journal_path = "/var/log/journal"
    if not os.path.isdir(journal_path):
        return None
    try:
        total = sum(
            os.path.getsize(os.path.join(d, f))
            for d, _, files in os.walk(journal_path) for f in files
        )
    except OSError:
        return None
    mb = total / (1024 * 1024)
    if mb < threshold_mb:
        return None
    text = f"The chronicle of {node} grows weighty — journal at {mb:.0f}MB"
    return _finding(node, "journal_bloat", 2, text, {
        "size_mb": round(mb, 1),
        "path": journal_path,
    })


def check_swap_usage(node: str = DEFAULT_NODE,
                     threshold_percent: int = 50) -> dict | None:
    """Swap usage above threshold."""
    try:
        with open("/proc/swaps") as f:
            lines = f.readlines()
    except OSError:
        return None
    total = used = 0
    for line in lines[1:]:  # skip header
        parts = line.split()
        if len(parts) >= 4:
            total += int(parts[2])
            used += int(parts[3])
    if total == 0:
        return None
    percent = (used / total) * 100
    if percent < threshold_percent:
        return None
    severity = 3 if percent < 80 else 4
    text = f"Shadow memory presses on {node} — swap {percent:.0f}% used"
    return _finding(node, "swap_pressure", severity, text, {
        "percent_used": round(percent, 1),
        "used_mb": round(used / 1024, 1),
        "total_mb": round(total / 1024, 1),
    })


def check_zombie_processes(node: str = DEFAULT_NODE,
                           threshold: int = 5) -> dict | None:
    """Zombie process count above threshold."""
    try:
        result = subprocess.run(
            ["ps", "-eo", "stat"], capture_output=True, text=True, timeout=10,
        )
        zombie_count = sum(1 for line in result.stdout.splitlines()
                          if line.strip().startswith("Z"))
    except (subprocess.SubprocessError, OSError):
        return None
    if zombie_count <= threshold:
        return None
    text = f"{zombie_count} restless wraiths haunt {node} — zombie processes"
    return _finding(node, "zombie_processes", 3, text, {
        "zombie_count": zombie_count,
    })


def check_load_average(node: str = DEFAULT_NODE,
                       multiplier: float = 2.0) -> dict | None:
    """5-minute load average above cpu_count * multiplier."""
    try:
        _, load_5, _ = os.getloadavg()
        cpu_count = os.cpu_count() or 1
    except OSError:
        return None
    threshold = cpu_count * multiplier
    if load_5 <= threshold:
        return None
    severity = 3 if load_5 < threshold * 1.5 else 4
    text = f"The burden on {node} is great — load {load_5:.1f} over {cpu_count} cores"
    return _finding(node, "high_load", severity, text, {
        "load_5min": round(load_5, 2),
        "cpu_count": cpu_count,
        "threshold": round(threshold, 2),
    })


def check_memory_pressure(node: str = DEFAULT_NODE,
                          threshold_percent: int = 10) -> dict | None:
    """Available memory percentage below threshold."""
    try:
        meminfo: dict[str, int] = {}
        with open("/proc/meminfo") as f:
            for line in f:
                parts = line.split(":")
                if len(parts) == 2:
                    key = parts[0].strip()
                    val = int(parts[1].strip().split()[0])  # kB
                    meminfo[key] = val
    except (OSError, ValueError):
        return None
    total = meminfo.get("MemTotal", 0)
    available = meminfo.get("MemAvailable", 0)
    if total == 0:
        return None
    avail_percent = (available / total) * 100
    if avail_percent >= threshold_percent:
        return None
    severity = 3 if avail_percent > 5 else 5
    text = f"The reserves of {node} run dry — {avail_percent:.0f}% memory free"
    return _finding(node, "memory_pressure", severity, text, {
        "available_percent": round(avail_percent, 1),
        "available_mb": round(available / 1024, 1),
        "total_mb": round(total / 1024, 1),
    })


def check_tmp_size(node: str = DEFAULT_NODE,
                   threshold_mb: int = 1024) -> dict | None:
    """/tmp size above threshold."""
    tmp_path = "/tmp"
    if not os.path.isdir(tmp_path):
        return None
    total = 0
    for dirpath, _, filenames in os.walk(tmp_path):
        for f in filenames:
            try:
                total += os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                continue  # permission denied or file vanished
    mb = total / (1024 * 1024)
    if mb < threshold_mb:
        return None
    severity = 2 if mb < 2048 else 3
    text = f"Detritus piles in the tmp catacombs of {node} — {mb:.0f}MB"
    return _finding(node, "tmp_bloat", severity, text, {
        "size_mb": round(mb, 1),
        "path": tmp_path,
    })


def check_failed_services(node: str = DEFAULT_NODE) -> dict | None:
    """Any failed systemd --user services."""
    try:
        result = subprocess.run(
            ["systemctl", "--user", "--state=failed", "--no-legend", "--plain",
             "list-units"],
            capture_output=True, text=True, timeout=10,
        )
        failed = [line.split()[0] for line in result.stdout.strip().splitlines()
                  if line.strip()]
    except (subprocess.SubprocessError, OSError):
        return None
    if not failed:
        return None
    sample = ", ".join(failed[:3])
    text = f"{len(failed)} ward(s) have fallen on {node}: {sample}"
    return _finding(node, "failed_services", 3, text, {
        "count": len(failed),
        "units": failed[:10],
    })


def check_dns_resolution(node: str = DEFAULT_NODE,
                        hostname: str = "dns.google") -> dict | None:
    """DNS resolution failure for canary hostname."""
    try:
        socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except socket.gaierror:
        text = f"The far-seeing of {node} has clouded — DNS cannot resolve {hostname}"
        return _finding(node, "dns_failure", 4, text, {
            "hostname": hostname,
        })
    except OSError:
        return None
    return None


# Order matters only for the order findings are emitted; each check is independent.
ALL_CHECKS = (
    check_disk_space,
    check_pip_cache,
    check_journal_size,
    check_swap_usage,
    check_zombie_processes,
    check_load_average,
    check_memory_pressure,
    check_tmp_size,
    check_failed_services,
    check_dns_resolution,
)


def run_audit(node: str = DEFAULT_NODE) -> list[dict]:
    """Run all audits. Returns non-None findings as a list."""
    findings: list[dict] = []
    for check in ALL_CHECKS:
        try:
            result = check(node)
        except Exception:
            # Audit must never crash the sweep.
            continue
        if result:
            findings.append(result)
    return findings
