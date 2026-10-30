// backend/routes/apiRoutes.js
'use strict';

const express = require('express');
const { apiRepository: defaultApiRepo } = require('../data/apiRepository');
const { testResultRepository: defaultTestResultRepo } = require('../data/testResultRepository');
const { schedulerRunRepository: defaultSchedulerRunRepo } = require('../data/schedulerRunRepository');
const { workspaceRepository: defaultWorkspaceRepo } = require('../data/workspaceRepository');
const { testApi: defaultTestApi } = require('../services/tester');
const { getApiAnalytics: defaultGetApiAnalytics, getGlobalAnalytics: defaultGetGlobalAnalytics } = require('../services/analytics');
const { requireAuth: defaultRequireAuth } = require('../middleware/auth');
const { asyncHandler, NotFoundError } = require('../middleware/errors');
const { validateUrlSyntax } = require('../services/ssrfProtection');
const { validateBody, createApiSchema } = require('../middleware/validation');

/**
 * Creates and configures the legacy compatibility API router.
 * All operations are strictly authenticated and scoped to the user's workspace,
 * preventing any anonymous access or cross-tenant authorization bypass.
 *
 * @param {Object} [deps]
 * @returns {express.Router}
 */
function createApiRouter(deps = {}) {
  const router = express.Router();

  const apiRepo = deps.apiRepo || defaultApiRepo;
  const testResultRepo = deps.testResultRepo || defaultTestResultRepo;
  const schedulerRunRepo = deps.schedulerRunRepo || defaultSchedulerRunRepo;
  const workspaceRepo = deps.workspaceRepo || defaultWorkspaceRepo;
  const testApiFn = deps.testApiFn || defaultTestApi;
  const getApiAnalyticsFn = deps.getApiAnalyticsFn || defaultGetApiAnalytics;
  const getGlobalAnalyticsFn = deps.getGlobalAnalyticsFn || defaultGetGlobalAnalytics;
  const requireAuth = deps.requireAuth || defaultRequireAuth;

  /**
   * Helper to resolve the authenticated user's active/primary workspace.
   */
  async function resolveUserWorkspaceId(req) {
    if (req.user && req.user.id) {
      const workspaces = await workspaceRepo.findUserWorkspaces(req.user.id);
      if (workspaces.length > 0) {
        return workspaces[0].id;
      }
    }
    return null;
  }

  // Enforce authentication on all legacy compatibility routes
  router.use(requireAuth);

  // Enforce workspace membership and resolve workspaceId for all legacy compatibility routes
  router.use(asyncHandler(async (req, _res, next) => {
    const workspaceId = await resolveUserWorkspaceId(req);
    if (!workspaceId) {
      throw new NotFoundError('No active workspace found for user');
    }
    req.workspaceId = workspaceId;
    next();
  }));

  // ─── POST /api/add ────────────────────────────────────────────────────────────
  router.post('/add', validateBody(createApiSchema), asyncHandler(async (req, res) => {
    const { name, url, method, expected_status, headers, body, timeout_ms, assertions } = req.body;
    validateUrlSyntax(url);

    const createdApi = await apiRepo.create({
      workspace_id: req.workspaceId,
      name,
      url,
      method,
      expected_status,
      headers,
      body,
      timeout_ms,
      assertions,
    });

    return res.status(201).json({
      message: 'API added successfully',
      api: createdApi,
    });
  }));

  // ─── GET /api/test/:id ────────────────────────────────────────────────────────
  router.get('/test/:id', asyncHandler(async (req, res) => {
    const api = await apiRepo.findById(req.params.id, req.workspaceId);
    if (!api) {
      throw new NotFoundError(`No API found with id ${req.params.id}`);
    }

    const testResult = await testApiFn(api);
    return res.json(testResult);
  }));

  // ─── GET /api/list ────────────────────────────────────────────────────────────
  router.get('/list', asyncHandler(async (req, res) => {
    const rows = await apiRepo.findAllWithLatestResult(req.workspaceId);
    return res.json(rows);
  }));

  // ─── GET /api/history/:id ─────────────────────────────────────────────────────
  router.get('/history/:id', asyncHandler(async (req, res) => {
    const api = await apiRepo.findById(req.params.id, req.workspaceId);
    if (!api) {
      throw new NotFoundError(`No API found with id ${req.params.id}`);
    }

    const rows = await testResultRepo.findRecentByApiId(req.params.id, 20, req.workspaceId);
    return res.json(rows);
  }));

  // ─── GET /api/stats ──────────────────────────────────────────────────────────
  router.get('/stats', asyncHandler(async (req, res) => {
    const stats = await apiRepo.getStats(req.workspaceId);
    return res.json(stats);
  }));

  // ─── GET /api/chart-data ──────────────────────────────────────────────────────
  router.get('/chart-data', asyncHandler(async (req, res) => {
    const apis = await apiRepo.findAll(req.workspaceId);
    const result = {};

    await Promise.all(apis.map(async (api) => {
      const rows = await testResultRepo.findChartPoints(api.id, 10, req.workspaceId);
      result[api.id] = { name: api.name, points: rows.reverse() };
    }));

    return res.json(result);
  }));

  // ─── DELETE /api/delete/:id ───────────────────────────────────────────────────
  router.delete('/delete/:id', asyncHandler(async (req, res) => {
    const deleted = await apiRepo.deleteById(req.params.id, req.workspaceId);
    if (!deleted) {
      throw new NotFoundError('API not found');
    }
    return res.json({ message: 'API deleted successfully' });
  }));

  // ─── GET /api/analytics/summary ──────────────────────────────────────────────
  router.get('/analytics/summary', asyncHandler(async (req, res) => {
    const hours = parseInt(req.query.hours, 10) || 24;
    const data = await getGlobalAnalyticsFn(hours, {
      workspaceId: req.workspaceId,
      apiRepo,
      testResultRepo,
      runRepo: schedulerRunRepo,
    });
    return res.json(data);
  }));

  // ─── GET /api/analytics/:id ───────────────────────────────────────────────────
  router.get('/analytics/:id', asyncHandler(async (req, res) => {
    const hours = parseInt(req.query.hours, 10) || 24;
    const api = await apiRepo.findById(req.params.id, req.workspaceId);
    if (!api) {
      throw new NotFoundError(`No API with id ${req.params.id}`);
    }

    const data = await getApiAnalyticsFn(req.params.id, hours, {
      workspaceId: req.workspaceId,
      testResultRepo,
    });
    return res.json(data);
  }));

  // ─── GET /api/scheduler-runs ─────────────────────────────────────────────────
  router.get('/scheduler-runs', asyncHandler(async (_req, res) => {
    const rows = await schedulerRunRepo.findRecent(60);
    return res.json(rows.reverse()); // oldest -> newest for charting
  }));

  return router;
}

const defaultRouter = createApiRouter();
defaultRouter.createApiRouter = createApiRouter;

module.exports = defaultRouter;
