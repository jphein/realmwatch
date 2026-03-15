#!/usr/bin/env bash
# One-time setup: configure Claude Code to use Amazon Bedrock (Opus 4.6).
#
# Usage:
#   ./scripts/setup-bedrock.sh
#
# Description:
#   Walks through 4 steps:
#   1. Installs AWS CLI v2 if missing
#   2. Runs `aws configure` if no credentials exist (prompts for key/secret/region)
#   3. Lists available Claude models in Bedrock (requires bedrock:ListInferenceProfiles)
#   4. Appends CLAUDE_CODE_USE_BEDROCK=1 + AWS_REGION env vars to ~/.bashrc or ~/.zshrc
#
# After running:
#   source ~/.bashrc  (or open a new terminal)
#   claude
#
# To switch providers later:
#   source scripts/claude-provider.sh bedrock|vertex|direct
set -euo pipefail

echo "=== Claude Code + Amazon Bedrock Setup ==="
echo ""

# ── Step 1: Install AWS CLI if missing ──
if ! command -v aws &>/dev/null; then
  echo "[1/4] Installing AWS CLI v2..."
  cd /tmp
  curl -s "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip
  unzip -qo awscliv2.zip
  sudo ./aws/install
  rm -rf awscliv2.zip aws/
  echo "  Installed: $(aws --version)"
else
  echo "[1/4] AWS CLI already installed: $(aws --version)"
fi

# ── Step 2: Configure AWS credentials ──
echo ""
echo "[2/4] AWS Credentials"
if aws sts get-caller-identity &>/dev/null; then
  echo "  Already authenticated:"
  aws sts get-caller-identity --output table
else
  echo "  No credentials found. Running 'aws configure'..."
  echo "  You'll need: Access Key ID, Secret Access Key, Region"
  echo ""
  aws configure
fi

# ── Step 3: Check Bedrock model access ──
echo ""
echo "[3/4] Checking Bedrock model availability..."
REGION=${AWS_REGION:-$(aws configure get region 2>/dev/null || echo "us-east-1")}
echo "  Region: $REGION"

# List Claude models available
echo "  Available Claude models:"
aws bedrock list-inference-profiles --region "$REGION" 2>/dev/null \
  | python3 -c "
import json,sys
data = json.load(sys.stdin)
for p in data.get('inferenceProfileSummaries', []):
    name = p.get('inferenceProfileName','')
    pid = p.get('inferenceProfileId','')
    if 'claude' in name.lower() or 'claude' in pid.lower():
        print(f'    {pid}  ({name})')
" 2>/dev/null || echo "    (Could not list — check IAM permissions: bedrock:ListInferenceProfiles)"

# ── Step 4: Write env vars ──
echo ""
echo "[4/4] Configuring environment..."

SHELL_RC="$HOME/.bashrc"
[[ "$SHELL" == *zsh ]] && SHELL_RC="$HOME/.zshrc"

# Remove old entries if present
sed -i '/# Claude Code Bedrock/d' "$SHELL_RC" 2>/dev/null || true
sed -i '/CLAUDE_CODE_USE_BEDROCK/d' "$SHELL_RC" 2>/dev/null || true
sed -i '/ANTHROPIC_DEFAULT_OPUS_MODEL.*bedrock/d' "$SHELL_RC" 2>/dev/null || true
sed -i '/AWS_REGION.*# bedrock/d' "$SHELL_RC" 2>/dev/null || true

cat >> "$SHELL_RC" << 'VARS'

# Claude Code Bedrock
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION="${AWS_REGION:-us-east-1}"  # bedrock
export ANTHROPIC_DEFAULT_OPUS_MODEL='us.anthropic.claude-opus-4-6-v1'
VARS

echo "  Added to $SHELL_RC:"
echo "    CLAUDE_CODE_USE_BEDROCK=1"
echo "    AWS_REGION=$REGION"
echo "    ANTHROPIC_DEFAULT_OPUS_MODEL=us.anthropic.claude-opus-4-6-v1"

echo ""
echo "=== Done! ==="
echo ""
echo "To use Bedrock Claude Code:"
echo "  source $SHELL_RC"
echo "  claude"
echo ""
echo "Or in a new terminal just run: claude"
