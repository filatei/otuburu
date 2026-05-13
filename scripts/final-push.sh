#!/usr/bin/env bash
# Verify clean build, then push to GitHub.
# Run from the repo root: bash scripts/final-push.sh

set -e
cd "$(dirname "$0")/.."          # repo root = otuburu_live/

echo "=== cargo check (all crates) ==="
(cd rust-engine && cargo check --all 2>&1)

echo ""
echo "=== cargo clippy (must be warning-free) ==="
(cd rust-engine && cargo clippy --all-targets --all-features -- -D warnings 2>&1)

echo ""
echo "All checks passed ✅ — committing and pushing …"

git add -A
git commit -m "fix: remove unused imports, tokio-stream sync feature, protoc in CI, Terraform HCL"
git push origin main

echo "Done. Check CI at: https://github.com/filatei/otuburu/actions"
