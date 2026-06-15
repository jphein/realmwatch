#!/usr/bin/env bash
# realm-quest — manage realm quests
set -euo pipefail

REALM_HELP_SUMMARY="List, create, update, complete, or delete quests"
realm::help() {
  cat <<'EOF'
realm quest — manage realm quests

USAGE:
  realm quest <SUBCOMMAND> [args]

SUBCOMMANDS:
  list                   List all quests
  show <id>              Show a single quest by id
  create <name> [text]   Create a new quest
  update <id> <field> <value>   Update one field on an existing quest
  complete <id>          Mark a quest complete
  delete <id>            Delete a quest

EXAMPLES:
  realm quest list
  realm quest create "Patrol the realm" "Check on every host"
  realm quest complete q-42
  realm quest list --json | jq '.[] | select(.status == "active")'
EOF
  realm::help_flags
}

REALM_SUBCOMMANDS="list
show
create
update
complete
delete"

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

realm::api_reachable || realm::die_unreachable

sub="${1:-list}"
shift || true

case "$sub" in
  list)
    # `/quests` now returns rows from game.db (quest-forge schema) with
    # `.title` as the human-facing field. Fall back to `.name` to keep
    # the legacy realm.db row shape working during any transition.
    realm::api_get /quests \
      | realm::fmt_table '
          (["ID","NAME","STATUS","XP"] | @tsv),
          (.[] | [.id, .title // .name // "-", .status // "-", ((.rewards.xp // .xp // 0) | tostring)] | @tsv)
        '
    ;;
  show)
    [[ $# -ge 1 ]] || realm::die "missing quest id" 2
    realm::api_get "/quests" | jq -r --arg id "$1" '.[] | select(.id == $id) // empty' \
      | if [[ "$REALM_OUTPUT" = "json" ]]; then cat; else realm::fmt_kv; fi
    ;;
  create)
    [[ $# -ge 1 ]] || realm::die "missing quest name" 2
    name="$1"; text="${2:-}"
    # game.db quests expect `title` + `description`; keep the legacy `name`/
    # `text` keys around so realm.db-backed flows keep working too.
    body=$(jq -n --arg name "$name" --arg text "$text" \
      '{name:$name, text:$text, title:$name, description:$text}')
    realm::api_post /quest-create "$body" \
      | if [[ "$REALM_OUTPUT" = "json" ]]; then cat; else realm::fmt_kv; fi
    ;;
  update)
    [[ $# -ge 3 ]] || realm::die "usage: realm quest update <id> <field> <value>" 2
    id="$1"; field="$2"; value="$3"
    body=$(jq -n --arg id "$id" --arg f "$field" --arg v "$value" '{id:$id} + {($f): $v}')
    realm::api_post /quest-update "$body"
    ;;
  complete)
    [[ $# -ge 1 ]] || realm::die "missing quest id" 2
    body=$(jq -n --arg id "$1" '{id:$id, status:"complete"}')
    realm::api_post /quest-update "$body"
    ;;
  delete)
    [[ $# -ge 1 ]] || realm::die "missing quest id" 2
    body=$(jq -n --arg id "$1" '{id:$id}')
    realm::api_post /quest-delete "$body"
    ;;
  *)
    realm::die "unknown subcommand: $sub" 2
    ;;
esac
