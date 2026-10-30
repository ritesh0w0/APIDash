-- backend/migrations/009_enhance_apis_table.sql
-- Add request configuration and assertions fields to apis table

ALTER TABLE apis
  ADD COLUMN headers TEXT NULL AFTER method,
  ADD COLUMN body TEXT NULL AFTER headers,
  ADD COLUMN timeout_ms INT DEFAULT 10000 AFTER body,
  ADD COLUMN assertions TEXT NULL AFTER timeout_ms;
