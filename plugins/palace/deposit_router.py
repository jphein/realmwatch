"""Event → palace deposit routing with per-(event-type, node) rate limiting.

When realmwatch fires an event the palace plugin cares about, this router
translates it into a (wing, room, title, body) deposit and pushes it to
palace-daemon via the configured PalaceClient. Rate-limit policy: drop any
deposit whose (event_type, node) tuple has fired within ``RATE_LIMIT_SECS``
of the last accepted deposit. The cache lives in-process — survives
restarts as a no-op (worst case = one extra deposit on restart).

The routing table is small and deliberately conservative — we only deposit
significant events. The taxonomy follows palace-daemon's canonical 7-room
shape:

    wing = "realmwatch"
    room ∈ {architecture, decisions, problems, planning,
            sessions, references, discoveries}
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Callable, Optional


# Default rate-limit window — applies per (event_type, node) tuple.
RATE_LIMIT_SECS = 60.0

# Default XP-grant amount threshold — events at or above this trigger a
# discoveries deposit.
XP_DEPOSIT_THRESHOLD = 100

# Default alert-severity threshold — alerts at or above this go to problems.
ALERT_DEPOSIT_SEVERITY = 4


@dataclass
class Deposit:
    wing: str
    room: str
    title: str
    body: str


class DepositRouter:
    """Routes realmwatch events into palace deposits with rate limiting.

    Args:
        client: A ``PalaceClient`` instance (or any object with a
                ``deposit(wing, room, title, body)`` method returning
                ``(ok, payload)``).
        log:    Optional logger callable (e.g., ``ctx.log``); falls back
                to ``print`` with a ``[palace]`` prefix.
        rate_limit_secs: Cooldown per (event_type, node) tuple. Default 60s.
        wing:   Wing slug for all deposits. Default ``"realmwatch"``.
    """

    def __init__(
        self,
        client,
        log: Optional[Callable[..., None]] = None,
        rate_limit_secs: float = RATE_LIMIT_SECS,
        wing: str = "realmwatch",
    ) -> None:
        self.client = client
        self.log = log if log is not None else (lambda msg, *a: print(("[palace] " + msg) % a if a else "[palace] " + msg))
        self.rate_limit_secs = rate_limit_secs
        self.wing = wing
        self._last_deposit: dict[tuple[str, str], float] = {}
        self._lock = threading.Lock()

    # ── rate limiting ──────────────────────────────────────────────────────

    def _allowed(self, event_type: str, node: str) -> bool:
        """Return True if (event_type, node) hasn't deposited within the
        cooldown window. Updates the last-seen timestamp on True returns.
        """
        key = (event_type, node or "")
        now = time.monotonic()
        with self._lock:
            last = self._last_deposit.get(key, 0.0)
            if now - last < self.rate_limit_secs:
                return False
            self._last_deposit[key] = now
        return True

    # ── public deposit ─────────────────────────────────────────────────────

    def _deposit(self, deposit: Deposit) -> None:
        """Push a deposit to the palace, log on failure, never raise."""
        try:
            ok, payload = self.client.deposit(
                wing=deposit.wing,
                room=deposit.room,
                title=deposit.title,
                body=deposit.body,
            )
        except Exception as exc:  # pragma: no cover — client wraps too
            self.log("deposit raised: %s: %s", exc.__class__.__name__, exc)
            return
        if not ok:
            err = ""
            if isinstance(payload, dict):
                err = payload.get("error") or str(payload)
            self.log("deposit failed (%s/%s): %s", deposit.wing, deposit.room, err)
            return
        # Quiet success — silent_save semantics, palace-daemon is the source
        # of truth on whether it was queued vs immediate.
        drawer_id = ""
        if isinstance(payload, dict):
            drawer_id = payload.get("id") or payload.get("drawer_id") or ""
        self.log("deposited → %s/%s%s",
                 deposit.wing, deposit.room,
                 f" (id={drawer_id})" if drawer_id else "")

    # ── event handlers ─────────────────────────────────────────────────────
    #
    # Each ``on_*`` returns silently and never raises — caller (ctx.on_event
    # subscribers) should not see exceptions from the palace plugin.

    def on_realm_event(self, event: dict) -> None:
        """Dispatch ``realm-event`` events by their ``kind`` field."""
        if not isinstance(event, dict):
            return
        kind = event.get("kind") or ""

        try:
            if kind == "fleet.renamed":
                self._on_fleet_renamed(event)
            elif kind == "fleet.replaced":
                self._on_fleet_replaced(event)
            elif kind == "quest.completed":
                self._on_quest_completed(event)
        except Exception as exc:
            self.log("realm-event router error: %s: %s", exc.__class__.__name__, exc)

    def _on_fleet_renamed(self, event: dict) -> None:
        fleet_id = event.get("fleet_id") or "?"
        old = event.get("from") or "?"
        new = event.get("to") or "?"
        if not self._allowed("fleet.renamed", fleet_id):
            return
        title = f"Renamed {old} → {new}"
        body_lines = [
            f"fleet_id: {fleet_id}",
            f"prior_name: {old}",
            f"current_name: {new}",
        ]
        reason = event.get("reason")
        if reason:
            body_lines.append(f"reason: {reason}")
        self._deposit(Deposit(
            wing=self.wing,
            room="decisions",
            title=title,
            body="\n".join(body_lines),
        ))

    def _on_fleet_replaced(self, event: dict) -> None:
        old_id = event.get("old_fleet_id") or "?"
        new_id = event.get("new_fleet_id") or "?"
        if not self._allowed("fleet.replaced", old_id):
            return
        title = f"Replaced fleet entry {old_id} → {new_id}"
        body_lines = [
            f"old_fleet_id: {old_id}",
            f"new_fleet_id: {new_id}",
        ]
        retired_on = event.get("retired_on")
        if retired_on:
            body_lines.append(f"retired_on: {retired_on}")
        self._deposit(Deposit(
            wing=self.wing,
            room="decisions",
            title=title,
            body="\n".join(body_lines),
        ))

    def _on_quest_completed(self, event: dict) -> None:
        title = event.get("quest_title") or event.get("title") or ""
        if not title:
            return
        quest_id = event.get("quest_id") or event.get("id") or "?"
        if not self._allowed("quest.completed", quest_id):
            return
        completed_ts = event.get("ts") or event.get("completed_ts") or ""
        body_lines = [f"quest_title: {title}"]
        if quest_id and quest_id != "?":
            body_lines.append(f"quest_id: {quest_id}")
        if completed_ts:
            body_lines.append(f"completed_ts: {completed_ts}")
        description = event.get("description") or ""
        if description:
            body_lines.append("")
            body_lines.append(description)
        self._deposit(Deposit(
            wing=self.wing,
            room="sessions",
            title=f"Quest completed: {title}",
            body="\n".join(body_lines),
        ))

    # ── direct event subscriptions ─────────────────────────────────────────

    def on_xp_grant(self, event: dict) -> None:
        """Deposit XP grants above ``XP_DEPOSIT_THRESHOLD`` to discoveries."""
        if not isinstance(event, dict):
            return
        try:
            amount = int(event.get("amount") or 0)
        except (TypeError, ValueError):
            return
        if amount < XP_DEPOSIT_THRESHOLD:
            return
        source = event.get("source_type") or event.get("source") or "event"
        quest_title = event.get("quest_title") or ""
        node = event.get("node") or quest_title or source
        if not self._allowed("xp.grant", node):
            return
        title_bits = [f"+{amount} XP"]
        if quest_title:
            title_bits.append(f"from {quest_title}")
        elif source and source != "event":
            title_bits.append(f"({source})")
        body_lines = [f"amount: {amount}", f"source_type: {source}"]
        if quest_title:
            body_lines.append(f"quest_title: {quest_title}")
        if node and node != source:
            body_lines.append(f"node: {node}")
        try:
            self._deposit(Deposit(
                wing=self.wing,
                room="discoveries",
                title=" ".join(title_bits),
                body="\n".join(body_lines),
            ))
        except Exception as exc:
            self.log("xp.grant deposit error: %s: %s", exc.__class__.__name__, exc)

    def on_alert(self, event: dict) -> None:
        """Deposit alerts of severity ≥ ``ALERT_DEPOSIT_SEVERITY`` to problems."""
        if not isinstance(event, dict):
            return
        try:
            severity = int(event.get("severity") or 0)
        except (TypeError, ValueError):
            severity = 0
        if severity < ALERT_DEPOSIT_SEVERITY:
            return
        node = event.get("node") or event.get("host") or "?"
        alert_type = event.get("alert_type") or event.get("type") or "alert"
        if not self._allowed(f"alert.{alert_type}", node):
            return
        msg = event.get("text") or event.get("msg") or event.get("message") or ""
        title = f"[sev{severity}] {alert_type} — {node}"
        body_lines = [
            f"severity: {severity}",
            f"node: {node}",
            f"alert_type: {alert_type}",
        ]
        if msg:
            body_lines.append("")
            body_lines.append(str(msg)[:1000])
        try:
            self._deposit(Deposit(
                wing=self.wing,
                room="problems",
                title=title,
                body="\n".join(body_lines),
            ))
        except Exception as exc:
            self.log("alert deposit error: %s: %s", exc.__class__.__name__, exc)
