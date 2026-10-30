// backend/scripts/migrate.js
'use strict';

const fs = require('fs');
const path = require('path');
const { getPool, closePool } = require('../db');
const { logger: defaultLogger } = require('../logger');

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

/**
 * Ensures the schema_migrations tracking table exists.
 *
 * @param {import('mysql2/promise').Pool} pool
 */
async function ensureMigrationsTable(pool) {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * Returns an array of migration names that have already been applied.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<string[]>}
 */
async function getAppliedMigrations(pool) {
  const [rows] = await pool.execute('SELECT name FROM schema_migrations ORDER BY id ASC');
  return rows.map((r) => r.name);
}

/**
 * Executes pending SQL migrations in deterministic alphabetical order.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {string} [migrationsDir]
 * @param {import('pino').Logger} [logger]
 * @returns {Promise<{ applied: string[], alreadyApplied: string[] }>}
 */
async function runMigrations(pool = getPool(), migrationsDir = DEFAULT_MIGRATIONS_DIR, logger = defaultLogger) {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory does not exist: ${migrationsDir}`);
  }

  await ensureMigrationsTable(pool);
  const alreadyApplied = await getAppliedMigrations(pool);
  const appliedSet = new Set(alreadyApplied);

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const newlyApplied = [];

  for (const file of files) {
    if (appliedSet.has(file)) {
      continue;
    }

    const filePath = path.join(migrationsDir, file);
    const sqlContent = fs.readFileSync(filePath, 'utf8').trim();

    if (!sqlContent) {
      continue;
    }

    logger.info({ migration: file }, `Applying migration: ${file}`);

    try {
      // Execute the single DDL/DML statement
      await pool.execute(sqlContent);
      // Record migration success
      await pool.execute('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
      newlyApplied.push(file);
      logger.info({ migration: file }, `Successfully applied: ${file}`);
    } catch (err) {
      logger.error({ migration: file, err: err.message }, `Migration failed on: ${file}`);
      throw new Error(`Migration ${file} failed: ${err.message}`);
    }
  }

  return {
    applied: newlyApplied,
    alreadyApplied,
  };
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  require('dotenv').config();
  const pool = getPool();

  runMigrations(pool)
    .then((result) => {
      if (result.applied.length === 0) {
        console.log('✅  Database schema is up to date. No pending migrations.');
      } else {
        console.log(`✅  Successfully applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`);
      }
      return closePool().then(() => process.exit(0));
    })
    .catch((err) => {
      console.error('❌  Migration error:', err.message);
      closePool().finally(() => process.exit(1));
    });
}

module.exports = {
  runMigrations,
  ensureMigrationsTable,
  getAppliedMigrations,
};
