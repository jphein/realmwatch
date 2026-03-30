#!/usr/bin/env python3
"""Read collectd RRD data from /var/lib/collectd/rrd/.

Synchronous RRD reader — no background thread. Each call to get_host_summary()
shells out to rrdtool and returns immediately; results are cached for CACHE_TTL
seconds so repeated calls within the same SSE tick are cheap.

Data flow:
  /var/lib/collectd/rrd/<hostname>/ → rrdtool lastupdate/fetch → summary dict

Threading:
  No locks — per-host cache is a simple dict; reads/writes are GIL-safe for
  the single-value _cache[hostname] = (ts, summary) assignment pattern.

Configuration:
  RRD_BASE   = "/var/lib/collectd/rrd"  # collectd RRD directory
  _CACHE_TTL = 5.0                      # seconds between re-reads per host

Metrics collected per host (where available):
  load_1/5/15, mem_used/total/pct, uptime, cpu_cores, conntrack,
  temp (max thermal zone), dhcp_leases, interfaces (rx_bps/tx_bps per iface),
  ping/ping_drop/ping_stddev (per target), disk_used/free/pct, swap_used,
  procs_running, fork_rate

Public API (imported by map_server, sse_broker, traffic_precompute):
  get_host_summary(hostname) -> dict | None
  get_all_summaries()        -> {hostname: dict}
"""

import concurrent.futures
import os
import subprocess
import time

RRD_BASE = "/var/lib/collectd/rrd"
_cache = {}
_CACHE_TTL = 5.0  # seconds


def _safe_listdir(path):
    """os.listdir that returns [] on OSError (directory deleted mid-read)."""
    try:
        return os.listdir(path)
    except OSError:
        return []


def _rrd_last(rrd_path):
    """Get the last value(s) from an RRD file."""
    try:
        out = subprocess.check_output(
            ["rrdtool", "lastupdate", rrd_path],
            text=True, timeout=2, stderr=subprocess.DEVNULL
        ).strip().split("\n")
        if len(out) < 2:
            return None
        # Header line has DS names, last line has ts: val1 val2 ...
        header = out[0].split()
        parts = out[-1].split()
        ts = int(parts[0].rstrip(":"))
        vals = []
        for v in parts[1:]:
            try:
                vals.append(float(v))
            except (ValueError, TypeError):
                vals.append(None)
        return {"ds": header, "values": vals, "ts": ts}
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError,
            FileNotFoundError, OSError):
        return None


def _rrd_rate(rrd_path):
    """Get the last computed rate from an RRD file (for DERIVE/COUNTER DS types).

    Uses 'rrdtool fetch AVERAGE' over the last 120s and returns the most recent
    non-NaN value. This gives actual bytes/sec for interface counters.
    """
    try:
        out = subprocess.check_output(
            ["rrdtool", "fetch", rrd_path, "AVERAGE", "-s", "-120", "-e", "now"],
            text=True, timeout=2, stderr=subprocess.DEVNULL
        ).strip().split("\n")
        if len(out) < 3:
            return None
        # Header line has DS names
        header = out[0].split()
        # Find last non-NaN row (iterate backwards)
        for line in reversed(out[2:]):
            if not line.strip() or "nan" in line.lower():
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            vals = []
            all_nan = True
            for v in parts[1:]:
                try:
                    fv = float(v)
                    if fv != fv:  # NaN check
                        vals.append(None)
                    else:
                        vals.append(fv)
                        all_nan = False
                except (ValueError, TypeError):
                    vals.append(None)
            if not all_nan:
                return {"ds": header, "values": vals}
        return None
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError,
            FileNotFoundError, OSError):
        return None


def get_host_summary(hostname):
    """Build a summary dict for a host from its RRD data."""
    now = time.monotonic()
    cached = _cache.get(hostname)
    if cached and (now - cached[0]) < _CACHE_TTL:
        return cached[1]

    host_dir = os.path.join(RRD_BASE, hostname)
    if not os.path.isdir(host_dir):
        return None

    summary = {"hostname": hostname}

    # Load average
    load_rrd = os.path.join(host_dir, "load", "load.rrd")
    if os.path.exists(load_rrd):
        d = _rrd_last(load_rrd)
        if d and d["values"]:
            v = d["values"]
            if len(v) >= 3:
                summary["load_1"] = v[0]
                summary["load_5"] = v[1]
                summary["load_15"] = v[2]
            elif len(v) >= 1:
                summary["load_1"] = v[0]

    # Memory
    mem_dir = os.path.join(host_dir, "memory")
    if os.path.isdir(mem_dir):
        mem = {}
        for f in _safe_listdir(mem_dir):
            if f.startswith("memory-") and f.endswith(".rrd"):
                key = f.replace("memory-", "").replace(".rrd", "")
                d = _rrd_last(os.path.join(mem_dir, f))
                if d and d["values"] and d["values"][0] is not None:
                    mem[key] = d["values"][0]
        used = mem.get("used", 0)
        free = mem.get("free", 0)
        buffered = mem.get("buffered", 0)
        cached_mem = mem.get("cached", 0)
        slab_recl = mem.get("slab_recl", 0)
        slab_unrecl = mem.get("slab_unrecl", 0)
        total = used + free + buffered + cached_mem + slab_recl + slab_unrecl
        if total > 0:
            summary["mem_used"] = used
            summary["mem_total"] = total
            summary["mem_pct"] = round(used / total * 100, 1)
            summary["mem_total_mb"] = round(total / (1024 * 1024), 0)

    # Uptime
    uptime_rrd = os.path.join(host_dir, "uptime", "uptime.rrd")
    if os.path.exists(uptime_rrd):
        d = _rrd_last(uptime_rrd)
        if d and d["values"] and d["values"][0] is not None:
            summary["uptime"] = d["values"][0]

    # CPU count
    cpu_count = 0
    for entry in _safe_listdir(host_dir):
        if entry.startswith("cpu-") and os.path.isdir(os.path.join(host_dir, entry)):
            cpu_count += 1
    if cpu_count > 0:
        summary["cpu_cores"] = cpu_count

    # Conntrack (gatekeeper)
    conntrack_dir = os.path.join(host_dir, "conntrack")
    if os.path.isdir(conntrack_dir):
        for f in _safe_listdir(conntrack_dir):
            if f.endswith(".rrd"):
                d = _rrd_last(os.path.join(conntrack_dir, f))
                if d and d["values"] and d["values"][0] is not None:
                    summary["conntrack"] = int(d["values"][0])

    # Thermal (gatekeeper, katana)
    temps = []
    for entry in _safe_listdir(host_dir):
        if entry.startswith("thermal-thermal_zone"):
            rrd = os.path.join(host_dir, entry, "temperature.rrd")
            if os.path.exists(rrd):
                d = _rrd_last(rrd)
                if d and d["values"] and d["values"][0] is not None:
                    temps.append(d["values"][0])
    if temps:
        summary["temp"] = round(max(temps), 1)

    # DHCP leases (gatekeeper)
    dhcp_dir = os.path.join(host_dir, "dhcpleases")
    if os.path.isdir(dhcp_dir):
        for f in _safe_listdir(dhcp_dir):
            if f.endswith(".rrd"):
                d = _rrd_last(os.path.join(dhcp_dir, f))
                if d and d["values"] and d["values"][0] is not None:
                    summary["dhcp_leases"] = int(d["values"][0])

    # Key interfaces — get actual byte rates (not cumulative counters)
    ifaces = {}
    for entry in _safe_listdir(host_dir):
        if entry.startswith("interface-"):
            iface_name = entry.replace("interface-", "")
            # Skip loopback and uninteresting
            if iface_name in ("lo",):
                continue
            octets_rrd = os.path.join(host_dir, entry, "if_octets.rrd")
            if os.path.exists(octets_rrd):
                # Use _rrd_rate for DERIVE/COUNTER DS — returns actual bytes/sec
                d = _rrd_rate(octets_rrd)
                if d and d["values"] and len(d["values"]) >= 2:
                    rx, tx = d["values"][0], d["values"][1]
                    if rx is not None and tx is not None and (rx + tx) > 0:
                        ifaces[iface_name] = {
                            "rx_bps": round(rx),
                            "tx_bps": round(tx),
                        }
    if ifaces:
        summary["interfaces"] = ifaces

    # Ping data (gatekeeper) — latency, droprate, stddev
    ping_dir = os.path.join(host_dir, "ping")
    if os.path.isdir(ping_dir):
        pings = {}
        drops = {}
        stddevs = {}
        for f in _safe_listdir(ping_dir):
            if not f.endswith(".rrd"):
                continue
            if f.startswith("ping_droprate-"):
                target = f.replace("ping_droprate-", "").replace(".rrd", "")
                d = _rrd_last(os.path.join(ping_dir, f))
                if d and d["values"] and d["values"][0] is not None:
                    drops[target] = round(d["values"][0], 2)
            elif f.startswith("ping_stddev-"):
                target = f.replace("ping_stddev-", "").replace(".rrd", "")
                d = _rrd_last(os.path.join(ping_dir, f))
                if d and d["values"] and d["values"][0] is not None:
                    stddevs[target] = round(d["values"][0], 2)
            elif f.startswith("ping-"):
                target = f.replace("ping-", "").replace(".rrd", "")
                d = _rrd_last(os.path.join(ping_dir, f))
                if d and d["values"] and d["values"][0] is not None:
                    pings[target] = round(d["values"][0], 1)
        if pings:
            summary["ping"] = pings
        if drops:
            summary["ping_drop"] = drops
        if stddevs:
            summary["ping_stddev"] = stddevs

    # Disk — meaningful df-* mount points (skip docker overlays, snaps, media)
    _skip_prefixes = ("var/lib/docker", "var/lib/containers", "var/snap", "snap/", "media/")
    disks = []
    for entry in _safe_listdir(host_dir):
        if not entry.startswith("df-"):
            continue
        df_dir = os.path.join(host_dir, entry)
        if not os.path.isdir(df_dir):
            continue
        mount = entry[3:].replace("-", "/")
        if mount == "root":
            mount = "/"
        if any(mount.startswith(p) for p in _skip_prefixes):
            continue
        used_val = free_val = None
        for f in _safe_listdir(df_dir):
            if f == "df_complex-used.rrd":
                d = _rrd_last(os.path.join(df_dir, f))
                if d and d["values"] and d["values"][0] is not None:
                    used_val = d["values"][0]
            elif f == "df_complex-free.rrd":
                d = _rrd_last(os.path.join(df_dir, f))
                if d and d["values"] and d["values"][0] is not None:
                    free_val = d["values"][0]
        if used_val is not None and free_val is not None:
            total = used_val + free_val
            if total > 0:
                disks.append({
                    "mount": mount, "pct": round(used_val / total * 100, 1),
                    "total_gb": round(total / (1024**3), 1),
                    "used": used_val, "free": free_val,
                })
    if disks:
        summary["disks"] = disks
        # Keep backward compat: disk_pct/disk_total_gb from root or largest
        root = next((d for d in disks if d["mount"] == "/"), None)
        primary = root or max(disks, key=lambda d: d["total_gb"])
        summary["disk_pct"] = primary["pct"]
        summary["disk_total_gb"] = primary["total_gb"]
        summary["disk_used"] = primary["used"]
        summary["disk_free"] = primary["free"]

    # Swap (katana)
    swap_dir = os.path.join(host_dir, "swap")
    if os.path.isdir(swap_dir):
        swap_used_rrd = os.path.join(swap_dir, "swap-used.rrd")
        if os.path.exists(swap_used_rrd):
            d = _rrd_last(swap_used_rrd)
            if d and d["values"] and d["values"][0] is not None:
                summary["swap_used"] = d["values"][0]

    # Processes (katana)
    proc_dir = os.path.join(host_dir, "processes")
    if os.path.isdir(proc_dir):
        for f in _safe_listdir(proc_dir):
            if f == "ps_state-running.rrd":
                d = _rrd_last(os.path.join(proc_dir, f))
                if d and d["values"] and d["values"][0] is not None:
                    summary["procs_running"] = int(d["values"][0])
            elif f == "fork_rate.rrd":
                d = _rrd_last(os.path.join(proc_dir, f))
                if d and d["values"] and d["values"][0] is not None:
                    summary["fork_rate"] = round(d["values"][0], 1)

    _cache[hostname] = (now, summary)
    return summary


def get_all_summaries():
    """Return summaries for all collectd hosts (parallel)."""
    if not os.path.isdir(RRD_BASE):
        return {}
    hosts = [
        h for h in _safe_listdir(RRD_BASE)
        if os.path.isdir(os.path.join(RRD_BASE, h))
    ]
    result = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        future_to_host = {pool.submit(get_host_summary, h): h for h in hosts}
        for future in concurrent.futures.as_completed(future_to_host):
            host = future_to_host[future]
            try:
                s = future.result()
                if s:
                    result[host] = s
            except Exception:
                pass  # skip hosts that error out
    return result
