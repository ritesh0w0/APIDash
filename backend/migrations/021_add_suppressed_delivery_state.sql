-- backend/migrations/021_add_suppressed_delivery_state.sql
-- Add 'suppressed' terminal delivery state to notification_outbox table to distinguish deliberately skipped events from sent emails

ALTER TABLE notification_outbox
  MODIFY COLUMN delivery_state ENUM('pending', 'processing', 'sent', 'dead_letter', 'suppressed') NOT NULL DEFAULT 'pending';

