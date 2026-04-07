"""Projects discovery plugin — The Scholar's Archive.

Discovers local project directories in ~/Projects/. Tracks git status,
branch, last commit, tech stack, and cross-links to GitHub.
"""

import logging
import os
import subprocess

from discovery_engine import SubEntity

log = logging.getLogger(__name__)

PROJECTS_DIR = os.path.expanduser("~/Projects")

_STACK_MARKERS = {
    "requirements.txt": "python", "setup.py": "python", "pyproject.toml": "python",
    "package.json": "javascript", "go.mod": "go", "Cargo.toml": "rust",
    "Makefile": "make", "Dockerfile": "docker", "docker-compose.yml": "docker",
    "Gemfile": "ruby", "pom.xml": "java",
}


def _git(path, cmd):
    """Run git command in project dir, return stdout or empty string."""
    try:
        r = subprocess.run(
            ["git"] + cmd.split(), cwd=path,
            capture_output=True, text=True, timeout=5
        )
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""


def _detect_stack(path):
    """Detect project tech stack from marker files."""
    stack = []
    for fname, lang in _STACK_MARKERS.items():
        if os.path.isfile(os.path.join(path, fname)) and lang not in stack:
            stack.append(lang)
    return stack


def discover_projects(node_id, node_data, host_access, engine):
    """Discover local projects in ~/Projects/."""
    if not os.path.isdir(PROJECTS_DIR):
        return []

    entities = []
    for name in sorted(os.listdir(PROJECTS_DIR)):
        path = os.path.join(PROJECTS_DIR, name)
        if not os.path.isdir(path):
            continue
        # Skip hidden directories
        if name.startswith("."):
            continue

        meta = {"path": path}

        # Git info
        git_dir = os.path.join(path, ".git")
        is_git = os.path.isdir(git_dir)
        if is_git:
            meta["branch"] = _git(path, "rev-parse --abbrev-ref HEAD")
            meta["last_commit"] = _git(path, "log -1 --format=%aI")
            meta["last_commit_msg"] = _git(path, "log -1 --format=%s")
            meta["remote"] = _git(path, "remote get-url origin")
            dirty = _git(path, "status --porcelain")
            meta["git_dirty"] = bool(dirty)
            meta["is_git"] = True
        else:
            meta["is_git"] = False

        # Project metadata
        meta["has_claude_md"] = os.path.isfile(os.path.join(path, "CLAUDE.md"))
        meta["has_tests"] = any(
            os.path.isdir(os.path.join(path, d))
            for d in ("tests", "test", "__tests__", "spec")
        )
        meta["stack"] = _detect_stack(path)

        # Cross-link to GitHub
        remote = meta.get("remote", "")
        if remote and "github.com/jphein/" in remote:
            repo_name = remote.rstrip(".git").rsplit("/", 1)[-1]
            meta["github_repo"] = f"github:jphein:{repo_name}"

        # Activity status
        if meta.get("git_dirty"):
            status = "active"
        elif is_git:
            status = "clean"
        else:
            status = "unknown"

        entities.append(SubEntity(
            id=f"project:{name}",
            type="local_project",
            name=name,
            host_node_id="forge",
            status=status,
            metadata=meta,
        ))

    return entities


def setup(ctx):
    ctx.register_discovery_provider(
        name="projects",
        roles=[],  # global provider — scans local filesystem
        discover_fn=discover_projects,
        interval=120,
        entity_types=["local_project"],
        priority=62,
    )
    ctx.log("The Scholar's Archive active — local project discovery registered (interval=120s)")
