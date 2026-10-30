-- backend/migrations/013_exclude_null_workspace_schedules.sql
-- Purge schedule records for legacy monitors that have no workspace ownership

DELETE FROM monitor_schedules
WHERE api_id IN (SELECT id FROM apis WHERE workspace_id IS NULL);
