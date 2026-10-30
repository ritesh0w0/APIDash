// backend/test/contractIntegration.test.js
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
const { ContractRepository } = require('../data/contractRepository');
const { executeMonitoringRun } = require('../services/monitoringCoordinator');
const { contractValidatorService } = require('../services/contractValidatorService');

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

test('Contract Integration — Preflight violation halts execution with neutral health impact and zero outbound calls', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible');
    return;
  }

  const dbName = `apidash_test_contract_preflight_${Date.now()}`;
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

    // 1. Setup workspace & user
    const [uRes] = await pool.execute('INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)', [
      'dev@example.com',
      'hash',
      'Dev User',
    ]);
    const [wRes] = await pool.execute('INSERT INTO workspaces (name, created_by) VALUES (?, ?)', [
      'API Team',
      uRes.insertId,
    ]);
    const workspaceId = wRes.insertId;

    // 2. Setup Monitor expecting GET /users/{id}
    const [mRes] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [workspaceId, 'User Monitor', 'https://api.example.com/users/not-an-int', 'GET', 200]
    );
    const monitorId = mRes.insertId;

    // 3. Setup Contract & Revision with strict integer parameter
    const contractRepo = new ContractRepository(pool);
    const contract = await contractRepo.createContract(workspaceId, {
      name: 'User Contract',
      description: 'Preflight test spec',
    });

    const spec = {
      openapi: '3.0.3',
      info: { title: 'User API', version: '1.0' },
      paths: {
        '/users/{id}': {
          get: {
            parameters: [
              {
                name: 'id',
                in: 'path',
                required: true,
                schema: { type: 'integer' },
              },
            ],
            responses: {
              '200': { description: 'OK' },
            },
          },
        },
      },
    };

    const revision = await contractRepo.createRevision(contract.id, {
      revisionNumber: 1,
      openapiVersion: '3.0.3',
      specificationRaw: JSON.stringify(spec),
      specificationContent: spec,
      contentSha256: 'user_spec_sha_123',
      operationsCatalog: [
        {
          method: 'GET',
          pathTemplate: '/users/{id}',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { '200': { description: 'OK' } },
        },
      ],
      dereferencedSpec: spec,
    });

    // 4. Bind monitor to contract operation
    await contractRepo.createOrUpdateBinding(workspaceId, monitorId, {
      contractId: contract.id,
      revisionId: revision.id,
      method: 'GET',
      pathTemplate: '/users/{id}',
    });

    const incidentRepo = new IncidentRepository(pool);
    const notificationRepo = new NotificationRepository(pool);
    const incidentService = new IncidentService({
      pool,
      incidentRepo,
      notificationRepo,
      contractRepo,
    });

    let outboundCallsCount = 0;
    const mockExecutor = async () => {
      outboundCallsCount++;
      return {
        status_code: 200,
        response_time: 45,
        headers: { 'content-type': 'application/json' },
        body: '{}',
        json_body: {},
      };
    };

    const monitorRecord = {
      id: monitorId,
      workspace_id: workspaceId,
      name: 'User Monitor',
      url: 'https://api.example.com/users/not-an-int',
      method: 'GET',
      expected_status: 200,
    };

    // 5. Execute monitoring run
    const result = await executeMonitoringRun(monitorRecord, {
      pool,
      contractRepo,
      incidentService,
      executorFn: mockExecutor,
    });

    // Assertions
    assert.equal(outboundCallsCount, 0, 'Zero outbound HTTP calls must be made on preflight rejection');
    assert.equal(result.result, 'error');
    assert.equal(result.error_type, 'CONTRACT_REQUEST_INVALID');
    assert.equal(result.contract_verdict, 'preflight_rejected');
    assert.ok(result.contract_findings.length > 0);

    // Verify contract validation result was persisted
    const [cvrRows] = await pool.execute('SELECT * FROM contract_validation_results WHERE test_result_id = ?', [result.id]);
    assert.equal(cvrRows.length, 1);
    assert.equal(cvrRows[0].verdict, 'preflight_rejected');
    assert.equal(cvrRows[0].failure_category, 'PREFLIGHT_REJECTED');

    // Verify monitor streak is neutral (streaks reset to 0 in monitor_health_states, no incident created)
    const [monRows] = await pool.execute('SELECT consecutive_healthy, consecutive_unhealthy FROM monitor_health_states WHERE api_id = ?', [monitorId]);
    assert.equal(monRows[0].consecutive_healthy, 0);
    assert.equal(monRows[0].consecutive_unhealthy, 0);

    const activeInc = await incidentRepo.findActiveByApiId(monitorId);
    assert.equal(activeInc, null, 'Neutral preflight rejection must never open an incident');
  } finally {
    if (pool) await pool.end();
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});

test('Contract Integration — Incident state machine neutral health semantics', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible');
    return;
  }

  const dbName = `apidash_test_neutral_incidents_${Date.now()}`;
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

    const [uRes] = await pool.execute('INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)', [
      'tester@example.com',
      'hash',
      'Tester',
    ]);
    const [wRes] = await pool.execute('INSERT INTO workspaces (name, created_by) VALUES (?, ?)', [
      'QA Workspace',
      uRes.insertId,
    ]);
    const workspaceId = wRes.insertId;

    const [mRes] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [workspaceId, 'Order Service', 'https://orders.example.com/status', 'GET', 200]
    );
    const monitorId = mRes.insertId;

    const incidentRepo = new IncidentRepository(pool);
    const notificationRepo = new NotificationRepository(pool);
    const contractRepo = new ContractRepository(pool);
    const incidentService = new IncidentService({
      pool,
      incidentRepo,
      notificationRepo,
      contractRepo,
    });

    const monitor = { id: monitorId, workspace_id: workspaceId, name: 'Order Service' };

    // Step 1: Run 1 is unhealthy (streak: 1 unhealthy)
    const run1 = await incidentService.recordExecutionAndEvaluateIncident(monitor, {
      status_code: 500,
      response_time: 120,
      result: 'failed',
      error_type: 'HTTP_500',
    }, null);
    assert.equal(run1.transition, 'first_unhealthy');

    const [s1] = await pool.execute('SELECT consecutive_healthy, consecutive_unhealthy FROM monitor_health_states WHERE api_id = ?', [monitorId]);
    assert.equal(s1[0].consecutive_unhealthy, 1);

    // Step 2: Run 2 is neutral (preflight rejection) -> must reset streak to 0
    const run2 = await incidentService.recordExecutionAndEvaluateIncident(monitor, {
      status_code: null,
      response_time: 0,
      result: 'error',
      error_type: 'CONTRACT_REQUEST_INVALID',
      health_impact: 'neutral',
    }, null);
    assert.equal(run2.transition, 'neutral_streak_reset');

    const [s2] = await pool.execute('SELECT consecutive_healthy, consecutive_unhealthy FROM monitor_health_states WHERE api_id = ?', [monitorId]);
    assert.equal(s2[0].consecutive_unhealthy, 0, 'Neutral result must reset unhealthy streak to 0');
    assert.equal(s2[0].consecutive_healthy, 0);

    // Step 3: Run 3 is unhealthy -> streak is now 1 again, NOT 2! So NO incident opened.
    const run3 = await incidentService.recordExecutionAndEvaluateIncident(monitor, {
      status_code: 503,
      response_time: 110,
      result: 'failed',
      error_type: 'HTTP_503',
    }, null);
    assert.equal(run3.transition, 'first_unhealthy');

    const [s3] = await pool.execute('SELECT consecutive_healthy, consecutive_unhealthy FROM monitor_health_states WHERE api_id = ?', [monitorId]);
    assert.equal(s3[0].consecutive_unhealthy, 1);
    const activeInc3 = await incidentRepo.findActiveByApiId(monitorId);
    assert.equal(activeInc3, null, 'Neutral observation prevented bridging disjoint outages into an incident');

    // Step 4: Run 4 is unhealthy again -> NOW streak is 2, incident opens!
    const run4 = await incidentService.recordExecutionAndEvaluateIncident(monitor, {
      status_code: 503,
      response_time: 110,
      result: 'failed',
      error_type: 'HTTP_503',
    }, null);
    assert.equal(run4.transition, 'incident_opened');
    assert.ok(run4.incident);

    // Step 5: During open incident, Run 5 is neutral -> incident remains OPEN, not resolved!
    const run5 = await incidentService.recordExecutionAndEvaluateIncident(monitor, {
      status_code: null,
      response_time: 0,
      result: 'error',
      error_type: 'CONTRACT_REQUEST_INVALID',
      health_impact: 'neutral',
    }, null);
    assert.equal(run5.transition, 'neutral_streak_reset');

    const activeInc5 = await incidentRepo.findActiveByApiId(monitorId);
    assert.ok(activeInc5, 'Open incident must remain open after neutral result');
    assert.equal(activeInc5.status, 'open');
  } finally {
    if (pool) await pool.end();
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});

test('Contract Integration — Binding immutability and multi-tenant workspace isolation', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible');
    return;
  }

  const dbName = `apidash_test_contract_isolation_${Date.now()}`;
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

    // Create 2 users & 2 separate workspaces
    const [u1] = await pool.execute('INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)', ['alice@test.com', 'h1', 'Alice']);
    const [u2] = await pool.execute('INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)', ['bob@test.com', 'h2', 'Bob']);

    const [w1] = await pool.execute('INSERT INTO workspaces (name, created_by) VALUES (?, ?)', ['Workspace A', u1.insertId]);
    const [w2] = await pool.execute('INSERT INTO workspaces (name, created_by) VALUES (?, ?)', ['Workspace B', u2.insertId]);

    const wsA = w1.insertId;
    const wsB = w2.insertId;

    const [monA] = await pool.execute('INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)', [
      wsA,
      'Monitor A',
      'https://a.com/data',
      'GET',
      200,
    ]);

    const contractRepo = new ContractRepository(pool);

    // Create contract in Workspace A
    const contractA = await contractRepo.createContract(wsA, { name: 'Spec A' });
    const rev1 = await contractRepo.createRevision(contractA.id, {
      revisionNumber: 1,
      openapiVersion: '3.0.3',
      specificationRaw: 'openapi: 3.0.3',
      specificationContent: { openapi: '3.0.3' },
      contentSha256: 'sha_rev_1',
      operationsCatalog: [{ method: 'GET', pathTemplate: '/data' }],
      dereferencedSpec: { openapi: '3.0.3' },
    });

    // Bind Monitor A to Revision 1
    const binding = await contractRepo.createOrUpdateBinding(wsA, monA.insertId, {
      contractId: contractA.id,
      revisionId: rev1.id,
      method: 'GET',
      pathTemplate: '/data',
    });
    assert.equal(binding.revision_id, rev1.id);

    // Publish Revision 2 in Workspace A
    const rev2 = await contractRepo.createRevision(contractA.id, {
      revisionNumber: 2,
      openapiVersion: '3.1.0',
      specificationRaw: 'openapi: 3.1.0',
      specificationContent: { openapi: '3.1.0' },
      contentSha256: 'sha_rev_2',
      operationsCatalog: [{ method: 'GET', pathTemplate: '/data' }],
      dereferencedSpec: { openapi: '3.1.0' },
    });
    assert.equal(rev2.revision_number, 2);

    // Verify Monitor A is STILL bound to Revision 1 (Immutability guarantee)
    const activeBinding = await contractRepo.getBindingByApiId(monA.insertId, wsA);
    assert.equal(activeBinding.revision_id, rev1.id, 'Monitor binding must remain pinned to Revision 1');
    assert.equal(activeBinding.revision_number, 1);

    // Cross-workspace contract binding attempt
    // Try to find Contract A from Workspace B -> must return null
    const crossContract = await contractRepo.findContractById(contractA.id, wsB);
    assert.equal(crossContract, null, 'Contract from Workspace A must not be accessible in Workspace B');
  } finally {
    if (pool) await pool.end();
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});
