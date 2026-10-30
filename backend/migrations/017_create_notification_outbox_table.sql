-- backend/migrations/017_create_notification_outbox_table.sql
-- Create durable notification outbox table for reliable asynchronous email delivery

CREATE TABLE IF NOT EXISTS notification_outbox (
  id INT AUTO_INCREMENT PRIMARY KEY,
  idempotency_key VARCHAR(255) NOT NULL UNIQUE,
  workspace_id INT NOT NULL,
  incident_id INT NOT NULL,
  event_type ENUM('incident_opened', 'incident_resolved') NOT NULL,
  delivery_state ENUM('pending', 'processing', 'sent', 'dead_letter') NOT NULL DEFAULT 'pending',
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_owner_token VARCHAR(64) NULL,
  lease_expires_at DATETIME NULL,
  payload JSON NOT NULL,
  last_error VARCHAR(500) NULL,
  sent_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_outbox_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_outbox_incident FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
  INDEX idx_outbox_eligibility (next_attempt_at, delivery_state, lease_expires_at),
  INDEX idx_outbox_workspace (workspace_id, created_at)
);
