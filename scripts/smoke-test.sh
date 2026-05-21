#!/usr/bin/env bash
# Production smoke test for recruitment-email-automation.
#
# Runs a sequence of unauthenticated HTTP checks against the deployed API and
# frontend, printing PASS/FAIL per check. Exits 0 only if every check passes.
#
# Usage:
#   ./scripts/smoke-test.sh [BASE_URL]
#
# Default BASE_URL: https://recruiting-email-automation-api.vercel.app

set -u
set -o pipefail

BASE_URL="${1:-https://recruiting-email-automation-api.vercel.app}"
BASE_URL="${BASE_URL%/}"

# ANSI colours (skip if not a TTY).
if [ -t 1 ]; then
  GREEN=$'\033[32m'
  RED=$'\033[31m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
else
  GREEN=""
  RED=""
  BOLD=""
  RESET=""
fi

PASS_COUNT=0
TOTAL=7

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command '$1' not found in PATH" >&2
    exit 2
  fi
}

require_cmd curl
require_cmd jq

# Run a request and split body / status code. Echoes body on stdout and writes
# status code to the global STATUS variable.
http() {
  local method="$1"; shift
  local url="$1"; shift
  local tmp
  tmp=$(mktemp)
  STATUS=$(curl -s -o "$tmp" -w "%{http_code}" -X "$method" "$@" "$url" || echo "000")
  BODY=$(cat "$tmp")
  rm -f "$tmp"
}

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "  ${GREEN}PASS${RESET}  $1"
}

fail() {
  echo "  ${RED}FAIL${RESET}  $1"
  if [ -n "${2:-}" ]; then
    echo "        reason: $2"
  fi
}

echo "${BOLD}Production smoke test${RESET}"
echo "Base URL: $BASE_URL"
echo

# ---- Check 1: GET /api/health -> 200 + healthy ------------------------------
echo "[1/${TOTAL}] GET /api/health"
http GET "$BASE_URL/api/health" --max-time 15
if [ "$STATUS" != "200" ]; then
  fail "GET /api/health" "expected HTTP 200, got $STATUS"
else
  status_field=$(echo "$BODY" | jq -r '.data.status // empty' 2>/dev/null || true)
  if [ "$status_field" = "healthy" ]; then
    pass "GET /api/health -> 200 + data.status=healthy"
  else
    fail "GET /api/health" "expected data.status=healthy, got '${status_field:-missing}'"
  fi
fi

# ---- Check 2: GET /api/mailboxes without auth -> 401 ------------------------
echo "[2/${TOTAL}] GET /api/mailboxes (no auth)"
http GET "$BASE_URL/api/mailboxes" --max-time 15
if [ "$STATUS" = "401" ]; then
  pass "GET /api/mailboxes -> 401 without auth"
else
  fail "GET /api/mailboxes" "expected HTTP 401, got $STATUS"
fi

# ---- Check 3: POST /api/auth/google with empty body -> 400 ------------------
echo "[3/${TOTAL}] POST /api/auth/google (empty body)"
http POST "$BASE_URL/api/auth/google" \
  -H 'Content-Type: application/json' \
  --data '{}' \
  --max-time 15
if [ "$STATUS" = "400" ]; then
  pass "POST /api/auth/google -> 400 with empty body"
else
  fail "POST /api/auth/google" "expected HTTP 400, got $STATUS"
fi

# ---- Check 4: GET /api/auth/me with junk Bearer -> 401 ----------------------
echo "[4/${TOTAL}] GET /api/auth/me (junk Bearer)"
http GET "$BASE_URL/api/auth/me" \
  -H 'Authorization: Bearer not-a-real-token' \
  --max-time 15
if [ "$STATUS" = "401" ]; then
  pass "GET /api/auth/me -> 401 with junk Bearer"
else
  fail "GET /api/auth/me" "expected HTTP 401, got $STATUS"
fi

# ---- Check 5: GET / -> 200 + frontend HTML ----------------------------------
echo "[5/${TOTAL}] GET / (frontend root)"
http GET "$BASE_URL/" --max-time 15
if [ "$STATUS" != "200" ]; then
  fail "GET /" "expected HTTP 200, got $STATUS"
elif echo "$BODY" | grep -q '<title>Archive Recruiting AI</title>'; then
  pass "GET / -> 200 + index.html"
else
  fail "GET /" "expected <title>Archive Recruiting AI</title> in body"
fi

# ---- Check 6: GET /login -> 200 + SPA fallback ------------------------------
echo "[6/${TOTAL}] GET /login (SPA fallback)"
http GET "$BASE_URL/login" --max-time 15
if [ "$STATUS" != "200" ]; then
  fail "GET /login" "expected HTTP 200, got $STATUS"
elif echo "$BODY" | grep -q '<title>Archive Recruiting AI</title>'; then
  pass "GET /login -> 200 + index.html"
else
  fail "GET /login" "expected <title>Archive Recruiting AI</title> in body"
fi

# ---- Check 7: GET /api/internal/sync-health without auth -> 401 -------------
echo "[7/${TOTAL}] GET /api/internal/sync-health (no auth)"
http GET "$BASE_URL/api/internal/sync-health" --max-time 15
if [ "$STATUS" = "401" ]; then
  pass "GET /api/internal/sync-health -> 401 without auth"
else
  fail "GET /api/internal/sync-health" "expected HTTP 401, got $STATUS"
fi

echo
if [ "$PASS_COUNT" -eq "$TOTAL" ]; then
  echo "${BOLD}${GREEN}PASSED: ${PASS_COUNT}/${TOTAL}${RESET}"
  exit 0
else
  echo "${BOLD}${RED}PASSED: ${PASS_COUNT}/${TOTAL}${RESET}"
  exit 1
fi
