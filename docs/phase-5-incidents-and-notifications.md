# APIDash — Phase 5: Incident Detection, Lifecycle Management & Reliable Email Notifications

## 1. Overview and Core Philosophy

Phase 5 introduces durable incident detection, lifecycle tracking, and asynchronous email alert delivery to APIDash. 

Instead of spamming alerts on every isolated HTTP glitch, APIDash implements a deterministic, state-machine driven incident lifecycle anchored to consecutive observations:
- **Unhealthy Threshold:** 2 consecutive unhealthy observations (`failed` or `error`) open exactly one incident and enqueue one `incident_opened` outbox notification.
- **Recovery Threshold:** 2 consecutive passing observations (`passed`) resolve the active incident and enqueue one `incident_resolved` outbox notification.
- **Isolation:** A single failure never opens an incident; a single pass never resolves an open incident.

---

## 2. Result Semantics vs Incidents

APIDash distinguishes individual test results from persistent incidents:

| State | Scope | Description |
|---|---|---|
| `passed` | Per execution | HTTP request succeeded and all configured assertions evaluated to true. Healthy. |
| `failed` | Per execution | HTTP response was received, but one or more assertions failed. Unhealthy. |
| `error` | Per execution | Transport failure (DNS failure, network timeout, connection refused, TLS error). Unhealthy. |
| **Incident** | Multi-execution state | Persistent operational state spanning consecutive unhealthy observations. At most one open incident exists per monitor at any time. |

---

## 3. Incident Lifecycle State Machine

```
                      +-----------------------------+
                      |                             |
                      v                             |
              [ 0 Healthy / 0 Unhealthy ]           | 2 Consecutive
                      |                             | Passes
                      | 1st Unhealthy               |
                      v                             |
              [ 1 Unhealthy ]                       |
             /               \                      |
1st Healthy /                 \ 2nd Unhealthy       |
           v                   v                    |
     [ Reset to 0 ]    [ INCIDENT OPENED ]          |
                              |   ^                 |
                  Unhealthy   |   | 1st Unhealthy   |
                  (Update)    v   | (Reset pass)    |
                       [ 1 Healthy While Open ] ----+
```

### Transition Invariants:
1. **First Unhealthy Observation Anchor:** When the first failure occurs, `first_unhealthy_at` and `first_unhealthy_result_id` are anchored in `monitor_health_states`.
2. **Detection & Opening:** On the second consecutive failure, an incident is created in `incidents` with:
   - `status = 'open'`
   - `first_unhealthy_at`: anchored from the first failure.
   - `opened_at`: timestamp of the threshold crossing.
   - `first_result_id`: the result ID that began the streak.
   - `trigger_result_id`: the result ID that crossed the threshold.
   - `error_summary`: concise, sanitized failure summary.
3. **Active Incident Uniqueness:** Database-enforced via virtual generated column and unique index:
   ```sql
   active_api_id INT GENERATED ALWAYS AS (IF(status = 'open', api_id, NULL)) VIRTUAL,
   UNIQUE KEY uk_active_incident_per_api (active_api_id)
   ```
   InnoDB allows multiple `NULL` entries for resolved incidents, but guarantees that no two rows can simultaneously have `active_api_id = api_id`.
4. **Resolution:** Two consecutive `passed` results transition the incident to `status = 'resolved'`, set `resolved_at = NOW()`, record `resolution_result_id`, and enqueue `incident_resolved`.
5. **Post-Resolution:** Once resolved, subsequent failures begin a fresh streak. The resolved incident remains permanently in audit history.

---

## 4. Transaction Boundary & Idempotency

All monitoring runs (both manual runs via API and scheduled runs via background worker) execute through the unified `monitoringCoordinator` and `incidentService`:
1. The outbound HTTP request executes **outside** any database transaction.
2. A single atomic MySQL transaction:
   - Derives authoritative `workspace_id` by locking `apis` with `FOR UPDATE`.
   - Rejects incident evaluation for legacy unassigned monitors (`apis.workspace_id IS NULL`).
   - Persists the test result in `test_results`.
   - Records the result in `result_processing_ledger (result_id, api_id)`. If duplicate, transaction safely terminates without double-counting streaks.
   - Loads and row-locks `monitor_health_states`.
   - Evaluates the state transition and updates/creates the `incidents` row.
   - Enqueues logical notification events in `notification_outbox` with unique idempotency keys (`incident:{id}:opened`, `incident:{id}:resolved`).
   - Commits.

---

## 5. Durable MySQL Outbox & Asynchronous Dispatcher

### Delivery Architecture
- `notification_outbox` stores pending and processing delivery jobs.
- Workers atomically claim eligible events using MySQL 8 `FOR UPDATE SKIP LOCKED` and database server time `NOW()`.
- Outbox index `(next_attempt_at, delivery_state, lease_expires_at)` ensures efficient row-level locking without gap lock collisions across concurrent dispatchers.
- Finite lease duration (default 60s) with conditional lease ownership tokens prevents stale workers from overwriting newer claims.

### Delivery Guarantees: At-Least-Once Delivery
- APIDash provides durable **at-least-once** delivery.
- If an email transport accepts a message and the worker process crashes before committing the `delivery_state = 'sent'` update, the expired lease will be recovered and the email may be redelivered.
- Exactly-once delivery across external distributed SMTP boundaries is impossible; idempotency keys and stable deduplication keys in email headers minimize duplicate impact.

### Retry & Backoff Policy
- Transient SMTP failures trigger exponential backoff: `Math.min(3600, 2^attempt * 10s + jitter)`.
- Delivery attempts are bounded by `max_attempts` (default 5).
- Exhausted jobs transition to `dead_letter` for operator inspection.

### Missing SMTP Configuration Behavior
- When `SMTP_HOST` or `SMTP_PORT` is unconfigured, incident detection, transitions, and the web UI continue operating normally.
- The dispatcher logs a warning once per minute and reschedules pending outbox events with a 5-minute pause without incrementing `attempt_count` or burning retries.

---

## 6. Workspace Authorization & Recipient Controls

- **Tenant Isolation:** All incident reads, detail lookups, and notification settings are strictly scoped to the authenticated user's workspace (`/api/workspaces/:workspaceId/...`).
- **Owner-Only Mutations:** Modifying notification preferences or recipients requires the `owner` role.
- **Authorized Recipients Only:** Arbitrary external emails cannot be submitted. Recipient user IDs are validated against active `workspace_members`.
- **Dynamic Membership Revocation:** At dispatch time, recipients are joined against `workspace_members`. If a user is removed from a workspace, they immediately stop receiving alert emails.

---

## 7. Configuration & Environment Variables

| Variable | Type | Default | Description |
|---|---|---|---|
| `SMTP_HOST` | string | `""` | SMTP mail server hostname |
| `SMTP_PORT` | integer | `587` | SMTP port (1-65535) |
| `SMTP_SECURE` | boolean | `false` | Enable TLS/SSL connection |
| `SMTP_USER` | string | `""` | SMTP authentication username |
| `SMTP_PASS` | string | `""` | SMTP authentication password (redacted in logs) |
| `SMTP_FROM` | string | `alerts@apidash.local` | Sender address for alert emails |
| `OUTBOX_CONCURRENCY` | integer | `5` | Maximum concurrent email sends per worker |
| `OUTBOX_POLL_INTERVAL_MS` | integer | `1000` | Polling interval for due notification events |
| `OUTBOX_LEASE_MS` | integer | `60000` | Lease duration in ms for outbox claims |
| `OUTBOX_MAX_ATTEMPTS` | integer | `5` | Maximum delivery attempts before moving to dead_letter |

---

## 8. Database Migrations

Phase 5 introduces forward-only migrations 014 through 020:
- `014_create_incidents_table.sql`: DDL for incidents and `uk_active_incident_per_api` unique constraint.
- `015_create_monitor_health_states_table.sql`: DDL for tracking consecutive streaks.
- `016_create_result_processing_ledger_table.sql`: DDL for result processing idempotency.
- `017_create_notification_outbox_table.sql`: DDL for durable asynchronous notifications.
- `018_create_workspace_notification_settings_table.sql`: DDL for workspace alert toggles.
- `019_create_workspace_notification_recipients_table.sql`: DDL for workspace recipient associations.
- `020_backfill_monitor_health_states.sql`: Idempotently backfills health state for existing monitors where `workspace_id IS NOT NULL`.
- `021_add_suppressed_delivery_state.sql`: Adds `suppressed` delivery state to `notification_outbox` to distinguish deliberately skipped alerts from sent emails.

Run migrations:
```bash
npm run db:migrate
```

---

## 9. Testing & Verification

Run the complete backend test suite:
```bash
npm --prefix backend test
```
Run individual test modules:
```bash
node --test backend/test/incidentLifecycle.test.js
node --test backend/test/incidentConcurrency.test.js
node --test backend/test/notificationDispatch.test.js
node --test backend/test/incidentRoutes.test.js
node --test backend/test/migrationIntegration.test.js
node --test backend/test/phase5ReliabilityHardening.test.js
```
*Note: Integration tests dynamically provision isolated disposable databases (e.g. `apidash_test_lifecycle_*`, `apidash_test_dispatch_*`, `apidash_test_suppression_*`, `apidash_test_membership_*`, `apidash_test_lease_*`) on MySQL 8 and drop them in `finally` blocks. The normal `api_monitor` development database is never modified or reset.*

---

## 10. Operational Troubleshooting & Hardening Guarantees

1. **Incidents not resolving:** Verify that the monitor returns 2 consecutive `passed` results. A single passing check is insufficient.
2. **Deterministic Suppression vs Sent:** Events that should not be sent due to workspace preferences or zero recipients transition to `suppressed` (never `sent` or indefinitely `pending`). Distinct reasons: `DISABLED_IN_SETTINGS_OPEN`, `DISABLED_IN_SETTINGS_RESOLVE`, `ZERO_RECIPIENTS_CONFIGURED`, `ALL_RECIPIENTS_REVOKED`.
3. **Emails not sending:** Check server logs for `SMTP is not configured`. Ensure `SMTP_HOST` and `SMTP_PORT` are set in `.env` and restart the worker (`npm run worker`). When SMTP is unconfigured, outbox delivery pauses (5m delay) without consuming the `max_attempts` budget.
4. **Bounded Transport Timeouts & Lease Protection:** SMTP socket timeouts (default 15s), connection timeouts (default 10s), and greeting timeouts (default 10s) are bounded to ~35s, strictly below the outbox lease duration (default 60s). Unexpired leases cannot be reclaimed by concurrent workers.
5. **Dynamic Membership Re-evaluation:** Notification recipients are queried dynamically at dispatch time using an inner join against `workspace_members`. If a user is revoked between event creation and dispatch, they are strictly excluded.
6. **Workspace Role Alignment:** Consistent with APIDash's role model (`owner` and `member`), only workspace owners can update notification preferences and recipients (`PUT /notification-settings`). Members can view preferences in read-only mode (`GET`). Attempts to assign non-members or cross-workspace users are rejected with HTTP 400.
7. **Dead-letter jobs:** Check `SELECT * FROM notification_outbox WHERE delivery_state = 'dead_letter'`. The `last_error` column details the terminal failure.
8. **Lease recovery:** If a worker process was killed abruptly, orphaned outbox claims recover automatically once their lease expires.

