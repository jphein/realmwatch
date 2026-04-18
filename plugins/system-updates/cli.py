"""Terminal-facing update runner. Shares sources.py with the web panel.

Invoked by scripts/realm-update.sh. Synchronous, streaming output, no SSE.
"""

import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sources import SOURCES, PARSERS

G = "\033[0;32m"
R = "\033[0;31m"
Y = "\033[0;33m"
C = "\033[0;36m"
D = "\033[2m"
B = "\033[1m"
N = "\033[0m"

USAGE = """Usage:
  realm-update                 check all, then prompt to upgrade
  realm-update list            list known sources
  realm-update check [source]  check all, or one source
  realm-update run   [source]  upgrade all, or one source (no prompt)
  realm-update -h | --help"""


def _env():
    env = os.environ.copy()
    extras = [
        os.path.expanduser("~/.local/bin"),
        os.path.expanduser("~/.npm-global/bin"),
        "/home/linuxbrew/.linuxbrew/bin",
    ]
    env["PATH"] = ":".join(extras) + ":" + env.get("PATH", "")
    env.setdefault("HOMEBREW_NO_AUTO_UPDATE", "1")
    env.setdefault("HOMEBREW_NO_ENV_HINTS", "1")
    return env


def _run(src, cmd, shell, timeout, ok_codes, stream):
    """Run a command, optionally streaming to stdout. Returns (rc, stdout_text)."""
    try:
        proc = subprocess.Popen(
            cmd, shell=shell, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, env=_env(), bufsize=1,
        )
    except FileNotFoundError:
        name = cmd[0] if isinstance(cmd, list) else cmd.split()[0]
        return 127, f"{name}: command not found"

    deadline = time.monotonic() + timeout
    lines = []
    try:
        for line in proc.stdout:
            line = line.rstrip("\n")
            lines.append(line)
            if stream:
                print(f"  {D}│{N} {line}")
            if time.monotonic() > deadline:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                return 124, "\n".join(lines) + "\n[timeout]"
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        raise

    allowed = {0}
    if ok_codes:
        allowed.update(ok_codes)
    if proc.returncode not in allowed:
        return proc.returncode, "\n".join(lines)
    return 0, "\n".join(lines)


def _header(src, verb):
    print(f"\n{B}{src.icon}  {src.fantasy_name}{N} {D}({src.id}) — {verb}{N}")


def _ok(msg):
    print(f"  {G}✓{N} {msg}")


def _warn(msg):
    print(f"  {Y}!{N} {msg}")


def _fail(msg):
    print(f"  {R}✗{N} {msg}")


def cmd_list():
    print(f"\n{B}Known update sources:{N}\n")
    by_group = {}
    for src in SOURCES.values():
        by_group.setdefault(src.lock_group, []).append(src)
    for group in sorted(by_group):
        print(f"  {C}[{group}]{N}")
        for src in by_group[group]:
            print(f"    {src.icon}  {src.id:<10} {D}— {src.fantasy_name}{N}")
    print()


def cmd_check(source_id=None):
    """Check one or all sources. Returns list of (src, count, packages, ok)."""
    targets = [SOURCES[source_id]] if source_id else list(SOURCES.values())
    if source_id and source_id not in SOURCES:
        _fail(f"unknown source: {source_id}")
        sys.exit(2)

    results = []
    for src in targets:
        _header(src, "checking")
        rc, out = _run(src, src.check_cmd, src.check_shell, src.timeout,
                       src.check_ok_codes, stream=False)
        if rc != 0:
            _fail(out.splitlines()[-1] if out else f"exit {rc}")
            results.append((src, 0, [], False))
            continue
        parser = PARSERS.get(src.parse_check_fn, PARSERS["default"])
        count, packages = parser(out)
        if count == 0:
            _ok("up to date")
        else:
            preview = ", ".join(packages[:5])
            if len(packages) > 5:
                preview += f", +{len(packages) - 5} more"
            _warn(f"{count} update{'s' if count != 1 else ''} available: {preview}")
        results.append((src, count, packages, True))
    return results


def cmd_run(source_id=None):
    """Upgrade one or all sources."""
    if source_id and source_id not in SOURCES:
        _fail(f"unknown source: {source_id}")
        sys.exit(2)
    targets = [SOURCES[source_id]] if source_id else list(SOURCES.values())
    failures = []
    for src in targets:
        _header(src, "upgrading")
        rc, out = _run(src, src.update_cmd, src.update_shell, src.timeout,
                       src.update_ok_codes, stream=True)
        if rc == 0:
            _ok("warded")
        else:
            _fail(f"exit {rc}")
            failures.append(src.id)
    print()
    if failures:
        _fail(f"failed: {', '.join(failures)}")
        sys.exit(1)
    _ok("all sources warded")


def cmd_interactive():
    results = cmd_check()
    pending = [(s, c, p) for (s, c, p, ok) in results if ok and c > 0]
    broken = [s for (s, _, _, ok) in results if not ok]

    print()
    if broken:
        _warn(f"could not check: {', '.join(s.id for s in broken)}")
    if not pending:
        _ok("nothing to upgrade")
        return

    total = sum(c for _, c, _ in pending)
    names = ", ".join(f"{s.id}({c})" for s, c, _ in pending)
    print(f"{B}{total} updates across:{N} {names}")
    try:
        ans = input(f"{C}Upgrade now? [y/N] {N}").strip().lower()
    except EOFError:
        ans = ""
    if ans not in ("y", "yes"):
        print("aborted.")
        return

    failures = []
    for src, _, _ in pending:
        _header(src, "upgrading")
        rc, _ = _run(src, src.update_cmd, src.update_shell, src.timeout,
                     src.update_ok_codes, stream=True)
        if rc == 0:
            _ok("warded")
        else:
            _fail(f"exit {rc}")
            failures.append(src.id)
    print()
    if failures:
        _fail(f"failed: {', '.join(failures)}")
        sys.exit(1)
    _ok("all pending updates warded")


def main():
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help", "help"):
        print(USAGE)
        return
    try:
        if not args:
            cmd_interactive()
        elif args[0] == "list":
            cmd_list()
        elif args[0] == "check":
            cmd_check(args[1] if len(args) > 1 else None)
        elif args[0] == "run":
            cmd_run(args[1] if len(args) > 1 else None)
        else:
            print(USAGE, file=sys.stderr)
            sys.exit(2)
    except KeyboardInterrupt:
        print("\naborted.")
        sys.exit(130)


if __name__ == "__main__":
    main()
