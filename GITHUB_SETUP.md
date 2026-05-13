# Step 2 — Put Otuburu on GitHub and pull-deploy from the Linode

Pre-conditions: TLS is live on `https://otuburu.torama.money` (see
`TLS_SETUP.md`). The placeholder page is currently being served.

End state after this guide:

- Private GitHub repo `otuburu` under your account (or org).
- A read-only SSH deploy key on the Linode that lets the `otuburu`
  system user pull from that repo.
- The repo cloned to `/home/otuburu/app` on the Linode.
- A one-command deploy: `sudo /home/otuburu/app/scripts/deploy.sh`.
- The Apache vhost flipped from "serve the placeholder" to "proxy to
  the Node engine", with the certbot-managed TLS block left intact.

SSH details: port **2525**, user **`user1`**, host **`104.237.157.53`**.

---

## Part A — On your laptop: get the repo on GitHub

### A1. Initialise the repo

```bash
cd "TORAMA BROKERAGE -  Otuburu/otuburu-demo"

git init -b main
git add .
git status                       # eyeball — make sure no node_modules etc.
git -c user.name="Torama" \
    -c user.email="filatei@gtsng.com" \
    commit -m "Initial commit: Otuburu demo + infra + scripts"
```

### A2. Create the private repo on GitHub

Two ways — pick whichever you have set up.

**With the `gh` CLI:**

```bash
gh repo create otuburu --private --source=. --remote=origin --push
```

That single command creates the private repo, adds it as `origin`, and
pushes `main`.

**Without `gh` (web UI):**

1. <https://github.com/new>
2. Name: `otuburu` · Visibility: **Private** · Don't add README/.gitignore/license (we already have them).
3. Click **Create repository**.
4. Then on your laptop:

```bash
git remote add origin git@github.com:YOUR_USER/otuburu.git
git push -u origin main
```

(If you don't have SSH set up to GitHub locally, use HTTPS instead:
`https://github.com/YOUR_USER/otuburu.git` — GitHub will prompt for a
Personal Access Token on push.)

---

## Part B — On the Linode: install the deploy key and clone

### B1. Push the bootstrap script up

From your laptop:

```bash
scp -P 2525 \
  "TORAMA BROKERAGE -  Otuburu/otuburu-demo/scripts/server-bootstrap.sh" \
  user1@104.237.157.53:/tmp/server-bootstrap.sh
```

### B2. Run the bootstrap (round 1: generate the deploy key)

SSH in and run it without `REPO_URL` first — this creates the user,
generates a deploy keypair, and prints the public key:

```bash
ssh -p 2525 user1@104.237.157.53
sudo bash /tmp/server-bootstrap.sh
```

The script ends with a block like:

```
======================================================================
Public key to add as a Deploy Key on the GitHub repo (read-only):
----------------------------------------------------------------------
ssh-ed25519 AAAA…lots…of…characters… otuburu-deploy@host
----------------------------------------------------------------------
```

Copy the `ssh-ed25519 …` line.

### B3. Register the key as a Deploy Key on GitHub

In a browser:

1. GitHub → `YOUR_USER/otuburu` → **Settings** → **Deploy keys** → **Add deploy key**.
2. Title: `linode-104.237.157.53` (so future-you knows which server).
3. Key: paste the line you copied.
4. **Allow write access: LEAVE UNCHECKED.** This server only needs to *read*.
5. **Add key.**

### B4. Bootstrap round 2 — clone the repo

Back on the Linode, re-run the bootstrap with `REPO_URL` set:

```bash
sudo REPO_URL=git@github.com:YOUR_USER/otuburu.git \
  bash /tmp/server-bootstrap.sh
```

(Replace `YOUR_USER` with your GitHub username or org.)

This clones the repo to `/home/otuburu/app` and runs `npm install
--omit=dev`. You can verify:

```bash
sudo -u otuburu git -C /home/otuburu/app log --oneline -1
sudo -u otuburu ls /home/otuburu/app/engine
```

---

## Part C — First deploy: flip Apache from placeholder to proxy

The `scripts/deploy.sh` script handles vhost install, but it intentionally
**will not overwrite** a vhost file that already contains a `<VirtualHost
*:443>` block (i.e. the one certbot wrote). That's the right default for
day-to-day deploys.

For this **one-time** flip we need to merge the proxy directives from
`infra/apache/otuburu.torama.money.conf` into the live vhost file that
certbot manages. Two safe approaches — pick one.

### Approach 1 — Edit certbot's file in place (recommended)

```bash
sudo cp /etc/apache2/sites-available/otuburu.torama.money.conf \
        /etc/apache2/sites-available/otuburu.torama.money.conf.bak

sudo nano /etc/apache2/sites-available/otuburu.torama.money.conf
```

You will see two blocks: `<VirtualHost *:80>` (redirect to HTTPS) and
`<VirtualHost *:443>` (the one with the certbot SSL lines).

In the `<VirtualHost *:443>` block:

1. **Remove** these lines if they exist (we don't want static docroot anymore):

   ```apache
   DocumentRoot /var/www/otuburu
   <Directory /var/www/otuburu>
       Require all granted
       Options -Indexes
       AllowOverride None
   </Directory>
   ```

2. **Add** these lines (right before the cert lines is fine):

   ```apache
   ProxyPreserveHost On
   ProxyRequests Off

   ProxyPass        /ws  ws://127.0.0.1:8080/ws
   ProxyPassReverse /ws  ws://127.0.0.1:8080/ws
   ProxyPass        /    http://127.0.0.1:8080/
   ProxyPassReverse /    http://127.0.0.1:8080/

   RequestHeader set X-Forwarded-Proto "https"
   ```

3. Save and exit.

Then:

```bash
sudo apache2ctl configtest        # expect "Syntax OK"
sudo systemctl reload apache2
```

### Approach 2 — Nuke and rerun certbot

If you'd rather have the deploy script own the vhost cleanly:

```bash
sudo a2dissite otuburu.torama.money.conf
sudo rm /etc/apache2/sites-available/otuburu.torama.money.conf
sudo systemctl reload apache2

# Now let deploy.sh install the proxy vhost from the repo:
sudo /home/otuburu/app/scripts/deploy.sh

# Then re-issue the cert — certbot will add the *:443 block again,
# preserving the ProxyPass lines:
sudo certbot --apache -d otuburu.torama.money \
  --redirect --agree-tos -m you@yourdomain --non-interactive
```

Approach 1 is less disruptive; Approach 2 is cleaner when you've changed
the vhost a lot.

---

## Part D — Install the systemd service and start the app

```bash
sudo /home/otuburu/app/scripts/deploy.sh
```

This will:

- `git pull` (already at HEAD on first run — no-op)
- Install/refresh production deps
- Install the systemd unit from `infra/systemd/otuburu.service`
- Restart the `otuburu` service
- Smoke-test `http://127.0.0.1:8080/api/symbols`

When it succeeds, open <https://otuburu.torama.money> — the placeholder
is gone, the live dashboard takes its place, the "live" badge in the top
right goes green within a second or two.

---

## Day-to-day workflow after this

### Push a change from your laptop

```bash
cd "TORAMA BROKERAGE -  Otuburu/otuburu-demo"
# edit something
git add -A
git commit -m "tweak: improve binary payout display"
git push
```

### Pull-deploy on the Linode

```bash
ssh -p 2525 user1@104.237.157.53 \
  'sudo /home/otuburu/app/scripts/deploy.sh'
```

A one-liner you can save as an alias on your laptop:

```bash
# in your ~/.zshrc or ~/.bashrc
alias otu-deploy='ssh -p 2525 user1@104.237.157.53 "sudo /home/otuburu/app/scripts/deploy.sh"'
```

Then deploy is literally just: `otu-deploy`.

---

## Things to know

- **The deploy key is per-repo and read-only.** It can clone and pull
  `otuburu` and nothing else. If the Linode is compromised, the blast
  radius on GitHub is "attacker can clone the otuburu repo" — they cannot
  push, cannot touch other repos, cannot access your account.

- **The vhost file is special.** Once certbot has written its `<VirtualHost
  *:443>` block, the deploy script will not touch the vhost file — both
  to protect your TLS config and because every deploy reloading TLS is
  wasteful. If you genuinely need to change the vhost via the repo, delete
  the live file and re-run certbot (Approach 2 above).

- **Logs:** `sudo journalctl -u otuburu -f` for the engine, `sudo tail -f
  /var/log/apache2/otuburu_*.log` for Apache.

- **Rollback:** if a deploy breaks something, SSH in and pin to the
  previous commit:

  ```bash
  ssh -p 2525 user1@104.237.157.53
  sudo -u otuburu git -C /home/otuburu/app log --oneline -5   # find the last good SHA
  sudo -u otuburu git -C /home/otuburu/app reset --hard <SHA>
  sudo systemctl restart otuburu
  ```

- **Auto-deploy later.** When you're ready to graduate from manual
  pull-deploy, the GitHub Actions equivalent is ~25 lines of YAML that
  SSHes in and runs the same script. We can add it without changing
  anything on the server.
