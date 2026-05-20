"""The Command Spire plugin — exposes the entire realm CLI surface inside the webgui.

Endpoints:
  GET  /cli/commands        — list every available realm subcommand (one per file
                              under scripts/cli/) for the panel quick-bar
  GET  /cli/run/<subcmd>    — run `realm <subcmd>` with query-string args, return
                              stdout/stderr/code (read-only / GET-safe commands)
  GET  /cli/brief           — convenience alias for /cli/run/brief
  GET  /cli/doctor          — convenience alias; ?quick=1 maps to --quick
  GET  /cli/logs            — convenience alias for /cli/run/logs
  POST /exec                — run `realm <cmd>` from the Scrying Terminal
                              (the only path for mutating commands)

Security: localhost binding. Subcommand allowlist is "every script in
scripts/cli/realm-*.sh" — i.e. anything you could invoke from the shell. No
arbitrary shell injection: input is shlex-parsed and the first token MUST be
`realm` (or the absolute realm binary path).
"""

from __future__ import annotations

import shlex
import subprocess
from pathlib import Path

from realm_text import real_home


_REALM_HOME = real_home() / "Projects" / "realmwatch"
_REALM_BIN = real_home() / ".local" / "bin" / "realm"
_REALM_CLI_DIR = _REALM_HOME / "scripts" / "cli"


def _available_subcommands() -> list[str]:
    """Discover every `realm <X>` subcommand by globbing scripts/cli/realm-*.sh."""
    if not _REALM_CLI_DIR.exists():
        return []
    out = []
    for p in sorted(_REALM_CLI_DIR.glob("realm-*.sh")):
        # realm-fleet.sh → "fleet"
        name = p.stem.removeprefix("realm-")
        out.append(name)
    return out


def _run_realm(args: list[str], timeout: int = 30) -> dict:
    """Invoke the realm CLI dispatcher. Returns {stdout, stderr, code, text}."""
    if not _REALM_BIN.exists():
        return {
            "stdout": "",
            "stderr": f"realm CLI not installed at {_REALM_BIN} (run: make cli-install)",
            "code": 127,
            "text": "",
        }
    cmd = [str(_REALM_BIN), *args]
    env = dict(os.environ)
    env["REALM_NO_COLOR"] = "1"
    env["NO_COLOR"] = "1"
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
            cwd=str(_REALM_HOME),
        )
        text = proc.stdout if proc.returncode == 0 else (proc.stdout + ("\n" + proc.stderr if proc.stderr else ""))
        return {"stdout": proc.stdout, "stderr": proc.stderr, "code": proc.returncode, "text": text}
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": f"timeout after {timeout}s", "code": 124, "text": ""}
    except Exception as e:
        return {"stdout": "", "stderr": f"exec failed: {e}", "code": 1, "text": ""}


def setup(ctx):
    """Register CLI endpoints."""

    SUBCOMMANDS = _available_subcommands()

    def commands_handler(req, params):
        """List all discoverable realm subcommands for the panel quick-bar."""
        return req.respond({"commands": SUBCOMMANDS, "count": len(SUBCOMMANDS)})

    def run_handler(req, params):
        """Run `realm <subcmd>` with extra args from query string `?args=...`.

        Path: /cli/run/<subcmd>
        Optional query params:
          args   — extra args, space-separated and shlex-parsed (e.g. ?args=list)
          quick  — adds --quick (for doctor)
          json   — adds --json
        """
        subcmd = (params or {}).get("subcmd", "").strip()
        if not subcmd:
            return req.respond({"stderr": "missing subcommand", "code": 2}, status=400)
        if subcmd not in SUBCOMMANDS:
            return req.respond({
                "stderr": f"unknown subcommand: {subcmd!r}. "
                          f"available: {', '.join(SUBCOMMANDS)}",
                "code": 2,
            }, status=404)

        cli_args = [subcmd]
        qp = req.query_params or {}
        extra = (qp.get("args") or "").strip()
        if extra:
            try:
                cli_args.extend(shlex.split(extra))
            except ValueError as e:
                return req.respond({"stderr": f"args parse error: {e}", "code": 2}, status=400)
        if qp.get("quick") in ("1", "true", "yes"):
            cli_args.append("--quick")
        if qp.get("json") in ("1", "true", "yes"):
            cli_args.append("--json")

        return req.respond(_run_realm(cli_args, timeout=60))

    def brief_handler(req, params):
        return req.respond(_run_realm(["brief"], timeout=15))

    def doctor_handler(req, params):
        qp = req.query_params or {}
        args = ["doctor"]
        if qp.get("quick") in ("1", "true", "yes"):
            args.append("--quick")
        return req.respond(_run_realm(args, timeout=45))

    def logs_handler(req, params):
        qp = req.query_params or {}
        try:
            n = max(10, min(int(qp.get("n", "100")), 2000))
        except (TypeError, ValueError):
            n = 100
        args = ["logs", "-n", str(n)]
        plugin = (qp.get("plugin") or "").strip()
        if plugin:
            args.extend(["--plugin", plugin])
        if qp.get("errors") in ("1", "true", "yes"):
            args.append("--errors")
        return req.respond(_run_realm(args, timeout=10))

    def exec_handler(req, params):
        """Scrying Terminal — runs an arbitrary `realm <subcmd> ...`."""
        try:
            body = req.json()
        except Exception:
            return req.respond({"stdout": "", "stderr": "invalid JSON", "code": 2}, status=400)

        cmd_str = (body.get("command") or "").strip()
        if not cmd_str:
            return req.respond({"stdout": "", "stderr": "command required", "code": 2}, status=400)

        try:
            tokens = shlex.split(cmd_str)
        except ValueError as e:
            return req.respond({"stdout": "", "stderr": f"parse error: {e}", "code": 2}, status=400)

        if not tokens or tokens[0] not in ("realm", str(_REALM_BIN)):
            return req.respond({
                "stdout": "",
                "stderr": "only `realm <subcommand>` is permitted; no raw shell from this endpoint",
                "code": 2,
            }, status=400)

        return req.respond(_run_realm(tokens[1:], timeout=60))

    ctx.register_endpoint("GET", "/cli/commands", commands_handler, raw_path=True)
    ctx.register_endpoint("GET", "/cli/run/<subcmd>", run_handler, raw_path=True)
    ctx.register_endpoint("GET", "/cli/brief", brief_handler, raw_path=True)
    ctx.register_endpoint("GET", "/cli/doctor", doctor_handler, raw_path=True)
    ctx.register_endpoint("GET", "/cli/logs", logs_handler, raw_path=True)
    ctx.register_endpoint("POST", "/exec", exec_handler, raw_path=True)

    ctx.log(f"command-spire loaded; {len(SUBCOMMANDS)} realm subcommands exposed via /cli/run/<subcmd>")
