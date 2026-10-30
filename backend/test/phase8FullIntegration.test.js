// backend/test/phase8FullIntegration.test.js
'use strict';

const path = require('path');
const http = require('http');
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
const { TestResultRepository } = require('../data/testResultRepository');
const { IncidentRepository } = require('../data/incidentRepository');
const { NotificationRepository } = require('../data/notificationRepository');
const { ContractRepository } = require('../data/contractRepository');
const { AiAnalysisRepository } = require('../data/aiAnalysisRepository');

const { executeMonitoringRun } = require('../services/monitoringCoordinator');
const { IncidentService } = require('../services/incidentService');
const { NotificationDispatcher } = require('../services/notificationDispatcher');
const { ContractValidatorService } = require('../services/contractValidatorService');
const { IncidentEvidenceBuilder } = require('../services/incidentEvidenceBuilder');
const { AiAnalysisWorker } = require('../services/aiAnalysisWorker');
const {
  FallbackAiProvider,
  ProcessRateLimitTracker,
  AiProviderError,
} = require('../services/aiProviderService');
const { validateAiResponse } = require('../services/aiResponseValidator');
const defaultWorkspaceRouter = require('../routes/workspaceRoutes');
const serializeAnalysisForClient = defaultWorkspaceRouter.serializeAnalysisForClient;
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

test('Phase 8 — End-to-End Multi-Subsystem Integration & Failure Fallback Verification', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible for Phase 8 integration test');
    return;
  }

  const dbName = `apidash_test_p8_full_${Date.now()}`;
  let pool = null;
  let localServer = null;
  let serverPort = 0;
  let localServerRequestCount = 0;

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
      connectionLimit: 10,
    });

    await runMigrations(pool, MIGRATIONS_DIR);

    // ─── 0. Start Local Controlled HTTP Server ──────────────────────────────────
    localServer = http.createServer((req, res) => {
      localServerRequestCount++;
      const url = req.url;

      if (url === '/health-success') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'UP', service: 'orders', code: 200 }));
      } else if (url === '/health-fail-assertion') {
        // Returns 200 but body status is DEGRADED (failing assertions)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'DEGRADED', code: 500 }));
      } else if (url.startsWith('/orders')) {
        // Contract expects { id: integer, total: number }, returns string for total
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 101, total: 'INVALID_STRING_TOTAL' }));
      } else if (url === '/contract-valid') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 101, total: 99.5 }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
      }
    });

    await new Promise((resolve) => {
      localServer.listen(0, '127.0.0.1', () => {
        serverPort = localServer.address().port;
        resolve();
      });
    });

    // ─── Repositories & Services Setup ──────────────────────────────────────────
    const userRepo = new UserRepository(pool);
    const workspaceRepo = new WorkspaceRepository(pool);
    const apiRepo = new ApiRepository(pool);
    const testResultRepo = new TestResultRepository(pool);
    const incidentRepo = new IncidentRepository(pool);
    const notifRepo = new NotificationRepository(pool);
    const contractRepo = new ContractRepository(pool);
    const aiRepo = new AiAnalysisRepository(pool);
    const validatorService = new ContractValidatorService();
    const evidenceBuilder = new IncidentEvidenceBuilder({ incidentRepo, pool });
    const incidentService = new IncidentService({ pool, incidentRepo, notificationRepo: notifRepo });

    // Seed Owner and Workspace
    const user = await userRepo.create({
      email: 'p8-owner@example.com',
      password_hash: 'hash_p8',
      display_name: 'Phase 8 Lead',
    });
    const ws = await workspaceRepo.create({ name: 'Phase 8 Workspace', created_by: user.id });
    await workspaceRepo.createMember({ workspace_id: ws.id, user_id: user.id, role: 'owner' });

    // App with Auth Middleware
    const realAuthMiddleware = createAuthMiddleware({ userRepo, workspaceRepo });
    const testAuthMiddleware = {
      requireAuth: async (req, _res, next) => {
        const userId = Number(req.headers['x-test-user-id']);
        if (!userId) return next(new AppError('Authentication required', 401));
        const u = await userRepo.findById(userId);
        if (!u) return next(new AppError('User not found', 401));
        req.user = u;
        next();
      },
      requireWorkspaceMember: realAuthMiddleware.requireWorkspaceMember,
      requireWorkspaceOwner: realAuthMiddleware.requireWorkspaceOwner,
    };

    const workspaceRouter = createWorkspaceRouter({
      workspaceRepo,
      apiRepo,
      testResultRepo,
      incidentRepo,
      notificationRepo: notifRepo,
      contractRepo,
      aiRepo,
      evidenceBuilder,
      requireAuth: testAuthMiddleware.requireAuth,
      requireWorkspaceMember: testAuthMiddleware.requireWorkspaceMember,
      requireWorkspaceOwner: testAuthMiddleware.requireWorkspaceOwner,
    });

    const app = createApp({
      pool,
      workspaceRouter,
      csrfProtection: (_req, _res, next) => next(),
    });

    // ─── STAGE 3: API Execution & Monitoring with Local HTTP Server ─────────────
    // Controlled local client adapter that connects to localServer
    const localSafeClient = async (options) => {
      return new Promise((resolve, reject) => {
        const u = new URL(options.url);
        const req = http.request(
          {
            hostname: u.hostname,
            port: u.port,
            path: u.pathname + u.search,
            method: options.method || 'GET',
            headers: options.headers || {},
            timeout: options.timeout || 5000,
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              let parsedBody = data;
              try {
                parsedBody = JSON.parse(data);
              } catch (_e) {}
              resolve({
                status: res.statusCode,
                headers: res.headers,
                data: parsedBody,
              });
            });
          }
        );
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy(new Error('timeout of 5000ms exceeded'));
        });
        if (options.data) {
          req.write(typeof options.data === 'string' ? options.data : JSON.stringify(options.data));
        }
        req.end();
      });
    };

    // Subtest 3.1: Monitor with passing assertions produces 'passed' / 'healthy'
    const [m1] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [ws.id, 'Success API', `http://127.0.0.1:${serverPort}/health-success`, 'GET', 200]
    );
    const monitor1Id = m1.insertId;
    const monitor1 = await apiRepo.findById(monitor1Id, ws.id);

    const run1 = await executeMonitoringRun(monitor1, {
      resultRepo: testResultRepo,
      contractRepo,
      validatorService,
      executorFn: async (m, deps) => {
        const { executeRequest } = require('../services/executor');
        return executeRequest(m, { safeClient: localSafeClient, ...deps });
      },
    });

    assert.equal(run1.result, 'passed');
    assert.equal(run1.health_impact, 'healthy');
    assert.equal(run1.status_code, 200);
    assert.ok(run1.response_time >= 0);
    assert.equal(run1.assertions_passed, true);
    assert.ok(run1.id, 'Result must be persisted with DB insertId');

    // Subtest 3.2: Monitor with failing assertions produces 'failed' / 'unhealthy'
    const [m2] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [ws.id, 'Failing Assertion API', `http://127.0.0.1:${serverPort}/health-fail-assertion`, 'GET', 200]
    );
    const monitor2Id = m2.insertId;
    // Set custom assertion: body_json.status equals 'UP' (server returns 'DEGRADED')
    await pool.execute('UPDATE apis SET assertions = ? WHERE id = ?', [
      JSON.stringify([{ type: 'body_json', path: 'status', operator: 'equals', value: 'UP' }]),
      monitor2Id,
    ]);
    const monitor2 = await apiRepo.findById(monitor2Id, ws.id);

    const run2 = await executeMonitoringRun(monitor2, {
      resultRepo: testResultRepo,
      contractRepo,
      validatorService,
      executorFn: async (m, deps) => {
        const { executeRequest } = require('../services/executor');
        return executeRequest(m, { safeClient: localSafeClient, ...deps });
      },
    });

    assert.equal(run2.result, 'failed');
    assert.equal(run2.health_impact, 'unhealthy');
    assert.equal(run2.assertions_passed, false);

    // Subtest 3.3: Connection / Transport error produces 'error' / 'unhealthy'
    const [m3] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [ws.id, 'Dead Port API', 'http://127.0.0.1:59999/does-not-exist', 'GET', 200]
    );
    const monitor3Id = m3.insertId;
    const monitor3 = await apiRepo.findById(monitor3Id, ws.id);

    const run3 = await executeMonitoringRun(monitor3, {
      resultRepo: testResultRepo,
      contractRepo,
      validatorService,
      executorFn: async (m, deps) => {
        const { executeRequest } = require('../services/executor');
        return executeRequest(m, { safeClient: localSafeClient, ...deps });
      },
    });

    assert.equal(run3.result, 'error');
    assert.equal(run3.health_impact, 'unhealthy');
    assert.equal(run3.status_code, null);
    assert.ok(run3.error_message);

    // Subtest 3.4: Sensitive request headers are redacted in diagnostics
    const [m4] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, headers) VALUES (?, ?, ?, ?, ?)',
      [
        ws.id,
        'Auth Redaction API',
        `http://127.0.0.1:${serverPort}/health-success`,
        'GET',
        JSON.stringify({
          Authorization: 'Bearer top-secret-jwt-token',
          'X-API-Key': 'secret-api-key-value',
          Cookie: 'session_id=secret-session-id',
          'Content-Type': 'application/json',
        }),
      ]
    );
    const monitor4 = await apiRepo.findById(m4.insertId, ws.id);

    const run4 = await executeMonitoringRun(monitor4, {
      resultRepo: testResultRepo,
      contractRepo,
      validatorService,
      executorFn: async (m, deps) => {
        const { executeRequest } = require('../services/executor');
        return executeRequest(m, { safeClient: localSafeClient, ...deps });
      },
    });

    const [resultRows] = await pool.execute('SELECT * FROM test_results WHERE id = ?', [run4.id]);
    assert.equal(resultRows.length, 1);
    const persistedResult = resultRows[0];
    assert.equal(persistedResult.result, 'passed');
    assert.equal(persistedResult.status_code, 200);

    // Verify sensitive request headers and error messages are redacted
    const { redactHeaders, sanitizeErrorMessage } = require('../services/executor');
    const dirtyHeaders = {
      authorization: 'Bearer top-secret-jwt-token',
      'x-api-key': 'secret-api-key-value',
      cookie: 'session_id=secret-session-id',
      'content-type': 'application/json',
    };
    const sanitizedHeaders = redactHeaders(dirtyHeaders);
    assert.equal(sanitizedHeaders.authorization, '[REDACTED]');
    assert.equal(sanitizedHeaders['x-api-key'], '[REDACTED]');
    assert.equal(sanitizedHeaders.cookie, '[REDACTED]');
    assert.equal(sanitizedHeaders['content-type'], 'application/json');

    const dirtyError = 'Upstream failed with Authorization: Bearer secret-token and key: secret-key';
    const cleanError = sanitizeErrorMessage(dirtyError);
    assert.ok(!cleanError.includes('secret-token'));
    assert.ok(cleanError.includes('[REDACTED]'));

    // ─── STAGE 4 & 5: Incident Lifecycle (Opening, Persistence, Recovery, Resolution) ─
    // Subtest 5.1: 1st unhealthy execution does NOT open incident (threshold = 2)
    const incRun1 = await incidentService.recordExecutionAndEvaluateIncident(monitor2, run2);
    assert.equal(incRun1.transition, 'first_unhealthy');
    assert.equal(incRun1.incident, null);

    // Subtest 5.2: 2nd consecutive unhealthy execution opens incident
    const incRun2 = await incidentService.recordExecutionAndEvaluateIncident(monitor2, run2);
    assert.equal(incRun2.transition, 'incident_opened');
    assert.ok(incRun2.incident);
    assert.equal(incRun2.incident.status, 'open');
    assert.equal(incRun2.incident.unhealthy_count, 2);
    assert.equal(incRun2.incident.workspace_id, ws.id);
    assert.equal(incRun2.incident.api_id, monitor2.id);
    const activeIncidentId = incRun2.incident.id;

    // Subtest 5.3: 3rd unhealthy execution updates existing incident (no duplicate)
    const incRun3 = await incidentService.recordExecutionAndEvaluateIncident(monitor2, run2);
    assert.equal(incRun3.transition, 'incident_updated');
    assert.equal(incRun3.incident.id, activeIncidentId);
    assert.equal(incRun3.incident.unhealthy_count, 3);

    // Subtest 5.4: 1st healthy execution does NOT resolve incident (requires 2 consecutive healthy)
    const incRun4 = await incidentService.recordExecutionAndEvaluateIncident(monitor2, run1);
    assert.equal(incRun4.transition, 'healthy_streak_incremented');
    assert.equal(incRun4.incident.status, 'open');
    const [healthRows] = await pool.execute('SELECT consecutive_healthy FROM monitor_health_states WHERE api_id = ?', [monitor2.id]);
    assert.equal(healthRows[0].consecutive_healthy, 1);

    // Subtest 5.5: 2nd consecutive healthy execution resolves incident
    const incRun5 = await incidentService.recordExecutionAndEvaluateIncident(monitor2, run1);
    assert.equal(incRun5.transition, 'incident_resolved');
    assert.equal(incRun5.incident.status, 'resolved');
    const resolvedDbIncident = await incidentRepo.findById(activeIncidentId, ws.id);
    assert.equal(resolvedDbIncident.status, 'resolved');
    assert.ok(resolvedDbIncident.resolved_at);

    // ─── STAGE 6: Notification Outbox Processing and Delivery ────────────────────
    // Subtest 6.1: Opening notification was enqueued in outbox
    const [outboxRows] = await pool.execute('SELECT * FROM notification_outbox WHERE workspace_id = ?', [ws.id]);
    assert.ok(outboxRows.length >= 1, 'At least 1 notification event must be enqueued');
    const openEvent = outboxRows.find((e) => e.event_type === 'incident_opened');
    assert.ok(openEvent);
    assert.equal(openEvent.delivery_state, 'pending');

    // Subtest 6.2: Mock SMTP transport marks notification as sent
    await notifRepo.setRecipients(ws.id, [user.id]);

    let sentEmails = [];
    const mockEmailService = {
      config: { smtp: { isConfigured: true } },
      async sendIncidentEmail(options) {
        sentEmails.push(options);
        return { messageId: 'msg-mock-123' };
      },
    };

    const dispatcher = new NotificationDispatcher({
      pool,
      notificationRepo: notifRepo,
      emailService: mockEmailService,
      workerId: 'test-dispatcher-1',
    });

    const dispatchCount = await dispatcher.pollOnce();
    await dispatcher.stop();
    assert.ok(dispatchCount >= 1);
    assert.ok(sentEmails.length >= 1);
    assert.equal(sentEmails[0].eventType, 'incident_opened');
    assert.ok(sentEmails[0].recipients.includes(user.email));

    const [deliveredRows] = await pool.execute('SELECT * FROM notification_outbox WHERE id = ?', [openEvent.id]);
    assert.equal(deliveredRows[0].delivery_state, 'sent');
    assert.ok(deliveredRows[0].sent_at);

    // ─── STAGE 7: OpenAPI Contract Registration, Binding & Validation ───────────
    const contractDoc = {
      openapi: '3.0.0',
      info: { title: 'Order Service API', version: '1.0.0' },
      paths: {
        '/orders': {
          get: {
            summary: 'List orders',
            parameters: [
              {
                name: 'limit',
                in: 'query',
                required: true,
                schema: { type: 'integer', minimum: 1, maximum: 100 },
              },
            ],
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['id', 'total'],
                      properties: {
                        id: { type: 'integer' },
                        total: { type: 'number' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    // Subtest 7.1: Register Contract and Revision
    const contract = await contractRepo.createContract(ws.id, {
      name: 'Orders Contract',
      createdBy: user.id,
    });
    const revision = await contractRepo.createRevision(contract.id, {
      revisionNumber: 1,
      openapiVersion: '3.0.0',
      title: 'Order Service API',
      version: '1.0.0',
      contentSha256: 'dummy-sha-p8',
      specificationContent: contractDoc,
      operationsCatalog: [{ method: 'GET', path: '/orders', operationId: 'listOrders' }],
      createdBy: user.id,
    });

    // Create Monitor Bound to Contract
    const [boundMonRes] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [ws.id, 'Contract Bound API', `http://127.0.0.1:${serverPort}/orders?limit=invalid_not_number`, 'GET', 200]
    );
    const boundMonId = boundMonRes.insertId;

    await contractRepo.createOrUpdateBinding(ws.id, boundMonId, {
      contractId: contract.id,
      revisionId: revision.id,
      pathTemplate: '/orders',
      method: 'GET',
      operationId: null,
    });

    const boundMonitor = await apiRepo.findById(boundMonId, ws.id);

    // Subtest 7.2: Request Preflight validation fails -> halts before HTTP request (zero outbound requests)
    const prevServerReqCount = localServerRequestCount;
    const preflightRun = await executeMonitoringRun(boundMonitor, {
      resultRepo: testResultRepo,
      contractRepo,
      validatorService,
      executorFn: async (m, deps) => {
        const { executeRequest } = require('../services/executor');
        return executeRequest(m, { safeClient: localSafeClient, ...deps });
      },
    });

    assert.equal(localServerRequestCount, prevServerReqCount, 'Local HTTP server must NOT be contacted when preflight fails');
    assert.equal(preflightRun.health_impact, 'neutral', 'Preflight rejection must have neutral health impact');
    assert.equal(preflightRun.contract_valid, false);

    // Subtest 7.3: Preflight passes, request executed, response contract violation detected
    // Update monitor with valid query param 'limit=10'
    await pool.execute('UPDATE apis SET url = ? WHERE id = ?', [
      `http://127.0.0.1:${serverPort}/orders?limit=10`,
      boundMonId,
    ]);
    const updatedBoundMonitor = await apiRepo.findById(boundMonId, ws.id);

    const responseViolationRun = await executeMonitoringRun(updatedBoundMonitor, {
      resultRepo: testResultRepo,
      contractRepo,
      validatorService,
      executorFn: async (m, deps) => {
        const { executeRequest } = require('../services/executor');
        return executeRequest(m, { safeClient: localSafeClient, ...deps });
      },
    });

    assert.ok(localServerRequestCount > prevServerReqCount, 'Local HTTP server MUST be contacted when preflight passes');
    assert.equal(responseViolationRun.result, 'failed');
    assert.equal(responseViolationRun.health_impact, 'unhealthy');
    assert.equal(responseViolationRun.contract_valid, false);
    assert.equal(responseViolationRun.contract_verdict, 'failed');

    // ─── STAGE 8: Full AI Investigation Pipeline with Persisted Incident ────────
    // Create durable test incident for AI analysis
    const [trInc] = await pool.execute(
      'INSERT INTO test_results (api_id, status_code, response_time, result, error_message, tested_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [monitor2.id, 500, 450, 'FAIL', 'HTTP 500 Internal Server Error']
    );
    const incidentTestResultId = trInc.insertId;

    const testIncident = await incidentRepo.create({
      api_id: monitor2.id,
      workspace_id: ws.id,
      status: 'open',
      first_unhealthy_at: new Date(),
      opened_at: new Date(),
      first_result_id: incidentTestResultId,
      trigger_result_id: incidentTestResultId,
      latest_result_id: incidentTestResultId,
      unhealthy_count: 2,
      error_summary: 'Persistent HTTP 500 server error',
    });

    // Build authentic evidence snapshot
    const { evidenceSnapshot } = await evidenceBuilder.buildEvidenceSnapshot(testIncident.id, ws.id);
    assert.ok(evidenceSnapshot.observations.length >= 2);
    const validObsId = evidenceSnapshot.observations[0].id;

    // Subtest 8.1: Full Pipeline Scenario A — Primary Success
    const primarySuccessPayload = JSON.stringify({
      summary: 'Persistent 500 observed on orders endpoint.',
      observed_facts: [{ fact: 'Status is 500.', evidence_ids: [validObsId] }],
      hypotheses: [
        {
          hypothesis: 'Connection timeout.',
          rationale: 'Observed 500 response.',
          supporting_evidence_ids: [validObsId],
          contradicting_evidence_ids: [],
          strength: 'strong',
        },
      ],
      recommended_checks: [{ check: 'Check logs.', rationale: 'Inspect stack trace.', evidence_ids: [validObsId] }],
      unknowns: ['Database health'],
      overall_assessment: { confidence: 'high', rationale: 'Confirmed outage.' },
    });

    const mockPrimarySuccess = {
      async generateAnalysis() {
        return {
          rawText: primarySuccessPayload,
          provider: 'groq',
          model: 'openai/gpt-oss-20b',
          durationMs: 800,
          tokens: { prompt: 100, completion: 50, total: 150 },
        };
      },
    };

    const workerA = new AiAnalysisWorker({
      config,
      aiRepo,
      aiProvider: mockPrimarySuccess,
      workerId: 'worker-p8-a',
    });

    // Trigger analysis via HTTP API
    const postResA = await request(app)
      .post(`/api/workspaces/${ws.id}/incidents/${testIncident.id}/ai-analysis`)
      .set('x-test-user-id', String(user.id))
      .send({});
    assert.equal(postResA.status, 201);
    const jobIdA = postResA.body.analysis.id;

    await workerA.pollOnce();
    await workerA.stop();

    const completedA = await aiRepo.findById(jobIdA, ws.id);
    assert.equal(completedA.status, 'completed');
    assert.equal(completedA.provider, 'groq');
    assert.equal(completedA.result._fallback, undefined, 'Fallback must NOT be present on primary success');

    // Subtest 8.2: Full Pipeline Scenario B — SYN-002 Schema Failure + Alternative Success (Fallback)
    const syn002InvalidPrimary = JSON.stringify({
      summary: 'Persistent 500 observed on orders endpoint.',
      observed_facts: [{ fact: 'Status is 500.', evidence_ids: [validObsId] }],
      hypotheses: [
        {
          hypothesis: 'Connection timeout.',
          rationale: 'Observed 500 response.',
          supporting_evidence_ids: [validObsId],
          contradicting_evidence_ids: [],
          strength: 'strong',
        },
      ],
      recommended_checks: [{ check: 'Check logs.', rationale: 'Inspect stack trace.', evidence_ids: [validObsId] }],
      unknowns: ['Database health'],
      // Missing overall_assessment!
    });

    const syn002ValidAlternative = JSON.stringify({
      summary: 'Persistent 500 observed on orders endpoint.',
      observed_facts: [{ fact: 'Status is 500.', evidence_ids: [validObsId] }],
      hypotheses: [
        {
          hypothesis: 'Connection timeout.',
          rationale: 'Observed 500 response.',
          supporting_evidence_ids: [validObsId],
          contradicting_evidence_ids: [],
          strength: 'strong',
        },
      ],
      recommended_checks: [{ check: 'Check logs.', rationale: 'Inspect stack trace.', evidence_ids: [validObsId] }],
      unknowns: ['Database health'],
      overall_assessment: { confidence: 'high', rationale: 'Confirmed outage after fallback analysis.' },
    });

    let bPrimaryCalls = 0;
    let bAlternativeCalls = 0;

    const mockPrimaryB = {
      async generateAnalysis() {
        bPrimaryCalls++;
        return {
          rawText: syn002InvalidPrimary,
          provider: 'groq',
          model: 'openai/gpt-oss-20b',
          durationMs: 900,
        };
      },
    };

    const mockAlternativeB = {
      async generateAnalysis() {
        bAlternativeCalls++;
        return {
          rawText: syn002ValidAlternative,
          provider: 'openrouter',
          model: 'nvidia/nemotron-3.5-super-vl:free',
          durationMs: 750,
          tokens: { prompt: 120, completion: 60, total: 180 },
        };
      },
    };

    const fallbackProviderB = new FallbackAiProvider({
      primary: mockPrimaryB,
      alternative: mockAlternativeB,
      tracker: new ProcessRateLimitTracker(),
    });

    const workerB = new AiAnalysisWorker({
      config,
      aiRepo,
      aiProvider: fallbackProviderB,
      workerId: 'worker-p8-b',
    });

    // Force new analysis for scenario B
    const postResB = await request(app)
      .post(`/api/workspaces/${ws.id}/incidents/${testIncident.id}/ai-analysis`)
      .set('x-test-user-id', String(user.id))
      .send({ force: true });
    assert.equal(postResB.status, 201);
    const jobIdB = postResB.body.analysis.id;

    await workerB.pollOnce();
    await workerB.stop();

    assert.equal(bPrimaryCalls, 1);
    assert.equal(bAlternativeCalls, 1);

    const completedB = await aiRepo.findById(jobIdB, ws.id);
    assert.equal(completedB.status, 'completed');
    assert.ok(completedB.result._fallback, 'Fallback metadata must be present');
    assert.equal(completedB.result._fallback.provider, 'openrouter');
    assert.equal(completedB.result._fallback.model, 'nvidia/nemotron-3.5-super-vl:free');
    assert.equal(completedB.result._fallback.primary_failure_category, 'SCHEMA_OR_CITATION_FAILURE');
    assert.equal(completedB.result.overall_assessment.confidence, 'high');

    // Subtest 8.3: Full Pipeline Scenario E — Dual Provider Failure is Marked Non-Retryable
    const mockPrimaryFail = {
      async generateAnalysis() {
        throw new AiProviderError('Primary 500 error', 'AI_UPSTREAM_ERROR', 500, true);
      },
    };
    const mockAlternativeFail = {
      async generateAnalysis() {
        throw new AiProviderError('Alternative 502 error', 'AI_UPSTREAM_ERROR', 502, true);
      },
    };

    const dualFailProvider = new FallbackAiProvider({
      primary: mockPrimaryFail,
      alternative: mockAlternativeFail,
      tracker: new ProcessRateLimitTracker(),
    });

    const workerE = new AiAnalysisWorker({
      config,
      aiRepo,
      aiProvider: dualFailProvider,
      workerId: 'worker-p8-e',
    });

    const postResE = await request(app)
      .post(`/api/workspaces/${ws.id}/incidents/${testIncident.id}/ai-analysis`)
      .set('x-test-user-id', String(user.id))
      .send({ force: true });
    assert.equal(postResE.status, 201);
    const jobIdE = postResE.body.analysis.id;

    await workerE.pollOnce();
    await workerE.stop();

    const failedE = await aiRepo.findById(jobIdE, ws.id);
    assert.equal(failedE.status, 'failed');
    assert.equal(failedE.error_code, 'AI_DUAL_PROVIDER_EXHAUSTION');
    assert.ok(failedE.error_message.includes('could not be completed at this time'));

    // Verify worker polling does NOT re-claim the failed non-retryable job!
    const reclaims = await aiRepo.claimDueJobs(5, { workerId: 'worker-check', leaseMs: 30000 });
    const duplicateClaims = reclaims.filter((j) => j.id === jobIdE);
    assert.equal(duplicateClaims.length, 0, 'Dual failure job must NOT be re-claimed in worker loop');

    // Subtest 8.4: Diagnostic Privacy & Client Serialization via GET route
    const getResB = await request(app)
      .get(`/api/workspaces/${ws.id}/incidents/${testIncident.id}/ai-analysis`)
      .set('x-test-user-id', String(user.id));
    assert.equal(getResB.status, 200);
    assert.equal(getResB.body.analysis.lease_owner_token, undefined, 'lease_owner_token must never reach client');
    assert.equal(getResB.body.analysis.lease_expires_at, undefined, 'lease_expires_at must never reach client');

    // Subtest 8.5: Hallucinated Evidence ID rejection
    const hallucinatedPayload = JSON.stringify({
      summary: 'Hallucinating evidence IDs.',
      observed_facts: [{ fact: 'Fake observation.', evidence_ids: ['E-HALLUCINATED-999'] }],
      hypotheses: [{ hypothesis: 'Fake.', rationale: 'None.', supporting_evidence_ids: ['E-HALLUCINATED-999'], contradicting_evidence_ids: [], strength: 'weak' }],
      recommended_checks: [{ check: 'None.', rationale: 'None.', evidence_ids: ['E-HALLUCINATED-999'] }],
      unknowns: [],
      overall_assessment: { confidence: 'low', rationale: 'Uncertain.' },
    });

    const hallucinatedValidation = validateAiResponse(hallucinatedPayload, evidenceSnapshot);
    assert.equal(hallucinatedValidation.valid, false, 'Validator must reject hallucinated evidence IDs');
    assert.ok(hallucinatedValidation.invalidEvidenceIds.includes('E-HALLUCINATED-999'));

  } finally {
    if (localServer) {
      await new Promise((resolve) => localServer.close(resolve));
    }
    if (pool) await pool.end();
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});
