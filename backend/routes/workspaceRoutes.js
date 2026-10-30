// backend/routes/workspaceRoutes.js
'use strict';

const express = require('express');
const { workspaceRepository: defaultWorkspaceRepo } = require('../data/workspaceRepository');
const { apiRepository: defaultApiRepo } = require('../data/apiRepository');
const { testResultRepository: defaultTestResultRepo } = require('../data/testResultRepository');
const { schedulerRunRepository: defaultSchedulerRunRepo } = require('../data/schedulerRunRepository');
const { userRepository: defaultUserRepo } = require('../data/userRepository');
const { incidentRepository: defaultIncidentRepo } = require('../data/incidentRepository');
const { notificationRepository: defaultNotificationRepo } = require('../data/notificationRepository');
const { contractRepository: defaultContractRepo } = require('../data/contractRepository');
const { aiAnalysisRepository: defaultAiRepo } = require('../data/aiAnalysisRepository');
const { incidentEvidenceBuilder: defaultEvidenceBuilder } = require('../services/incidentEvidenceBuilder');
const { PROMPT_VERSION, SCHEMA_VERSION } = require('../ai/prompts/systemPrompt.v1');
const { parseAndValidateOpenAPI } = require('../services/openapiParserService');
const { loadConfig } = require('../config');
const { testApi: defaultTestApi } = require('../services/tester');
const { getApiAnalytics: defaultGetApiAnalytics, getGlobalAnalytics: defaultGetGlobalAnalytics } = require('../services/analytics');
const { requireAuth: defaultRequireAuth, requireWorkspaceMember: defaultRequireWorkspaceMember, requireWorkspaceOwner: defaultRequireWorkspaceOwner } = require('../middleware/auth');
const {
  validateBody,
  validateParams,
  validateQuery,
  createWorkspaceSchema,
  addMemberSchema,
  createApiSchema,
  workspaceIdParamSchema,
  workspaceAndApiIdParamSchema,
  incidentsQuerySchema,
  workspaceAndIncidentIdParamSchema,
  workspaceAndAnalysisIdParamSchema,
  triggerAiAnalysisBodySchema,
  updateNotificationSettingsSchema,
  createContractSchema,
  createRevisionSchema,
  contractIdParamSchema,
  revisionNumberParamSchema,
  bindContractSchema,
  contractResultsQuerySchema,
} = require('../middleware/validation');
const { asyncHandler, AppError, NotFoundError } = require('../middleware/errors');
const { probeLimiter } = require('../middleware/rateLimiters');

/**
 * Strips sensitive internal worker lease tokens and redacts credentials/keys from client-facing responses.
 *
 * @param {Object} [analysis]
 * @returns {Object|null}
 */
function serializeAnalysisForClient(analysis) {
  if (!analysis) return null;
  const clone = { ...analysis };
  delete clone.lease_owner_token;
  delete clone.lease_expires_at;

  if (clone.error_message) {
    clone.error_message = String(clone.error_message)
      .replace(/gsk_[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]')
      .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED_API_KEY]')
      .replace(/AIza[A-Za-z0-9_-]{35}/g, '[REDACTED_API_KEY]')
      .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
      .replace(/key=[A-Za-z0-9_-]+/gi, 'key=[REDACTED]');
  }

  return clone;
}

/**
 * Creates the workspace management and workspace-scoped monitoring router.
 *
 * @param {Object} [deps]
 * @returns {express.Router}
 */
function createWorkspaceRouter(deps = {}) {
  const router = express.Router();

  const workspaceRepo = deps.workspaceRepo || defaultWorkspaceRepo;
  const apiRepo = deps.apiRepo || defaultApiRepo;
  const testResultRepo = deps.testResultRepo || defaultTestResultRepo;
  const schedulerRunRepo = deps.schedulerRunRepo || defaultSchedulerRunRepo;
  const userRepo = deps.userRepo || defaultUserRepo;
  const incidentRepo = deps.incidentRepo || defaultIncidentRepo;
  const notificationRepo = deps.notificationRepo || defaultNotificationRepo;
  const contractRepo = deps.contractRepo || defaultContractRepo;
  const aiRepo = deps.aiRepo || defaultAiRepo;
  const evidenceBuilder = deps.evidenceBuilder || defaultEvidenceBuilder;
  const testApiFn = deps.testApiFn || defaultTestApi;
  const getApiAnalyticsFn = deps.getApiAnalyticsFn || defaultGetApiAnalytics;
  const getGlobalAnalyticsFn = deps.getGlobalAnalyticsFn || defaultGetGlobalAnalytics;

  const requireAuth = deps.requireAuth || defaultRequireAuth;
  const requireWorkspaceMember = deps.requireWorkspaceMember || defaultRequireWorkspaceMember;
  const requireWorkspaceOwner = deps.requireWorkspaceOwner || defaultRequireWorkspaceOwner;

  // ─── Top-level Workspace Routes ─────────────────────────────────────────────

  // GET /api/workspaces — List all workspaces for the authenticated user
  router.get(
    '/',
    requireAuth,
    asyncHandler(async (req, res) => {
      const workspaces = await workspaceRepo.findUserWorkspaces(req.user.id);
      return res.json(workspaces);
    })
  );

  // POST /api/workspaces — Create a new workspace (creator becomes owner)
  router.post(
    '/',
    requireAuth,
    validateBody(createWorkspaceSchema),
    asyncHandler(async (req, res) => {
      const { name } = req.body;
      const workspace = await workspaceRepo.create({
        name,
        created_by: req.user.id,
      });

      await workspaceRepo.createMember({
        workspace_id: workspace.id,
        user_id: req.user.id,
        role: 'owner',
      });

      return res.status(201).json({
        message: 'Workspace created successfully',
        workspace: {
          id: workspace.id,
          name: workspace.name,
          role: 'owner',
        },
      });
    })
  );

  // ─── Workspace-Scoped Sub-Router (/api/workspaces/:workspaceId) ─────────────
  const scopedRouter = express.Router({ mergeParams: true });

  scopedRouter.use(requireAuth);
  scopedRouter.use(validateParams(workspaceIdParamSchema));
  scopedRouter.use(requireWorkspaceMember);

  // GET /api/workspaces/:workspaceId — Get workspace details
  scopedRouter.get(
    '/',
    asyncHandler(async (req, res) => {
      const workspace = await workspaceRepo.findById(req.workspaceId);
      if (!workspace) {
        throw new NotFoundError('Workspace not found');
      }
      return res.json({
        ...workspace,
        role: req.membership.role,
      });
    })
  );

  // PATCH /api/workspaces/:workspaceId — Update workspace name (owner only)
  scopedRouter.patch(
    '/',
    requireWorkspaceOwner,
    validateBody(createWorkspaceSchema),
    asyncHandler(async (req, res) => {
      const { name } = req.body;
      await workspaceRepo.update(req.workspaceId, { name });
      return res.json({ message: 'Workspace updated successfully', name });
    })
  );

  // DELETE /api/workspaces/:workspaceId — Delete workspace (owner only)
  scopedRouter.delete(
    '/',
    requireWorkspaceOwner,
    asyncHandler(async (req, res) => {
      await workspaceRepo.deleteById(req.workspaceId);
      return res.json({ message: 'Workspace deleted successfully' });
    })
  );

  // GET /api/workspaces/:workspaceId/members — List workspace members
  scopedRouter.get(
    '/members',
    asyncHandler(async (req, res) => {
      const members = await workspaceRepo.findMembers(req.workspaceId);
      return res.json(members);
    })
  );

  // POST /api/workspaces/:workspaceId/members — Add member by email (owner only)
  scopedRouter.post(
    '/members',
    requireWorkspaceOwner,
    validateBody(addMemberSchema),
    asyncHandler(async (req, res) => {
      const { email, role } = req.body;
      const targetUser = await userRepo.findByEmail(email);
      if (!targetUser) {
        throw new NotFoundError(`No registered user found with email: ${email}`);
      }

      const existingMember = await workspaceRepo.findMembership(req.workspaceId, targetUser.id);
      if (existingMember) {
        throw new AppError('User is already a member of this workspace', 400);
      }

      const member = await workspaceRepo.createMember({
        workspace_id: req.workspaceId,
        user_id: targetUser.id,
        role,
      });

      return res.status(201).json({
        message: 'Member added successfully',
        member: {
          id: member.id,
          user_id: targetUser.id,
          email: targetUser.email,
          display_name: targetUser.display_name,
          role: member.role,
        },
      });
    })
  );

  // DELETE /api/workspaces/:workspaceId/members/:userId — Remove member (owner only)
  scopedRouter.delete(
    '/members/:userId',
    requireWorkspaceOwner,
    asyncHandler(async (req, res) => {
      const targetUserId = Number(req.params.userId);
      if (!targetUserId || isNaN(targetUserId)) {
        throw new AppError('Invalid member user ID', 400);
      }

      const membership = await workspaceRepo.findMembership(req.workspaceId, targetUserId);
      if (!membership) {
        throw new NotFoundError('Member not found in this workspace');
      }

      // Invariant: Do not allow removing the final owner
      if (membership.role === 'owner') {
        const ownerCount = await workspaceRepo.countOwners(req.workspaceId);
        if (ownerCount <= 1) {
          throw new AppError('Cannot remove the final owner of a workspace. Assign another owner first.', 400);
        }
      }

      await workspaceRepo.removeMember(req.workspaceId, targetUserId);
      return res.json({ message: 'Member removed successfully' });
    })
  );

  // ─── Scoped API Monitor Endpoints ──────────────────────────────────────────

  // GET /api/workspaces/:workspaceId/apis — List all monitors in this workspace
  scopedRouter.get(
    '/apis',
    asyncHandler(async (req, res) => {
      const apis = await apiRepo.findAllWithLatestResult(req.workspaceId);
      return res.json(apis);
    })
  );

  // POST /api/workspaces/:workspaceId/apis — Register monitor in this workspace
  scopedRouter.post(
    '/apis',
    validateBody(createApiSchema),
    asyncHandler(async (req, res) => {
      const { name, url, method, expected_status, headers, body, timeout_ms, assertions } = req.body;

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
    })
  );

  // GET /api/workspaces/:workspaceId/apis/:id — View single monitor in workspace
  scopedRouter.get(
    '/apis/:id',
    validateParams(workspaceAndApiIdParamSchema),
    asyncHandler(async (req, res) => {
      const api = await apiRepo.findById(req.params.id, req.workspaceId);
      if (!api) {
        throw new NotFoundError(`No API found with id ${req.params.id} in this workspace`);
      }
      return res.json(api);
    })
  );

  // DELETE /api/workspaces/:workspaceId/apis/:id — Delete monitor in workspace
  scopedRouter.delete(
    '/apis/:id',
    validateParams(workspaceAndApiIdParamSchema),
    asyncHandler(async (req, res) => {
      const deleted = await apiRepo.deleteById(req.params.id, req.workspaceId);
      if (!deleted) {
        throw new NotFoundError(`No API found with id ${req.params.id} in this workspace`);
      }
      return res.json({ message: 'API deleted successfully' });
    })
  );

  // GET /api/workspaces/:workspaceId/apis/:id/test — Manual on-demand probe
  scopedRouter.get(
    '/apis/:id/test',
    probeLimiter,
    validateParams(workspaceAndApiIdParamSchema),
    asyncHandler(async (req, res) => {
      const api = await apiRepo.findById(req.params.id, req.workspaceId);
      if (!api) {
        throw new NotFoundError(`No API found with id ${req.params.id} in this workspace`);
      }

      const testResult = await testApiFn(api);
      return res.json(testResult);
    })
  );

  // GET /api/workspaces/:workspaceId/apis/:id/history — History for monitor
  scopedRouter.get(
    '/apis/:id/history',
    validateParams(workspaceAndApiIdParamSchema),
    asyncHandler(async (req, res) => {
      const api = await apiRepo.findById(req.params.id, req.workspaceId);
      if (!api) {
        throw new NotFoundError(`No API found with id ${req.params.id} in this workspace`);
      }

      const history = await testResultRepo.findRecentByApiId(req.params.id, 20, req.workspaceId);
      return res.json(history);
    })
  );

  // GET /api/workspaces/:workspaceId/stats — Aggregate stats for workspace
  scopedRouter.get(
    '/stats',
    asyncHandler(async (req, res) => {
      const stats = await apiRepo.getStats(req.workspaceId);
      return res.json(stats);
    })
  );

  // GET /api/workspaces/:workspaceId/chart-data — Latency chart data for workspace
  scopedRouter.get(
    '/chart-data',
    asyncHandler(async (req, res) => {
      const apis = await apiRepo.findAll(req.workspaceId);
      const result = {};

      await Promise.all(apis.map(async (api) => {
        const rows = await testResultRepo.findChartPoints(api.id, 10, req.workspaceId);
        result[api.id] = { name: api.name, points: rows.reverse() };
      }));

      return res.json(result);
    })
  );

  // GET /api/workspaces/:workspaceId/analytics/summary — Global summary for workspace
  scopedRouter.get(
    '/analytics/summary',
    asyncHandler(async (req, res) => {
      const hours = parseInt(req.query.hours, 10) || 24;
      const data = await getGlobalAnalyticsFn(hours, {
        workspaceId: req.workspaceId,
        apiRepo,
        testResultRepo,
        runRepo: schedulerRunRepo,
      });
      return res.json(data);
    })
  );

  // GET /api/workspaces/:workspaceId/analytics/:id — Per-API deep analytics
  scopedRouter.get(
    '/analytics/:id',
    validateParams(workspaceAndApiIdParamSchema),
    asyncHandler(async (req, res) => {
      const hours = parseInt(req.query.hours, 10) || 24;
      const api = await apiRepo.findById(req.params.id, req.workspaceId);
      if (!api) {
        throw new NotFoundError(`No API with id ${req.params.id} in this workspace`);
      }

      const data = await getApiAnalyticsFn(req.params.id, hours, {
        workspaceId: req.workspaceId,
        testResultRepo,
      });
      return res.json(data);
    })
  );

  // GET /api/workspaces/:workspaceId/scheduler-runs — Scheduler runs timeline
  scopedRouter.get(
    '/scheduler-runs',
    asyncHandler(async (req, res) => {
      let rows = [];
      if (typeof schedulerRunRepo.findRecentByWorkspace === 'function') {
        rows = await schedulerRunRepo.findRecentByWorkspace(req.workspaceId, 60);
      } else {
        rows = await schedulerRunRepo.findRecent(60);
      }
      return res.json(rows.reverse());
    })
  );

  // ─── Scoped Incident Endpoints ─────────────────────────────────────────────

  // GET /api/workspaces/:workspaceId/incidents — List workspace incidents (paginated & filtered)
  scopedRouter.get(
    '/incidents',
    validateQuery(incidentsQuerySchema),
    asyncHandler(async (req, res) => {
      const { status, page, limit } = req.query;
      const offset = (page - 1) * limit;
      const incidents = await incidentRepo.listByWorkspace(req.workspaceId, { status, limit, offset });
      const total = await incidentRepo.countByWorkspace(req.workspaceId, { status });
      return res.json({
        incidents,
        total,
        page,
        limit,
      });
    })
  );

  // GET /api/workspaces/:workspaceId/incidents/:id — View single incident with result history
  scopedRouter.get(
    '/incidents/:id',
    validateParams(workspaceAndIncidentIdParamSchema),
    asyncHandler(async (req, res) => {
      const incident = await incidentRepo.findById(req.params.id, req.workspaceId);
      if (!incident) {
        throw new NotFoundError('Incident not found');
      }

      const recentResults = await testResultRepo.findRecentByApiId(incident.api_id, 15);
      return res.json({
        incident,
        results: recentResults,
      });
    })
  );

  // ─── Scoped AI Incident Investigation Endpoints (Phase 7) ───────────────────

  // GET /api/workspaces/:workspaceId/ai-status — Check whether AI is enabled and active model
  scopedRouter.get(
    '/ai-status',
    asyncHandler(async (_req, res) => {
      const appConfig = deps.config || loadConfig();
      const provider = (appConfig.ai && appConfig.ai.provider) || 'disabled';
      const isEnabled = Boolean(appConfig.ai && appConfig.ai.isEnabled);
      let model = 'none';
      if (provider === 'gemini') {
        model = (appConfig.ai && appConfig.ai.gemini && appConfig.ai.gemini.model) || 'gemini-3.8-flash';
      } else if (provider === 'ollama') {
        model = (appConfig.ai && appConfig.ai.ollama && appConfig.ai.ollama.model) || 'qwen3.5:4b';
      } else if (provider === 'openrouter') {
        model = (appConfig.ai && appConfig.ai.openrouter && appConfig.ai.openrouter.model) || 'openai/gpt-oss-20b:free';
      } else if (provider === 'groq' || provider === 'fallback') {
        model = (appConfig.ai && appConfig.ai.groq && appConfig.ai.groq.model) || 'openai/gpt-oss-20b';
      } else if (provider === 'mock') {
        model = 'mock-model';
      }

      return res.json({
        enabled: isEnabled,
        provider,
        model,
      });
    })
  );


  // POST /api/workspaces/:workspaceId/incidents/:id/ai-analysis — Request an AI investigation
  scopedRouter.post(
    '/incidents/:id/ai-analysis',
    validateParams(workspaceAndIncidentIdParamSchema),
    validateBody(triggerAiAnalysisBodySchema),
    asyncHandler(async (req, res) => {
      const incident = await incidentRepo.findById(req.params.id, req.workspaceId);
      if (!incident) {
        throw new NotFoundError('Incident not found');
      }

      const appConfig = deps.config || loadConfig();
      const provider = (appConfig.ai && appConfig.ai.provider) || 'disabled';
      let model = 'default';
      if (provider === 'gemini') {
        model = (appConfig.ai && appConfig.ai.gemini && appConfig.ai.gemini.model) || 'gemini-3.8-flash';
      } else if (provider === 'ollama') {
        model = (appConfig.ai && appConfig.ai.ollama && appConfig.ai.ollama.model) || 'qwen3.5:4b';
      } else if (provider === 'openrouter') {
        model = (appConfig.ai && appConfig.ai.openrouter && appConfig.ai.openrouter.model) || 'openai/gpt-oss-20b:free';
      } else if (provider === 'groq' || provider === 'fallback') {
        model = (appConfig.ai && appConfig.ai.groq && appConfig.ai.groq.model) || 'openai/gpt-oss-20b';
      } else if (provider === 'mock') {
        model = 'mock-model';
      }

      // Build bounded, sanitized evidence package deterministically
      const { evidenceSnapshot, evidenceFingerprint } = await evidenceBuilder.buildEvidenceSnapshot(
        incident.id,
        req.workspaceId
      );

      const forceNew = Boolean(req.body && (req.body.force || req.body.forceNew));

      const { job, isExisting } = await aiRepo.createJob({
        workspace_id: req.workspaceId,
        incident_id: incident.id,
        created_by_user_id: req.user.id,
        provider,
        model,
        prompt_version: PROMPT_VERSION,
        schema_version: SCHEMA_VERSION,
        evidence_snapshot: evidenceSnapshot,
        evidence_fingerprint: evidenceFingerprint,
        forceNew,
      });

      const isStale = Boolean(
        incident.latest_result_id &&
        job.evidence_snapshot &&
        job.evidence_snapshot.latest_result_id &&
        incident.latest_result_id !== job.evidence_snapshot.latest_result_id
      );

      return res.status(isExisting ? 200 : 201).json({
        analysis: serializeAnalysisForClient(job),
        is_existing: isExisting,
        is_stale: isStale,
      });
    })
  );

  // GET /api/workspaces/:workspaceId/incidents/:id/ai-analysis — Get latest AI analysis for an incident
  scopedRouter.get(
    '/incidents/:id/ai-analysis',
    validateParams(workspaceAndIncidentIdParamSchema),
    asyncHandler(async (req, res) => {
      const incident = await incidentRepo.findById(req.params.id, req.workspaceId);
      if (!incident) {
        throw new NotFoundError('Incident not found');
      }

      const latest = await aiRepo.getLatestByIncident(incident.id, req.workspaceId);
      if (!latest) {
        return res.json({ analysis: null, is_stale: false });
      }

      const isStale = Boolean(
        incident.latest_result_id &&
        latest.evidence_snapshot &&
        latest.evidence_snapshot.latest_result_id &&
        incident.latest_result_id !== latest.evidence_snapshot.latest_result_id
      );

      return res.json({
        analysis: serializeAnalysisForClient(latest),
        is_stale: isStale,
        current_incident_status: incident.status,
      });
    })
  );

  // GET /api/workspaces/:workspaceId/incidents/:id/ai-analyses — List prior AI analyses
  scopedRouter.get(
    '/incidents/:id/ai-analyses',
    validateParams(workspaceAndIncidentIdParamSchema),
    asyncHandler(async (req, res) => {
      const incident = await incidentRepo.findById(req.params.id, req.workspaceId);
      if (!incident) {
        throw new NotFoundError('Incident not found');
      }

      const history = await aiRepo.listByIncident(incident.id, req.workspaceId, {
        limit: req.query.limit,
        offset: req.query.offset,
      });

      return res.json({ analyses: (history || []).map(serializeAnalysisForClient) });
    })
  );

  // GET /api/workspaces/:workspaceId/ai-analyses/:analysisId — View specific analysis record
  scopedRouter.get(
    '/ai-analyses/:analysisId',
    validateParams(workspaceAndAnalysisIdParamSchema),
    asyncHandler(async (req, res) => {
      const analysis = await aiRepo.findById(req.params.analysisId, req.workspaceId);
      if (!analysis) {
        throw new NotFoundError('Analysis record not found');
      }

      return res.json({ analysis: serializeAnalysisForClient(analysis) });
    })
  );

  // ─── Scoped Notification Settings Endpoints ─────────────────────────────────

  // GET /api/workspaces/:workspaceId/notification-settings — Read notification preferences & recipients
  scopedRouter.get(
    '/notification-settings',
    asyncHandler(async (req, res) => {
      const settings = await notificationRepo.getSettings(req.workspaceId);
      const recipients = await notificationRepo.getRecipients(req.workspaceId);
      const members = await workspaceRepo.findMembers(req.workspaceId);
      const appConfig = (deps.config) || loadConfig();

      return res.json({
        settings,
        recipients,
        members,
        smtpConfigured: Boolean(appConfig.smtp && appConfig.smtp.isConfigured),
        canEdit: req.membership.role === 'owner',
      });
    })
  );

  // PUT /api/workspaces/:workspaceId/notification-settings — Update notification preferences (owner only)
  scopedRouter.put(
    '/notification-settings',
    requireWorkspaceOwner,
    validateBody(updateNotificationSettingsSchema),
    asyncHandler(async (req, res) => {
      const { notify_on_open, notify_on_resolve, recipient_user_ids } = req.body;

      const updatedSettings = await notificationRepo.updateSettings(req.workspaceId, {
        notify_on_open,
        notify_on_resolve,
      });

      let updatedRecipients = null;
      if (recipient_user_ids !== undefined) {
        updatedRecipients = await notificationRepo.setRecipients(req.workspaceId, recipient_user_ids);
      } else {
        updatedRecipients = await notificationRepo.getRecipients(req.workspaceId);
      }

      return res.json({
        message: 'Notification settings updated successfully',
        settings: updatedSettings,
        recipients: updatedRecipients,
      });
    })
  );

  // ─── Phase 6 Versioned OpenAPI Contracts Endpoints ─────────────────────────

  // GET /api/workspaces/:workspaceId/contracts — List workspace contracts
  scopedRouter.get(
    '/contracts',
    asyncHandler(async (req, res) => {
      const contracts = await contractRepo.listContractsByWorkspace(req.workspaceId);
      return res.json({ contracts });
    })
  );

  // POST /api/workspaces/:workspaceId/contracts — Create contract & initial revision
  scopedRouter.post(
    '/contracts',
    requireWorkspaceOwner,
    validateBody(createContractSchema),
    asyncHandler(async (req, res) => {
      const { name, description, specification } = req.body;

      // 1. Parse and validate specification
      let parsedSpec;
      try {
        parsedSpec = await parseAndValidateOpenAPI(specification);
      } catch (specErr) {
        throw new AppError(specErr.message, 400);
      }

      // 2. Create logical contract
      let newContract;
      try {
        newContract = await contractRepo.createContract(req.workspaceId, {
          name,
          description,
          createdBy: req.user ? req.user.id : null,
        });
      } catch (dbErr) {
        if (dbErr.code === 'ER_DUP_ENTRY' || (dbErr.message && dbErr.message.includes('Duplicate entry'))) {
          throw new AppError(`A contract named "${name}" already exists in this workspace`, 409);
        }
        throw dbErr;
      }

      // 3. Create initial revision (revision_number = 1)
      const newRevision = await contractRepo.createRevision(newContract.id, {
        revisionNumber: 1,
        openapiVersion: parsedSpec.openapiVersion,
        specificationContent: parsedSpec.canonicalContent,
        specificationRaw: parsedSpec.rawText,
        contentSha256: parsedSpec.contentSha256,
        operationsCatalog: parsedSpec.operationsCatalog,
        createdBy: req.user ? req.user.id : null,
      });

      return res.status(201).json({
        message: 'Contract created successfully',
        contract: {
          ...newContract,
          revisions_count: 1,
          latest_revision_number: 1,
          latest_openapi_version: parsedSpec.openapiVersion,
        },
        revision: newRevision,
      });
    })
  );

  // GET /api/workspaces/:workspaceId/contracts/:contractId — Get contract & revisions
  scopedRouter.get(
    '/contracts/:contractId',
    validateParams(contractIdParamSchema),
    asyncHandler(async (req, res) => {
      const contractId = Number(req.params.contractId);
      const contract = await contractRepo.findContractById(contractId, req.workspaceId);
      if (!contract) {
        throw new NotFoundError('Contract not found');
      }

      const revisions = await contractRepo.listRevisionsByContract(contractId);
      return res.json({
        contract,
        revisions,
      });
    })
  );

  // DELETE /api/workspaces/:workspaceId/contracts/:contractId — Archive or delete contract
  scopedRouter.delete(
    '/contracts/:contractId',
    requireWorkspaceOwner,
    validateParams(contractIdParamSchema),
    asyncHandler(async (req, res) => {
      const contractId = Number(req.params.contractId);
      const contract = await contractRepo.findContractById(contractId, req.workspaceId);
      if (!contract) {
        throw new NotFoundError('Contract not found');
      }

      // 1. Check for active bindings
      const activeBindings = await contractRepo.countActiveBindingsByContractId(contractId, req.workspaceId);
      if (activeBindings > 0) {
        throw new AppError(
          `Cannot delete or archive contract "${contract.name}" while ${activeBindings} active monitor binding(s) exist. Please unbind all monitors first.`,
          409
        );
      }

      // 2. Check for historical validation results
      const historicalResults = await contractRepo.countValidationResultsByContractId(contractId, req.workspaceId);
      if (historicalResults > 0) {
        // Soft archive to permanently retain validation audit history
        await contractRepo.archiveContract(contractId, req.workspaceId);
        return res.json({
          message: `Contract "${contract.name}" has ${historicalResults} historical validation record(s) and was archived to preserve audit history`,
          archived: true,
          contract_id: contractId,
        });
      }

      // 3. No active bindings and no historical validation results: hard delete contract
      await contractRepo.deleteContract(contractId, req.workspaceId);
      return res.json({
        message: `Contract "${contract.name}" deleted successfully`,
        archived: false,
        contract_id: contractId,
      });
    })
  );

  // POST /api/workspaces/:workspaceId/contracts/:contractId/revisions — Publish new revision
  scopedRouter.post(
    '/contracts/:contractId/revisions',
    requireWorkspaceOwner,
    validateParams(contractIdParamSchema),
    validateBody(createRevisionSchema),
    asyncHandler(async (req, res) => {
      const contractId = Number(req.params.contractId);
      const contract = await contractRepo.findContractById(contractId, req.workspaceId);
      if (!contract) {
        throw new NotFoundError('Contract not found');
      }

      const { specification } = req.body;
      let parsedSpec;
      try {
        parsedSpec = await parseAndValidateOpenAPI(specification);
      } catch (specErr) {
        throw new AppError(specErr.message, 400);
      }

      // Check if identical revision content already exists (deterministic idempotency)
      const existingRev = await contractRepo.findRevisionByHash(contractId, parsedSpec.contentSha256);
      if (existingRev) {
        return res.status(200).json({
          message: `Specification is identical to revision ${existingRev.revision_number}`,
          revision: existingRev,
          duplicate: true,
        });
      }

      const nextRevNum = await contractRepo.getNextRevisionNumber(contractId);
      const newRevision = await contractRepo.createRevision(contractId, {
        revisionNumber: nextRevNum,
        openapiVersion: parsedSpec.openapiVersion,
        specificationContent: parsedSpec.canonicalContent,
        specificationRaw: parsedSpec.rawText,
        contentSha256: parsedSpec.contentSha256,
        operationsCatalog: parsedSpec.operationsCatalog,
        createdBy: req.user ? req.user.id : null,
      });

      return res.status(201).json({
        message: `Revision ${nextRevNum} published successfully`,
        revision: newRevision,
        duplicate: false,
      });
    })
  );

  // GET /api/workspaces/:workspaceId/contracts/:contractId/revisions/:revisionNumber — Get specific revision details
  scopedRouter.get(
    '/contracts/:contractId/revisions/:revisionNumber',
    validateParams(revisionNumberParamSchema),
    asyncHandler(async (req, res) => {
      const contractId = Number(req.params.contractId);
      const revisionNumber = Number(req.params.revisionNumber);

      const contract = await contractRepo.findContractById(contractId, req.workspaceId);
      if (!contract) {
        throw new NotFoundError('Contract not found');
      }

      const revision = await contractRepo.getRevisionByNumber(contractId, revisionNumber);
      if (!revision) {
        throw new NotFoundError('Revision not found');
      }

      return res.json({ revision });
    })
  );

  // GET /api/workspaces/:workspaceId/apis/:id/contract-binding — Get monitor's contract binding
  scopedRouter.get(
    '/apis/:id/contract-binding',
    validateParams(workspaceAndApiIdParamSchema),
    asyncHandler(async (req, res) => {
      const apiId = Number(req.params.id);
      const api = await apiRepo.findById(apiId, req.workspaceId);
      if (!api) {
        throw new NotFoundError('API monitor not found');
      }

      const binding = await contractRepo.getBindingByApiId(apiId, req.workspaceId);
      return res.json({ binding });
    })
  );

  // PUT /api/workspaces/:workspaceId/apis/:id/contract-binding — Bind or update monitor binding
  scopedRouter.put(
    '/apis/:id/contract-binding',
    requireWorkspaceOwner,
    validateParams(workspaceAndApiIdParamSchema),
    validateBody(bindContractSchema),
    asyncHandler(async (req, res) => {
      const apiId = Number(req.params.id);
      const api = await apiRepo.findById(apiId, req.workspaceId);
      if (!api) {
        throw new NotFoundError('API monitor not found');
      }

      // 0. Verify monitor has explicit workspace ownership (not legacy unassigned)
      if (!api.workspace_id) {
        throw new AppError('Cannot bind monitor: legacy unassigned monitors cannot have contract bindings', 400);
      }

      const { contract_id, revision_id, operation_id, method, path_template } = req.body;

      // 1. Verify contract belongs to current workspace and is not archived
      const contract = await contractRepo.findContractById(contract_id, req.workspaceId);
      if (!contract) {
        throw new AppError('Specified contract does not exist in this workspace', 400);
      }
      if (contract.archived_at) {
        throw new AppError(`Cannot bind monitor: contract "${contract.name}" is archived`, 400);
      }

      // 2. Verify revision belongs to the contract
      const revision = await contractRepo.getRevisionById(revision_id, contract_id);
      if (!revision) {
        throw new AppError(`Revision ${revision_id} does not belong to contract ${contract_id}`, 400);
      }

      // 3. Verify operation exists in that revision's operations catalog
      const catalog = revision.operations_catalog || [];
      const opMatch = catalog.find(
        (op) =>
          op.method.toUpperCase() === method.toUpperCase() &&
          op.pathTemplate === path_template
      );

      if (!opMatch) {
        throw new AppError(
          `Operation ${method.toUpperCase()} ${path_template} does not exist in revision ${revision.revision_number}`,
          400
        );
      }

      const updatedBinding = await contractRepo.createOrUpdateBinding(
        req.workspaceId,
        apiId,
        {
          contractId: contract_id,
          revisionId: revision_id,
          operationId: operation_id || opMatch.operationId,
          method: method.toUpperCase(),
          pathTemplate: path_template,
        }
      );

      return res.json({
        message: 'Contract binding updated successfully',
        binding: updatedBinding,
      });
    })
  );

  // DELETE /api/workspaces/:workspaceId/apis/:id/contract-binding — Unbind monitor
  scopedRouter.delete(
    '/apis/:id/contract-binding',
    requireWorkspaceOwner,
    validateParams(workspaceAndApiIdParamSchema),
    asyncHandler(async (req, res) => {
      const apiId = Number(req.params.id);
      const api = await apiRepo.findById(apiId, req.workspaceId);
      if (!api) {
        throw new NotFoundError('API monitor not found');
      }

      await contractRepo.deleteBinding(apiId, req.workspaceId);
      return res.json({ message: 'Contract binding removed successfully' });
    })
  );

  // GET /api/workspaces/:workspaceId/apis/:id/contract-results — List validation history
  scopedRouter.get(
    '/apis/:id/contract-results',
    validateParams(workspaceAndApiIdParamSchema),
    validateQuery(contractResultsQuerySchema),
    asyncHandler(async (req, res) => {
      const apiId = Number(req.params.id);
      const api = await apiRepo.findById(apiId, req.workspaceId);
      if (!api) {
        throw new NotFoundError('API monitor not found');
      }

      const { limit, offset } = req.query;
      const results = await contractRepo.listValidationHistoryByApiId(apiId, req.workspaceId, { limit, offset });
      return res.json({ results });
    })
  );

  // GET /api/workspaces/:workspaceId/test-results/:id/contract-result — Get validation result for a test run
  scopedRouter.get(
    '/test-results/:id/contract-result',
    asyncHandler(async (req, res) => {
      const testResultId = Number(req.params.id);
      if (!testResultId || isNaN(testResultId)) {
        throw new AppError('Invalid test result ID', 400);
      }

      const validationResult = await contractRepo.getValidationResultByTestResultId(testResultId, req.workspaceId);
      return res.json({ result: validationResult });
    })
  );

  router.use('/:workspaceId', scopedRouter);

  return router;
}

const defaultWorkspaceRouter = createWorkspaceRouter();
defaultWorkspaceRouter.createWorkspaceRouter = createWorkspaceRouter;
defaultWorkspaceRouter.serializeAnalysisForClient = serializeAnalysisForClient;

module.exports = defaultWorkspaceRouter;
