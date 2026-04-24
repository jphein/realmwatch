"""Terminal-facing update runner. Shares sources.py with the web panel.

Invoked by scripts/realm-update.sh. Synchronous, streaming output, no SSE.
"""

import json
import os
import pathlib
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sources import SOURCES, PARSERS
import verification

G = "\033[0;32m"
R = "\033[0;31m"
Y = "\033[0;33m"   # amber / yellow — used for advisory warnings too
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

# ── Supply-chain risky sources ───────────────────────────────────

RISKY_SOURCES = {"npm", "pip-user", "mise"}

OSV_ECOSYSTEMS = {
    "npm": "npm",
    "pip-user": "PyPI",
    "mise": None,  # no OSV coverage
}

# ── Persistent first_seen state ──────────────────────────────────

_STATE_FILE = pathlib.Path.home() / ".local/share/realm-update/first_seen.json"


def _load_first_seen() -> dict:
    try:
        return json.loads(_STATE_FILE.read_text())
    except Exception:
        return {}


def _save_first_seen(data: dict):
    try:
        _STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _STATE_FILE.write_text(json.dumps(data, indent=2))
    except Exception:
        pass


# ── Environment / subprocess helpers ────────────────────────────

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


# ── Version collection for risky sources ─────────────────────────

def _collect_versions(src) -> dict:
    """Return {pkg: {"from": current_ver, "to": target_ver}} for risky sources."""
    source_id = src.id
    try:
        if source_id == "npm":
            r = subprocess.run(
                ["npm", "-g", "outdated", "--json"],
                capture_output=True, text=True, env=_env(),
                timeout=60, check=False,
            )
            if not r.stdout.strip():
                return {}
            data = json.loads(r.stdout)
            if not isinstance(data, dict):
                return {}
            out = {}
            for pkg, info in data.items():
                if not isinstance(info, dict):
                    continue
                cur = str(info.get("current") or "")
                tgt = str(info.get("wanted") or info.get("latest") or "")
                if tgt:
                    out[pkg] = {"from": cur, "to": tgt}
            return out

        if source_id == "pip-user":
            r = subprocess.run(
                ["pip", "list", "--user", "--outdated", "--format=json"],
                capture_output=True, text=True, env=_env(),
                timeout=60, check=False,
            )
            if not r.stdout.strip():
                return {}
            data = json.loads(r.stdout)
            if not isinstance(data, list):
                return {}
            out = {}
            for item in data:
                if not isinstance(item, dict):
                    continue
                name = item.get("name")
                if not name:
                    continue
                cur = str(item.get("version") or "")
                tgt = str(item.get("latest_version") or "")
                if tgt:
                    out[name] = {"from": cur, "to": tgt}
            return out

        if source_id == "mise":
            r = subprocess.run(
                ["mise", "outdated"],
                capture_output=True, text=True, env=_env(),
                timeout=60, check=False,
            )
            if not r.stdout.strip():
                return {}
            out = {}
            lines = r.stdout.strip().splitlines()
            for line in lines[1:]:  # skip header
                parts = line.split()
                if len(parts) >= 4:
                    pkg, _requested, current, latest = parts[0], parts[1], parts[2], parts[3]
                    out[pkg] = {"from": current, "to": latest}
                elif len(parts) >= 2:
                    out[parts[0]] = {"from": "", "to": parts[-1]}
            return out

    except Exception:
        return {}


# ── Per-package install for risky sources ────────────────────────

def _install_one(src, pkg: str, to_ver: str) -> bool:
    """Install a single package. Returns True on success."""
    source_id = src.id
    if source_id == "npm":
        cmd = ["npm", "install", "-g", f"{pkg}@{to_ver}"]
    elif source_id == "pip-user":
        cmd = ["pip", "install", "--user", "--break-system-packages",
               "--upgrade", f"{pkg}=={to_ver}"]
    elif source_id == "mise":
        cmd = ["mise", "upgrade", f"{pkg}@{to_ver}"]
    else:
        return False
    rc, _ = _run(src, cmd, shell=False, timeout=src.timeout,
                 ok_codes=src.update_ok_codes, stream=True)
    return rc == 0


# ── Risky source update flow ──────────────────────────────────────

def _run_risky(src, first_seen: dict) -> tuple:
    """Run verified update for a risky source.

    Returns (success: bool, installed_pkgs: list[tuple[str,str]])
    """
    source_id = src.id

    # Ensure per-source dict exists in first_seen.
    if source_id not in first_seen:
        first_seen[source_id] = {}
    fs = first_seen[source_id]  # {version: timestamp}

    # 1. Collect pending versions.
    versions = _collect_versions(src)
    if not versions:
        _ok("nothing to upgrade")
        return (True, [])

    # 2. Record new versions in first_seen.
    now = time.time()
    for info in versions.values():
        ver = info.get("to")
        if ver and ver not in fs:
            fs[ver] = now

    installed: list = []
    any_failure = False

    for pkg, info in versions.items():
        from_ver = info.get("from", "") or ""
        to_ver = info.get("to", "") or ""

        if not to_ver:
            continue

        print(f"\n  {B}{pkg}{N} {D}{from_ver} → {to_ver}{N}")

        # 3a. L2 quarantine check.
        quar, remaining = verification.is_quarantined(source_id, to_ver, fs)
        if quar:
            h = remaining // 3600
            print(f"  {Y}⏳{N} {pkg}@{to_ver} — in quarantine ({h}h remaining), skipping")
            continue

        # 3b. L3A script diff (npm only).
        approved_scripts: dict = {}
        if source_id == "npm":
            new_scripts = verification.fetch_scripts_npm(pkg, to_ver)
            old_scripts = verification.read_installed_scripts_npm(pkg)
            changes = verification.diff_scripts(old_scripts, new_scripts, pkg, from_ver, to_ver)
            if changes:
                print(f"  {Y}!{N} Install-script changes for {B}{pkg}{N}:")
                for ch in changes:
                    if ch.change == "added":
                        label = f"{G}+added{N}"
                        body = ch.new or ""
                    elif ch.change == "removed":
                        label = f"{R}-removed{N}"
                        body = ch.old or ""
                    else:
                        label = f"{Y}~modified{N}"
                        body = f"{R}- {ch.old}{N}\n    {G}+ {ch.new}{N}"
                    print(f"    [{label}] {B}{ch.hook}{N}: {body}")
                try:
                    ans = input(f"  Install {pkg}@{to_ver} anyway? [y/N] ").strip().lower()
                except EOFError:
                    ans = ""
                if ans not in ("y", "yes"):
                    print("  skipped")
                    continue
            approved_scripts = new_scripts

        # 3c. Install.
        ok = _install_one(src, pkg, to_ver)
        if not ok:
            _fail(f"{pkg}@{to_ver} install failed")
            any_failure = True
            continue

        # 3d. L3B audit (npm only).
        if source_id == "npm":
            audit = verification.audit_installed_scripts_npm(pkg, approved_scripts)
            if not audit.get("match", True):
                print(f"  {R}🛑 {pkg} audit failed — on-disk scripts differ from approved manifest{N}")
                any_failure = True
                continue

        installed.append((pkg, to_ver))

    # 4. L1 OSV advisory check (npm and pip-user only).
    ecosystem = OSV_ECOSYSTEMS.get(source_id)
    if ecosystem and installed:
        advisories = verification.osv_batch_query(installed, ecosystem)
        for adv in advisories:
            print(f"  {Y}⚠{N} {adv.package}@{adv.version}: [{adv.severity}] {adv.summary}")

    return (not any_failure, installed)


# ── Output helpers ────────────────────────────────────────────────

def _header(src, verb):
    print(f"\n{B}{src.icon}  {src.fantasy_name}{N} {D}({src.id}) — {verb}{N}")


def _ok(msg):
    print(f"  {G}✓{N} {msg}")


def _warn(msg):
    print(f"  {Y}!{N} {msg}")


def _fail(msg):
    print(f"  {R}✗{N} {msg}")


# ── Commands ──────────────────────────────────────────────────────

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

    # Load first_seen state once; update it for risky sources as we check.
    first_seen = _load_first_seen()
    first_seen_dirty = False

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

        if src.id in RISKY_SOURCES and count > 0:
            # Collect per-version info and record first_seen timestamps.
            if src.id not in first_seen:
                first_seen[src.id] = {}
            fs = first_seen[src.id]
            versions = _collect_versions(src)
            now = time.time()
            for info in versions.values():
                ver = info.get("to")
                if ver and ver not in fs:
                    fs[ver] = now
                    first_seen_dirty = True

            # Show quarantine info alongside the package list.
            if count == 0:
                _ok("up to date")
            else:
                # Check if all versions are quarantined.
                all_quarantined = bool(versions) and all(
                    verification.is_quarantined(src.id, info.get("to", ""), fs)[0]
                    for info in versions.values() if info.get("to")
                )
                preview_parts = []
                for pkg in packages[:5]:
                    info = versions.get(pkg, {})
                    to_ver = info.get("to", "")
                    if to_ver:
                        quar, remaining = verification.is_quarantined(src.id, to_ver, fs)
                        if quar:
                            h = remaining // 3600
                            preview_parts.append(f"{pkg} {Y}⏳{h}h{N}")
                        else:
                            preview_parts.append(pkg)
                    else:
                        preview_parts.append(pkg)
                if len(packages) > 5:
                    preview_parts.append(f"+{len(packages) - 5} more")
                preview = ", ".join(preview_parts)
                if all_quarantined:
                    _warn(f"{count} update{'s' if count != 1 else ''} available (all in quarantine): {preview}")
                else:
                    _warn(f"{count} update{'s' if count != 1 else ''} available: {preview}")
        else:
            if count == 0:
                _ok("up to date")
            else:
                preview = ", ".join(packages[:5])
                if len(packages) > 5:
                    preview += f", +{len(packages) - 5} more"
                _warn(f"{count} update{'s' if count != 1 else ''} available: {preview}")

        results.append((src, count, packages, True))

    if first_seen_dirty:
        _save_first_seen(first_seen)

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
        if src.id in RISKY_SOURCES:
            first_seen = _load_first_seen()
            try:
                ok, _ = _run_risky(src, first_seen)
            finally:
                _save_first_seen(first_seen)
            if ok:
                _ok("warded")
            else:
                _fail("some packages failed or were skipped")
                failures.append(src.id)
        else:
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
        if src.id in RISKY_SOURCES:
            first_seen = _load_first_seen()
            try:
                ok, _ = _run_risky(src, first_seen)
            finally:
                _save_first_seen(first_seen)
            if ok:
                _ok("warded")
            else:
                _fail("some packages failed or were skipped")
                failures.append(src.id)
        else:
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
