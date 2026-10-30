// backend/test/contractMigration.test.js
'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { runMigrations } = require('../scripts/migrate');
const { loadConfig } = require('../config');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function getAdminConnection() {
  const config = loadConfig();
  try {
    const conn = await mysql.createConnection({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
    });
    return conn;
  } catch (_err) {
    return null;
  }
}

test('Migration — Fresh install applies migrations 001 through 025 cleanly on disposable DB', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible');
    return;
  }

  const dbName = `apidash_test_mig_fresh_${Date.now()}`;
  let pool = null;

  try {
    await adminConn.execute(`CREATE DATABASE \`${dbName}\``);
    await adminConn.end();

    const config = loadConfig();
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: dbName,
      connectionLimit: 5,
    });

    // Run all migrations
    await runMigrations(pool, MIGRATIONS_DIR);

    // Verify Phase 6 tables exist
    const expectedTables = [
      'api_contracts',
      'api_contract_revisions',
      'api_contract_bindings',
      'contract_validation_results',
    ];

    for (const table of expectedTables) {
      const [rows] = await pool.execute(
        `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [dbName, table]
      );
      assert.equal(rows.length, 1, `Table ${table} must exist after fresh migrations`);
    }

    // Verify migrations table recorded up to 025
    const [migRows] = await pool.execute('SELECT name FROM schema_migrations ORDER BY name ASC');
    const migNames = migRows.map((r) => r.name);
    assert.ok(migNames.includes('022_create_api_contracts_table.sql'));
    assert.ok(migNames.includes('023_create_api_contract_revisions_table.sql'));
    assert.ok(migNames.includes('024_create_api_contract_bindings_table.sql'));
    assert.ok(migNames.includes('025_create_contract_validation_results_table.sql'));
    assert.ok(migNames.includes('026_add_archived_at_and_unique_key_to_api_contracts.sql'));
    assert.ok(migNames.includes('027_add_unique_key_to_apis_workspace.sql'));
    assert.ok(migNames.includes('028_add_unique_key_to_revisions_contract.sql'));
    assert.ok(migNames.includes('029_enforce_composite_foreign_keys_on_bindings.sql'));
    assert.ok(migNames.includes('030_enforce_composite_foreign_keys_and_retention_on_results.sql'));
  } finally {
    if (pool) await pool.end();
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});

test('Migration — Upgrade path from 001-021 to 022-025 preserves legacy data and unowned monitors', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible');
    return;
  }

  const dbName = `apidash_test_mig_upgrade_${Date.now()}`;
  let pool = null;

  try {
    await adminConn.execute(`CREATE DATABASE \`${dbName}\``);
    await adminConn.end();

    const config = loadConfig();
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: dbName,
      connectionLimit: 5,
    });

    // 1. Apply pre-Phase-6 migrations (001 through 021)
    const allFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const prePhase6Files = allFiles.filter((f) => {
      const num = parseInt(f.slice(0, 3), 10);
      return num <= 21;
    });

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    for (const file of prePhase6Files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await pool.execute(sql);
      await pool.execute('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
    }

    // 2. Insert pre-existing user, workspace, and monitors (both with and without workspace)
    const [uRes] = await pool.execute('INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)', [
      'legacy@test.com',
      'hash',
      'Legacy User',
    ]);
    const [wRes] = await pool.execute('INSERT INTO workspaces (name, created_by) VALUES (?, ?)', ['Legacy WS', uRes.insertId]);
    const wsId = wRes.insertId;

    const [ownedMonRes] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [wsId, 'Owned API', 'https://owned.example.com', 'GET', 200]
    );

    const [unownedMonRes] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [null, 'Unowned Legacy API', 'https://unowned.example.com', 'GET', 200]
    );

    // 3. Apply Phase 6 migrations (022 through 025)
    await runMigrations(pool, MIGRATIONS_DIR);

    // 4. Assert legacy data is perfectly preserved
    const [ownedCheck] = await pool.execute('SELECT * FROM apis WHERE id = ?', [ownedMonRes.insertId]);
    assert.equal(ownedCheck.length, 1);
    assert.equal(ownedCheck[0].name, 'Owned API');
    assert.equal(ownedCheck[0].workspace_id, wsId);

    const [unownedCheck] = await pool.execute('SELECT * FROM apis WHERE id = ?', [unownedMonRes.insertId]);
    assert.equal(unownedCheck.length, 1);
    assert.equal(unownedCheck[0].name, 'Unowned Legacy API');
    assert.equal(unownedCheck[0].workspace_id, null, 'Unowned monitor must retain NULL workspace_id');

    // 5. Assert contract bindings table exists and has 0 rows for unowned monitor
    const [bindings] = await pool.execute('SELECT * FROM api_contract_bindings WHERE api_id = ?', [unownedMonRes.insertId]);
    assert.equal(bindings.length, 0);
  } finally {
    if (pool) await pool.end();
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});

