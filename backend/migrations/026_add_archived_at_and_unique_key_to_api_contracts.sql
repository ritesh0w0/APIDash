-- backend/migrations/026_add_archived_at_and_unique_key_to_api_contracts.sql
-- Add archived_at for audit retention and unique key on (id, workspace_id) for composite FK reference

ALTER TABLE api_contracts
  ADD COLUMN archived_at DATETIME NULL DEFAULT NULL AFTER description,
  ADD UNIQUE KEY uk_contracts_id_workspace (id, workspace_id);

