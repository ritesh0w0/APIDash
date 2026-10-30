// backend/test/incidentLifecycle.test.js
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { runMigrations } = require('../scripts/migrate');
const { loadConfig } = require('../config');
const { IncidentService, isHealthyOutcome } = require('../services/incidentService');
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

test('Incident Lifecycle — 2-unhealthy opening and 2-healthy resolution thresholds on disposable DB', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible for incident lifecycle test');
    return;
  }

  const dbName = `apidash_test_lifecycle_${Date.now()}`;
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

    await runMigrations(pool, MIGRATIONS_DIR);

    // Setup seed workspace and monitors
    const [userRes] = await pool.execute(
      'INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)',
      ['owner@example.com', 'hash123', 'Workspace Owner']
    );
    const [wsRes] = await pool.execute(
      'INSERT INTO workspaces (name, created_by) VALUES (?, ?)',
      ['Ops Workspace', userRes.insertId]
    );
    const workspaceId = wsRes.insertId;

    const [apiRes] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [workspaceId, 'Payment API', 'https://payments.example.com/health', 'GET', 200]
    );
    const apiId = apiRes.insertId;

    // Monitor without workspace
    const [nullWsApiRes] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [null, 'Unowned Legacy API', 'https://legacy.example.com', 'GET', 200]
    );
    const nullWsApiId = nullWsApiRes.insertId;

    const incidentRepo = new IncidentRepository(pool);
    const notificationRepo = new NotificationRepository(pool);
    const incidentService = new IncidentService({
      pool,
      incidentRepo,
      notificationRepo,
    });

    const monitor = { id: apiId, name: 'Payment API', url: 'https://payments.example.com/health' };
    const nullMonitor = { id: nullWsApiId, name: 'Unowned Legacy API', url: 'https://legacy.example.com' };

    // 1. First unhealthy result does NOT open an incident
    const run1 = await incidentService.recordExecutionAndEvaluateIncident(monitor, {
      status_code: 500,
      response_time: 150,
      result: 'failed',
      error_message: 'HTTP 500 Internal Server Error',
      error_type: 'ASSERTION_FAILED',
    });
    assert.equal(run1.transition, 'first_unhealthy');
    assert.equal(run1.incident, null);

    const activeInc1 = await incidentRepo.findActiveByApiId(apiId);
    assert.equal(activeInc1, null, 'No incident should open on single failure');

    // 2. Second consecutive unhealthy result (`failed` followed by `error`) opens exactly one incident
    const run2 = await incidentService.recordExecutionAndEvaluateIncident(monitor, {
      status_code: null,
      response_time: 10000,
      result: 'error',
      error_message: 'Request timed out after 10000ms',
      error_type: 'TIMEOUT',
    });
    assert.equal(run2.transition, 'incident_opened');
    assert.ok(run2.incident);
    assert.equal(run2.incident.status, 'open');
    assert.equal(run2.incident.unhealthy_count, 2);

    const activeInc2 = await incidentRepo.findActiveByApiId(apiId);
    assert.ok(activeInc2);
    assert.equal(activeInc2.id, run2.incident.id);
    assert.equal(activeInc2.first_result_id, run1.resultRecord.id);
    assert.equal(activeInc2.trigger_result_id, run2.resultRecord.id);
    assert.equal(activeInc2.latest_result_id, run2.resultRecord.id);

    // Verify outbox has exactly one incident_opened event
    const [outboxOpened] = await pool.execute(
      'SELECT * FROM notification_outbox WHERE incident_id = ?',
      [activeInc2.id]
    );
    assert.equal(outboxOpened.length, 1);
    assert.equal(outboxOpened[0].event_type, 'incident_opened');
    assert.equal(outboxOpened[0].delivery_state, 'pending');

    // 3. Additional unhealthy results update the existing incident, not create a duplicate
    const run3 = await incidentService.recordExecutionAndEvaluateIncident(monitor, {
      status_code: 503,
      response_time: 200,
      result: 'failed',
      error_message: 'Service Unavailable',
      error_type: 'ASSERTION_FAILED',
    });
    assert.equal(run3.transition, 'incident_updated');
    assert.equal(run3.incident.id, activeInc2.id);
    assert.equal(run3.incident.unhealthy_count, 3);
    assert.equal(run3.incident.latest_result_id, run3.resultRecord.id);

    const [outboxAfterUpdate] = await pool.execute(
      'SELECT * FROM notification_outbox WHERE incident_id = ?',
      [activeInc2.id]
    );
    assert.equal(outboxAfterUpdate.length, 1, 'No duplicate opening event on repeated failures');

    // 4. A single passing result while open does NOT resolve the incident
    const run4 = await incidentService.recordExecutionAndEvaluateIncident(monitor, {
      status_code: 200,
      response_time: 45,
      result: 'passed',
    });
    assert.equal(run4.transition, 'healthy_streak_incremented');
    assert.equal(run4.incident.status, 'open');

    const activeInc4 = await incidentRepo.findActiveByApiId(apiId);
    assert.ok(activeInc4, 'Incident must remain open after only 1 pass');

    // 5. An unhealthy result resets the healthy streak while open
    const run5 = await incidentService.recordExecutionAndEvaluateIncident(monitor, {
      status_code: 500,
      response_time: 80,
      result: 'failed',
      error_message: 'Still failing',
    });
    assert.equal(run5.transition, 'incident_updated');

    const [stateAfterReset] = await pool.execute('SELECT * FROM monitor_health_states WHERE api_id = ?', [apiId]);
    assert.equal(stateAfterReset[0].consecutive_healthy, 0);

    // 6. First recovery pass increments healthy streak again
    const run6 = await incidentService.recordExecutionAndEvaluateIncident(monitor, {
      status_code: 200,
      response_time: 40,
      result: 'passed',
    });
    assert.equal(run6.transition, 'healthy_streak_incremented');

    // 7. Second consecutive passing result RESOLVES the incident
    const run7 = await incidentService.recordExecutionAndEvaluateIncident(monitor, {
      status_code: 200,
      response_time: 35,
      result: 'passed',
    });
    assert.equal(run7.transition, 'incident_resolved');
    assert.equal(run7.incident.status, 'resolved');

    const activeIncResolved = await incidentRepo.findActiveByApiId(apiId);
    assert.equal(activeIncResolved, null, 'No active incident should remain after 2 passes');

    const [resolvedRow] = await pool.execute('SELECT * FROM incidents WHERE id = ?', [activeInc2.id]);
    assert.equal(resolvedRow[0].status, 'resolved');
    assert.ok(resolvedRow[0].resolved_at);
    assert.equal(resolvedRow[0].resolution_result_id, run7.resultRecord.id);

    // Verify outbox has exactly one incident_resolved event
    const [outboxResolved] = await pool.execute(
      'SELECT * FROM notification_outbox WHERE incident_id = ? AND event_type = "incident_resolved"',
      [activeInc2.id]
    );
    assert.equal(outboxResolved.length, 1);

    // 8. Passing result resets unhealthy streak before an incident opens
    const run8 = await incidentService.recordExecutionAndEvaluateIncident(monitor, {
      status_code: 500,
      response_time: 100,
      result: 'failed',
    });
    assert.equal(run8.transition, 'first_unhealthy');

    const run9 = await incidentService.recordExecutionAndEvaluateIncident(monitor, {
      status_code: 200,
      response_time: 50,
      result: 'passed',
    });
    assert.equal(run9.transition, 'healthy');

    const [stateReset] = await pool.execute('SELECT * FROM monitor_health_states WHERE api_id = ?', [apiId]);
    assert.equal(stateReset[0].consecutive_unhealthy, 0);
    assert.equal(stateReset[0].consecutive_healthy, 1);

    // 9. Subsequent unhealthy streak after resolution creates a brand NEW incident
    await incidentService.recordExecutionAndEvaluateIncident(monitor, {
      status_code: 500,
      response_time: 120,
      result: 'failed',
    });
    const run11 = await incidentService.recordExecutionAndEvaluateIncident(monitor, {
      status_code: 500,
      response_time: 120,
      result: 'failed',
    });
    assert.equal(run11.transition, 'incident_opened');
    assert.notEqual(run11.incident.id, activeInc2.id, 'New incident must have distinct ID');

    // 10. Null-workspace monitor does NOT create incidents, health state, or notifications
    const runNull1 = await incidentService.recordExecutionAndEvaluateIncident(nullMonitor, {
      status_code: 500,
      response_time: 100,
      result: 'failed',
    });
    const runNull2 = await incidentService.recordExecutionAndEvaluateIncident(nullMonitor, {
      status_code: 500,
      response_time: 100,
      result: 'failed',
    });
    assert.equal(runNull1.transition, 'none_null_workspace');
    assert.equal(runNull2.transition, 'none_null_workspace');

    const [nullIncidents] = await pool.execute('SELECT * FROM incidents WHERE api_id = ?', [nullWsApiId]);
    assert.equal(nullIncidents.length, 0);
    const [nullStates] = await pool.execute('SELECT * FROM monitor_health_states WHERE api_id = ?', [nullWsApiId]);
    assert.equal(nullStates.length, 0);
  } finally {
    if (pool) await pool.end();
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});

test('Incident Semantics — Healthy/Unhealthy classification', () => {
  assert.equal(isHealthyOutcome('passed'), true);
  assert.equal(isHealthyOutcome('PASS'), true);
  assert.equal(isHealthyOutcome('failed'), false);
  assert.equal(isHealthyOutcome('FAIL'), false);
  assert.equal(isHealthyOutcome('error'), false);
  assert.equal(isHealthyOutcome(''), false);
  assert.equal(isHealthyOutcome(null), false);
  assert.equal(isHealthyOutcome(undefined), false);
  assert.equal(isHealthyOutcome('unknown'), false);
  assert.equal(isHealthyOutcome('MALFORMED_STATE'), false);
});

