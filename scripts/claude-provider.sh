#!/usr/bin/env bash
# Switch Claude Code between API providers by setting environment variables.
#
# Usage (MUST be sourced, not executed):
#   source scripts/claude-provider.sh bedrock   # Amazon Bedrock (Opus 4.6, us-west-1)
#   source scripts/claude-provider.sh vertex    # Google Vertex AI (Opus 4.6)
#   source scripts/claude-provider.sh direct    # Direct Anthropic API (ANTHROPIC_API_KEY)
#   source scripts/claude-provider.sh           # show current provider
#
# Description:
#   Clears all provider env vars, then sets the appropriate ones for the chosen
#   provider. Must be sourced (not executed) so that `export` affects the current
#   shell session where you'll run `claude`.
#
# Provider env vars:
#   bedrock: CLAUDE_CODE_USE_BEDROCK=1, AWS_REGION=us-west-1
#   vertex:  CLAUDE_CODE_USE_VERTEX=1, CLOUD_ML_REGION=us-west1,
#            ANTHROPIC_VERTEX_PROJECT_ID (auto-read from gcloud config)
#   direct:  only ANTHROPIC_DEFAULT_OPUS_MODEL (requires ANTHROPIC_API_KEY in env)
#
# Setup scripts: scripts/setup-bedrock.sh, scripts/setup-vertex.sh

PROVIDER="${1:-}"

if [ -z "$PROVIDER" ]; then
  echo "Claude Code Provider Switcher"
  echo ""
  echo "  Current:"
  [ "${CLAUDE_CODE_USE_BEDROCK:-}" = "1" ] && echo "    → Amazon Bedrock (us-west-1)"
  [ "${CLAUDE_CODE_USE_VERTEX:-}" = "1" ] && echo "    → Google Vertex AI"
  [ -z "${CLAUDE_CODE_USE_BEDROCK:-}${CLAUDE_CODE_USE_VERTEX:-}" ] && echo "    → Direct Anthropic API"
  echo ""
  echo "  Usage: source $0 [bedrock|vertex|direct]"
  echo ""
  echo "  bedrock  — AWS Bedrock (Opus 4.6, us-west-1)"
  echo "  vertex   — Google Vertex AI (Opus 4.6)"
  echo "  direct   — Direct Anthropic API (uses ANTHROPIC_API_KEY)"
  return 0 2>/dev/null || exit 0
fi

# Clear all provider vars first
unset CLAUDE_CODE_USE_BEDROCK
unset CLAUDE_CODE_USE_VERTEX
unset AWS_REGION
unset ANTHROPIC_VERTEX_PROJECT_ID
unset CLOUD_ML_REGION

case "$PROVIDER" in
  bedrock)
    export CLAUDE_CODE_USE_BEDROCK=1
    export AWS_REGION="us-west-1"
    export ANTHROPIC_DEFAULT_OPUS_MODEL='us.anthropic.claude-opus-4-6-v1'
    echo "→ Switched to Amazon Bedrock (us-west-1)"
    echo "  Run: claude"
    ;;
  vertex)
    export CLAUDE_CODE_USE_VERTEX=1
    export CLOUD_ML_REGION="us-west1"
    # Read project ID from gcloud if available
    GCLOUD_BIN="${HOME}/google-cloud-sdk/bin/gcloud"
    GCP_PROJECT=$("$GCLOUD_BIN" config get-value project 2>/dev/null || gcloud config get-value project 2>/dev/null || echo "")
    if [ -n "$GCP_PROJECT" ]; then
      export ANTHROPIC_VERTEX_PROJECT_ID="$GCP_PROJECT"
      echo "→ Switched to Google Vertex AI (project: $GCP_PROJECT)"
    else
      echo "→ Switched to Google Vertex AI"
      echo "  ⚠ Set ANTHROPIC_VERTEX_PROJECT_ID manually or run: gcloud config set project YOUR_PROJECT"
    fi
    export ANTHROPIC_DEFAULT_OPUS_MODEL='claude-opus-4-6'
    echo "  Run: claude"
    ;;
  direct)
    export ANTHROPIC_DEFAULT_OPUS_MODEL='claude-opus-4-6-20260312'
    echo "→ Switched to Direct Anthropic API"
    if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
      echo "  ⚠ Set ANTHROPIC_API_KEY if not already in config"
    fi
    echo "  Run: claude"
    ;;
  *)
    echo "Unknown provider: $PROVIDER"
    echo "Options: bedrock, vertex, direct"
    return 1 2>/dev/null || exit 1
    ;;
esac
