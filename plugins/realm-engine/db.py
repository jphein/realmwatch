"""Shared SQLite database — schema creation and connection management.

All game MCP servers share a single SQLite database. Each server owns
specific tables (see Truth Model v1 spec). WAL mode for concurrent reads.

Migrated from os.realm.watch/servers/shared/db.py 2026-05-19. Only change
from upstream: DEFAULT_DB_PATH resolves SUDO_USER's home so the path is
stable regardless of whether realmwatch runs as root (port 80) or as JP.
"""
import os
import sqlite3
from pathlib import Path

from realm_text import real_home


DEFAULT_DB_PATH = os.environ.get(
    "REALM_GAME_DB",
    str(real_home() / ".realmwatch" / "game.db"),
)

_SCHEMA_SQL = """
-- Events (owner: realm-engine)
CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    source_system TEXT NOT NULL,
    entity_id TEXT,
    correlation_id TEXT,
    dedupe_key TEXT NOT NULL UNIQUE,
    severity INTEGER NOT NULL CHECK(severity BETWEEN 0 AND 5),
    confidence INTEGER NOT NULL CHECK(confidence BETWEEN 0 AND 100),
    timestamp_observed INTEGER NOT NULL,
    timestamp_ingested INTEGER NOT NULL,
    replay_flag INTEGER NOT NULL DEFAULT 0,
    raw_payload_json TEXT NOT NULL,
    normalized_payload_json TEXT NOT NULL,
    processed INTEGER NOT NULL DEFAULT 0,
    schema_version INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (entity_id) REFERENCES entities(entity_id)
);
CREATE INDEX IF NOT EXISTS idx_events_entity ON events(entity_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(timestamp_observed);
CREATE INDEX IF NOT EXISTS idx_events_corr ON events(correlation_id);

-- Entities (owner: realm-engine)
CREATE TABLE IF NOT EXISTS entities (
    entity_id TEXT PRIMARY KEY,
    canonical_name TEXT,
    entity_type TEXT NOT NULL DEFAULT 'unknown',
    identity_confidence INTEGER NOT NULL DEFAULT 0 CHECK(identity_confidence BETWEEN 0 AND 100),
    first_seen_ts INTEGER NOT NULL,
    last_seen_ts INTEGER NOT NULL,
    mac_primary TEXT,
    ipv4_last TEXT,
    ipv6_last TEXT,
    vlan_id INTEGER,
    ap_bssid TEXT,
    manufacturer TEXT,
    os_fingerprint TEXT,
    service_fingerprint TEXT,
    user_label TEXT,
    infrastructure_flag INTEGER NOT NULL DEFAULT 0,
    merge_parent_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    schema_version INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (merge_parent_id) REFERENCES entities(entity_id)
);
CREATE INDEX IF NOT EXISTS idx_entities_mac ON entities(mac_primary);
CREATE INDEX IF NOT EXISTS idx_entities_ipv4 ON entities(ipv4_last);
CREATE INDEX IF NOT EXISTS idx_entities_vlan ON entities(vlan_id);

CREATE TABLE IF NOT EXISTS entity_ip_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id TEXT NOT NULL,
    ip_address TEXT NOT NULL,
    first_seen_ts INTEGER NOT NULL,
    last_seen_ts INTEGER NOT NULL,
    source TEXT,
    FOREIGN KEY (entity_id) REFERENCES entities(entity_id)
);
CREATE INDEX IF NOT EXISTS idx_eip_entity ON entity_ip_history(entity_id);

CREATE TABLE IF NOT EXISTS entity_hostname_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id TEXT NOT NULL,
    hostname TEXT NOT NULL,
    first_seen_ts INTEGER NOT NULL,
    last_seen_ts INTEGER NOT NULL,
    FOREIGN KEY (entity_id) REFERENCES entities(entity_id)
);
CREATE INDEX IF NOT EXISTS idx_ehost_entity ON entity_hostname_history(entity_id);

CREATE TABLE IF NOT EXISTS entity_mac_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id TEXT NOT NULL,
    mac TEXT NOT NULL,
    first_seen_ts INTEGER NOT NULL,
    last_seen_ts INTEGER NOT NULL,
    FOREIGN KEY (entity_id) REFERENCES entities(entity_id)
);
CREATE INDEX IF NOT EXISTS idx_emac_entity ON entity_mac_history(entity_id);

-- Quests (owner: quest-forge)
CREATE TABLE IF NOT EXISTS quests (
    quest_id TEXT PRIMARY KEY,
    quest_type TEXT NOT NULL,
    source_event_id TEXT,
    correlation_id TEXT,
    entity_id TEXT,
    title TEXT NOT NULL,
    technical_label TEXT,
    description TEXT,
    severity INTEGER NOT NULL DEFAULT 0 CHECK(severity BETWEEN 0 AND 5),
    status TEXT NOT NULL DEFAULT 'detected',
    hints_json TEXT DEFAULT '[]',
    debrief_json TEXT,
    xp_reward INTEGER NOT NULL DEFAULT 100,
    created_ts INTEGER NOT NULL,
    activated_ts INTEGER,
    resolved_ts INTEGER,
    debriefed_ts INTEGER,
    rewarded_ts INTEGER,
    archived_ts INTEGER,
    dedupe_key TEXT NOT NULL UNIQUE,
    replay_flag INTEGER NOT NULL DEFAULT 0,
    parent_quest_id TEXT REFERENCES quests(quest_id),
    actions_json TEXT DEFAULT '[]',
    node TEXT,
    sort_order INTEGER DEFAULT 0,
    schema_version INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (source_event_id) REFERENCES events(event_id),
    FOREIGN KEY (entity_id) REFERENCES entities(entity_id)
);
CREATE INDEX IF NOT EXISTS idx_quests_entity ON quests(entity_id);
CREATE INDEX IF NOT EXISTS idx_quests_status ON quests(status);
CREATE INDEX IF NOT EXISTS idx_quests_corr ON quests(correlation_id);
CREATE INDEX IF NOT EXISTS idx_quests_parent ON quests(parent_quest_id);

CREATE TABLE IF NOT EXISTS quest_event_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quest_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    role TEXT DEFAULT 'trigger',
    FOREIGN KEY (quest_id) REFERENCES quests(quest_id),
    FOREIGN KEY (event_id) REFERENCES events(event_id)
);
CREATE INDEX IF NOT EXISTS idx_qel_quest ON quest_event_links(quest_id);

CREATE TABLE IF NOT EXISTS quest_state_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quest_id TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT NOT NULL,
    transition_ts INTEGER NOT NULL,
    actor TEXT DEFAULT 'system',
    FOREIGN KEY (quest_id) REFERENCES quests(quest_id)
);
CREATE INDEX IF NOT EXISTS idx_qsl_quest ON quest_state_log(quest_id);

-- Actions (owner: combat-ward, Phase 1 — tables created now for schema completeness)
CREATE TABLE IF NOT EXISTS actions (
    action_id TEXT PRIMARY KEY,
    quest_id TEXT,
    entity_id TEXT,
    action_type TEXT NOT NULL,
    action_class TEXT NOT NULL,
    policy_allowed INTEGER NOT NULL DEFAULT 0,
    policy_reason TEXT,
    proposed_ts INTEGER NOT NULL,
    approved_ts INTEGER,
    executed_ts INTEGER,
    result_status TEXT DEFAULT 'pending',
    result_payload_json TEXT,
    entity_confidence_at_action INTEGER,
    replay_flag INTEGER NOT NULL DEFAULT 0,
    schema_version INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (quest_id) REFERENCES quests(quest_id),
    FOREIGN KEY (entity_id) REFERENCES entities(entity_id)
);
CREATE INDEX IF NOT EXISTS idx_actions_entity ON actions(entity_id);
CREATE INDEX IF NOT EXISTS idx_actions_quest ON actions(quest_id);

CREATE TABLE IF NOT EXISTS action_policy_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_id TEXT NOT NULL,
    rule_id TEXT,
    decision TEXT NOT NULL,
    reason TEXT,
    evaluated_ts INTEGER NOT NULL,
    FOREIGN KEY (action_id) REFERENCES actions(action_id)
);

-- Codex entries (owner: lore-keeper)
CREATE TABLE IF NOT EXISTS codex_entries (
    codex_id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    fantasy_name TEXT NOT NULL,
    technical_name TEXT NOT NULL,
    summary TEXT NOT NULL,
    lore_text TEXT,
    technical_text TEXT,
    schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_codex_category ON codex_entries(category);

-- Node lore (owner: lore-keeper)
CREATE TABLE IF NOT EXISTS node_lore (
    lore_id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL UNIQUE,
    backstory TEXT,
    personality TEXT,
    notable_events_json TEXT DEFAULT '[]',
    created_ts INTEGER NOT NULL,
    updated_ts INTEGER NOT NULL,
    FOREIGN KEY (entity_id) REFERENCES entities(entity_id)
);

-- Chronicles (owner: lore-keeper)
CREATE TABLE IF NOT EXISTS chronicles (
    chronicle_id TEXT PRIMARY KEY,
    event_id TEXT,
    title TEXT NOT NULL,
    narrative TEXT NOT NULL,
    chronicle_date INTEGER NOT NULL,
    created_ts INTEGER NOT NULL,
    FOREIGN KEY (event_id) REFERENCES events(event_id)
);
CREATE INDEX IF NOT EXISTS idx_chronicles_date ON chronicles(chronicle_date);

-- Journal entries (owner: lore-keeper)
CREATE TABLE IF NOT EXISTS journal_entries (
    journal_id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    entry_type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    entity_id TEXT,
    quest_id TEXT,
    created_ts INTEGER NOT NULL,
    FOREIGN KEY (player_id) REFERENCES players(player_id),
    FOREIGN KEY (entity_id) REFERENCES entities(entity_id),
    FOREIGN KEY (quest_id) REFERENCES quests(quest_id)
);
CREATE INDEX IF NOT EXISTS idx_journal_player ON journal_entries(player_id);
CREATE INDEX IF NOT EXISTS idx_journal_type ON journal_entries(entry_type);

-- Ward templates (owner: combat-ward)
CREATE TABLE IF NOT EXISTS ward_templates (
    ward_id TEXT PRIMARY KEY,
    ward_name TEXT NOT NULL,
    fantasy_name TEXT NOT NULL,
    action_type TEXT NOT NULL,
    template_json TEXT NOT NULL,
    severity_min INTEGER NOT NULL DEFAULT 0,
    description TEXT,
    schema_version INTEGER NOT NULL DEFAULT 1
);

-- Bestiary (owner: combat-ward)
CREATE TABLE IF NOT EXISTS bestiary_entries (
    bestiary_id TEXT PRIMARY KEY,
    threat_type TEXT NOT NULL UNIQUE,
    fantasy_name TEXT NOT NULL,
    technical_name TEXT NOT NULL,
    description TEXT NOT NULL,
    first_encountered_ts INTEGER,
    times_encountered INTEGER NOT NULL DEFAULT 0,
    last_defeated_ts INTEGER,
    recommended_ward_id TEXT,
    lore_text TEXT,
    schema_version INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (recommended_ward_id) REFERENCES ward_templates(ward_id)
);
CREATE INDEX IF NOT EXISTS idx_bestiary_type ON bestiary_entries(threat_type);

-- Players (owner: progression)
CREATE TABLE IF NOT EXISTS players (
    player_id TEXT PRIMARY KEY,
    player_name TEXT,
    player_class TEXT DEFAULT 'watcher',
    created_ts INTEGER NOT NULL,
    last_active_ts INTEGER,
    total_xp INTEGER NOT NULL DEFAULT 0,
    level INTEGER NOT NULL DEFAULT 1,
    schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS xp_events (
    xp_event_id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    quest_id TEXT,
    source_type TEXT,
    xp_amount INTEGER NOT NULL,
    granted_ts INTEGER NOT NULL,
    replay_flag INTEGER NOT NULL DEFAULT 0,
    UNIQUE(player_id, quest_id, source_type),
    FOREIGN KEY (player_id) REFERENCES players(player_id),
    FOREIGN KEY (quest_id) REFERENCES quests(quest_id)
);
CREATE INDEX IF NOT EXISTS idx_xp_player ON xp_events(player_id);

CREATE TABLE IF NOT EXISTS skill_trees (
    skill_id TEXT PRIMARY KEY,
    tree TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    unlock_level INTEGER DEFAULT 1,
    parent_skill_id TEXT
);

CREATE TABLE IF NOT EXISTS player_skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    unlocked_ts INTEGER NOT NULL,
    UNIQUE(player_id, skill_id),
    FOREIGN KEY (player_id) REFERENCES players(player_id),
    FOREIGN KEY (skill_id) REFERENCES skill_trees(skill_id)
);

CREATE TABLE IF NOT EXISTS achievements (
    achievement_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    xp_reward INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS player_achievements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    achievement_id TEXT NOT NULL,
    unlocked_ts INTEGER NOT NULL,
    UNIQUE(player_id, achievement_id),
    FOREIGN KEY (player_id) REFERENCES players(player_id),
    FOREIGN KEY (achievement_id) REFERENCES achievements(achievement_id)
);
"""

# Seed data for skill trees and achievements
_SEED_SQL = """
-- Networking tree (blue)
INSERT OR IGNORE INTO skill_trees VALUES ('net_dns', 'networking', 'DNS Mastery', 'Understand the naming stones', 1, NULL);
INSERT OR IGNORE INTO skill_trees VALUES ('net_vlan', 'networking', 'VLAN Architect', 'Map the realm boundaries', 3, 'net_dns');
INSERT OR IGNORE INTO skill_trees VALUES ('net_routing', 'networking', 'Routing Sage', 'Navigate the realm paths', 5, 'net_vlan');
INSERT OR IGNORE INTO skill_trees VALUES ('net_dhcp', 'networking', 'DHCP Whisperer', 'Hear the address oracle', 2, 'net_dns');
INSERT OR IGNORE INTO skill_trees VALUES ('net_subnet', 'networking', 'Subnet Sculptor', 'Shape the realm geography', 7, 'net_routing');

-- Security tree (red)
INSERT OR IGNORE INTO skill_trees VALUES ('sec_ward', 'security', 'Ward Weaver', 'Craft basic protections', 1, NULL);
INSERT OR IGNORE INTO skill_trees VALUES ('sec_threat', 'security', 'Threat Hunter', 'Track shadow probes', 3, 'sec_ward');
INSERT OR IGNORE INTO skill_trees VALUES ('sec_cipher', 'security', 'Cipher Knight', 'Master encryption wards', 5, 'sec_threat');
INSERT OR IGNORE INTO skill_trees VALUES ('sec_shadow', 'security', 'Shadow Watcher', 'See through deception', 7, 'sec_cipher');
INSERT OR IGNORE INTO skill_trees VALUES ('sec_arcane', 'security', 'Arcane Defender', 'Ultimate realm protection', 10, 'sec_shadow');

-- Systems tree (green)
INSERT OR IGNORE INTO skill_trees VALUES ('sys_process', 'systems', 'Process Tamer', 'Control the realm workers', 1, NULL);
INSERT OR IGNORE INTO skill_trees VALUES ('sys_metric', 'systems', 'Metric Seer', 'Read the realm vitals', 2, 'sys_process');
INSERT OR IGNORE INTO skill_trees VALUES ('sys_service', 'systems', 'Service Binder', 'Bind realm daemons', 4, 'sys_metric');
INSERT OR IGNORE INTO skill_trees VALUES ('sys_disk', 'systems', 'Disk Warden', 'Guard the archives', 6, 'sys_service');
INSERT OR IGNORE INTO skill_trees VALUES ('sys_auto', 'systems', 'Automation Mage', 'Enchant recurring tasks', 8, 'sys_disk');

-- Arcana tree (purple)
INSERT OR IGNORE INTO skill_trees VALUES ('arc_agent', 'arcana', 'Agent Caller', 'Summon AI companions', 2, NULL);
INSERT OR IGNORE INTO skill_trees VALUES ('arc_mcp', 'arcana', 'MCP Crafter', 'Build tool servers', 5, 'arc_agent');
INSERT OR IGNORE INTO skill_trees VALUES ('arc_hook', 'arcana', 'Hook Weaver', 'Set realm triggers', 7, 'arc_mcp');
INSERT OR IGNORE INTO skill_trees VALUES ('arc_skill', 'arcana', 'Skill Forger', 'Create game verbs', 9, 'arc_hook');
INSERT OR IGNORE INTO skill_trees VALUES ('arc_realm', 'arcana', 'Realm Architect', 'Reshape the world itself', 12, 'arc_skill');

-- Codex entries (dual-labeled: fantasy + technical, with deep lore and technical text)

-- === PROTOCOLS ===
INSERT OR IGNORE INTO codex_entries VALUES ('dns', 'protocols', 'The Naming Stones', 'Domain Name System (DNS)', 'The ancient stones that translate realm names into true addresses — every journey begins with a name lookup', 'Before the Naming Stones were carved, travelers could only reach destinations by reciting long numerical incantations. The Stones map memorable names to addresses — a hierarchy of oracles, each responsible for a fragment of the name. The root oracles sit atop all, delegating to realm oracles (.com, .watch), who delegate further. When a name is unknown, the query ascends the hierarchy until an oracle can answer.', 'Hierarchical distributed database. Resolvers query recursively through root → TLD → authoritative nameservers. A/AAAA records map hostnames to IPv4/IPv6. CNAME aliases, MX for mail routing, TXT for verification. TTL controls caching duration. The realm uses gatekeeper (10.0.6.1) as DNS forwarder with dnsmasq, resolving local .jphe.in names and forwarding external queries upstream.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('dhcp', 'protocols', 'The Address Oracle', 'Dynamic Host Configuration Protocol (DHCP)', 'The oracle that assigns addresses to new arrivals — without it, no device can join the realm', 'When a new spirit materializes in the realm, it has no address — only its True Name (MAC). It cries out into the void: "Who will grant me passage?" The Address Oracle hears and responds with a lease — an IP address, a gateway to follow, and DNS oracles to consult. The lease is temporary; the spirit must return to renew it or lose its place.', 'DORA process: Discover → Offer → Request → Acknowledge. The realm runs DHCP on gatekeeper via dnsmasq, with 12 VLAN-scoped pools. Static leases for infrastructure nodes. Lease time 12h for known devices, 1h for unknowns. Option 82 (relay agent) used for cross-VLAN assignment. PXE boot options served via proxy DHCP for LTSP clients.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('arp', 'protocols', 'The Identity Ritual', 'Address Resolution Protocol (ARP)', 'The ritual that links a device''s true name (MAC) to its realm address (IP) — identity at the link layer', 'To speak to a neighbor, you must know both their address and their true name. The Identity Ritual broadcasts a question to all: "Who bears this address? Reveal your True Name!" The bearer responds, and the asker records the binding in a temporary scroll. Should the scroll expire, the ritual must be performed again.', 'Layer 2 protocol mapping IPv4 addresses to MAC addresses on the local segment. ARP tables cache entries with TTL (typically 300s). Gratuitous ARP announces address changes. ARP spoofing is a common attack vector — the realm monitors for unexpected ARP replies via realmwatch event detection.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('tcp', 'protocols', 'The Covenant of Reliable Passage', 'Transmission Control Protocol (TCP)', 'A sacred covenant ensuring every message arrives complete and in order — the foundation of trusted communication', 'Two parties seal a three-fold covenant (SYN, SYN-ACK, ACK) before any words are exchanged. Every message sent receives an acknowledgment. If silence follows, the message is resent. The covenant guarantees: nothing lost, nothing disordered, nothing duplicated. When the conversation ends, a four-fold farewell dissolves the bond.', 'Connection-oriented transport protocol. Three-way handshake establishes sequence numbers. Sliding window for flow control, congestion control via algorithms (cubic, bbr). Retransmission on timeout or triple duplicate ACK. Used by HTTP, SSH, SMTP — most realm services. The realm''s iperf3 tests measure TCP throughput between nodes.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('udp', 'protocols', 'The Swift Messenger', 'User Datagram Protocol (UDP)', 'Speed over certainty — used for voice, video, and time-sensitive dispatches across the realm', 'The Swift Messenger carries no covenant — it simply hurls datagrams into the void and trusts they arrive. No handshake, no acknowledgment, no retransmission. What it sacrifices in reliability, it gains in speed. Voice, music, and the Watchers'' collectd heartbeats all travel by this swift but careless courier.', 'Connectionless transport protocol. No handshake, no guaranteed delivery, no ordering. 8-byte header vs TCP''s 20+. Used by DNS (port 53), collectd (port 25826), DHCP (67/68), NTP, SNMP, and real-time audio/video (RTP). The realm''s collectd agents send UDP multicast metrics every 30 seconds.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('ip', 'protocols', 'The Realm Address', 'Internet Protocol (IP)', 'The addressing system giving every device a unique location — IPv4 and IPv6 are the old and new tongues', 'Every citizen of the realm bears an address — four numbers separated by dots in the old tongue (IPv4), or eight groups of hex in the new (IPv6). The address reveals both identity and location: the network portion tells which realm, the host portion tells which soul within it.', 'Network layer protocol. IPv4: 32-bit addresses, subnet masks define network boundaries. The realm uses 10.0.0.0/8 private space carved into /24 subnets per VLAN. CIDR notation. IPv6 link-local (fe80::) present on all interfaces. IP header carries TTL (hop limit), protocol type, source/destination addresses.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('icmp', 'protocols', 'The Echo Pulse', 'Internet Control Message Protocol (ICMP)', 'The echo pulse that tests if a node lives — ping sends, the node responds if it hears', 'The simplest divination in the realm: send an Echo Request into the void and listen. If the target lives, an Echo Reply returns. The time between sending and receiving reveals the distance — measured in milliseconds, the heartbeat of latency. Some nodes hide from this pulse, cloaked by wards.', 'Control protocol riding on IP. Type 8/0 for echo request/reply (ping). Type 3 for destination unreachable, Type 11 for TTL exceeded (used by traceroute). The realm''s fping sweeps all subnets every 60 seconds. ICMP is often rate-limited or blocked by firewalls — the realm''s gatekeeper allows it between VLANs but rate-limits from WAN.', 1);

-- === NETWORKING ===
INSERT OR IGNORE INTO codex_entries VALUES ('vlan', 'networking', 'The Realm Boundaries', 'Virtual LAN (VLAN)', 'Invisible walls segmenting the realm into zones — devices in one zone cannot see another without a gateway''s blessing', 'The realm is divided into twelve territories, each walled off from the others by invisible barriers woven into the fabric of the switches. A device in the IoT Quarter (VLAN 10) cannot see the Server Sanctum (VLAN 6) without passing through the Gatekeeper. This separation is the foundation of realm security — compromise one zone, and the others remain safe.', 'IEEE 802.1Q tagging on Ethernet frames. The realm uses 12 VLANs: VLAN 1 (management), VLAN 6 (servers/infra), VLAN 10 (IoT), VLAN 20 (guests), VLAN 30 (cameras), VLAN 40 (gaming), VLAN 50 (work), VLAN 60 (family), VLAN 70 (outdoor), VLAN 100 (WAN), VLAN 200 (VPN), VLAN 250 (quarantine). Inter-VLAN routing on gatekeeper via OpenWrt. HP managed switch (10.0.6.103) handles trunk ports.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('nat', 'networking', 'The Mask of Many Faces', 'Network Address Translation (NAT)', 'The spell hiding many internal addresses behind one public face — the realm''s disguise to the outside world', 'Behind the Gatekeeper stands a single public face — one IP address that the outside world sees. Yet behind that mask, dozens of citizens conduct their business. The Gatekeeper remembers which citizen initiated each conversation and routes replies back to the correct soul. This is masquerade NAT — many faces, one mask.', 'Source NAT (masquerade) on gatekeeper''s WAN interface. Connection tracking table maps internal IP:port → external IP:port. Port forwarding (DNAT) for inbound services. Hairpin NAT for internal access to public IPs. The realm uses nftables masquerade on the wan zone. NAT traversal (STUN/TURN) needed for WebRTC and some VPN protocols.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('routing', 'networking', 'The Pathfinder''s Art', 'IP Routing', 'The art of choosing the best path between realms — routers are the pathfinders, routing tables their maps', 'Every packet is a traveler seeking a destination. The Pathfinder (router) consults its map (routing table) and chooses the best gate. The map says: "For realm 10.0.6.0/24, go through eth0. For all unknown realms, go through the WAN gate." Simple yet powerful — the entire internet runs on this art.', 'Static routes on gatekeeper for each VLAN subnet. Default route to ISP gateway. Longest prefix match determines route selection. The realm''s routing is simple (star topology, one gateway) but the gatekeeper handles inter-VLAN routing for 12 subnets. Policy-based routing used for VPN split tunneling.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('mac', 'networking', 'The True Name', 'MAC Address', 'The true name burned into every device at birth — 48 bits of identity that (usually) never change', 'Every device is branded with a True Name at the moment of its creation — six pairs of hex digits that identify its maker and its individual soul. Unlike realm addresses which shift with location, the True Name is permanent. Yet some cunning devices learn to forge false names, and modern privacy features randomize them to avoid tracking.', 'IEEE 802 48-bit hardware address. First 3 octets = OUI (manufacturer). Burned into NIC firmware but overridable. Modern devices (iOS, Android) use MAC randomization for privacy — the realm sees these as "_unknown_" entities. The entity_resolver in realm-engine correlates MAC + IP + hostname to build canonical entity IDs despite randomization.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('wifi', 'networking', 'The Aether Bonds', 'WiFi (802.11)', 'The invisible threads binding wireless devices to access points — strength measured in signal, weakness in noise', 'Wireless spirits bond to the nearest tower through the Aether — invisible radio waves that carry data at the speed of light but weaken with distance and walls. The bond''s strength is measured in dBm (closer to 0 is stronger). When the bond weakens, the spirit may roam to a stronger tower. The realm has 10 towers spanning the estate.', 'IEEE 802.11ac/ax on 2.4GHz and 5GHz bands. The realm runs 10 access points: 4 OnHubs, 2 EA6350s, 1 MR8300, 1 WRT1900AC, 1 EAP225-outdoor, 1 CPE710. Roaming detected via OpenWrt assoclist polling — realmwatch tracks AP associations and fires wifi_roam events. Signal strength, SNR, and channel utilization monitored per client.', 1);

-- === SECURITY ===
INSERT OR IGNORE INTO codex_entries VALUES ('firewall', 'security', 'The Realm Wards', 'Firewall (nftables)', 'The magical wards guarding every gateway — rules that decide what passes and what is banished', 'The Gatekeeper maintains thousands of wards — invisible barriers that inspect every traveler. Each ward is a rule: "Allow this type of traffic from this zone to pass. Block all else." The wards are layered in chains, evaluated in order. The default policy: deny everything not explicitly allowed.', 'nftables (fw4) on OpenWrt gatekeeper. Zone-based firewall: lan, wan, iot, guest, camera, etc. Default policy: reject input, reject forward, accept output. Port forwarding via DNAT rules. The realm has ~200 firewall rules managing inter-VLAN traffic, WAN access policies, and port forwards for exposed services.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('ssh', 'security', 'The Whispering Tunnel', 'Secure Shell (SSH)', 'An encrypted tunnel for commanding remote nodes — only those with the right key may enter', 'The Whispering Tunnel is how the Watcher commands distant nodes — an encrypted passage that shields every word from eavesdroppers. Entry requires a key, not a password. Once inside, the Watcher can execute commands, transfer scrolls, and even tunnel other protocols through the secure passage.', 'OpenSSH on port 22. Key-based auth for most nodes, password via sshpass for gatekeeper (OpenWrt limitation). SSH config in ~/.ssh/config with per-host settings. Agent forwarding enabled for jump hosts. SCP/SFTP for file transfer (except OpenWrt which lacks sftp-server — use ssh cat pipe instead). ProxyJump for multi-hop access.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('tls', 'security', 'The Enchanted Seal', 'Transport Layer Security (TLS)', 'The seal protecting messages in transit — ensures no eavesdropper reads the realm''s secrets', 'Every HTTPS connection begins with a handshake where both parties present their seals. The seal proves identity (via certificates signed by trusted authorities) and establishes a shared secret for encryption. Once sealed, the entire conversation is shielded — even if intercepted, the words are unintelligible.', 'TLS 1.3 for all public-facing services. Caddy auto-provisions Let''s Encrypt certificates for *.jphe.in domains. Internal services use self-signed or Caddy-issued certs. HSTS headers enforce HTTPS. Certificate transparency logs monitored. The realm-portal and all SSO-protected services require valid TLS.', 1);

-- === SERVICES ===
INSERT OR IGNORE INTO codex_entries VALUES ('nfs', 'services', 'The Shared Archives', 'Network File System (NFS)', 'A spell letting distant nodes read the same scrolls — files shared across the realm as if local', 'The Vault server (disks) maintains vast archives — media, backups, shared files. Through the NFS enchantment, distant nodes can read and write these archives as if they were local scrolls. The enchantment is transparent: applications see normal files, unaware they traverse the network with each read.', 'NFSv4 exports from disks server (10.0.6.120). Exports: /mnt/raid (media), /mnt/gdrive (Google Drive via rclone). Mounted on katana and other workstations. Kerberos auth not used (LAN-only trust). Performance tuned with rsize/wsize=1048576, async mounts. Monitored via collectd NFS plugin.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('samba', 'services', 'The Common Tongue', 'Samba/SMB File Sharing', 'The bridge letting Windows and Linux share scrolls in a common tongue', 'Not all realm citizens speak the same language. Windows machines speak SMB, Linux speaks NFS. Samba is the translator — it lets Linux servers present shares that Windows can read natively. The Common Tongue bridges the divide.', 'Samba 4 on disks server. Shares: media, backups, public. Guest access for media, authenticated for backups. TimeMachine support for macOS backups via fruit VFS module. Accessible from all VLANs via firewall rules on ports 139/445.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('collectd', 'services', 'The Watchers'' Network', 'collectd Monitoring', '23 hosts across the realm report load, memory, disk, and network stats every 30 seconds via UDP to katana', 'Across the realm, silent watchers observe every node — counting heartbeats (CPU), measuring wells (RAM), gauging archives (disk), and timing messengers (network). Every 30 seconds, they send their observations to the central observatory on katana, where the data is inscribed in round-robin scrolls that never grow.', 'collectd daemon on 23+ hosts. Plugins: cpu, memory, disk, interface, load, uptime, ping, processes, swap. Transport: UDP multicast to katana (port 25826). Storage: RRD files at /var/lib/collectd/rrd/. Retention: 5min resolution for 1 day, 30min for 1 week, 2hr for 1 month, 1 day for 1 year. Realmwatch reads RRDs for the map display.', 1);

-- === ARCHITECTURE ===
INSERT OR IGNORE INTO codex_entries VALUES ('sso', 'architecture', 'The Unified Gate', 'Single Sign-On (Authelia SSO)', 'One login to rule all services — Authelia guards the gate, OIDC tokens open every door', 'Before the Unified Gate, each service demanded its own password — a traveler carried a dozen keys. Now, one key opens all doors. Authelia stands at the threshold, verifying identity once and issuing enchanted tokens that all services recognize. The ten realm citizens (JP + 9 family) each hold one key.', 'Authelia on realm-portal VM (10.0.6.134:9091). OIDC provider for 8 services: Immich, Jellyfin, Navidrome (header auth), Outline, Nextcloud, Home Assistant, Vaultwarden (direct auth), Syncthing (forward_auth). TOTP 2FA available. Session cookies stored in SQLite. Caddy reverse proxy handles forward_auth interception.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('oidc', 'architecture', 'The Token Covenant', 'OpenID Connect (OIDC)', 'The identity protocol binding realm portal to all services — authenticate once, trusted everywhere', 'The Token Covenant is the enchantment woven between the Gate (Authelia) and each service. When a traveler presents their token, the service verifies it with the Gate — "Is this person who they claim?" The Gate confirms, and the door opens. No password ever crosses the threshold; only cryptographic proof.', 'OAuth 2.0 + OpenID Connect. Authorization Code flow with PKCE. ID tokens (JWT) carry claims: sub, email, groups. Each service registered as an OIDC client with client_id + client_secret (stored in Vaultwarden). Scopes: openid, profile, email, groups. Token refresh via refresh_token grant.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('realm-portal', 'architecture', 'The Realm Portal', 'realm.watch Portal', 'The front door to all services — optional OIDC login reveals personal widgets, SSO links skip re-auth', 'The Portal is the first thing a realm citizen sees — a grand hall showing the health of all services, quick links to each, and personal widgets for the logged-in user. Anonymous visitors see the public facade; authenticated users see their realm, their quests, their services.', 'Go web server on ubox0 VM. OIDC login via Authelia. Serves static HTML + JS with server-rendered service status cards. Links to all *.jphe.in services carry SSO session cookies — no re-auth needed. Health checks via HTTP probes to each service.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('hud', 'architecture', 'The Realm HUD', 'GNOME Shell Extension', 'Floating overlay (Super+R) showing player stats, active quest, threats, wifi/wired counts, and resource bars', 'The HUD floats at the edge of the Watcher''s vision — a constant stream of realm intelligence. XP progress, active quest title, threat count, resource bars for CPU/RAM/disk/battery, and node counts. It polls the realm every few seconds, a silent companion that keeps the Watcher informed without demanding attention.', 'GNOME Shell extension (realm-hud@realmwatch). Polls /api/hud on localhost:80 every 5 seconds via Soup3. GSettings schema for poll interval, position, auto-hide, keybind. Panel indicator in top bar shows threat count. Overlay widget (Super+R toggle) renders with glassmorphism CSS. Prefs page via Adw.PreferencesPage.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('forward-auth', 'architecture', 'The Proxy Shield', 'Caddy Forward Auth', 'A reverse proxy pattern where Caddy asks Authelia is this visitor allowed before passing traffic through', 'Some services cannot speak the Token Covenant directly. For these, the Proxy Shield intercepts every request and asks the Gate: "Is this visitor allowed?" Only if the Gate nods does the request continue. The visitor never sees the Gate — it operates invisibly within the proxy.', 'Caddy forward_auth directive. Every request to a protected service triggers a subrequest to Authelia''s /api/verify endpoint. If 200, the request proceeds with injected headers (Remote-User, Remote-Groups). If 401/302, the user is redirected to the Authelia login portal. Used for Navidrome and Syncthing.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('authelia', 'architecture', 'The Gatekeeper''s Apprentice', 'Authelia Identity Server', 'Standalone binary on realm-portal VM (10.0.6.134). Manages SSO sessions, OIDC tokens, TOTP 2FA, and access policies for all jphe.in services', 'The Apprentice was summoned to relieve the Gatekeeper of identity management. Where the Gatekeeper (OpenWrt firewall) guards network boundaries, the Apprentice guards application boundaries — verifying identities, issuing tokens, enforcing two-factor authentication, and maintaining session state.', 'Authelia v4 standalone binary. Configuration: access_control policies (one_factor/two_factor per domain), session cookie settings, OIDC client registrations. Storage: SQLite for users, sessions, TOTP secrets. Notification: SMTP relay for verification codes. Runs behind Caddy reverse proxy at auth.jphe.in.', 1);

-- === RESOURCES ===
INSERT OR IGNORE INTO codex_entries VALUES ('resource-forge', 'resources', 'The Great Forge', 'CPU & GPU Metrics', 'CPU load and temperature from collectd, GPU load and temp from nvidia-smi — the heat of computation', 'The Forge burns hotter as the Watcher demands more computation. Load measures how many tasks queue for the Forge''s attention. Temperature reveals the physical cost of that labor. The Crystal Engine (GPU) runs its own forge — cooler at rest, blazing during rendering or inference.', 'CPU metrics via collectd cpu plugin (per-core utilization). Load average from /proc/loadavg. Temperature from lm-sensors via collectd thermal plugin. GPU: nvidia-smi polled for temperature, load percentage, memory usage. HUD displays as a single "Forge" bar combining CPU load + thermal reading.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('resource-mana', 'resources', 'The Mana Well', 'RAM Usage', 'System memory utilization — when the well runs dry, processes begin to falter', 'The Mana Well holds the realm''s working memory — every running process draws from it. When the well runs low, the system begins writing to the Swap Scrolls (disk-backed memory), which are vastly slower. If both are exhausted, the OOM Reaper awakens and begins slaying processes to free resources.', 'RAM from collectd memory plugin: used, buffered, cached, free. Linux counts buffers/cache as "available" — true pressure is (total - available). Swap from collectd swap plugin. zswap enabled on katana (lz4 compression, 25% max pool). HUD shows percentage as "Mana" bar.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('resource-essence', 'resources', 'Life Essence', 'Power/Battery Status', 'Power state — anchored to the source when plugged in, draining when mobile', 'Life Essence represents the device''s connection to power. When anchored to the Eternal Source (plugged in), essence is limitless. When severed, the device runs on its internal reserve — a slow drain toward silence. The HUD shows this as a simple binary: anchored or draining.', 'UPower D-Bus interface for battery state. Polled via collectd battery plugin or direct UPower queries. States: charging, discharging, full, not-charging. Percentage and time-to-empty estimated. Desktop devices (katana) are always "plugged" — this metric matters more for laptops in the realm.', 1);

-- === SKILLS ===
INSERT OR IGNORE INTO codex_entries VALUES ('cast-skill', 'skills', 'The Spell of Command', '/cast Command', 'Execute network commands as spells — ping, traceroute, iperf3, SSH all wrapped in fantasy narration', 'The /cast skill channels raw network commands through the fantasy lens. "Cast ping at gatekeeper" becomes an Echo Pulse divination. "Cast traceroute to 8.8.8.8" traces the path through intermediate realms. Each spell is a real command — the narration adds context and meaning to the raw output.', 'Skill file: skills/cast.md. Wraps: ping, traceroute, mtr, iperf3, nmap, ssh, curl, dig. Each command is executed via Bash, output parsed and narrated. Safety: only pre-approved commands, no arbitrary execution. Entity resolution: node names mapped to IPs via realm-engine before execution.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('defend-skill', 'skills', 'The Ward Master', '/defend Command', 'Manage realm wards, review threats, cast defensive spells — firewall rules and threat response', 'The /defend skill is the Watcher''s shield. It shows active threats, casts wards (firewall rules) from pre-defined templates, and generates defense reports. The action policy (observe → suggest → dry-run → confirm → auto) governs how aggressive the defenses can be.', 'Skill file: skills/defend.md. Tools: active_threats_tool, cast_ward_tool, defense_report_tool, bestiary_tool. Ward templates: banish (IP block), slow (rate limit), isolate (VLAN quarantine), watch (enhanced monitoring), sentry (fail2ban). Policy enforcement via combat-ward/policy.py.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('oracle-skill', 'skills', 'The Oracle', '/oracle Command', 'Consult the all-seeing eye — no args for quest recommendations, any question for realm-grounded answers', 'The Oracle sees all — realm status, recent events, active quests, player state, and threats. With no question, it recommends the next quest based on severity, recency, and player level. With a question, it answers by weaving realm data into its response. The Oracle speaks with the voice of Davis.', 'Skill file: skills/oracle.md. Gathers: realm_status_tool, recent_events_tool, list_quests_tool, get_level_info_tool, active_threats_tool. Quest scoring: threat severity × recency × momentum × level fit. Voice: en-US-Davis:DragonHDLatestNeural via gnome-speaks D-Bus.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('quest-skill', 'skills', 'The Quest Board', '/quest Command', 'View, accept, complete quests — numbered selection, sub-step tracking, voice narration on completion', 'The Quest Board is where adventures begin. It shows all available quests sorted by priority, lets the Watcher accept them, and tracks progress through completion. When a quest is resolved, XP is granted, chimes play, and the achievement is narrated aloud.', 'Skill file: skills/quest.md. Tools: list_quests_tool, accept_quest_tool, complete_quest_tool, grant_xp_tool, get_level_info_tool. Lifecycle: created → active → resolved → debriefed → rewarded → archived. Sound chimes via gnome-speaks PlaySound. Voice narration via gnome-speaks Speak.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('scout-skill', 'skills', 'The Scout''s Eye', '/scout Command', 'Discover and probe network nodes — port scans, service detection, device identification', 'The Scout''s Eye peers into the unknown — scanning ports, identifying services, and cataloging new devices. It combines nmap''s power with the realm''s entity resolver to map discoveries back to known nodes. Useful for investigating unknown wanderers or verifying service health.', 'Skill file: skills/scout.md. Wraps: nmap (port scan, service detection, OS fingerprinting), curl (HTTP probes), dig (DNS lookups). Results mapped to entities via entity_resolver. New discoveries can be added to topology.json or flagged for investigation.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('lore-skill', 'skills', 'The Lorekeeper', '/lore Command', 'Look up realm codex, node histories, and networking concepts', 'The /lore skill opens the Living Codex — this very collection of knowledge. It can look up networking concepts, node backstories, chronicles of past events, and the player''s personal journal. The Codex grows with each discovery.', 'Skill file: skills/lore.md. Tools: lookup_lore_tool (codex search by ID or category), node_lore_tool (entity backstories), chronicles_tool (historical narratives), journal_tool + add_journal_tool (player notes). Categories: protocols, networking, security, services, architecture, resources, skills, game, nodes.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('forge-skill', 'skills', 'The Enchantment Forge', '/forge Command', 'Craft automation as enchantments — systemd timers, cron jobs, hooks, monitoring rules', 'The Forge turns manual tasks into permanent enchantments. A realm-optimizer timer, a theme-watcher service, a hook that rebuilds on file change — all are crafted here. The Forge understands systemd, cron, Claude Code hooks, and realmwatch event triggers.', 'Skill file: skills/forge.md. Creates: systemd user services/timers, Claude Code hooks (settings.json), realmwatch event handlers, shell scripts in /opt/realmwatch/bin/. Safety: all enchantments are user-scoped (no root), reversible, and logged.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('summon-skill', 'skills', 'The Summoner', '/summon Command', 'Spawn AI agents as realm companions or summon VM realms', 'The Summoner calls forth companions — AI agents that work in parallel on the Watcher''s behalf. It can also summon entire realms (VMs) from the dormant state. "Summon a research team" spawns named agents with voices. "Summon the Shadow Realm" boots the Kali VM.', 'Skill file: skills/summon.md. Agent spawning: Agent tool with team_name, voice assignment from roster, background execution. VM management: virsh start/stop/list via servers/plugins/vm_monitor.py. VMs: shadow-realm (Kali), mirror-realm (Android), outer-realm (Windows), hearthstone (HAOS).', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('realm-skill', 'skills', 'The Realm Overview', '/realm Command', 'View realm status, map overview, and entity list', 'The /realm skill provides a bird''s eye view — how many nodes are online, how many events have occurred, active threats, and player state. It''s the quick status check before diving into specific quests or investigations.', 'Skill file: skills/realm.md. Tools: realm_status_tool (summary), list_entities_tool (node list with status), recent_events_tool (event feed). Opens realmwatch map in browser for visual overview.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('patrol-skill', 'skills', 'The Guard''s Patrol', '/patrol Command', 'Health check sweep as guard duty', 'The Patrol walks the realm''s perimeter — pinging nodes, checking services, verifying connectivity. It''s a structured health check that reports any anomalies found. Regular patrols surface problems before they become threats.', 'Skill file: skills/patrol.md. Sweeps: fping all known hosts, check HTTP endpoints, verify service ports, test DNS resolution, measure latency to gateway. Results compared against baseline. Anomalies reported as realm events via ingest_event_tool.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('spellbook', 'skills', 'The Spellbook', 'Slash Command Reference', 'A floating GNOME Shell panel (Super+B) showing available /slash commands — the adventurer''s quick reference', 'The Spellbook hovers at the Watcher''s side — a quick reference of all available skills. Super+B summons it. Each entry shows the command, a brief description, and the key shortcut if any. It''s the index to all realm abilities.', 'GNOME Shell extension panel in realm-hud. Fetches skill list from /api/hud endpoint. Renders as a floating overlay with click-to-copy functionality. Skills are defined as .md files in os.realm.watch/skills/ and .claude/commands/.', 1);

-- === GAME MECHANICS ===
INSERT OR IGNORE INTO codex_entries VALUES ('xp-system', 'game', 'The Path of Experience', 'XP & Leveling System', 'Experience points granted for completing quests, resolving threats, and learning new skills', 'Every deed in the realm earns experience — quests completed, threats resolved, skills discovered. XP accumulates toward the next level. Each level requires more XP than the last (quadratic scaling). Levels unlock new skill tree nodes and increase the Watcher''s standing in the realm.', '`progression` plugin (realmwatch). XP stored in players table (total_xp) in ~/.realmwatch/game.db. Level thresholds: L1=0, L2=100, L3=300, L4=600, L5=1000, L6=1500, L7=2100, L8=2800, L9=3600, L10=4500. XP sources: quest_reward, threat_resolve, discovery, skill_unlock. Dedupe: UNIQUE(player_id, quest_id, source_type) prevents double-granting.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('quest-lifecycle', 'game', 'The Quest Cycle', 'Quest State Machine', 'Forward-only lifecycle: detected → created → active → resolved → debriefed → rewarded → archived', 'A quest is born from an event — a threat detected, a task identified, an optimization suggested. It moves forward through states, never backward. The Watcher accepts it (active), completes the work (resolved), reflects on lessons (debriefed), collects XP (rewarded), and files it away (archived).', '`quests` plugin (realmwatch). States: detected, correlated, created, active, resolved, debriefed, rewarded, archived. Transitions enforced in the plugin. Dedupe: UNIQUE dedupe_key prevents duplicate quests per incident. Quest types: event-generated, manual, migrated. XP granted only in rewarded transition.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('action-policy', 'game', 'The Five Disciplines', 'Action Policy Tiers', 'Safety tiers: observe → suggest → dry-run → confirm → auto — controls what the realm can do autonomously', 'The Five Disciplines govern how much power the realm wields on its own. At Observe, it only watches and reports. At Suggest, it recommends actions. At Dry-Run, it shows what would happen. At Confirm, it asks the Watcher''s permission before acting. At Auto, it acts independently within strict safety bounds.', 'Combat-ward policy.py. Tiers: observe (read-only), suggest (narrate recommendations), dry_run (simulate commands), confirm (execute after explicit approval), auto (execute within safety constraints). Infrastructure nodes (infrastructure_flag=1) never auto-acted. Entity confidence < 80 blocks automated actions.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('entity-resolver', 'game', 'The Name Binder', 'Entity Resolution', 'MAC + IP + hostname → canonical entity ID — how the realm recognizes devices across identity changes', 'Devices in the realm shift identities — MAC randomization, DHCP reassignment, hostname changes. The Name Binder correlates all these signals to maintain a single canonical identity per physical device. It tracks confidence scores and history, building certainty over time.', 'Realm-engine entity_resolver.py. Correlates MAC address, IP address, hostname, and mDNS name. Confidence scoring: exact MAC match = 95, IP+hostname = 80, hostname only = 60. Entity history tables track all observed identities over time. Unknown devices get "_unknown_" prefix with partial MAC suffix.', 1);

-- === NODE CATEGORIES ===
INSERT OR IGNORE INTO codex_entries VALUES ('node-gateway', 'nodes', 'The Gatekeeper', 'OpenWrt Router/Firewall', 'The central guardian — routes traffic between all VLANs and guards the WAN boundary', 'The Gatekeeper stands at the nexus of all twelve realm territories. Every packet between zones passes through its judgment. It speaks to the outside world on behalf of all citizens, maintains the firewall wards, assigns addresses via DHCP, and resolves names via DNS. It is the single point of authority — and vulnerability.', 'gatekeeper (10.0.6.1): OpenWrt 23.05 on Linksys WRT1900ACS. 4-core ARM, 512MB RAM. Runs: dnsmasq (DHCP/DNS), nftables (fw4 firewall), collectd, uhttpd. 12 VLAN interfaces. WAN: cable modem. Managed via SSH (sshpass due to dropbear limitations). Config backup critical.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('node-server', 'nodes', 'The Vault Keeper', 'File/Media Server', 'The central repository — NFS, Samba, Docker containers for media and storage services', 'The Vault Keeper (disks server at 10.0.6.120) guards the realm''s most precious assets — media archives, photo libraries, music collections, and shared files. It runs Docker containers for Jellyfin, Immich, Navidrome, Syncthing, and Vaultwarden. Multiple RAID arrays ensure redundancy.', 'disks (10.0.6.120): Ubuntu Server. Docker Compose for services. Storage: RAID1 for critical data, single disks for media. NFS exports for LAN access. Caddy reverse proxy for HTTPS. Google Drive mounted via rclone at /mnt/gdrive. Collectd monitors disk health, temps, and I/O.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('node-workstation', 'nodes', 'The Citadel', 'Primary Workstation', 'The Watcher''s seat of power — where Claude Code runs, where the realm is commanded', 'Katana is the Watcher''s throne — a powerful workstation running Ubuntu desktop with NVIDIA GPU. All realm management happens here: Claude Code sessions, realmwatch map server (with its in-tree MCP server, the Astral Conduit), and the Realm HUD. It is both the command center and the primary development machine.', 'katana (10.0.6.110): Ubuntu 24.04, Intel i7, 16GB RAM, NVIDIA GPU. Runs: realmwatch (HTTP :80) with the in-tree FastMCP server (Astral Conduit) and game-layer plugins (realm-engine, progression, quests, combat-ward, codex), gnome-speaks, realm-optimizer. GNOME desktop with Realm Shell theme, HUD extension, Spellbook panel. PipeWire audio. Collectd agent reports to self.', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('node-ap', 'nodes', 'The Aether Towers', 'WiFi Access Points', 'The wireless beacons binding mobile devices to the realm', 'Ten Aether Towers span the estate, each covering a different zone. OnHubs guard the core rooms, outdoor APs extend coverage to the grounds, and bridge links connect distant buildings. Each tower reports its connected devices to the Gatekeeper, enabling the realm to track all wireless citizens.', 'Access points: 4x Google OnHub (office, bed, closet, family), 2x Linksys EA6350 (family, CL), 1x Linksys MR8300 (Glenn), 1x Linksys WRT1900AC (family backup), 1x TP-Link EAP225-outdoor (sentinel), 1x TP-Link CPE710 (bridge). All running OpenWrt. Polled via SSH for assoclist (client associations).', 1);
INSERT OR IGNORE INTO codex_entries VALUES ('node-iot', 'nodes', 'The Familiar Spirits', 'IoT Devices', 'The small enchanted devices — sensors, switches, cameras — that observe and act in the physical realm', 'Familiar Spirits are the realm''s eyes and hands in the physical world — ESP32 sensors measuring temperature, SwitchBot toggles controlling lights, Kasa smart plugs managing power, cameras watching perimeters. They live on VLAN 10, isolated from the main network for security.', 'IoT VLAN 10: ESP32 sensors (BLE proxy, environmental), TP-Link Kasa plugs, SwitchBot devices, Hikvision cameras (VLAN 30), Roomba, Nest thermostats, LG appliances. Managed via Home Assistant (10.0.6.108). WAN access blocked by firewall policy (except devices that require cloud connectivity).', 1);

-- Ward templates (pre-defined defense patterns)
INSERT OR IGNORE INTO ward_templates VALUES ('ward_banish', 'IP Block', 'Ward of Banishment', 'block_ip', '{"rule":"nft add rule ip filter input ip saddr {target_ip} drop","scope":"single_ip","reversible":true}', 3, 'Block all traffic from a specific IP address', 1);
INSERT OR IGNORE INTO ward_templates VALUES ('ward_slow', 'Rate Limit', 'Ward of Slowing', 'rate_limit', '{"rule":"nft add rule ip filter input ip saddr {target_ip} limit rate 10/second accept","scope":"single_ip","reversible":true}', 2, 'Rate-limit traffic from a specific IP', 1);
INSERT OR IGNORE INTO ward_templates VALUES ('ward_isolate', 'VLAN Quarantine', 'Ward of Isolation', 'quarantine_device', '{"rule":"move {target_mac} to quarantine VLAN","scope":"single_device","reversible":true}', 4, 'Isolate a device to a quarantine VLAN', 1);
INSERT OR IGNORE INTO ward_templates VALUES ('ward_watch', 'Enhanced Monitoring', 'Ward of Watchfulness', 'enhanced_monitor', '{"rule":"enable detailed logging for {target_ip}","scope":"single_ip","reversible":true}', 1, 'Increase monitoring detail for a suspicious device', 1);
INSERT OR IGNORE INTO ward_templates VALUES ('ward_sentry', 'Fail2Ban Rule', 'The Sentry', 'sentry', '{"rule":"fail2ban-client set {jail} banip {target_ip}","scope":"single_ip","reversible":true}', 3, 'Activate a fail2ban sentry against repeated attacks', 1);

-- Bestiary entries (threat catalog, dual-labeled)
INSERT OR IGNORE INTO bestiary_entries VALUES ('beast_probe', 'port_scan', 'Shadow Probe', 'SYN Scan', 'Dark scouts probing the realm walls, testing every door for weakness. They move silently, mapping defenses before a larger assault.', NULL, 0, NULL, 'ward_banish', NULL, 1);
INSERT OR IGNORE INTO bestiary_entries VALUES ('beast_ram', 'brute_force', 'Battering Ram', 'SSH/Auth Brute Force', 'A relentless ram hammering at the gates with thousands of password attempts. Tireless and methodical, seeking the one weak lock.', NULL, 0, NULL, 'ward_sentry', NULL, 1);
INSERT OR IGNORE INTO bestiary_entries VALUES ('beast_whisper', 'dns_poisoning', 'Whispering Corruption', 'DNS Cache Poisoning', 'A subtle corruption whispering false names to the Naming Stones, redirecting travelers to shadow destinations.', NULL, 0, NULL, 'ward_watch', NULL, 1);
INSERT OR IGNORE INTO bestiary_entries VALUES ('beast_shifter', 'unknown_device', 'Shapeshifter', 'Unknown/Rogue Device', 'An entity of uncertain form appearing uninvited in the realm. Friend or foe — only investigation reveals its nature.', NULL, 0, NULL, 'ward_isolate', NULL, 1);
INSERT OR IGNORE INTO bestiary_entries VALUES ('beast_swarm', 'ddos', 'The Swarm', 'Distributed Denial of Service', 'An overwhelming flood of requests drowning all legitimate traffic. Like locusts, consuming all resources.', NULL, 0, NULL, 'ward_slow', NULL, 1);

-- Achievements
INSERT OR IGNORE INTO achievements VALUES ('first_quest', 'First Steps', 'Complete your first quest', 100);
INSERT OR IGNORE INTO achievements VALUES ('cartographer', 'The Cartographer', 'Discover and name 5 nodes', 250);
INSERT OR IGNORE INTO achievements VALUES ('first_blood', 'First Blood', 'Block your first threat', 200);
INSERT OR IGNORE INTO achievements VALUES ('whisperer', 'The Whisperer', 'Complete a voice-only session', 150);
INSERT OR IGNORE INTO achievements VALUES ('patrol_5', 'Diligent Watcher', 'Complete 5 daily patrols', 300);
INSERT OR IGNORE INTO achievements VALUES ('level_3', 'Apprentice Watcher', 'Reach level 3', 150);
INSERT OR IGNORE INTO achievements VALUES ('level_5', 'Realm Scout', 'Reach level 5', 500);
INSERT OR IGNORE INTO achievements VALUES ('level_10', 'Ward Keeper', 'Reach level 10', 1000);
INSERT OR IGNORE INTO achievements VALUES ('quest_10', 'Seasoned Adventurer', 'Complete 10 quests', 200);
INSERT OR IGNORE INTO achievements VALUES ('quest_25', 'Questmaster', 'Complete 25 quests', 500);
INSERT OR IGNORE INTO achievements VALUES ('quest_50', 'Legend of the Realm', 'Complete 50 quests', 1000);
INSERT OR IGNORE INTO achievements VALUES ('architect', 'The Architect', 'Write a custom MCP server', 2000);
"""


def _migrate_quests_v2(conn: sqlite3.Connection) -> None:
    """Add sub-quest columns if missing (for DBs created before this change)."""
    # Guard: skip if quests table doesn't exist yet (fresh DB)
    tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
    if "quests" not in tables:
        return
    cols = [r[1] for r in conn.execute("PRAGMA table_info(quests)").fetchall()]
    if "parent_quest_id" not in cols:
        conn.execute("ALTER TABLE quests ADD COLUMN parent_quest_id TEXT REFERENCES quests(quest_id)")
        conn.execute("ALTER TABLE quests ADD COLUMN actions_json TEXT DEFAULT '[]'")
        conn.execute("ALTER TABLE quests ADD COLUMN node TEXT")
        conn.execute("ALTER TABLE quests ADD COLUMN sort_order INTEGER DEFAULT 0")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_quests_parent ON quests(parent_quest_id)")
        conn.commit()


def create_database(db_path: str = DEFAULT_DB_PATH) -> None:
    """Create the game database with full Truth Model v1 schema."""
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    # Migrate existing tables BEFORE schema script (which references new columns)
    _migrate_quests_v2(conn)
    conn.executescript(_SCHEMA_SQL)
    conn.executescript(_SEED_SQL)
    conn.commit()
    conn.close()


def get_connection(db_path: str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    """Get a connection with row_factory and foreign keys enabled."""
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn
