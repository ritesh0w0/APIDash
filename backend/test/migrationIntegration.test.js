// backend/test/migrationIntegration.test.js
'use strict';

const path = require('path');
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
  } catch (err) {
    return null;
  }
}

test('Migration integration: upgrade path from 001-013 to 014-020 preserves data and initializes scheduling and incidents', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible for migration integration test');
    return;
  }

  const dbName = `apidash_test_upgrade_${Date.now()}`;
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

    // 1. Apply migrations 001 to 013 into disposable database
    const fs = require('fs');
    const legacyFiles = fs.readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql') && (f.startsWith('00') || f.startsWith('010') || f.startsWith('011') || f.startsWith('012') || f.startsWith('013')))
      .sort();

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    for (const file of legacyFiles) {
      const sqlContent = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').trim();
      await pool.execute(sqlContent);
      await pool.execute('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
    }

    // 2. Insert representative legacy monitor and historical PASS/FAIL test results
    const [userRes] = await pool.execute(
      'INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)',
      ['legacy@example.com', 'hash123', 'Legacy User']
    );
    const [wsRes] = await pool.execute(
      'INSERT INTO workspaces (name, created_by) VALUES (?, ?)',
      ['Legacy Workspace', userRes.insertId]
    );
    const [apiRes1] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [wsRes.insertId, 'Legacy API 1', 'https://example.com/api1', 'GET', 200]
    );
    const [apiRes2] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [wsRes.insertId, 'Legacy API 2', 'https://example.com/api2', 'POST', 201]
    );
    const [apiResOrphan] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [null, 'Orphaned Legacy API', 'https://example.com/orphan', 'GET', 200]
    );

    await pool.execute(
      'INSERT INTO test_results (api_id, status_code, response_time, result, error_message) VALUES (?, ?, ?, ?, ?)',
      [apiRes1.insertId, 200, 110, 'PASS', null]
    );
    await pool.execute(
      'INSERT INTO test_results (api_id, status_code, response_time, result, error_message) VALUES (?, ?, ?, ?, ?)',
      [apiRes2.insertId, 500, 240, 'FAIL', 'Internal Server Error']
    );

    // 3. Apply pending Phase 5 migrations via actual runMigrations runner
    const migrationResult = await runMigrations(pool, MIGRATIONS_DIR);
    assert.ok(migrationResult.applied.includes('014_create_incidents_table.sql'));
    assert.ok(migrationResult.applied.includes('015_create_monitor_health_states_table.sql'));
    assert.ok(migrationResult.applied.includes('016_create_result_processing_ledger_table.sql'));
    assert.ok(migrationResult.applied.includes('017_create_notification_outbox_table.sql'));
    assert.ok(migrationResult.applied.includes('018_create_workspace_notification_settings_table.sql'));
    assert.ok(migrationResult.applied.includes('019_create_workspace_notification_recipients_table.sql'));
    assert.ok(migrationResult.applied.includes('020_backfill_monitor_health_states.sql'));

    // 4. Verify historical rows and original status values remain intact
    const [results] = await pool.execute('SELECT * FROM test_results ORDER BY id ASC');
    assert.equal(results.length, 2);
    assert.equal(results[0].result, 'PASS');
    assert.equal(results[0].status_code, 200);
    assert.equal(results[1].result, 'FAIL');
    assert.equal(results[1].status_code, 500);

    // Verify orphaned legacy monitor without workspace is preserved in apis
    const [orphanRows] = await pool.execute('SELECT * FROM apis WHERE id = ?', [apiResOrphan.insertId]);
    assert.equal(orphanRows.length, 1);
    assert.equal(orphanRows[0].workspace_id, null);

    // 5. Verify health state backfill: initialized for workspace-associated monitors, excluded for orphaned
    const [healthStates] = await pool.execute('SELECT * FROM monitor_health_states ORDER BY api_id ASC');
    assert.equal(healthStates.length, 2);
    assert.equal(healthStates[0].api_id, apiRes1.insertId);
    assert.equal(healthStates[1].api_id, apiRes2.insertId);
    assert.ok(!healthStates.some(h => h.api_id === apiResOrphan.insertId), 'Orphaned monitor must not have health state backfilled');

    // 6. Verify repeated migration invocation is idempotent
    const rerunResult = await runMigrations(pool, MIGRATIONS_DIR);
    assert.equal(rerunResult.applied.length, 0);
  } finally {
    if (pool) {
      await pool.end();
    }
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});

test('Migration integration: fresh-install applies all migrations 001-020 cleanly', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible for migration integration test');
    return;
  }

  const dbName = `apidash_test_fresh_${Date.now()}`;
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

    const result = await runMigrations(pool, MIGRATIONS_DIR);
    assert.ok(result.applied.length >= 20);
    assert.ok(result.applied.includes('014_create_incidents_table.sql'));
    assert.ok(result.applied.includes('015_create_monitor_health_states_table.sql'));
    assert.ok(result.applied.includes('016_create_result_processing_ledger_table.sql'));
    assert.ok(result.applied.includes('017_create_notification_outbox_table.sql'));
    assert.ok(result.applied.includes('018_create_workspace_notification_settings_table.sql'));
    assert.ok(result.applied.includes('019_create_workspace_notification_recipients_table.sql'));
    assert.ok(result.applied.includes('020_backfill_monitor_health_states.sql'));

    const [tables] = await pool.execute('SHOW TABLES');
    const tableNames = tables.map((r) => Object.values(r)[0]);

    assert.ok(tableNames.includes('apis'));
    assert.ok(tableNames.includes('test_results'));
    assert.ok(tableNames.includes('scheduler_runs'));
    assert.ok(tableNames.includes('monitor_schedules'));
    assert.ok(tableNames.includes('incidents'));
    assert.ok(tableNames.includes('monitor_health_states'));
    assert.ok(tableNames.includes('result_processing_ledger'));
    assert.ok(tableNames.includes('notification_outbox'));
    assert.ok(tableNames.includes('workspace_notification_settings'));
    assert.ok(tableNames.includes('workspace_notification_recipients'));
    assert.ok(tableNames.includes('schema_migrations'));
  } finally {
    if (pool) {
      await pool.end();
    }
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});