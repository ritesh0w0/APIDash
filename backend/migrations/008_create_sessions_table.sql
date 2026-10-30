CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR(128) NOT NULL PRIMARY KEY,
  expires INT UNSIGNED NOT NULL,
  data MEDIUMTEXT,
  INDEX idx_sessions_expires (expires)
);
