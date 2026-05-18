"""Filesystem watcher for fleet.yaml. Polls mtime every 2s; reloads on change.

stdlib-only — no pyinotify dependency. Works on bind mounts and remote FSes."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable


class FleetWatcher(threading.Thread):
    def __init__(self, path: Path, on_change: Callable[[], None],
                 interval: float = 2.0):
        super().__init__(daemon=True, name="fleet-watcher")
        self.path = path
        self.on_change = on_change
        self.interval = interval
        self._last_mtime = self._mtime()
        self._stop = threading.Event()

    def _mtime(self) -> float:
        try:
            return self.path.stat().st_mtime
        except FileNotFoundError:
            return 0.0

    def run(self) -> None:
        while not self._stop.wait(self.interval):
            current = self._mtime()
            if current and current != self._last_mtime:
                self._last_mtime = current
                try:
                    self.on_change()
                except Exception as e:
                    print(f"[fleet-watcher] reload failed: {e}")

    def stop(self) -> None:
        self._stop.set()
