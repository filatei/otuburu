#!/usr/bin/env bash
# github-setup.sh
# ─────────────────────────────────────────────────────────────────────────────
# ONE-SHOT script: creates the private GitHub repo "otuburu" under filatei,
# initialises git in this directory, and pushes everything.
#
# Run from the project root (otuburu_live/):
#   chmod +x scripts/github-setup.sh
#   GH_TOKEN=ghp_xxxx bash scripts/github-setup.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

GH_USER="filatei"
REPO_NAME="otuburu"
GH_TOKEN="${GH_TOKEN:?Set GH_TOKEN=ghp_... before running}"

echo "▶ Creating private GitHub repo ${GH_USER}/${REPO_NAME} ..."
RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "Authorization: token ${GH_TOKEN}" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/user/repos \
  -d "{
    \"name\": \"${REPO_NAME}\",
    \"private\": true,
    \"description\": \"Otuburu synthetic brokerage — torama.money\",
    \"auto_init\": false
  }")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -1)

if [[ "$HTTP_CODE" == "201" ]]; then
  echo "  ✅ Repo created: https://github.com/${GH_USER}/${REPO_NAME}"
elif [[ "$HTTP_CODE" == "422" ]]; then
  echo "  ℹ️  Repo already exists — continuing with push."
else
  echo "  ❌ GitHub API returned HTTP ${HTTP_CODE}:"
  echo "$BODY"
  exit 1
fi

# ── Git init ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
cd "$REPO_DIR"

echo "▶ Initialising git in $(pwd) ..."
if [ ! -d .git ]; then
  git init -b main
else
  echo "  ℹ️  .git already exists — skipping init."
fi

# ── Configure identity if not set ──────────────────────────────────────────
if ! git config user.email > /dev/null 2>&1; then
  git config user.email "filatei@gtsng.com"
  git config user.name  "Torama"
fi

# ── Remote ──────────────────────────────────────────────────────────────────
REMOTE_URL="https://${GH_USER}:${GH_TOKEN}@github.com/${GH_USER}/${REPO_NAME}.git"
if git remote get-url origin > /dev/null 2>&1; then
  git remote set-url origin "$REMOTE_URL"
  echo "  ℹ️  Updated existing remote 'origin'."
else
  git remote add origin "$REMOTE_URL"
  echo "  ✅ Added remote 'origin'."
fi

# ── Stage & commit ───────────────────────────────────────────────────────────
echo "▶ Staging all files ..."
git add -A

if git diff --cached --quiet; then
  echo "  ℹ️  Nothing to commit."
else
  git commit -m "chore: initial monorepo scaffold

- Node.js demo engine (proof-of-concept, already deployed to torama.money)
- Rust engine workspace: feed-generator, order-book, risk-engine, binary-options crates
- Go services: account (auth + wallet), gateway (WebSocket hub + REST proxy)
- Terraform: Linode VPC, LKE, Object Storage modules (staging + production envs)
- GitHub Actions: CI (Rust/Go/Node/Terraform) + pull-deploy workflow
"
fi

# ── Push ────────────────────────────────────────────────────────────────────
echo "▶ Pushing to GitHub ..."
git push -u origin main

echo ""
echo "🎉 Done!  https://github.com/${GH_USER}/${REPO_NAME}"
echo ""
echo "Next steps:"
echo "  1. Add GitHub Actions secrets (Settings → Secrets → Actions):"
echo "     LINODE_HOST      = 104.237.157.53"
echo "     LINODE_USER      = user1"
echo "     LINODE_SSH_KEY   = <contents of your deploy private key>"
echo "     LINODE_SSH_PORT  = 2525"
echo ""
echo "  2. Enable branch protection on 'main' (require PR + CI green)."
echo ""
echo "  3. Run terraform init in infra/terraform/envs/staging once ready."
