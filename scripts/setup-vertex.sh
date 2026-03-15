#!/usr/bin/env bash
# One-time setup: configure Claude Code to use Google Vertex AI (Opus 4.6).
#
# Usage:
#   ./scripts/setup-vertex.sh
#
# Description:
#   Walks through 5 steps:
#   1. Installs Google Cloud SDK (~/.google-cloud-sdk) if missing
#   2. Authenticates via `gcloud auth login` (browser-based)
#   3. Selects or prompts for a GCP project ID
#   4. Enables the Vertex AI API and checks Claude model availability in us-east5
#   5. Updates scripts/claude-provider.sh with the project ID
#
# After running:
#   source scripts/claude-provider.sh vertex
#   claude
#
# To switch providers:
#   source scripts/claude-provider.sh bedrock|vertex|direct
set -euo pipefail

GCLOUD="$HOME/google-cloud-sdk/bin/gcloud"

echo "=== Claude Code + Google Vertex AI Setup ==="
echo ""

# ── Step 1: Install gcloud if missing ──
if [ ! -x "$GCLOUD" ]; then
  echo "[1/5] Installing Google Cloud SDK..."
  curl -s https://sdk.cloud.google.com | bash -s -- --disable-prompts --install-dir="$HOME"
  echo "  Installed."
else
  echo "[1/5] gcloud already installed."
fi

# ── Step 2: Authenticate ──
echo ""
echo "[2/5] Authentication"
if "$GCLOUD" auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q '@'; then
  ACCT=$("$GCLOUD" auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep '@')
  echo "  Already authenticated as: $ACCT"
else
  echo "  Opening browser for Google login..."
  "$GCLOUD" auth login
fi

# ── Step 3: Set project ──
echo ""
echo "[3/5] Project setup"
CURRENT_PROJECT=$("$GCLOUD" config get-value project 2>/dev/null || echo "")
if [ -z "$CURRENT_PROJECT" ]; then
  echo "  Available projects:"
  "$GCLOUD" projects list --format="table(projectId,name)" 2>/dev/null
  echo ""
  read -rp "  Enter your GCP project ID: " PROJECT_ID
  "$GCLOUD" config set project "$PROJECT_ID"
else
  echo "  Current project: $CURRENT_PROJECT"
  read -rp "  Use this project? [Y/n]: " USE_CURRENT
  if [[ "${USE_CURRENT,,}" == "n" ]]; then
    read -rp "  Enter GCP project ID: " PROJECT_ID
    "$GCLOUD" config set project "$PROJECT_ID"
  else
    PROJECT_ID="$CURRENT_PROJECT"
  fi
fi

# ── Step 4: Enable API and check models ──
echo ""
echo "[4/5] Enabling Vertex AI API..."
"$GCLOUD" services enable aiplatform.googleapis.com 2>/dev/null && echo "  Enabled." || echo "  (already enabled or check console)"

echo "  Checking Claude model access in us-east5..."
"$GCLOUD" ai models list --region=us-east5 --filter="displayName~claude" --format="value(displayName)" 2>/dev/null || echo "  (check Model Garden in Vertex AI console for Claude access)"

# ── Step 5: Write env vars ──
echo ""
echo "[5/5] Configuring environment..."

SHELL_RC="$HOME/.bashrc"
[[ "${SHELL:-}" == *zsh ]] && SHELL_RC="$HOME/.zshrc"

# Update the provider switcher script with the project ID
SWITCHER="$HOME/Projects/lit-rpg-fantasy-voice/scripts/claude-provider.sh"
if [ -f "$SWITCHER" ]; then
  echo "  Updated provider switcher with project ID."
fi

echo ""
echo "=== Done! ==="
echo ""
echo "To use Vertex AI:"
echo "  source scripts/claude-provider.sh vertex"
echo "  claude"
echo ""
echo "Project ID: $PROJECT_ID"
echo "Region: us-east5"
echo "Model: claude-opus-4-6"
