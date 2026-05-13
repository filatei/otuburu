#!/usr/bin/env bash
# One-time script to provision Otuburu staging infrastructure on Linode.
#
# Prerequisites:
#   brew install linode-cli terraform
#   terraform providers:  linode/linode ~> 2.28
#
# Usage:
#   export LINODE_TOKEN=<your-linode-api-token>
#   bash scripts/provision-staging.sh
#
# After running, it prints the STAGING_KUBECONFIG value to add as a GitHub secret.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TF_DIR="$REPO_ROOT/infra/terraform/envs/staging"

: "${LINODE_TOKEN:?Set LINODE_TOKEN to your Linode API token}"

echo "═══════════════════════════════════════════════════════"
echo "  Otuburu — Provision staging infrastructure on Linode"
echo "═══════════════════════════════════════════════════════"
echo ""

# ── 1. Write terraform.tfvars ─────────────────────────────────────────────────
TFVARS="$TF_DIR/terraform.tfvars"
cat > "$TFVARS" <<EOF
linode_token = "$LINODE_TOKEN"
region       = "us-east"
EOF
echo "✓  Wrote $TFVARS"

# ── 2. Terraform init + apply ─────────────────────────────────────────────────
echo ""
echo "==> terraform init …"
terraform -chdir="$TF_DIR" init

echo ""
echo "==> terraform apply (takes ~5 min for LKE) …"
terraform -chdir="$TF_DIR" apply -auto-approve

# ── 3. Extract kubeconfig ─────────────────────────────────────────────────────
echo ""
echo "==> Extracting kubeconfig …"
KUBECONFIG_B64=$(terraform -chdir="$TF_DIR" output -raw kubeconfig 2>/dev/null \
  || terraform -chdir="$TF_DIR" output -json | \
     python3 -c "import sys,json,base64; d=json.load(sys.stdin); print(base64.b64decode(d['kubeconfig']['value']).decode())" \
     | base64 | tr -d '\n')

KUBECONFIG_FILE="$REPO_ROOT/infra/staging-kubeconfig.yaml"
echo "$KUBECONFIG_B64" | base64 -d > "$KUBECONFIG_FILE"
chmod 600 "$KUBECONFIG_FILE"
echo "✓  Kubeconfig written to $KUBECONFIG_FILE"

# ── 4. Verify cluster ─────────────────────────────────────────────────────────
echo ""
echo "==> Verifying cluster …"
KUBECONFIG="$KUBECONFIG_FILE" kubectl get nodes

# ── 5. Instructions ───────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  DONE — add this secret to GitHub:"
echo "  Settings → Secrets → Actions → New secret"
echo ""
echo "  Name:  STAGING_KUBECONFIG"
echo "  Value: (paste the base64 below)"
echo ""
echo "$KUBECONFIG_B64"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Then push to main to trigger the first real deployment."
