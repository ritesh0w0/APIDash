-- backend/migrations/027_add_unique_key_to_apis_workspace.sql
-- Add unique key on (id, workspace_id) to apis for composite FK reference

ALTER TABLE apis
  ADD UNIQUE KEY uk_apis_id_workspace (id, workspace_id);

