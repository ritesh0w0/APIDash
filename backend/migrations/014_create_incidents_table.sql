-- backend/migrations/014_create_incidents_table.sql
-- Create incidents table with database-enforced single active incident per monitor constraint

CREATE TABLE IF NOT EXISTS incidents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  api_id INT NOT NULL,
  workspace_id INT NOT NULL,
  status ENUM('open', 'resolved') NOT NULL DEFAULT 'open',
  first_unhealthy_at DATETIME NOT NULL,
  opened_at DATETIME NOT NULL,
  resolved_at DATETIME NULL,
  first_result_id INT NULL,
  trigger_result_id INT NULL,
  latest_result_id INT NULL,
  resolution_result_id INT NULL,
  unhealthy_count INT NOT NULL DEFAULT 1,
  error_summary VARCHAR(1000) NULL,
  active_api_id INT GENERATED ALWAYS AS (IF(status = 'open', api_id, NULL)) VIRTUAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_incidents_api FOREIGN KEY (api_id) REFERENCES apis(id) ON DELETE CASCADE,
  CONSTRAINT fk_incidents_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  UNIQUE KEY uk_active_incident_per_api (active_api_id),
  INDEX idx_incidents_workspace_status (workspace_id, status, opened_at),
  INDEX idx_incidents_api_opened (api_id, opened_at)
);

