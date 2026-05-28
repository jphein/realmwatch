#!/usr/bin/env python3
"""Host-agnostic sysinfo collector for `realm wave <host>`.

Runs on the target host (piped via `ssh <host> "python3 -"` by host-poll.py
or executed locally when the target is the current host). Stdlib only —
no deps to install. Emits one JSON object per invocation; wave-block's
custom mode picks numeric fields as sparkline rows and strings as labels.

Detected signals (omitted when not present so wave-block doesn't render
empty rows):

  load_1m, load_5m, load_15m         /proc/loadavg
  ram_total_gb, ram_used_gb,
  ram_avail_gb, ram_pct              /proc/meminfo
  swap_used_gb, swap_pct             /proc/meminfo (only if SwapTotal > 0)
  disk_total_gb, disk_used_gb,
  disk_pct                           os.statvfs("/")
  cpu_temp_c                         /sys/class/thermal/thermal_zone*/temp
                                     (max across zones with "x86_pkg_temp",
                                     "coretemp", or first non-zero)
  cpu_count                          os.cpu_count()
  gpu<N>_temp_c, gpu<N>_util_pct,
  gpu<N>_vram_pct                    nvidia-smi (per GPU, if installed)
  pg_active_conns                    docker exec mempalace-db psql
                                     (only on hosts running that container)
  uptime_hours                       /proc/uptime
  net_<iface>_rx_Mbps,
  net_<iface>_tx_Mbps                /proc/net/dev (first non-lo iface
                                     with traffic, deltas against /tmp cache)
  hostname                           os.uname().nodename
  distro                             /etc/os-release PRETTY_NAME
  kernel                             os.uname().release
  arch                               os.uname().machine
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time


_NET_CACHE = "/tmp/realm-wave-host-net.json"


def _read(path: str) -> str:
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return ""


def _run(cmd: list[str], timeout: int = 5) -> str:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip()
    except Exception:
        return ""


def _has(cmd: str) -> bool:
    """True if `cmd` resolves on PATH."""
    for p in os.environ.get("PATH", "").split(os.pathsep):
        candidate = os.path.join(p, cmd)
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return True
    return False


def collect_os(m: dict) -> None:
    u = os.uname()
    m["hostname"] = u.nodename
    m["kernel"] = u.release
    m["arch"] = u.machine
    for line in _read("/etc/os-release").splitlines():
        if line.startswith("PRETTY_NAME="):
            m["distro"] = line.split("=", 1)[1].strip().strip('"')
            break


def collect_load(m: dict) -> None:
    parts = _read("/proc/loadavg").split()
    if len(parts) >= 3:
        try:
            m["load_1m"] = float(parts[0])
            m["load_5m"] = float(parts[1])
            m["load_15m"] = float(parts[2])
        except ValueError:
            pass
    if (n := os.cpu_count()):
        m["cpu_count"] = int(n)


def collect_mem(m: dict) -> None:
    meminfo: dict[str, int] = {}
    for line in _read("/proc/meminfo").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1].isdigit():
            meminfo[parts[0].rstrip(":")] = int(parts[1])
    total = meminfo.get("MemTotal", 0)
    avail = meminfo.get("MemAvailable", 0)
    if total > 0:
        m["ram_total_gb"] = round(total / 1048576, 1)
        m["ram_used_gb"] = round((total - avail) / 1048576, 1)
        m["ram_avail_gb"] = round(avail / 1048576, 1)
        m["ram_pct"] = round((total - avail) / total * 100, 1)
    swap_total = meminfo.get("SwapTotal", 0)
    swap_free = meminfo.get("SwapFree", 0)
    if swap_total > 0:
        m["swap_used_gb"] = round((swap_total - swap_free) / 1048576, 1)
        m["swap_pct"] = round((swap_total - swap_free) / swap_total * 100, 1)


def collect_disk(m: dict) -> None:
    try:
        st = os.statvfs("/")
    except OSError:
        return
    total_b = st.f_frsize * st.f_blocks
    free_b = st.f_frsize * st.f_bfree
    if total_b <= 0:
        return
    total_gb = total_b / 1073741824
    used_gb = (total_b - free_b) / 1073741824
    m["disk_total_gb"] = round(total_gb, 1)
    m["disk_used_gb"] = round(used_gb, 1)
    m["disk_pct"] = round(used_gb / total_gb * 100, 1)


def collect_cpu_temp(m: dict) -> None:
    if not os.path.isdir("/sys/class/thermal"):
        return
    best: int | None = None
    for zone in sorted(os.listdir("/sys/class/thermal")):
        if not zone.startswith("thermal_zone"):
            continue
        zpath = f"/sys/class/thermal/{zone}"
        ztype = _read(f"{zpath}/type")
        ztemp = _read(f"{zpath}/temp")
        if not (ztemp and ztemp.lstrip("-").isdigit()):
            continue
        t = int(ztemp) // 1000
        if ztype in ("x86_pkg_temp", "coretemp", "cpu-thermal"):
            best = t
            break
        if best is None and t > 0:
            best = t
    if best is not None:
        m["cpu_temp_c"] = best


def collect_gpu(m: dict) -> None:
    if not _has("nvidia-smi"):
        return
    out = _run([
        "nvidia-smi",
        "--query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total",
        "--format=csv,noheader,nounits",
    ])
    for i, line in enumerate(out.splitlines()):
        fields = [f.strip() for f in line.split(",")]
        if len(fields) < 4:
            continue
        try:
            temp = int(fields[0])
            util = int(fields[1])
            vram_used = int(fields[2])
            vram_total = int(fields[3])
        except ValueError:
            continue
        m[f"gpu{i}_temp_c"] = temp
        m[f"gpu{i}_util_pct"] = util
        if vram_total > 0:
            m[f"gpu{i}_vram_pct"] = round(vram_used / vram_total * 100, 1)
            m[f"gpu{i}_vram_used_gb"] = round(vram_used / 1024, 1)


def collect_pg(m: dict) -> None:
    if not _has("docker"):
        return
    if "mempalace-db" not in _run(["docker", "ps", "--format", "{{.Names}}"]):
        return
    out = _run([
        "docker", "exec", "mempalace-db",
        "psql", "-U", "palace", "-d", "mempalace_2026_05_13",
        "-t", "-A", "-c",
        "SELECT count(*) FROM pg_stat_activity WHERE state != 'idle'",
    ])
    if out.strip().lstrip("-").isdigit():
        m["pg_active_conns"] = int(out.strip())


def collect_uptime(m: dict) -> None:
    parts = _read("/proc/uptime").split()
    if parts:
        try:
            m["uptime_hours"] = round(float(parts[0]) / 3600, 1)
        except ValueError:
            pass


def collect_net(m: dict) -> None:
    """Per-iface rx/tx Mbps using a small delta cache in /tmp."""
    raw = _read("/proc/net/dev").splitlines()
    now = time.time()
    cur: dict[str, tuple[int, int]] = {}
    for line in raw:
        if ":" not in line:
            continue
        iface, rest = line.split(":", 1)
        iface = iface.strip()
        if iface in ("lo", ""):
            continue
        fields = rest.split()
        if len(fields) < 9:
            continue
        try:
            rx = int(fields[0])
            tx = int(fields[8])
        except ValueError:
            continue
        cur[iface] = (rx, tx)

    prev: dict = {}
    try:
        with open(_NET_CACHE) as f:
            prev = json.load(f)
    except (OSError, json.JSONDecodeError):
        prev = {}

    dt = max(now - float(prev.get("ts", now)), 0.1)
    best_iface: str | None = None
    best_total: int = 0
    rates: dict[str, tuple[float, float]] = {}
    for iface, (rx, tx) in cur.items():
        prev_iface = prev.get("ifaces", {}).get(iface)
        if not prev_iface:
            continue
        prev_rx, prev_tx = prev_iface
        d_rx = max(rx - prev_rx, 0)
        d_tx = max(tx - prev_tx, 0)
        rate = (d_rx + d_tx) / dt
        rates[iface] = (d_rx / dt * 8 / 1_000_000, d_tx / dt * 8 / 1_000_000)
        if rate > best_total:
            best_total = int(rate)
            best_iface = iface

    if best_iface and best_iface in rates:
        rx_mbps, tx_mbps = rates[best_iface]
        m[f"net_{best_iface}_rx_Mbps"] = round(rx_mbps, 2)
        m[f"net_{best_iface}_tx_Mbps"] = round(tx_mbps, 2)
    elif rates:
        iface = next(iter(rates))
        rx_mbps, tx_mbps = rates[iface]
        m[f"net_{iface}_rx_Mbps"] = round(rx_mbps, 2)
        m[f"net_{iface}_tx_Mbps"] = round(tx_mbps, 2)

    try:
        with open(_NET_CACHE, "w") as f:
            json.dump({"ts": now, "ifaces": cur}, f)
    except OSError:
        pass


def main() -> int:
    m: dict = {}
    collect_os(m)
    collect_load(m)
    collect_mem(m)
    collect_disk(m)
    collect_cpu_temp(m)
    collect_gpu(m)
    collect_pg(m)
    collect_uptime(m)
    collect_net(m)
    json.dump(m, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
