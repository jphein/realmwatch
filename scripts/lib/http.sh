# scripts/lib/http.sh
#
# Thin curl wrapper for the realm HTTP API. Provides consistent error
# semantics, dry-run support, and SSE streaming.
#
# All functions write the response body to stdout and informational/error
# chatter to stderr. Exit codes follow the realm CLI convention:
#   0  success
#   3  network / connection refused / DNS error
#   4  auth / 401/403
#   5  server-side error (5xx)
#   22 client error (4xx other than 401/403)
#
# Requires curl. jq is required only when REALM_OUTPUT=human and the caller
# formats responses through output.sh.

realm::_curl_base() {
  if [[ -n "${REALM_VERBOSE:-}" ]]; then
    printf '%s+ curl%s %s\n' "$C" "$N" "$*" >&2
  fi
  # --silent --show-error: quiet but still report errors on stderr
  # --fail-with-body: non-2xx exits non-zero, but body still prints
  # --max-time: hard cap so a hung server can't wedge the CLI
  curl --silent --show-error --fail-with-body --max-time 30 "$@"
}

# realm::_status_to_exit — translates curl exit + http status into realm exit codes
realm::_status_to_exit() {
  local curl_exit="$1"
  local http_status="${2:-0}"
  case "$curl_exit" in
    0) return 0 ;;
    6|7) return 3 ;;       # CURL_COULDNT_RESOLVE_HOST, CURL_COULDNT_CONNECT
    28) return 3 ;;        # operation timeout
    52) return 5 ;;        # empty reply from server (server crashed mid-response)
    22)
      if [[ "$http_status" =~ ^4 ]]; then
        [[ "$http_status" == 401 || "$http_status" == 403 ]] && return 4
        return 22
      elif [[ "$http_status" =~ ^5 ]]; then
        return 5
      fi
      return 1
      ;;
    *) return 1 ;;
  esac
}

# Internal: capture body to a tempfile and rm it before returning. No traps —
# traps survive across function calls and tripped set -u on tmp's locality.
realm::_run() {
  local method="$1"; shift
  local url="$1"; shift
  local body="${1:-}"

  if [[ -n "${REALM_DRY_RUN:-}" ]]; then
    printf 'DRY-RUN: %s %s\n' "$method" "$url" >&2
    [[ -n "$body" && "$method" != "GET" && "$method" != "DELETE" ]] \
      && printf '  body: %s\n' "$body" >&2
    return 0
  fi

  local tmp
  tmp=$(mktemp)
  local http_status curl_exit=0

  case "$method" in
    GET)
      http_status=$(realm::_curl_base -o "$tmp" -w '%{http_code}' "$url") || curl_exit=$?
      ;;
    POST)
      http_status=$(realm::_curl_base \
        -H 'Content-Type: application/json' \
        -X POST --data "$body" \
        -o "$tmp" -w '%{http_code}' "$url") || curl_exit=$?
      ;;
    PUT)
      http_status=$(realm::_curl_base \
        -H 'Content-Type: application/json' \
        -X PUT --data "$body" \
        -o "$tmp" -w '%{http_code}' "$url") || curl_exit=$?
      ;;
    DELETE)
      http_status=$(realm::_curl_base -X DELETE -o "$tmp" -w '%{http_code}' "$url") || curl_exit=$?
      ;;
    *)
      rm -f "$tmp"
      echo "realm::_run: unsupported method $method" >&2
      return 2
      ;;
  esac

  cat "$tmp"
  rm -f "$tmp"

  realm::_status_to_exit "$curl_exit" "$http_status"
}

# realm::api_get PATH [QUERY]
realm::api_get() {
  local path="$1"
  local query="${2:-}"
  realm::_run GET "${REALM_API}${path}${query}"
}

# realm::api_post PATH JSON_BODY
realm::api_post() {
  realm::_run POST "${REALM_API}${1}" "${2:-}"
}

# realm::api_put PATH JSON_BODY
realm::api_put() {
  realm::_run PUT "${REALM_API}${1}" "${2:-}"
}

# realm::api_delete PATH [QUERY]
realm::api_delete() {
  realm::_run DELETE "${REALM_API}${1}${2:-}"
}

# realm::api_sse PATH — streams an SSE endpoint line-by-line to stdout.
realm::api_sse() {
  local path="$1"
  local url="${REALM_API}${path}"

  if [[ -n "${REALM_DRY_RUN:-}" ]]; then
    printf 'DRY-RUN: SSE %s\n' "$url" >&2
    return 0
  fi

  # --no-buffer keeps SSE events flowing immediately
  curl --silent --show-error --no-buffer \
    -H 'Accept: text/event-stream' \
    "$url"
}

# realm::api_reachable — true if the realm server responds to /server-info
realm::api_reachable() {
  curl --silent --fail --max-time 2 \
    -o /dev/null \
    "${REALM_API}/server-info" 2>/dev/null
}

# realm::die_unreachable — friendly error when realm host is down
realm::die_unreachable() {
  printf '%s✘ realm:%s cannot reach %s (connection refused or timeout)\n' "$R" "$N" "$REALM_API" >&2
  printf '  Is map_server.py running? Try: %srealm health%s\n' "$C" "$N" >&2
  exit 3
}
