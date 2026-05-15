#!/usr/bin/env bash
# watch-auth.sh — tail Otuburu wallet logs, highlighting auth events and errors.
#
# Usage:
#   bash /opt/otuburu/watch-auth.sh              # interactive, coloured output
#   bash /opt/otuburu/watch-auth.sh --plain      # no colours (for log files)
#
# To run in background and keep a persistent log:
#   nohup bash /opt/otuburu/watch-auth.sh --plain >> /var/log/otuburu-auth.log 2>&1 &

set -euo pipefail

CONTAINER="backend-wallet-1"
PLAIN=false
[[ "${1:-}" == "--plain" ]] && PLAIN=true

# ── Colour helpers ────────────────────────────────────────────────────────────
if $PLAIN; then
  red=""   green=""  yellow=""  cyan=""  grey=""  bold=""  reset=""
else
  red="\033[1;31m"  green="\033[1;32m"  yellow="\033[1;33m"
  cyan="\033[1;36m" grey="\033[0;37m"   bold="\033[1m"  reset="\033[0m"
fi

stamp() { date '+%Y-%m-%d %H:%M:%S'; }

banner() {
  echo -e "${bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${reset}"
  echo -e "${bold}  Otuburu Auth Monitor — container: ${CONTAINER}${reset}"
  echo -e "${bold}  Started: $(stamp)${reset}"
  echo -e "${bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${reset}"
}

# ── Check container is running ────────────────────────────────────────────────
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo -e "${red}ERROR: container '${CONTAINER}' is not running.${reset}" >&2
  echo "Running containers:" >&2
  docker ps --format '  {{.Names}}\t{{.Status}}' >&2
  exit 1
fi

banner

# ── Process each log line ─────────────────────────────────────────────────────
process_line() {
  local line="$1"
  local ts
  ts=$(stamp)

  # Skip pure noise (deposit/sweep polling with no event)
  if echo "$line" | grep -qE "monitor query err.*relation.*does not exist|sweep query err.*relation.*does not exist"; then
    # DB schema not applied yet — show once per minute, not every 30s
    echo -e "${yellow}[${ts}] DB SCHEMA MISSING — run: docker exec -i backend-postgres-1 psql -U otuburu -d otuburu < /opt/otuburu/backend/schema.sql${reset}"
    return
  fi

  # ── Login / auth events ───────────────────────────────────────────────────
  if echo "$line" | grep -qiE "google|auth|login|signin|sign.in|jwt|token|user.*creat|register|account"; then
    if echo "$line" | grep -qiE "error|err|fail|invalid|denied|unauthori[zs]ed|bad|reject|wrong"; then
      echo -e "${red}[${ts}] AUTH ERROR  │ ${line}${reset}"
    elif echo "$line" | grep -qiE "creat|new user|registered|welcome"; then
      echo -e "${green}[${ts}] NEW USER    │ ${line}${reset}"
    else
      echo -e "${cyan}[${ts}] AUTH EVENT  │ ${line}${reset}"
    fi
    return
  fi

  # ── Deposit / sweep events ────────────────────────────────────────────────
  if echo "$line" | grep -qiE "deposit|sweep|usdt|tron|treasury|withdraw"; then
    if echo "$line" | grep -qiE "error|err|fail"; then
      echo -e "${red}[${ts}] WALLET ERR  │ ${line}${reset}"
    else
      echo -e "${yellow}[${ts}] WALLET      │ ${line}${reset}"
    fi
    return
  fi

  # ── General errors ────────────────────────────────────────────────────────
  if echo "$line" | grep -qiE "error|err|panic|fatal|exception"; then
    echo -e "${red}[${ts}] ERROR       │ ${line}${reset}"
    return
  fi

  # ── Startup / info — show but dim ────────────────────────────────────────
  if echo "$line" | grep -qiE "INFO|started|ready|connected|listening"; then
    echo -e "${grey}[${ts}] INFO        │ ${line}${reset}"
    return
  fi

  # ── Everything else — pass through dimmed ────────────────────────────────
  echo -e "${grey}[${ts}] LOG         │ ${line}${reset}"
}

echo -e "${grey}Waiting for log lines...${reset}"
echo ""

# Follow logs from now, process each line
docker logs "${CONTAINER}" --follow --since 0m 2>&1 | while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  process_line "$line"
done
