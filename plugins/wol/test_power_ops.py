"""Unit tests for the Slumber Ward's magic-packet addressing.

These lock in the two defects fixed alongside the fleet.yaml ops_ip migration
(IP literals -> hostnames), both of which are addressing bugs rather than
protocol bugs:

- `ops_ip` may now be a hostname, so the x.y.z.255 directed broadcast has to be
  computed from a RESOLVED address. The old code ran `rsplit('.', 1)` straight
  on the field, turning "katana.lan" into the nonsense host "katana.255".
- A directed-broadcast failure must never be reported as a failure of the whole
  send. The limited broadcast to 255.255.255.255 goes out first and succeeds;
  the old code shared one try/except, so an unroutable directed subnet made
  send_magic_packet claim {"ok": false, "sent": false} for a packet that was
  already on the wire. That is the #122 lying-instrument class, in the power
  lane.

Everything here is offline: DNS and the socket are both mocked, so no packet is
ever emitted and no name is ever really looked up.
"""

import os
import socket
import sys
from unittest.mock import MagicMock, patch

import pytest

# Make the plugin directory importable regardless of pytest cwd.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import power_ops  # noqa: E402

MAC = "00d861bb9f8e"

# The fleet as it actually looks after the migration, plus the pre-migration
# literal form, which must keep behaving identically.
_DNS = {
    "katana.lan": "10.0.6.129",
    "serialhub.lan": "10.0.6.104",
    "east-tree-trunk.lan": "10.37.5.2",
    "glenn-precision.lan": "10.0.11.130",
    "disks.lan": "10.0.6.120",
    "10.0.6.129": "10.0.6.129",
    "10.37.5.2": "10.37.5.2",
}


def _fake_gethostbyname(name):
    try:
        return _DNS[name]
    except KeyError:
        raise socket.gaierror(-5, "No address associated with hostname")


@pytest.fixture
def dns():
    with patch.object(power_ops.socket, "gethostbyname", _fake_gethostbyname):
        yield


@pytest.mark.parametrize("ops_ip,expected", [
    # Hostnames — the migration's whole point.
    ("katana.lan", "10.0.6.255"),
    ("serialhub.lan", "10.0.6.255"),
    # A host on a subnet that is NOT the admin VLAN. This is the case the old
    # rsplit produced "east-tree-trunk.255" for.
    ("east-tree-trunk.lan", "10.37.5.255"),
    ("glenn-precision.lan", "10.0.11.255"),
    # Dotted-quads must be untouched by the migration.
    ("10.0.6.129", "10.0.6.255"),
    ("10.37.5.2", "10.37.5.255"),
    # host:port — how palace-daemon / mempalace carry their entry.
    ("disks.lan:8085", "10.0.6.255"),
    # Nothing usable.
    ("nope.invalid", None),
    (None, None),
    ("", None),
])
def test_directed_broadcast(dns, ops_ip, expected):
    assert power_ops._directed_broadcast(ops_ip) == expected


def test_hostname_does_not_become_a_dotted_nonsense_host(dns):
    """Regression guard for the literal old bug."""
    assert power_ops._directed_broadcast("katana.lan") != "katana.255"


def _sock_ctx(sendto):
    """A context-manager mock standing in for socket.socket(...)."""
    sock = MagicMock()
    sock.sendto = sendto
    ctx = MagicMock()
    ctx.__enter__ = MagicMock(return_value=sock)
    ctx.__exit__ = MagicMock(return_value=False)
    return ctx


def test_sends_to_both_limited_and_directed_broadcast(dns):
    sent = []
    with patch.object(power_ops.socket, "socket",
                      lambda *a, **k: _sock_ctx(lambda m, addr: sent.append(addr))):
        out = power_ops.send_magic_packet(MAC, "katana.lan")
    assert out["ok"] is True and out["sent"] is True
    assert out["directed_broadcast"] == "10.0.6.255"
    assert "directed_warning" not in out
    assert ("255.255.255.255", 9) in sent
    assert ("10.0.6.255", 9) in sent


def test_directed_failure_does_not_mask_a_successful_send(dns):
    """The bug that was live BEFORE any hostname existed.

    The limited broadcast succeeds; the directed one raises. The result must
    still report ok/sent — the packet really did go out — and surface the
    directed problem as a warning instead of a whole-operation failure.
    """
    sent = []

    def sendto(magic, addr):
        sent.append(addr)
        if addr[0] != "255.255.255.255":
            raise OSError(101, "Network is unreachable")

    with patch.object(power_ops.socket, "socket",
                      lambda *a, **k: _sock_ctx(sendto)):
        out = power_ops.send_magic_packet(MAC, "east-tree-trunk.lan")

    assert out["ok"] is True, "a sent packet must not be reported as a failure"
    assert out["sent"] is True
    assert ("255.255.255.255", 9) in sent
    assert "Network is unreachable" in out["directed_warning"]


def test_limited_broadcast_failure_is_still_a_real_failure(dns):
    """The inverse: if the packet genuinely never left, say so."""
    def sendto(magic, addr):
        raise OSError(1, "Operation not permitted")

    with patch.object(power_ops.socket, "socket",
                      lambda *a, **k: _sock_ctx(sendto)):
        out = power_ops.send_magic_packet(MAC, "katana.lan")

    assert out["ok"] is False
    assert out["sent"] is False
    assert "socket error" in out["error"]


def test_unresolvable_ops_ip_still_sends_the_limited_broadcast(dns):
    """A bad fleet entry must not cost us the broadcast that would have worked."""
    sent = []
    with patch.object(power_ops.socket, "socket",
                      lambda *a, **k: _sock_ctx(lambda m, addr: sent.append(addr))):
        out = power_ops.send_magic_packet(MAC, "nope.invalid")

    assert out["ok"] is True and out["sent"] is True
    assert sent == [("255.255.255.255", 9)]
    assert out["directed_broadcast"] is None
    assert "could not resolve" in out["directed_warning"]


def test_no_ops_ip_is_not_a_warning(dns):
    """Plenty of fleet entries legitimately have no ops_ip at all."""
    with patch.object(power_ops.socket, "socket",
                      lambda *a, **k: _sock_ctx(lambda m, addr: None)):
        out = power_ops.send_magic_packet(MAC, None)
    assert out["ok"] is True
    assert out["directed_broadcast"] is None
    assert "directed_warning" not in out


# ---------------------------------------------------------------------------
# suspend_host — a sleep that did not happen must not be reported as one
# ---------------------------------------------------------------------------
# The same #122 lying-instrument class as the directed-broadcast bug above,
# pointed the other way: suspend_host returned the SSH result, so
# `realm wol sleep familiar` answered {"ok": true, "slept": "familiar"} the
# instant the target ACCEPTED the command, having checked nothing.
#
# Measured on familiar 2026-08-15, three outcomes that were indistinguishable
# at the CLI:
#   * the suspend OOM'd in the PM_SUSPEND_PREPARE notifier chain and rolled
#     back ~95 s later — the host never stopped serving,
#   * the suspend held for ~2 minutes and something woke the host,
#   * the suspend held.
# Reporting all three as success is what let this sit unexamined. These lock
# the difference in. Everything is injected: no packets, no sleeping, no host.

def _ssh_ok(*_a, **_k):
    return {"ok": True, "stdout": "", "stderr": "", "code": 0, "target": "familiar"}


def test_a_host_that_keeps_answering_is_reported_as_a_failed_suspend():
    with patch.object(power_ops, "ssh", _ssh_ok):
        out = power_ops.suspend_host(
            "familiar",
            probe=lambda _n: 0.4,          # answers every single time
            sleep_fn=lambda _s: None,
        )
    assert out["ok"] is False
    assert out["slept"] is False
    assert "still answering" in out["reason"]


def test_suspend_is_confirmed_once_the_host_goes_dark():
    replies = [0.4, 0.4, None]             # answers twice, then gone
    with patch.object(power_ops, "ssh", _ssh_ok):
        out = power_ops.suspend_host(
            "familiar",
            probe=lambda _n: replies.pop(0),
            sleep_fn=lambda _s: None,
        )
    assert out["ok"] is True
    assert out["slept"] is True
    assert out["verified"] is True


def test_an_ssh_failure_short_circuits_before_any_probe():
    """If the command never landed there is nothing to verify — and claiming
    'still answering' would blame the host for the caller's failure."""
    probed = []
    with patch.object(power_ops, "ssh",
                      lambda *_a, **_k: {"ok": False, "stderr": "boom", "code": 255}):
        out = power_ops.suspend_host(
            "familiar",
            probe=lambda n: probed.append(n),
            sleep_fn=lambda _s: None,
        )
    assert out["ok"] is False
    assert probed == []
    assert "verified" not in out


def test_verification_is_bounded_by_the_timeout():
    """A host that never sleeps must not hold the HTTP request open forever."""
    slept_for = []
    with patch.object(power_ops, "ssh", _ssh_ok):
        power_ops.suspend_host(
            "familiar",
            probe=lambda _n: 0.4,
            sleep_fn=slept_for.append,
            verify_timeout=10,
        )
    assert sum(slept_for) <= 10
