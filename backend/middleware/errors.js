// backend/middleware/errors.js
'use strict';

const { logger: defaultLogger } = require('../logger');

class AppError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, 400, details);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Resource not found', details = null) {
    super(message, 404, details);
  }
}

/**
 * Async handler wrapper to forward promise rejections to Express error middleware.
 */
function asyncHandler(fn) {
  return function asyncUtilWrap(req, res, next) {
    const fnReturn = fn(req, res, next);
    return Promise.resolve(fnReturn).catch(next);
  };
}

/**
 * Centralized Express error handler.
 * Prevents credential leaks and unhandled promise rejections.
 */
function createErrorHandler(logger = defaultLogger) {
  return function errorHandler(err, req, res, next) {
    if (res.headersSent) {
      return next(err);
    }

    const statusCode = err.statusCode || (err.status && typeof err.status === 'number' ? err.status : 500);

    if (statusCode >= 500) {
      logger.error({
        err: {
          message: err.message,
          name: err.name,
          stack: err.stack,
        },
        req: {
          method: req.method,
          url: req.originalUrl || req.url,
        },
      }, 'Unhandled server error');

      return res.status(500).json({
        error: 'Internal server error',
        details: err.message || 'An unexpected error occurred',
      });
    }

    // Client errors (4xx)
    return res.status(statusCode).json({
      error: err.message || 'Bad Request',
      ...(err.details ? { details: err.details } : {}),
    });
  };
}

module.exports = {
  AppError,
  ValidationError,
  NotFoundError,
  asyncHandler,
  createErrorHandler,
};
