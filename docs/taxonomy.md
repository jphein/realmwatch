# The Realm of the Living Network

A fantasy taxonomy mapping every node in the homelab to a cohesive world.

---

## The World

The Realm is a medieval-fantasy kingdom built atop a network of magical ley lines.
At its heart sits **The Citadel** (VLAN 6), a fortress of compute and governance.
Surrounding it: the **Enchanted Grove** (VLAN 10) where IoT sprites and enchanted
objects dwell, the **Hearthlands** (VLAN 11) of domestic life, and the ethereal
**Astral Plane** (Tailscale mesh) connecting far-flung outposts across the void.

Magical **Aether Towers** broadcast connectivity across the physical realm. Ley lines
(network connections) carry traffic between nodes as visible energy flows.

---

## The Wards

### The Citadel (VLAN 6 — Admin)
The central fortress. Houses the rulers, their personal artifacts, and defensive infrastructure.

| Node | Label | Role |
|------|-------|------|
| `katana` | **The Citadel Throne** | Proxmox hypervisor — the kingdom's seat of power |
| `gatekeeper` | **The Gatekeeper** | OpenWrt router — guardian of all boundaries |
| `oracle` | **The Oracle Stone** | AI inference server (ubox0) |
| `game` | **The Arena** | Gaming rig — the proving grounds |
| `ha` | **The Homestead** | Home Assistant — domestic automation nexus |
| `nodered` | **The Automaton** | Node-RED — the automation forge |
| `hp-switch` | **The Iron Spine** | HP managed switch — the realm's backbone |
| `gs308t` | **The Hub Stone** | Netgear GS308T — secondary spine |
| `tab-s5e` | **Scrying Slate** | Control tablet |
| `echo` | **The Echo Chamber** | Amazon Echo on Admin (HA voice control) |

**Personal Artifacts (Admin devices):**
| Node | Label | Owner/Role |
|------|-------|------------|
| `s24-ultra` | **<REDACTED>** | S24 Ultra — primary phone |
| `flip3` | **The Messenger** | Z Flip3 |
| `flip3-5g` | **The Wanderer** | Z Flip3 5G |
| `iphone` | **The Apple Shard** | iPhone |
| `kindle` | **The Reading Stone** | Kindle e-reader |
| `latitude-7390` | **The Wandering Codex** | Laptop |

---

### The Enchanted Grove (VLAN 10 — IoT)
A magical forest where enchanted objects and elemental sprites dwell.

**Named Enchantments:**
| Node | Label | Role |
|------|-------|------|
| `goodwe` | **The Sunstone** | Solar inverter — harvests celestial energy |
| `neocharge` | **The Lightning Post** | EV charger — channels lightning |
| `bed-air` | **The Breath Stone** | Air quality sensor |
| `shed-ble` | **The Whisper Stone** | BLE proxy in the shed |
| `ipad` | **The Ancient Slate** | iPad 3rd Gen (legacy device on IoT) |
| `users-air` | **The Windborne Tome** | MacBook Air (on IoT VLAN) |

**Sprite Clans (Expandable Clusters):**
| Cluster | Label | Members | What they are |
|---------|-------|---------|---------------|
| `kasa-spirits` | **The Kasa Spirits** | 16 | TP-Link/Kasa smart plugs, switches, bulbs |
| `tuya-sprites` | **The Tuya Sprites** | 16 | Tuya WiFi smart devices |
| `esp-swarm` | **The Sprite Swarm** | 16 | ESP8266/ESP32 generic sensors |
| `voice-stones` | **The Voice Stones** | 7 | Google Home speakers |
| `nest-circle` | **The Nest Circle** | 5 | Nest thermostats |
| `smart-hubs` | **The Binding Stones** | 4 | SwitchBot, HiSmart, gecko hubs |
| `iot-pumphouse` | **The Well Sprites** | 1 | mmWave radar (The Groundseer) |

*Click any cluster on the map to expand and see individual members.*

**Other Clusters (no members yet):**
| Cluster | Label | Role |
|---------|-------|------|
| `watchers` | **The Watchers** | HikVision cameras |
| `esp-office` | **The Study Runes** | Office ESP sensors |
| `esp-outdoor` | **The Wild Runes** | Outdoor ESP sensors |
| `iot-closet` | **The Hidden Sprites** | Closet IoT devices |
| `wandering-golems` | **The Wandering Golems** | Robot vacuums (cluster) |
| `steam-works` | **The Steam Works** | Washer/dryer (cluster) |

---

### The Hearthlands (VLAN 11 — Family/Guest)
The domestic quarters where daily life unfolds.

| Node | Label | Role |
|------|-------|------|
| `roomba` | **The Floor Golem** | Roomba vacuum |
| `irobot` | **The Second Golem** | iRobot vacuum |
| `lg-washer` | **The Tidecaller** | LG smart washer |
| `lg-dryer` | **The Hearthwind** | LG smart dryer |
| `wled-main` | **The Prismatic** | WLED LED strip — main |
| `wled-aqi` | **The AQI Crystal** | WLED AQI indicator |
| `roku` | **The Crystal Mirror** | Roku streaming device |
| `esp32-bed1` | **Bed Rune I** | Bedroom sensor 1 |
| `esp32-bed2` | **Bed Rune II** | Bedroom sensor 2 |
| `esp32-bed3` | **Bed Rune III** | Bedroom sensor 3 |
| `esp32-a90c10` | **The Hearthstone Rune** | ESP32 sensor |
| `pixel-7` | **The Seer's Eye** | Pixel 7 phone |
| `pixel-4` | **The Old Herald** | Pixel 4 (retired) |
| `latitude-5490` | **The Spare Tome** | Spare laptop |
| `wolf-creek` | **The Wolf Creek Tome** | Wolf Creek laptop |

---

### The Family Scroll (VLAN 8)

| Node | Label | Role |
|------|-------|------|
| `family-vm` | **The Family Scroll** | Family VM |

---

### The Astral Plane (Tailscale Mesh)
Ethereal connections spanning great distances through the void.

| Node | Label | Role |
|------|-------|------|
| `ts-android` | **The Herald** | Primary phone tailscale |
| `ts-android2` | **Herald II** | Secondary (dormant) |
| `ts-instance` | **The Cloud Spire** | GCP cloud instance |
| `ts-iperf` | **The Speedstone** | iperf testing node |
| `ts-terra` | **The Earthbound** | Linux workstation |
| `ts-openclaw` | **The Open Claw** | Linux box |
| `ts-pikvm` | **The Remote Eye** | PiKVM remote KVM (dormant) |
| `ts-nitro` | **The Swift Bolt** | Acer Nitro laptop (dormant) |
| `ts-gig` | **The Far Reach** | Remote endpoint (dormant) |
| `ts-7050` | **The Chromatic** | Chromebook (dormant) |

---

## The Aether Towers (WiFi APs)

The magical towers that broadcast connectivity. All on VLAN 6 (Admin).

**Main Keep:**
| Tower | Label | Location |
|-------|-------|----------|
| `ea6350-cl` | **The Citadel Beacon** | Main house entry |
| `onhub-office` | **The Scribe's Alcove** | Office |
| `onhub-closet` | **The Hidden Chamber** | Network closet |
| `onhub-bed` | **The Dreamer's Rest** | Bedroom |
| `onhub-family` | **The Family Hearth** | Family room |

**Outer Realm:**
| Tower | Label | Location |
|-------|-------|----------|
| `eap225-outdoor` | **The Sentinel** | Outdoor, wide coverage |
| `onhub-pumphouse` | **The Pumphouse Keep** | Pumphouse building |
| `wndr4300sw-shed` | **The Woodshed Watch** | Woodshed |
| `woodshed` | **The Timber Keep** | Woodshed (secondary) |
| `wrt1900ac-family` | **The Great Hall** | Family area (extended) |
| `ea6350v3-family` | **The Inner Ward** | Family area (inner) |
| `mr8300-host` | **<REDACTED>** | <Owner>'s area |

**Sky Bridges (point-to-point):**
| Bridge | Label | Role |
|--------|-------|------|
| `cpe710-ap` | **Sky Bridge Alpha** | CPE710 AP-side |
| `cpe710-client` | **Sky Bridge Omega** | CPE710 client-side |
| `gigabeam0` | **The North Star** | GigaBeam north link |
| `gigabeam1` | **The South Star** | GigaBeam south link |

---

## Power & Protection

| Node | Label | Role |
|------|-------|------|
| `apcupsmini1` | **The Ward Stone** | APC UPS — power protection |
| `mobileups` | **The Wandering Shield** | Mobile UPS |
| `poe-switch` | **The Watcher's Forge** | PoE switch powering cameras |
| `shed-switch` | **The Shed Spine** | Unmanaged switch in shed |

---

## The Primordial Forces (Core abstractions)

| Node | Label | What it represents |
|------|-------|-------------------|
| `forge` | **The Great Forge** | CPU — raw computational fire |
| `gpu` | **Crystal Engine** | GPU — crystalline parallel processing |
| `mana` | **The Mana Well** | RAM — volatile magical energy |
| `essence` | **Life Essence** | The eternal source — uptime, health |
| `void` | **The Outer Darkness** | The untamed internet beyond the gate |
| `wan` | **The WAN Gate** | The boundary between realm and void |

---

## The Portals

| Node | Label | Destination |
|------|-------|-------------|
| `scrying-pool` | **The Scrying Pool** | Chat interface — ask and the aether answers |
| `notion-portal` | **The Mystical Portal** | Notion gateway — quest log and codex sync |

---

## Naming Conventions

| Pattern | Used for | Examples |
|---------|----------|---------|
| **The [Noun]** | Infrastructure, servers | The Gatekeeper, The Iron Spine |
| **The [Adjective] [Noun]** | Descriptive devices | The Wandering Codex, The Hidden Chamber |
| **[Name]'s [Role]** | Personal/owned devices | <REDACTED>, <REDACTED> |
| **[Archetype] [Roman]** | Cluster members | Kasa Spirit IV, Hearth Keeper II |
| **The [Mythical Name]** | Unique notable devices | The Groundseer, The Floodlight |

---

## VLAN → Ward Mapping

| VLAN | Subnet | Ward | Fantasy Name |
|------|--------|------|-------------|
| 6 | 10.0.6.0/24 | Admin | The Citadel |
| 7 | 10.0.7.0/24 | Test Lab *(liminal — no fw4 zone)* | The Crucible |
| 8 | 10.0.8.0/24 | Family (VMs) | The Family Scroll |
| 10 | 10.0.10.0/24 | IoT | The Enchanted Grove |
| 11 | 10.0.11.0/24 | Guest/Family | The Hearthlands |
| 0 | 100.x.x.x | Tailscale | The Astral Plane |
| 38 | WAN | Treelink WAN (fw4: wan) | The Great Bridge |
