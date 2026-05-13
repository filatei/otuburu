#!/usr/bin/env bash
# Quick push helper — run from otuburu_live/ after making changes
# Usage: GH_TOKEN=ghp_xxxx bash scripts/git-push.sh "your commit message"
set -euo pipefail

MSG="${1:-chore: update}"
GH_TOKEN="${GH_TOKEN:?Set GH_TOKEN=ghp_... before running}"

# Update remote URL with fresh token (tokens expire)
git remote set-url origin "https://filatei:${GH_TOKEN}@github.com/filatei/otuburu.git"

git add -A
if git diff --cached --quiet; then
  echo "Nothing to commit."
else
  git commit -m "$MSG"
  git push
  echo "✅ Pushed: $MSG"
fi
