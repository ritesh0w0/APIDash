// backend/test/aiInvestigationIntegration.test.js
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
const { IncidentRepository } = require('../data/incidentRepository');
const { AiAnalysisRepository } = require('../data/aiAnalysisRepository');
const { IncidentEvidenceBuilder } = require('../services/incidentEvidenceBuilder');
const { AiAnalysisWorker } = require('../services/aiAnalysisWorker');
const { MockAiProvider } = require('../services/aiProviderService');
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

function setupTestApp(pool, aiRepo, evidenceBuilder) {
  const userRepo = new UserRepository(pool);
  const workspaceRepo = new WorkspaceRepository(pool);
  const apiRepo = new ApiRepository(pool);
  const incidentRepo = new IncidentRepository(pool);

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
    incidentRepo,
    aiRepo,
    evidenceBuilder,
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

test('Phase 7 — AI Investigation Endpoints, Authorization, and IDOR Defense', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible');
    return;
  }

  const dbName = `apidash_test_ai_auth_${Date.now()}`;
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
      waitForConnections: true,
      connectionLimit: 5,
    });

    await runMigrations(pool, MIGRATIONS_DIR);

    const userRepo = new UserRepository(pool);
    const workspaceRepo = new WorkspaceRepository(pool);
    const incidentRepo = new IncidentRepository(pool);
    const aiRepo = new AiAnalysisRepository(pool);
    const evidenceBuilder = new IncidentEvidenceBuilder({ incidentRepo, pool });

    // Seed User A (Owner of WS A) and User B (Owner of WS B)
    const userA = await userRepo.create({
      email: 'owner-a@example.com',
      password_hash: 'hashA',
      display_name: 'User A',
    });
    const wsA = await workspaceRepo.create({ name: 'Workspace A', created_by: userA.id });
    await workspaceRepo.createMember({ workspace_id: wsA.id, user_id: userA.id, role: 'owner' });

    // Seed Member in WS A
    const memberA = await userRepo.create({
      email: 'member-a@example.com',
      password_hash: 'hashMember',
      display_name: 'Member A',
    });
    await workspaceRepo.createMember({ workspace_id: wsA.id, user_id: memberA.id, role: 'member' });

    // Seed User B in WS B
    const userB = await userRepo.create({
      email: 'owner-b@example.com',
      password_hash: 'hashB',
      display_name: 'User B',
    });
    const wsB = await workspaceRepo.create({ name: 'Workspace B', created_by: userB.id });
    await workspaceRepo.createMember({ workspace_id: wsB.id, user_id: userB.id, role: 'owner' });

    // Seed API monitor and Incident in Workspace A
    const [apiRes] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [wsA.id, 'API A', 'https://api-a.example.com/test', 'GET', 200]
    );
    const apiAId = apiRes.insertId;

    const [trRes] = await pool.execute(
      'INSERT INTO test_results (api_id, status_code, response_time, result, error_message, tested_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [apiAId, 500, 150, 'FAIL', 'Internal Server Error']
    );
    const testResultId = trRes.insertId;

    const incidentA = await incidentRepo.create({
      api_id: apiAId,
      workspace_id: wsA.id,
      status: 'open',
      first_unhealthy_at: new Date(),
      opened_at: new Date(),
      first_result_id: testResultId,
      trigger_result_id: testResultId,
      latest_result_id: testResultId,
      unhealthy_count: 2,
      error_summary: 'Persistent HTTP 500',
    });

    const app = setupTestApp(pool, aiRepo, evidenceBuilder);

    // 1. Unauthenticated request rejected with 401
    const unauthRes = await request(app).get(`/api/workspaces/${wsA.id}/ai-status`);
    assert.equal(unauthRes.status, 401);

    // 2. GET /ai-status returns valid metadata without exposing secrets
    const statusRes = await request(app)
      .get(`/api/workspaces/${wsA.id}/ai-status`)
      .set('x-test-user-id', String(userA.id));
    assert.equal(statusRes.status, 200);
    assert.equal(typeof statusRes.body.enabled, 'boolean');
    assert.ok(statusRes.body.provider);
    assert.equal(statusRes.body.apiKey, undefined);

    // 3. Cross-workspace IDOR protection: User B cannot trigger or view investigation for Incident A
    const idorPost = await request(app)
      .post(`/api/workspaces/${wsB.id}/incidents/${incidentA.id}/ai-analysis`)
      .set('x-test-user-id', String(userB.id));
    assert.equal(idorPost.status, 404);

    const idorGet = await request(app)
      .get(`/api/workspaces/${wsB.id}/incidents/${incidentA.id}/ai-analysis`)
      .set('x-test-user-id', String(userB.id));
    assert.equal(idorGet.status, 404);

    // 4. Regular workspace member CAN request analysis (consistent with read/collaborate role)
    const memberPost = await request(app)
      .post(`/api/workspaces/${wsA.id}/incidents/${incidentA.id}/ai-analysis`)
      .set('x-test-user-id', String(memberA.id))
      .send({});
    assert.equal(memberPost.status, 201);
    assert.ok(memberPost.body.analysis);
    assert.equal(memberPost.body.analysis.status, 'pending');
    assert.equal(memberPost.body.is_existing, false);

    // 5. Subsequent request with identical evidence returns existing pending job (deduplication)
    const dedupPost = await request(app)
      .post(`/api/workspaces/${wsA.id}/incidents/${incidentA.id}/ai-analysis`)
      .set('x-test-user-id', String(userA.id))
      .send({});
    assert.equal(dedupPost.status, 200);
    assert.equal(dedupPost.body.is_existing, true);
    assert.equal(dedupPost.body.analysis.id, memberPost.body.analysis.id);

    // 6. Force new analysis creates distinct job row
    const forcePost = await request(app)
      .post(`/api/workspaces/${wsA.id}/incidents/${incidentA.id}/ai-analysis`)
      .set('x-test-user-id', String(userA.id))
      .send({ force: true });
    assert.equal(forcePost.status, 201);
    assert.notEqual(forcePost.body.analysis.id, memberPost.body.analysis.id);
  } finally {
    if (pool) await pool.end();
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});

test('Phase 7 — Worker Lifecycle, Leasing, Processing, and Staleness Detection', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible');
    return;
  }

  const dbName = `apidash_test_ai_worker_${Date.now()}`;
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
      waitForConnections: true,
      connectionLimit: 5,
    });

    await runMigrations(pool, MIGRATIONS_DIR);

    const userRepo = new UserRepository(pool);
    const workspaceRepo = new WorkspaceRepository(pool);
    const incidentRepo = new IncidentRepository(pool);
    const aiRepo = new AiAnalysisRepository(pool);
    const evidenceBuilder = new IncidentEvidenceBuilder({ incidentRepo, pool });

    const user = await userRepo.create({
      email: 'worker-test@example.com',
      password_hash: 'hash',
      display_name: 'Worker Tester',
    });
    const ws = await workspaceRepo.create({ name: 'Worker WS', created_by: user.id });
    await workspaceRepo.createMember({ workspace_id: ws.id, user_id: user.id, role: 'owner' });

    const [apiRes] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [ws.id, 'Worker API', 'https://api.worker.test/ping', 'GET', 200]
    );
    const apiId = apiRes.insertId;

    const [trRes1] = await pool.execute(
      'INSERT INTO test_results (api_id, status_code, response_time, result, error_message, tested_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [apiId, 500, 200, 'FAIL', 'Server Error']
    );

    const incident = await incidentRepo.create({
      api_id: apiId,
      workspace_id: ws.id,
      status: 'open',
      first_unhealthy_at: new Date(),
      opened_at: new Date(),
      first_result_id: trRes1.insertId,
      trigger_result_id: trRes1.insertId,
      latest_result_id: trRes1.insertId,
      unhealthy_count: 2,
      error_summary: 'Server Error',
    });

    const app = setupTestApp(pool, aiRepo, evidenceBuilder);

    // 1. Enqueue job via API
    const postRes = await request(app)
      .post(`/api/workspaces/${ws.id}/incidents/${incident.id}/ai-analysis`)
      .set('x-test-user-id', String(user.id))
      .send({});
    assert.equal(postRes.status, 201);
    const jobId = postRes.body.analysis.id;

    // 2. Instantiate AiAnalysisWorker with MockAiProvider and run single poll cycle
    const mockProvider = new MockAiProvider();
    const worker = new AiAnalysisWorker({
      config,
      aiRepo,
      aiProvider: mockProvider,
      workerId: 'test-ai-worker-1',
    });

    const claimedCount = await worker.pollOnce();
    assert.equal(claimedCount, 1);

    // Wait for in-flight job to finish
    await worker.stop();

    // 3. Verify job status updated to 'completed' with structured result
    const completedJob = await aiRepo.findById(jobId, ws.id);
    assert.equal(completedJob.status, 'completed');
    assert.ok(completedJob.result);
    assert.ok(completedJob.result.summary);
    assert.ok(Array.isArray(completedJob.result.observed_facts));
    assert.equal(completedJob.error_message, null);

    // 4. Staleness detection: simulate new execution arriving for the incident
    const [trRes2] = await pool.execute(
      'INSERT INTO test_results (api_id, status_code, response_time, result, error_message, tested_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [apiId, 500, 250, 'FAIL', 'Still down']
    );
    await incidentRepo.update(incident.id, { latest_result_id: trRes2.insertId });

    const latestGet = await request(app)
      .get(`/api/workspaces/${ws.id}/incidents/${incident.id}/ai-analysis`)
      .set('x-test-user-id', String(user.id));

    assert.equal(latestGet.status, 200);
    assert.equal(latestGet.body.is_stale, true);

    // 5. Retention cleanup: backdate job by 40 days and run cleanup(30)
    await pool.execute(
      'UPDATE incident_ai_analyses SET created_at = DATE_SUB(NOW(), INTERVAL 40 DAY) WHERE id = ?',
      [jobId]
    );

    const deleted = await aiRepo.cleanupExpired(30);
    assert.equal(deleted, 1);

    const afterCleanup = await aiRepo.findById(jobId, ws.id);
    assert.equal(afterCleanup, null);
  } finally {
    if (pool) await pool.end();
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});
