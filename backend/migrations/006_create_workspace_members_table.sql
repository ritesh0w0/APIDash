CREATE TABLE IF NOT EXISTS workspace_members (
  id INT AUTO_INCREMENT PRIMARY KEY,
  workspace_id INT NOT NULL,
  user_id INT NOT NULL,
  role ENUM('owner', 'member') NOT NULL DEFAULT 'member',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uk_workspace_user (workspace_id, user_id),
  INDEX idx_workspace_members_user (user_id)
);
