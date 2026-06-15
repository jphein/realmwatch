#!/usr/bin/env bash
# realm-role — browse the role registry and templates.
#
# Roles are how realmwatch generalizes "this kind of host." Each role bundles:
#   - icon, color, title, description (display)
#   - sources, stats (where to pull metrics from)
#   - template.alert_rules        — rules that apply to hosts of this role
#   - template.discovery_providers — which scanners run on this role
#   - template.default_tags       — tags auto-attached
#   - template.sublabel_format    — SVG map sublabel format
#
# The role is determined by node_roles.get_role() which checks (in order):
#   1. node.data._role (explicit override)
#   2. node.data.os (set by realm discover-os)
#   3. node_id pattern heuristics
#   4. MAC/OUI lookups
#   5. node.data.type + VLAN

set -euo pipefail

REALM_HELP_SUMMARY="Browse role registry: list, show templates, list nodes per role"
REALM_SUBCOMMANDS="list
show
nodes
template
of"

realm::help() {
  cat <<'EOF'
realm role — browse the role registry

USAGE:
  realm role <SUBCOMMAND> [args]

SUBCOMMANDS:
  list             Every role with its node count
  show <name>      Full info for one role (display + template + member nodes)
  nodes <name>    Member nodes of a given role
  template <name>  Just the template block (alert_rules, discovery_providers, ...)
  of <node>        Which role a given node has + why

EXAMPLES:
  realm role list
  realm role show server
  realm role nodes router
  realm role template server
  realm role of familiar           # show role + reasoning
EOF
  realm::help_flags
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

realm::api_reachable || realm::die_unreachable

sub="${1:-list}"
shift || true

case "$sub" in
  list)
    realm::api_get /roles \
      | realm::fmt_table '
          (["ROLE","NODES","TITLE","HAS_TEMPLATE"] | @tsv),
          (to_entries | sort_by(-(.value.node_count // 0)) | .[]
            | [
                .key,
                ((.value.node_count // 0) | tostring),
                (.value.title // "-"),
                (if .value.template then "yes" else "-" end)
              ] | @tsv)
        '
    ;;
  show)
    [[ $# -ge 1 ]] || realm::die "usage: realm role show <name>" 2
    if [[ "$REALM_OUTPUT" = "json" ]]; then
      realm::api_get "/roles/$1"
    else
      response=$(realm::api_get "/roles/$1")
      if printf '%s' "$response" | jq -e '.error' >/dev/null 2>&1; then
        realm::die "$(printf '%s' "$response" | jq -r '.error')" 4
      fi
      printf '%s' "$response" | jq -r '
        "Role:     \(.name // "-")",
        "Title:    \(.title // "-")",
        "Icon:     \(.icon // "-")",
        "Desc:     \(.desc // "-")",
        "Sources:  \((.sources // []) | join(", "))",
        "Stats:    \((.stats // []) | join(", "))",
        "",
        "Template:",
        (if .template then
          "  alert_rules:         \((.template.alert_rules // []) | join(", "))",
          "  discovery_providers: \((.template.discovery_providers // []) | join(", "))",
          "  default_tags:        \((.template.default_tags // []) | join(", "))",
          "  sublabel_format:     \(.template.sublabel_format // "(none)")"
        else
          "  (no template defined)"
        end),
        "",
        "Member nodes (\(.node_count // 0)):",
        ((.nodes // [])[] | "  - \(.)")
      '
    fi
    ;;
  nodes)
    [[ $# -ge 1 ]] || realm::die "usage: realm role nodes <name>" 2
    realm::api_get "/roles/$1" | jq -r '
      if .error then "Error: \(.error)"
      else (.nodes // [])[]
      end'
    ;;
  template)
    [[ $# -ge 1 ]] || realm::die "usage: realm role template <name>" 2
    response=$(realm::api_get "/roles/$1")
    if [[ "$REALM_OUTPUT" = "json" ]]; then
      printf '%s' "$response" | jq '.template // {}'
    else
      printf '%s' "$response" | jq -r '
        if .error then "Error: \(.error)"
        else
          (.template // {} | to_entries[] | "\(.key)\t\(.value | tostring)")
        end' | column -t -s$'\t'
    fi
    ;;
  of)
    [[ $# -ge 1 ]] || realm::die "usage: realm role of <node>" 2
    node="$1"
    # Get the node data for the explanation block
    node_data=$(realm::api_get /topology | jq --arg id "$node" '.nodes[] | select(.id == $id)')
    if [[ -z "$node_data" || "$node_data" = "null" ]]; then
      realm::die "no such node: $node" 4
    fi
    # Ask /roles which role owns this node — single jq call, no shell loop
    role=$(realm::api_get /roles \
      | jq -r --arg node "$node" '
          to_entries[]
          | select((.value.nodes // []) | index($node))
          | .key' \
      | head -1)
    [[ -z "$role" ]] && role="unknown"

    printf 'Node:    %s\n' "$node"
    printf 'Role:    %s\n\n' "$role"
    printf 'Why this role:\n'
    explicit_role=$(printf '%s' "$node_data" | jq -r '._role // empty')
    explicit_os=$(printf '%s' "$node_data" | jq -r '.os // empty')
    node_type=$(printf '%s' "$node_data" | jq -r '.type // "?"')
    node_label=$(printf '%s' "$node_data" | jq -r '.label // "?"')
    if [[ -n "$explicit_role" ]]; then
      printf '  - explicit _role field: %s\n' "$explicit_role"
    elif [[ -n "$explicit_os" ]]; then
      printf '  - os field set to: %s (mapped via node_roles.get_role)\n' "$explicit_os"
    else
      printf '  - inferred from id/label/type/MAC heuristics\n'
    fi
    printf '  - type: %s, label: %s\n\n' "$node_type" "$node_label"
    printf 'Template binds:\n'
    realm::api_get "/roles/$role" | jq -r '
      .template // {} |
      "  alert_rules:         \((.alert_rules // []) | join(", "))",
      "  discovery_providers: \((.discovery_providers // []) | join(", "))",
      "  default_tags:        \((.default_tags // []) | join(", "))"
    '
    ;;
  *)
    realm::die "unknown subcommand: $sub" 2
    ;;
esac
