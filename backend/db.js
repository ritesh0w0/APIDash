// backend/db.js
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'api_monitor',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

/**
 * Initialises the database and tables if they don't exist yet.
 */
async function initDB() {
  // Create the database if missing
  const raw = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  });

  await raw.execute(`CREATE DATABASE IF NOT EXISTS api_monitor
    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await raw.end();

  // Create the apis table
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS apis (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      name          VARCHAR(255)   NOT NULL,
      url           TEXT           NOT NULL,
      method        VARCHAR(10)    NOT NULL DEFAULT 'GET',
      expected_status INT          NOT NULL DEFAULT 200,
      created_at    DATETIME       DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create the test_results table for history
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS test_results (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      api_id        INT            NOT NULL,
      status_code   INT,
      response_time INT,
      result        ENUM('PASS','FAIL') NOT NULL,
      error_message TEXT,
      tested_at     DATETIME       DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (api_id) REFERENCES apis(id) ON DELETE CASCADE
    )
  `);

  // Track every 30-second scheduler cycle
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS scheduler_runs (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      total      INT NOT NULL DEFAULT 0,
      passed     INT NOT NULL DEFAULT 0,
      failed     INT NOT NULL DEFAULT 0,
      avg_ms     INT,
      ran_at     DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('✅  Database & tables ready');
}

module.exports = { pool, initDB };
