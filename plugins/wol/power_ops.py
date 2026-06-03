"""Slumber Ward — pure power-management logic.

No HTTP, no PluginContext: importable and exercisable on its own. The plugin
wiring (plugin.py) calls into these helpers.

SSH model: the realm host reaches targets with key-based SSH (BatchMode) and,
for privileged ops, passwordless ``sudo -n`` — the same path proven manually on
2026-06-02 (``ssh familiar 'sudo systemd-run --no-block systemctl suspend'``).
"""
import socket
import subprocess
import time

# StrictHostKeyChecking=accept-new mirrors core map_server.py's /ssh handler.
SSH_OPTS = ["-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=accept-new",
            "-o", "BatchMode=yes"]


def normalize_mac(s):
    """Return a 12-char lowercase hex MAC, or None if ``s`` isn't a MAC."""
    n = (s or "").replace(":", "").replace("-", "").lower()
    if len(n) == 12 and all(c in "0123456789abcdef" for c in n):
        return n
    return None


def resolve_target(raw, mac_overrides=None):
    """raw -> (mac_hex, resolved_name|None, directed_ip|None). Raises ValueError.

    Accepts a raw MAC, or a fleet current_name / prior_name / fleet_id. The MAC
    comes from a ``mac:`` fleet_id when present, else from ``mac_overrides``
    (keyed by current_name or the raw target) — needed for hosts like familiar
    whose fleet_id is a ``fleet:<uuid>`` rather than a MAC.
    """
    raw = (raw or "").strip()
    if not raw:
        raise ValueError("missing target (mac or node id)")
    mac = normalize_mac(raw)
    if mac is not None:
        return mac, None, None
    import realm_fleet
    entry = realm_fleet.host(raw)
    name = entry.current_name if entry else raw
    directed_ip = getattr(entry, "ops_ip", None) if entry else None
    if entry and entry.fleet_id.startswith("mac:"):
        mac = normalize_mac(entry.fleet_id.split(":", 1)[1])
    if mac is None and mac_overrides:
        mac = normalize_mac(mac_overrides.get(name) or mac_overrides.get(raw) or "")
    if mac is None:
        if entry is None:
            raise ValueError(f"{raw!r} is not a valid MAC and not a known fleet host")
        raise ValueError(f"no MAC for {name!r}: fleet_id is {entry.fleet_id!r} and no "
                         f"mac_overrides entry exists; WoL needs a MAC")
    return mac, name, directed_ip


def send_magic_packet(mac_hex, directed_ip=None):
    """Send the WoL magic packet to the limited broadcast + directed subnet broadcast."""
    magic = b"\xff" * 6 + bytes.fromhex(mac_hex) * 16
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        # 255.255.255.255 = IPv4 limited broadcast (RFC 1122 §3.2.1.3): a protocol
        # constant, not a host. The x.y.z.255 directed broadcast reaches the /24.
        sock.sendto(magic, ("255.255.255.255", 9))
        if directed_ip:
            parts = directed_ip.rsplit(".", 1)
            if len(parts) == 2:
                sock.sendto(magic, (parts[0] + ".255", 9))
    return {"ok": True, "mac": mac_hex, "sent": True, "directed_ip": directed_ip}


def _ssh_target(name):
    """Prefer the fleet current_name (an ssh-config alias) else ops_ip else the raw name."""
    import realm_fleet
    entry = realm_fleet.host(name)
    if entry is None:
        return name
    return entry.current_name or getattr(entry, "ops_ip", None) or name


def ssh(name, command, priv=False, timeout=15):
    """Run ``command`` on the host via key-based SSH. priv=True prefixes ``sudo -n``.

    Returns {ok, stdout, stderr, code, target}.
    """
    target = _ssh_target(name)
    remote = f"sudo -n {command}" if priv else command
    try:
        proc = subprocess.run(["ssh", *SSH_OPTS, target, remote],
                              capture_output=True, text=True, timeout=max(1, min(timeout, 60)))
        return {"ok": proc.returncode == 0, "stdout": proc.stdout, "stderr": proc.stderr,
                "code": proc.returncode, "target": target}
    except subprocess.TimeoutExpired:
        return {"ok": False, "stdout": "", "stderr": f"ssh timeout after {timeout}s",
                "code": 124, "target": target}
    except FileNotFoundError:
        return {"ok": False, "stdout": "", "stderr": "ssh binary not found",
                "code": 127, "target": target}


def detect_iface(name, iface_overrides=None):
    """Primary NIC (default-route device) of the host, or an override, or None."""
    if iface_overrides and name in iface_overrides:
        return iface_overrides[name]
    r = ssh(name, "ip -o route show default", priv=False)
    if r["ok"]:
        for line in r["stdout"].splitlines():
            toks = line.split()
            if "dev" in toks:
                return toks[toks.index("dev") + 1]
    return None


def check_wol(name, iface_overrides=None):
    """Doctor: is the host SSH-reachable and is WoL armed (``Wake-on: g``)?"""
    iface = detect_iface(name, iface_overrides)
    if iface is None:
        return {"ok": False, "ssh": False, "armed": False,
                "reason": "ssh unreachable or could not detect primary interface"}
    r = ssh(name, f"ethtool {iface}", priv=True)
    if not r["ok"]:
        return {"ok": False, "ssh": True, "iface": iface, "armed": False,
                "reason": (r["stderr"] or "ethtool failed").strip()}
    armed = False
    for line in r["stdout"].splitlines():
        if "Wake-on:" in line:
            armed = line.split("Wake-on:", 1)[1].strip() == "g"
    return {"ok": armed, "ssh": True, "iface": iface, "armed": armed}


def arm_wol(name, iface_overrides=None):
    """Best-effort runtime arm (``ethtool -s <iface> wol g``). NM persistence is
    set separately (see the familiar memory ``reference-familiar-wol-s3``)."""
    iface = detect_iface(name, iface_overrides)
    if iface is None:
        return {"ok": False, "reason": "ssh unreachable or could not detect primary interface"}
    r = ssh(name, f"ethtool -s {iface} wol g", priv=True)
    return {"ok": r["ok"], "iface": iface, "detail": r,
            "note": "runtime arm only; set NM 802-3-ethernet.wake-on-lan=magic for persistence"}


def suspend_host(name):
    """Suspend to S3 via detached systemd-run so the SSH call returns cleanly."""
    return ssh(name, "systemd-run --no-block systemctl suspend", priv=True)


def power_state(name, reachable, last_sleep_ts, last_wake_ts, sleep_ttl):
    """Derive power state from reachability + recent wake/sleep intent."""
    now = time.time()
    if reachable:
        return "awake"
    if last_sleep_ts and (now - last_sleep_ts) < sleep_ttl:
        return "slumbering"
    if last_wake_ts and (now - last_wake_ts) < 120:
        return "waking"
    return "dark"
