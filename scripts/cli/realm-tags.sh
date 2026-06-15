#!/usr/bin/env bash
# realm-tags — manage the `tags` array on topology nodes.
#
# Tags are heuristic-friendly labels stored at node.data.tags. The fantasy
# `label` field is for display only; tags are what plugins and CLI filters
# query against. discover-os auto-populates tags from /etc/os-release.
#
# Conventions:
#   - lowercase, kebab-case (e.g. "ubuntu-24.04", "gpu-host", "autoupdate")
#   - additive: existing tags are preserved unless you use `remove` or `set`
#   - immutable from the user's perspective — auto-populated tags re-appear
#     when `discover-os` re-runs
set -euo pipefail

REALM_HELP_SUMMARY="Manage tags on topology nodes (heuristic-friendly labels)"
REALM_SUBCOMMANDS="list
get
add
remove
set
clear
nodes"

realm::help() {
  cat <<'EOF'
realm tags — manage tags on topology nodes

USAGE:
  realm tags <SUBCOMMAND> [args]

SUBCOMMANDS:
  list                         Show every tag in the realm with counts
  get <node>                   Show tags on one node
  add <node> <tag> [tag ...]   Add tags (preserves existing)
  remove <node> <tag> [tag..]  Remove specific tags
  set <node> <tag> [tag ...]   Replace the entire tag set
  clear <node>                 Remove all tags from a node
  nodes <tag>                  List every node carrying this tag

EXAMPLES:
  realm tags list
  realm tags get familiar
  realm tags add familiar gpu-host autoupdate
  realm tags nodes ubuntu
  realm tags nodes autoupdate

CONVENTIONS:
  Use lowercase, kebab-case. discover-os auto-populates ubuntu, linux,
  ubuntu-24.04, debian-family, apt, etc. Manual tags layer on top.
EOF
  realm::help_flags
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

realm::api_reachable || realm::die_unreachable

sub="${1:-list}"
shift || true

# Helpers — fetch and write the tag array on a node
_get_tags() {
  realm::api_get /topology | jq -r --arg id "$1" '.nodes[] | select(.id == $id) | (.tags // []) | .[]'
}
_set_tags() {
  local id="$1"; shift
  local tags_json
  tags_json=$(printf '%s\n' "$@" | jq -R . | jq -s . -c)
  local body
  body=$(jq -n --arg id "$id" --argjson tags "$tags_json" '{id:$id, tags:$tags}')
  realm::api_post /node "$body" >/dev/null
}

case "$sub" in
  list)
    realm::api_get /topology \
      | jq -r '.nodes[] | (.tags // []) | .[]' \
      | sort | uniq -c | sort -rn \
      | awk '{printf "  %-5s %s\n", $1, $2}'
    ;;
  get)
    [[ $# -ge 1 ]] || realm::die "usage: realm tags get <node>" 2
    if [[ "$REALM_OUTPUT" = "json" ]]; then
      realm::api_get /topology | jq --arg id "$1" '.nodes[] | select(.id == $id) | (.tags // [])'
    else
      _get_tags "$1" | sed 's/^/  /'
    fi
    ;;
  add)
    [[ $# -ge 2 ]] || realm::die "usage: realm tags add <node> <tag> [tag...]" 2
    id="$1"; shift
    declare -a existing=()
    while IFS= read -r t; do [[ -n "$t" ]] && existing+=("$t"); done < <(_get_tags "$id")
    # Union (dedup)
    declare -A seen=()
    declare -a merged=()
    for t in "${existing[@]}" "$@"; do
      [[ -n "${seen[$t]:-}" ]] && continue
      seen[$t]=1; merged+=("$t")
    done
    _set_tags "$id" "${merged[@]}"
    realm::say "$id now has ${#merged[@]} tags: ${merged[*]}"
    ;;
  remove)
    [[ $# -ge 2 ]] || realm::die "usage: realm tags remove <node> <tag> [tag...]" 2
    id="$1"; shift
    declare -a kept=()
    while IFS= read -r t; do
      keep=1
      for r in "$@"; do [[ "$t" = "$r" ]] && keep=0 && break; done
      [[ $keep -eq 1 && -n "$t" ]] && kept+=("$t")
    done < <(_get_tags "$id")
    if [[ ${#kept[@]} -eq 0 ]]; then
      _set_tags "$id"  # empty → clears
    else
      _set_tags "$id" "${kept[@]}"
    fi
    realm::say "$id now has ${#kept[@]} tag(s)"
    ;;
  set)
    [[ $# -ge 2 ]] || realm::die "usage: realm tags set <node> <tag> [tag...]" 2
    id="$1"; shift
    _set_tags "$id" "$@"
    realm::say "$id tags replaced: $*"
    ;;
  clear)
    [[ $# -ge 1 ]] || realm::die "usage: realm tags clear <node>" 2
    _set_tags "$1"
    realm::say "$1 tags cleared"
    ;;
  nodes)
    [[ $# -ge 1 ]] || realm::die "usage: realm tags nodes <tag>" 2
    realm::api_get /topology \
      | jq -r --arg tag "$1" '
          .nodes[]
          | select(((.tags // []) | index($tag)) != null)
          | [.id, (.ip // "-"), (.label // "-")]
          | @tsv
        ' \
      | (echo -e "ID\tIP\tLABEL"; cat) | column -t -s$'\t'
    ;;
  *)
    realm::die "unknown subcommand: $sub" 2
    ;;
esac
