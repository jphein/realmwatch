#!/usr/bin/env bash
# realm-os — instant OS inventory from the STORED topology (no SSH).
#
# Reads the os / os_version / os_pretty fields already persisted on each
# topology node (written by `realm discover-os`) and prints a deduped
# inventory of distinct machines. Pure `/topology` read — instant, safe,
# read-only. For the slow SSH re-probe that *populates* those fields, see
# the companion `realm discover-os`.
#
# Why dedupe? Raw node records over-count: co-located service sub-entities
# share one host IP (e.g. immich/jellyfin/navidrome/syncthing all live on
# 10.0.6.120 — one Ubuntu box). We group by IP so the count reflects real
# machines, list the co-located members under each host, and optionally fold
# Tailscale aliases (100.64.0.0/10) onto their LAN host when os+version match.
#
# USAGE:
#   realm os                  # table: host, ip, os, version (all known)
#   realm os --filter ubuntu  # only that OS (positional `realm os ubuntu` too)
#   realm os --json           # structured per-host records
#
# Exit codes: 0 ok · 2 usage · 3 realm unreachable (see CLI contract).

set -euo pipefail

REALM_HELP_SUMMARY="Instant OS inventory from stored topology (no SSH), deduped by host"

realm::help() {
  cat <<'EOF'
realm os — instant OS inventory from stored topology (no SSH)

USAGE:
  realm os [OPTIONS] [OS]

OPTIONS:
  --filter OS    Only hosts whose OS matches (case-insensitive substring).
                 May also be given positionally: `realm os ubuntu`.
  --json         Machine-readable per-host JSON records.
  -h, --help     Show this help.

OUTPUT (human):
  HOST  IP  OS  VERSION  MEMBERS
  MEMBERS lists co-located service sub-entities sharing the host IP, plus any
  folded Tailscale alias IPs (ts:100.x). "-" means a standalone host.

DEDUPE:
  Nodes are grouped by IP so co-located services count as ONE machine.
  Tailscale aliases (100.64.0.0/10) fold onto a LAN host with the same
  os + os_version. Reads stored fields only — run `realm discover-os` first
  to populate them.

EXAMPLES:
  realm os                       # every host with a known OS
  realm os --filter ubuntu       # distinct Ubuntu machines (deduped)
  realm os ubuntu                # same, positional form
  realm os --json | jq 'length'  # count distinct machines
EOF
}

source "$(dirname "${BASH_SOURCE[0]}")/../lib/realm-cli.sh"
realm::parse_common "$@"
set -- "${REALM_POSARGS[@]+"${REALM_POSARGS[@]}"}"

# ─── parse subcommand-specific flags ─────────────────────────────
FILTER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --filter)    [[ $# -ge 2 ]] || realm::die "--filter requires a value" 2; FILTER="$2"; shift 2 ;;
    --filter=*)  FILTER="${1#*=}"; shift ;;
    -*)          realm::die "unknown option: $1 (try: realm os --help)" 2 ;;
    *)           # positional OS filter: `realm os ubuntu`
                 [[ -z "$FILTER" ]] || realm::die "unexpected argument: $1" 2
                 FILTER="$1"; shift ;;
  esac
done

realm::api_reachable || realm::die_unreachable

# ─── dedupe pipeline (pure jq) ───────────────────────────────────
# Group os-known nodes by IP (falling back to id when an IP is absent),
# then fold Tailscale aliases onto a matching LAN host.
REALM_OS_JQ='
  # 100.64.0.0/10 → first octet 100, second octet 64-127
  def is_tailnet($ip):
    ($ip | test("^100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\."));

  [ .nodes[]?
    | select((.os // "") != "")
    | { id,
        ip:         (.ip // ""),
        os:         (.os // ""),
        os_version: (.os_version // ""),
        os_pretty:  (.os_pretty // (.os // "")),
        key:        (if (.ip // "") != "" then (.ip) else (.id) end) }
  ]
  # one record per distinct host key
  | group_by(.key)
  | map({
      ip:         (.[0].ip),
      os:         (.[0].os),
      os_version: (.[0].os_version),
      os_pretty:  (.[0].os_pretty),
      members:    (map(.id) | unique),
      host:       (map(.id) | sort | .[0]),
      tailnet:    (is_tailnet(.[0].ip))
    })
  | . as $all
  | ($all | map(select(.tailnet | not)) | map(. + {tailscale_aliases: []})) as $lan
  | ($all | map(select(.tailnet)))                                          as $ts
  # fold each tailnet host onto a LAN host with the same os + version;
  # otherwise keep it as a standalone machine.
  | reduce $ts[] as $t ($lan;
      ( [ range(0; length) as $i
          | select(.[$i].os == $t.os and .[$i].os_version == $t.os_version)
          | $i ] | .[0] ) as $idx
      | if $idx == null
        then . + [ $t + {tailscale_aliases: []} ]
        else .[0:$idx]
             + [ .[$idx] + {
                   tailscale_aliases: (.[$idx].tailscale_aliases + [$t.ip] | unique),
                   members:           (.[$idx].members + $t.members | unique)
                 } ]
             + .[$idx+1:]
        end
    )
  | map(del(.tailnet))
  # apply --filter (case-insensitive substring over os and os_pretty)
  | map(select(
      ($filt | length) == 0
      or (.os        | ascii_downcase | contains($filt | ascii_downcase))
      or (.os_pretty | ascii_downcase | contains($filt | ascii_downcase))
    ))
  | sort_by(.os, .ip)
'

tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
realm::api_get /topology \
  | jq --arg filt "$FILTER" "$REALM_OS_JQ" > "$tmp"

# ─── output ──────────────────────────────────────────────────────
if [[ "$REALM_OUTPUT" = "json" ]]; then
  cat "$tmp"
  exit 0
fi

count=$(jq -r 'length' "$tmp")
if [[ "$count" -eq 0 ]]; then
  if [[ -n "$FILTER" ]]; then
    realm::warn "no hosts with a known OS matching '$FILTER'"
  else
    realm::warn "no hosts have a stored OS yet — run: realm discover-os"
  fi
  exit 0
fi

jq -r '
  (["HOST","IP","OS","VERSION","MEMBERS"] | @tsv),
  (.[] | .host as $h | [
     $h,
     (.ip | if . == "" then "-" else . end),
     .os,
     (if (.os_version // "") == "" then "-" else .os_version end),
     ( ( (.members | map(select(. != $h)))
         + ((.tailscale_aliases // []) | map("ts:" + .)) ) as $extra
       | if ($extra | length) > 0 then ($extra | join(",")) else "-" end )
   ] | @tsv)
' "$tmp" | column -t -s $'\t'

realm::say "$count distinct host(s) with a known OS"
exit 0
