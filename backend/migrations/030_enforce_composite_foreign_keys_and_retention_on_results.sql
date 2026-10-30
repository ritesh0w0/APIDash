-- backend/migrations/030_enforce_composite_foreign_keys_and_retention_on_results.sql
-- Enforce workspace consistency and RESTRICT deletion of contracts/revisions referenced by validation results

ALTER TABLE contract_validation_results
  DROP FOREIGN KEY fk_cvr_contract,
  DROP FOREIGN KEY fk_cvr_revision,
  MODIFY COLUMN verdict ENUM('passed', 'failed', 'partial', 'preflight_rejected', 'not_evaluated') NOT NULL,
  ADD CONSTRAINT fk_cvr_contract_workspace FOREIGN KEY (contract_id, workspace_id) REFERENCES api_contracts(id, workspace_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_cvr_revision_contract FOREIGN KEY (revision_id, contract_id) REFERENCES api_contract_revisions(id, contract_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_cvr_api_workspace FOREIGN KEY (api_id, workspace_id) REFERENCES apis(id, workspace_id) ON DELETE CASCADE;
