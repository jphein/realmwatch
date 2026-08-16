"""Slumber Ward — Wake-on-LAN + remote S3 sleep + power-state awareness.

Extracts the legacy inline ``POST /wol`` out of core (map_server.py) and adds
remote sleep, a power-state model (slumbering vs dark), and loose RPG hooks.

Handlers are defined inside setup() so they close over ``ctx`` (PluginRequest
does not expose ctx). Game-layer coupling is runtime-only and guarded.
"""
import threading
import time

from . import power_ops


def setup(ctx):
    db = ctx.db

    # --- settings (remote sleep is consequential -> opt-in per host) ---
    if db.get_setting("sleepable", None) is None:
        db.set_setting("sleepable", ["familiar"])
    if db.get_setting("sleep_ttl_seconds", None) is None:
        db.set_setting("sleep_ttl_seconds", 21600)  # 6h slumber-intent window
    if db.get_setting("iface_overrides", None) is None:
        db.set_setting("iface_overrides", {})
    if db.get_setting("mac_overrides", None) is None:
        # Hosts whose fleet_id is not a mac: (e.g. familiar uses a fleet:<uuid>)
        # supply their MAC here to be wake-capable.
        db.set_setting("mac_overrides", {"familiar": "04:d9:f5:fa:1e:e0"})

    # --- intent log (distinguishes slumbering from dark) ---
    db.create_table(
        "power_log",
        "id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT NOT NULL, fleet_id TEXT, "
        "action TEXT NOT NULL, result TEXT NOT NULL, detail TEXT, actor TEXT, ts REAL NOT NULL")

    def log_action(host, action, result, detail="", actor="api", fleet_id=None):
        db.execute(
            "INSERT INTO plugin_wol_power_log "
            "(host, fleet_id, action, result, detail, actor, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (host, fleet_id, action, result, (detail or "")[:2000], actor, time.time()))

    def last_action_ts(host, action):
        rows = db.query(
            "SELECT ts FROM plugin_wol_power_log WHERE host=? AND action=? AND result='ok' "
            "ORDER BY ts DESC LIMIT 1", (host, action))
        return rows[0]["ts"] if rows else None

    def managed_hosts():
        """WoL-managed hosts as {name, fleet_id, ip, mac}: every curated mac:
        fleet entry, plus any sleepable host (even without a mac: fleet_id,
        using mac_overrides)."""
        import realm_fleet
        overrides = db.get_setting("mac_overrides", {})
        sleepable = db.get_setting("sleepable", [])
        out = {}
        cat = realm_fleet._catalog()
        if cat:
            for e in cat.entries:
                if e.status != "curated":
                    continue
                mac = None
                if e and e.fleet_id and e.fleet_id.startswith("mac:"):
                    mac = e.fleet_id.split(":", 1)[1]
                elif e.current_name in overrides:
                    mac = overrides[e.current_name]
                if mac or e.current_name in sleepable:
                    out[e.current_name] = {"name": e.current_name, "fleet_id": e.fleet_id,
                                           "ip": getattr(e, "ops_ip", None), "mac": mac}
        for n in sleepable:
            if n not in out:
                out[n] = {"name": n, "fleet_id": None, "ip": None, "mac": overrides.get(n)}
        return list(out.values())

    # --- liveness (#122) -------------------------------------------------
    # The old reachable() asked the latency plugin "is this name a key in your
    # map?" and treated every miss as *down*. That map only covers topology
    # nodes that carry an `ip` field and answered fping AT THAT STORED IP, so
    # three very different facts all arrived as False: host is down, host has
    # no topology entry (serialhub had none), and host was probed at a stale
    # address belonging to somebody else (nodered's .118 is ha-dash-kitchen).
    # Measured 2026-08-02: 16 of 70 managed hosts reported "dark" while
    # answering ping. The watch() thread below turns each of those into an
    # `alert` event, so the bad reads were also manufacturing false quests.
    #
    # We now run our own probe, BY HOSTNAME, and keep the three-valued answer.
    _LIVENESS_TTL = 25          # seconds; watch() refreshes on a 20s cadence
    _liveness = {}              # {host: rtt_ms|None} — absent = unprobeable
    _liveness_ts = 0.0
    _liveness_lock = threading.Lock()

    def refresh_liveness(hosts=None):
        """Probe every managed host by name and swap in the fresh map."""
        nonlocal _liveness, _liveness_ts
        names = [h["name"] for h in (hosts if hosts is not None else managed_hosts())]
        probed = power_ops.probe_liveness(names)
        # Fall back to the stored IP only for hosts whose NAME did not resolve,
        # so a host that is in the fleet but not in DNS is still measurable.
        missing = [h for h in (hosts if hosts is not None else managed_hosts())
                   if h["name"] not in probed and h.get("ip")]
        if missing:
            by_ip = power_ops.probe_liveness([h["ip"] for h in missing])
            for h in missing:
                if h["ip"] in by_ip:
                    probed[h["name"]] = by_ip[h["ip"]]
        with _liveness_lock:
            _liveness = probed
            _liveness_ts = time.time()
        return probed

    def liveness_map():
        """Cached liveness. Refreshes synchronously only on a cold/stale cache
        — status_rows() runs on every /status request, so this must be cheap."""
        with _liveness_lock:
            fresh = _liveness_ts and (time.time() - _liveness_ts) < _LIVENESS_TTL
            snapshot = dict(_liveness)
        return snapshot if fresh else refresh_liveness()

    def reachable(name, live=None):
        """True only on positive evidence, from either probe lane.

        The latency plugin's map is still consulted as a fast path, but only a
        *hit* is meaningful there; a miss proves nothing (see above).
        """
        live = liveness_map() if live is None else live
        if live.get(name) is not None:
            return True
        api = ctx.get_plugin_api("latency")
        if not api:
            return False
        try:
            return name in api["get_latency_map"]()
        except Exception:
            return False

    def status_rows():
        ttl = db.get_setting("sleep_ttl_seconds", 21600)
        sleepable = db.get_setting("sleepable", [])
        hosts = managed_hosts()
        live = liveness_map()
        rows = []
        for h in hosts:
            n = h["name"]
            rch = reachable(n, live)
            # "known" = we actually measured this host this cycle. Without it a
            # host we never managed to ask would be reported dark.
            known = rch or (n in live)
            state = power_ops.power_state(
                n, rch, last_action_ts(n, "sleep"), last_action_ts(n, "wake"), ttl, known=known)
            rows.append({"host": n, "fleet_id": h["fleet_id"], "ip": h["ip"], "state": state,
                         "reachable": rch, "measured": known, "rtt_ms": live.get(n),
                         "sleepable": n in sleepable, "wake_capable": bool(h["mac"])})
        return rows

    # --- HTTP handlers (close over ctx/db) ---
    def h_wol(req, params):
        try:
            data = req.json()
            raw = data.get("target") or data.get("mac") or ""
            mac, name, directed_ip = power_ops.resolve_target(raw, db.get_setting("mac_overrides", {}))
            if data.get("ip"):
                directed_ip = data["ip"]
            res = power_ops.send_magic_packet(mac, directed_ip)
            if name:
                res["resolved_name"] = name
            log_action(name or raw, "wake", "ok", mac, "api")
            return res
        except ValueError as e:
            req.respond({"error": str(e)}, 400)
            return None
        except Exception as e:
            req.respond({"error": str(e)}, 500)
            return None

    def h_doctor(req, params):
        name = req.query_params.get("target", "")
        if not name:
            req.respond({"error": "missing 'target' query param"}, 400)
            return None
        return power_ops.check_wol(name, db.get_setting("iface_overrides", {}))

    def h_arm(req, params):
        try:
            data = req.json() or {}
            name = (data.get("target") or "").strip()
            if not name:
                req.respond({"error": "missing 'target'"}, 400)
                return None
            res = power_ops.arm_wol(name, db.get_setting("iface_overrides", {}))
            # A refused arm must not look like success to scripts (h_sleep
            # already follows this pattern for its refusals).
            if not res.get("ok") and res.get("link") == "wifi":
                req.respond({"error": res.get("reason", "wireless NIC"),
                             "code": "wireless_nic", **res}, 409)
                return None
            return res
        except Exception as e:
            req.respond({"error": str(e)}, 500)
            return None

    def h_sleep(req, params):
        try:
            name = (req.json().get("target") or "").strip()
            if not name:
                req.respond({"error": "missing 'target'"}, 400)
                return None
            # Gate order matters — each answer must be truthful on its own:
            #   unknown host  -> 404 (a typo must never report success; before
            #                    this check, `sleep familair` returned ok/noop
            #                    "already asleep" because reachable() treats
            #                    no-evidence as unreachable — 2026-08-16)
            #   not allowed   -> 403 (even if currently off: policy first)
            #   already off   -> ok/noop (idempotent "ensure asleep")
            #   not armed     -> 409 (would strand: no way to wake it back)
            if name not in {h["name"] for h in managed_hosts()}:
                req.respond({"error": f"unknown host {name!r} — not a WoL-managed fleet "
                             "host (see `realm wol show`)", "code": "unknown_host"}, 404)
                return None
            if name not in db.get_setting("sleepable", []):
                req.respond({"error": f"{name!r} is not in the sleepable allow-list",
                             "code": "not_sleepable"}, 403)
                return None
            if not reachable(name):
                return {"ok": True, "noop": True,
                        "message": f"{name} is not reachable (already asleep/off) — no action"}
            doctor = power_ops.check_wol(name, db.get_setting("iface_overrides", {}))
            if not doctor.get("armed"):
                req.respond({"error": f"refusing to sleep {name!r}: WoL not armed "
                             f"({doctor.get('reason', '')})", "code": "not_armed",
                             "doctor": doctor}, 409)
                return None
            res = power_ops.suspend_host(name)
            log_action(name, "sleep", "ok" if res["ok"] else "error", res.get("stderr") or "", "api")
            if not res["ok"]:
                req.respond({"error": "suspend command failed", "detail": res}, 502)
                return None
            return {"ok": True, "slept": name, "detail": res}
        except Exception as e:
            req.respond({"error": str(e)}, 500)
            return None

    # /wol is a top-level (raw) path for frontend parity; the rest auto-prefix
    # to /plugins/wol/<name>.
    ctx.register_endpoint("POST", "/wol", h_wol, raw_path=True)
    ctx.register_endpoint("GET", "status", lambda req, params: {"hosts": status_rows()})
    ctx.register_endpoint("GET", "doctor", h_doctor)
    ctx.register_endpoint("POST", "sleep", h_sleep)
    ctx.register_endpoint("POST", "arm", h_arm)

    # --- map integration: status provider + slumber node badge ---
    # _last_state is written by the background `watch` thread and read by the
    # HTTP `enrich` handler — guard every access with _state_lock.
    _last_state = {}
    _state_lock = threading.Lock()

    ctx.register_status_provider(lambda: {"wol": {r["host"]: r["state"] for r in status_rows()}})

    def enrich(node_id, node_data):
        with _state_lock:
            cur = _last_state.get(node_id)
        if cur == "slumbering":
            return {"badge": "🌙", "sublabel": "slumbering", "status_class": "wol-slumber"}
        return None
    ctx.register_node_enricher(enrich, priority=40)

    # --- reachability-edge watcher: themed events + loose RPG hooks ---
    _THEMES = {
        "slumbering": ("speech", "🌙 {host} slips into slumber."),
        "awake": ("speech", "⚡ {host} awakens."),
        "dark": ("alert", "🕯️ {host} has gone dark."),
    }

    def watch():
        prog = ctx.get_plugin_api("progression")
        codex = ctx.get_plugin_api("codex")
        # Pay the probe cost on this thread, not on a /status request.
        refresh_liveness()
        for r in status_rows():
            host, cur = r["host"], r["state"]
            with _state_lock:
                prev = _last_state.get(host)
            if prev is not None and prev != cur and cur in _THEMES:
                kind, tmpl = _THEMES[cur]
                ctx.push_event("realm-event", {"kind": kind, "node": host,
                                               "subtype": f"wol.{cur}", "text": tmpl.format(host=host)})
                if cur == "slumbering" and prog and "grant_xp" in prog:
                    try:
                        prog["grant_xp"](player_id="default", amount=5, source_type="wol.slumber")
                    except Exception as e:
                        ctx.log(f"wol xp hook failed: {e}")
                if cur in ("slumbering", "awake") and codex and "add_journal_entry" in codex:
                    try:
                        codex["add_journal_entry"](entry_type="chronicle",
                                                   title=tmpl.format(host=host),
                                                   content=f"{host} entered power state {cur}.",
                                                   entity_id=host)
                    except Exception as e:
                        ctx.log(f"wol codex hook failed: {e}")
            with _state_lock:
                _last_state[host] = cur
    ctx.start_background_thread(watch, interval=20, name="wol-watch")

    # --- public API for other plugins ---
    def wake_api(target):
        mac, name, directed_ip = power_ops.resolve_target(target, db.get_setting("mac_overrides", {}))
        res = power_ops.send_magic_packet(mac, directed_ip)
        log_action(name or target, "wake", "ok", mac, "api")
        return res

    ctx.expose_api({"wake": wake_api, "power_states": status_rows, "is_reachable": reachable})

    ctx.log("Slumber Ward (wol) loaded — wake + S3 sleep + power state")
