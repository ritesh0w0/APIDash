// backend/middleware/requestLogger.js
'use strict';

const pinoHttp = require('pino-http');
const { logger: defaultLogger } = require('../logger');

/**
 * Creates lightweight HTTP request logging middleware.
 *
 * @param {import('pino').Logger} [customLogger]
 */
function createRequestLogger(customLogger = defaultLogger) {
  return pinoHttp({
    logger: customLogger,
    autoLogging: {
      ignore: (req) => {
        // Skip noisy health probes or static assets in tests if needed
        return req.url === '/health' && process.env.NODE_ENV === 'test';
      },
    },
    serializers: {
      req: (req) => ({
        id: req.id,
        method: req.method,
        url: req.url,
      }),
      res: (res) => ({
        statusCode: res.statusCode,
      }),
    },
  });
}

module.exports = {
  createRequestLogger,
};
