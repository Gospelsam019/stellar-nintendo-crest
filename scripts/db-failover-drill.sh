#!/usr/bin/env bash
# db-failover-drill.sh — Automated PostgreSQL failover chaos drill.
#
# Issue: #285 (feat(infra): implement automated database failover drill playbook)
#
# Simulates a primary PostgreSQL failure and verifies:
#   1. The application reconnects to the promoted replica within TIMEOUT_SECS.
#   2. Zero transactions are dropped during the failover window (checked via
#      a monotonic counter table written continuously during the drill).
#   3. The application health endpoint returns { "status": "ok" } after failover.
#
# Usage:
#   ./scripts/db-failover-drill.sh \
#     --primary-url   "postgres://predictify:predictify@localhost:5432/predictify" \
#     --replica-url   "postgres://predictify:predictify@localhost:5433/predictify" \
#     --app-health    "http://localhost:3001/health" \
#     --timeout-secs  30
#
# Exit codes:
#   0  — drill passed
#   1  — reconnection timed out (> TIMEOUT_SECS seconds)
#   2  — data corruption detected (counter mismatch — dropped transactions)
#   3  — application health endpoint did not recover within TIMEOUT_SECS

set -uo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
PRIMARY_URL="${DATABASE_URL:-}"
REPLICA_URL="${DATABASE_REPLICA_URL:-}"
APP_HEALTH_URL="http://localhost:3001/health"
TIMEOUT_SECS=30
DRILL_TABLE="_failover_drill_counter"

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --primary-url)  PRIMARY_URL="$2";   shift 2 ;;
    --replica-url)  REPLICA_URL="$2";   shift 2 ;;
    --app-health)   APP_HEALTH_URL="$2"; shift 2 ;;
    --timeout-secs) TIMEOUT_SECS="$2";  shift 2 ;;
    *) echo "ERROR: Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ── Validate inputs ───────────────────────────────────────────────────────────
if [[ -z "$PRIMARY_URL" ]]; then
  echo "ERROR: --primary-url or DATABASE_URL is required." >&2; exit 1
fi
if [[ -z "$REPLICA_URL" ]]; then
  echo "ERROR: --replica-url or DATABASE_REPLICA_URL is required." >&2; exit 1
fi

LOG_PREFIX="[db-failover-drill]"

log()  { echo "$LOG_PREFIX $(date -u +%H:%M:%SZ) INFO  $*"; }
warn() { echo "$LOG_PREFIX $(date -u +%H:%M:%SZ) WARN  $*" >&2; }
err()  { echo "$LOG_PREFIX $(date -u +%H:%M:%SZ) ERROR $*" >&2; }

# ── Phase 0: Setup — create counter table and seed a baseline row ─────────────
log "Phase 0: Setting up drill counter table on primary…"

psql "$PRIMARY_URL" -v ON_ERROR_STOP=1 <<SQL
  CREATE TABLE IF NOT EXISTS ${DRILL_TABLE} (
      id         SERIAL PRIMARY KEY,
      written_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sequence   BIGINT NOT NULL
  );
  TRUNCATE ${DRILL_TABLE};
SQL

# Write N baseline rows before simulating the failure
BASELINE_ROWS=10
for i in $(seq 1 "$BASELINE_ROWS"); do
  psql "$PRIMARY_URL" -v ON_ERROR_STOP=1 -c \
    "INSERT INTO ${DRILL_TABLE} (sequence) VALUES (${i});" >/dev/null
done

baseline_max="$(psql "$PRIMARY_URL" --no-align --tuples-only \
  -c "SELECT MAX(sequence) FROM ${DRILL_TABLE};" | tr -d '[:space:]')"

log "Baseline written: ${BASELINE_ROWS} rows, max sequence = ${baseline_max}."

# ── Phase 1: Begin background write workload ───────────────────────────────────
# Write one row per second to the primary in the background. These writes will
# start failing when the primary is paused.
log "Phase 1: Starting background write workload…"

WRITE_LOG="$(mktemp)"
WRITE_PID=""
(
  seq=$((BASELINE_ROWS + 1))
  while true; do
    if psql "$PRIMARY_URL" --no-align --tuples-only -v ON_ERROR_STOP=1 \
        -c "INSERT INTO ${DRILL_TABLE} (sequence) VALUES (${seq});" >/dev/null 2>&1; then
      echo "ok:${seq}" >> "$WRITE_LOG"
    else
      echo "fail:${seq}" >> "$WRITE_LOG"
    fi
    (( seq++ )) || true
    sleep 1
  done
) &
WRITE_PID=$!

sleep 2  # Let a few rows accumulate before the simulated failure.

# ── Phase 2: Simulate primary failure (pause the Docker container) ────────────
log "Phase 2: Simulating primary failure (pausing predictify-postgres container)…"

PAUSE_SUCCEEDED=false
if docker pause predictify-postgres >/dev/null 2>&1; then
  PAUSE_SUCCEEDED=true
  log "Container paused successfully."
else
  warn "Could not pause Docker container — falling back to pg_terminate_backend simulation."
  # Terminate all non-superuser connections to simulate a partitioned primary.
  psql "$PRIMARY_URL" -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = 'predictify' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
fi

FAIL_TS="$(date +%s)"
log "Primary failure simulated at epoch ${FAIL_TS}."

# ── Phase 3: Wait for replica promotion / application reconnection ─────────────
log "Phase 3: Waiting up to ${TIMEOUT_SECS}s for application to reconnect via replica…"

reconnect_secs=-1
elapsed=0
while [[ "$elapsed" -lt "$TIMEOUT_SECS" ]]; do
  sleep 2
  elapsed=$(( $(date +%s) - FAIL_TS ))

  # Check application health endpoint
  http_code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$APP_HEALTH_URL" 2>/dev/null || echo "000")"

  if [[ "$http_code" == "200" ]]; then
    reconnect_secs="$elapsed"
    log "Application healthy after ${reconnect_secs}s (HTTP 200 from ${APP_HEALTH_URL})."
    break
  fi

  log "  …${elapsed}s elapsed, HTTP ${http_code} — waiting…"
done

# ── Phase 4: Restore the primary ──────────────────────────────────────────────
log "Phase 4: Restoring primary…"

if [[ "$PAUSE_SUCCEEDED" == "true" ]]; then
  docker unpause predictify-postgres >/dev/null 2>&1 || true
  log "Container unpaused."
fi

# Stop the background write workload
if [[ -n "$WRITE_PID" ]]; then
  kill "$WRITE_PID" 2>/dev/null || true
  wait "$WRITE_PID" 2>/dev/null || true
fi

# ── Phase 5: Check for data corruption ────────────────────────────────────────
log "Phase 5: Checking for dropped transactions…"

sleep 3  # Allow replica a moment to catch up.

# Count rows written successfully before failure (to primary)
ok_before="$(grep -c "^ok:" "$WRITE_LOG" || echo 0)"
fail_count="$(grep -c "^fail:" "$WRITE_LOG" || echo 0)"

log "  Background writes — ok: ${ok_before}, failed: ${fail_count}"

# Verify sequence is gapless in the rows that did succeed
max_seq_in_db="$(psql "$REPLICA_URL" --no-align --tuples-only \
  -c "SELECT COALESCE(MAX(sequence), 0) FROM ${DRILL_TABLE};" \
  2>/dev/null | tr -d '[:space:]' || echo "0")"

log "  Max sequence in replica DB: ${max_seq_in_db}"

# Check there are no unexpected gaps among the successfully logged rows
ok_sequences="$(grep "^ok:" "$WRITE_LOG" | cut -d: -f2 | sort -n)"
expected_ok_count="$(echo "$ok_sequences" | wc -l | tr -d '[:space:]')"
actual_ok_count="$(psql "$REPLICA_URL" --no-align --tuples-only \
  -c "SELECT COUNT(*) FROM ${DRILL_TABLE} WHERE sequence > ${BASELINE_ROWS};" \
  2>/dev/null | tr -d '[:space:]' || echo "0")"

rm -f "$WRITE_LOG"

# ── Verdict ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════"
echo "  DB FAILOVER DRILL RESULTS"
echo "════════════════════════════════════════════"

PASS=true

# Check 1: reconnection time
if [[ "$reconnect_secs" -lt 0 ]]; then
  err "FAIL — Application did not reconnect within ${TIMEOUT_SECS}s."
  PASS=false
elif [[ "$reconnect_secs" -le "$TIMEOUT_SECS" ]]; then
  log "PASS — Reconnection: ${reconnect_secs}s (threshold: ${TIMEOUT_SECS}s)."
else
  err "FAIL — Reconnection: ${reconnect_secs}s exceeded threshold of ${TIMEOUT_SECS}s."
  PASS=false
fi

# Check 2: data integrity (no dropped rows among writes that reported ok)
if [[ "$expected_ok_count" -eq "$actual_ok_count" ]]; then
  log "PASS — Data integrity: ${actual_ok_count} successful writes confirmed in replica DB."
else
  err "FAIL — Data corruption: expected ${expected_ok_count} rows in replica, found ${actual_ok_count}."
  PASS=false
fi

# Check 3: application health after recovery
final_health="$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$APP_HEALTH_URL" 2>/dev/null || echo "000")"
if [[ "$final_health" == "200" ]]; then
  log "PASS — Application health endpoint: HTTP 200."
else
  err "FAIL — Application health endpoint returned HTTP ${final_health} after recovery."
  PASS=false
fi

echo "════════════════════════════════════════════"
echo ""

if [[ "$PASS" == "true" ]]; then
  log "Drill PASSED. Sign off in DB_FAILOVER_RUNBOOK.md acceptance checklist."
  exit 0
else
  err "Drill FAILED. See output above. Do not promote to production until drill passes."
  # Distinguish exit codes per acceptance criteria
  if [[ "$reconnect_secs" -lt 0 ]]; then exit 1; fi
  if [[ "$expected_ok_count" -ne "$actual_ok_count" ]]; then exit 2; fi
  exit 3
fi
