"""Slumber Ward — pure power-management logic.

No HTTP, no PluginContext: importable and exercisable on its own. The plugin
wiring (plugin.py) calls into these helpers.

SSH model: the realm host reaches targets with key-based SSH (BatchMode) and,
for privileged ops, passwordless ``sudo -n`` — the same path proven manually on
2026-06-02 (``ssh familiar 'sudo systemd-run --no-block systemctl suspend'``).
"""
import re
import socket
import subprocess
import time

# StrictHostKeyChecking=accept-new mirrors core map_server.py's /ssh handler.
SSH_OPTS = ["-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=accept-new",
            "-o", "BatchMode=yes"]

# A safe ssh target / interface token. Must START alphanumeric — so it can never
# begin with '-' and be smuggled to ssh as an option flag (e.g. -oProxyCommand=) —
# and may contain only hostname/IP/alias chars, no shell metacharacters (the
# remote command string is executed by the target host's shell).
_SAFE_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _safe_token(s):
    return bool(s) and bool(_SAFE_TOKEN.match(s))


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
    if entry and entry.fleet_id and entry.fleet_id.startswith("mac:"):
        mac = normalize_mac(entry.fleet_id.split(":", 1)[1])
    if mac is None and mac_overrides:
        mac = normalize_mac(mac_overrides.get(name) or mac_overrides.get(raw) or "")
    if mac is None:
        if entry is None:
            raise ValueError(f"{raw!r} is not a valid MAC and not a known fleet host")
        raise ValueError(f"no MAC for {name!r}: fleet_id is {entry.fleet_id!r} and no "
                         f"mac_overrides entry exists; WoL needs a MAC")
    return mac, name, directed_ip


def _directed_broadcast(target):
    """Return the x.y.z.255 directed broadcast for ``target``, or None.

    ``target`` is a fleet ``ops_ip``, which may be either a dotted-quad or a
    hostname — the operator file is allowed to carry either, and hostnames are
    preferred so a DHCP re-lease can't leave a stale literal behind. A name has
    to be resolved before the broadcast address can be computed: the old code
    did ``rsplit('.', 1)`` straight on the field, which turns "katana.lan" into
    the nonsense host "katana.255".
    """
    if not target:
        return None
    host = target.rsplit(":", 1)[0] if target.count(":") == 1 else target
    try:
        ip = socket.gethostbyname(host)
    except OSError:
        return None
    parts = ip.rsplit(".", 1)
    return parts[0] + ".255" if len(parts) == 2 else None


def send_magic_packet(mac_hex, directed_ip=None):
    """Send the WoL magic packet to the limited broadcast + directed subnet broadcast.

    Socket failures (no route, permission, transient OS error) are caught and
    returned as a clean error dict rather than raised — the caller gets a
    structured result either way.
    """
    magic = b"\xff" * 6 + bytes.fromhex(mac_hex) * 16
    bcast = _directed_broadcast(directed_ip)
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            # 255.255.255.255 = IPv4 limited broadcast (RFC 1122 §3.2.1.3): a protocol
            # constant, not a host. The x.y.z.255 directed broadcast reaches the /24.
            sock.sendto(magic, ("255.255.255.255", 9))
    except OSError as e:
        return {"ok": False, "mac": mac_hex, "sent": False, "directed_ip": directed_ip,
                "error": f"socket error sending magic packet: {e}"}

    # The directed broadcast is a best-effort second copy, and it gets its own
    # try for a reason: it fails routinely for hosts on subnets this box has no
    # route to (10.37.5.0/24, say). Sharing one try with the limited broadcast
    # above made that failure report {"ok": false, "sent": false} for a packet
    # that had already gone out — the instrument lying about its own success,
    # which is the exact class of bug #122 was about.
    directed_error = None
    if bcast:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                sock.sendto(magic, (bcast, 9))
        except OSError as e:
            directed_error = f"directed broadcast to {bcast} failed: {e}"
    elif directed_ip:
        directed_error = f"could not resolve {directed_ip!r} to a directed broadcast address"

    out = {"ok": True, "mac": mac_hex, "sent": True, "directed_ip": directed_ip,
           "directed_broadcast": bcast}
    if directed_error:
        out["directed_warning"] = directed_error
    return out


def _ssh_target(name):
    """Resolve to the fleet current_name (ssh-config alias), else ops_ip, else the
    raw name — then validate. Rejects anything ssh could mistake for an option flag
    (leading '-') or that carries shell metacharacters. Raises ValueError."""
    import realm_fleet
    entry = realm_fleet.host(name)
    target = (entry.current_name or getattr(entry, "ops_ip", None) or name) if entry else name
    if not _safe_token(target):
        raise ValueError(f"refusing unsafe ssh target {target!r}")
    return target


def ssh(name, command, priv=False, timeout=15):
    """Run ``command`` on the host via key-based SSH. priv=True prefixes ``sudo -n``.

    Returns {ok, stdout, stderr, code, target}.
    """
    try:
        target = _ssh_target(name)
    except ValueError as e:
        return {"ok": False, "stdout": "", "stderr": str(e), "code": 2, "target": name}
    remote = f"sudo -n {command}" if priv else command
    try:
        # '--' terminates ssh option parsing so a hostile target can never be
        # read as a flag (defence-in-depth alongside _safe_token validation).
        proc = subprocess.run(["ssh", *SSH_OPTS, "--", target, remote],
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
                idx = toks.index("dev")
                if idx + 1 < len(toks):
                    return toks[idx + 1]
    return None


def check_wol(name, iface_overrides=None):
    """Doctor: is the host SSH-reachable and is WoL armed (``Wake-on: g``)?"""
    iface = detect_iface(name, iface_overrides)
    if iface is None or not _safe_token(iface):
        return {"ok": False, "ssh": False, "armed": False,
                "reason": "ssh unreachable or could not detect a safe primary interface"}
    r = ssh(name, f"ethtool {iface}", priv=True)
    if not r["ok"]:
        return {"ok": False, "ssh": True, "iface": iface, "armed": False,
                "reason": (r["stderr"] or "ethtool failed").strip()}
    armed = False
    # ethtool prints both "Supports Wake-on: <modes>" and the active "Wake-on: <state>".
    # Match the active field exactly (key == "Wake-on" after the colon split) so the
    # supported-modes line can never be mistaken for the armed state.
    for line in r["stdout"].splitlines():
        key, sep, val = line.partition(":")
        if sep and key.strip() == "Wake-on":
            armed = val.strip() == "g"
    return {"ok": armed, "ssh": True, "iface": iface, "armed": armed}


def arm_wol(name, iface_overrides=None):
    """Best-effort runtime arm (``ethtool -s <iface> wol g``). NM persistence is
    set separately (see the familiar memory ``reference-familiar-wol-s3``)."""
    iface = detect_iface(name, iface_overrides)
    if iface is None or not _safe_token(iface):
        return {"ok": False, "reason": "ssh unreachable or could not detect a safe primary interface"}
    r = ssh(name, f"ethtool -s {iface} wol g", priv=True)
    return {"ok": r["ok"], "iface": iface, "detail": r,
            "note": "runtime arm only; set NM 802-3-ethernet.wake-on-lan=magic for persistence"}


# How long to wait for an accepted suspend to actually take effect. familiar's
# pre-sleep hook stops two llama-server lanes and waits for them to release
# ~10 GB of GPU buffers, measured at 20-60 s on 2026-08-15; 90 s leaves headroom
# without holding the request open indefinitely.
SUSPEND_VERIFY_TIMEOUT_S = 90
SUSPEND_VERIFY_INTERVAL_S = 3


def suspend_host(name, verify_timeout=SUSPEND_VERIFY_TIMEOUT_S, probe=None,
                 sleep_fn=time.sleep):
    """Suspend to S3 via detached systemd-run, then verify the host went dark.

    ACCEPTING the command and SLEEPING are different facts, and only one of them
    is what the caller asked about. This used to return the SSH result directly,
    so `realm wol sleep` reported success the instant the target took the
    command — which on 2026-08-15 meant reporting success for suspends that
    OOM'd in the PM_SUSPEND_PREPARE notifier chain and rolled back 95 s later,
    with the host serving traffic the entire time.

    ``probe`` and ``sleep_fn`` are injectable so the wait is exercisable offline.
    """
    # Prefer the host's own quiesce wrapper when it has one. familiar must free
    # ~10 GB of GPU-pinned system RAM before it can reach S3 at all, and that
    # work CANNOT be done from a system-sleep hook (the stop job queues behind
    # the sleep transaction — 60 s+ versus 1 s outside it). Hosts without the
    # wrapper get the plain suspend, unchanged.
    res = ssh(name,
              "sh -c 'if command -v familiar-sleep-now >/dev/null 2>&1; then "
              "exec familiar-sleep-now; fi; "
              "exec systemd-run --no-block systemctl suspend'",
              priv=True, timeout=60)
    if not res.get("ok"):
        # The command never landed. There is nothing to verify, and reporting
        # "still answering" here would blame the host for the caller's failure.
        return res

    if probe is None:
        def probe(target):
            return probe_liveness([target]).get(target)

    waited = 0
    while waited < verify_timeout:
        # Clamp the final tick: a caller who said "90s" gets 90s, not 92.
        step = min(SUSPEND_VERIFY_INTERVAL_S, verify_timeout - waited)
        sleep_fn(step)
        waited += step
        if probe(name) is None:
            return {**res, "verified": True, "slept": True,
                    "verify_seconds": waited}

    return {**res, "ok": False, "verified": False, "slept": False,
            "verify_seconds": waited,
            "reason": (f"{name} accepted the suspend but was still answering "
                       f"{waited}s later — it did not sleep, or woke straight "
                       f"back up. Check `journalctl -k | grep 'PM: suspend'` and "
                       f"`journalctl -u systemd-suspend` on the host.")}


LIVENESS_TIMEOUT_MS = 500


def probe_liveness(targets, timeout_ms=LIVENESS_TIMEOUT_MS):
    """Batch ICMP-probe ``targets``; return ``{target: rtt_ms | None}``.

    Probe **by hostname**, not by a stored IP. DNS then resolves at probe time,
    so a host that re-leases a new address stays visible. A stored IP literal
    silently starts probing whoever inherited the lease — the wrong-referent
    failure behind #122, where topology's ``familiar.ip`` still held serialhub's
    address and the map reported live hosts as dark.

    The return value is deliberately three-valued, because "did not answer" and
    "was never asked" are different facts and only one of them means *down*:

    * ``target -> float``  — answered; value is RTT in ms  (**awake**)
    * ``target -> None``   — resolved, probed, stayed silent (**dark**)
    * *target absent*      — could not be resolved/probed at all (**unknown**)

    Callers must not collapse the third case into "down". Unresolvable targets
    are omitted rather than reported False so that a DNS outage degrades to
    "unknown" instead of alarming every host in the fleet at once.
    """
    targets = [t for t in dict.fromkeys(targets or []) if _safe_token(t)]
    if not targets:
        return {}
    try:
        result = subprocess.run(
            ["fping", "-c1", "-t", str(int(timeout_ms)), "-q"] + targets,
            capture_output=True, text=True, timeout=max(20, len(targets) // 4))
    except FileNotFoundError:
        return _probe_liveness_fallback(targets, timeout_ms)
    except (subprocess.TimeoutExpired, OSError):
        return {}
    # fping echoes the target as given (name in, name out) on stderr:
    #   host : xmt/rcv/%loss = 1/1/0%, min/avg/max = 0.36/0.36/0.36   -> alive
    #   host : xmt/rcv/%loss = 1/0/100%                               -> silent
    # Unresolvable targets produce no line at all, so they stay absent.
    out = {}
    for line in result.stderr.splitlines():
        m = re.match(r'^(\S+)\s*:\s*xmt/rcv/%loss', line)
        if not m:
            continue
        rtt = re.search(r'min/avg/max\s*=\s*[\d.]+/([\d.]+)/[\d.]+', line)
        out[m.group(1)] = round(float(rtt.group(1)), 2) if rtt else None
    return out


def _probe_liveness_fallback(targets, timeout_ms):
    """Sequential ``ping`` fallback when fping is not installed.

    Keeps probe_liveness's three-valued contract: a target whose ping cannot
    resolve the name is omitted, not reported dead.
    """
    wait = max(1, int(round(timeout_ms / 1000.0)))
    out = {}
    for t in targets:
        try:
            r = subprocess.run(["ping", "-c", "1", "-W", str(wait), t],
                               capture_output=True, text=True, timeout=wait + 3)
        except (subprocess.TimeoutExpired, OSError):
            continue
        # ping exits 2 (and says so on stderr) when the NAME cannot resolve —
        # that is "unknown", not "down", so leave the target out of the map.
        if r.returncode == 2 and ("unknown host" in r.stderr.lower()
                                  or "name or service not known" in r.stderr.lower()):
            continue
        m = re.search(r'time[=<]([\d.]+)', r.stdout)
        out[t] = round(float(m.group(1)), 2) if m else None
    return out


def power_state(name, reachable, last_sleep_ts, last_wake_ts, sleep_ttl, known=True):
    """Derive power state from reachability + recent wake/sleep intent.

    ``known`` carries whether reachability was actually *measured*. When it is
    False the host was never successfully probed, and the honest answer is
    "unknown" — reporting "dark" there is what made /status lie (#122).
    Recorded sleep/wake intent still wins over an unmeasured probe, since that
    intent is first-hand knowledge rather than an inference from silence.
    """
    now = time.time()
    if reachable:
        return "awake"
    if last_sleep_ts and (now - last_sleep_ts) < sleep_ttl:
        return "slumbering"
    if last_wake_ts and (now - last_wake_ts) < 120:
        return "waking"
    if not known:
        return "unknown"
    return "dark"
