#!/usr/bin/env python3
"""Node role definitions — categorizes nodes by function for auto-stats.

Instance data (node roles, OUI map) stored in realm.db.
Seed data (_SEED_*) used only for initial DB migration.
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
    # Google
    "a4:77:33": ("Google", "speaker"), "f4:f5:d8": ("Google", "speaker"),
    "24:e5:0f": ("Google", "speaker"), "dc:e5:5b": ("Google", "speaker"),
    "d4:f5:47": ("Google", "speaker"), "f0:ef:86": ("Google", "speaker"),
    "3c:8d:20": ("Google", "speaker"),
    # Apple
    "f0:18:98": ("Apple", "phone"),
    # Hikvision
    "c0:56:e3": ("Hikvision", "camera"), "bc:ad:28": ("Hikvision", "camera"),
    # Roku
    "b0:a7:37": ("Roku", "tv"), "d8:31:34": ("Roku", "tv"),
    # Amazon
    "fc:65:de": ("Amazon", "speaker"),
}

# ── Seed data: Node→Role mappings (migration only) ──
# After migrate_to_db(), roles stored as _role field on each node in DB.
_SEED_NODE_ROLES = {
    # Routers
    "gatekeeper": "router", "mr8300-host": "router",
    "wrt1900ac-family": "router", "ea6350v3-family": "router",
    "ea6350-cl": "router", "wndr4300sw-shed": "router",
    # Access Points
    "onhub-closet": "ap", "onhub-bed": "ap", "onhub-office": "ap",
    "onhub-pumphouse": "ap", "onhub-family": "ap", "eap225-outdoor": "ap",
    # Switches
    "hp-switch": "switch", "gs308t": "switch",
    # Bridges
    "gigabeam0": "bridge", "gigabeam1": "bridge",
    "cpe710-ap": "bridge", "cpe710-client": "bridge",
    # Servers
    "woodshed": "ap",
    "katana": "server", "oracle": "server", "ha": "server",
    "nodered": "server", "family-vm": "vm",
    # WLED
    "wled-main": "wled", "wled-aqi": "wled",
    # Thermostats
    "nest-circle": "thermostat",
    "_unknown_14c14e61276c": "thermostat", "_unknown_14c14e6d333f": "thermostat",
    "_unknown_ac678428b56d": "thermostat", "_unknown_d8eb466182d1": "thermostat",
    "_unknown_14c14e2616b5": "thermostat",
    # Cameras
    "watchers": "camera", "hikcams": "camera",
    # Speakers
    "voice-stones": "speaker", "google-home": "speaker", "echo": "speaker",
    # Smart Plugs
    "kasa-spirits": "plug", "smart-plugs": "plug", "smart-hubs": "plug",
    # Sensors
    "esp-swarm": "sensor", "esp-office": "sensor", "esp-outdoor": "sensor",
    "esp32-bed1": "sensor", "esp32-bed2": "sensor", "esp32-bed3": "sensor",
    "esp32-a90c10": "sensor", "shed-ble": "sensor",
    "_unknown_f0f5bdfd3504": "sensor", "_unknown_b4e84212e7ac": "sensor",
    "_unknown_b43a31d1771e": "sensor",
    # Appliances
    "lg-washer": "appliance", "lg-dryer": "appliance", "bed-air": "appliance",
    "iot-closet": "appliance", "iot-pumphouse": "appliance",
    # Vacuums
    "roomba": "vacuum", "irobot": "vacuum", "wandering-golems": "vacuum",
    # Power
    "goodwe": "inverter", "apcupsmini1": "ups", "mobileups": "ups",
    "neocharge": "ev_charger",
    # Phones
    "flip3": "phone", "flip3-5g": "phone", "s24-ultra": "phone",
    "pixel-7": "phone", "pixel-4": "phone", "iphone": "phone",
    # Tablets
    "tab-s5e": "tablet", "ipad": "tablet", "kindle": "tablet",
    "_unknown_f24a37407ca1": "tablet",
    # Laptops
    "latitude-5490": "laptop", "latitude-7390": "laptop",
    "users-air": "laptop", "wolf-creek": "laptop",
    # Desktops
    "game": "desktop",
    # TV/Media
    "roku": "tv", "ts-android": "tv", "ts-android2": "tv",
    # Tailscale
    "ts-instance": "tailscale", "ts-iperf": "tailscale", "ts-terra": "tailscale",
    "ts-openclaw": "tailscale", "ts-pikvm": "tailscale", "ts-nitro": "tailscale",
    "ts-gig": "tailscale", "ts-7050": "tailscale",
    # Unknown → Plugs
    "_unknown_909a4a474ca9": "plug", "_unknown_e848b8aa3933": "plug",
    "_unknown_b0a7b9933d17": "plug", "_unknown_68c63ad2b03d": "plug",
    "_unknown_ca2c4fac00a1": "plug", "_unknown_ca2c4fad7ef5": "plug",
    "_unknown_fc584a862e9e": "plug", "_unknown_c006c3f658f5": "plug",
    # Unknown → Sensors
    "_unknown_e868e7d50978": "sensor", "_unknown_600194a441c1": "sensor",
    "_unknown_bcddc282ed19": "sensor", "_unknown_bcddc282eff7": "sensor",
    "_unknown_e868e7cfaa92": "sensor", "_unknown_24a160393fb0": "sensor",
    "_unknown_ac67b2d1f2e4": "sensor", "_unknown_483fda6a0ea8": "sensor",
    "_unknown_2cf43208cff0": "sensor", "_unknown_b4e62d79b610": "sensor",
    "_unknown_18de50775aff": "sensor", "_unknown_b8060d2b4a5d": "sensor",
    # Abstract/UI nodes
    "forge": "server", "mana": "server", "essence": "ups",
    "void": "router", "wan": "router", "gpu": "desktop",
    "scrying-pool": "server", "notion-portal": "server", "steam-works": "server",
}

# ── Seed data: HA entity→node mappings (migration only) ──
# After migrate_to_db(), stored in settings table.
_SEED_HA_MAP = {
    "nest-circle": {"fn": "climate_cluster", "entities": [
        "climate.kitchen_thermostat", "climate.bedroom_thermostat",
        "climate.bathroom_thermostat", "climate.laundry_thermostat_2",
        "climate.pumphouse_thermostat",
    ]},
    "goodwe": {"fn": "solar", "entities": {
        "kw": "sensor.goodwe_kw",
        "grid_in": "sensor.6000w_inverter_grid_watts_in",
        "w_out": "sensor.6000winverter_geninverter_watts_out",
        "batt_v": "sensor.6000w_inverter_battery_voltage",
    }},
    "watchers": {"fn": "camera_cluster", "entities": [
        "camera.uproad", "camera.car", "camera.nap",
        "camera.10_0_10_88", "camera.10_0_10_133", "camera.10_0_8_106",
    ], "also": ["hikcams"]},
    "voice-stones": {"fn": "speaker_cluster", "entities": [
        "media_player.nesthuba011", "media_player.nesthub0db6",
        "media_player.shed_speaker", "media_player.bed_speaker",
        "media_player.pumphouse_speaker", "media_player.counter",
        "media_player.kitchen_stereo", "media_player.bathroom_speaker",
        "media_player.laundry_speaker",
    ], "also": ["google-home"]},
    "kasa-spirits": {"fn": "switch_cluster", "entities": [
        "switch.computer", "switch.clamp_construction_light",
        "switch.construction_light_1", "switch.kitchen_christmas_lights",
        "switch.christmas_tree_socket_1", "switch.christmas_tree_socket_1_2",
        "switch.color_christmas_lights_switch_1", "switch.treelink_socket",
        "switch.bathroom_night_light_socket", "switch.shed_light_socket_1",
        "switch.shed_light_socket_1_2", "switch.outside_fan_socket_1",
    ], "also": ["smart-plugs"]},
    "wled-main": {"fn": "wled", "entity": "light.mamastrip"},
    "wled-aqi": {"fn": "wled", "entity": "light.claqi"},
    "bed-air": {"fn": "fan", "entity": "fan.air_purifier", "prefix": "Purifier"},
    "roomba": {"fn": "vacuum", "entity": "vacuum.roomba", "also": ["irobot"]},
    "apcupsmini1": {"fn": "ups", "prefix": "apcupsmini1"},
    "mobileups": {"fn": "ups", "prefix": "mobileups"},
    "iot-closet": {"fn": "dehumidifier", "entity": "fan.bathroom_dehumidifier", "prefix": "Dehumidifier"},
    "iot-pumphouse": {"fn": "dehumidifier", "entity": "fan.laundry_dehumidifier", "prefix": "Dehumidifier"},
    "flip3": {"fn": "phone", "prefix": "flipz3"},
    "roku": {"fn": "media_state", "entity": "media_player.roku"},
    "echo": {"fn": "echo", "entity": "select.m5stack_atom_echo_a14320_wake_word"},
    "ha": {"fn": "ha_self"},
    "_unknown_f0f5bdfd3504": {"fn": "radar", "prefix": "pumphouse_radar"},
    "lg-dryer": {"fn": "lg_appliance", "prefix": "dryer", "name": "Dryer"},
    "lg-washer": {"fn": "lg_appliance", "prefix": "washer", "name": "Washer"},
    "_unknown_b43a31d1771e": {"fn": "humidifier", "entity": "humidifier.humidifier"},
    "_unknown_b4e84212e7ac": {"fn": "rgb", "entity": "light.controller_rgb_ir_12e7ac"},
    "_unknown_fc584a862e9e": {"fn": "smart_bulb", "entity": "light.smart_bulb_2"},
    "_unknown_14c14e61276c": {"fn": "thermostat_single", "entity": "climate.kitchen_thermostat"},
    "_unknown_14c14e6d333f": {"fn": "thermostat_single", "entity": "climate.bedroom_thermostat"},
    "_unknown_ac678428b56d": {"fn": "thermostat_single", "entity": "climate.bathroom_thermostat"},
    "_unknown_d8eb466182d1": {"fn": "thermostat_single", "entity": "climate.laundry_thermostat_2"},
    "_unknown_14c14e2616b5": {"fn": "thermostat_single", "entity": "climate.pumphouse_thermostat"},
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

    # Auto-detect from node ID patterns
    nid = node_id.lower()
    if nid.startswith("wled"):
        return "wled"
    if nid.startswith("onhub") or nid.startswith("eap") or nid.startswith("woodshed"):
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
    """Get all role definitions."""
    return ROLES


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


def enrich_unknown_node(node_id, mac, hostname=None, ip=None):
    """Generate enriched node data for a newly discovered unknown device.

    Returns (node_data_dict, persona_dict).
    """
    vendor, oui_role = oui_lookup(mac)
    randomized = _is_randomized_mac(mac)

    # Determine role: stored > OUI > hostname pattern > VLAN guess > unknown
    role = oui_role or "unknown"
    if hostname:
        hn = hostname.lower()
        if "wled" in hn:
            role = "wled"
        elif "esp" in hn:
            role = "sensor"
        elif "nest" in hn or "thermo" in hn:
            role = "thermostat"
        elif "kasa" in hn or "hs1" in hn or "hs2" in hn or "kl" in hn:
            role = "plug"
        elif "cam" in hn or "hik" in hn:
            role = "camera"
        elif "roku" in hn:
            role = "tv"
        elif "iphone" in hn or "pixel" in hn or "galaxy" in hn:
            role = "phone"
        elif "ipad" in hn or "tab" in hn:
            role = "tablet"

    # Randomized MACs on guest/family VLANs are likely phones/tablets
    if randomized and role == "unknown" and ip:
        vlan = _vlan_label(ip)
        if vlan in ("Guest", "Family"):
            role = "phone"

    role_info = ROLES.get(role, ROLES["unknown"])
    mac_suffix = mac[-5:].replace(":", "")
    vlan = _vlan_label(ip)

    # Build label
    if hostname:
        label = hostname[:20]
    elif vendor:
        label = f"{vendor} {mac_suffix}"
    elif randomized and vlan:
        label = f"{vlan} Device {mac_suffix}"
    else:
        label = f"Device {mac_suffix}"

    # Sublabel
    parts = []
    if ip:
        parts.append(ip)
    if vendor:
        parts.append(vendor)
    elif randomized:
        parts.append("Randomized MAC")
    sublabel = " \u2022 ".join(parts) if parts else mac[:8] + "..."

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
        "_role": role,
        "_vendor": vendor,
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
