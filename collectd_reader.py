#!/usr/bin/env python3
"""Read collectd RRD data from /var/lib/collectd/rrd/.

Provides host summaries (load, memory, uptime, interfaces, CPU, thermal)
for the realm map by reading the latest values from RRD files via rrdtool.
"""

import os
import subprocess
import time
import threading

RRD_BASE = "/var/lib/collectd/rrd"
_cache = {}
_CACHE_TTL = 5.0  # seconds


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
        for f in os.listdir(mem_dir):
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
    for entry in os.listdir(host_dir):
        if entry.startswith("cpu-") and os.path.isdir(os.path.join(host_dir, entry)):
            cpu_count += 1
    if cpu_count > 0:
        summary["cpu_cores"] = cpu_count

    # Conntrack (gatekeeper)
    conntrack_dir = os.path.join(host_dir, "conntrack")
    if os.path.isdir(conntrack_dir):
        for f in os.listdir(conntrack_dir):
            if f.endswith(".rrd"):
                d = _rrd_last(os.path.join(conntrack_dir, f))
                if d and d["values"] and d["values"][0] is not None:
                    summary["conntrack"] = int(d["values"][0])

    # Thermal (gatekeeper, katana)
    temps = []
    for entry in os.listdir(host_dir):
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
        for f in os.listdir(dhcp_dir):
            if f.endswith(".rrd"):
                d = _rrd_last(os.path.join(dhcp_dir, f))
                if d and d["values"] and d["values"][0] is not None:
                    summary["dhcp_leases"] = int(d["values"][0])

    # Key interfaces — get actual byte rates (not cumulative counters)
    ifaces = {}
    for entry in os.listdir(host_dir):
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
        for f in os.listdir(ping_dir):
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

    # Disk (katana)
    df_root = os.path.join(host_dir, "df-root")
    if os.path.isdir(df_root):
        for f in os.listdir(df_root):
            if f == "df_complex-used.rrd":
                d = _rrd_last(os.path.join(df_root, f))
                if d and d["values"] and d["values"][0] is not None:
                    summary["disk_used"] = d["values"][0]
            elif f == "df_complex-free.rrd":
                d = _rrd_last(os.path.join(df_root, f))
                if d and d["values"] and d["values"][0] is not None:
                    summary["disk_free"] = d["values"][0]
        if "disk_used" in summary and "disk_free" in summary:
            total = summary["disk_used"] + summary["disk_free"]
            if total > 0:
                summary["disk_pct"] = round(summary["disk_used"] / total * 100, 1)
                summary["disk_total_gb"] = round(total / (1024**3), 1)

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
        for f in os.listdir(proc_dir):
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
    """Return summaries for all collectd hosts."""
    if not os.path.isdir(RRD_BASE):
        return {}
    result = {}
    for host in os.listdir(RRD_BASE):
        host_path = os.path.join(RRD_BASE, host)
        if os.path.isdir(host_path):
            s = get_host_summary(host)
            if s:
                result[host] = s
    return result
