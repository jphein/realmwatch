"""Update source definitions and state registry."""

import time
from dataclasses import dataclass, field


# ── Data models ──────────────────────────────────────────────────

@dataclass
class UpdateSource:
    """Definition of a single update source."""
    id: str
    fantasy_name: str
    icon: str
    lock_group: str          # "dpkg" or the source id (independent)
    check_cmd: list          # shell command list or shell string
    update_cmd: list         # shell command list or shell string
    check_shell: bool = False  # if True, check_cmd is run via shell
    update_shell: bool = False # if True, update_cmd is run via shell
    timeout: int = 300       # seconds
    parse_check_fn: str = "default"  # name of parser function
    check_ok_codes: list = None  # extra exit codes that are OK for check (e.g., npm returns 1 for "outdated found")


@dataclass
class SourceState:
    """Runtime state of a single update source."""
    status: str = "idle"
    available: int = 0
    packages: list = field(default_factory=list)
    last_check: float = 0.0
    last_update: float = 0.0
    log_lines: list = field(default_factory=list)
    error: str | None = None
    queued_behind: str | None = None


MAX_LOG_LINES = 200


# ── Source registry ──────────────────────────────────────────────

SOURCES: dict[str, UpdateSource] = {}
_state: dict[str, SourceState] = {}


def _register(src: UpdateSource):
    SOURCES[src.id] = src
    _state[src.id] = SourceState()


# ── Check output parsers ────────────────────────────────────────

def parse_apt(stdout: str) -> tuple[int, list[str]]:
    """Parse 'apt list --upgradable' output."""
    packages = []
    for line in stdout.strip().splitlines():
        # Only parse lines with the "pkg/suite version" format
        if "/" in line and "[upgradable" in line:
            name = line.split("/")[0]
            packages.append(name)
    return len(packages), packages


def parse_snap(stdout: str) -> tuple[int, list[str]]:
    """Parse 'snap refresh --list' output."""
    lines = stdout.strip().splitlines()
    if not lines or "All snaps up to date" in stdout:
        return 0, []
    packages = []
    for line in lines[1:]:  # skip header
        parts = line.split()
        if parts:
            packages.append(parts[0])
    return len(packages), packages


def parse_flatpak(stdout: str) -> tuple[int, list[str]]:
    """Parse 'flatpak remote-ls --updates' output."""
    lines = [l.strip() for l in stdout.strip().splitlines() if l.strip()]
    packages = []
    for line in lines:
        parts = line.split("\t")
        packages.append(parts[0] if parts else line)
    return len(packages), packages


def parse_deb_get(stdout: str) -> tuple[int, list[str]]:
    """Parse deb-get show-upgradable output."""
    lines = [l.strip() for l in stdout.strip().splitlines()
             if l.strip() and not l.startswith("Listing")]
    packages = []
    for line in lines:
        name = line.split("/")[0] if "/" in line else line.split()[0]
        packages.append(name)
    return len(packages), packages


def parse_firmware(stdout: str) -> tuple[int, list[str]]:
    """Parse fwupdmgr get-updates output."""
    if "No updates available" in stdout or "No updatable devices" in stdout:
        return 0, []
    devices = [l.strip() for l in stdout.splitlines() if l.strip().startswith("New version:")]
    return len(devices), [f"firmware-device-{i}" for i in range(len(devices))]


def parse_mise(stdout: str) -> tuple[int, list[str]]:
    """Parse 'mise outdated' output."""
    lines = stdout.strip().splitlines()
    if not lines or "All tools are up to date" in stdout:
        return 0, []
    packages = []
    for line in lines[1:]:  # skip header
        parts = line.split()
        if parts:
            packages.append(parts[0])
    return len(packages), packages


def parse_brew(stdout: str) -> tuple[int, list[str]]:
    """Parse 'brew outdated' output."""
    lines = [l.strip() for l in stdout.strip().splitlines() if l.strip()]
    return len(lines), lines


def parse_npm(stdout: str) -> tuple[int, list[str]]:
    """Parse 'npm -g outdated' output."""
    lines = stdout.strip().splitlines()
    if not lines:
        return 0, []
    packages = []
    for line in lines[1:]:  # skip header
        parts = line.split()
        if parts:
            packages.append(parts[0])
    return len(packages), packages


def parse_pip_user(stdout: str) -> tuple[int, list[str]]:
    """Parse 'pip list --user --outdated --format=json' output."""
    import json
    try:
        items = json.loads(stdout)
        names = [p["name"] for p in items]
        return len(names), names
    except (json.JSONDecodeError, KeyError):
        return 0, []


def parse_version_only(stdout: str) -> tuple[int, list[str]]:
    """For self-updating tools (claude, copilot) — no check, just version info."""
    return 0, []


PARSERS = {
    "apt": parse_apt,
    "snap": parse_snap,
    "flatpak": parse_flatpak,
    "deb_get": parse_deb_get,
    "firmware": parse_firmware,
    "mise": parse_mise,
    "brew": parse_brew,
    "npm": parse_npm,
    "pip_user": parse_pip_user,
    "version_only": parse_version_only,
    "default": parse_version_only,
}


# ── Source definitions ───────────────────────────────────────────

_register(UpdateSource(
    id="apt",
    fantasy_name="Arcane Packages",
    icon="\U0001f4e6",  # 📦
    lock_group="dpkg",
    check_cmd="sudo apt update -qq && apt list --upgradable 2>/dev/null",
    update_cmd="sudo apt upgrade -y && sudo apt autoremove -y",
    check_shell=True,
    update_shell=True,
    timeout=600,
    parse_check_fn="apt",
))

_register(UpdateSource(
    id="snap",
    fantasy_name="Snap Wards",
    icon="\U0001f512",  # 🔒
    lock_group="snap",
    check_cmd=["snap", "refresh", "--list"],
    update_cmd=["sudo", "snap", "refresh"],
    parse_check_fn="snap",
    check_ok_codes=[1],  # snap returns 1 when no updates available
))

_register(UpdateSource(
    id="flatpak",
    fantasy_name="Flatpak Scrolls",
    icon="\U0001f4cb",  # 📋
    lock_group="flatpak",
    check_cmd=["flatpak", "remote-ls", "--updates"],
    update_cmd=["flatpak", "update", "-y"],
    parse_check_fn="flatpak",
))

_register(UpdateSource(
    id="deb-get",
    fantasy_name="Deb Grimoire",
    icon="\U0001f4d5",  # 📕
    lock_group="dpkg",
    check_cmd="deb-get update && deb-get show-upgradable",
    update_cmd="deb-get upgrade",
    check_shell=True,
    update_shell=True,
    parse_check_fn="deb_get",
))

_register(UpdateSource(
    id="firmware",
    fantasy_name="Firmware Runes",
    icon="\U0001f525",  # 🔥
    lock_group="dpkg",
    check_cmd="sudo fwupdmgr refresh --force 2>/dev/null; sudo fwupdmgr get-updates 2>&1",
    update_cmd="sudo fwupdmgr update --no-reboot-check 2>&1",
    check_shell=True,
    update_shell=True,
    parse_check_fn="firmware",
))

_register(UpdateSource(
    id="mise",
    fantasy_name="Mise Armory",
    icon="\u2697\ufe0f",  # ⚗️
    lock_group="mise",
    check_cmd=["mise", "outdated"],
    update_cmd=["mise", "upgrade"],
    parse_check_fn="mise",
))

_register(UpdateSource(
    id="brew",
    fantasy_name="Brew Cellar",
    icon="\U0001f37a",  # 🍺
    lock_group="brew",
    check_cmd=["brew", "outdated"],
    update_cmd="brew update && brew upgrade",
    update_shell=True,
    parse_check_fn="brew",
))

_register(UpdateSource(
    id="claude",
    fantasy_name="Claude Codex",
    icon="\U0001f916",  # 🤖
    lock_group="claude",
    check_cmd=["claude", "--version"],
    update_cmd=["claude", "update"],
    parse_check_fn="version_only",
))

_register(UpdateSource(
    id="copilot",
    fantasy_name="Copilot Familiar",
    icon="\U0001f98a",  # 🦊
    lock_group="copilot",
    check_cmd=["copilot", "--version"],
    update_cmd=["copilot", "update"],
    parse_check_fn="version_only",
))

_register(UpdateSource(
    id="npm",
    fantasy_name="Node Enchantments",
    icon="\U0001f4d7",  # 📗
    lock_group="npm",
    check_cmd=["npm", "-g", "outdated"],
    update_cmd=["npm", "-g", "update"],
    parse_check_fn="npm",
    check_ok_codes=[1],  # npm returns 1 when outdated packages exist
))

_register(UpdateSource(
    id="pip-user",
    fantasy_name="Pip Elixirs",
    icon="\U0001f9ea",  # 🧪
    lock_group="pip-user",
    check_cmd=["pip", "list", "--user", "--outdated", "--format=json"],
    update_cmd="pip list --user --outdated --format=json 2>/dev/null | python3 -c \"import sys,json; [print(p['name']) for p in json.load(sys.stdin)]\" | xargs -r pip install --user --upgrade",
    update_shell=True,
    parse_check_fn="pip_user",
))


# ── State access ─────────────────────────────────────────────────

def get_state(source_id: str) -> dict:
    """Get serializable state for one source."""
    src = SOURCES.get(source_id)
    st = _state.get(source_id)
    if not src or not st:
        return {}
    return {
        "id": src.id,
        "fantasy_name": src.fantasy_name,
        "icon": src.icon,
        "lock_group": src.lock_group,
        "status": st.status,
        "available": st.available,
        "packages": st.packages,
        "last_check": st.last_check,
        "last_update": st.last_update,
        "log_lines": list(st.log_lines),
        "error": st.error,
        "queued_behind": st.queued_behind,
    }


def get_all_state() -> dict:
    """Get serializable state for all sources."""
    sources = {}
    for sid in SOURCES:
        sources[sid] = get_state(sid)
    warded = sum(1 for s in _state.values() if s.status in ("up-to-date", "idle"))
    pending = sum(s.available for s in _state.values() if s.status == "updates-available")
    running = sum(1 for s in _state.values() if s.status in ("checking", "updating", "queued"))
    failed = sum(1 for s in _state.values() if s.status == "failed")
    return {
        "sources": sources,
        "summary": {
            "warded": warded,
            "pending": pending,
            "running": running,
            "failed": failed,
            "total": len(SOURCES),
        },
    }


def update_state(source_id: str, **kwargs):
    """Update state fields for a source."""
    st = _state.get(source_id)
    if not st:
        return
    for k, v in kwargs.items():
        if hasattr(st, k):
            setattr(st, k, v)


def append_log(source_id: str, line: str):
    """Append a line to a source's log ring buffer."""
    st = _state.get(source_id)
    if not st:
        return
    st.log_lines.append(line)
    if len(st.log_lines) > MAX_LOG_LINES:
        st.log_lines = st.log_lines[-MAX_LOG_LINES:]


def clear_log(source_id: str):
    """Clear a source's log buffer."""
    st = _state.get(source_id)
    if st:
        st.log_lines.clear()
