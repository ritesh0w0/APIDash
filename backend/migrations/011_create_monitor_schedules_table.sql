-- backend/migrations/011_create_monitor_schedules_table.sql
-- Create durable scheduling and lease tracking table for API monitors

CREATE TABLE IF NOT EXISTS monitor_schedules (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  api_id           INT NOT NULL UNIQUE,
  next_run_at      DATETIME NOT NULL,
  leased_by        VARCHAR(64) NULL,
  lease_expires_at DATETIME NULL,
  last_run_at      DATETIME NULL,
  last_outcome     VARCHAR(20) NULL,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_monitor_schedules_api FOREIGN KEY (api_id) REFERENCES apis(id) ON DELETE CASCADE,
  INDEX idx_schedules_due_lease (next_run_at, lease_expires_at)
);
