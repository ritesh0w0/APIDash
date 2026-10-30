-- backend/migrations/023_create_api_contract_revisions_table.sql
-- Create immutable contract revisions table

CREATE TABLE IF NOT EXISTS api_contract_revisions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contract_id INT NOT NULL,
  revision_number INT NOT NULL,
  openapi_version VARCHAR(32) NOT NULL,
  specification_content LONGTEXT NOT NULL,
  specification_raw LONGTEXT NULL,
  content_sha256 VARCHAR(64) NOT NULL,
  operations_catalog JSON NOT NULL,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_revisions_contract FOREIGN KEY (contract_id) REFERENCES api_contracts(id) ON DELETE CASCADE,
  CONSTRAINT fk_revisions_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uk_contract_revision_number (contract_id, revision_number),
  INDEX idx_revision_contract_content (contract_id, content_sha256)
);

