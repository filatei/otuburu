#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Otuburu backend monitor — run on the server while users are active
# Usage:
#   bash /opt/otuburu/backend/monitor.sh          # full live log tail
#   bash /opt/otuburu/backend/monitor.sh status   # one-shot health snapshot
#   bash /opt/otuburu/backend/monitor.sh errors   # errors only (last 100 lines)
#   bash /opt/otuburu/backend/monitor.sh staking  # staking service only
#   bash /opt/otuburu/backend/monitor.sh engine   # engine + gateway only
# ─────────────────────────────────────────────────────────────────────────────

COMPOSE=/opt/otuburu/backend/docker-compose.yml
API=https://otuburu.torama.money
MODE=${1:-live}

# ── colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'   GREEN='\033[0;32m'  YELLOW='\033[1;33m'
CYAN='\033[0;36m'  BOLD='\033[1m'      DIM='\033[2m'        NC='\033[0m'

banner() {
  printf "\n${BOLD}${CYAN}══════════════════════════════════════════════════════${NC}\n"
  printf "${BOLD}${CYAN}  🎰  OTUBURU MONITOR — $(date '+%Y-%m-%d %H:%M:%S %Z')  ${NC}\n"
  printf "${BOLD}${CYAN}══════════════════════════════════════════════════════${NC}\n\n"
}

# ── One-shot status snapshot ──────────────────────────────────────────────────
status_snapshot() {
  banner

  printf "${BOLD}Container health:${NC}\n"
  docker ps --filter name=backend- --format \
    "  {{.Names}}\t{{.Status}}\t{{.Ports}}" | column -t
  echo

  printf "${BOLD}API endpoints:${NC}\n"
  for ep in \
      "gateway   http://127.0.0.1:8082/healthz" \
      "wallet    http://127.0.0.1:8083/healthz" \
      "staking   http://127.0.0.1:8084/healthz" ; do
    name=$(echo "$ep" | awk '{print $1}')
    url=$(echo  "$ep" | awk '{print $2}')
    resp=$(curl -fsS --max-time 3 "$url" 2>/dev/null)
    if [ $? -eq 0 ]; then
      printf "  ${GREEN}✓${NC} %-10s %s\n" "$name" "$resp"
    else
      printf "  ${RED}✗${NC} %-10s ${RED}NOT RESPONDING${NC}\n" "$name"
    fi
  done
  echo

  printf "${BOLD}Engine state:${NC}\n"
  state=$(curl -fsS --max-time 3 \
    "http://127.0.0.1:8082/api/state?account_id=00000000-0000-4000-8000-000000000001" \
    2>/dev/null)
  if [ $? -eq 0 ] && [ -n "$state" ]; then
    bal=$(echo "$state" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); \
       a=d.get('account',{}); \
       print(f\"  balance=\${a.get('balance',0):.2f}  equity=\${a.get('equity',0):.2f}  positions={len(d.get('positions',[]))}  binaries={len(d.get('binaries',[]))}\")" \
      2>/dev/null || echo "  (parse error)")
    printf "${GREEN}${bal}${NC}\n"
  else
    printf "  ${RED}engine not responding${NC}\n"
  fi
  echo

  printf "${BOLD}Staking DB (last 5 stakes):${NC}\n"
  sqlite3 /opt/otuburu/backend/staking.db \
    "SELECT id, user_id, amount_usd, status, created_at FROM stakes ORDER BY created_at DESC LIMIT 5;" \
    2>/dev/null | column -t -s '|' \
    || printf "  ${DIM}(no staking.db yet or sqlite3 not installed)${NC}\n"
  echo

  printf "${BOLD}Recent errors (last 20 lines across all services):${NC}\n"
  docker compose -f "$COMPOSE" logs --no-log-prefix --since 30m 2>/dev/null \
    | grep -iE "(error|fatal|panic|failed|exception|crash|WARN)" \
    | tail -20 \
    | sed "s/.*/${RED}&${NC}/" \
    || printf "  ${GREEN}No errors in last 30 minutes${NC}\n"
  echo
}

# ── Errors-only tail ──────────────────────────────────────────────────────────
errors_only() {
  banner
  printf "${YELLOW}Tailing errors across all services (Ctrl-C to stop)…${NC}\n\n"
  docker compose -f "$COMPOSE" logs -f --no-log-prefix 2>/dev/null \
    | grep -iE --line-buffered "(error|fatal|panic|failed|exception|crash|WARN)"
}

# ── Service-specific tail ─────────────────────────────────────────────────────
tail_service() {
  local svc=$1
  banner
  printf "${YELLOW}Tailing ${BOLD}${svc}${NC}${YELLOW} logs (Ctrl-C to stop)…${NC}\n\n"
  docker compose -f "$COMPOSE" logs -f --no-log-prefix "$svc" 2>/dev/null
}

# ── Full live tail (all services, colour-coded by prefix) ─────────────────────
live_tail() {
  banner
  printf "${YELLOW}Live log tail — all Otuburu services (Ctrl-C to stop)${NC}\n"
  printf "${DIM}  gateway=cyan  engine=green  wallet=yellow  staking=magenta${NC}\n\n"

  # Multiplex docker compose logs with coloured prefixes
  docker compose -f "$COMPOSE" logs -f --no-log-prefix \
    --names gateway engine wallet staking 2>/dev/null \
  | awk '
    /backend-gateway/  { printf "\033[0;36m[gateway] \033[0m"; print; next }
    /backend-engine/   { printf "\033[0;32m[engine]  \033[0m"; print; next }
    /backend-wallet/   { printf "\033[1;33m[wallet]  \033[0m"; print; next }
    /backend-staking/  { printf "\033[0;35m[staking] \033[0m"; print; next }
                       { print }
  ' \
  || docker compose -f "$COMPOSE" logs -f 2>/dev/null
}

# ── Dispatch ──────────────────────────────────────────────────────────────────
case "$MODE" in
  status)  status_snapshot ;;
  errors)  errors_only ;;
  staking) tail_service staking ;;
  engine)  docker compose -f "$COMPOSE" logs -f --no-log-prefix engine gateway 2>/dev/null ;;
  wallet)  tail_service wallet ;;
  live|*)  live_tail ;;
esac
