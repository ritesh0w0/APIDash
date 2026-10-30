// backend/test/incidentConcurrency.test.js
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { runMigrations } = require('../scripts/migrate');
const { loadConfig } = require('../config');
const { IncidentService } = require('../services/incidentService');
const { IncidentRepository } = require('../data/incidentRepository');
const { NotificationRepository } = require('../data/notificationRepository');

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

test('Incident Concurrency & Idempotency — Single active incident uniqueness and idempotent transactions', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible for concurrency test');
    return;
  }

  const dbName = `apidash_test_concurrency_${Date.now()}`;
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
      connectionLimit: 10,
    });

    await runMigrations(pool, MIGRATIONS_DIR);

    // Setup seed workspace and 2 monitors
    const [userRes] = await pool.execute(
      'INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)',
      ['user@example.com', 'hash', 'User']
    );
    const [wsRes] = await pool.execute(
      'INSERT INTO workspaces (name, created_by) VALUES (?, ?)',
      ['Workspace', userRes.insertId]
    );
    const workspaceId = wsRes.insertId;

    const [apiRes1] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [workspaceId, 'Monitor Alpha', 'https://alpha.example.com', 'GET', 200]
    );
    const api1Id = apiRes1.insertId;

    const [apiRes2] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [workspaceId, 'Monitor Beta', 'https://beta.example.com', 'GET', 200]
    );
    const api2Id = apiRes2.insertId;

    const incidentRepo = new IncidentRepository(pool);
    const notificationRepo = new NotificationRepository(pool);
    const incidentService = new IncidentService({
      pool,
      incidentRepo,
      notificationRepo,
    });

    const monitor1 = { id: api1Id, name: 'Monitor Alpha', url: 'https://alpha.example.com' };
    const monitor2 = { id: api2Id, name: 'Monitor Beta', url: 'https://beta.example.com' };

    // 1. Database-enforced uniqueness: Attempting to insert 2 open incidents for same api fails
    await incidentRepo.create({
      api_id: api1Id,
      workspace_id: workspaceId,
      status: 'open',
      first_unhealthy_at: new Date(),
      opened_at: new Date(),
      unhealthy_count: 2,
    });

    await assert.rejects(
      async () => {
        await incidentRepo.create({
          api_id: api1Id,
          workspace_id: workspaceId,
          status: 'open',
          first_unhealthy_at: new Date(),
          opened_at: new Date(),
          unhealthy_count: 2,
        });
      },
      (err) => err.code === 'ER_DUP_ENTRY' || err.message.includes('Duplicate entry')
    );

    // Clean up created incident for further testing
    await pool.execute('DELETE FROM incidents WHERE api_id = ?', [api1Id]);

    // 2. Idempotency ledger: duplicate result cannot double-increment streak
    const [rawResult] = await pool.execute(
      'INSERT INTO test_results (api_id, status_code, response_time, result) VALUES (?, ?, ?, ?)',
      [api1Id, 500, 100, 'failed']
    );
    const existingResultId = rawResult.insertId;

    // Simulate recording the result into ledger
    await pool.execute('INSERT INTO result_processing_ledger (result_id, api_id) VALUES (?, ?)', [
      existingResultId,
      api1Id,
    ]);

    // Attempting to re-insert the same result_id into ledger throws duplicate key
    await assert.rejects(
      async () => {
        await pool.execute('INSERT INTO result_processing_ledger (result_id, api_id) VALUES (?, ?)', [
          existingResultId,
          api1Id,
        ]);
      },
      (err) => err.code === 'ER_DUP_ENTRY' || err.message.includes('Duplicate entry')
    );

    // 3. Concurrent executions for DIFFERENT monitors progress independently without interference
    const [resAlpha, resBeta] = await Promise.all([
      incidentService.recordExecutionAndEvaluateIncident(monitor1, {
        status_code: 500,
        response_time: 100,
        result: 'failed',
      }),
      incidentService.recordExecutionAndEvaluateIncident(monitor2, {
        status_code: 200,
        response_time: 50,
        result: 'passed',
      }),
    ]);

    assert.equal(resAlpha.transition, 'first_unhealthy');
    assert.equal(resBeta.transition, 'healthy');

    const [stateAlpha] = await pool.execute('SELECT * FROM monitor_health_states WHERE api_id = ?', [api1Id]);
    const [stateBeta] = await pool.execute('SELECT * FROM monitor_health_states WHERE api_id = ?', [api2Id]);

    assert.equal(stateAlpha[0].consecutive_unhealthy, 1);
    assert.equal(stateAlpha[0].consecutive_healthy, 0);
    assert.equal(stateBeta[0].consecutive_unhealthy, 0);
    assert.equal(stateBeta[0].consecutive_healthy, 1);

    // 4. Concurrent execution on SAME monitor serializes cleanly under MySQL row lock
    // Trigger second and third failures concurrently
    const [concurrent1, concurrent2] = await Promise.all([
      incidentService.recordExecutionAndEvaluateIncident(monitor1, {
        status_code: 500,
        response_time: 120,
        result: 'failed',
      }),
      incidentService.recordExecutionAndEvaluateIncident(monitor1, {
        status_code: 500,
        response_time: 130,
        result: 'failed',
      }),
    ]);

    // One opened the incident, the other updated it
    const transitions = [concurrent1.transition, concurrent2.transition].sort();
    assert.deepEqual(transitions, ['incident_opened', 'incident_updated']);

    // Exactly one open incident exists in database
    const [incidents] = await pool.execute('SELECT * FROM incidents WHERE api_id = ? AND status = "open"', [api1Id]);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].unhealthy_count, 3);

    // Exactly one notification event was created in outbox
    const [outboxRows] = await pool.execute('SELECT * FROM notification_outbox WHERE incident_id = ?', [
      incidents[0].id,
    ]);
    assert.equal(outboxRows.length, 1);
    assert.equal(outboxRows[0].event_type, 'incident_opened');

    // 5. Transaction rollback: if an unhandled error happens before commit, all writes roll back
    const badConn = await pool.getConnection();
    await badConn.beginTransaction();
    try {
      await badConn.execute(
        'INSERT INTO test_results (api_id, status_code, response_time, result) VALUES (?, ?, ?, ?)',
        [api1Id, 500, 9999, 'failed']
      );
      // Simulate crash / error
      throw new Error('Simulated crash before commit');
    } catch (_expected) {
      await badConn.rollback();
    } finally {
      badConn.release();
    }

    // Verify rolled back result was NOT persisted
    const [resultsAfterRollback] = await pool.execute(
      'SELECT COUNT(*) AS cnt FROM test_results WHERE response_time = 9999'
    );
    assert.equal(resultsAfterRollback[0].cnt, 0);

    // 6. Monitor workspace is derived from database, caller cannot spoof workspace_id
    const spoofedMonitor = { id: api1Id, workspace_id: 999999, name: 'Spoofed' };
    const spoofedRun = await incidentService.recordExecutionAndEvaluateIncident(spoofedMonitor, {
      status_code: 200,
      response_time: 50,
      result: 'passed',
    });

    const [stateSpoofed] = await pool.execute('SELECT workspace_id FROM monitor_health_states WHERE api_id = ?', [
      api1Id,
    ]);
    assert.equal(stateSpoofed[0].workspace_id, workspaceId, 'Workspace ID must be derived from database, not caller');
  } finally {
    if (pool) await pool.end();
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});
