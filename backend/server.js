// backend/server.js
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config();

const { createApp } = require('./app');
const { loadConfig } = require('./config');
const { closePool, pingDatabase } = require('./db');
const { logger } = require('./logger');

let httpServer = null;

/**
 * Starts the HTTP server and optional transitional legacy scheduler.
 *
 * @param {Object} [overrideConfig]
 * @returns {Promise<{ server: import('http').Server, app: import('express').Application }>}
 */
async function startServer(overrideConfig = null) {
  const config = overrideConfig || loadConfig();
  const app = createApp({ logger, config });

  // Verify database connectivity
  try {
    await pingDatabase();
    logger.info({ db: config.db.database, host: config.db.host }, 'Connected to MySQL database');
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to connect to MySQL database at startup');
    // Note: In development or during setup, we log the error. Depending on deployment mode,
    // we continue or throw. For local dev setup before migrations, we let the server start.
  }

  const bindHost = process.env.HOST || '127.0.0.1';

  return new Promise((resolve, reject) => {
    httpServer = app.listen(config.port, bindHost, () => {
      logger.info({ port: config.port, host: bindHost }, `🚀 API Health Monitor running on http://${bindHost}:${config.port}`);

      // Legacy in-process scheduler retirement (Phase 4):
      // The API server must never independently run periodic scheduling.
      // Background monitoring is executed exclusively by the dedicated worker (`npm run worker`).
      if (config.enableLegacyScheduler) {
        logger.warn('DEPRECATED: ENABLE_LEGACY_SCHEDULER is deprecated and disabled in the API server. Scheduled monitoring runs exclusively in the dedicated background worker ("npm run worker").');
      }

      resolve({ server: httpServer, app });
    });

    httpServer.on('error', (err) => {
      logger.error({ err: err.message }, 'HTTP server error');
      reject(err);
    });
  });
}

/**
 * Gracefully stops the HTTP server, scheduler timers, and database connection pool.
 */
async function stopServer() {
  if (httpServer) {
    await new Promise((resolve) => {
      httpServer.close(() => {
        logger.info('HTTP server closed');
        resolve();
      });
    });
    httpServer = null;
  }

  await closePool();
  logger.info('Database pool closed');
}

// Graceful shutdown process handlers
function setupSignalHandlers() {
  const shutdown = async (signal) => {
    logger.info({ signal }, `Received ${signal}, shutting down gracefully...`);
    try {
      await stopServer();
      process.exit(0);
    } catch (err) {
      logger.error({ err: err.message }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

// Direct-execution guard: only start when invoked directly, never on require()
if (require.main === module) {
  setupSignalHandlers();
  startServer().catch((err) => {
    console.error('❌  Failed to start server:', err.message);
    process.exit(1);
  });
}

module.exports = {
  startServer,
  stopServer,
};
