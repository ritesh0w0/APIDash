// backend/test/phase6IntegrityAndAuthorization.test.js
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const request = require('supertest');
const { runMigrations } = require('../scripts/migrate');
const { loadConfig } = require('../config');
const { createApp } = require('../app');
const { createWorkspaceRouter } = require('../routes/workspaceRoutes');
const { createAuthMiddleware } = require('../middleware/auth');
const { UserRepository } = require('../data/userRepository');
const { WorkspaceRepository } = require('../data/workspaceRepository');
const { ApiRepository } = require('../data/apiRepository');
const { ContractRepository } = require('../data/contractRepository');
const { AppError } = require('../middleware/errors');

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

function setupTestApp(pool) {
  const userRepo = new UserRepository(pool);
  const workspaceRepo = new WorkspaceRepository(pool);
  const apiRepo = new ApiRepository(pool);
  const contractRepo = new ContractRepository(pool);

  const realAuthMiddleware = createAuthMiddleware({
    userRepo,
    workspaceRepo,
  });

  const testAuthMiddleware = {
    requireAuth: async (req, _res, next) => {
      const userId = Number(req.headers['x-test-user-id']);
      if (!userId) {
        return next(new AppError('Authentication required. Please log in.', 401));
      }
      const user = await userRepo.findById(userId);
      if (!user) return next(new AppError('User account not found', 401));
      req.user = user;
      next();
    },
    requireWorkspaceMember: realAuthMiddleware.requireWorkspaceMember,
    requireWorkspaceOwner: realAuthMiddleware.requireWorkspaceOwner,
  };

  const workspaceRouter = createWorkspaceRouter({
    workspaceRepo,
    apiRepo,
    contractRepo,
    requireAuth: testAuthMiddleware.requireAuth,
    requireWorkspaceMember: testAuthMiddleware.requireWorkspaceMember,
    requireWorkspaceOwner: testAuthMiddleware.requireWorkspaceOwner,
  });

  return createApp({
    pool,
    workspaceRouter,
    csrfProtection: (_req, _res, next) => next(),
  });
}

test('Phase 6 — Contract Deletion, Archival, and Audit Retention', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible');
    return;
  }

  const dbName = `apidash_test_p6_retention_${Date.now()}`;
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

    // Setup Owner User & Workspace
    const [uRes] = await pool.execute('INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)', [
      'owner@test.com',
      'hash',
      'Owner User',
    ]);
    const userId = uRes.insertId;

    const [wRes] = await pool.execute('INSERT INTO workspaces (name, created_by) VALUES (?, ?)', ['Retention WS', userId]);
    const workspaceId = wRes.insertId;

    await pool.execute('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)', [
      workspaceId,
      userId,
      'owner',
    ]);

    const [mRes] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [workspaceId, 'Target API', 'https://api.example.com/items', 'GET', 200]
    );
    const monitorId = mRes.insertId;

    const contractRepo = new ContractRepository(pool);

    // 1. Create contract & Revision
    const contract = await contractRepo.createContract(workspaceId, { name: 'Item Service' });
    const revision = await contractRepo.createRevision(contract.id, {
      revisionNumber: 1,
      openapiVersion: '3.0.3',
      specificationRaw: 'openapi: 3.0.3',
      specificationContent: { openapi: '3.0.3' },
      contentSha256: 'sha_item_1',
      operationsCatalog: [{ method: 'GET', pathTemplate: '/items' }],
      dereferencedSpec: { openapi: '3.0.3' },
    });

    // 2. Bind monitor to contract
    await contractRepo.createOrUpdateBinding(workspaceId, monitorId, {
      contractId: contract.id,
      revisionId: revision.id,
      method: 'GET',
      pathTemplate: '/items',
    });

    // 3. Attempting to delete contract while active binding exists must be rejected with 409
    const app = setupTestApp(pool);
    const agent = request.agent(app);

    const deleteWhileBoundRes = await agent
      .delete(`/api/workspaces/${workspaceId}/contracts/${contract.id}`)
      .set('x-test-user-id', String(userId));

    assert.equal(deleteWhileBoundRes.status, 409);
    assert.match(deleteWhileBoundRes.body.error, /Cannot delete or archive contract .* active monitor binding/);

    // Also verify database foreign key RESTRICT prevents direct SQL deletion while binding exists
    await assert.rejects(
      async () => {
        await pool.execute('DELETE FROM api_contracts WHERE id = ?', [contract.id]);
      },
      (err) => err.code === 'ER_ROW_IS_REFERENCED_2' || err.message.includes('foreign key constraint fails'),
      'Database foreign key fk_bindings_contract_workspace must RESTRICT deletion while bindings exist'
    );

    // 4. Create historical test result and contract validation result
    const [trRes] = await pool.execute(
      'INSERT INTO test_results (api_id, status_code, response_time, result) VALUES (?, ?, ?, ?)',
      [monitorId, 200, 45, 'passed']
    );
    const testResultId = trRes.insertId;

    await contractRepo.saveValidationResult({
      test_result_id: testResultId,
      api_id: monitorId,
      workspace_id: workspaceId,
      contract_id: contract.id,
      revision_id: revision.id,
      operation_id: 'getItems',
      method: 'GET',
      path_template: '/items',
      verdict: 'passed',
      findings: [],
      findings_count: 0,
      findings_truncated: false,
    });

    // 5. Unbind the monitor
    const unbindRes = await agent
      .delete(`/api/workspaces/${workspaceId}/apis/${monitorId}/contract-binding`)
      .set('x-test-user-id', String(userId));
    assert.equal(unbindRes.status, 200);

    // 6. Delete contract: since historical validation results exist, contract must be ARCHIVED (not hard deleted)
    const deleteAfterUnbindRes = await agent
      .delete(`/api/workspaces/${workspaceId}/contracts/${contract.id}`)
      .set('x-test-user-id', String(userId));

    assert.equal(deleteAfterUnbindRes.status, 200);
    assert.equal(deleteAfterUnbindRes.body.archived, true);
    assert.match(deleteAfterUnbindRes.body.message, /archived to preserve audit history/);

    // 7. Verify all historical evidence survived intact
    const [cvrCheck] = await pool.execute('SELECT * FROM contract_validation_results WHERE test_result_id = ?', [testResultId]);
    assert.equal(cvrCheck.length, 1);
    assert.equal(cvrCheck[0].contract_id, contract.id);
    assert.equal(cvrCheck[0].revision_id, revision.id);

    const [revCheck] = await pool.execute('SELECT * FROM api_contract_revisions WHERE id = ?', [revision.id]);
    assert.equal(revCheck.length, 1);
    assert.equal(revCheck[0].revision_number, 1);

    // 8. Attempting to newly bind a monitor to an archived contract must be rejected
    const bindArchivedRes = await agent
      .put(`/api/workspaces/${workspaceId}/apis/${monitorId}/contract-binding`)
      .set('x-test-user-id', String(userId))
      .send({
        contract_id: contract.id,
        revision_id: revision.id,
        method: 'GET',
        path_template: '/items',
      });

    assert.equal(bindArchivedRes.status, 400);
    assert.match(bindArchivedRes.body.error, /is archived/);

    // 9. Archived contract is excluded from active contracts list by default
    const listRes = await agent
      .get(`/api/workspaces/${workspaceId}/contracts`)
      .set('x-test-user-id', String(userId));
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.contracts.length, 0);
  } finally {
    if (pool) await pool.end();
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});

test('Phase 6 — Workspace Relational Integrity at Service and Database Levels', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible');
    return;
  }

  const dbName = `apidash_test_p6_integrity_${Date.now()}`;
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

    // Setup 2 Users and 2 Workspaces
    const [u1] = await pool.execute('INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)', ['u1@test.com', 'h', 'U1']);
    const [u2] = await pool.execute('INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)', ['u2@test.com', 'h', 'U2']);

    const [w1] = await pool.execute('INSERT INTO workspaces (name, created_by) VALUES (?, ?)', ['WS 1', u1.insertId]);
    const [w2] = await pool.execute('INSERT INTO workspaces (name, created_by) VALUES (?, ?)', ['WS 2', u2.insertId]);

    const ws1 = w1.insertId;
    const ws2 = w2.insertId;

    await pool.execute('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)', [ws1, u1.insertId, 'owner']);
    await pool.execute('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)', [ws2, u2.insertId, 'owner']);

    // Monitor 1 in WS1, Monitor 2 in WS2, Monitor Unowned (NULL)
    const [m1] = await pool.execute('INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)', [
      ws1, 'API 1', 'https://api1.com', 'GET', 200,
    ]);
    const [m2] = await pool.execute('INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)', [
      ws2, 'API 2', 'https://api2.com', 'GET', 200,
    ]);
    const [mNull] = await pool.execute('INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)', [
      null, 'Legacy API', 'https://null.com', 'GET', 200,
    ]);

    const contractRepo = new ContractRepository(pool);

    // Contract 1 in WS1, Contract 2 in WS2
    const c1 = await contractRepo.createContract(ws1, { name: 'Contract WS1' });
    const r1 = await contractRepo.createRevision(c1.id, {
      revisionNumber: 1,
      openapiVersion: '3.0.3',
      specificationRaw: 'openapi: 3.0.3',
      specificationContent: { openapi: '3.0.3' },
      contentSha256: 'sha_ws1',
      operationsCatalog: [{ method: 'GET', pathTemplate: '/v1' }],
      dereferencedSpec: { openapi: '3.0.3' },
    });

    const c2 = await contractRepo.createContract(ws2, { name: 'Contract WS2' });
    const r2 = await contractRepo.createRevision(c2.id, {
      revisionNumber: 1,
      openapiVersion: '3.0.3',
      specificationRaw: 'openapi: 3.0.3',
      specificationContent: { openapi: '3.0.3' },
      contentSha256: 'sha_ws2',
      operationsCatalog: [{ method: 'GET', pathTemplate: '/v2' }],
      dereferencedSpec: { openapi: '3.0.3' },
    });

    // 1. Normal same-workspace binding succeeds
    const okBinding = await contractRepo.createOrUpdateBinding(ws1, m1.insertId, {
      contractId: c1.id,
      revisionId: r1.id,
      method: 'GET',
      pathTemplate: '/v1',
    });
    assert.equal(okBinding.api_id, m1.insertId);
    assert.equal(okBinding.workspace_id, ws1);

    // 2. Cross-workspace binding through API is rejected
    const app = setupTestApp(pool);
    const agent1 = request.agent(app);

    const crossApiRes = await agent1
      .put(`/api/workspaces/${ws1}/apis/${m1.insertId}/contract-binding`)
      .set('x-test-user-id', String(u1.insertId))
      .send({
        contract_id: c2.id, // Contract belongs to WS2!
        revision_id: r2.id,
        method: 'GET',
        path_template: '/v2',
      });
    assert.equal(crossApiRes.status, 400);
    assert.match(crossApiRes.body.error, /does not exist in this workspace/);

    // 3. Cross-workspace binding through repository / DB boundary is rejected
    await assert.rejects(
      async () => {
        // Attempting to bind WS1 monitor to WS2 contract
        await contractRepo.createOrUpdateBinding(ws1, m1.insertId, {
          contractId: c2.id,
          revisionId: r2.id,
          method: 'GET',
          pathTemplate: '/v2',
        });
      },
      /belongs to workspace/,
      'Repository boundary must reject cross-workspace contract binding'
    );

    // Direct SQL insert violating composite foreign key must be blocked by MySQL
    const [mDirect] = await pool.execute('INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)', [
      ws1, 'Direct API', 'https://direct.com', 'GET', 200,
    ]);

    await assert.rejects(
      async () => {
        await pool.execute(
          `INSERT INTO api_contract_bindings (api_id, workspace_id, contract_id, revision_id, method, path_template)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [mDirect.insertId, ws1, c2.id, r2.id, 'GET', '/v2'] // c2 has workspace_id = ws2, not ws1!
        );
      },
      (err) => err.code === 'ER_NO_REFERENCED_ROW_2' || err.message.includes('foreign key constraint fails'),
      'Database composite foreign key fk_bindings_contract_workspace must reject cross-workspace binding'
    );

    // 4. Revision belonging to another contract is rejected
    await assert.rejects(
      async () => {
        await contractRepo.createOrUpdateBinding(ws1, m1.insertId, {
          contractId: c1.id,
          revisionId: r2.id, // Revision 2 belongs to Contract 2, not Contract 1!
          method: 'GET',
          pathTemplate: '/v1',
        });
      },
      /belongs to contract/,
      'Repository boundary must reject revision belonging to another contract'
    );

    const [mMismatch] = await pool.execute('INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)', [
      ws1, 'Mismatch API', 'https://mismatch.com', 'GET', 200,
    ]);

    await assert.rejects(
      async () => {
        await pool.execute(
          `INSERT INTO api_contract_bindings (api_id, workspace_id, contract_id, revision_id, method, path_template)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [mMismatch.insertId, ws1, c1.id, r2.id, 'GET', '/v1']
        );
      },
      (err) => err.code === 'ER_NO_REFERENCED_ROW_2' || err.message.includes('foreign key constraint fails'),
      'Database composite foreign key fk_bindings_revision_contract must reject mismatched revision'
    );

    // 5. Null-workspace monitor cannot be bound
    await assert.rejects(
      async () => {
        await contractRepo.createOrUpdateBinding(ws1, mNull.insertId, {
          contractId: c1.id,
          revisionId: r1.id,
          method: 'GET',
          pathTemplate: '/v1',
        });
      },
      /legacy unassigned monitors cannot have contract bindings/,
      'Unassigned legacy monitors must not be bound'
    );

    await assert.rejects(
      async () => {
        await pool.execute(
          `INSERT INTO api_contract_bindings (api_id, workspace_id, contract_id, revision_id, method, path_template)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [mNull.insertId, ws1, c1.id, r1.id, 'GET', '/v1']
        );
      },
      (err) => err.code === 'ER_NO_REFERENCED_ROW_2' || err.message.includes('foreign key constraint fails'),
      'Database foreign key fk_bindings_api_workspace must reject null-workspace monitor'
    );
  } finally {
    if (pool) await pool.end();
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});

test('Phase 6 — Workspace Role Reconcilation and Authorization', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible');
    return;
  }

  const dbName = `apidash_test_p6_roles_${Date.now()}`;
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

    // Setup Owner (User 1) and Member (User 2) in Workspace 1
    // And User 3 in Workspace 2
    const [u1] = await pool.execute('INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)', ['owner@test.com', 'h', 'Owner']);
    const [u2] = await pool.execute('INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)', ['member@test.com', 'h', 'Member']);
    const [u3] = await pool.execute('INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)', ['outsider@test.com', 'h', 'Outsider']);

    const [w1] = await pool.execute('INSERT INTO workspaces (name, created_by) VALUES (?, ?)', ['Primary WS', u1.insertId]);
    const [w2] = await pool.execute('INSERT INTO workspaces (name, created_by) VALUES (?, ?)', ['Foreign WS', u3.insertId]);

    const ws1 = w1.insertId;
    const ws2 = w2.insertId;

    await pool.execute('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)', [ws1, u1.insertId, 'owner']);
    await pool.execute('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)', [ws1, u2.insertId, 'member']);
    await pool.execute('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)', [ws2, u3.insertId, 'owner']);

    const [mRes] = await pool.execute('INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)', [
      ws1, 'API 1', 'https://test.com', 'GET', 200,
    ]);
    const monitorId = mRes.insertId;

    const app = setupTestApp(pool);
    const agentOwner = request.agent(app);
    const agentMember = request.agent(app);
    const agentOutsider = request.agent(app);

    const testSpec = `
openapi: 3.0.3
info:
  title: Role Test API
  version: 1.0.0
paths:
  /ping:
    get:
      responses:
        '200':
          description: OK
`;

    // 1. Regular Member CANNOT create contract -> 403 Forbidden
    const memberCreateRes = await agentMember
      .post(`/api/workspaces/${ws1}/contracts`)
      .set('x-test-user-id', String(u2.insertId))
      .send({
        name: 'Member Spec',
        specification: testSpec,
      });
    assert.equal(memberCreateRes.status, 403);
    assert.match(memberCreateRes.body.error, /Owner permission is required/);

    // 2. Owner CAN create contract -> 201 Created
    const ownerCreateRes = await agentOwner
      .post(`/api/workspaces/${ws1}/contracts`)
      .set('x-test-user-id', String(u1.insertId))
      .send({
        name: 'Owner Spec',
        specification: testSpec,
      });
    assert.equal(ownerCreateRes.status, 201);
    const contractId = ownerCreateRes.body.contract.id;

    // 3. Regular Member CAN read contract details -> 200 OK
    const memberGetRes = await agentMember
      .get(`/api/workspaces/${ws1}/contracts/${contractId}`)
      .set('x-test-user-id', String(u2.insertId));
    assert.equal(memberGetRes.status, 200);
    assert.equal(memberGetRes.body.contract.name, 'Owner Spec');

    // 4. Regular Member CANNOT publish new revision -> 403 Forbidden
    const memberRevRes = await agentMember
      .post(`/api/workspaces/${ws1}/contracts/${contractId}/revisions`)
      .set('x-test-user-id', String(u2.insertId))
      .send({
        specification: testSpec,
      });
    assert.equal(memberRevRes.status, 403);
    assert.match(memberRevRes.body.error, /Owner permission is required/);

    // 5. Regular Member CANNOT bind monitor -> 403 Forbidden
    const memberBindRes = await agentMember
      .put(`/api/workspaces/${ws1}/apis/${monitorId}/contract-binding`)
      .set('x-test-user-id', String(u2.insertId))
      .send({
        contract_id: contractId,
        revision_id: ownerCreateRes.body.revision.id,
        method: 'GET',
        path_template: '/ping',
      });
    assert.equal(memberBindRes.status, 403);
    assert.match(memberBindRes.body.error, /Owner permission is required/);

    // 6. Owner CAN bind monitor -> 200 OK
    const ownerBindRes = await agentOwner
      .put(`/api/workspaces/${ws1}/apis/${monitorId}/contract-binding`)
      .set('x-test-user-id', String(u1.insertId))
      .send({
        contract_id: contractId,
        revision_id: ownerCreateRes.body.revision.id,
        method: 'GET',
        path_template: '/ping',
      });
    assert.equal(ownerBindRes.status, 200);

    // 7. Regular Member CAN read monitor's contract binding -> 200 OK
    const memberReadBindingRes = await agentMember
      .get(`/api/workspaces/${ws1}/apis/${monitorId}/contract-binding`)
      .set('x-test-user-id', String(u2.insertId));
    assert.equal(memberReadBindingRes.status, 200);
    assert.equal(memberReadBindingRes.body.binding.contract_id, contractId);

    // 8. Regular Member CANNOT unbind monitor -> 403 Forbidden
    const memberUnbindRes = await agentMember
      .delete(`/api/workspaces/${ws1}/apis/${monitorId}/contract-binding`)
      .set('x-test-user-id', String(u2.insertId));
    assert.equal(memberUnbindRes.status, 403);

    // 9. Cross-workspace IDOR protection: Outsider receives 404 (revealing nothing)
    const outsiderAccessRes = await agentOutsider
      .get(`/api/workspaces/${ws1}/contracts/${contractId}`)
      .set('x-test-user-id', String(u3.insertId));
    assert.equal(outsiderAccessRes.status, 404);
  } finally {
    if (pool) await pool.end();
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});
