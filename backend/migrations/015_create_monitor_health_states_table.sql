-- backend/migrations/015_create_monitor_health_states_table.sql
-- Create monitor health state table tracking consecutive streaks and active incident pointer

CREATE TABLE IF NOT EXISTS monitor_health_states (
  api_id INT NOT NULL PRIMARY KEY,
  workspace_id INT NOT NULL,
  consecutive_healthy INT NOT NULL DEFAULT 0,
  consecutive_unhealthy INT NOT NULL DEFAULT 0,
  current_incident_id INT NULL,
  first_unhealthy_at DATETIME NULL,
  first_unhealthy_result_id INT NULL,
  last_result_id INT NULL,
  last_result_outcome VARCHAR(20) NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_health_state_api FOREIGN KEY (api_id) REFERENCES apis(id) ON DELETE CASCADE,
  CONSTRAINT fk_health_state_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_health_state_incident FOREIGN KEY (current_incident_id) REFERENCES incidents(id) ON DELETE SET NULL
);

