# Otuburu Demo

Local proof-of-concept for the Otuburu synthetic brokerage (torama.money).

This is **not** the production system. It is a single-process Node.js app that
demonstrates the core mechanics described in the Architecture & Tech Plan:

- deterministic, seeded synthetic price-feed generators
- a tick-driven in-memory engine
- CFD positions with margin, mark-to-market, and stop-out
- digital options (Rise / Fall) with a calibrated payout margin (house edge)
- a WebSocket fan-out
- a live browser dashboard

The production engine will be Rust (see plan §5); the production services will
be Go (plan §6). This demo intentionally runs in pure Node so it can be started
on any laptop with one command.

## Run it

Requires Node.js 18 or newer.

```bash
cd otuburu-demo
npm install     # already done — run again if you delete node_modules
npm start
```

Then open <http://localhost:8080> in a browser.

To use a different port: `PORT=9000 npm start`.

## What you'll see

- Seven live charts ticking — BOOM1000, CRASH1000, BOOM500, frxEURUSD,
  frxGBPUSD, cryBTCUSD, cryETHUSD.
- A trade panel that lets you place CFD buys/sells and digital options.
- An account panel: balance, equity, used margin, free margin, margin level.
- A house P&L monitor: net P&L, spread captured, payout-margin earned,
  binary win-rate, and trade counts.
- Tables of open positions and open digital options.

## What the demo proves

| Plan section | Demonstrated in code |
| --- | --- |
| §8.2 Boom / Crash generator | `engine/generators.js` → `makeBoomCrash` |
| §8.3 Synthetic FX (Heston-lite) | `engine/generators.js` → `makeFxFeed` |
| §8.3 Synthetic Crypto (GBM + regime) | `engine/generators.js` → `makeCryptoFeed` |
| §9.1 Spread edge | `engine.js` → `house.totalSpreadCaptured` |
| §9.1 Payout margin (digital options) | `engine.js` → `PAYOUT_MULTIPLIER`, `BINARY_HOUSE_EDGE` |
| §5 Engine internals (in-memory + MTM) | `engine.js` |
| §5.2 Stop-out | `engine.js` → `marginLevel() < 50 → closeCfd(worst)` |
| WebSocket fan-out (gateway analogue) | `engine/server.js` |

The point of running it long enough is to see the **house net** number drift
upward on average even as individual binaries randomly win or lose — that's
the calibrated edge in action.

## What this demo intentionally omits

- Persistence (no Postgres, no WAL, no Object Storage)
- Multi-account, multi-shard
- KYC, AML, wallet, deposits/withdrawals
- TLS, auth, JWT
- Risk-engine exposure caps (a single demo account never trips them)
- ChaCha20 CSPRNG (uses Mulberry32 for speed — see `rng.js`)
- Seed commit-reveal scheme
- MT5 / cTrader bridges

All of these are in the plan and are next-phase work.

## File layout

```
otuburu-demo/
  engine/
    rng.js          deterministic PRNG + Gaussian + Poisson helpers
    generators.js   one tick generator per symbol; emits to a bus
    engine.js       account + position book + binary book + house stats
    server.js       Express REST + WebSocket fan-out
  web/
    index.html      single-file dashboard (Chart.js for charts)
  package.json
  README.md
```

This structure is the local-friendly mirror of the production monorepo layout
in Appendix C of the plan: `engine/` is what becomes the Rust workspace,
`web/` is what becomes the Next.js app.

## REST endpoints

| Method | Path | Body | Description |
| --- | --- | --- | --- |
| GET | `/api/symbols` | — | Tradable symbols. |
| GET | `/api/state` | — | Account, positions, binaries, quotes, house stats. |
| POST | `/api/order` | `{symbol, side: "BUY"\|"SELL", lots}` | Open a CFD position. |
| POST | `/api/close` | `{id}` | Close a CFD position. |
| POST | `/api/binary` | `{symbol, direction: "UP"\|"DOWN", stake, ticks}` | Place a digital option. |

## WebSocket

Connect to `ws://localhost:8080/ws`. Messages:

- `{type: "hello", symbols: [...]}` — on connect
- `{type: "tick", tick: {symbol, ts, mid, bid, ask}}` — every tick
- `{type: "state", state: {...}}` — every 500ms full snapshot
- `{type: "position-open"|"position-close"|"binary-open"|"binary-settled", ...}` — events

## Deployment

The demo is deployed to <https://otuburu.torama.money> via a private
GitHub repo and a manual pull-deploy on the Linode. Two short walkthroughs:

- [`TLS_SETUP.md`](./TLS_SETUP.md) — one-time setup of the Apache vhost and Let's Encrypt cert. Must be done first.
- [`GITHUB_SETUP.md`](./GITHUB_SETUP.md) — put the code on GitHub, install a read-only deploy key on the Linode, clone the repo, and run the first deploy.

After both are done, the day-to-day workflow is:

```bash
# on your laptop
git push
# on the Linode (one-shot)
ssh -p 2525 user1@104.237.157.53 'sudo /home/otuburu/app/scripts/deploy.sh'
```

### Repo layout for the deploy

```
otuburu-demo/
  engine/                Node engine + server (single-process for the demo)
  web/                   Single-file browser dashboard
  placeholder/           Branded "coming soon" page (pre-launch)
  infra/
    systemd/             otuburu.service — canonical systemd unit
    apache/              otuburu.torama.money.conf — canonical proxy vhost
  scripts/
    server-bootstrap.sh  one-shot first-time server setup (user, key, clone)
    deploy.sh            pull-deploy script (run on every push)
  TLS_SETUP.md           one-time TLS setup
  GITHUB_SETUP.md        one-time GitHub + deploy-key setup
  README.md              this file
```

## Operations cheat-sheet

```bash
# Tail logs (on the Linode)
sudo journalctl -u otuburu -f
sudo tail -f /home/otuburu/logs/otuburu.log /home/otuburu/logs/otuburu.err.log
sudo tail -f /var/log/apache2/otuburu_access.log /var/log/apache2/otuburu_error.log

# Restart the app (engine state is in-memory and will reset)
sudo systemctl restart otuburu

# Apache config changes
sudo apache2ctl configtest && sudo systemctl reload apache2

# Roll back to the previous good commit
sudo -u otuburu git -C /home/otuburu/app log --oneline -5
sudo -u otuburu git -C /home/otuburu/app reset --hard <SHA>
sudo systemctl restart otuburu

# Add HTTP basic-auth in front of the vhost for pre-launch
sudo apt-get install -y apache2-utils
sudo htpasswd -c /etc/apache2/.otuburu-htpasswd torama
# then in the <VirtualHost *:443> block add:
#   <Location />
#       AuthType Basic
#       AuthName "Otuburu (pre-launch)"
#       AuthUserFile /etc/apache2/.otuburu-htpasswd
#       Require valid-user
#   </Location>
```

## Next steps after this demo is live

1. **Repo scaffold for the real monorepo** (Rust + Go workspaces, GitHub Actions, Terraform).
2. **Linode provisioning** — VPC, LKE cluster, Object Storage buckets via Terraform.
3. **Port the engine to Rust** with a WAL and gRPC API matching this demo's REST.
4. **Stand up the first real service** (Account / Auth) in Go alongside the engine.
