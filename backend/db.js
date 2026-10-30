// backend/db.js
'use strict';

const mysql = require('mysql2/promise');
const { loadConfig } = require('./config');

let activePool = null;

/**
 * Returns the active MySQL connection pool or creates one lazily.
 *
 * @param {Object} [overrideConfig]
 * @returns {import('mysql2/promise').Pool}
 */
function getPool(overrideConfig = null) {
  if (activePool && !overrideConfig) {
    return activePool;
  }

  if (overrideConfig && overrideConfig.execute) {
    // Allows injecting a mock pool directly
    activePool = overrideConfig;
    return activePool;
  }

  const config = overrideConfig || loadConfig().db;

  activePool = mysql.createPool({
    host: config.host || 'localhost',
    port: config.port || 3306,
    user: config.user || 'root',
    password: config.password !== undefined ? config.password : '',
    database: config.database || 'api_monitor',
    waitForConnections: true,
    connectionLimit: config.connectionLimit || 10,
    queueLimit: 0,
  });

  return activePool;
}

/**
 * Overrides the active pool (primarily used in tests).
 * @param {any} mockPool
 */
function setPool(mockPool) {
  activePool = mockPool;
}

/**
 * Closes the active MySQL pool if one exists.
 */
async function closePool() {
  if (activePool && typeof activePool.end === 'function') {
    await activePool.end();
  }
  activePool = null;
}

/**
 * Pings the database to verify connectivity.
 *
 * @param {import('mysql2/promise').Pool} [poolInstance]
 * @returns {Promise<boolean>}
 */
async function pingDatabase(poolInstance = null) {
  const p = poolInstance || getPool();
  const [rows] = await p.execute('SELECT 1 AS alive');
  return Boolean(rows && rows.length > 0);
}

/**
 * Lazy proxy to preserve backwards compatibility for `const { pool } = require('./db')`
 * without connecting to MySQL on module import.
 */
const poolProxy = new Proxy({}, {
  get(_target, prop) {
    const pool = getPool();
    const value = pool[prop];
    if (typeof value === 'function') {
      return value.bind(pool);
    }
    return value;
  },
});

module.exports = {
  pool: poolProxy,
  getPool,
  setPool,
  closePool,
  pingDatabase,
};
