"""Bidirectional sync between the game DB's codex_entries table and the
realmwatch HTML codex (docs/codex/*.md + build_codex.py).

Game DB codex: ~/.realmwatch/game.db codex_entries (owned by this plugin)
HTML codex:    <realmwatch>/docs/codex/*.md + build_codex.py

Ported from os.realm.watch/servers/shared/codex_sync_bridge.py.

NOTE: This is OFFLINE TOOLING (CLI). It is intentionally NOT registered as
a setup-time hook in the plugin — the realmwatch-side codex_sync.py
(repo root) handles the live Notion -> codex sync used by /codex-sync.
This bridge is a manual operator tool for round-tripping content between
the markdown wiki and the game DB.

Usage (from realmwatch repo root):
    python -m plugins.codex.codex_sync_bridge            # full bidirectional
    python -m plugins.codex.codex_sync_bridge --import   # HTML -> game DB
    python -m plugins.codex.codex_sync_bridge --export   # game DB -> HTML
"""
from __future__ import annotations

import os
import re
import sqlite3
import sys
from pathlib import Path

# Realmwatch repo root: <repo>/plugins/codex/codex_sync_bridge.py -> parent x3
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
REALMWATCH_CODEX = str(_REPO_ROOT / "docs" / "codex")
DB_PATH = os.path.expanduser("~/.realmwatch/game.db")

# Map HTML codex categories to game-DB categories
HTML_TO_DB_CATEGORY = {
    "lore": "lore",
    "guardians": "nodes",
    "wards": "wards",
    "artifacts": "artifacts",
    "services": "services",
    "spellbook": "spellbook",
    "protocols": "protocols",
    "bestiary": "bestiary",
    "prophecies": "prophecies",
    "songs": "songs",
}


def parse_markdown(filepath: str) -> dict:
    """Parse a codex markdown file into structured fields."""
    with open(filepath) as f:
        text = f.read()

    # Strip YAML frontmatter
    if text.startswith("---"):
        end = text.find("---", 3)
        if end != -1:
            text = text[end + 3:].lstrip("\n")

    # Extract H2 title
    title_match = re.search(r"^##\s+(.+)", text, re.MULTILINE)
    fantasy_name = (title_match.group(1).strip() if title_match else
                    os.path.basename(filepath).replace(".md", "").replace("-", " ").title())

    parts = re.split(r"\n---+\n", text)

    lore_text = ""
    if len(parts) >= 2:
        lore_text = parts[1].strip()
    elif len(parts) == 1:
        lines = text.split("\n")
        lore_lines = []
        past_title = False
        for line in lines:
            if line.startswith("## "):
                past_title = True
                continue
            if past_title:
                lore_lines.append(line)
        lore_text = "\n".join(lore_lines).strip()

    technical_text = ""
    if len(parts) >= 3:
        technical_text = parts[-1].strip()

    summary_match = re.match(r"(.+?)(?:\n\n|\Z)", lore_text, re.DOTALL)
    summary = summary_match.group(1).strip()[:300] if summary_match else fantasy_name
    summary = re.sub(r"\*+([^*]+)\*+", r"\1", summary)
    summary = re.sub(r"`([^`]+)`", r"\1", summary)

    return {
        "fantasy_name": fantasy_name,
        "summary": summary,
        "lore_text": lore_text,
        "technical_text": technical_text,
    }


def import_html_to_db() -> int:
    """Import HTML codex markdown entries into the game DB."""
    if not os.path.isdir(REALMWATCH_CODEX):
        print(f"HTML codex not found at {REALMWATCH_CODEX}")
        return 0

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    existing = {r["codex_id"] for r in
                conn.execute("SELECT codex_id FROM codex_entries").fetchall()}

    build_script = os.path.join(REALMWATCH_CODEX, "build_codex.py")
    stem_to_category: dict[str, str] = {}
    if os.path.isfile(build_script):
        with open(build_script) as f:
            content = f.read()
        for m in re.finditer(r'\("([\w-]+)",\s*"[^"]+",\s*\[(.*?)\]\)', content, re.DOTALL):
            cat_id = m.group(1)
            stems = re.findall(r'"([^"]+)"', m.group(2))
            for stem in stems:
                stem_to_category[stem] = cat_id

    imported = 0
    for fname in sorted(os.listdir(REALMWATCH_CODEX)):
        if not fname.endswith(".md"):
            continue
        stem = fname[:-3]
        codex_id = stem
        if codex_id in existing:
            continue

        filepath = os.path.join(REALMWATCH_CODEX, fname)
        parsed = parse_markdown(filepath)

        html_cat = stem_to_category.get(stem, "uncategorized")
        db_cat = HTML_TO_DB_CATEGORY.get(html_cat, html_cat)

        conn.execute(
            """INSERT OR IGNORE INTO codex_entries
            (codex_id, category, fantasy_name, technical_name, summary, lore_text, technical_text, schema_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)""",
            (codex_id, db_cat, parsed["fantasy_name"], parsed["fantasy_name"],
             parsed["summary"], parsed["lore_text"],
             parsed["technical_text"] or None),
        )
        if conn.total_changes:
            imported += 1
            print(f"  Imported: {codex_id} -> {db_cat}")

    conn.commit()
    conn.close()
    return imported


def export_db_to_html() -> int:
    """Export game-DB codex entries as markdown files for the HTML codex."""
    if not os.path.isdir(REALMWATCH_CODEX):
        print(f"HTML codex directory not found at {REALMWATCH_CODEX}")
        return 0

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    existing_stems = {f[:-3] for f in os.listdir(REALMWATCH_CODEX)
                      if f.endswith(".md")}
    rows = conn.execute(
        "SELECT * FROM codex_entries ORDER BY category, codex_id"
    ).fetchall()
    conn.close()

    exported = 0
    for row in rows:
        codex_id = row["codex_id"]
        if codex_id in existing_stems:
            continue

        md = f"## {row['fantasy_name']}"
        if row["technical_name"] and row["technical_name"] != row["fantasy_name"]:
            md += f"\n\n*{row['technical_name']}*"
        md += "\n\n---\n\n"
        if row["lore_text"]:
            md += row["lore_text"]
        else:
            md += row["summary"]
        if row["technical_text"]:
            md += "\n\n---\n\n"
            md += row["technical_text"]
        md += "\n"

        filepath = os.path.join(REALMWATCH_CODEX, f"{codex_id}.md")
        with open(filepath, "w") as f:
            f.write(md)
        exported += 1
        print(f"  Exported: {codex_id}.md ({row['category']})")

    return exported


def main() -> None:
    args = set(sys.argv[1:])
    do_import = "--import" in args or not args
    do_export = "--export" in args or not args

    print("=== Codex Sync Bridge (plugin tool) ===\n")

    if do_import:
        print("-> Importing HTML codex -> game DB...")
        n = import_html_to_db()
        print(f"  {n} entries imported\n")

    if do_export:
        print("-> Exporting game DB -> HTML markdown...")
        n = export_db_to_html()
        print(f"  {n} entries exported\n")

    conn = sqlite3.connect(DB_PATH)
    total = conn.execute("SELECT COUNT(*) FROM codex_entries").fetchone()[0]
    filled = conn.execute(
        "SELECT COUNT(*) FROM codex_entries WHERE lore_text IS NOT NULL"
    ).fetchone()[0]
    cats = conn.execute(
        "SELECT COUNT(DISTINCT category) FROM codex_entries"
    ).fetchone()[0]
    conn.close()

    md_count = len([f for f in os.listdir(REALMWATCH_CODEX)
                    if f.endswith(".md")])

    print(f"\n=== Sync Complete ===")
    print(f"  Game DB codex: {total} entries ({filled} with lore), {cats} categories")
    print(f"  HTML codex:    {md_count} markdown files")


if __name__ == "__main__":
    main()
