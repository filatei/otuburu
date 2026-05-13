#!/usr/bin/env bash
# generate-lockfiles.sh
# Generates Cargo.lock and go.sum files so CI passes on all 4 jobs.
# Run from otuburu_live/:
#   bash scripts/generate-lockfiles.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "📁  Working in: $REPO_DIR"

# ── Rust ──────────────────────────────────────────────────────────────────────
echo ""
echo "🦀  Rust — generating Cargo.lock ..."
if ! command -v cargo &>/dev/null; then
  echo "  ⚠️   cargo not found. Installing via rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  source "$HOME/.cargo/env"
fi

cd "$REPO_DIR/rust-engine"
cargo fetch                         # downloads deps, writes Cargo.lock
cargo check --all 2>&1 | tail -5   # quick syntax check (no full compile needed)
echo "  ✅  Cargo.lock generated"

# ── Go ────────────────────────────────────────────────────────────────────────
echo ""
echo "🐹  Go — running go mod tidy for each service ..."
if ! command -v go &>/dev/null; then
  echo "  ⚠️   go not found. Install via: brew install go"
  echo "       Then re-run this script."
  exit 1
fi

for svc in account gateway; do
  SVC_DIR="$REPO_DIR/go-services/$svc"
  echo "  → $svc"
  cd "$SVC_DIR"
  go mod tidy
  echo "    ✅  go.sum updated"
done

cd "$REPO_DIR/go-services"
go work sync 2>/dev/null || true
echo "  ✅  go.work.sum updated"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "✅  All lock files generated. Commit and push with:"
echo ""
echo "    GH_TOKEN=ghp_xxxx bash scripts/git-push.sh \"chore: add Cargo.lock and go.sum\""
echo ""
