# Autodiscovery Phase 5 — Inventory & Code Awareness

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inventory plugins — GitHub repos, local project directories, and manual entries for non-discoverable infrastructure. This gives realmwatch awareness of the full development lifecycle: code → deployment → running service.

**Depends on:** Phase 1 (core engine)

**Estimated tasks:** 3

**Spec:** `docs/superpowers/specs/2026-04-07-autodiscovery-engine-design.md` (sections: github, projects, manual plugins)

---

## File Structure

| File | Changes |
|------|---------|
| `plugins/github/plugin.json` | New — manifest for GitHub discovery plugin |
| `plugins/github/plugin.py` | New — GitHub repo status, CI, PRs, issues via `gh` CLI |
| `plugins/projects/plugin.json` | New — manifest for local projects plugin |
| `plugins/projects/plugin.py` | New — ~/Projects/ inventory, git status, stack detection |
| `plugins/manual/plugin.json` | New — manifest for manual entries plugin |
| `plugins/manual/plugin.py` | New — static entries, relationships, tags, bookmarks + API endpoints |
| `map_server.py` | Register manual plugin API endpoints |

---

## Task 1: GitHub Plugin ("The Archive Spire")

**Files:** `plugins/github/plugin.json`, `plugins/github/plugin.py`

**Description:** Discover GitHub repositories via the `gh` CLI (already authenticated). Tracks all repos in the `jphein` account — last commit, default branch, open PRs/issues, CI status, public/private. Auto-links repos to topology nodes by name match (e.g., `portfolio` repo → `portfolio` node). Also cross-links to local ~/Projects/ directories. Uses a meta-node `github` as the host for all repo SubEntities.

**Key code:**

```python
import subprocess, json

def discover_github(node_id, node_data, host_access, engine):
    """Discover GitHub repos via gh CLI."""
    result = subprocess.run(
        ["gh", "repo", "list", "jphein", "--json",
         "name,description,isPrivate,defaultBranchRef,updatedAt,url",
         "--limit", "100"],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        return []
    repos = json.loads(result.stdout)
    entities = []
    for repo in repos:
        name = repo["name"]
        updated = repo.get("updatedAt", "")
        # Determine activity status
        status = "active"  # TODO: check if >30 days since last update → "stale"
        # Check CI status
        ci_result = subprocess.run(
            ["gh", "run", "list", "--repo", f"jphein/{name}", "--limit", "1",
             "--json", "conclusion,status"],
            capture_output=True, text=True, timeout=10,
        )
        ci_status = "none"
        if ci_result.returncode == 0:
            runs = json.loads(ci_result.stdout)
            if runs:
                ci_status = runs[0].get("conclusion") or runs[0].get("status", "none")
        # Check for local project
        import os
        local_path = f"/home/jp/Projects/{name}"
        has_local = os.path.isdir(local_path)
        has_claude_md = os.path.isfile(os.path.join(local_path, "CLAUDE.md")) if has_local else False
        entities.append(SubEntity(
            id=f"github:jphein:{name}",
            type="github_repo",
            name=name,
            host_node_id="github",
            status=status,
            metadata={
                "url": repo.get("url", ""),
                "private": repo.get("isPrivate", False),
                "description": repo.get("description", ""),
                "default_branch": (repo.get("defaultBranchRef") or {}).get("name", "main"),
                "updated_at": updated,
                "ci_status": ci_status,
                "local_path": local_path if has_local else None,
                "has_claude_md": has_claude_md,
            },
        ))
    return entities
```

**Note on rate limiting:** GitHub API has rate limits. The `gh` CLI handles auth/tokens but still subject to limits. 300s interval keeps us well under. CI status checks add N API calls (one per repo) — consider batching or skipping for less-active repos.

**Entity linking:** Repos link to topology nodes by name. When linked, the node gains CI badge, last commit date, open PRs in its discovery metadata. The `github` meta-node needs to exist in topology (or be auto-created on first run).

- [ ] Step 1: Create `plugins/github/plugin.json`
- [ ] Step 2: Implement `discover_github()` — repo list + CI status
- [ ] Step 3: Register as global discovery provider (runs once, not per-node)
- [ ] Step 4: Add PR/issue count fetching (can batch with repo list query)
- [ ] Step 5: Test — verify repos appear in `/discovery/github`
- [ ] Step 6: Commit

---

## Task 2: Projects Plugin ("The Scholar's Archive")

**Files:** `plugins/projects/plugin.json`, `plugins/projects/plugin.py`

**Description:** Discover local project directories in ~/Projects/. For each directory: git status (clean/dirty), current branch, last commit, remote URL, CLAUDE.md presence, test presence, language/stack detection. Cross-references with GitHub plugin (local → remote) and topology (project → running service). Host node is `forge` (the local machine).

**Key code:**

```python
import os, subprocess

PROJECTS_DIR = os.path.expanduser("~/Projects")

def discover_projects(node_id, node_data, host_access, engine):
    """Discover local projects in ~/Projects/."""
    entities = []
    for name in sorted(os.listdir(PROJECTS_DIR)):
        path = os.path.join(PROJECTS_DIR, name)
        if not os.path.isdir(path):
            continue
        meta = {"path": path}
        # Git info
        git_dir = os.path.join(path, ".git")
        if os.path.isdir(git_dir):
            meta["branch"] = _git(path, "rev-parse --abbrev-ref HEAD")
            meta["last_commit"] = _git(path, "log -1 --format=%aI")
            meta["remote"] = _git(path, "remote get-url origin")
            meta["git_dirty"] = bool(_git(path, "status --porcelain"))
        # Project metadata
        meta["has_claude_md"] = os.path.isfile(os.path.join(path, "CLAUDE.md"))
        meta["has_tests"] = any(os.path.isdir(os.path.join(path, d))
                                for d in ("tests", "test", "__tests__", "spec"))
        meta["stack"] = _detect_stack(path)
        # Cross-link to GitHub
        if meta.get("remote") and "github.com/jphein/" in meta["remote"]:
            repo_name = meta["remote"].rstrip(".git").rsplit("/", 1)[-1]
            meta["github_repo"] = f"github:jphein:{repo_name}"
        # Activity status
        status = "active" if meta.get("git_dirty") else "clean"
        entities.append(SubEntity(
            id=f"project:{name}",
            type="local_project",
            name=name,
            host_node_id="forge",
            status=status,
            metadata=meta,
        ))
    return entities

def _git(path, cmd):
    """Run git command in project dir, return stdout or empty string."""
    try:
        r = subprocess.run(f"git {cmd}", shell=True, cwd=path,
                           capture_output=True, text=True, timeout=5)
        return r.stdout.strip() if r.returncode == 0 else ""
    except: return ""

def _detect_stack(path):
    """Detect project tech stack from marker files."""
    markers = {
        "requirements.txt": "python", "setup.py": "python", "pyproject.toml": "python",
        "package.json": "javascript", "go.mod": "go", "Cargo.toml": "rust",
        "Makefile": "make", "Dockerfile": "docker",
    }
    stack = []
    for fname, lang in markers.items():
        if os.path.isfile(os.path.join(path, fname)) and lang not in stack:
            stack.append(lang)
    return stack
```

- [ ] Step 1: Create `plugins/projects/plugin.json`
- [ ] Step 2: Implement `discover_projects()` — git status, stack detection, cross-links
- [ ] Step 3: Register as global discovery provider (runs locally on forge)
- [ ] Step 4: Test — verify all ~/Projects/ dirs appear in `/discovery/forge`
- [ ] Step 5: Commit

---

## Task 3: Manual Plugin ("The Chronicler's Quill")

**Files:** `plugins/manual/plugin.json`, `plugins/manual/plugin.py`

**Description:** A plugin for declaring static sub-entities, relationships, tags, annotations, and external bookmarks that can't be auto-discovered. Provides CRUD API endpoints. Entries are stored in `sub_entities` table with `provider="manual"`. Supports 5 entry types: static infrastructure, service declarations, relationship declarations, tags/annotations, and external bookmarks.

**Key code — API endpoints:**

```python
def setup(ctx):
    # Register API endpoints
    ctx.register_endpoint("GET", "/discovery/manual", handle_list)
    ctx.register_endpoint("POST", "/discovery/manual", handle_create)
    ctx.register_endpoint("DELETE", "/discovery/manual/<id>", handle_delete)
    ctx.register_endpoint("GET", "/discovery/manual/tags", handle_tags)

def handle_create(request_data):
    """Create or update a manual discovery entry."""
    required = ["id", "type", "name", "host_node_id"]
    for field in required:
        if field not in request_data:
            return {"error": f"Missing field: {field}"}, 400
    # Ensure ID has manual: prefix
    entry_id = request_data["id"]
    if not entry_id.startswith("manual:"):
        entry_id = f"manual:{entry_id}"
    entity = {
        "id": entry_id,
        "type": request_data["type"],
        "name": request_data["name"],
        "host_node_id": request_data["host_node_id"],
        "status": request_data.get("status", "active"),
        "metadata": request_data.get("metadata", {}),
        "provider": "manual",
    }
    realm_db.upsert_sub_entity(entity)
    return {"ok": True, "id": entry_id}

def handle_list():
    """List all manual entries."""
    return realm_db.get_sub_entities(provider="manual")

def handle_tags():
    """List all tags from manual entries."""
    entries = realm_db.get_sub_entities(provider="manual")
    return [e for e in entries if e.get("type") == "tag"]

def handle_delete(entry_id):
    """Delete a manual entry."""
    realm_db.delete_sub_entity(entry_id)
    return {"ok": True}
```

**Seed data:** On first run, create initial manual entries for infrastructure that can't be discovered:
- fiber-gateway (AT&T ONT, no management interface)
- Cloud meta-node (Cloudflare, Vercel, GitHub, Azure parent)
- terra2 game servers (if game-servers plugin isn't configured yet)
- Known relationship declarations (jellyfin → disks dependency, etc.)

- [ ] Step 1: Create `plugins/manual/plugin.json`
- [ ] Step 2: Implement CRUD API endpoints (create, list, delete, tags)
- [ ] Step 3: Add seed data for non-discoverable infrastructure
- [ ] Step 4: Test — create, list, delete manual entries via API
- [ ] Step 5: Commit

---

## What's Next

Phase 6 migrates the WiFi plugin to the discovery provider model — the most complex upgrade because WiFi currently does its own node CRUD. Phase 7 builds the frontend panels.
