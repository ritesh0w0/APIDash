// backend/middleware/auth.js
'use strict';

const { AppError } = require('./errors');
const { userRepository: defaultUserRepo } = require('../data/userRepository');
const { workspaceRepository: defaultWorkspaceRepo } = require('../data/workspaceRepository');

/**
 * Creates authentication and authorization middleware functions with injectable repositories.
 */
function createAuthMiddleware(deps = {}) {
  const userRepo = deps.userRepo || defaultUserRepo;
  const workspaceRepo = deps.workspaceRepo || defaultWorkspaceRepo;

  /**
   * Middleware requiring a valid authenticated session.
   */
  async function requireAuth(req, _res, next) {
    if (!req.session || !req.session.userId) {
      return next(new AppError('Authentication required. Please log in.', 401));
    }

    try {
      const user = await userRepo.findById(req.session.userId);
      if (!user) {
        req.session.destroy(() => {});
        return next(new AppError('User account not found. Please log in again.', 401));
      }

      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Middleware requiring the authenticated user to be a member of the workspace specified in params.workspaceId.
   */
  async function requireWorkspaceMember(req, _res, next) {
    if (!req.user) {
      return next(new AppError('Authentication required prior to workspace authorization check', 401));
    }

    const workspaceId = Number(req.params.workspaceId);
    if (!workspaceId || isNaN(workspaceId)) {
      return next(new AppError('Invalid workspace ID parameter', 400));
    }

    try {
      const membership = await workspaceRepo.findMembership(workspaceId, req.user.id);
      if (!membership) {
        // Safe IDOR defense: return 404 rather than disclosing workspace existence
        return next(new AppError('Workspace not found or access denied', 404));
      }

      req.workspaceId = workspaceId;
      req.membership = membership;
      next();
    } catch (err) {
      next(err);
    }
  }

  /**
   * Middleware requiring the member to have the 'owner' role.
   */
  function requireWorkspaceOwner(req, _res, next) {
    if (!req.membership) {
      return next(new AppError('Workspace membership required prior to role check', 403));
    }

    if (req.membership.role !== 'owner') {
      return next(new AppError('Forbidden: Owner permission is required for this action', 403));
    }

    next();
  }

  return {
    requireAuth,
    requireWorkspaceMember,
    requireWorkspaceOwner,
  };
}

const defaultAuthMiddleware = createAuthMiddleware();

module.exports = {
  createAuthMiddleware,
  requireAuth: defaultAuthMiddleware.requireAuth,
  requireWorkspaceMember: defaultAuthMiddleware.requireWorkspaceMember,
  requireWorkspaceOwner: defaultAuthMiddleware.requireWorkspaceOwner,
};
