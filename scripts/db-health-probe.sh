#!/usr/bin/env bash
# db-health-probe.sh — Continuous PostgreSQL primary/replica health probe.
#
# Issue: #285 (feat(infra): implement automated database failover drill playbook)
#
# Runs in a tight loop, probing the primary and replica at a configurable
# interval. Exits non-zero (and prints a machine-readable JSON status to stdout)
# after FAIL_THRESHOLD consecutive primary failures, so it can be called from
# a process supervisor, Kubernetes liveness probe, or the failover drill script.
#
# Usage:
#   DATABASE_URL="postgres://..." DATABASE_REPLICA_URL="postgres://..." \
#     ./scripts/db-health-probe.sh [--interval N] [--threshold N] [--once]
#
#   --interval N    Seconds between probe cycles (default: 5)
#   --threshold N   Consecutive failures before exit 1 (default: 3)
#   --once          Run a single probe cycle and exit (useful in CI)
#
# Output: each cycle writes one JSON line to stdout, e.g.:
#   {"ts":"2025-01-01T00:00:00Z","primary":"ok","replica":"ok","replica_lag_ms":12}
#   {"ts":"2025-01-01T00:00:05Z","primary":"down","replica":"ok","replica_lag_ms":18}
#
# Exit codes:
#   0  — probe healthy (or --once succeeded)
#   1  — primary down for >= FAIL_THRESHOLD consecutive cycles
#   2  — missing required environment variables

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
INTERVAL=5
FAIL_THRESHOLD=3
ONCE=false

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval)   INTERVAL="$2";   shift 2 ;;
    --threshold)  FAIL_THRESHOLD="$2"; shift 2 ;;
    --once)       ONCE=true;        shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

# ── Validate required environment variables ───────────────────────────────────
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo '{"error":"DATABASE_URL is not set"}' >&2
  exit 2
fi

REPLICA_URL="${DATABASE_REPLICA_URL:-}"

# ── Helper: probe a single postgres URL ───────────────────────────────────────
# Returns "ok" or "down", and sets REPLICA_LAG_MS to the lag in ms if URL is
# a replica.
probe_pg() {
  local url="$1"
  local timeout_secs=4

  if pg_isready -d "$url" -t "$timeout_secs" >/dev/null 2>&1; then
    echo "ok"
  else
    echo "down"
  fi
}

# ── Helper: get replica lag in milliseconds ───────────────────────────────────
get_replica_lag_ms() {
  local url="$1"
  # Returns the replication lag in ms, or -1 on error.
  psql "$url" --no-align --tuples-only -c \
    "SELECT COALESCE(EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000, 0)::bigint;" \
    2>/dev/null || echo "-1"
}

# ── Main probe loop ───────────────────────────────────────────────────────────
consecutive_primary_failures=0

while true; do
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Probe primary
  primary_status="$(probe_pg "$DATABASE_URL")"

  # Probe replica (if configured)
  if [[ -n "$REPLICA_URL" ]]; then
    replica_status="$(probe_pg "$REPLICA_URL")"
    replica_lag_ms="$(get_replica_lag_ms "$REPLICA_URL" | tr -d '[:space:]')"
  else
    replica_status="unconfigured"
    replica_lag_ms=0
  fi

  # Build JSON status line
  echo "{\"ts\":\"${ts}\",\"primary\":\"${primary_status}\",\"replica\":\"${replica_status}\",\"replica_lag_ms\":${replica_lag_ms}}"

  # Track consecutive primary failures
  if [[ "$primary_status" == "down" ]]; then
    (( consecutive_primary_failures++ )) || true
    echo "{\"ts\":\"${ts}\",\"alert\":\"primary_down\",\"consecutive_failures\":${consecutive_primary_failures},\"threshold\":${FAIL_THRESHOLD}}" >&2
    if [[ "$consecutive_primary_failures" -ge "$FAIL_THRESHOLD" ]]; then
      echo "{\"ts\":\"${ts}\",\"alert\":\"FAILOVER_REQUIRED\",\"message\":\"Primary has been down for ${consecutive_primary_failures} consecutive checks — initiate failover\"}" >&2
      exit 1
    fi
  else
    consecutive_primary_failures=0
  fi

  # --once: exit after first successful cycle
  if [[ "$ONCE" == "true" ]]; then
    if [[ "$primary_status" == "ok" ]]; then
      exit 0
    else
      exit 1
    fi
  fi

  sleep "$INTERVAL"
done
