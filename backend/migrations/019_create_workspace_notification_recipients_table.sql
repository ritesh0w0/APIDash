-- backend/migrations/019_create_workspace_notification_recipients_table.sql
-- Create workspace notification recipients table linking authorized workspace members to alerts

CREATE TABLE IF NOT EXISTS workspace_notification_recipients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workspace_id INT NOT NULL,
  user_id INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_notif_recipients_ws FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CONSTRAINT fk_notif_recipients_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uk_ws_recipient (workspace_id, user_id)
);

