CREATE TABLE IF NOT EXISTS test_results (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  api_id        INT            NOT NULL,
  status_code   INT,
  response_time INT,
  result        ENUM('PASS','FAIL') NOT NULL,
  error_message TEXT,
  tested_at     DATETIME       DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (api_id) REFERENCES apis(id) ON DELETE CASCADE,
  INDEX idx_test_results_api_tested (api_id, tested_at)
);
