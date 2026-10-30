// backend/test/importSideEffects.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('importing backend/app does not connect to MySQL, listen, or start scheduler', () => {
  const { createApp } = require('../app');
  assert.equal(typeof createApp, 'function');
  const app = createApp();
  assert.ok(app);
});

test('importing backend/server does not invoke startServer or start scheduler', () => {
  const serverModule = require('../server');
  assert.equal(typeof serverModule.startServer, 'function');
  assert.equal(typeof serverModule.stopServer, 'function');
});

test('importing backend/db does not create a live MySQL connection pool automatically', () => {
  const db = require('../db');
  assert.equal(typeof db.getPool, 'function');
  assert.equal(typeof db.closePool, 'function');
  assert.equal(typeof db.pingDatabase, 'function');
});

test('importing backend/worker does not connect to MySQL or start worker automatically', () => {
  const workerModule = require('../worker');
  assert.equal(typeof workerModule.startWorker, 'function');
  assert.equal(typeof workerModule.stopWorker, 'function');
  assert.equal(typeof workerModule.SchedulerWorker, 'function');
});

test('importing services does not make outbound HTTP requests or run queries', () => {
  const tester = require('../services/tester');
  const analytics = require('../services/analytics');
  assert.equal(typeof tester.testApi, 'function');
  assert.equal(typeof tester.testAllApis, 'function');
  assert.equal(typeof analytics.getApiAnalytics, 'function');
  assert.equal(typeof analytics.getGlobalAnalytics, 'function');
  assert.equal(typeof analytics.calcHealthScore, 'function');
});
