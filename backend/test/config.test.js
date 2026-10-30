// backend/test/config.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, ConfigError } = require('../config');

test('loadConfig() returns valid defaults with empty object', () => {
  const config = loadConfig({});
  assert.equal(config.nodeEnv, 'development');
  assert.equal(config.port, 5000);
  assert.equal(config.db.host, 'localhost');
  assert.equal(config.db.port, 3306);
  assert.equal(config.db.user, 'root');
  assert.equal(config.db.password, '');
  assert.equal(config.db.database, 'api_monitor');
  assert.equal(config.enableLegacyScheduler, false);
  assert.equal(config.worker.concurrency, 5);
  assert.equal(config.worker.pollIntervalMs, 1000);
  assert.equal(config.worker.leaseMs, 60000);
  assert.equal(config.worker.shutdownTimeoutMs, 35000);
  assert.equal(config.schedulerIntervalMs, 30000);
});

test('loadConfig() respects custom environment variables', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '8080',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3307',
    DB_USER: 'testuser',
    DB_PASSWORD: 'testpassword',
    DB_NAME: 'test_db',
    ENABLE_LEGACY_SCHEDULER: 'true',
  });

  assert.equal(config.nodeEnv, 'test');
  assert.equal(config.port, 8080);
  assert.equal(config.db.host, '127.0.0.1');
  assert.equal(config.db.port, 3307);
  assert.equal(config.db.user, 'testuser');
  assert.equal(config.db.password, 'testpassword');
  assert.equal(config.db.database, 'test_db');
  assert.equal(config.enableLegacyScheduler, true);
});

test('loadConfig() throws ConfigError on invalid PORT', () => {
  assert.throws(
    () => loadConfig({ PORT: 'abc' }),
    (err) => err instanceof ConfigError && err.message.includes('PORT')
  );

  assert.throws(
    () => loadConfig({ PORT: '70000' }),
    (err) => err instanceof ConfigError && err.message.includes('PORT')
  );

  assert.throws(
    () => loadConfig({ PORT: '-1' }),
    (err) => err instanceof ConfigError && err.message.includes('PORT')
  );
});

test('loadConfig() throws ConfigError on invalid DB_PORT', () => {
  assert.throws(
    () => loadConfig({ DB_PORT: 'not-a-port' }),
    (err) => err instanceof ConfigError && err.message.includes('DB_PORT')
  );
});

test('loadConfig() throws ConfigError on missing/empty DB_USER or DB_NAME', () => {
  assert.throws(
    () => loadConfig({ DB_USER: '' }),
    (err) => err instanceof ConfigError && err.message.includes('DB_USER')
  );

  assert.throws(
    () => loadConfig({ DB_NAME: '' }),
    (err) => err instanceof ConfigError && err.message.includes('DB_NAME')
  );
});

test('loadConfig() enforces password and session secret requirement in production environment', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', DB_PASSWORD: '', SESSION_SECRET: 'a_very_long_secure_session_secret_32_characters' }),
    (err) => err instanceof ConfigError && err.message.includes('DB_PASSWORD')
  );

  // Fails if SESSION_SECRET is missing in production
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', DB_PASSWORD: 'prod_secure_password' }),
    (err) => err instanceof ConfigError && err.message.includes('SESSION_SECRET')
  );

  // Fails if SESSION_SECRET is shorter than 32 characters in production
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', DB_PASSWORD: 'prod_secure_password', SESSION_SECRET: 'short_secret' }),
    (err) => err instanceof ConfigError && err.message.includes('SESSION_SECRET')
  );

  // Succeeds when password and valid secret are provided in production
  const validProd = loadConfig({
    NODE_ENV: 'production',
    DB_PASSWORD: 'prod_secure_password',
    SESSION_SECRET: 'a_very_long_secure_session_secret_32_characters',
  });
  assert.equal(validProd.db.password, 'prod_secure_password');
  assert.equal(validProd.session.secret, 'a_very_long_secure_session_secret_32_characters');
});

test('loadConfig() validates ENABLE_LEGACY_SCHEDULER boolean values', () => {
  assert.equal(loadConfig({ ENABLE_LEGACY_SCHEDULER: 'false' }).enableLegacyScheduler, false);
  assert.equal(loadConfig({ ENABLE_LEGACY_SCHEDULER: '0' }).enableLegacyScheduler, false);
  assert.equal(loadConfig({ ENABLE_LEGACY_SCHEDULER: 'true' }).enableLegacyScheduler, true);
  assert.equal(loadConfig({ ENABLE_LEGACY_SCHEDULER: '1' }).enableLegacyScheduler, true);

  assert.throws(
    () => loadConfig({ ENABLE_LEGACY_SCHEDULER: 'maybe' }),
    (err) => err instanceof ConfigError && err.message.includes('ENABLE_LEGACY_SCHEDULER')
  );
});

test('loadConfig() validates worker configuration bounds', () => {
  // Custom valid values
  const valid = loadConfig({
    WORKER_CONCURRENCY: '10',
    WORKER_POLL_INTERVAL_MS: '2000',
    WORKER_LEASE_MS: '45000',
    SCHEDULER_INTERVAL_MS: '60000',
    WORKER_SHUTDOWN_TIMEOUT_MS: '40000',
  });
  assert.equal(valid.worker.concurrency, 10);
  assert.equal(valid.worker.pollIntervalMs, 2000);
  assert.equal(valid.worker.leaseMs, 45000);
  assert.equal(valid.schedulerIntervalMs, 60000);
  assert.equal(valid.worker.shutdownTimeoutMs, 40000);

  // Invalid WORKER_CONCURRENCY
  assert.throws(
    () => loadConfig({ WORKER_CONCURRENCY: '0' }),
    (err) => err instanceof ConfigError && err.message.includes('WORKER_CONCURRENCY')
  );
  assert.throws(
    () => loadConfig({ WORKER_CONCURRENCY: '100' }),
    (err) => err instanceof ConfigError && err.message.includes('WORKER_CONCURRENCY')
  );

  // Invalid WORKER_POLL_INTERVAL_MS
  assert.throws(
    () => loadConfig({ WORKER_POLL_INTERVAL_MS: '5' }),
    (err) => err instanceof ConfigError && err.message.includes('WORKER_POLL_INTERVAL_MS')
  );

  // Invalid WORKER_LEASE_MS (must be >= 35000 to exceed max request timeout 30000)
  assert.throws(
    () => loadConfig({ WORKER_LEASE_MS: '20000' }),
    (err) => err instanceof ConfigError && err.message.includes('WORKER_LEASE_MS')
  );

  // Invalid SCHEDULER_INTERVAL_MS
  assert.throws(
    () => loadConfig({ SCHEDULER_INTERVAL_MS: '500' }),
    (err) => err instanceof ConfigError && err.message.includes('SCHEDULER_INTERVAL_MS')
  );

  // Invalid WORKER_SHUTDOWN_TIMEOUT_MS
  assert.throws(
    () => loadConfig({ WORKER_SHUTDOWN_TIMEOUT_MS: '1000' }),
    (err) => err instanceof ConfigError && err.message.includes('WORKER_SHUTDOWN_TIMEOUT_MS')
  );
});
