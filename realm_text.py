"""Realm text utilities — string sanitization, ID generation, real-home resolution.

Migrated from os.realm.watch/servers/shared/{sanitizer,ulid}.py 2026-05-19.

All hostnames, SSIDs, service banners, and log lines from the network are
untrusted input. The sanitizer functions strip/escape them before they reach
any LLM prompt or game system. The ulid() helper produces monotonic, sortable
26-char IDs (Crockford base32) with no external dependency.

`real_home()` returns the invoking user's home directory even when the process
runs under sudo. realmwatch's `make dev` binds port 80 via sudo, so plain
`os.path.expanduser("~")` resolves to `/root` — game.db / fleet.yaml /
realm-local.json all live under the original user's home. Use this helper
when reading or writing those files from plugin / core code.
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Sanitizers — network-sourced strings → LLM-safe strings
# ---------------------------------------------------------------------------

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_ANGLE_BRACKETS = re.compile(r"[<>]")
_QUOTES = re.compile(r"[\"']")


def sanitize_hostname(hostname: str | None, max_len: int = 128) -> str:
    """Sanitize a hostname/SSID/mDNS name for safe use in prompts."""
    if not hostname:
        return ""
    s = _CONTROL_CHARS.sub("", str(hostname))
    s = _ANGLE_BRACKETS.sub("", s)
    s = _QUOTES.sub("", s)
    return s[:max_len]


def sanitize_banner(banner: str | None, max_len: int = 256) -> str:
    """Sanitize a service banner (SSH, HTTP, etc.)."""
    if not banner:
        return ""
    s = _CONTROL_CHARS.sub("", str(banner))
    s = _ANGLE_BRACKETS.sub("", s)
    s = _QUOTES.sub("", s)
    return s[:max_len]


def sanitize_log_line(raw_line: str) -> dict:
    """Parse a log line into structured fields. Never expose raw text to AI.

    Returns dict with safe fields only: source_ip, event_type, timestamp_str.
    """
    fields = {"source_ip": "", "event_type": "unknown", "timestamp_str": ""}

    if not raw_line:
        return fields

    # Extract source IP if present
    ip_match = re.search(r"SRC=(\d+\.\d+\.\d+\.\d+)", raw_line)
    if ip_match:
        fields["source_ip"] = ip_match.group(1)

    # Extract common event types
    if "DROP" in raw_line:
        fields["event_type"] = "firewall_drop"
    elif "ACCEPT" in raw_line:
        fields["event_type"] = "firewall_accept"
    elif "Failed password" in raw_line:
        fields["event_type"] = "auth_failure"
    elif "Accepted" in raw_line:
        fields["event_type"] = "auth_success"

    # Extract timestamp prefix (first 15 chars of syslog format)
    if len(raw_line) >= 15 and raw_line[3] == " ":
        fields["timestamp_str"] = sanitize_hostname(raw_line[:15], 15)

    return fields


# ---------------------------------------------------------------------------
# ULID — monotonic, sortable, 26-char Crockford base32, no external dep
# (Python 3.12+ also offers uuid.uuid4() as an alternative for non-sortable IDs.)
# ---------------------------------------------------------------------------

_ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


# ---------------------------------------------------------------------------
# real_home — invoking-user home even under sudo
# ---------------------------------------------------------------------------


def real_home() -> Path:
    """Return the invoking user's home directory.

    Walks SUDO_USER → LOGNAME → USER → Path.home(). When realmwatch's
    map_server is started via `sudo` (to bind port 80) the bare home
    resolves to /root, but JP's data lives in /home/jp/. This helper
    keeps the two cases coherent.
    """
    for env_var in ("SUDO_USER", "LOGNAME", "USER"):
        user = os.environ.get(env_var)
        if user and user != "root":
            home = Path("/home") / user
            if home.is_dir():
                return home
            # Fall back to pwd lookup for non-/home users (e.g. /Users on
            # macOS dev boxes) — best-effort, swallow any failure.
            try:
                import pwd

                return Path(pwd.getpwnam(user).pw_dir)
            except (KeyError, ImportError):
                continue
    return Path.home()


def ulid() -> str:
    """Generate a ULID (26 chars, Crockford base32)."""
    t = int(time.time() * 1000)
    # 10-char timestamp
    ts_part = ""
    for _ in range(10):
        ts_part = _ENCODING[t & 0x1F] + ts_part
        t >>= 5
    # 16-char randomness
    rand_bytes = os.urandom(10)
    rand_part = ""
    for b in rand_bytes:
        rand_part += _ENCODING[b & 0x1F]
        rand_part += _ENCODING[(b >> 5) & 0x1F]
    return ts_part + rand_part[:16]
