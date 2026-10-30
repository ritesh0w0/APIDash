-- backend/migrations/022_create_api_contracts_table.sql
-- Create workspace-owned logical contracts table

CREATE TABLE IF NOT EXISTS api_contracts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workspace_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_contracts_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_contracts_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uk_contracts_workspace_name (workspace_id, name),
  INDEX idx_contracts_workspace (workspace_id, updated_at)
);

