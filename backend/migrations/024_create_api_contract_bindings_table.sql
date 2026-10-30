-- backend/migrations/024_create_api_contract_bindings_table.sql
-- Create monitor-to-operation bindings table

CREATE TABLE IF NOT EXISTS api_contract_bindings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  api_id INT NOT NULL UNIQUE,
  workspace_id INT NOT NULL,
  contract_id INT NOT NULL,
  revision_id INT NOT NULL,
  operation_id VARCHAR(255) NULL,
  method VARCHAR(16) NOT NULL,
  path_template VARCHAR(500) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_bindings_api FOREIGN KEY (api_id) REFERENCES apis(id) ON DELETE CASCADE,
  CONSTRAINT fk_bindings_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_bindings_contract FOREIGN KEY (contract_id) REFERENCES api_contracts(id) ON DELETE CASCADE,
  CONSTRAINT fk_bindings_revision FOREIGN KEY (revision_id) REFERENCES api_contract_revisions(id) ON DELETE RESTRICT,
  INDEX idx_bindings_workspace (workspace_id),
  INDEX idx_bindings_contract_rev (contract_id, revision_id)
);

