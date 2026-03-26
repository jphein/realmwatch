#!/usr/bin/env python3
"""Realm Launcher — arcane portal for switching between realm branches."""

import http.server
import json
import os
import signal
import subprocess
import sys
import threading
import time

PORT = 8899
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
MAP_SERVER = os.path.join(PROJECT_DIR, 'map_server.py')

def _launcher_version():
    """Git short hash at import time — verifies you're running the latest code."""
    try:
        r = subprocess.run(['git', 'log', '--oneline', '-1', '--', 'realm_launcher.py'],
                           capture_output=True, text=True, cwd=PROJECT_DIR)
        return r.stdout.strip()[:7] if r.stdout.strip() else '???'
    except Exception:
        return '???'

LAUNCHER_VERSION = _launcher_version()

_server_proc = None
_log_lines = []
_log_lock = threading.Lock()
MAX_LOG = 200

def _log(msg):
    ts = time.strftime('%H:%M:%S')
    line = f'[{ts}] {msg}'
    with _log_lock:
        _log_lines.append(line)
        if len(_log_lines) > MAX_LOG:
            _log_lines.pop(0)
    print(line, flush=True)

def _get_branch():
    try:
        r = subprocess.run(['git', 'branch', '--show-current'],
                           capture_output=True, text=True, cwd=PROJECT_DIR)
        return r.stdout.strip()
    except Exception:
        return '???'

def _get_branches():
    try:
        r = subprocess.run(['git', 'branch', '--list'],
                           capture_output=True, text=True, cwd=PROJECT_DIR)
        branches = []
        for line in r.stdout.strip().split('\n'):
            b = line.strip().lstrip('* ').strip()
            if b:
                branches.append(b)
        return branches
    except Exception:
        return []

def _get_commit():
    try:
        r = subprocess.run(['git', 'log', '--oneline', '-1'],
                           capture_output=True, text=True, cwd=PROJECT_DIR)
        return r.stdout.strip()
    except Exception:
        return ''

def _get_ahead_count(branch):
    try:
        r = subprocess.run(['git', 'rev-list', '--count', f'master..{branch}'],
                           capture_output=True, text=True, cwd=PROJECT_DIR)
        return int(r.stdout.strip())
    except Exception:
        return 0

def _kill_port(port=80):
    """Kill any process holding the given port."""
    try:
        r = subprocess.run(['fuser', f'{port}/tcp'],
                           capture_output=True, text=True)
        pids = r.stdout.strip().split()
        for pid in pids:
            pid = pid.strip()
            if pid and pid.isdigit():
                _log(f'Killing existing server (PID {pid}) on :{port}')
                os.kill(int(pid), signal.SIGTERM)
        if pids:
            time.sleep(1)
            # Force-kill stragglers
            for pid in pids:
                pid = pid.strip()
                if pid and pid.isdigit():
                    try:
                        os.kill(int(pid), signal.SIGKILL)
                    except ProcessLookupError:
                        pass
    except Exception as e:
        _log(f'Port cleanup note: {e}')

def _is_server_running():
    global _server_proc
    if _server_proc and _server_proc.poll() is None:
        return True
    # Also check if anything is listening on :80 (e.g. server started outside launcher)
    try:
        r = subprocess.run(['fuser', '80/tcp'], capture_output=True, text=True)
        return bool(r.stdout.strip())
    except Exception:
        return False

def _stop_server():
    global _server_proc
    if _server_proc and _server_proc.poll() is None:
        _log('Stopping map_server.py...')
        _server_proc.terminate()
        try:
            _server_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _server_proc.kill()
            _server_proc.wait()
        _log('Server stopped')
    _server_proc = None
    # Also kill any orphaned server on :80
    _kill_port(80)


def _stop_all_services():
    """Stop all realm services except the launcher itself."""
    _stop_server()
    for svc in ("realm-map-server", "oracle-daemon", "realm-herald"):
        try:
            r = subprocess.run(
                ["systemctl", "--user", "is-active", svc],
                capture_output=True, text=True, timeout=5
            )
            if r.stdout.strip() == "active":
                _log(f"Stopping {svc}...")
                subprocess.run(
                    ["systemctl", "--user", "stop", svc],
                    capture_output=True, timeout=10
                )
                _log(f"  {svc} stopped")
        except (subprocess.TimeoutExpired, FileNotFoundError):
            _log(f"  Failed to stop {svc}")


def _start_all_services():
    """Start all realm services (map server via subprocess, others via systemd)."""
    _start_server()
    for svc in ("oracle-daemon", "realm-herald"):
        try:
            r = subprocess.run(
                ["systemctl", "--user", "is-enabled", svc],
                capture_output=True, text=True, timeout=5
            )
            if r.stdout.strip() == "enabled":
                _log(f"Starting {svc}...")
                subprocess.run(
                    ["systemctl", "--user", "start", svc],
                    capture_output=True, timeout=10
                )
                _log(f"  {svc} started")
        except (subprocess.TimeoutExpired, FileNotFoundError):
            _log(f"  Failed to start {svc}")

def _start_server():
    global _server_proc
    _stop_server()
    _log('Starting map_server.py...')
    _server_proc = subprocess.Popen(
        [sys.executable, MAP_SERVER],
        cwd=PROJECT_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    # Background thread to capture server output
    def _reader():
        for line in _server_proc.stdout:
            _log('[server] ' + line.decode(errors='replace').rstrip())
    threading.Thread(target=_reader, daemon=True).start()
    # Wait for server to bind — check for port availability
    for i in range(10):
        time.sleep(0.5)
        if _server_proc.poll() is not None:
            _log('Server failed to start (exited)')
            return
        try:
            r = subprocess.run(['fuser', '80/tcp'], capture_output=True, text=True)
            if r.stdout.strip():
                _log('Server started on :80')
                return
        except Exception:
            pass
    if _server_proc.poll() is None:
        _log('Server started (port check inconclusive)')
    else:
        _log('Server failed to start')

def _build():
    _log('Building realm-map.js...')
    r = subprocess.run(['npm', 'run', 'build'],
                       capture_output=True, text=True, cwd=PROJECT_DIR)
    for line in (r.stdout + r.stderr).strip().split('\n'):
        if line.strip():
            _log('[build] ' + line.strip())
    return r.returncode == 0

def _switch_branch(branch):
    _log(f'Switching to branch: {branch}')
    _stop_server()

    r = subprocess.run(['git', 'checkout', branch],
                       capture_output=True, text=True, cwd=PROJECT_DIR)
    if r.returncode != 0:
        _log(f'Checkout failed: {r.stderr.strip()}')
        return False, r.stderr.strip()

    _log(f'Checked out {branch}')

    if not _build():
        _log('Build failed!')
        return False, 'Build failed'

    _start_server()
    return True, 'ok'


LAUNCHER_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='30' fill='%230a0a1a' stroke='%235030a0' stroke-width='2'/><circle cx='32' cy='30' r='18' fill='%237040c0' opacity='.6'/><polygon points='32,10 36,26 52,26 39,35 43,51 32,41 21,51 25,35 12,26 28,26' fill='none' stroke='%23c0a0ff' stroke-width='1.5' stroke-linejoin='round'/><circle cx='32' cy='30' r='3' fill='%23fff' opacity='.8'/></svg>">
<title>Realm Launcher</title>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Cinzel+Decorative:wght@400;700&family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&display=swap" rel="stylesheet">
<style>
  /* ── Reset ── */
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --void: #030208;
    --void-surface: rgba(12, 8, 20, 0.95);
    --gold: #f0d080;
    --gold-dim: rgba(200, 170, 90, 0.2);
    --gold-bright: rgba(240, 216, 144, 0.8);
    --gold-text: #d4a574;
    --amethyst: #d0a0ff;
    --amethyst-dim: rgba(180, 140, 255, 0.15);
    --emerald: #80e8a0;
    --emerald-dim: rgba(100, 220, 140, 0.15);
    --sapphire: #6cb8ff;
    --ruby: #dc503c;
    --cream: #f0e6c8;
    --leather: rgba(200, 180, 150, 0.5);
    --panel-bg: linear-gradient(145deg, rgba(25, 18, 38, 0.95) 0%, rgba(10, 6, 18, 0.98) 100%);
  }

  body {
    background: var(--void);
    color: var(--cream);
    font-family: 'Cormorant Garamond', 'Georgia', serif;
    min-height: 100vh;
    overflow-x: hidden;
    position: relative;
  }

  /* ── Void background with nebula ── */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background:
      radial-gradient(ellipse 800px 600px at 20% 30%, rgba(60, 30, 100, 0.12) 0%, transparent 70%),
      radial-gradient(ellipse 600px 400px at 75% 70%, rgba(100, 60, 30, 0.08) 0%, transparent 70%),
      radial-gradient(ellipse 900px 500px at 50% 50%, rgba(30, 20, 50, 0.15) 0%, transparent 60%);
    pointer-events: none;
    z-index: 0;
    animation: nebulaShift 30s ease-in-out infinite alternate;
  }

  @keyframes nebulaShift {
    0%   { filter: hue-rotate(0deg); opacity: 1; }
    50%  { filter: hue-rotate(15deg); opacity: 0.8; }
    100% { filter: hue-rotate(-10deg); opacity: 1; }
  }

  /* ── Floating motes ── */
  .mote {
    position: fixed;
    width: 3px; height: 3px;
    border-radius: 50%;
    pointer-events: none;
    z-index: 0;
    opacity: 0;
    animation: moteDrift 12s ease-in-out infinite;
  }
  .mote-gold   { background: var(--gold); box-shadow: 0 0 8px var(--gold); }
  .mote-purple { background: var(--amethyst); box-shadow: 0 0 8px var(--amethyst); }
  .mote-teal   { background: #70e8d8; box-shadow: 0 0 8px #70e8d8; }

  @keyframes moteDrift {
    0%   { opacity: 0; transform: translateY(0) translateX(0); }
    20%  { opacity: 0.6; }
    50%  { opacity: 0.3; transform: translateY(-80px) translateX(20px); }
    80%  { opacity: 0.5; }
    100% { opacity: 0; transform: translateY(-160px) translateX(-10px); }
  }

  /* ── Container ── */
  .launcher {
    position: relative;
    z-index: 1;
    max-width: 1100px;
    margin: 0 auto;
    padding: 48px 32px 40px;
  }

  /* ── Header ── */
  .header {
    text-align: center;
    margin-bottom: 48px;
    position: relative;
  }

  .header-sigil {
    display: inline-block;
    width: 72px; height: 72px;
    border: 1.5px solid var(--gold-dim);
    border-radius: 50%;
    margin-bottom: 20px;
    position: relative;
    background: radial-gradient(circle, rgba(240,208,128,0.06) 0%, transparent 70%);
    animation: sigilPulse 4s ease-in-out infinite;
  }
  .header-sigil::after {
    content: '\2726';
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 30px;
    color: var(--gold);
    text-shadow: 0 0 20px rgba(240,208,128,0.4);
    animation: sigilSpin 40s linear infinite;
  }

  @keyframes sigilPulse {
    0%, 100% { box-shadow: 0 0 20px rgba(240,208,128,0.1); }
    50%      { box-shadow: 0 0 40px rgba(240,208,128,0.2), 0 0 80px rgba(180,140,255,0.08); }
  }
  @keyframes sigilSpin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }

  .header h1 {
    font-family: 'Cinzel Decorative', serif;
    font-size: 32px;
    font-weight: 400;
    color: var(--gold);
    letter-spacing: 6px;
    text-transform: uppercase;
    text-shadow: 0 0 30px rgba(240,208,128,0.2), 0 2px 4px rgba(0,0,0,0.5);
    margin-bottom: 8px;
  }

  .header .subtitle {
    font-family: 'Cormorant Garamond', serif;
    font-size: 16px;
    font-style: italic;
    color: var(--leather);
    letter-spacing: 2px;
  }

  .current-info {
    margin-top: 16px;
    display: flex;
    gap: 24px;
    justify-content: center;
    flex-wrap: wrap;
  }
  .info-chip {
    font-size: 12px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--gold-text);
    padding: 5px 14px;
    border: 1px solid var(--gold-dim);
    border-radius: 20px;
    background: rgba(240,208,128,0.04);
  }
  .info-chip .val { color: var(--cream); font-weight: 600; }

  /* ── Branch portals ── */
  .portals {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
    margin-bottom: 40px;
  }

  @media (max-width: 800px) {
    .portals { grid-template-columns: 1fr; max-width: 420px; margin-left: auto; margin-right: auto; }
  }

  .portal {
    position: relative;
    background: var(--panel-bg);
    border: 1px solid rgba(200,170,90,0.08);
    border-radius: 12px;
    padding: 28px 24px 24px;
    cursor: pointer;
    transition: all 0.4s ease;
    overflow: hidden;
  }
  .portal::before {
    content: '';
    position: absolute;
    inset: -1px;
    border-radius: 12px;
    padding: 1px;
    background: conic-gradient(from 0deg, transparent 30%, var(--gold-dim) 50%, transparent 70%);
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    opacity: 0;
    transition: opacity 0.4s;
    animation: portalRingSpin 8s linear infinite;
  }
  .portal:hover::before { opacity: 1; }
  .portal:hover {
    border-color: var(--gold-dim);
    transform: translateY(-3px);
    box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 40px rgba(240,208,128,0.06);
  }

  @keyframes portalRingSpin {
    from { background: conic-gradient(from 0deg, transparent 30%, var(--gold-dim) 50%, transparent 70%); }
    to   { background: conic-gradient(from 360deg, transparent 30%, var(--gold-dim) 50%, transparent 70%); }
  }

  .portal.active {
    border-color: rgba(200,170,90,0.35);
    box-shadow: 0 4px 24px rgba(0,0,0,0.3), 0 0 30px rgba(240,208,128,0.08), inset 0 0 40px rgba(240,208,128,0.03);
  }
  .portal.active::before { opacity: 1; }
  .portal.active::after {
    content: 'ACTIVE';
    position: absolute;
    top: 12px; right: 14px;
    font-family: 'Cinzel', serif;
    font-size: 9px;
    letter-spacing: 3px;
    color: var(--gold);
    background: rgba(240,208,128,0.1);
    padding: 3px 10px;
    border-radius: 10px;
    border: 1px solid rgba(240,208,128,0.2);
  }

  .portal-icon {
    font-size: 36px;
    margin-bottom: 14px;
    display: block;
    filter: drop-shadow(0 0 12px rgba(240,208,128,0.3));
    transition: transform 0.3s;
  }
  .portal:hover .portal-icon { transform: scale(1.1); }

  .portal-name {
    font-family: 'Cinzel', serif;
    font-size: 17px;
    font-weight: 600;
    color: var(--cream);
    margin-bottom: 4px;
    letter-spacing: 1px;
  }

  .portal-branch {
    font-family: 'Consolas', 'Fira Code', monospace;
    font-size: 12px;
    color: var(--gold-text);
    opacity: 0.7;
    margin-bottom: 12px;
  }

  .portal-desc {
    font-size: 14px;
    line-height: 1.5;
    color: var(--leather);
    margin-bottom: 16px;
  }

  .portal-features {
    list-style: none;
    font-size: 12.5px;
    line-height: 1.8;
    color: rgba(200,180,150,0.6);
  }
  .portal-features li::before {
    content: '\25C7 ';
    color: var(--gold-dim);
    font-size: 10px;
  }
  .portal-features li .tag {
    display: inline-block;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    margin-left: 4px;
    vertical-align: middle;
  }
  .tag-new  { background: rgba(100,220,140,0.12); color: var(--emerald); border: 1px solid rgba(100,220,140,0.2); }
  .tag-ai   { background: rgba(180,140,255,0.12); color: var(--amethyst); border: 1px solid rgba(180,140,255,0.2); }
  .tag-wm   { background: rgba(100,180,255,0.12); color: var(--sapphire); border: 1px solid rgba(100,180,255,0.2); }

  .portal-meta {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid rgba(200,170,90,0.06);
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: rgba(200,180,150,0.35);
    letter-spacing: 0.5px;
  }

  .portal-btn {
    display: block;
    width: 100%;
    margin-top: 16px;
    padding: 10px 0;
    font-family: 'Cinzel', serif;
    font-size: 12px;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: var(--gold);
    background: rgba(240,208,128,0.06);
    border: 1px solid rgba(240,208,128,0.15);
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.3s;
  }
  .portal-btn:hover:not(:disabled) {
    background: rgba(240,208,128,0.12);
    border-color: rgba(240,208,128,0.35);
    box-shadow: 0 0 20px rgba(240,208,128,0.1);
  }
  .portal-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }
  .portal.active .portal-btn {
    color: var(--emerald);
    border-color: rgba(100,220,140,0.2);
    background: rgba(100,220,140,0.06);
  }

  /* ── Loading overlay ── */
  .loading-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: rgba(3,2,8,0.92);
    display: none;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 24px;
    backdrop-filter: blur(8px);
  }
  .loading-overlay.visible { display: flex; }

  .loading-sigil {
    width: 120px; height: 120px;
    position: relative;
  }

  .loading-ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 1.5px solid transparent;
  }
  .loading-ring-outer {
    border-top-color: var(--gold);
    border-right-color: rgba(240,208,128,0.3);
    animation: ringSpinA 2s linear infinite;
  }
  .loading-ring-middle {
    inset: 14px;
    border-bottom-color: var(--amethyst);
    border-left-color: rgba(180,140,255,0.3);
    animation: ringSpinB 3s linear infinite;
  }
  .loading-ring-inner {
    inset: 28px;
    border-top-color: var(--emerald);
    border-right-color: rgba(100,220,140,0.3);
    animation: ringSpinA 1.5s linear infinite;
  }

  .loading-core {
    position: absolute;
    inset: 40px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(240,208,128,0.15), transparent);
    display: flex; align-items: center; justify-content: center;
    font-size: 22px;
    color: var(--gold);
    text-shadow: 0 0 20px rgba(240,208,128,0.5);
    animation: corePulse 1.5s ease-in-out infinite;
  }

  @keyframes ringSpinA { to { transform: rotate(360deg); } }
  @keyframes ringSpinB { to { transform: rotate(-360deg); } }
  @keyframes corePulse {
    0%, 100% { opacity: 0.6; transform: scale(1); }
    50%      { opacity: 1; transform: scale(1.1); }
  }

  .loading-text {
    font-family: 'Cinzel', serif;
    font-size: 15px;
    letter-spacing: 4px;
    text-transform: uppercase;
    color: var(--gold);
    text-shadow: 0 0 20px rgba(240,208,128,0.3);
  }

  .loading-step {
    font-size: 13px;
    color: var(--leather);
    font-style: italic;
    min-height: 20px;
    transition: opacity 0.3s;
  }

  /* ── Console grimoire ── */
  .console-section {
    margin-top: 0;
  }

  .console-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }

  .console-title {
    font-family: 'Cinzel', serif;
    font-size: 13px;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: rgba(200,170,90,0.4);
  }

  .console-actions {
    display: flex; gap: 8px;
  }

  .console-btn {
    font-family: 'Cinzel', serif;
    font-size: 10px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--gold-text);
    background: rgba(240,208,128,0.04);
    border: 1px solid rgba(240,208,128,0.1);
    border-radius: 4px;
    padding: 5px 12px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .console-btn:hover {
    background: rgba(240,208,128,0.1);
    border-color: rgba(240,208,128,0.25);
  }

  .console {
    background: rgba(8, 5, 15, 0.9);
    border: 1px solid rgba(200,170,90,0.08);
    border-radius: 8px;
    padding: 16px;
    height: 180px;
    overflow-y: auto;
    font-family: 'Consolas', 'Fira Code', monospace;
    font-size: 11.5px;
    line-height: 1.6;
    color: rgba(200,180,150,0.5);
    scroll-behavior: smooth;
  }
  .console::-webkit-scrollbar { width: 6px; }
  .console::-webkit-scrollbar-track { background: transparent; }
  .console::-webkit-scrollbar-thumb { background: rgba(200,170,90,0.15); border-radius: 3px; }

  .console .log-line { white-space: pre-wrap; word-break: break-all; }
  .console .log-line:last-child { color: var(--cream); }

  /* ── Server status bar ── */
  .status-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 32px;
    padding: 12px 20px;
    background: var(--panel-bg);
    border: 1px solid rgba(200,170,90,0.06);
    border-radius: 8px;
  }

  .status-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .status-orb {
    width: 10px; height: 10px;
    border-radius: 50%;
    transition: all 0.3s;
  }
  .status-orb.online {
    background: var(--emerald);
    box-shadow: 0 0 10px rgba(100,220,140,0.4);
    animation: orbPulse 2s ease-in-out infinite;
  }
  .status-orb.offline {
    background: rgba(120,80,80,0.6);
    box-shadow: none;
  }

  @keyframes orbPulse {
    0%, 100% { box-shadow: 0 0 10px rgba(100,220,140,0.4); }
    50%      { box-shadow: 0 0 18px rgba(100,220,140,0.6); }
  }

  .status-label {
    font-family: 'Cinzel', serif;
    font-size: 12px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--leather);
  }
  .status-label .val {
    color: var(--cream);
    font-weight: 600;
  }

  .status-actions {
    display: flex;
    gap: 8px;
  }

  .action-btn {
    font-family: 'Cinzel', serif;
    font-size: 10px;
    letter-spacing: 2px;
    text-transform: uppercase;
    padding: 6px 16px;
    border-radius: 5px;
    border: 1px solid;
    cursor: pointer;
    transition: all 0.3s;
    background: transparent;
  }
  .action-btn.rebuild {
    color: var(--sapphire);
    border-color: rgba(100,180,255,0.2);
  }
  .action-btn.rebuild:hover {
    background: rgba(100,180,255,0.08);
    border-color: rgba(100,180,255,0.4);
  }
  .action-btn.restart {
    color: var(--amethyst);
    border-color: rgba(180,140,255,0.2);
  }
  .action-btn.restart:hover {
    background: rgba(180,140,255,0.08);
    border-color: rgba(180,140,255,0.4);
  }
  .action-btn.stop {
    color: var(--ruby);
    border-color: rgba(220,80,60,0.2);
  }
  .action-btn.stop:hover {
    background: rgba(220,80,60,0.08);
    border-color: rgba(220,80,60,0.4);
  }
  .action-btn.open {
    color: var(--emerald);
    border-color: rgba(100,220,140,0.2);
  }
  .action-btn.open:hover {
    background: rgba(100,220,140,0.08);
    border-color: rgba(100,220,140,0.4);
    box-shadow: 0 0 12px rgba(100,220,140,0.1);
  }

  /* ── Decorative corner runes ── */
  .corner-rune {
    position: fixed;
    font-size: 24px;
    color: rgba(200,170,90,0.08);
    pointer-events: none;
    z-index: 0;
  }
  .corner-rune.tl { top: 20px; left: 20px; }
  .corner-rune.tr { top: 20px; right: 20px; }
  .corner-rune.bl { bottom: 20px; left: 20px; }
  .corner-rune.br { bottom: 20px; right: 20px; }
</style>
</head>
<body>

<!-- Decorative motes -->
<div class="mote mote-gold"   style="left:12%;top:20%;animation-delay:0s;animation-duration:14s"></div>
<div class="mote mote-purple" style="left:30%;top:60%;animation-delay:3s;animation-duration:18s"></div>
<div class="mote mote-teal"   style="left:55%;top:35%;animation-delay:6s;animation-duration:16s"></div>
<div class="mote mote-gold"   style="left:78%;top:75%;animation-delay:2s;animation-duration:20s"></div>
<div class="mote mote-purple" style="left:88%;top:15%;animation-delay:8s;animation-duration:15s"></div>
<div class="mote mote-teal"   style="left:42%;top:85%;animation-delay:4s;animation-duration:17s"></div>
<div class="mote mote-gold"   style="left:65%;top:50%;animation-delay:10s;animation-duration:13s"></div>
<div class="mote mote-purple" style="left:8%;top:45%;animation-delay:7s;animation-duration:19s"></div>

<!-- Corner runes -->
<span class="corner-rune tl">&#5765;</span>
<span class="corner-rune tr">&#5765;</span>
<span class="corner-rune bl">&#5792;</span>
<span class="corner-rune br">&#5792;</span>

<!-- Loading overlay -->
<div class="loading-overlay" id="loading-overlay">
  <div class="loading-sigil">
    <div class="loading-ring loading-ring-outer"></div>
    <div class="loading-ring loading-ring-middle"></div>
    <div class="loading-ring loading-ring-inner"></div>
    <div class="loading-core">&#10022;</div>
  </div>
  <div class="loading-text" id="loading-text">Shifting Realms</div>
  <div class="loading-step" id="loading-step">preparing the arcane conduit...</div>
</div>

<div class="launcher">
  <!-- Header -->
  <div class="header">
    <div class="header-sigil"></div>
    <h1>Realm Launcher</h1>
    <div class="subtitle">Choose thy portal &mdash; four paths through the realm &middot; <span style="opacity:0.4;font-size:10px" id="launcher-ver"></span></div>
    <div class="current-info" id="current-info"></div>
  </div>

  <!-- Server status bar -->
  <div class="status-bar">
    <div class="status-left">
      <div class="status-orb" id="status-orb"></div>
      <span class="status-label">
        Map Server &mdash; <span class="val" id="server-status-text">checking...</span>
      </span>
    </div>
    <div class="status-actions">
      <button class="action-btn open" onclick="window.open('http://localhost/realm-map.html','_blank')">&#9670; Open Map</button>
      <button class="action-btn rebuild" onclick="doRebuild()">&#9881; Rebuild</button>
      <button class="action-btn restart" onclick="doRestart()">&#9654; Restart</button>
      <button class="action-btn stop" onclick="doStop()">&#9632; Stop</button>
    </div>
  </div>

  <!-- Branch portals -->
  <div class="portals" id="portals"></div>

  <!-- Console -->
  <div class="console-section">
    <div class="console-header">
      <span class="console-title">&#128220; Arcane Console</span>
      <div class="console-actions">
        <button class="console-btn" onclick="clearConsole()">Clear</button>
      </div>
    </div>
    <div class="console" id="console"></div>
  </div>
</div>

<script>
'use strict';

const BRANCHES = {
  'master': {
    icon: '\u2694\uFE0F',
    name: 'The Foundation',
    desc: 'Stable realm &mdash; core network map with all panels, terrain, effects, and SSE live data.',
    features: [
      'Live collectd metrics &amp; SSE streaming',
      'Panel system with 4 seal modes',
      'Enchanted Forest theme',
      'Inscription Codex panel',
    ],
    tags: {},
  },
  'feature/winbox-wm': {
    icon: '\uD83D\uDDBC\uFE0F',
    name: 'WinBox Realm',
    desc: 'Floating windows via WinBox.js &mdash; panels become draggable, resizable windows.',
    features: [
      'WinBox.js window manager <span class="tag tag-wm">WM</span>',
      'Dark fantasy window theme',
      'Panel resize handles &amp; z-stacking',
      'Gold borders, corner decorations',
    ],
    tags: {},
  },
  'feature/puter-wm': {
    icon: '\u2601\uFE0F',
    name: 'Puter Cloud Realm',
    desc: 'Full Puter.js SDK &mdash; free AI, cloud storage, auth, deploy, sharing, and more.',
    features: [
      'Free Claude Opus 4.6 AI <span class="tag tag-ai">AI</span>',
      'Cloud KV + filesystem <span class="tag tag-new">NEW</span>',
      'Auth, notifications, sharing',
      'Deploy to *.puter.site <span class="tag tag-new">NEW</span>',
      'DOM window manager',
      '10 integrated modules',
    ],
    tags: {},
  },
  'feat/plugin-system': {
    icon: '\uD83E\uDDE9',
    name: 'Plugin Architects',
    desc: 'Modular plugin system &mdash; drop-in plugins with manifests, SSE sources, panels, and node enrichment.',
    features: [
      'Plugin loader with topological sort <span class="tag tag-new">NEW</span>',
      'RouteTable replaces if/elif chains',
      'Ansible War Room plugin <span class="tag tag-new">NEW</span>',
      'Latency prober extracted as plugin',
      'RealmAPI frontend global for plugins',
      'Performance: CSS containment, RAF batching',
    ],
    tags: {},
  },
};

let currentBranch = '';
let serverRunning = false;
let polling = null;

// ── Render portals ──
function renderPortals(status) {
  const container = document.getElementById('portals');
  const items = [];

  for (const [branch, info] of Object.entries(BRANCHES)) {
    const isActive = branch === status.branch;
    const ahead = status.ahead?.[branch] || 0;
    const aheadText = branch === 'master' ? 'base' : `${ahead} ahead`;

    items.push(`
      <div class="portal ${isActive ? 'active' : ''}" data-branch="${branch}">
        <span class="portal-icon">${info.icon}</span>
        <div class="portal-name">${info.name}</div>
        <div class="portal-branch">${branch}</div>
        <div class="portal-desc">${info.desc}</div>
        <ul class="portal-features">
          ${info.features.map(f => `<li>${f}</li>`).join('')}
        </ul>
        <div class="portal-meta">
          <span>${aheadText}</span>
          <span>${isActive ? '\u2714 active' : ''}</span>
        </div>
        <button class="portal-btn" ${isActive ? 'disabled' : ''}
                onclick="switchBranch('${branch}')">
          ${isActive ? '\u25C7 Currently Active' : '\u25C8 Activate Portal'}
        </button>
      </div>
    `);
  }

  container.textContent = '';
  container.insertAdjacentHTML('beforeend', items.join(''));
}

function renderInfo(status) {
  const el = document.getElementById('current-info');
  el.textContent = '';
  el.insertAdjacentHTML('beforeend', `
    <span class="info-chip">Branch: <span class="val">${status.branch}</span></span>
    <span class="info-chip">Commit: <span class="val">${status.commit?.slice(0, 30) || '?'}</span></span>
    <span class="info-chip">Server: <span class="val">${status.server ? 'Running' : 'Stopped'}</span></span>
  `);

  // Update status bar
  const orb = document.getElementById('status-orb');
  const txt = document.getElementById('server-status-text');
  orb.className = 'status-orb ' + (status.server ? 'online' : 'offline');
  txt.textContent = status.server ? 'Online (:80)' : 'Offline';
  serverRunning = status.server;
  currentBranch = status.branch;
}

// ── Console ──
function appendLog(lines) {
  const el = document.getElementById('console');
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'log-line';
    div.textContent = line;
    el.appendChild(div);
  }
  el.scrollTop = el.scrollHeight;
}

function clearConsole() {
  document.getElementById('console').textContent = '';
}

// ── Loading overlay ──
function showLoading(text, step) {
  const overlay = document.getElementById('loading-overlay');
  document.getElementById('loading-text').textContent = text || 'Shifting Realms';
  document.getElementById('loading-step').textContent = step || '';
  overlay.classList.add('visible');
}

function updateLoadingStep(step) {
  document.getElementById('loading-step').textContent = step;
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.remove('visible');
}

// ── API calls ──
async function fetchStatus() {
  try {
    const r = await fetch('/api/status');
    const data = await r.json();
    renderPortals(data);
    renderInfo(data);
    const verEl = document.getElementById('launcher-ver');
    if (verEl && data.launcher_version) verEl.textContent = data.launcher_version;
    if (data.log && data.log.length) {
      const consoleEl = document.getElementById('console');
      const existing = consoleEl.querySelectorAll('.log-line').length;
      if (data.log.length > existing) {
        appendLog(data.log.slice(existing));
      }
    }
  } catch (e) {
    console.error('Status fetch failed:', e);
  }
}

async function switchBranch(branch) {
  if (branch === currentBranch) return;
  showLoading('Shifting Realms', 'checking out ' + branch + '...');

  try {
    const r = await fetch('/api/switch', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ branch }),
    });
    const data = await r.json();

    if (data.ok) {
      updateLoadingStep('realm portal opened successfully');
      await new Promise(res => setTimeout(res, 800));
      await fetchStatus();
    } else {
      updateLoadingStep('portal failed: ' + (data.error || 'unknown'));
      await new Promise(res => setTimeout(res, 2000));
    }
  } catch (e) {
    updateLoadingStep('connection severed: ' + e.message);
    await new Promise(res => setTimeout(res, 2000));
  }

  hideLoading();
}

async function doRebuild() {
  showLoading('Rebuilding', 'compiling realm-map.js...');
  try {
    const r = await fetch('/api/rebuild', { method: 'POST' });
    const data = await r.json();
    updateLoadingStep(data.ok ? 'build complete' : 'build failed');
    await new Promise(res => setTimeout(res, 1000));
    await fetchStatus();
  } catch (e) {
    updateLoadingStep('error: ' + e.message);
    await new Promise(res => setTimeout(res, 1500));
  }
  hideLoading();
}

async function doRestart() {
  showLoading('Restarting', 'awakening the map server...');
  try {
    const r = await fetch('/api/restart', { method: 'POST' });
    const data = await r.json();
    updateLoadingStep(data.ok ? 'server online' : 'restart failed');
    await new Promise(res => setTimeout(res, 1000));
    await fetchStatus();
  } catch (e) {
    updateLoadingStep('error: ' + e.message);
    await new Promise(res => setTimeout(res, 1500));
  }
  hideLoading();
}

async function doStop() {
  try {
    await fetch('/api/stop', { method: 'POST' });
    await fetchStatus();
  } catch (e) {
    console.error(e);
  }
}

// ── Init ──
fetchStatus();
polling = setInterval(fetchStatus, 3000);
</script>
</body>
</html>"""


class LauncherHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # silence default logging

    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def _html(self, html):
        body = html.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/':
            self._html(LAUNCHER_HTML)
        elif self.path == '/api/status':
            branch = _get_branch()
            ahead = {}
            for b in ['feature/winbox-wm', 'feature/puter-wm', 'feat/plugin-system']:
                ahead[b] = _get_ahead_count(b)
            with _log_lock:
                log_copy = list(_log_lines)
            self._json({
                'branch': branch,
                'commit': _get_commit(),
                'server': _is_server_running(),
                'ahead': ahead,
                'log': log_copy,
                'launcher_version': LAUNCHER_VERSION,
            })
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == '/api/switch':
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length)) if length else {}
            branch = body.get('branch')
            if not branch:
                self._json({'ok': False, 'error': 'no branch specified'}, 400)
                return
            ok, msg = _switch_branch(branch)
            self._json({'ok': ok, 'error': msg if not ok else None})

        elif self.path == '/api/rebuild':
            ok = _build()
            self._json({'ok': ok})

        elif self.path == '/api/restart':
            _start_all_services()
            self._json({'ok': _is_server_running()})

        elif self.path == '/api/stop':
            _stop_all_services()
            self._json({'ok': True})

        else:
            self.send_error(404)


def main():
    _log(f'Realm Launcher starting on :{PORT}')
    _log(f'Current branch: {_get_branch()}')
    _log(f'Project: {PROJECT_DIR}')

    # Check if map_server is already running
    if _is_server_running():
        _log('Map server already running on :80 (adopted)')
    else:
        _log('Map server not running — starting it...')
        _start_server()

    http.server.HTTPServer.allow_reuse_address = True
    server = http.server.HTTPServer(('0.0.0.0', PORT), LauncherHandler)
    _log(f'Open http://localhost:{PORT} in your browser')

    def _shutdown(sig, frame):
        _log('Shutting down launcher...')
        _stop_server()
        # shutdown() from a thread to avoid deadlock with serve_forever()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        _shutdown(None, None)
    finally:
        server.server_close()
        _log('Launcher stopped.')


if __name__ == '__main__':
    main()
