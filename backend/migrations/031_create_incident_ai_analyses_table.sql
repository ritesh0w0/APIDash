-- backend/migrations/031_create_incident_ai_analyses_table.sql
-- Durable background AI incident investigations, evidence snapshots, and validated structured results

CREATE TABLE IF NOT EXISTS incident_ai_analyses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workspace_id INT NOT NULL,
  incident_id INT NOT NULL,
  created_by_user_id INT NOT NULL,
  status ENUM('pending', 'running', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  provider VARCHAR(50) NOT NULL,
  model VARCHAR(100) NOT NULL,
  prompt_version VARCHAR(50) NOT NULL,
  schema_version VARCHAR(50) NOT NULL,
  evidence_snapshot JSON NOT NULL,
  evidence_fingerprint VARCHAR(64) NOT NULL,
  result JSON NULL,
  error_message VARCHAR(500) NULL,
  error_code VARCHAR(100) NULL,
  tokens_prompt INT NULL,
  tokens_completion INT NULL,
  tokens_total INT NULL,
  duration_ms INT NULL,
  lease_owner_token VARCHAR(64) NULL,
  lease_expires_at DATETIME(3) NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ai_analysis_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_ai_analysis_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
  CONSTRAINT fk_ai_analysis_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_ai_analysis_incident_created (incident_id, created_at),
  INDEX idx_ai_analysis_workspace_status (workspace_id, status),
  INDEX idx_ai_analysis_claim (status, lease_expires_at, attempt_count),
  INDEX idx_ai_analysis_fingerprint (incident_id, evidence_fingerprint)
);

