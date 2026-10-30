-- backend/migrations/012_backfill_monitor_schedules.sql
-- Idempotently initialize scheduling state for all existing registered monitors with workspace ownership

INSERT IGNORE INTO monitor_schedules (api_id, next_run_at)
SELECT id, NOW() FROM apis
WHERE workspace_id IS NOT NULL;
