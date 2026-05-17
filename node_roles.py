#!/usr/bin/env python3
"""Node role definitions and 6-signal enrichment pipeline for discovered devices.

Two responsibilities:
  1. Role schema (ROLES dict) — 30+ roles with icon, color, stats sources,
     and description. Used by the frontend to style node cards.
  2. Enrichment pipeline (enrich_unknown_node) — called by ap_scanner when a
     new MAC is seen on the network. Combines 6 signals to identify the device
     and generate a label, sublabel, icon, and persona.

Enrichment pipeline (enrich_unknown_node):
  Signal 1: Hostname pattern matching  — most reliable; 40+ regex patterns
  Signal 2: OUI vendor lookup          — MAC prefix → vendor + default role
  Signal 3: Randomized MAC heuristic   — locally-administered bit + VLAN → phone
  Signal 4: TCP port probe             — quick scan of 11 ports (SSH, SMB, etc.)
  Signal 5: Home Assistant device_tracker + device registry (manufacturer/model)
  Signal 6: LLDP neighbor data        — authoritative hostname for wired devices

Seed data vs live data:
  _SEED_OUI, _SEED_NODE_ROLES, _SEED_HA_MAP are migration-only defaults.
  After migrate_to_db() runs once, all data lives in realm.db settings table
  and is loaded into in-memory caches on first access. Modify live data via
  the realm.db settings API, not these seed dicts.

Threading:
  No locks. Cache reads/writes (_oui_cache, _ha_map_cache) are synchronous.
  enrich_unknown_node() makes network calls (port probe, HA, LLDP lookups)
  and is called from ap_scanner's ThreadPoolExecutor, so it must be thread-safe
  for reads — it is, since it only reads from caches and makes local calls.

Configuration:
  All instance data (OUI map, node roles, HA map) is stored in realm.db.
  reload_caches() forces a re-read after settings changes.

Public API (imported by ap_scanner, ha_bridge, map_server):
  enrich_unknown_node(node_id, mac, hostname, ip) -> (node_data, persona)
  get_role(node_id, node_data)                    -> str
  get_role_info(node_id, node_data)               -> dict
  get_all_roles()                                 -> ROLES dict
  get_nodes_by_role()                             -> {role: [node_id, ...]}
  oui_lookup(mac)                                 -> (vendor, role)
  get_ha_map()                                    -> {node_id: config}
  migrate_to_db()                                 # idempotent seed on first run
  reload_caches()                                 # force DB re-read
  ROLES                                           # role schema dict
  ROLE_ICONS                                      # role → HTML entity icon
"""

import realm_db

# ── Seed data: OUI prefixes (migration only) ──
# After migrate_to_db(), these are read from settings table.
_SEED_OUI = {
    # Espressif (ESP32/ESP8266)
    "f0:f5:bd": ("Espressif", "sensor"), "b4:e8:42": ("Espressif", "sensor"),
    "b4:e6:2d": ("Espressif", "sensor"), "e8:68:e7": ("Espressif", "sensor"),
    "bc:dd:c2": ("Espressif", "sensor"), "60:01:94": ("Espressif", "sensor"),
    "24:a1:60": ("Espressif", "sensor"), "2c:f4:32": ("Espressif", "sensor"),
    "18:de:50": ("Espressif", "sensor"), "b8:06:0d": ("Espressif", "sensor"),
    "48:3f:da": ("Espressif", "sensor"), "ac:67:b2": ("Espressif", "sensor"),
    # Nest Labs
    "14:c1:4e": ("Nest", "thermostat"), "ac:67:84": ("Nest", "thermostat"),
    "d8:eb:46": ("Nest", "thermostat"),
    # TP-Link / Kasa
    "90:9a:4a": ("Kasa", "plug"), "e8:48:b8": ("Kasa", "plug"),
    "b0:a7:b9": ("Kasa", "plug"), "c0:06:c3": ("Kasa", "plug"),
    "1c:3b:f3": ("TP-Link", "plug"), "50:c7:bf": ("TP-Link", "ap"),
    "60:32:b1": ("TP-Link", "plug"), "6c:5a:b0": ("TP-Link", "plug"),
    # SwitchBot
    "68:c6:3a": ("SwitchBot", "plug"),
    # Tuya / generic smart home
    "fc:58:4a": ("Tuya", "plug"), "ca:2c:4f": ("HiSmart", "plug"),
    "50:8b:b9": ("Tuya", "plug"), "f8:17:2d": ("Tuya", "plug"),
    "38:1f:8d": ("Tuya", "plug"), "a8:80:55": ("Tuya", "plug"),
    "c4:82:e1": ("Tuya", "plug"), "7c:f6:66": ("Tuya", "plug"),
    "d8:1f:12": ("Tuya", "plug"),
    # Meross
    "48:e1:e9": ("Meross", "plug"),
    # Samsung
    "f2:4a:37": ("Samsung", "tablet"), "8e:85:90": ("Samsung", "phone"),
    "00:1e:e2": ("Samsung", "phone"), "84:25:19": ("Samsung", "phone"),
    "a8:7c:01": ("Samsung", "phone"), "6c:f3:73": ("Samsung", "phone"),
    # Google
    "a4:77:33": ("Google", "speaker"), "f4:f5:d8": ("Google", "speaker"),
    "24:e5:0f": ("Google", "speaker"), "dc:e5:5b": ("Google", "speaker"),
    "d4:f5:47": ("Google", "speaker"), "f0:ef:86": ("Google", "speaker"),
    "3c:8d:20": ("Google", "speaker"), "30:fd:38": ("Google", "speaker"),
    "54:60:09": ("Google", "speaker"),
    # Apple
    "f0:18:98": ("Apple", "phone"), "10:94:bb": ("Apple", "laptop"),
    "3c:06:30": ("Apple", "laptop"), "ac:bc:32": ("Apple", "laptop"),
    "a8:88:08": ("Apple", "laptop"), "14:7d:da": ("Apple", "phone"),
    "f0:b4:29": ("Apple", "phone"), "28:6a:ba": ("Apple", "laptop"),
    "88:66:5a": ("Apple", "laptop"), "c8:89:f3": ("Apple", "phone"),
    # Dell
    "f8:bc:12": ("Dell", "laptop"), "18:db:f2": ("Dell", "laptop"),
    "b0:83:fe": ("Dell", "laptop"), "00:14:22": ("Dell", "laptop"),
    "d4:be:d9": ("Dell", "laptop"), "24:b6:fd": ("Dell", "laptop"),
    "74:e6:e2": ("Dell", "laptop"), "e4:b9:7a": ("Dell", "laptop"),
    "f4:8e:38": ("Dell", "laptop"), "98:90:96": ("Dell", "laptop"),
    # HP / HPE
    "00:1a:4b": ("HP", "laptop"), "3c:d9:2b": ("HP", "laptop"),
    "a0:d3:c1": ("HP", "laptop"), "c8:b5:b7": ("HP", "laptop"),
    "ec:8e:b5": ("HP", "laptop"), "10:1f:74": ("HP", "laptop"),
    "e4:11:5b": ("HP", "laptop"), "68:b5:99": ("HP", "laptop"),
    "fc:15:b4": ("HP", "laptop"),
    # Lenovo
    "50:5b:c2": ("Lenovo", "laptop"), "70:72:0d": ("Lenovo", "laptop"),
    "e8:6a:64": ("Lenovo", "laptop"), "00:06:1b": ("Lenovo", "laptop"),
    "c8:21:58": ("Lenovo", "laptop"), "8c:16:45": ("Lenovo", "laptop"),
    "b0:c4:20": ("Lenovo", "laptop"),
    # Intel (often in laptops/desktops)
    "00:1e:64": ("Intel", "laptop"), "f8:0f:f9": ("Intel", "laptop"),
    "ac:fd:ce": ("Intel", "laptop"), "dc:1b:a1": ("Intel", "laptop"),
    "3c:58:c2": ("Intel", "laptop"),
    # Microsoft (Surface)
    "28:18:78": ("Microsoft", "laptop"), "00:15:5d": ("Microsoft", "vm"),
    "7c:1e:52": ("Microsoft", "laptop"),
    # Hikvision
    "c0:56:e3": ("Hikvision", "camera"), "bc:ad:28": ("Hikvision", "camera"),
    # Roku
    "b0:a7:37": ("Roku", "tv"), "d8:31:34": ("Roku", "tv"),
    "dc:3a:5e": ("Roku", "tv"), "b0:ee:45": ("Roku", "tv"),
    # Amazon
    "fc:65:de": ("Amazon", "speaker"), "44:65:0d": ("Amazon", "speaker"),
    "a0:02:dc": ("Amazon", "speaker"), "74:c2:46": ("Amazon", "tablet"),
    # Raspberry Pi
    "b8:27:eb": ("RPi", "server"), "dc:a6:32": ("RPi", "server"),
    "e4:5f:01": ("RPi", "server"), "d8:3a:dd": ("RPi", "server"),
    # iRobot (Roomba)
    "50:14:79": ("iRobot", "vacuum"),
    # Sonos
    "00:0e:58": ("Sonos", "speaker"), "b8:e9:37": ("Sonos", "speaker"),
    # Wyze
    "2c:aa:8e": ("Wyze", "camera"),
    # Ring
    "4c:e1:73": ("Ring", "camera"),
    # LG
    "00:1c:62": ("LG", "tv"), "64:99:5d": ("LG", "tv"),
    "a8:23:fe": ("LG", "tv"),
    # Sony (PlayStation)
    "00:d9:d1": ("Sony PS", "tv"), "fc:0f:e6": ("Sony PS", "tv"),
    "00:04:1f": ("Sony PS", "tv"),
    # Nintendo
    "58:2f:40": ("Nintendo", "tv"), "98:b6:e9": ("Nintendo", "tv"),
    "00:1f:32": ("Nintendo", "tv"),
    # Xbox
    "60:45:bd": ("Xbox", "tv"), "c8:3f:26": ("Xbox", "tv"),
    # Printer vendors
    "00:1b:a9": ("Brother", "printer"), "30:05:5c": ("Brother", "printer"),
    "00:80:77": ("Brother", "printer"),
    "00:18:fe": ("Canon", "printer"), "18:0c:ac": ("Canon", "printer"),
    "00:00:48": ("Epson", "printer"),
    "a4:5d:36": ("HP", "printer"),
}

# ── Seed data: Node→Role mappings (migration only) ──
# After migrate_to_db(), roles stored as _role field on each node in DB.
_SEED_NODE_ROLES = {
    # Populated by JP's local install via the persona-editor / realm CLI.
    # Mappings are stored on each node's _role field in realm.db.
    # Add your own per-host role assignments here OR edit via the UI.
}

# ── Seed data: HA entity→node mappings (migration only) ──
# After migrate_to_db(), stored in settings table.
_SEED_HA_MAP = {
    # Populated by your local install. Each entry maps a topology node id
    # to one or more Home Assistant entities, optionally with a function
    # name (climate_cluster, solar, camera_cluster, etc.) the HA bridge
    # uses to render sublabels. See plugins/ha/ for the consumer.
}

# ── In-memory cache (loaded from DB on first use) ──
_oui_cache = None
_ha_map_cache = None


def _load_oui():
    global _oui_cache
    data = realm_db.get_setting("oui", "map")
    _oui_cache = data if isinstance(data, dict) else {}


def _load_ha_map():
    global _ha_map_cache
    data = realm_db.get_setting("ha", "entity_map")
    _ha_map_cache = data if isinstance(data, dict) else {}


def reload_caches():
    """Force reload of DB-backed caches (call after settings change)."""
    _load_oui()
    _load_ha_map()


def oui_lookup(mac):
    """Look up vendor and default role from MAC OUI prefix (DB-backed)."""
    global _oui_cache
    if _oui_cache is None:
        _load_oui()
    prefix = mac.lower()[:8]
    entry = _oui_cache.get(prefix)
    if entry:
        return entry.get("vendor"), entry.get("role")
    return None, None


def get_ha_map():
    """Get HA entity→node mapping config (DB-backed)."""
    global _ha_map_cache
    if _ha_map_cache is None:
        _load_ha_map()
    return _ha_map_cache


# ── Role type definitions (schema — stays in code) ──

ROLES = {
    # Infrastructure
    "router": {
        "icon": "\U0001f310", "color": "#60a0c0", "title": "Router",
        "sources": ["collectd", "ha"],
        "stats": ["load", "memory", "conntrack", "dhcp", "interfaces", "uptime"],
        "desc": "Network router / firewall"
    },
    "ap": {
        "icon": "\U0001f4e1", "color": "#60c0a0", "title": "Access Point",
        "sources": ["collectd", "wifi"],
        "stats": ["load", "memory", "wifi_clients", "interfaces", "uptime"],
        "desc": "WiFi access point"
    },
    "switch": {
        "icon": "\U0001f500", "color": "#a0a0c0", "title": "Network Switch",
        "sources": ["collectd"],
        "stats": ["interfaces", "uptime"],
        "desc": "Ethernet switch"
    },
    "bridge": {
        "icon": "\U0001f309", "color": "#c0a060", "title": "Wireless Bridge",
        "sources": ["collectd"],
        "stats": ["load", "interfaces", "ping", "uptime"],
        "desc": "Point-to-point wireless bridge"
    },
    # Servers
    "server": {
        "icon": "\U0001f5a5\ufe0f", "color": "#c06060", "title": "Server",
        "sources": ["collectd", "tailscale"],
        "stats": ["load", "memory", "disk", "thermal", "interfaces", "uptime"],
        "desc": "Compute server"
    },
    "nas": {
        "icon": "\U0001f4be", "color": "#c08060", "title": "NAS",
        "sources": ["collectd"],
        "stats": ["load", "memory", "disk", "interfaces", "uptime"],
        "desc": "Network attached storage"
    },
    "vm": {
        "icon": "\U0001f4e6", "color": "#a060c0", "title": "Virtual Machine",
        "sources": ["collectd", "tailscale"],
        "stats": ["load", "memory", "disk", "interfaces"],
        "desc": "Virtual machine"
    },
    # Smart Home
    "wled": {
        "icon": "\U0001f308", "color": "#ff6090", "title": "LED Controller",
        "sources": ["wled", "ha"],
        "stats": ["on", "brightness", "effect", "led_count", "wifi_rssi", "uptime"],
        "desc": "WLED LED strip controller"
    },
    "thermostat": {
        "icon": "\U0001f321\ufe0f", "color": "#60c0c0", "title": "Thermostat",
        "sources": ["ha"],
        "stats": ["temperature", "humidity", "hvac_state", "battery"],
        "desc": "Smart thermostat"
    },
    "camera": {
        "icon": "\U0001f4f9", "color": "#c06080", "title": "Camera",
        "sources": ["ha"],
        "stats": ["recording", "motion", "stream"],
        "desc": "Security camera"
    },
    "speaker": {
        "icon": "\U0001f50a", "color": "#6090c0", "title": "Smart Speaker",
        "sources": ["ha"],
        "stats": ["playing", "volume", "media"],
        "desc": "Smart speaker / display"
    },
    "plug": {
        "icon": "\U0001f50c", "color": "#c0c060", "title": "Smart Plug",
        "sources": ["ha"],
        "stats": ["on", "power", "energy"],
        "desc": "Smart plug / outlet"
    },
    "sensor": {
        "icon": "\U0001f4ca", "color": "#60c060", "title": "Sensor",
        "sources": ["ha"],
        "stats": ["presence", "temperature", "humidity", "light"],
        "desc": "ESP/Zigbee sensor"
    },
    "appliance": {
        "icon": "\U0001f3e0", "color": "#a0c060", "title": "Smart Appliance",
        "sources": ["ha"],
        "stats": ["state", "cycle", "energy"],
        "desc": "Smart appliance (washer, dryer, etc.)"
    },
    "vacuum": {
        "icon": "\U0001f916", "color": "#60a060", "title": "Robot Vacuum",
        "sources": ["ha"],
        "stats": ["state", "battery", "area"],
        "desc": "Robot vacuum"
    },
    # Power
    "inverter": {
        "icon": "\u2600\ufe0f", "color": "#c0a030", "title": "Solar Inverter",
        "sources": ["ha", "collectd"],
        "stats": ["power", "battery_v", "battery_soc", "grid", "daily_kwh"],
        "desc": "Solar inverter / battery system"
    },
    "ups": {
        "icon": "\U0001f50b", "color": "#60c030", "title": "UPS",
        "sources": ["ha", "collectd"],
        "stats": ["status", "battery", "load", "runtime"],
        "desc": "Uninterruptible power supply"
    },
    "ev_charger": {
        "icon": "\u26a1", "color": "#30c0c0", "title": "EV Charger",
        "sources": ["ha"],
        "stats": ["state", "power", "session_kwh"],
        "desc": "Electric vehicle charger"
    },
    # Mobile / Personal
    "phone": {
        "icon": "\U0001f4f1", "color": "#a080c0", "title": "Phone",
        "sources": ["ha", "tailscale", "wifi"],
        "stats": ["battery", "charging", "wifi_signal"],
        "desc": "Mobile phone"
    },
    "tablet": {
        "icon": "\U0001f4df", "color": "#80a0c0", "title": "Tablet",
        "sources": ["ha", "wifi"],
        "stats": ["battery", "wifi_signal"],
        "desc": "Tablet device"
    },
    "laptop": {
        "icon": "\U0001f4bb", "color": "#8080c0", "title": "Laptop",
        "sources": ["collectd", "tailscale", "wifi"],
        "stats": ["load", "memory", "battery", "wifi_signal"],
        "desc": "Laptop computer"
    },
    "desktop": {
        "icon": "\U0001f5a5\ufe0f", "color": "#6060c0", "title": "Desktop",
        "sources": ["collectd", "tailscale"],
        "stats": ["load", "memory", "disk", "thermal", "gpu"],
        "desc": "Desktop computer"
    },
    # Media
    "tv": {
        "icon": "\U0001f4fa", "color": "#c080a0", "title": "TV / Streaming",
        "sources": ["ha"],
        "stats": ["state", "app", "volume"],
        "desc": "Smart TV or streaming device"
    },
    # Tailscale
    "tailscale": {
        "icon": "\U0001f517", "color": "#6080ff", "title": "Tailscale Node",
        "sources": ["tailscale"],
        "stats": ["online", "ip", "os", "link", "traffic", "key_expiry"],
        "desc": "Tailscale-connected remote device"
    },
    # Printer
    "printer": {
        "icon": "\U0001f5a8\ufe0f", "color": "#a0a080", "title": "Printer",
        "sources": ["ha"],
        "stats": ["state", "ink", "jobs"],
        "desc": "Network printer / scanner"
    },
    # Unknown
    "unknown": {
        "icon": "\u2753", "color": "#808080", "title": "Unknown Device",
        "sources": ["wifi", "ha"],
        "stats": ["ip", "mac", "wifi_signal"],
        "desc": "Unidentified device"
    },
}


# ── Role lookup (reads _role from node data in DB) ──

def get_role(node_id, node_data=None):
    """Get the role for a node. Checks stored _role first, then auto-detects."""
    # Stored role on node takes priority
    if node_data and node_data.get("_role"):
        return node_data["_role"]

    # Explicit OS (written by `realm discover-os` via SSH probe) implies role.
    # This runs before pattern heuristics so probed hosts get correct roles
    # even without MAC/OUI data — fixes auto-discovery for nodes added by
    # POST /node which don't carry a MAC.
    if node_data:
        os_id = (node_data.get("os") or "").strip().lower()
        if os_id in ("ubuntu", "debian", "centos", "rocky", "alma", "fedora", "rhel", "linux"):
            return "server"
        if os_id == "alpine":
            return "server"  # Alpine boxes (e.g. HA OS) are server-class for discovery
        if os_id == "openwrt":
            node_type = (node_data.get("type") or "").lower()
            return "router" if node_type in ("router", "core") else "ap"

    # Auto-detect from node ID patterns
    nid = node_id.lower()
    if nid.startswith("wled"):
        return "wled"
    if nid.startswith("onhub") or nid.startswith("eap"):
        return "ap"
    if nid.startswith("ts-"):
        return "tailscale"
    if nid.startswith("esp"):
        return "sensor"

    # Auto-detect from node data (MAC, IP, type)
    if node_data:
        mac = node_data.get("mac", "")
        ip = node_data.get("ip", "")
        node_type = node_data.get("type", "")

        # OUI vendor lookup from MAC
        if mac:
            _, oui_role = oui_lookup(mac)
            if oui_role:
                return oui_role

        # Wired devices in admin VLAN
        if mac and ip and ip.startswith("10.0.6."):
            if node_type in ("core", "infra", "tower"):
                return "server"
            if node_type == "bridge":
                return "bridge"
            if "switch" in nid or "gs" in nid:
                return "switch"
            if "router" in nid or "wrt" in nid or "mr" in nid:
                return "router"
            if "cam" in nid or "hik" in nid:
                return "camera"

    return "unknown"


def get_role_info(node_id, node_data=None):
    """Get full role info for a node."""
    role = get_role(node_id, node_data)
    return {"role": role, **ROLES.get(role, ROLES["unknown"])}


def get_all_roles():
    """Get all role definitions, merging in any template data."""
    out = {}
    for name, role in ROLES.items():
        merged = dict(role)
        if name in ROLE_TEMPLATES:
            merged["template"] = ROLE_TEMPLATES[name]
        out[name] = merged
    return out


def get_role_template(role_name):
    """Return the template block for a role, or {} if none defined.

    The template carries the operational binding for a role:
      - alert_rules: rule IDs that should fire for this role (informational
        for now; future: realm role apply instantiates them)
      - discovery_providers: which scanners run on hosts with this role
        (mirrors ROLE_PROVIDERS in discovery_engine for consistency)
      - default_tags: tags auto-attached to any host of this role
      - sublabel_format: jinja-style template for the SVG map sublabel

    Templates are intentionally code-defined for now (no DB schema). If
    per-host override becomes useful, add a node_role_overrides settings ns.
    """
    return dict(ROLE_TEMPLATES.get(role_name, {}))


# ── Role Templates (Zabbix-inspired, issue #3) ──
#
# Each template binds a role to: alerting rules that apply, discovery
# providers that should run, default tags, and a sublabel format. Not every
# role needs a template — roles without one fall through to the legacy
# behaviour (no rule binding, ROLE_PROVIDERS from discovery_engine.py).

ROLE_TEMPLATES = {
    "router": {
        "alert_rules": ["latency-spike", "dhcp-overflow", "high-load"],
        "discovery_providers": ["snmp", "netdata"],
        "default_tags": ["network", "infrastructure", "critical"],
        "sublabel_format": "{load} • {wan_state}",
    },
    "ap": {
        "alert_rules": ["wifi-client-flap", "high-load"],
        "discovery_providers": ["snmp"],
        "default_tags": ["network", "wifi"],
        "sublabel_format": "{clients} clients • {channel}",
    },
    "switch": {
        "alert_rules": ["port-down", "loop-detected"],
        "discovery_providers": ["snmp"],
        "default_tags": ["network", "infrastructure"],
        "sublabel_format": "{ports_up}/{ports_total} ports",
    },
    "bridge": {
        "alert_rules": ["link-down"],
        "discovery_providers": ["snmp"],
        "default_tags": ["network"],
    },
    "server": {
        "alert_rules": ["linux-disk-full", "linux-load-high", "linux-mem-pressure"],
        "discovery_providers": ["docker", "systemd", "netdata"],
        "default_tags": ["linux", "infrastructure"],
        "sublabel_format": "{cpu_pct}% • {disk_pct}% • {mem_pct}%",
    },
    "nas": {
        "alert_rules": ["linux-disk-full", "raid-degraded"],
        "discovery_providers": ["docker", "systemd", "netdata", "snmp"],
        "default_tags": ["storage", "linux"],
    },
    "vm": {
        "alert_rules": ["linux-disk-full", "linux-load-high"],
        "discovery_providers": ["systemd", "netdata"],
        "default_tags": ["linux", "virtual"],
    },
    "hypervisor": {
        "alert_rules": ["host-load-high", "vm-failure"],
        "discovery_providers": ["docker", "kvm", "systemd", "netdata"],
        "default_tags": ["linux", "virtual", "infrastructure"],
    },
    "desktop": {
        "alert_rules": ["linux-disk-full"],
        "discovery_providers": ["systemd", "netdata"],
        "default_tags": ["linux", "desktop"],
    },
    "laptop": {
        "alert_rules": ["battery-low"],
        "discovery_providers": ["netdata"],
        "default_tags": ["linux", "mobile"],
    },
    "camera": {
        "alert_rules": ["camera-offline", "motion-event"],
        "default_tags": ["security", "ha"],
    },
    "wled": {
        "alert_rules": ["wled-offline"],
        "default_tags": ["lighting"],
    },
    "sensor": {
        "alert_rules": ["sensor-stale"],
        "default_tags": ["iot"],
    },
    "ups": {
        "alert_rules": ["ups-on-battery", "ups-low-battery", "ups-critical"],
        "discovery_providers": ["snmp"],
        "default_tags": ["power", "infrastructure", "critical"],
    },
    "printer": {
        "alert_rules": ["printer-error", "printer-low-toner"],
        "discovery_providers": ["snmp"],
        "default_tags": ["peripheral"],
    },
}


def get_nodes_by_role():
    """Group all nodes by role (reads from DB)."""
    by_role = {}
    for node in realm_db.get_nodes():
        role = node.get("_role") or get_role(node.get("id", ""), node)
        by_role.setdefault(role, []).append(node.get("id", ""))
    return by_role


# ── Auto-enrichment for discovered nodes ──

ROLE_ICONS = {
    "router": "&#127760;", "ap": "&#128225;", "switch": "&#128256;",
    "bridge": "&#127753;", "server": "&#128421;", "nas": "&#128190;",
    "vm": "&#128230;", "wled": "&#127752;", "thermostat": "&#127777;",
    "camera": "&#128249;", "speaker": "&#128266;", "plug": "&#128268;",
    "sensor": "&#128202;", "appliance": "&#127968;", "vacuum": "&#129302;",
    "inverter": "&#9728;", "ups": "&#128267;", "ev_charger": "&#9889;",
    "phone": "&#128241;", "tablet": "&#128223;", "laptop": "&#128187;",
    "desktop": "&#128421;", "tv": "&#128250;", "tailscale": "&#128279;",
    "printer": "&#128424;",
    "unknown": "&#128123;",
}

ROLE_PERSONAS = {
    "sensor": {"voice": "whisper", "personality": "A quiet sentinel, watching and reporting from the shadows."},
    "plug": {"voice": "steady", "personality": "A loyal servant channeling arcane power on command."},
    "thermostat": {"voice": "warm", "personality": "A climate keeper, balancing warmth and chill."},
    "camera": {"voice": "vigilant", "personality": "An ever-watchful eye, guarding the perimeter."},
    "speaker": {"voice": "melodic", "personality": "A bard, filling halls with sound and story."},
    "phone": {"voice": "swift", "personality": "A swift messenger, roaming the realm."},
    "tablet": {"voice": "calm", "personality": "A portable scribe, always at hand."},
    "appliance": {"voice": "industrious", "personality": "A tireless worker in the domestic forge."},
    "vacuum": {"voice": "determined", "personality": "A wandering golem, cleaning the realm's floors."},
    "tv": {"voice": "dramatic", "personality": "A window to other realms, showing visions and tales."},
    "printer": {"voice": "methodical", "personality": "A meticulous scribe, inscribing scrolls on command."},
    "laptop": {"voice": "clever", "personality": "A traveling scholar, carrying knowledge between realms."},
    "desktop": {"voice": "commanding", "personality": "A stationary tower of arcane computation."},
    "unknown": {"voice": "mysterious", "personality": "A wandering spirit, identity not yet revealed."},
}


def _is_randomized_mac(mac):
    """Check if MAC is locally administered (randomized by Android/iOS)."""
    first_byte = int(mac.split(":")[0], 16)
    return bool((first_byte >> 1) & 1)


# VLAN labels for labeling devices by network
_VLAN_LABELS = {
    "10.0.6.": "Admin", "10.0.8.": "Family",
    "10.0.10.": "IoT", "10.0.11.": "Guest",
}


def _vlan_label(ip):
    """Get VLAN name from IP prefix."""
    if not ip:
        return None
    for prefix, name in _VLAN_LABELS.items():
        if ip.startswith(prefix):
            return name
    return None


def _probe_ports(ip, timeout=1.5):
    """Quick TCP probe of key ports to fingerprint a device. Returns dict of findings."""
    import socket
    # port → (service, role_hint, os_hint)
    PROBES = {
        22:    ("SSH", "server", "Linux"),
        80:    ("HTTP", None, None),
        443:   ("HTTPS", None, None),
        445:   ("SMB", "desktop", "Windows"),
        548:   ("AFP", "laptop", "macOS"),
        631:   ("IPP", "printer", None),
        3389:  ("RDP", "desktop", "Windows"),
        5353:  ("mDNS", None, None),
        8009:  ("Chromecast", "tv", None),
        9100:  ("RAW Print", "printer", None),
        62078: ("iSync", "phone", "iOS"),
    }
    results = {"open_ports": [], "role_hint": None, "os_hint": None}
    for port, (service, role_hint, os_hint) in PROBES.items():
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.settimeout(timeout)
            if s.connect_ex((ip, port)) == 0:
                results["open_ports"].append((port, service))
                if role_hint and not results["role_hint"]:
                    results["role_hint"] = role_hint
                if os_hint and not results["os_hint"]:
                    results["os_hint"] = os_hint
        except (socket.error, OSError):
            pass
        finally:
            s.close()
    return results


# Hostname → (role, os, model) patterns
_HOSTNAME_PATTERNS = [
    # Windows
    (r"^DESKTOP-", "desktop", "Windows", None),
    (r"^LAPTOP-", "laptop", "Windows", None),
    (r"^WIN-", "desktop", "Windows", None),
    # Apple
    (r"(?i)macbook.?pro", "laptop", "macOS", "MacBook Pro"),
    (r"(?i)macbook.?air", "laptop", "macOS", "MacBook Air"),
    (r"(?i)macbook", "laptop", "macOS", "MacBook"),
    (r"(?i)imac", "desktop", "macOS", "iMac"),
    (r"(?i)iphone", "phone", "iOS", "iPhone"),
    (r"(?i)ipad", "tablet", "iPadOS", "iPad"),
    (r"(?i)apple.?tv", "tv", "tvOS", "Apple TV"),
    (r"(?i)users?-air", "laptop", "macOS", "MacBook Air"),
    (r"(?i)air$", "laptop", "macOS", "MacBook Air"),
    # Samsung
    (r"(?i)galaxy.?s\d", "phone", "Android", "Samsung Galaxy"),
    (r"(?i)galaxy.?z.?flip", "phone", "Android", "Samsung Z Flip"),
    (r"(?i)galaxy.?z.?fold", "phone", "Android", "Samsung Z Fold"),
    (r"(?i)galaxy.?tab", "tablet", "Android", "Samsung Galaxy Tab"),
    (r"(?i)galaxy.?note", "phone", "Android", "Samsung Note"),
    (r"(?i)galaxy", "phone", "Android", "Samsung Galaxy"),
    (r"(?i)SM-[A-Z]\d{3}", "phone", "Android", "Samsung"),
    # Google
    (r"(?i)pixel.?\d", "phone", "Android", "Google Pixel"),
    (r"(?i)chromecast", "tv", "ChromeOS", "Chromecast"),
    (r"(?i)chromebook", "laptop", "ChromeOS", "Chromebook"),
    # Android generic
    (r"(?i)android", "phone", "Android", None),
    (r"(?i)oneplus", "phone", "Android", "OnePlus"),
    (r"(?i)xiaomi|redmi|poco", "phone", "Android", None),
    (r"(?i)oppo|realme", "phone", "Android", None),
    # IoT
    (r"(?i)^esp[_-]", "sensor", None, "ESP"),
    (r"(?i)^wled", "wled", None, "WLED"),
    (r"(?i)nest.?therm", "thermostat", None, "Nest Thermostat"),
    (r"(?i)nest.?cam", "camera", None, "Nest Cam"),
    (r"(?i)^kasa|^hs[12]\d\d|^kl[0-9]", "plug", None, "TP-Link Kasa"),
    (r"(?i)^hs300", "plug", None, "Kasa Power Strip"),
    (r"(?i)switchbot", "plug", None, "SwitchBot"),
    (r"(?i)hismart", "plug", None, "HiSmart"),
    (r"(?i)^roku", "tv", None, "Roku"),
    (r"(?i)roomba|irobot", "vacuum", None, "iRobot Roomba"),
    (r"(?i)ring.?door", "camera", None, "Ring Doorbell"),
    (r"(?i)^sonos", "speaker", None, "Sonos"),
    (r"(?i)echo|alexa", "speaker", None, "Amazon Echo"),
    # Printers
    (r"(?i)brother|laserjet|officejet|deskjet|epson", "printer", None, None),
    # Linux hostnames
    (r"(?i)raspberr?y", "server", "Linux", "Raspberry Pi"),
    (r"(?i)^ubuntu|^debian|^fedora|^arch|^centos", "server", "Linux", None),
]


def enrich_unknown_node(node_id, mac, hostname=None, ip=None):
    """Generate enriched node data for a newly discovered unknown device.

    Uses OUI vendor lookup, hostname pattern matching, and optional port probing.
    Returns (node_data_dict, persona_dict).
    """
    import re

    vendor, oui_role = oui_lookup(mac)
    randomized = _is_randomized_mac(mac)

    # ── Determine role + OS + model from multiple signals ──
    role = oui_role or "unknown"
    os_hint = None
    model_hint = None

    # Signal 1: Hostname pattern matching (most reliable)
    if hostname:
        hn = hostname.lower()
        for pattern, pat_role, pat_os, pat_model in _HOSTNAME_PATTERNS:
            if re.search(pattern, hostname):
                role = pat_role
                os_hint = pat_os
                model_hint = pat_model
                break

    # Signal 2: OUI vendor → refine role if still generic
    if role == "unknown" and vendor:
        vendor_lower = vendor.lower()
        if vendor_lower in ("dell", "hp", "lenovo", "intel", "microsoft"):
            role = "laptop"  # default for PC vendors; port probe may override to desktop
        elif vendor_lower in ("apple",):
            role = "laptop"
        elif vendor_lower in ("samsung",):
            role = "phone"

    # Signal 3: Randomized MACs on guest/family VLANs → likely phone/tablet
    if randomized and role == "unknown" and ip:
        vlan = _vlan_label(ip)
        if vlan in ("Guest", "Family"):
            role = "phone"

    # Signal 4: Port probe (only for devices with an IP, quick timeout)
    probe = None
    if ip and role in ("unknown", "laptop", "desktop"):
        try:
            probe = _probe_ports(ip)
            if probe["role_hint"] and role == "unknown":
                role = probe["role_hint"]
            if probe["os_hint"] and not os_hint:
                os_hint = probe["os_hint"]
        except Exception:
            pass

    # Signal 5: Home Assistant device_tracker + device registry enrichment
    ha_info = {}
    try:
        import ha_bridge
        ha_info = ha_bridge.get_device_enrichment(mac=mac, ip=ip)
        if ha_info:
            # HA friendly_name can provide a better label
            if ha_info.get("friendly_name") and not model_hint and (not hostname or hostname == "*"):
                hostname = ha_info["friendly_name"]
            # HA hostname can fill gaps
            if ha_info.get("hostname") and not hostname:
                hostname = ha_info["hostname"]
            # Device registry: manufacturer + model (authoritative)
            if ha_info.get("manufacturer") and not vendor:
                vendor = ha_info["manufacturer"]
            if ha_info.get("model") and not model_hint:
                model_hint = ha_info["model"]
    except Exception:
        pass

    # Signal 6: LLDP neighbor data (ethernet-connected devices)
    lldp_info = {}
    try:
        import ap_scanner
        lldp_info = ap_scanner.get_lldp_info(mac=mac, ip=ip, hostname=hostname)
        if lldp_info:
            # LLDP SysName is authoritative for hostname
            if lldp_info.get("remote_name") and not hostname:
                hostname = lldp_info["remote_name"]
    except Exception:
        pass

    role_info = ROLES.get(role, ROLES["unknown"])
    mac_suffix = mac[-5:].replace(":", "")
    vlan = _vlan_label(ip)

    # ── Build label (prioritize model > vendor+hostname > vendor+suffix) ──
    if model_hint and hostname and hostname != "*":
        label = model_hint if model_hint.lower() in hostname.lower() else hostname[:20]
    elif hostname and hostname != "*":
        label = hostname[:20]
    elif model_hint:
        label = model_hint
    elif vendor:
        label = f"{vendor} {mac_suffix}"
    elif randomized and vlan:
        label = f"{vlan} Device {mac_suffix}"
    else:
        label = f"Device {mac_suffix}"

    # ── Build sublabel (IP + vendor + OS + model) ──
    parts = []
    if ip:
        parts.append(ip)
    detail_parts = []
    if vendor:
        detail_parts.append(vendor)
    if model_hint and model_hint != label:
        detail_parts.append(model_hint)
    if os_hint:
        detail_parts.append(os_hint)
    if detail_parts:
        parts.append(" ".join(detail_parts))
    elif randomized:
        parts.append("Randomized MAC")
    if probe and probe["open_ports"]:
        svcs = [svc for _, svc in probe["open_ports"][:3]]
        parts.append(" ".join(svcs))
    if ha_info.get("battery") is not None:
        batt_icon = "\u26a1" if ha_info.get("charging") else "\U0001f50b"
        parts.append(f"{batt_icon}{ha_info['battery']}%")
    sublabel = " \u2022 ".join(parts) if parts else mac[:8] + "..."

    # ── Build tip with detailed stats ──
    title = model_hint or (f"{vendor} {role_info['title']}" if vendor else role_info["title"])
    tip_stats = []
    if model_hint:
        tip_stats.append(["Model", model_hint])
    if vendor:
        tip_stats.append(["Vendor", vendor])
    tip_stats.append(["Role", role_info["title"]])
    if os_hint:
        tip_stats.append(["OS", os_hint])
    if ip:
        tip_stats.append(["IP", ip])
    tip_stats.append(["MAC", mac])
    if probe and probe["open_ports"]:
        tip_stats.append(["Services", ", ".join(svc for _, svc in probe["open_ports"])])
    if randomized:
        tip_stats.append(["MAC Type", "Randomized (private)"])
    if vlan:
        tip_stats.append(["Network", vlan])
    if ha_info.get("battery") is not None:
        charging = ha_info.get("charging")
        batt_str = f"{ha_info['battery']}%"
        if charging:
            batt_str += " \u26a1"
        tip_stats.append(["Battery", batt_str])
    if ha_info.get("sw_version"):
        tip_stats.append(["SW Version", ha_info["sw_version"]])
    if ha_info.get("source_type"):
        tip_stats.append(["HA Source", ha_info["source_type"]])
    if lldp_info.get("remote_port"):
        seen_by = lldp_info.get("seen_by", "")
        tip_stats.append(["Ethernet Port", f"{lldp_info['remote_port']} (via {seen_by})"])
    if lldp_info.get("protocol"):
        tip_stats.append(["Discovery", lldp_info["protocol"]])

    icon = ROLE_ICONS.get(role, ROLE_ICONS["unknown"])
    color = role_info.get("color", "#808080")

    node_data = {
        "label": label,
        "icon": icon,
        "sublabel": sublabel,
        "iconStyle": {
            "background": f"radial-gradient(circle,{color}20,#0a0510)",
            "borderColor": f"{color}80",
            "width": "32px", "height": "32px", "fontSize": "14px",
        },
        "tip": {"title": title, "stats": tip_stats},
        "_role": role,
        "_vendor": vendor,
        "_os": os_hint,
        "_model": model_hint,
        "_hostname": hostname,
        "_ha_entity": ha_info.get("entity_id"),
        "_ha_battery": ha_info.get("battery"),
    }

    template = ROLE_PERSONAS.get(role, ROLE_PERSONAS["unknown"])
    persona = {
        "name": label,
        "voice": template["voice"],
        "personality": template["personality"],
    }

    return node_data, persona


# ── DB Migration ──

def migrate_to_db():
    """Seed node roles, OUI map, and HA entity map into DB.
    Idempotent — only runs if data is missing.
    """
    # 1. OUI map → settings
    if not realm_db.get_setting("oui", "map"):
        oui_data = {k: {"vendor": v[0], "role": v[1]} for k, v in _SEED_OUI.items()}
        realm_db.set_settings("oui", {"map": oui_data})
        print(f"  [node_roles] Seeded {len(oui_data)} OUI entries to DB")

    # 2. Node roles → _role field on each node
    migrated = 0
    for node_id, role in _SEED_NODE_ROLES.items():
        node = realm_db.get_node(node_id)
        if node and not node.get("_role"):
            node["_role"] = role
            realm_db.set_node(node_id, node)
            migrated += 1
    if migrated:
        print(f"  [node_roles] Set _role on {migrated} nodes in DB")

    # 3. HA entity map → settings
    if not realm_db.get_setting("ha", "entity_map"):
        realm_db.set_settings("ha", {"entity_map": _SEED_HA_MAP})
        print(f"  [node_roles] Seeded {len(_SEED_HA_MAP)} HA entity mappings to DB")

    # Load caches
    reload_caches()
