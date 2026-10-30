-- backend/migrations/029_enforce_composite_foreign_keys_on_bindings.sql
-- Enforce workspace consistency and prevent contract deletion while bindings exist

ALTER TABLE api_contract_bindings
  DROP FOREIGN KEY fk_bindings_contract,
  ADD CONSTRAINT fk_bindings_api_workspace FOREIGN KEY (api_id, workspace_id) REFERENCES apis(id, workspace_id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_bindings_contract_workspace FOREIGN KEY (contract_id, workspace_id) REFERENCES api_contracts(id, workspace_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_bindings_revision_contract FOREIGN KEY (revision_id, contract_id) REFERENCES api_contract_revisions(id, contract_id) ON DELETE RESTRICT;

