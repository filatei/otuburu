#!/usr/bin/env python3
"""
github-secrets.py
─────────────────────────────────────────────────────────────────────────────
Adds GitHub Actions secrets and enables branch protection for filatei/otuburu.

Requirements:
    pip install PyNaCl requests   (or: pip3 install PyNaCl requests)

Usage:
    GH_TOKEN=ghp_xxxx \
    LINODE_SSH_KEY_PATH=~/.ssh/id_otuburu_deploy \
    python3 scripts/github-secrets.py

If LINODE_SSH_KEY_PATH is not set the script will look for a key at
~/.ssh/id_otuburu_deploy or ~/.ssh/id_rsa and let you confirm.

The script sets:
    LINODE_HOST      104.237.157.53
    LINODE_USER      user1
    LINODE_SSH_PORT  2525
    LINODE_SSH_KEY   <private key file contents>
─────────────────────────────────────────────────────────────────────────────
"""

import base64
import os
import sys
import json
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("❌  requests not installed. Run: pip3 install PyNaCl requests")

try:
    from nacl import encoding, public
except ImportError:
    sys.exit("❌  PyNaCl not installed. Run: pip3 install PyNaCl requests")

# ─── config ────────────────────────────────────────────────────────────────
GH_TOKEN   = os.environ.get("GH_TOKEN", "")
GH_USER    = "filatei"
GH_REPO    = "otuburu"
API_BASE   = f"https://api.github.com/repos/{GH_USER}/{GH_REPO}"

LINODE_HOST  = "104.237.157.53"
LINODE_USER  = "user1"
LINODE_PORT  = "2525"

# ─── helpers ────────────────────────────────────────────────────────────────

def die(msg):
    print(f"❌  {msg}", file=sys.stderr)
    sys.exit(1)

def gh(method, path, **kwargs):
    resp = requests.request(
        method,
        f"{API_BASE}{path}",
        headers={
            "Authorization": f"token {GH_TOKEN}",
            "Accept": "application/vnd.github.v3+json",
        },
        **kwargs,
    )
    return resp

def encrypt_secret(public_key_b64: str, secret: str) -> str:
    """Encrypt a secret value with the repo's public key (libsodium box)."""
    pub_key = public.PublicKey(public_key_b64.encode(), encoding.Base64Encoder)
    sealed  = public.SealedBox(pub_key)
    encrypted = sealed.encrypt(secret.encode("utf-8"))
    return base64.b64encode(encrypted).decode("utf-8")

def get_repo_public_key():
    r = gh("GET", "/actions/secrets/public-key")
    r.raise_for_status()
    data = r.json()
    return data["key_id"], data["key"]

def put_secret(name: str, value: str, key_id: str, pub_key: str):
    encrypted = encrypt_secret(pub_key, value)
    r = gh("PUT", f"/actions/secrets/{name}", json={
        "encrypted_value": encrypted,
        "key_id": key_id,
    })
    if r.status_code in (201, 204):
        print(f"  ✅  {name}")
    else:
        print(f"  ❌  {name} — HTTP {r.status_code}: {r.text}")

def find_ssh_key():
    path_env = os.environ.get("LINODE_SSH_KEY_PATH", "")
    if path_env:
        p = Path(path_env).expanduser()
        if p.exists():
            return p
        die(f"LINODE_SSH_KEY_PATH={path_env} does not exist")

    candidates = [
        Path.home() / ".ssh" / "id_otuburu_deploy",
        Path.home() / ".ssh" / "id_ed25519",
        Path.home() / ".ssh" / "id_rsa",
    ]
    for p in candidates:
        if p.exists():
            ans = input(f"\nUse SSH key at {p}? [y/N] ").strip().lower()
            if ans == "y":
                return p
    die(
        "No SSH key found. Either:\n"
        "  a) Generate one:  ssh-keygen -t ed25519 -f ~/.ssh/id_otuburu_deploy\n"
        "     Then add the PUBLIC key to the Linode server:\n"
        "       ssh-copy-id -i ~/.ssh/id_otuburu_deploy.pub -p 2525 user1@104.237.157.53\n"
        "  b) Set LINODE_SSH_KEY_PATH=/path/to/private_key and re-run."
    )

def enable_branch_protection():
    """Require status checks on main before merging."""
    r = gh("PUT", "/branches/main/protection", json={
        "required_status_checks": {
            "strict": True,
            "contexts": [
                "Rust engine",
                "Go services",
                "Node demo lint",
                "Terraform validate",
            ],
        },
        "enforce_admins": False,
        "required_pull_request_reviews": {
            "required_approving_review_count": 1,
            "dismiss_stale_reviews": True,
        },
        "restrictions": None,
        "allow_force_pushes": False,
        "allow_deletions": False,
    })
    if r.status_code == 200:
        print("  ✅  Branch protection enabled on main")
    else:
        print(f"  ⚠️   Branch protection — HTTP {r.status_code}: {r.text[:200]}")
        print("       (This requires a GitHub Pro/Team plan for private repos.)")
        print("       You can set it manually: Settings → Branches → Add rule → main")

# ─── main ───────────────────────────────────────────────────────────────────

def main():
    if not GH_TOKEN:
        die("GH_TOKEN env var is not set. Run:\n  GH_TOKEN=ghp_xxxx python3 scripts/github-secrets.py")

    # Verify token works
    r = requests.get(
        "https://api.github.com/user",
        headers={"Authorization": f"token {GH_TOKEN}"},
    )
    if r.status_code != 200:
        die(f"GitHub token invalid — HTTP {r.status_code}")

    print(f"\n🔑  Setting GitHub Actions secrets on {GH_USER}/{GH_REPO}\n")

    ssh_key_path = find_ssh_key()
    ssh_key_value = ssh_key_path.read_text()
    print(f"\nUsing SSH key: {ssh_key_path}")

    key_id, pub_key = get_repo_public_key()

    secrets = {
        "LINODE_HOST":    LINODE_HOST,
        "LINODE_USER":    LINODE_USER,
        "LINODE_SSH_PORT": LINODE_PORT,
        "LINODE_SSH_KEY": ssh_key_value,
    }

    print("\nAdding secrets:")
    for name, value in secrets.items():
        put_secret(name, value, key_id, pub_key)

    print("\nEnabling branch protection:")
    enable_branch_protection()

    print(f"""
✅  All done!

Next: verify CI is green at
    https://github.com/{GH_USER}/{GH_REPO}/actions

Then any push to main will auto-deploy to torama.money via:
    ssh -p {LINODE_PORT} {LINODE_USER}@{LINODE_HOST} 'sudo /home/otuburu/app/scripts/deploy.sh'
""")

if __name__ == "__main__":
    main()
