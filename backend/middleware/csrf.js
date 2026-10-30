// backend/middleware/csrf.js
'use strict';

const crypto = require('crypto');
const { AppError } = require('./errors');
const { loadConfig } = require('../config');

/**
 * Ensures a CSRF token is associated with the current session.
 *
 * @param {import('express').Request} req
 * @returns {string} CSRF token
 */
function getOrCreateCsrfToken(req) {
  if (!req.session) {
    throw new AppError('Session not initialized', 500);
  }
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

/**
 * Verifies request Origin / Referer matches expected application origin when present.
 */
function verifyOrigin(req, appOrigin) {
  const origin = req.headers['origin'] || req.headers['referer'];
  if (!origin) {
    // If neither Origin nor Referer is provided (e.g. non-browser API test), allow if same-site cookie applies
    return true;
  }
  try {
    const originUrl = new URL(origin);
    const expectedUrl = new URL(appOrigin);
    return originUrl.origin === expectedUrl.origin;
  } catch (_e) {
    return false;
  }
}

/**
 * Middleware that verifies CSRF token and request origin on state-changing requests.
 */
function createCsrfProtection(config = loadConfig()) {
  return function csrfProtection(req, _res, next) {
    // Safe HTTP methods do not modify state
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    // Origin verification
    if (!verifyOrigin(req, config.appOrigin)) {
      return next(new AppError('Forbidden: Request origin does not match allowed application origin', 403));
    }

    if (!req.session) {
      return next(new AppError('Forbidden: No active session for state-changing request', 403));
    }

    const sessionToken = req.session.csrfToken;
    const clientToken = req.headers['x-csrf-token'];

    if (!sessionToken || !clientToken || typeof clientToken !== 'string') {
      return next(new AppError('Forbidden: Missing CSRF token in X-CSRF-Token header', 403));
    }

    // Constant-time token comparison
    const sessionBuf = Buffer.from(sessionToken, 'utf8');
    const clientBuf = Buffer.from(clientToken, 'utf8');

    if (sessionBuf.length !== clientBuf.length || !crypto.timingSafeEqual(sessionBuf, clientBuf)) {
      return next(new AppError('Forbidden: Invalid CSRF token', 403));
    }

    next();
  };
}

module.exports = {
  getOrCreateCsrfToken,
  createCsrfProtection,
};
