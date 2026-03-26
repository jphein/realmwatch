#!/usr/bin/env python3
"""Lightweight collectd network protocol listener — UDP 25826.

Complements collectd_reader: where collectd_reader reads historical RRD files
on disk, this listener receives live push packets directly from collectd's
network plugin. Useful for hosts that don't write RRD locally (e.g. APs that
send metrics directly to katana over UDP).

Data flow:
  collectd (remote host) --UDP 25826--> _parse_packet() --> _metrics dict
  map_server/sse_broker  <-- get_host_summary() / get_metrics() <-- _metrics

Threading:
  _listener_loop() runs in a daemon thread started by start_listener().
  _metrics is a nested dict; writes are protected by _lock.
  get_metrics() returns a shallow copy snapshot.

Configuration:
  PORT = 25826  # collectd default UDP port

Binary protocol parsing:
  Decodes collectd's native binary format (part-type/length TLV frames).
  Supports COUNTER, GAUGE, DERIVE, ABSOLUTE DS types.
  Maintains context across parts within a packet (host, plugin, type, etc.).

Public API (imported by map_server):
  start_listener()            -> Thread
  get_metrics()               -> {hostname: {key: {values, ts}}}
  get_host_summary(hostname)  -> dict | None
"""

import struct
import socket
import threading
import time

# collectd binary protocol part types
PART_HOST            = 0x0000
PART_TIME            = 0x0001
PART_TIME_HR         = 0x0008
PART_PLUGIN          = 0x0002
PART_PLUGIN_INSTANCE = 0x0003
PART_TYPE            = 0x0004
PART_TYPE_INSTANCE   = 0x0005
PART_VALUES          = 0x0006
PART_INTERVAL        = 0x0007
PART_INTERVAL_HR     = 0x0009

# Value data types
DS_COUNTER  = 0
DS_GAUGE    = 1
DS_DERIVE   = 2
DS_ABSOLUTE = 3

PORT = 25826
STALE_THRESHOLD = 300   # seconds (5 minutes)
EVICT_INTERVAL  = 60    # seconds between sweeps

_lock = threading.Lock()
_metrics = {}  # {hostname: {plugin/type: {values, ts}}}


def get_metrics():
    """Return a snapshot of all collected metrics."""
    with _lock:
        return {h: dict(m) for h, m in _metrics.items()}


def get_host_summary(hostname):
    """Return a summary dict for a specific host."""
    with _lock:
        host_data = _metrics.get(hostname, {})
    if not host_data:
        return None

    summary = {"hostname": hostname, "last_seen": 0}

    for key, entry in host_data.items():
        ts = entry.get("ts", 0)
        if ts > summary["last_seen"]:
            summary["last_seen"] = ts

        vals = entry.get("values", [])
        if not vals:
            continue

        # Extract useful metrics
        if key.startswith("cpu/"):
            # cpu/N/cpu-idle -> extract idle percentage
            if "idle" in key and vals:
                summary.setdefault("cpu_idle", []).append(vals[0])
        elif key == "memory//memory-used" and vals:
            summary["mem_used"] = vals[0]
        elif key == "memory//memory-free" and vals:
            summary["mem_free"] = vals[0]
        elif key == "memory//memory-buffered" and vals:
            summary["mem_buffered"] = vals[0]
        elif key == "memory//memory-cached" and vals:
            summary["mem_cached"] = vals[0]
        elif key.startswith("load//load"):
            if vals and len(vals) >= 3:
                summary["load_1"] = vals[0]
                summary["load_5"] = vals[1]
                summary["load_15"] = vals[2]
        elif key.startswith("interface/") and vals:
            iface = key.split("/")[1]
            if "if_octets" in key and len(vals) >= 2:
                summary.setdefault("interfaces", {})[iface] = {
                    "rx": vals[0], "tx": vals[1]
                }
        elif key == "uptime//uptime" and vals:
            summary["uptime"] = vals[0]
        elif key.startswith("conntrack//conntrack"):
            if vals:
                summary["conntrack"] = vals[0]

    # Compute CPU usage from idle values
    if "cpu_idle" in summary:
        idle_vals = summary.pop("cpu_idle")
        avg_idle = sum(idle_vals) / len(idle_vals) if idle_vals else 100
        # collectd cpu plugin reports jiffies as derive, so idle is a rate
        # For a simple summary, we just note we have CPU data
        summary["cpu_cores"] = len(idle_vals)

    # Compute memory percentage
    if "mem_used" in summary:
        total = summary.get("mem_used", 0) + summary.get("mem_free", 0) + \
                summary.get("mem_buffered", 0) + summary.get("mem_cached", 0)
        if total > 0:
            summary["mem_pct"] = round(summary["mem_used"] / total * 100, 1)
            summary["mem_total_mb"] = round(total / (1024 * 1024), 0)

    return summary


def _parse_packet(data):
    """Parse a collectd binary protocol packet into parts."""
    offset = 0
    ctx = {}  # current context: host, plugin, type, etc.
    length = len(data)

    while offset < length - 4:
        part_type, part_len = struct.unpack("!HH", data[offset:offset + 4])
        if part_len < 5 or offset + part_len > length:
            break

        payload = data[offset + 4:offset + part_len]

        if part_type == PART_HOST:
            ctx["host"] = payload.rstrip(b"\x00").decode("utf-8", errors="replace")
        elif part_type == PART_TIME:
            ctx["time"] = struct.unpack("!Q", payload)[0]
        elif part_type == PART_TIME_HR:
            ctx["time"] = struct.unpack("!Q", payload)[0] / (2**30)
        elif part_type == PART_PLUGIN:
            ctx["plugin"] = payload.rstrip(b"\x00").decode("utf-8", errors="replace")
        elif part_type == PART_PLUGIN_INSTANCE:
            ctx["plugin_instance"] = payload.rstrip(b"\x00").decode("utf-8", errors="replace")
        elif part_type == PART_TYPE:
            ctx["type"] = payload.rstrip(b"\x00").decode("utf-8", errors="replace")
        elif part_type == PART_TYPE_INSTANCE:
            ctx["type_instance"] = payload.rstrip(b"\x00").decode("utf-8", errors="replace")
        elif part_type == PART_INTERVAL:
            ctx["interval"] = struct.unpack("!q", payload)[0]
        elif part_type == PART_INTERVAL_HR:
            ctx["interval"] = struct.unpack("!Q", payload)[0] / (2**30)
        elif part_type == PART_VALUES:
            if len(payload) >= 2:
                num_values = struct.unpack("!H", payload[:2])[0]
                types_data = payload[2:2 + num_values]
                values_data = payload[2 + num_values:]
                values = []
                for i in range(num_values):
                    if i >= len(types_data):
                        break
                    vtype = types_data[i]
                    voffset = i * 8
                    if voffset + 8 > len(values_data):
                        break
                    raw = values_data[voffset:voffset + 8]
                    if vtype == DS_COUNTER:
                        values.append(struct.unpack("!Q", raw)[0])
                    elif vtype == DS_GAUGE:
                        values.append(struct.unpack("<d", raw)[0])
                    elif vtype == DS_DERIVE:
                        values.append(struct.unpack("!q", raw)[0])
                    elif vtype == DS_ABSOLUTE:
                        values.append(struct.unpack("!Q", raw)[0])

                host = ctx.get("host", "unknown")
                plugin = ctx.get("plugin", "")
                plugin_inst = ctx.get("plugin_instance", "")
                dtype = ctx.get("type", "")
                type_inst = ctx.get("type_instance", "")
                ts = ctx.get("time", time.time())

                key = f"{plugin}/{plugin_inst}/{dtype}-{type_inst}".rstrip("-")

                with _lock:
                    if host not in _metrics:
                        _metrics[host] = {}
                    _metrics[host][key] = {"values": values, "ts": ts}

        offset += part_len


def _evict_stale_metrics():
    """Remove metric entries older than STALE_THRESHOLD seconds."""
    now = time.time()
    with _lock:
        for host in list(_metrics):
            entries = _metrics[host]
            stale_keys = [k for k, v in entries.items()
                          if now - v.get("ts", 0) > STALE_THRESHOLD]
            for k in stale_keys:
                del entries[k]
            if not entries:
                del _metrics[host]


def _eviction_loop():
    """Periodically sweep stale metrics."""
    while True:
        time.sleep(EVICT_INTERVAL)
        _evict_stale_metrics()


def _listener_loop():
    """Main UDP listener loop."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("", PORT))
        print(f"collectd listener: UDP :{PORT}")

        while True:
            try:
                data, addr = sock.recvfrom(65535)
                _parse_packet(data)
            except OSError:
                break  # Socket closed
            except Exception:
                pass
    finally:
        sock.close()


def start_listener():
    """Start the collectd listener in a background thread."""
    t = threading.Thread(target=_listener_loop, daemon=True)
    t.start()
    threading.Thread(target=_eviction_loop, daemon=True).start()
    return t


if __name__ == "__main__":
    start_listener()
    print("Listening for collectd packets... Press Ctrl+C to stop.")
    try:
        while True:
            time.sleep(10)
            metrics = get_metrics()
            for host, data in sorted(metrics.items()):
                summary = get_host_summary(host)
                if summary:
                    age = time.time() - summary.get("last_seen", 0)
                    mem = f"mem:{summary.get('mem_pct', '?')}%" if "mem_pct" in summary else ""
                    load = f"load:{summary.get('load_1', '?')}" if "load_1" in summary else ""
                    print(f"  {host}: {mem} {load} (age: {age:.0f}s)")
    except KeyboardInterrupt:
        print("\nStopped.")
