-- backend/migrations/018_create_workspace_notification_settings_table.sql
-- Create workspace notification settings table for opening and recovery alerts

CREATE TABLE IF NOT EXISTS workspace_notification_settings (
  workspace_id INT NOT NULL PRIMARY KEY,
  notify_on_open BOOLEAN NOT NULL DEFAULT TRUE,
  notify_on_resolve BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_notif_settings_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

