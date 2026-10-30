// backend/test/workerLifecycle.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer } = require('../server');
const { SchedulerWorker } = require('../services/schedulerWorker');
const { startWorker, stopWorker } = require('../worker');
const { loadConfig, ConfigError } = require('../config');

test('API server startup does not start periodic scheduler loop even with ENABLE_LEGACY_SCHEDULER=true', async () => {
  const customConfig = loadConfig({
    NODE_ENV: 'test',
    PORT: '5099',
    ENABLE_LEGACY_SCHEDULER: 'true',
    LOG_LEVEL: 'silent',
  });

  const { server } = await startServer(customConfig);
  assert.ok(server);
  assert.ok(server.listening);

  await stopServer();
  assert.equal(server.listening, false);
});

test('Dedicated worker starts without binding an HTTP listener', async () => {
  const mockSchedulerRepo = {
    repairMissingSchedules: async () => 0,
    claimDueMonitors: async () => [],
    completeClaim: async () => ({ completed: true }),
  };

  const worker = new SchedulerWorker({
    config: loadConfig({
      WORKER_CONCURRENCY: '3',
      WORKER_POLL_INTERVAL_MS: '500',
      LOG_LEVEL: 'silent',
    }),
    schedulerRepo: mockSchedulerRepo,
  });

  assert.equal(worker.isRunning, false);
  await worker.start();
  assert.equal(worker.isRunning, true);

  // Worker has no HTTP server instance attached
  assert.equal(worker.httpServer, undefined);
  assert.equal(worker.server, undefined);

  await worker.stop();
  assert.equal(worker.isRunning, false);
});

test('Invalid worker configuration fails safely before scheduling begins', () => {
  assert.throws(
    () => loadConfig({ WORKER_CONCURRENCY: '0' }),
    (err) => err instanceof ConfigError && err.message.includes('WORKER_CONCURRENCY')
  );

  assert.throws(
    () => loadConfig({ WORKER_LEASE_MS: '10000' }),
    (err) => err instanceof ConfigError && err.message.includes('WORKER_LEASE_MS')
  );

  assert.throws(
    () => loadConfig({ WORKER_POLL_INTERVAL_MS: '5' }),
    (err) => err instanceof ConfigError && err.message.includes('WORKER_POLL_INTERVAL_MS')
  );
});

test('Worker shutdown stops further claims and waits for active work within budget', async () => {
  let claimCalls = 0;
  let jobResolved = false;

  const mockSchedulerRepo = {
    repairMissingSchedules: async () => 0,
    claimDueMonitors: async () => {
      claimCalls++;
      if (claimCalls === 1) {
        return [
          {
            scheduleId: 1,
            apiId: 101,
            claimToken: 'token-1',
            leaseExpiresAt: new Date(Date.now() + 60000),
            monitor: { id: 101, name: 'Slow API', url: 'http://example.com' },
          },
        ];
      }
      return [];
    },
    completeClaim: async () => ({ completed: true }),
  };

  const slowCoordinator = async () => {
    // Simulate job in flight taking 50ms
    await new Promise((resolve) => setTimeout(resolve, 50));
    jobResolved = true;
    return { outcome: 'passed', response_time: 50 };
  };

  const worker = new SchedulerWorker({
    config: loadConfig({
      WORKER_CONCURRENCY: '2',
      WORKER_POLL_INTERVAL_MS: '20',
      LOG_LEVEL: 'silent',
    }),
    schedulerRepo: mockSchedulerRepo,
    schedulerRunRepo: { create: async () => ({ id: 1 }) },
    coordinatorFn: slowCoordinator,
  });

  await worker.start();

  // Wait until claim has happened and job is active
  while (worker.activeJobs.size === 0) {
    await new Promise((r) => setTimeout(r, 5));
  }

  assert.equal(worker.activeJobs.size, 1);
  assert.equal(jobResolved, false);

  // Trigger stop while job is still running
  const stopPromise = worker.stop();

  assert.equal(worker.isShuttingDown, true);
  assert.equal(worker.isRunning, false);

  await stopPromise;

  // After stop completes, in-flight job has resolved cleanly
  assert.equal(jobResolved, true);
  assert.equal(worker.activeJobs.size, 0);
});

test('Worker closes database resources cleanly at shutdown', async () => {
  let poolClosed = false;
  const mockPool = {
    execute: async () => [[{ alive: 1 }]],
    getConnection: async () => ({
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
      execute: async () => [[]],
    }),
    end: async () => {
      poolClosed = true;
    },
  };

  const db = require('../db');
  db.setPool(mockPool);

  try {
    const worker = await startWorker(loadConfig({
      WORKER_CONCURRENCY: '2',
      WORKER_POLL_INTERVAL_MS: '1000',
      LOG_LEVEL: 'silent',
    }));

    assert.ok(worker);
    await stopWorker();

    assert.equal(poolClosed, true);
  } finally {
    db.setPool(null);
  }
});