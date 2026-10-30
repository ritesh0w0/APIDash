CREATE TABLE IF NOT EXISTS apis (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(255)   NOT NULL,
  url             TEXT           NOT NULL,
  method          VARCHAR(10)    NOT NULL DEFAULT 'GET',
  expected_status INT            NOT NULL DEFAULT 200,
  created_at      DATETIME       DEFAULT CURRENT_TIMESTAMP
);
