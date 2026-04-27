"""Desktop notifications for source check/update completion.

Why a separate module: notifications need to fail safely (no notify-send,
DISPLAY unset, dbus not running) without affecting the runner's main path.
Wrapping subprocess.Popen in try/except keeps every call site one line.

Toggle: set ``SYSTEM_UPDATES_NOTIFY=0`` to disable. Default is enabled
when ``DISPLAY`` is set (i.e. running interactively under a desktop
session, not headless).
"""
import os
import shutil
import subprocess


def _enabled() -> bool:
    if os.environ.get("SYSTEM_UPDATES_NOTIFY") == "0":
        return False
    if not os.environ.get("DISPLAY"):
        return False
    return shutil.which("notify-send") is not None


def notify(title: str, body: str, urgency: str = "normal") -> None:
    """Fire-and-forget desktop toast. Silent on failure.

    ``urgency`` is one of ``low|normal|critical`` per the libnotify spec.
    Failed updates use ``critical`` so they linger; successes use ``normal``.
    """
    if not _enabled():
        return
    try:
        subprocess.Popen(
            ["notify-send", "--app-name=Scroll of Patch Runes",
             f"--urgency={urgency}", title, body],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except (FileNotFoundError, OSError):
        pass


def notify_check_result(fantasy_name: str, count: int) -> None:
    """Toast after a check finishes — only if updates are available."""
    if count <= 0:
        return
    word = "update" if count == 1 else "updates"
    notify(f"\U0001f4dc {fantasy_name}", f"{count} {word} available")


def notify_update_result(fantasy_name: str, ok: bool, error: str | None) -> None:
    """Toast after an update finishes — both success and failure."""
    if ok:
        notify(f"\U0001f4dc {fantasy_name}", "Update completed", urgency="low")
    else:
        msg = error or "see logs"
        notify(f"\U0001f4dc {fantasy_name}", f"Update failed: {msg}",
               urgency="critical")
