// backend/logger.js
'use strict';

const pino = require('pino');

/**
 * Creates or configures a structured logger instance using Pino.
 *
 * @param {Object} [options]
 * @param {string} [options.level] - Log level ('info', 'debug', 'warn', 'error', 'silent')
 * @returns {import('pino').Logger}
 */
function createLogger(options = {}) {
  const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);
  const level = options.level || (isTest ? 'silent' : process.env.LOG_LEVEL || 'info');

  return pino({
    level,
    redact: {
      paths: [
        'password',
        'db.password',
        'DB_PASSWORD',
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.*.password',
        'smtp.pass',
        'SMTP_PASS',
        'pass',
        '*.pass',
        '*.*.pass',
      ],
      censor: '[REDACTED]',
    },
    base: {
      pid: process.pid,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

const defaultLogger = createLogger();

module.exports = {
  logger: defaultLogger,
  createLogger,
};
