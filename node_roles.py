#!/usr/bin/env python3
"""Node role definitions — categorizes nodes by function for auto-stats."""

# Node roles define what kind of device a node is and what stats to expect
# Each role has: icon, color, expected data sources, stat priorities

ROLES = {
    # ── Infrastructure ──
    "router": {
        "icon": "🌐", "color": "#60a0c0", "title": "Router",
        "sources": ["collectd", "ha"],
        "stats": ["load", "memory", "conntrack", "dhcp", "interfaces", "uptime"],
        "desc": "Network router / firewall"
    },
    "ap": {
        "icon": "📡", "color": "#60c0a0", "title": "Access Point",
        "sources": ["collectd", "wifi"],
        "stats": ["load", "memory", "wifi_clients", "interfaces", "uptime"],
        "desc": "WiFi access point"
    },
    "switch": {
        "icon": "🔀", "color": "#a0a0c0", "title": "Network Switch",
        "sources": ["collectd"],
        "stats": ["interfaces", "uptime"],
        "desc": "Ethernet switch"
    },
    "bridge": {
        "icon": "🌉", "color": "#c0a060", "title": "Wireless Bridge",
        "sources": ["collectd"],
        "stats": ["load", "interfaces", "ping", "uptime"],
        "desc": "Point-to-point wireless bridge"
    },

    # ── Servers ──
    "server": {
        "icon": "🖥️", "color": "#c06060", "title": "Server",
        "sources": ["collectd", "tailscale"],
        "stats": ["load", "memory", "disk", "thermal", "interfaces", "uptime"],
        "desc": "Compute server"
    },
    "nas": {
        "icon": "💾", "color": "#c08060", "title": "NAS",
        "sources": ["collectd"],
        "stats": ["load", "memory", "disk", "interfaces", "uptime"],
        "desc": "Network attached storage"
    },
    "vm": {
        "icon": "📦", "color": "#a060c0", "title": "Virtual Machine",
        "sources": ["collectd", "tailscale"],
        "stats": ["load", "memory", "disk", "interfaces"],
        "desc": "Virtual machine"
    },

    # ── Smart Home ──
    "wled": {
        "icon": "🌈", "color": "#ff6090", "title": "LED Controller",
        "sources": ["wled", "ha"],
        "stats": ["on", "brightness", "effect", "led_count", "wifi_rssi", "uptime"],
        "desc": "WLED LED strip controller"
    },
    "thermostat": {
        "icon": "🌡️", "color": "#60c0c0", "title": "Thermostat",
        "sources": ["ha"],
        "stats": ["temperature", "humidity", "hvac_state", "battery"],
        "desc": "Smart thermostat"
    },
    "camera": {
        "icon": "📹", "color": "#c06080", "title": "Camera",
        "sources": ["ha"],
        "stats": ["recording", "motion", "stream"],
        "desc": "Security camera"
    },
    "speaker": {
        "icon": "🔊", "color": "#6090c0", "title": "Smart Speaker",
        "sources": ["ha"],
        "stats": ["playing", "volume", "media"],
        "desc": "Smart speaker / display"
    },
    "plug": {
        "icon": "🔌", "color": "#c0c060", "title": "Smart Plug",
        "sources": ["ha"],
        "stats": ["on", "power", "energy"],
        "desc": "Smart plug / outlet"
    },
    "sensor": {
        "icon": "📊", "color": "#60c060", "title": "Sensor",
        "sources": ["ha"],
        "stats": ["presence", "temperature", "humidity", "light"],
        "desc": "ESP/Zigbee sensor"
    },
    "appliance": {
        "icon": "🏠", "color": "#a0c060", "title": "Smart Appliance",
        "sources": ["ha"],
        "stats": ["state", "cycle", "energy"],
        "desc": "Smart appliance (washer, dryer, etc.)"
    },
    "vacuum": {
        "icon": "🤖", "color": "#60a060", "title": "Robot Vacuum",
        "sources": ["ha"],
        "stats": ["state", "battery", "area"],
        "desc": "Robot vacuum"
    },

    # ── Power ──
    "inverter": {
        "icon": "☀️", "color": "#c0a030", "title": "Solar Inverter",
        "sources": ["ha", "collectd"],
        "stats": ["power", "battery_v", "battery_soc", "grid", "daily_kwh"],
        "desc": "Solar inverter / battery system"
    },
    "ups": {
        "icon": "🔋", "color": "#60c030", "title": "UPS",
        "sources": ["ha", "collectd"],
        "stats": ["status", "battery", "load", "runtime"],
        "desc": "Uninterruptible power supply"
    },
    "ev_charger": {
        "icon": "⚡", "color": "#30c0c0", "title": "EV Charger",
        "sources": ["ha"],
        "stats": ["state", "power", "session_kwh"],
        "desc": "Electric vehicle charger"
    },

    # ── Mobile / Personal ──
    "phone": {
        "icon": "📱", "color": "#a080c0", "title": "Phone",
        "sources": ["ha", "tailscale", "wifi"],
        "stats": ["battery", "charging", "wifi_signal"],
        "desc": "Mobile phone"
    },
    "tablet": {
        "icon": "📟", "color": "#80a0c0", "title": "Tablet",
        "sources": ["ha", "wifi"],
        "stats": ["battery", "wifi_signal"],
        "desc": "Tablet device"
    },
    "laptop": {
        "icon": "💻", "color": "#8080c0", "title": "Laptop",
        "sources": ["collectd", "tailscale", "wifi"],
        "stats": ["load", "memory", "battery", "wifi_signal"],
        "desc": "Laptop computer"
    },
    "desktop": {
        "icon": "🖥️", "color": "#6060c0", "title": "Desktop",
        "sources": ["collectd", "tailscale"],
        "stats": ["load", "memory", "disk", "thermal", "gpu"],
        "desc": "Desktop computer"
    },

    # ── Media ──
    "tv": {
        "icon": "📺", "color": "#c080a0", "title": "TV / Streaming",
        "sources": ["ha"],
        "stats": ["state", "app", "volume"],
        "desc": "Smart TV or streaming device"
    },

    # ── Tailscale ──
    "tailscale": {
        "icon": "🔗", "color": "#6080ff", "title": "Tailscale Node",
        "sources": ["tailscale"],
        "stats": ["online", "ip", "os", "link", "traffic", "key_expiry"],
        "desc": "Tailscale-connected remote device"
    },

    # ── Unknown ──
    "unknown": {
        "icon": "❓", "color": "#808080", "title": "Unknown Device",
        "sources": ["wifi", "ha"],
        "stats": ["ip", "mac", "wifi_signal"],
        "desc": "Unidentified device"
    },
}


# ── Node → Role mappings ──
# Explicit mappings override auto-detection

NODE_ROLES = {
    # Routers
    "gatekeeper": "router",
    "mr8300-host": "router",
    "wrt1900ac-family": "router",
    "ea6350v3-family": "router",
    "ea6350-cl": "router",
    "wndr4300sw-shed": "router",

    # Access Points
    "onhub-closet": "ap",
    "onhub-bed": "ap",
    "onhub-office": "ap",
    "onhub-pumphouse": "ap",
    "onhub-family": "ap",
    "eap225-outdoor": "ap",

    # Switches
    "hp-switch": "switch",
    "gs308t": "switch",

    # Bridges
    "gigabeam0": "bridge",
    "gigabeam1": "bridge",
    "cpe710-ap": "bridge",
    "cpe710-client": "bridge",

    # Servers
    "katana": "server",
    "oracle": "server",
    "ha": "server",
    "nodered": "server",
    "woodshed": "server",
    "family-vm": "vm",

    # WLED
    "wled-main": "wled",
    "wled-aqi": "wled",

    # Thermostats (Nest)
    "nest-circle": "thermostat",
    "_unknown_14c14e61276c": "thermostat",
    "_unknown_14c14e6d333f": "thermostat",
    "_unknown_ac678428b56d": "thermostat",
    "_unknown_d8eb466182d1": "thermostat",
    "_unknown_14c14e2616b5": "thermostat",

    # Cameras
    "watchers": "camera",
    "hikcams": "camera",

    # Speakers
    "voice-stones": "speaker",
    "google-home": "speaker",
    "echo": "speaker",

    # Smart Plugs
    "kasa-spirits": "plug",
    "smart-plugs": "plug",
    "smart-hubs": "plug",

    # Sensors
    "esp-swarm": "sensor",
    "esp-office": "sensor",
    "esp-outdoor": "sensor",
    "esp32-bed1": "sensor",
    "esp32-bed2": "sensor",
    "esp32-bed3": "sensor",
    "esp32-a90c10": "sensor",
    "shed-ble": "sensor",
    "_unknown_f0f5bdfd3504": "sensor",  # pumphouse radar
    "_unknown_b4e84212e7ac": "sensor",  # RGB controller
    "_unknown_b43a31d1771e": "sensor",  # humidifier

    # Appliances
    "lg-washer": "appliance",
    "lg-dryer": "appliance",
    "bed-air": "appliance",
    "iot-closet": "appliance",  # dehumidifier
    "iot-pumphouse": "appliance",  # dehumidifier

    # Vacuums
    "roomba": "vacuum",
    "irobot": "vacuum",
    "wandering-golems": "vacuum",

    # Power
    "goodwe": "inverter",
    "apcupsmini1": "ups",
    "mobileups": "ups",
    "neocharge": "ev_charger",

    # Phones
    "flip3": "phone",
    "flip3-5g": "phone",
    "s24-ultra": "phone",
    "pixel-7": "phone",
    "pixel-4": "phone",
    "iphone": "phone",

    # Tablets
    "tab-s5e": "tablet",
    "ipad": "tablet",
    "kindle": "tablet",
    "_unknown_f24a37407ca1": "tablet",  # Galaxy Tab A7 Lite

    # Laptops
    "latitude-5490": "laptop",
    "latitude-7390": "laptop",
    "users-air": "laptop",
    "wolf-creek": "laptop",

    # Desktops
    "game": "desktop",

    # TV/Media
    "roku": "tv",
    "ts-android": "tv",
    "ts-android2": "tv",

    # Tailscale nodes
    "ts-instance": "tailscale",
    "ts-iperf": "tailscale",
    "ts-terra": "tailscale",
    "ts-openclaw": "tailscale",
    "ts-pikvm": "tailscale",
    "ts-nitro": "tailscale",
    "ts-gig": "tailscale",
    "ts-7050": "tailscale",

    # Unknown → Smart Plugs (Kasa)
    "_unknown_909a4a474ca9": "plug",  # HS103
    "_unknown_e848b8aa3933": "plug",  # HS200
    "_unknown_b0a7b9933d17": "plug",  # KL420

    # Unknown → Sensors (ESP)
    "_unknown_e868e7d50978": "sensor",  # ESP_D50978
    "_unknown_600194a441c1": "sensor",  # ESP_A441C1
    "_unknown_bcddc282ed19": "sensor",  # ESP_82ED19
    "_unknown_bcddc282eff7": "sensor",  # ESP_82EFF7
    "_unknown_e868e7cfaa92": "sensor",  # ESP_CFAA92
    "_unknown_24a160393fb0": "sensor",  # ESP_393FB0
    "_unknown_ac67b2d1f2e4": "sensor",  # espressif
    "_unknown_483fda6a0ea8": "sensor",  # ESP_6A0EA8
    "_unknown_2cf43208cff0": "sensor",  # ESP_08CFF0
    "_unknown_b4e62d79b610": "sensor",  # ESP_79B610
    "_unknown_18de50775aff": "sensor",  # lwip0 (ESP)
    "_unknown_b8060d2b4a5d": "sensor",  # wlan0 (ESP)

    # Unknown → Smart Home
    "_unknown_68c63ad2b03d": "plug",  # SwitchBot-HubMini
    "_unknown_ca2c4fac00a1": "plug",  # HiSmart sprinkler
    "_unknown_ca2c4fad7ef5": "plug",  # HiSmart sprinkler
    "_unknown_fc584a862e9e": "plug",  # WSD-bulb

    # Abstract/UI nodes (not real devices)
    "forge": "server",  # CPU visualization
    "mana": "server",   # RAM visualization
    "essence": "ups",   # Battery visualization
    "void": "router",   # WAN visualization
    "wan": "router",    # WAN interface
    "gpu": "desktop",   # GPU visualization
    "scrying-pool": "server",  # Oracle/AI visualization
    "notion-portal": "server",  # Notion integration
    "steam-works": "server",  # Steam/gaming cluster

    # Remaining unknowns
    "_unknown_c006c3f658f5": "plug",  # Likely Kasa KL125
}


def get_role(node_id, node_data=None):
    """Get the role for a node ID, optionally using node data for auto-detection."""
    # Explicit mapping takes priority
    if node_id in NODE_ROLES:
        return NODE_ROLES[node_id]

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

    # Auto-detect ethernet devices (have MAC, in wired VLAN)
    if node_data:
        mac = node_data.get("mac", "")
        ip = node_data.get("ip", "")
        node_type = node_data.get("type", "")

        # Devices with MAC in admin VLAN (10.0.6.x) are likely wired
        if mac and ip and ip.startswith("10.0.6."):
            # Already classified types
            if node_type in ("core", "infra", "tower"):
                return "server"  # Infrastructure defaults to server
            if node_type == "bridge":
                return "bridge"
            # Generic wired device - check patterns
            if "switch" in nid or "gs" in nid:
                return "switch"
            if "router" in nid or "wrt" in nid or "mr" in nid:
                return "router"
            if "cam" in nid or "hik" in nid:
                return "camera"

    if "_unknown_" in nid:
        return "unknown"

    return "unknown"


def get_role_info(node_id, node_data=None):
    """Get full role info for a node."""
    role = get_role(node_id, node_data)
    return {"role": role, **ROLES.get(role, ROLES["unknown"])}


def get_all_roles():
    """Get all role definitions."""
    return ROLES


def get_nodes_by_role():
    """Group all mapped nodes by role."""
    by_role = {}
    for node_id, role in NODE_ROLES.items():
        by_role.setdefault(role, []).append(node_id)
    return by_role
