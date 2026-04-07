"""GitHub discovery plugin — The Archive Spire.

Discovers GitHub repos via gh CLI. Tracks repo status, CI, PRs, issues.
Auto-links repos to topology nodes by name match.
"""

import json
import logging
import os
import subprocess

from discovery_engine import SubEntity

log = logging.getLogger(__name__)

_GITHUB_USER = "jphein"
_PROJECTS_DIR = os.path.expanduser("~/Projects")


def _gh(args, timeout=30):
    """Run gh CLI command, return parsed JSON or None."""
    try:
        result = subprocess.run(
            ["gh"] + args, capture_output=True, text=True, timeout=timeout
        )
        if result.returncode != 0:
            return None
        return json.loads(result.stdout) if result.stdout.strip() else None
    except Exception:
        return None


def discover_github(node_id, node_data, host_access, engine):
    """Discover GitHub repos via gh CLI."""
    repos = _gh([
        "repo", "list", _GITHUB_USER, "--json",
        "name,description,isPrivate,defaultBranchRef,updatedAt,url,pushedAt",
        "--limit", "100"
    ])
    if not repos:
        return []

    import time
    now = time.time()
    entities = []

    for repo in repos:
        name = repo.get("name", "")
        if not name:
            continue

        updated = repo.get("pushedAt") or repo.get("updatedAt", "")
        url = repo.get("url", "")
        is_private = repo.get("isPrivate", False)
        description = repo.get("description") or ""
        default_branch = (repo.get("defaultBranchRef") or {}).get("name", "main")

        # Check for local project
        local_path = os.path.join(_PROJECTS_DIR, name)
        has_local = os.path.isdir(local_path)
        has_claude_md = os.path.isfile(os.path.join(local_path, "CLAUDE.md")) if has_local else False

        # Determine status based on activity
        status = "active"
        if updated:
            try:
                from datetime import datetime
                pushed = datetime.fromisoformat(updated.replace("Z", "+00:00"))
                age_days = (datetime.now(pushed.tzinfo) - pushed).days
                if age_days > 90:
                    status = "stale"
                elif age_days > 30:
                    status = "inactive"
            except Exception:
                pass

        entities.append(SubEntity(
            id=f"github:{_GITHUB_USER}:{name}",
            type="github_repo",
            name=name,
            host_node_id="github",
            status=status,
            metadata={
                "url": url,
                "private": is_private,
                "description": description,
                "default_branch": default_branch,
                "updated_at": updated,
                "local_path": local_path if has_local else None,
                "has_claude_md": has_claude_md,
                "has_local": has_local,
            },
        ))

    return entities


def setup(ctx):
    ctx.register_discovery_provider(
        name="github",
        roles=[],  # global provider
        discover_fn=discover_github,
        interval=300,  # 5 minutes
        entity_types=["github_repo"],
        priority=65,
    )
    ctx.log("The Archive Spire active — GitHub repo discovery registered (interval=300s)")
