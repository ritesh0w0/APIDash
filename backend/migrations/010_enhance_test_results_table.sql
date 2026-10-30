-- backend/migrations/010_enhance_test_results_table.sql
-- Expand result enum to varchar and add structured assertions and error classification

ALTER TABLE test_results
  MODIFY COLUMN result VARCHAR(20) NOT NULL,
  ADD COLUMN assertion_results TEXT NULL AFTER error_message,
  ADD COLUMN error_type VARCHAR(50) NULL AFTER assertion_results;
