-- backend/migrations/020_backfill_monitor_health_states.sql
-- Idempotently initialize health tracking state for all registered monitors with workspace ownership

INSERT IGNORE INTO monitor_health_states (api_id, workspace_id, consecutive_healthy, consecutive_unhealthy)
SELECT id, workspace_id, 0, 0
FROM apis
WHERE workspace_id IS NOT NULL;

