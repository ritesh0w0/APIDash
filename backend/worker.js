// backend/worker.js
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config();

const { loadConfig } = require('./config');
const { pingDatabase, closePool } = require('./db');
const { SchedulerWorker } = require('./services/schedulerWorker');
const { logger } = require('./logger');

let activeWorker = null;
let isShuttingDown = false;

/**
 * Starts the dedicated background scheduler worker without binding any HTTP listener.
 *
 * @param {Object} [overrideConfig]
 * @returns {Promise<SchedulerWorker>}
 */
async function startWorker(overrideConfig = null) {
  const config = overrideConfig || loadConfig();

  // 1. Verify database connectivity
  try {
    await pingDatabase();
    logger.info({ db: config.db.database, host: config.db.host }, 'Worker connected to MySQL database');
  } catch (err) {
    logger.error({ err: err.message }, 'Worker failed to connect to MySQL database at startup');
    throw err;
  }

  // 2. Instantiate and start worker
  const worker = new SchedulerWorker({
    config,
    logger,
  });

  await worker.start();
  activeWorker = worker;
  return worker;
}

/**
 * Gracefully stops the active worker and closes the database pool.
 */
async function stopWorker() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  if (activeWorker) {
    try {
      await activeWorker.stop();
    } catch (err) {
      logger.error({ err: err.message }, 'Error stopping active worker');
    }
    activeWorker = null;
  }

  try {
    await closePool();
    logger.info('Worker database pool closed');
  } catch (err) {
    logger.error({ err: err.message }, 'Error closing database pool');
  } finally {
    isShuttingDown = false;
  }
}

/**
 * Attaches standard Unix signal handlers for graceful shutdown.
 */
function setupSignalHandlers() {
  const shutdown = async (signal) => {
    logger.info({ signal }, `Received ${signal}, initiating graceful worker shutdown...`);
    try {
      await stopWorker();
      process.exit(0);
    } catch (err) {
      logger.error({ err: err.message }, 'Error during worker shutdown');
      process.exit(1);
    }
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

// Direct-execution guard: only start when invoked directly, never on require()
if (require.main === module) {
  setupSignalHandlers();
  startWorker().catch((err) => {
    console.error('❌  Failed to start worker:', err.message);
    process.exit(1);
  });
}

module.exports = {
  startWorker,
  stopWorker,
  SchedulerWorker,
};
