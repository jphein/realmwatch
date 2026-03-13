#!/usr/bin/env python3
"""Event generator — monitors collectd metrics and HA states, fires events on thresholds.

Runs as part of map_server or standalone. Checks metrics periodically and fires
events when thresholds are crossed or significant state changes occur.
"""

import threading
import time
import realm_db
import collectd_reader
import ha_bridge

# Thresholds for alerts
THRESHOLDS = {
    "cpu": {"warn": 80, "crit": 95},
    "memory": {"warn": 85, "crit": 95},
    "disk": {"warn": 85, "crit": 95},
    "temp": {"warn": 75, "crit": 85},
    "load": {"warn": 4.0, "crit": 8.0},
}

# Check interval in seconds (balance between responsiveness and CPU usage)
CHECK_INTERVAL = 120

# Track previous states to detect changes
_prev_states = {}  # node_id → {metric: value, ...}
_prev_ha_states = {}  # entity_id → state
_event_callback = None

# Cooldown: don't fire same alert twice within this period
ALERT_COOLDOWN = 300  # 5 minutes
_alert_times = {}  # (node_id, metric) → last_alert_ts


def _fire_event(event_type, node_id, text, color=None, **extra):
    """Fire an event via callback or directly to DB."""
    evt = {"type": event_type, "node": node_id, "text": text}
    if color:
        evt["color"] = color
    evt.update(extra)
    if _event_callback:
        _event_callback(evt)
    else:
        realm_db.push_event(evt)


def _cooldown_ok(node_id, metric):
    """Check if we can fire an alert (not in cooldown)."""
    key = (node_id, metric)
    now = time.time()
    last = _alert_times.get(key, 0)
    if now - last < ALERT_COOLDOWN:
        return False
    _alert_times[key] = now
    return True


def _get_node_label(node_id):
    """Get display label for a node."""
    node = realm_db.get_node(node_id)
    if node:
        return node.get("label", node_id)
    return node_id


def check_collectd_thresholds():
    """Check collectd metrics against thresholds and fire events."""
    summaries = collectd_reader.get_all_summaries()
    topo = realm_db.get_topology()

    # Build hostname → node_id map
    host_to_node = {}
    for n in topo.get("nodes", []):
        # Match by hostname in ssh field or ID
        ssh = n.get("ssh", "")
        if ssh:
            hostname = ssh.split("@")[-1] if "@" in ssh else ssh
            host_to_node[hostname] = n["id"]
        host_to_node[n["id"]] = n["id"]

    for host, data in summaries.items():
        node_id = host_to_node.get(host)
        if not node_id:
            continue

        node_label = _get_node_label(node_id)
        prev = _prev_states.get(node_id, {})

        # CPU check
        cpu = data.get("cpu")
        if cpu is not None:
            if cpu >= THRESHOLDS["cpu"]["crit"] and _cooldown_ok(node_id, "cpu"):
                _fire_event(
                    "alert", node_id,
                    f"{node_label}'s forge burns white-hot! CPU at {cpu:.0f}%",
                    color="#ff4040"
                )
            elif cpu >= THRESHOLDS["cpu"]["warn"] and prev.get("cpu", 0) < THRESHOLDS["cpu"]["warn"]:
                if _cooldown_ok(node_id, "cpu"):
                    _fire_event(
                        "speech", node_id,
                        f"{node_label}'s forge is heating up: CPU at {cpu:.0f}%",
                        color="#ffaa00"
                    )

        # Memory check
        mem = data.get("memory_pct")
        if mem is not None:
            if mem >= THRESHOLDS["memory"]["crit"] and _cooldown_ok(node_id, "memory"):
                _fire_event(
                    "alert", node_id,
                    f"{node_label}'s mana well runs dry! Memory at {mem:.0f}%",
                    color="#ff4040"
                )
            elif mem >= THRESHOLDS["memory"]["warn"] and prev.get("memory_pct", 0) < THRESHOLDS["memory"]["warn"]:
                if _cooldown_ok(node_id, "memory"):
                    _fire_event(
                        "speech", node_id,
                        f"{node_label}'s mana well is draining: Memory at {mem:.0f}%",
                        color="#ffaa00"
                    )

        # Disk check
        disk = data.get("disk_pct")
        if disk is not None:
            if disk >= THRESHOLDS["disk"]["crit"] and _cooldown_ok(node_id, "disk"):
                _fire_event(
                    "alert", node_id,
                    f"{node_label}'s vaults are overflowing! Disk at {disk:.0f}%",
                    color="#ff4040"
                )
            elif disk >= THRESHOLDS["disk"]["warn"] and prev.get("disk_pct", 0) < THRESHOLDS["disk"]["warn"]:
                if _cooldown_ok(node_id, "disk"):
                    _fire_event(
                        "speech", node_id,
                        f"{node_label}'s vaults are filling: Disk at {disk:.0f}%",
                        color="#ffaa00"
                    )

        # Temperature check
        temp = data.get("temp")
        if temp is not None:
            if temp >= THRESHOLDS["temp"]["crit"] and _cooldown_ok(node_id, "temp"):
                _fire_event(
                    "alert", node_id,
                    f"{node_label} is overheating! Temperature at {temp:.0f}C",
                    color="#ff4040"
                )
            elif temp >= THRESHOLDS["temp"]["warn"] and prev.get("temp", 0) < THRESHOLDS["temp"]["warn"]:
                if _cooldown_ok(node_id, "temp"):
                    _fire_event(
                        "speech", node_id,
                        f"{node_label} is running hot: Temperature at {temp:.0f}C",
                        color="#ffaa00"
                    )

        # Load check
        load = data.get("load_1m")
        if load is not None:
            if load >= THRESHOLDS["load"]["crit"] and _cooldown_ok(node_id, "load"):
                _fire_event(
                    "alert", node_id,
                    f"{node_label} is overwhelmed! Load at {load:.1f}",
                    color="#ff4040"
                )
            elif load >= THRESHOLDS["load"]["warn"] and prev.get("load_1m", 0) < THRESHOLDS["load"]["warn"]:
                if _cooldown_ok(node_id, "load"):
                    _fire_event(
                        "speech", node_id,
                        f"{node_label} is under strain: Load at {load:.1f}",
                        color="#ffaa00"
                    )

        # Store current state for next comparison
        _prev_states[node_id] = {
            "cpu": cpu,
            "memory_pct": mem,
            "disk_pct": disk,
            "temp": temp,
            "load_1m": load,
        }


def check_ha_states():
    """Check Home Assistant states and fire events on significant changes."""
    states = ha_bridge.get_ha_states()
    if not states:
        return

    # Interesting entity patterns and their event mappings
    patterns = {
        "light.": {"on": "A light awakens", "off": "A light fades"},
        "switch.": {"on": "Power flows", "off": "Power ceases"},
        "binary_sensor.motion": {"on": "Motion detected"},
        "binary_sensor.door": {"on": "A door opens", "off": "A door closes"},
        "binary_sensor.window": {"on": "A window opens", "off": "A window closes"},
    }

    for entity_id, state_data in states.items():
        state = state_data.get("state")
        if state in ("unavailable", "unknown"):
            continue

        prev_state = _prev_ha_states.get(entity_id)
        if prev_state == state:
            continue

        # Only fire on actual state changes (not first load)
        if prev_state is None:
            _prev_ha_states[entity_id] = state
            continue

        _prev_ha_states[entity_id] = state

        # Find matching pattern
        for pattern, messages in patterns.items():
            if entity_id.startswith(pattern) or pattern in entity_id:
                msg = messages.get(state)
                if msg:
                    friendly_name = state_data.get("attributes", {}).get("friendly_name", entity_id)
                    _fire_event(
                        "speech", "ha",
                        f"{msg}: {friendly_name}",
                        color="#80c0ff",
                        entity_id=entity_id
                    )
                break


def _generator_loop():
    """Background loop — runs checks every CHECK_INTERVAL seconds."""
    while True:
        try:
            check_collectd_thresholds()
        except Exception as e:
            print(f"[Event Generator] collectd check error: {e}")

        try:
            check_ha_states()
        except Exception as e:
            print(f"[Event Generator] HA check error: {e}")

        time.sleep(CHECK_INTERVAL)


def start_event_generator(callback=None):
    """Start the event generator as a daemon thread."""
    global _event_callback
    _event_callback = callback
    t = threading.Thread(target=_generator_loop, daemon=True)
    t.start()
    print(f"[Event Generator] Started (interval={CHECK_INTERVAL}s)")
    return t


if __name__ == "__main__":
    # Standalone mode for testing
    realm_db.init()
    start_event_generator()
    print("Event generator running... Press Ctrl+C to stop")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopped")
