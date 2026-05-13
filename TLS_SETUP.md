# Step 1 — TLS for `otuburu.torama.money`

Target: a valid Let's Encrypt certificate on `https://otuburu.torama.money`,
served by the existing Apache, with a branded placeholder page underneath
until the Node app is deployed via GitHub.

Connection details used throughout: SSH on **port 2525**, user **`user1`**,
host **`104.237.157.53`**.

```bash
# from your laptop
ssh -p 2525 user1@104.237.157.53
```

---

## 1. Push the placeholder page up (from your laptop)

The page is in `otuburu-demo/placeholder/index.html`.

```bash
# from your laptop, in the workspace folder
scp -P 2525 \
  "TORAMA BROKERAGE -  Otuburu/otuburu-demo/placeholder/index.html" \
  user1@104.237.157.53:/tmp/otuburu-coming-soon.html
```

Note `-P` (capital) for scp's port flag — different from ssh's lowercase `-p`.

---

## 2. On the Linode — prep Apache modules (one-time)

```bash
ssh -p 2525 user1@104.237.157.53

# enable the modules we'll need (no-op if already enabled)
sudo a2enmod ssl rewrite headers proxy proxy_http proxy_wstunnel
sudo systemctl reload apache2

# confirm
apache2ctl -M 2>/dev/null | grep -E 'ssl|rewrite|proxy_(http|wstunnel)|headers' | sort
```

You should see:

```
headers_module (shared)
proxy_http_module (shared)
proxy_module (shared)
proxy_wstunnel_module (shared)
rewrite_module (shared)
ssl_module (shared)
```

If `apache2 --version` reports anything older than 2.4, stop and tell me —
the `proxy_wstunnel` module is what makes the live dashboard work later
and it ships from 2.4.5 onwards.

---

## 3. Place the placeholder page in its own docroot

```bash
# on the Linode
sudo mkdir -p /var/www/otuburu
sudo mv /tmp/otuburu-coming-soon.html /var/www/otuburu/index.html
sudo chown -R www-data:www-data /var/www/otuburu
```

---

## 4. Create the Apache vhost (HTTP only — certbot adds HTTPS)

```bash
sudo tee /etc/apache2/sites-available/otuburu.torama.money.conf >/dev/null <<'EOF'
<VirtualHost *:80>
    ServerName otuburu.torama.money

    DocumentRoot /var/www/otuburu
    <Directory /var/www/otuburu>
        Require all granted
        Options -Indexes
        AllowOverride None
    </Directory>

    ErrorLog  ${APACHE_LOG_DIR}/otuburu_error.log
    CustomLog ${APACHE_LOG_DIR}/otuburu_access.log combined
</VirtualHost>
EOF

sudo a2ensite otuburu.torama.money.conf
sudo apache2ctl configtest          # expect: "Syntax OK"
sudo systemctl reload apache2
```

Smoke-test it over HTTP before requesting the cert:

```bash
curl -sI http://otuburu.torama.money | head -3
# expect: HTTP/1.1 200 OK
```

If you see a 200, DNS + Apache are wired correctly and Let's Encrypt's
HTTP-01 challenge will succeed.

If you see a 404 or get the `torama.money` landing page instead, your
existing default vhost is winning the match. Confirm the new site is
enabled with `apache2ctl -S | grep otuburu` — the line should mention
the vhost file you just wrote.

---

## 5. Install certbot (one-time)

```bash
sudo apt-get update
sudo apt-get install -y certbot python3-certbot-apache
```

---

## 6. Request the certificate

Pick an email you'll actually see expiry-warning mail at (it's used only by
Let's Encrypt for renewal warnings — not published anywhere).

```bash
sudo certbot --apache \
  -d otuburu.torama.money \
  --redirect --agree-tos -m you@yourdomain --non-interactive
```

What certbot does:

1. Drops a token under `/var/www/otuburu/.well-known/acme-challenge/`.
2. Lets Encrypt fetches `http://otuburu.torama.money/.well-known/...`.
3. On success, certbot adds a `<VirtualHost *:443>` block to your config
   file with the cert paths.
4. Adds a permanent redirect from `:80` to `:443`.
5. Reloads Apache.

Expected output ends with something like:

```
Successfully received certificate.
Certificate is saved at: /etc/letsencrypt/live/otuburu.torama.money/fullchain.pem
Key is saved at:         /etc/letsencrypt/live/otuburu.torama.money/privkey.pem
This certificate expires on YYYY-MM-DD.
```

---

## 7. Verify HTTPS

```bash
# 80 → 301 → 443
curl -sI http://otuburu.torama.money | head -3
# expect: HTTP/1.1 301 Moved Permanently
#         Location: https://otuburu.torama.money/

curl -sI https://otuburu.torama.money | head -3
# expect: HTTP/1.1 200 OK

# show issuer + expiry so you know it's a real cert
echo | openssl s_client -servername otuburu.torama.money \
  -connect otuburu.torama.money:443 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
```

Then open <https://otuburu.torama.money> in a browser — you should see the
branded placeholder page with no certificate warnings.

---

## 8. Confirm auto-renewal is wired

Certbot installs a systemd timer that renews any time a cert is within 30
days of expiry. Verify:

```bash
systemctl list-timers | grep certbot
sudo certbot renew --dry-run         # should print "Congratulations, all renewals succeeded"
```

That's it. No further action is needed for cert renewal.

---

## What's set up after this step

- A dedicated Apache vhost for `otuburu.torama.money` independent of the
  `torama.money` landing-page vhost.
- A valid 90-day Let's Encrypt certificate with auto-renewal.
- A `noindex, nofollow` branded placeholder page so anyone who finds the
  URL sees something professional rather than the Apache default.

The vhost currently serves static files from `/var/www/otuburu`. The next
step (GitHub-based pull deploy) will edit this same vhost to add the
`ProxyPass` lines that route traffic to the Node engine running as the
`otuburu` system user — at which point the placeholder page is replaced
by the live dashboard. Cert and HTTPS-redirect remain untouched through
that change.
