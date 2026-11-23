# Database Failover Runbook

**Issue:** [#285](https://github.com/smokeylenz1-commits/stellar-nintendo-crest/issues/285)  
**Severity:** Critical  
**Service:** PostgreSQL primary + read-replica  
**Objective:** Promote the read-replica to primary within 30 seconds of a detected
primary failure, with zero data corruption and zero dropped transactions.

---

## Overview

iPredict runs a primary PostgreSQL instance (`predictify-postgres`) and at least one
streaming read-replica (`predictify-postgres-replica`). When the primary becomes
unreachable the application must reconnect to the promoted replica automatically.

This runbook describes:
1. How automatic failover works in normal operations.
2. The manual promotion procedure for cases where automatic failover stalls.
3. The chaos drill script that operations must run before each major release.

---

## Architecture

```
  ┌─────────────────────────────────────┐
  │           Application Tier          │
  │  API · Indexer · Oracle workers     │
  └────────────┬──────────┬─────────────┘
               │ writes   │ reads
               ▼          ▼
  ┌────────────────┐  ┌───────────────────────┐
  │   PRIMARY DB   │──│  READ REPLICA (async) │
  │  Port 5432     │  │  Port 5433            │
  └────────────────┘  └───────────────────────┘
```

Connection strings are injected via environment variables:
- `DATABASE_URL` — points to the primary at startup.
- `DATABASE_REPLICA_URL` — points to the replica; promoted to primary after failover.

The application layer (pg pool) uses a **connection retry loop with exponential
back-off** (max 30 s, 6 attempts). On exhaustion it switches to `DATABASE_REPLICA_URL`.

---

## Automatic Failover Steps (Managed Postgres / Patroni)

When using a Patroni-managed cluster or a managed Postgres service (e.g. AWS RDS
Multi-AZ, Supabase HA):

1. The health-check probe (`scripts/db-health-probe.sh`) detects the primary is
   unreachable within one probe cycle (default: 5 s interval, 3 consecutive failures).
2. The cluster orchestrator promotes the replica and updates the DNS entry / VIP.
3. The application connection pool detects the disconnect, retries, and reconnects
   to the new primary at the same hostname within ≤ 30 s.
4. `scripts/db-health-probe.sh` confirms the promoted replica is accepting writes
   before clearing the incident.

---

## Manual Promotion Procedure

Follow these steps only if automatic failover does not complete within 60 seconds.

### Step 1 — Confirm the primary is unreachable

```bash
# From any app server or bastion host:
pg_isready -h "$PRIMARY_HOST" -U predictify -d predictify -t 5
# Expected on failure: "no response"
```

### Step 2 — Verify replica lag before promotion

```bash
psql "$DATABASE_REPLICA_URL" -c "SELECT now() - pg_last_xact_replay_timestamp() AS replica_lag;"
# If lag > 60 s, alert the on-call lead before promoting — data may be behind.
```

### Step 3 — Promote the replica

```bash
# For Patroni-managed clusters:
patronictl -c /etc/patroni/patroni.yml failover predictify-cluster --master "$PRIMARY_HOST" --candidate "$REPLICA_HOST" --force

# For vanilla streaming replication (pg_ctl):
psql "$DATABASE_REPLICA_URL" -c "SELECT pg_promote();"
# Or via pg_ctl on the replica host:
# pg_ctl promote -D /var/lib/postgresql/data
```

### Step 4 — Update the application connection string

```bash
# Update the DATABASE_URL secret to point to the promoted replica:
./scripts/rotate-secrets.ts --key DATABASE_URL --value "$DATABASE_REPLICA_URL"

# Rolling restart to pick up the new connection string:
docker compose restart api indexer oracle
```

### Step 5 — Verify writes are flowing

```bash
psql "$DATABASE_URL" -c "INSERT INTO _failover_check (ts) VALUES (now());"
psql "$DATABASE_URL" -c "SELECT ts FROM _failover_check ORDER BY ts DESC LIMIT 1;"
```

### Step 6 — Confirm application health

```bash
curl -sf http://localhost:3001/health | jq '.database'
# Expected: { "status": "ok", "primary": true, "replica_lag_ms": 0 }
```

### Step 7 — Provision a new replica

After the incident, stand up a new streaming replica against the promoted primary
and re-attach it. Update `DATABASE_REPLICA_URL` once it has caught up.

---

## Chaos Drill Procedure

Run `scripts/db-failover-drill.sh` in the staging environment before every major
release. The script automates steps 1–6 above and asserts:

- Reconnection completes within 30 seconds.
- No transactions are dropped (checked via a counter table).
- Application health endpoint returns `{ "status": "ok" }` after failover.

```bash
# Usage:
./scripts/db-failover-drill.sh \
  --primary-url   "$DATABASE_URL" \
  --replica-url   "$DATABASE_REPLICA_URL" \
  --app-health    "http://localhost:3001/health" \
  --timeout-secs  30

# Exit codes:
#   0  — drill passed (reconnection ≤ 30 s, zero dropped transactions)
#   1  — reconnection timed out
#   2  — data corruption detected (counter mismatch)
#   3  — health endpoint did not recover
```

The drill must be **reviewed and signed off** by the operations lead before the
release is promoted to production.

---

## Acceptance Checklist

| # | Check | Owner | Status |
|---|-------|-------|--------|
| 1 | Application reconnects to promoted replica within 30 s | Engineering | ☐ |
| 2 | Zero dropped transactions during the failover window | Engineering | ☐ |
| 3 | Chaos drill script passes in staging before every release | Operations | ☐ |
| 4 | Health probe detects primary failure within 15 s | SRE | ☐ |
| 5 | Runbook reviewed and signed off by on-call lead | Operations | ☐ |

---

## Monitoring

- **Prometheus alert:** `PostgresPrimaryDown` — fires when the health probe returns
  non-zero for 3 consecutive checks.
- **Dashboard:** Grafana → "Database" → panel "Primary reachability" and "Replica lag".
- **Log label:** `service=postgres`, `event=failover_started` / `event=failover_complete`.

---

## Related Documents

- [RUNBOOK_INDEX.md](./RUNBOOK_INDEX.md)
- [DEPLOYMENT-GUIDE.md](./DEPLOYMENT-GUIDE.md)
- [SECRET-ROTATION.md](./SECRET-ROTATION.md)
