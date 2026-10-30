-- backend/migrations/016_create_result_processing_ledger_table.sql
-- Create result processing idempotency ledger ensuring exactly-once transition evaluation per test result

CREATE TABLE IF NOT EXISTS result_processing_ledger (
  result_id INT NOT NULL PRIMARY KEY,
  api_id INT NOT NULL,
  processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ledger_result FOREIGN KEY (result_id) REFERENCES test_results(id) ON DELETE CASCADE,
  CONSTRAINT fk_ledger_api FOREIGN KEY (api_id) REFERENCES apis(id) ON DELETE CASCADE
);

