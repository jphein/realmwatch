import psutil
import subprocess
import json
import os
import time
import shlex
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

# Prime psutil's CPU percent counter so that subsequent interval=0 calls
# return a meaningful delta instead of 0.0 on the first invocation.
psutil.cpu_percent(interval=None)

# Sensor cache to avoid repeated expensive calls within a short window
_cache = {}
_CACHE_TTL = 2.0  # seconds


def _cached(key, fn):
    now = time.monotonic()
    entry = _cache.get(key)
    if entry and (now - entry[0]) < _CACHE_TTL:
        return entry[1]
    val = fn()
    _cache[key] = (now, val)
    return val


class RealmEngine:
    # Known hosts in the realm and their roles
    KNOWN_HOSTS = {
        "katana":    {"role": "citadel",  "desc": "The Citadel — primary server"},
        "terra":     {"role": "outpost",  "desc": "Terra — remote outpost"},
        "openclaw":  {"role": "outpost",  "desc": "OpenClaw — remote outpost"},
        "ha":        {"role": "homestead","desc": "The Homestead — Home Assistant"},
    }

    def __init__(self):
        self.persona = "The System"
        self.katana_ip = os.getenv("KATANA_IP", "10.0.6.129")
        self.router_ip = os.getenv("ROUTER_IP", "10.0.6.1")
        self.ubox_ip = os.getenv("UBOX_IP", "10.0.6.11")

        self.notion_token = os.getenv("NOTION_TOKEN")
        self.database_id = os.getenv("NOTION_DATABASE_ID")
        self._notion = None

        # Auto-detect which host we're running on
        import socket
        self.hostname = socket.gethostname().lower()
        host_info = self.KNOWN_HOSTS.get(self.hostname, {"role": "unknown", "desc": f"Unknown host: {self.hostname}"})
        self.host_role = host_info["role"]
        self.host_desc = host_info["desc"]
        self.on_katana = self.hostname == "katana"

    def get_host_config(self):
        """Return current host detection and routing config as a dict."""
        return {
            "hostname": self.hostname,
            "role": self.host_role,
            "description": self.host_desc,
            "on_katana": self.on_katana,
            "router_access": "direct" if self.on_katana else "hop_via_katana",
            "katana_ip": self.katana_ip,
            "router_ip": self.router_ip,
            "ubox_ip": self.ubox_ip,
            "known_hosts": self.KNOWN_HOSTS,
        }

    # --- Tailscale mesh ---

    def get_tailscale_status(self):
        def _read():
            try:
                raw = subprocess.check_output(
                    ["tailscale", "status", "--json"],
                    text=True, timeout=3
                )
                data = json.loads(raw)
                peers = data.get("Peer", {})
                online = [v["HostName"] for v in peers.values() if v.get("Online")]
                total = len(peers)
                details = {}
                for v in peers.values():
                    dns = v.get("DNSName", "")
                    host = dns.split(".")[0] if dns else v.get("HostName", "")
                    ips = v.get("TailscaleIPs", [])
                    d = {
                        "online": v.get("Online", False),
                        "os": v.get("OS", ""),
                        "ip": ips[0] if ips else "",
                        "relay": v.get("Relay", ""),
                        "active": v.get("Active", False),
                        "curAddr": v.get("CurAddr", ""),
                        "rx": v.get("RxBytes", 0),
                        "tx": v.get("TxBytes", 0),
                        "exitNode": v.get("ExitNode", False),
                    }
                    ls = v.get("LastSeen", "")
                    if ls and not ls.startswith("0001"):
                        d["lastSeen"] = ls
                    ke = v.get("KeyExpiry", "")
                    if ke and not ke.startswith("0001"):
                        d["keyExpiry"] = ke
                    details[host] = d
                return {"online": online, "online_count": len(online), "total": total, "peers": details}
            except (subprocess.TimeoutExpired, subprocess.CalledProcessError,
                    FileNotFoundError, json.JSONDecodeError):
                return None
        return _cached("tailscale", _read)

    @property
    def notion(self):
        if self._notion is None and self.notion_token:
            from notion_client import Client
            self._notion = Client(auth=self.notion_token)
        return self._notion

    # --- Scales ---

    def get_depletion_scale(self, value, inverse=False):
        """Map 0-100 percentage to the -10/+10 Depletion/Repletion scale.
        -10 = Despair/Powerlessness, +10 = Empowerment/Plenitude."""
        scale = (value - 50) / 5
        if inverse:
            scale = -scale
        return round(scale, 1)

    def scale_label(self, scale):
        """Translate a scale value into Access to Power language."""
        if scale <= -7:
            return "Deep Depletion"
        elif scale <= -3:
            return "Depleted"
        elif scale <= 3:
            return "Balanced"
        elif scale <= 7:
            return "Replete"
        else:
            return "Full Plenitude"

    # --- Sensor reads (cached + parallel) ---

    def _validate_ip(self, ip):
        parts = ip.split(".")
        if len(parts) != 4:
            return False
        return all(p.isdigit() and 0 <= int(p) <= 255 for p in parts)

    def _run_router_cmd(self, command):
        if not self._validate_ip(self.router_ip):
            return None
        safe_cmd = shlex.quote(command)
        # If running on Katana, SSH directly to router; otherwise hop through Katana
        if self.on_katana:
            hop_cmd = f"ssh -o ConnectTimeout=3 -o BatchMode=yes -o StrictHostKeyChecking=accept-new root@{shlex.quote(self.router_ip)} {safe_cmd}"
        else:
            if not self._validate_ip(self.katana_ip):
                return None
            hop_cmd = f"ssh -o ConnectTimeout=3 -o BatchMode=yes -o StrictHostKeyChecking=accept-new {shlex.quote(self.katana_ip)} 'ssh -o ConnectTimeout=2 -o BatchMode=yes root@{shlex.quote(self.router_ip)} {safe_cmd}'"
        try:
            return subprocess.check_output(hop_cmd, shell=True, text=True, timeout=8)
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError, OSError):
            return None

    def get_gpu_stats(self):
        def _read():
            try:
                res = subprocess.check_output(
                    ["nvidia-smi", "--query-gpu=temperature.gpu,utilization.gpu",
                     "--format=csv,noheader,nounits"],
                    text=True, timeout=3
                ).strip().split(",")
                return {"temp": float(res[0]), "load": float(res[1])}
            except (subprocess.TimeoutExpired, subprocess.CalledProcessError,
                    FileNotFoundError, ValueError, IndexError):
                return None
        return _cached("gpu", _read)

    def check_node(self, ip):
        if not self._validate_ip(ip):
            return False
        try:
            subprocess.check_output(
                ["ping", "-c", "1", "-W", "1", ip],
                timeout=2, stderr=subprocess.DEVNULL
            )
            return True
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError, OSError):
            return False

    def get_nft_counters(self):
        def _read():
            raw = self._run_router_cmd("nft -j list ruleset")
            if not raw:
                return None
            try:
                data = json.loads(raw)
                counters = {"wan": 0, "lan": 0, "admin": 0}
                for item in data.get("nftables", []):
                    rule = item.get("rule")
                    if rule and rule.get("chain") in ("accept_to_wan", "accept_to_lan", "accept_to_admin"):
                        for expr in rule.get("expr", []):
                            counter = expr.get("counter")
                            if counter:
                                key = rule["chain"].replace("accept_to_", "")
                                counters[key] = counter.get("bytes", 0)
                return counters
            except (json.JSONDecodeError, KeyError):
                return None
        return _cached("nft", _read)

    # Ping list derived from topology.json — any node with an "ip" field gets pinged
    _TOPOLOGY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "topology.json")
    _topo_mtime = 0
    _realm_nodes = {}

    @classmethod
    def _load_realm_nodes(cls):
        """Load ping targets from topology.json (cached by mtime)."""
        try:
            mt = os.path.getmtime(cls._TOPOLOGY_FILE)
            if cls._realm_nodes and mt == cls._topo_mtime:
                return cls._realm_nodes
            with open(cls._TOPOLOGY_FILE) as f:
                topo = json.load(f)
            nodes = {}
            for n in topo.get("nodes", []):
                ip = n.get("ip")
                if ip and not ip.endswith(".x"):  # skip placeholder IPs
                    nodes[n["id"]] = ip
            cls._realm_nodes = nodes
            cls._topo_mtime = mt
        except (OSError, json.JSONDecodeError):
            pass  # keep previous cache on error
        return cls._realm_nodes

    @property
    def REALM_NODES(self):
        return self._load_realm_nodes()

    def _get_nodes_parallel(self):
        """Ping all realm nodes concurrently."""
        def _read():
            results = {}
            with ThreadPoolExecutor(max_workers=len(self.REALM_NODES)) as pool:
                futures = {pool.submit(self.check_node, ip): name
                           for name, ip in self.REALM_NODES.items()}
                for f in as_completed(futures):
                    results[futures[f]] = f.result()
            return results
        return _cached("nodes", _read)

    # --- Status assembly ---

    def get_status(self):
        cpu_usage = psutil.cpu_percent(interval=0)
        memory = psutil.virtual_memory()
        battery = psutil.sensors_battery()

        temps = psutil.sensors_temperatures()
        core_temps = temps.get("coretemp", [])
        max_temp = max((t.current for t in core_temps), default=None)

        gpu = self.get_gpu_stats()
        nodes = self._get_nodes_parallel()
        nft = self.get_nft_counters() if nodes.get("katana") else None

        net = psutil.net_io_counters()
        total_mb = (net.bytes_sent + net.bytes_recv) / (1024 * 1024)

        cpu_scale = self.get_depletion_scale(cpu_usage, inverse=True)
        mana_scale = self.get_depletion_scale(memory.percent, inverse=True)
        batt_pct = battery.percent if battery else 100
        essence_scale = self.get_depletion_scale(batt_pct)

        return {
            "forge": {
                "usage": cpu_usage, "temp": max_temp, "gpu": gpu,
                "scale": cpu_scale,
                "msg": self.translate_cpu(cpu_usage, max_temp, gpu),
            },
            "mana": {
                "usage": memory.percent, "scale": mana_scale,
                "msg": self.translate_memory(memory.percent),
            },
            "essence": {
                "usage": batt_pct, "plugged": battery.power_plugged if battery else True,
                "scale": essence_scale,
                "msg": self.translate_battery(battery),
            },
            "astral": {
                "traffic": total_mb, "nodes": nodes, "nft": nft,
                "msg": self.translate_network(nodes, total_mb, nft),
            },
            "realm_scale": round((cpu_scale + mana_scale + essence_scale) / 3, 1),
        }

    # --- Fantasy translations (sensor facts only) ---

    def translate_cpu(self, usage, temp, gpu):
        if usage > 90:
            msg = "The Great Forge is white-hot, consuming all fuel."
        elif usage > 70:
            msg = "The Great Forge roars with intense flame."
        elif usage > 40:
            msg = "The Great Forge burns with steady purpose."
        else:
            msg = "The Great Forge smolders gently, conserving its heat."
        if temp:
            msg += f" Thermal focus: {temp:.0f}C."
        if gpu:
            if gpu["load"] > 80:
                msg += f" The Crystal Engine blazes at {gpu['load']:.0f}% intensity, {gpu['temp']:.0f}C."
            elif gpu["load"] > 30:
                msg += f" The Crystal Engine hums at {gpu['load']:.0f}%, {gpu['temp']:.0f}C."
            else:
                msg += f" The Crystal Engine rests at {gpu['temp']:.0f}C."
        return msg

    def translate_memory(self, usage):
        if usage > 90:
            return "The Mana Well is nearly dry. Resources are critically scarce."
        elif usage > 70:
            return "The Mana Well runs low. The realm feels the strain."
        elif usage > 40:
            return "The Mana Well holds steady, currents flowing evenly."
        return "The Mana Well brims with potential."

    def translate_battery(self, battery):
        if not battery:
            return "Life Essence is anchored to the Eternal Source."
        pct = battery.percent
        plugged = battery.power_plugged
        if plugged:
            if pct >= 95:
                return "Life Essence is full, tethered to the Eternal Source."
            return f"Life Essence replenishes at the Source ({pct}%)."
        if pct < 10:
            return f"Life Essence fades to a flicker ({pct}%). The realm dims."
        elif pct < 30:
            return f"Life Essence wanes ({pct}%). Seek the Source soon."
        elif pct < 60:
            return f"Life Essence flows steadily ({pct}%)."
        return f"Life Essence is robust ({pct}%)."

    def translate_network(self, nodes, traffic, nft):
        report = []
        if nodes.get("katana"):
            report.append("Katana is unsheathed.")
        else:
            report.append("Katana sleeps in its scabbard.")
        if nodes.get("gatekeeper"):
            report.append("The Gatekeeper stands watch.")
            if nft:
                wan_gb = nft["wan"] / (1024 ** 3)
                report.append(f"WAN Gate: {wan_gb:.2f} GB.")
        else:
            report.append("The Gatekeeper is silent.")
        if nodes.get("oracle"):
            report.append("The Oracle Stone pulses.")
        return " ".join(report)

    # --- Access to Power interpretation layer ---

    def detect_pig_messages(self, stats):
        """Identify pig messages in the system state.
        Returns a list of (pig_type, message) tuples.
        These are the Stories, not the Facts."""
        pigs = []
        forge = stats["forge"]["usage"]
        mana = stats["mana"]["usage"]
        essence = stats["essence"]["usage"]
        scale = stats["realm_scale"]

        if forge > 90 and mana > 80:
            pigs.append(("lazy",
                "The Forge demands you work harder, burn hotter. "
                "But the observable fact is: the realm is under heavy load. "
                "That is a structural condition, not a personal failing."))
        if mana > 90:
            pigs.append(("weak",
                "The Mana Well whispers you cannot sustain this. "
                "But the fact is: memory is a finite resource being shared. "
                "Scarcity is real; shame about it is pig."))
        if essence < 20 and not stats["essence"].get("plugged", True):
            pigs.append(("deserve_to_die",
                "Life Essence fading can trigger the deepest pig: "
                "'it doesn't matter.' But it does. Seek the Source. "
                "The observable fact is: the battery needs charging."))
        if scale < -5:
            pigs.append(("stupid",
                "When everything feels depleted, the pig says "
                "'you should have managed this better.' "
                "The adult observer notes: depletion is systemic, "
                "not a measure of your intelligence or worth."))
        return pigs

    def adult_observation(self, stats):
        """The Adult Observer voice: analytical, compassionate, grounded in facts.
        Distinguishes Stories from Observable Facts."""
        scale = stats["realm_scale"]
        label = self.scale_label(scale)
        pigs = self.detect_pig_messages(stats)

        lines = []
        lines.append(f"Realm Depletion/Repletion: {scale:+.1f} ({label})")

        if pigs:
            lines.append("")
            lines.append("Pig Whispers Detected:")
            for pig_type, msg in pigs:
                lines.append(f"  [{pig_type}] {msg}")
            lines.append("")
            lines.append("The Adult Observer reminds you: "
                         "these are stories layered onto facts. "
                         "What is true? What is not true? What is also true?")
        else:
            lines.append("No pig activity detected. The realm is in balance.")
            lines.append("The Adult Observer is present and at ease.")

        return "\n".join(lines)

    # --- Observation + Notion logging ---

    def log_to_notion(self, stats):
        if not self.notion or not self.database_id:
            return
        try:
            usage = stats["forge"]["usage"]
            mana = stats["mana"]["usage"]
            if usage > 90 or mana > 90:
                status_label = "Critical"
            elif usage > 70 or mana > 70:
                status_label = "Roaring"
            else:
                status_label = "Stable"
            self.notion.pages.create(
                parent={"database_id": self.database_id},
                properties={
                    "Observation": {"title": [{"text": {"content": f"System Scan - {datetime.now().strftime('%H:%M:%S')}"}}]},
                    "Timestamp": {"date": {"start": datetime.now().isoformat()}},
                    "Great Forge (CPU)": {"number": usage / 100},
                    "Mana Well (RAM)": {"number": mana / 100},
                    "Astral Flow (MB)": {"number": stats["astral"]["traffic"]},
                    "Status": {"select": {"name": status_label}},
                },
            )
        except Exception:
            pass

