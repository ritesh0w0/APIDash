// backend/test/routes.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../app');
const { createApiRouter } = require('../routes/apiRoutes');

function createMockRepositories() {
  const apis = [
    { id: 1, name: 'GitHub Status', url: 'https://www.githubstatus.com', method: 'GET', expected_status: 200, created_at: new Date() },
    { id: 2, name: 'Google', url: 'https://www.google.com', method: 'HEAD', expected_status: 200, created_at: new Date() },
  ];

  const testResults = [
    { id: 101, api_id: 1, status_code: 200, response_time: 120, result: 'PASS', error_message: null, tested_at: new Date() },
    { id: 102, api_id: 1, status_code: 200, response_time: 130, result: 'PASS', error_message: null, tested_at: new Date() },
  ];

  const schedulerRuns = [
    { id: 1, total: 2, passed: 2, failed: 0, avg_ms: 125, ran_at: new Date() },
  ];

  const mockApiRepo = {
    create: async (data) => ({
      id: 3,
      ...data,
    }),
    findById: async (id) => apis.find((a) => String(a.id) === String(id)) || null,
    findAll: async () => apis,
    findAllWithLatestResult: async () => apis.map((a) => ({
      ...a,
      last_status_code: 200,
      last_response_time: 120,
      last_result: 'PASS',
      last_error: null,
      last_tested_at: new Date(),
    })),
    deleteById: async (id) => String(id) === '1',
    getStats: async () => ({
      total: 2,
      passing: 2,
      failing: 0,
      untested: 0,
      avg_response_time: 125,
    }),
  };

  const mockTestResultRepo = {
    create: async (data) => ({ id: 103, ...data }),
    findRecentByApiId: async (_apiId, _limit) => testResults,
    findChartPoints: async (_apiId, _limit) => testResults,
    findWithinHours: async (_apiId, _hours) => testResults,
  };

  const mockSchedulerRunRepo = {
    create: async (data) => ({ id: 2, ...data }),
    findRecent: async (_limit) => [...schedulerRuns],
  };

  const mockWorkspace = { id: 1, name: 'Default Workspace' };
  const mockWorkspaceRepo = {
    findUserWorkspaces: async () => [mockWorkspace],
  };

  const mockUser = { id: 1, email: 'owner@example.com', display_name: 'Owner' };
  const mockRequireAuth = (req, _res, next) => {
    req.user = mockUser;
    if (req.session) {
      req.session.userId = 1;
      req.session.csrfToken = 'test-token';
    }
    next();
  };

  return {
    mockApiRepo,
    mockTestResultRepo,
    mockSchedulerRunRepo,
    mockWorkspaceRepo,
    mockRequireAuth,
  };
}

test('Unauthenticated request to legacy routes is rejected with 401', async () => {
  const { mockApiRepo, mockTestResultRepo, mockSchedulerRunRepo } = createMockRepositories();
  const router = createApiRouter({
    apiRepo: mockApiRepo,
    testResultRepo: mockTestResultRepo,
    schedulerRunRepo: mockSchedulerRunRepo,
  });
  const app = createApp({ apiRouter: router, csrfProtection: (_req, _res, next) => next() });

  const resList = await request(app).get('/api/list');
  assert.equal(resList.status, 401);

  const resAdd = await request(app).post('/api/add').send({ name: 'Test', url: 'https://example.com' });
  assert.equal(resAdd.status, 401);
});

test('POST /api/add validates request body and creates an API monitor when authenticated', async () => {
  const { mockApiRepo, mockTestResultRepo, mockSchedulerRunRepo, mockWorkspaceRepo, mockRequireAuth } = createMockRepositories();
  const router = createApiRouter({
    apiRepo: mockApiRepo,
    testResultRepo: mockTestResultRepo,
    schedulerRunRepo: mockSchedulerRunRepo,
    workspaceRepo: mockWorkspaceRepo,
    requireAuth: mockRequireAuth,
  });
  const app = createApp({ apiRouter: router, csrfProtection: (_req, _res, next) => next() });

  // Missing name and url
  const resEmpty = await request(app).post('/api/add').send({});
  assert.equal(resEmpty.status, 400);
  assert.match(resEmpty.body.error, /name/);

  // Invalid HTTP method
  const resBadMethod = await request(app).post('/api/add').send({
    name: 'Bad Method',
    url: 'https://example.com',
    method: 'INVALID_METHOD',
  });
  assert.equal(resBadMethod.status, 400);
  assert.match(resBadMethod.body.error, /method/);

  // Successful add
  const resSuccess = await request(app).post('/api/add').send({
    name: 'New Service',
    url: 'https://api.example.com/health',
    method: 'GET',
    expected_status: 200,
  });
  assert.equal(resSuccess.status, 201);
  assert.equal(resSuccess.body.message, 'API added successfully');
  assert.equal(resSuccess.body.api.id, 3);
  assert.equal(resSuccess.body.api.name, 'New Service');
});

test('GET /api/list returns all registered APIs with their last result when authenticated', async () => {
  const { mockApiRepo, mockTestResultRepo, mockSchedulerRunRepo, mockWorkspaceRepo, mockRequireAuth } = createMockRepositories();
  const router = createApiRouter({
    apiRepo: mockApiRepo,
    testResultRepo: mockTestResultRepo,
    schedulerRunRepo: mockSchedulerRunRepo,
    workspaceRepo: mockWorkspaceRepo,
    requireAuth: mockRequireAuth,
  });
  const app = createApp({ apiRouter: router, csrfProtection: (_req, _res, next) => next() });

  const res = await request(app).get('/api/list');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 2);
  assert.equal(res.body[0].name, 'GitHub Status');
});

test('GET /api/test/:id returns 404 for unknown API and test result when found', async () => {
  const { mockApiRepo, mockTestResultRepo, mockSchedulerRunRepo, mockWorkspaceRepo, mockRequireAuth } = createMockRepositories();
  const mockTestApiFn = async (api) => ({
    api_id: api.id,
    api_name: api.name,
    result: 'PASS',
    status_code: 200,
    response_time: 45,
  });

  const router = createApiRouter({
    apiRepo: mockApiRepo,
    testResultRepo: mockTestResultRepo,
    schedulerRunRepo: mockSchedulerRunRepo,
    workspaceRepo: mockWorkspaceRepo,
    requireAuth: mockRequireAuth,
    testApiFn: mockTestApiFn,
  });
  const app = createApp({ apiRouter: router, csrfProtection: (_req, _res, next) => next() });

  const res404 = await request(app).get('/api/test/999');
  assert.equal(res404.status, 404);

  const res200 = await request(app).get('/api/test/1');
  assert.equal(res200.status, 200);
  assert.equal(res200.body.result, 'PASS');
  assert.equal(res200.body.status_code, 200);
});

test('DELETE /api/delete/:id returns 404 for missing and 200 when deleted', async () => {
  const { mockApiRepo, mockTestResultRepo, mockSchedulerRunRepo, mockWorkspaceRepo, mockRequireAuth } = createMockRepositories();
  const router = createApiRouter({
    apiRepo: mockApiRepo,
    testResultRepo: mockTestResultRepo,
    schedulerRunRepo: mockSchedulerRunRepo,
    workspaceRepo: mockWorkspaceRepo,
    requireAuth: mockRequireAuth,
  });
  const app = createApp({ apiRouter: router, csrfProtection: (_req, _res, next) => next() });

  const res404 = await request(app).delete('/api/delete/999');
  assert.equal(res404.status, 404);

  const res200 = await request(app).delete('/api/delete/1');
  assert.equal(res200.status, 200);
  assert.equal(res200.body.message, 'API deleted successfully');
});

test('GET /api/stats, /api/chart-data, and /api/scheduler-runs return expected shapes', async () => {
  const { mockApiRepo, mockTestResultRepo, mockSchedulerRunRepo, mockWorkspaceRepo, mockRequireAuth } = createMockRepositories();
  const router = createApiRouter({
    apiRepo: mockApiRepo,
    testResultRepo: mockTestResultRepo,
    schedulerRunRepo: mockSchedulerRunRepo,
    workspaceRepo: mockWorkspaceRepo,
    requireAuth: mockRequireAuth,
  });
  const app = createApp({ apiRouter: router, csrfProtection: (_req, _res, next) => next() });

  const resStats = await request(app).get('/api/stats');
  assert.equal(resStats.status, 200);
  assert.equal(resStats.body.total, 2);
  assert.equal(resStats.body.passing, 2);

  const resChart = await request(app).get('/api/chart-data');
  assert.equal(resChart.status, 200);
  assert.ok(resChart.body['1']);
  assert.equal(resChart.body['1'].points.length, 2);

  const resRuns = await request(app).get('/api/scheduler-runs');
  assert.equal(resRuns.status, 200);
  assert.ok(Array.isArray(resRuns.body));
  assert.equal(resRuns.body[0].total, 2);
});

test('Cross-workspace route authorization with 2 users: prevents IDOR across legacy endpoints', async () => {
  // Setup two isolated workspaces and two users:
  // User 1 belongs to Workspace 1 (Owner)
  // User 2 belongs to Workspace 2 (Owner)
  const apis = [
    { id: 101, workspace_id: 1, name: 'User 1 Monitor', url: 'https://user1.example.com', method: 'GET', expected_status: 200 },
    { id: 201, workspace_id: 2, name: 'User 2 Monitor', url: 'https://user2.example.com', method: 'GET', expected_status: 200 },
  ];

  const testResults = [
    { id: 501, api_id: 101, status_code: 200, response_time: 50, result: 'PASS', error_message: null, tested_at: new Date() },
    { id: 502, api_id: 201, status_code: 200, response_time: 80, result: 'PASS', error_message: null, tested_at: new Date() },
  ];

  const mockApiRepo = {
    findById: async (id, wsId) => {
      if (wsId !== undefined && wsId !== null) {
        return apis.find((a) => a.id === Number(id) && a.workspace_id === Number(wsId)) || null;
      }
      return apis.find((a) => a.id === Number(id)) || null;
    },
    findAll: async (wsId) => apis.filter((a) => (wsId !== undefined && wsId !== null ? a.workspace_id === Number(wsId) : true)),
    findAllByWorkspace: async (wsId) => apis.filter((a) => a.workspace_id === Number(wsId)),
    findAllWithLatestResult: async (wsId) => apis.filter((a) => a.workspace_id === Number(wsId)).map((a) => ({
      ...a,
      last_status_code: 200,
      last_response_time: 50,
      last_result: 'PASS',
      last_error: null,
      last_tested_at: new Date(),
    })),
    deleteById: async (id, wsId) => {
      const idx = apis.findIndex((a) => a.id === Number(id) && (wsId === undefined || wsId === null || a.workspace_id === Number(wsId)));
      if (idx !== -1) {
        apis.splice(idx, 1);
        return true;
      }
      return false;
    },
    deleteByIdAndWorkspace: async (id, wsId) => {
      const idx = apis.findIndex((a) => a.id === Number(id) && a.workspace_id === Number(wsId));
      if (idx !== -1) {
        apis.splice(idx, 1);
        return true;
      }
      return false;
    },
    getStats: async (wsId) => {
      const wsApis = apis.filter((a) => a.workspace_id === Number(wsId));
      return { total: wsApis.length, passing: wsApis.length, failing: 0, untested: 0, avg_response_time: 50 };
    },
  };

  const mockTestResultRepo = {
    findRecentByApiId: async (apiId) => testResults.filter((r) => r.api_id === Number(apiId)),
    findChartPoints: async (apiId) => testResults.filter((r) => r.api_id === Number(apiId)),
    findWithinHours: async (apiId) => testResults.filter((r) => r.api_id === Number(apiId)),
  };

  const mockWorkspaceRepo = {
    findUserWorkspaces: async (userId) => {
      if (userId === 1) return [{ id: 1, name: 'Workspace 1', role: 'owner' }];
      if (userId === 2) return [{ id: 2, name: 'Workspace 2', role: 'owner' }];
      return [];
    },
    getUserRole: async (wsId, userId) => {
      if (wsId === 1 && userId === 1) return 'owner';
      if (wsId === 2 && userId === 2) return 'owner';
      return null;
    },
  };

  const testedApis = [];
  const mockTestApiFn = async (api) => {
    testedApis.push(api.id);
    return { api_id: api.id, api_name: api.name, result: 'PASS', status_code: 200, response_time: 50 };
  };

  // Auth middleware switching on header 'x-test-user-id'
  const dynamicRequireAuth = (req, _res, next) => {
    const uid = Number(req.headers['x-test-user-id'] || 1);
    req.user = { id: uid, email: `user${uid}@example.com` };
    next();
  };

  const apiRouter = createApiRouter({
    apiRepo: mockApiRepo,
    testResultRepo: mockTestResultRepo,
    workspaceRepo: mockWorkspaceRepo,
    requireAuth: dynamicRequireAuth,
    testApiFn: mockTestApiFn,
  });

  const app = createApp({
    apiRouter,
    csrfProtection: (_req, _res, next) => next(),
  });

  // 1. Cross-workspace manual probe execution via legacy route:
  // User 1 attempts to trigger probe on User 2's monitor (id: 201)
  const resProbe = await request(app).get('/api/test/201').set('x-test-user-id', '1');
  assert.equal(resProbe.status, 404, 'Legacy probe on other tenant monitor must return 404');
  assert.ok(!testedApis.includes(201), 'Mock tester must never be invoked for cross-tenant API');

  // 2. Cross-workspace history read via legacy route:
  const resHistory = await request(app).get('/api/history/201').set('x-test-user-id', '1');
  assert.equal(resHistory.status, 404, 'Legacy history on other tenant monitor must return 404');

  // 3. Cross-workspace analytics read via legacy route:
  const resAnalytics = await request(app).get('/api/analytics/201').set('x-test-user-id', '1');
  assert.equal(resAnalytics.status, 404, 'Legacy analytics on other tenant monitor must return 404');

  // 4. Cross-workspace delete via legacy route:
  const resDelete = await request(app).delete('/api/delete/201').set('x-test-user-id', '1');
  assert.equal(resDelete.status, 404, 'Legacy delete on other tenant monitor must return 404');
  assert.ok(apis.some((a) => a.id === 201), 'User 2 monitor must NOT be deleted by User 1');

  // 5. Legacy list query isolation:
  const resList1 = await request(app).get('/api/list').set('x-test-user-id', '1');
  assert.equal(resList1.status, 200);
  assert.equal(resList1.body.length, 1);
  assert.equal(resList1.body[0].id, 101, 'User 1 must only see their own monitor in /api/list');

  const resList2 = await request(app).get('/api/list').set('x-test-user-id', '2');
  assert.equal(resList2.status, 200);
  assert.equal(resList2.body.length, 1);
  assert.equal(resList2.body[0].id, 201, 'User 2 must only see their own monitor in /api/list');

  // 6. Legacy stats isolation:
  const resStats1 = await request(app).get('/api/stats').set('x-test-user-id', '1');
  assert.equal(resStats1.status, 200);
  assert.equal(resStats1.body.total, 1, 'Stats for User 1 must only count User 1 monitors');

  // 7. Legacy chart-data isolation:
  const resChart1 = await request(app).get('/api/chart-data').set('x-test-user-id', '1');
  assert.equal(resChart1.status, 200);
  assert.ok(resChart1.body['101'], 'Chart data must contain User 1 monitor');
  assert.equal(resChart1.body['201'], undefined, 'Chart data must NOT contain User 2 monitor');

  // 8. Legitimate access by owner succeeds:
  const resOwnerProbe = await request(app).get('/api/test/101').set('x-test-user-id', '1');
  assert.equal(resOwnerProbe.status, 200);
  assert.equal(resOwnerProbe.body.result, 'PASS');
  assert.ok(testedApis.includes(101));

  const resOwnerDelete = await request(app).delete('/api/delete/101').set('x-test-user-id', '1');
  assert.equal(resOwnerDelete.status, 200);
  assert.ok(!apis.some((a) => a.id === 101), 'Owner can legitimately delete their own monitor');
});

test('POST /api/add validates and persists headers, timeout_ms, and assertions', async () => {
  const { mockApiRepo, mockTestResultRepo, mockSchedulerRunRepo, mockWorkspaceRepo, mockRequireAuth } = createMockRepositories();
  const router = createApiRouter({
    apiRepo: mockApiRepo,
    testResultRepo: mockTestResultRepo,
    schedulerRunRepo: mockSchedulerRunRepo,
    workspaceRepo: mockWorkspaceRepo,
    requireAuth: mockRequireAuth,
  });
  const app = createApp({ apiRouter: router, csrfProtection: (_req, _res, next) => next() });

  // 1. Invalid assertions config (unsupported type)
  const resBadAssertion = await request(app).post('/api/add').send({
    name: 'Bad Assertion API',
    url: 'https://api.example.com',
    assertions: [{ type: 'unknown_type' }],
  });
  assert.equal(resBadAssertion.status, 400);
  assert.match(resBadAssertion.body.error, /invalid type/i);

  // 2. Prototype pollution path in body_json assertion
  const resProtoAssertion = await request(app).post('/api/add').send({
    name: 'Proto API',
    url: 'https://api.example.com',
    assertions: [{ type: 'body_json', path: 'user.__proto__.admin', equals: true }],
  });
  assert.equal(resProtoAssertion.status, 400);
  assert.match(resProtoAssertion.body.error, /Forbidden property/i);

  // 3. Valid configuration with headers, timeout, and assertions
  const resValid = await request(app).post('/api/add').send({
    name: 'Configured API',
    url: 'https://api.example.com/v1/health',
    method: 'GET',
    timeout_ms: 5000,
    headers: { 'X-Custom-Header': 'TestValue' },
    assertions: [
      { type: 'status', equals: 200 },
      { type: 'latency', max_ms: 800 },
      { type: 'header', header: 'content-type', contains: 'application/json' },
      { type: 'body_json', path: 'status', equals: 'ok' },
    ],
  });
  assert.equal(resValid.status, 201);
  assert.equal(resValid.body.api.timeout_ms, 5000);
  assert.equal(resValid.body.api.assertions.length, 4);
});
