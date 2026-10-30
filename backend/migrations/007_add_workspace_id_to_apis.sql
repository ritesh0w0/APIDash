ALTER TABLE apis ADD COLUMN workspace_id INT NULL, ADD CONSTRAINT fk_apis_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
