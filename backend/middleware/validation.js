// backend/middleware/validation.js
'use strict';

const { z } = require('zod');
const { ValidationError } = require('./errors');
const { validateUrlSyntax } = require('../services/ssrfProtection');

/**
 * Creates middleware that validates req.body against a Zod schema.
 */
function validateBody(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const issue = result.error.issues[0];
      const message = `${issue.path.join('.') || 'body'}: ${issue.message}`;
      return next(new ValidationError(message, result.error.flatten()));
    }
    req.body = result.data;
    next();
  };
}

/**
 * Creates middleware that validates req.params against a Zod schema.
 */
function validateParams(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      const issue = result.error.issues[0];
      const message = `Invalid parameter "${issue.path.join('.')}": ${issue.message}`;
      return next(new ValidationError(message, result.error.flatten()));
    }
    req.params = result.data;
    next();
  };
}

/**
 * Creates middleware that validates req.query against a Zod schema.
 */
function validateQuery(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const issue = result.error.issues[0];
      const message = `Invalid query parameter "${issue.path.join('.')}": ${issue.message}`;
      return next(new ValidationError(message, result.error.flatten()));
    }
    req.query = result.data;
    next();
  };
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const registerSchema = z.object({
  email: z.string().trim().email('Valid email address is required').max(255),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128, 'Password must not exceed 128 characters'),
  display_name: z.string().trim().min(1, 'Display name cannot be empty').max(255).optional(),
  workspace_name: z.string().trim().min(1, 'Workspace name cannot be empty').max(255).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().email('Valid email address is required'),
  password: z.string().min(1, 'Password is required'),
});

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1, 'Workspace name cannot be empty').max(255),
});

const addMemberSchema = z.object({
  email: z.string().trim().email('Valid email address is required'),
  role: z.enum(['owner', 'member']).default('member'),
});

const { validateAssertionConfig } = require('../services/assertionEngine');

const createApiSchema = z.object({
  name: z.string().trim().min(1, 'API Name is required').max(255),
  url: z.string().trim().min(1, 'Endpoint URL is required').refine((val) => {
    try {
      validateUrlSyntax(val);
      return true;
    } catch (_e) {
      return false;
    }
  }, { message: 'Invalid or forbidden URL syntax' }),
  method: z.string().trim().toUpperCase().pipe(
    z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
  ).default('GET'),
  expected_status: z.coerce.number().int().min(100).max(599).default(200),
  headers: z.record(z.string(), z.string()).optional().nullable(),
  body: z.union([z.string(), z.record(z.string(), z.any())]).optional().nullable(),
  timeout_ms: z.coerce.number().int().min(100).max(30000).default(10000),
  assertions: z.any().optional().nullable().superRefine((val, ctx) => {
    if (val === undefined || val === null) return;
    try {
      validateAssertionConfig(val);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err.message || 'Invalid assertion configuration',
      });
    }
  }),
});

const updateApiSchema = createApiSchema.partial();

const idParamSchema = z.object({
  id: z.coerce.number().int().positive('ID must be a positive integer'),
});

const workspaceIdParamSchema = z.object({
  workspaceId: z.coerce.number().int().positive('Workspace ID must be a positive integer'),
});

const workspaceAndApiIdParamSchema = z.object({
  workspaceId: z.coerce.number().int().positive('Workspace ID must be a positive integer'),
  id: z.coerce.number().int().positive('API ID must be a positive integer'),
});

// Phase 5 Incident & Notification Schemas
const incidentsQuerySchema = z.object({
  status: z.enum(['open', 'resolved', 'all']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const workspaceAndIncidentIdParamSchema = z.object({
  workspaceId: z.coerce.number().int().positive('Workspace ID must be a positive integer'),
  id: z.coerce.number().int().positive('Incident ID must be a positive integer'),
});

const workspaceAndAnalysisIdParamSchema = z.object({
  workspaceId: z.coerce.number().int().positive('Workspace ID must be a positive integer'),
  analysisId: z.coerce.number().int().positive('Analysis ID must be a positive integer'),
});

const triggerAiAnalysisBodySchema = z.object({
  force: z.boolean().optional(),
  forceNew: z.boolean().optional(),
}).optional();

const updateNotificationSettingsSchema = z.object({
  notify_on_open: z.boolean().optional(),
  notify_on_resolve: z.boolean().optional(),
  recipient_user_ids: z.array(z.number().int().positive()).optional(),
});

// Phase 6 OpenAPI Contract Schemas
const createContractSchema = z.object({
  name: z.string().trim().min(1, 'Contract name is required').max(255),
  description: z.string().trim().max(2000).optional().nullable(),
  specification: z.string().min(1, 'OpenAPI specification content is required'),
});

const createRevisionSchema = z.object({
  specification: z.string().min(1, 'OpenAPI specification content is required'),
});

const contractIdParamSchema = z.object({
  workspaceId: z.coerce.number().int().positive('Workspace ID must be a positive integer'),
  contractId: z.coerce.number().int().positive('Contract ID must be a positive integer'),
});

const revisionNumberParamSchema = z.object({
  workspaceId: z.coerce.number().int().positive('Workspace ID must be a positive integer'),
  contractId: z.coerce.number().int().positive('Contract ID must be a positive integer'),
  revisionNumber: z.coerce.number().int().positive('Revision number must be a positive integer'),
});

const bindContractSchema = z.object({
  contract_id: z.coerce.number().int().positive('Contract ID is required'),
  revision_id: z.coerce.number().int().positive('Revision ID is required'),
  operation_id: z.string().trim().max(255).optional().nullable(),
  method: z.string().trim().min(1).max(16),
  path_template: z.string().trim().min(1).max(500),
});

const contractResultsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

module.exports = {
  validateBody,
  validateParams,
  validateQuery,
  registerSchema,
  loginSchema,
  createWorkspaceSchema,
  addMemberSchema,
  createApiSchema,
  updateApiSchema,
  idParamSchema,
  workspaceIdParamSchema,
  workspaceAndApiIdParamSchema,
  incidentsQuerySchema,
  workspaceAndIncidentIdParamSchema,
  updateNotificationSettingsSchema,
  createContractSchema,
  createRevisionSchema,
  contractIdParamSchema,
  revisionNumberParamSchema,
  bindContractSchema,
  contractResultsQuerySchema,
  workspaceAndAnalysisIdParamSchema,
  triggerAiAnalysisBodySchema,
};
