// backend/routes/authRoutes.js
'use strict';

const express = require('express');
const { userRepository: defaultUserRepo } = require('../data/userRepository');
const { workspaceRepository: defaultWorkspaceRepo } = require('../data/workspaceRepository');
const { hashPassword, verifyPassword } = require('../services/passwordService');
const { validateBody, registerSchema, loginSchema } = require('../middleware/validation');
const { asyncHandler, AppError, ValidationError } = require('../middleware/errors');
const { getOrCreateCsrfToken } = require('../middleware/csrf');
const { authLimiter } = require('../middleware/rateLimiters');

/**
 * Creates and configures the Authentication router with injectable dependencies.
 *
 * @param {Object} [deps]
 * @param {import('../data/userRepository').UserRepository} [deps.userRepo]
 * @param {import('../data/workspaceRepository').WorkspaceRepository} [deps.workspaceRepo]
 * @param {typeof hashPassword} [deps.hashPasswordFn]
 * @param {typeof verifyPassword} [deps.verifyPasswordFn]
 * @returns {express.Router}
 */
function createAuthRouter(deps = {}) {
  const router = express.Router();
  const userRepo = deps.userRepo || defaultUserRepo;
  const workspaceRepo = deps.workspaceRepo || defaultWorkspaceRepo;
  const hashPw = deps.hashPasswordFn || hashPassword;
  const verifyPw = deps.verifyPasswordFn || verifyPassword;

  // ─── GET /api/auth/csrf ──────────────────────────────────────────────────────
  router.get('/csrf', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const csrfToken = getOrCreateCsrfToken(req);
    return res.json({ csrfToken });
  });

  // ─── POST /api/auth/register ─────────────────────────────────────────────────
  router.post(
    '/register',
    authLimiter,
    validateBody(registerSchema),
    asyncHandler(async (req, res) => {
      const { email, password, display_name, workspace_name } = req.body;

      // Duplicate email check
      const existing = await userRepo.findByEmail(email);
      if (existing) {
        throw new ValidationError('Email address is already registered');
      }

      // Hash password using Argon2id
      const passwordHash = await hashPw(password);

      // Transactionally create User, Workspace, and Owner Membership
      const { user, workspace } = await workspaceRepo.registerUserWithWorkspace(
        {
          email,
          password_hash: passwordHash,
          display_name: display_name || email.split('@')[0],
          workspace_name: workspace_name || 'My Workspace',
        },
        userRepo
      );

      // Session regeneration on authentication
      await new Promise((resolve, reject) => {
        req.session.regenerate((err) => {
          if (err) return reject(err);
          req.session.userId = user.id;
          resolve();
        });
      });

      const csrfToken = getOrCreateCsrfToken(req);

      res.setHeader('Cache-Control', 'no-store');
      return res.status(201).json({
        message: 'Account created successfully',
        user: {
          id: user.id,
          email: user.email,
          display_name: user.display_name,
        },
        workspace: {
          id: workspace.id,
          name: workspace.name,
          role: 'owner',
        },
        csrfToken,
      });
    })
  );

  // ─── POST /api/auth/login ────────────────────────────────────────────────────
  router.post(
    '/login',
    authLimiter,
    validateBody(loginSchema),
    asyncHandler(async (req, res) => {
      const { email, password } = req.body;

      // Lookup user by canonicalized email
      const user = await userRepo.findByEmail(email);
      if (!user) {
        // Generic failure message to prevent email enumeration
        throw new AppError('Invalid email or password', 401);
      }

      // Verify Argon2id hash
      const isValid = await verifyPw(user.password_hash, password);
      if (!isValid) {
        throw new AppError('Invalid email or password', 401);
      }

      // Prevent session fixation by regenerating session identifier
      await new Promise((resolve, reject) => {
        req.session.regenerate((err) => {
          if (err) return reject(err);
          req.session.userId = user.id;
          resolve();
        });
      });

      const csrfToken = getOrCreateCsrfToken(req);
      const workspaces = await workspaceRepo.findUserWorkspaces(user.id);

      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        message: 'Login successful',
        user: {
          id: user.id,
          email: user.email,
          display_name: user.display_name,
        },
        workspaces,
        csrfToken,
      });
    })
  );

  // ─── GET /api/auth/me ────────────────────────────────────────────────────────
  router.get(
    '/me',
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');

      if (!req.session || !req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const user = await userRepo.findById(req.session.userId);
      if (!user) {
        req.session.destroy(() => {});
        return res.status(401).json({ error: 'User account not found' });
      }

      const workspaces = await workspaceRepo.findUserWorkspaces(user.id);
      const csrfToken = getOrCreateCsrfToken(req);

      return res.json({
        user: {
          id: user.id,
          email: user.email,
          display_name: user.display_name,
        },
        workspaces,
        csrfToken,
      });
    })
  );

  // ─── POST /api/auth/logout ───────────────────────────────────────────────────
  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');

      if (req.session) {
        await new Promise((resolve) => {
          req.session.destroy(() => {
            resolve();
          });
        });
      }

      const cookieName = req.app.get('sessionCookieName') || 'apidash_sid';
      res.clearCookie(cookieName);

      return res.json({ message: 'Logged out successfully' });
    })
  );

  return router;
}

const defaultAuthRouter = createAuthRouter();
defaultAuthRouter.createAuthRouter = createAuthRouter;

module.exports = defaultAuthRouter;
