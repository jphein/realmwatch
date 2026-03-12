---
name: realm-status
description: Quick health check of all Realm services, ports, and environment
---

# Realm Status

Run the health check script and report results concisely.

## Steps
1. Run `bash scripts/realm-health.sh` from the project root at `/home/jp/Projects/lit-rpg-fantasy-voice`
2. If map_server is down, suggest: `python3 map_server.py &`
3. If oracle_daemon is down, suggest: `python3 oracle_daemon.py --no-voice &`
4. If env vars are missing, suggest: `source .env` or check `~/.bashrc`
5. Report results in a short summary — do not re-read any project files
