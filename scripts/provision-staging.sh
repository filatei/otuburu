#!/usr/bin/env bash
# One-time script to provision Otuburu staging infrastructure on Linode.
#
# Prerequisites:
#   brew install hashicorp/tap/terraform kubectl
#
# Usage:
#   export LINODE_TOKEN=<your-linode-api-token>
#   bash scripts/provision-staging.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TF_DIR="$REPO_ROOT/infra/terraform/envs/staging"

: "${LINODE_TOKEN:?Set LINODE_TOKEN to your Linode API token}"

echo "═══════════════════════════════════════════════════════"
echo "  Otuburu — Provision staging infrastructure on Linode"
echo "═══════════════════════════════════════════════════════"

# ── 0. Clear any partial state from previous failed runs ─────────────────────
echo ""
echo "==> Clearing partial state …"
rm -f "$TF_DIR/terraform.tfstate" "$TF_DIR/terraform.tfstate.backup"

# ── 1. Write terraform.tfvars ─────────────────────────────────────────────────
TFVARS="$TF_DIR/terraform.tfvars"
cat > "$TFVARS" <<EOF
linode_token = "$LINODE_TOKEN"
region       = "us-southeast"
EOF
echo "✓  Wrote $TFVARS"

# ── 2. Terraform init + apply ─────────────────────────────────────────────────
echo ""
echo "==> terraform init …"
terraform -chdir="$TF_DIR" init -upgrade

echo ""
echo "==> terraform apply (takes ~5 min for LKE) …"
terraform -chdir="$TF_DIR" apply -auto-approve

# ── 3. Extract kubeconfig ─────────────────────────────────────────────────────
echo ""
echo "==> Extracting kubeconfig …"
KUBECONFIG_RAW=$(terraform -chdir="$TF_DIR" output -raw kubeconfig)
KUBECONFIG_B64=$(echo "$KUBECONFIG_RAW" | base64 | tr -d '\n')

KUBECONFIG_FILE="$REPO_ROOT/infra/staging-kubeconfig.yaml"
echo "$KUBECONFIG_RAW" > "$KUBECONFIG_FILE"
chmod 600 "$KUBECONFIG_FILE"
echo "✓  Kubeconfig saved to $KUBECONFIG_FILE"

# ── 4. Verify cluster ─────────────────────────────────────────────────────────
echo ""
echo "==> Verifying cluster connectivity …"
if command -v kubectl &>/dev/null; then
  KUBECONFIG="$KUBECONFIG_FILE" kubectl get nodes
else
  echo "(kubectl not found — install: brew install kubectl)"
fi

# ── 5. Print the GitHub secret ────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  DONE! Add this secret in GitHub:"
echo "  repo → Settings → Secrets → Actions → New secret"
echo ""
echo "  Name:  STAGING_KUBECONFIG"
echo "  Value: (copy the entire base64 string below)"
echo ""
echo "$KUBECONFIG_B64"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Then push to main to trigger the first container deployment."
