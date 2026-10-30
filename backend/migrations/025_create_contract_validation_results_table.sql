-- backend/migrations/025_create_contract_validation_results_table.sql
-- Create contract validation results table (1:1 with test_results)

CREATE TABLE IF NOT EXISTS contract_validation_results (
  id INT AUTO_INCREMENT PRIMARY KEY,
  test_result_id INT NOT NULL UNIQUE,
  api_id INT NOT NULL,
  workspace_id INT NOT NULL,
  contract_id INT NOT NULL,
  revision_id INT NOT NULL,
  operation_id VARCHAR(255) NULL,
  method VARCHAR(16) NOT NULL,
  path_template VARCHAR(500) NOT NULL,
  verdict ENUM('passed', 'failed', 'partial', 'preflight_rejected', 'not_evaluated') NOT NULL,
  failure_category VARCHAR(64) NULL,
  findings JSON NOT NULL,
  findings_count INT NOT NULL DEFAULT 0,
  findings_truncated BOOLEAN NOT NULL DEFAULT FALSE,
  tested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_cvr_test_result FOREIGN KEY (test_result_id) REFERENCES test_results(id) ON DELETE CASCADE,
  CONSTRAINT fk_cvr_api FOREIGN KEY (api_id) REFERENCES apis(id) ON DELETE CASCADE,
  CONSTRAINT fk_cvr_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_cvr_contract FOREIGN KEY (contract_id) REFERENCES api_contracts(id) ON DELETE CASCADE,
  CONSTRAINT fk_cvr_revision FOREIGN KEY (revision_id) REFERENCES api_contract_revisions(id) ON DELETE CASCADE,
  INDEX idx_cvr_api (api_id, tested_at),
  INDEX idx_cvr_workspace (workspace_id, tested_at)
);

