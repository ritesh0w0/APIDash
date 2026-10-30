CREATE TABLE IF NOT EXISTS scheduler_runs (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  total      INT NOT NULL DEFAULT 0,
  passed     INT NOT NULL DEFAULT 0,
  failed     INT NOT NULL DEFAULT 0,
  avg_ms     INT,
  ran_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_scheduler_runs_ran_at (ran_at)
);
