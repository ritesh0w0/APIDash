// backend/test/schedulerCoordinator.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SchedulerWorker } = require('../services/schedulerWorker');
const { executeMonitoringRun } = require('../services/monitoringCoordinator');
const { loadConfig } = require('../config');

test('Scheduled work invokes executeMonitoringRun and respects Phase 3 canonical outcomes', async () => {
  const coordinatorCalls = [];
  const completedClaims = [];

  const mockCoordinator = async (monitor, deps) => {
    coordinatorCalls.push({ monitor, deps });
    return {
      outcome: 'passed',
      result: 'passed',
      status_code: 200,
      response_time: 45,
    };
  };

  const mockSchedulerRepo = {
    claimDueMonitors: async () => [
      {
        scheduleId: 10,
        apiId: 42,
        claimToken: 'worker-test:token-42',
        monitor: { id: 42, name: 'Prod Users API', url: 'https://api.example.com/users', method: 'GET' },
      },
    ],
    completeClaim: async (apiId, claimToken, opts) => {
      completedClaims.push({ apiId, claimToken, opts });
      return { completed: true };
    },
    repairMissingSchedules: async () => 0,
  };

  const recordedRuns = [];
  const mockSchedulerRunRepo = {
    create: async (data) => {
      recordedRuns.push(data);
      return { id: 1, ...data };
    },
  };

  const worker = new SchedulerWorker({
    config: loadConfig({
      WORKER_CONCURRENCY: '1',
      WORKER_POLL_INTERVAL_MS: '100',
      SCHEDULER_INTERVAL_MS: '30000',
      LOG_LEVEL: 'silent',
    }),
    schedulerRepo: mockSchedulerRepo,
    schedulerRunRepo: mockSchedulerRunRepo,
    coordinatorFn: mockCoordinator,
  });

  const claimed = await worker.pollOnce();
  assert.equal(claimed, 1);

  // Wait for in-flight job to settle
  while (worker.activeJobs.size > 0) {
    await new Promise((r) => setTimeout(r, 5));
  }

  // 1. Verify coordinator was called with exact monitor
  assert.equal(coordinatorCalls.length, 1);
  assert.equal(coordinatorCalls[0].monitor.id, 42);
  assert.equal(coordinatorCalls[0].monitor.url, 'https://api.example.com/users');

  // 2. Verify completeClaim was called with correct claimToken and outcome
  assert.equal(completedClaims.length, 1);
  assert.equal(completedClaims[0].apiId, 42);
  assert.equal(completedClaims[0].claimToken, 'worker-test:token-42');
  assert.equal(completedClaims[0].opts.outcome, 'passed');
  assert.equal(completedClaims[0].opts.cadenceSeconds, 30);

  // 3. Trigger batch flush and verify scheduler_runs shape
  await worker._flushBatch();
  assert.equal(recordedRuns.length, 1);
  assert.equal(recordedRuns[0].total, 1);
  assert.equal(recordedRuns[0].passed, 1);
  assert.equal(recordedRuns[0].failed, 0);
  assert.equal(recordedRuns[0].avg_ms, 45);
});

test('Scheduled HTTP failure advances schedule normally without tight retry loop', async () => {
  const completedClaims = [];

  const failingCoordinator = async () => {
    return {
      outcome: 'failed',
      result: 'failed',
      status_code: 500,
      response_time: 120,
      error_message: 'HTTP status 500 does not match expected 200',
    };
  };

  const mockSchedulerRepo = {
    claimDueMonitors: async () => [
      {
        scheduleId: 11,
        apiId: 43,
        claimToken: 'token-43',
        monitor: { id: 43, name: 'Failing API', url: 'https://api.example.com/fail' },
      },
    ],
    completeClaim: async (apiId, claimToken, opts) => {
      completedClaims.push({ apiId, claimToken, opts });
      return { completed: true };
    },
    repairMissingSchedules: async () => 0,
  };

  const recordedRuns = [];
  const mockSchedulerRunRepo = {
    create: async (data) => {
      recordedRuns.push(data);
      return { id: 2, ...data };
    },
  };

  const worker = new SchedulerWorker({
    config: loadConfig({
      WORKER_CONCURRENCY: '1',
      SCHEDULER_INTERVAL_MS: '30000',
      LOG_LEVEL: 'silent',
    }),
    schedulerRepo: mockSchedulerRepo,
    schedulerRunRepo: mockSchedulerRunRepo,
    coordinatorFn: failingCoordinator,
  });

  await worker.pollOnce();

  while (worker.activeJobs.size > 0) {
    await new Promise((r) => setTimeout(r, 5));
  }

  assert.equal(completedClaims.length, 1);
  assert.equal(completedClaims[0].opts.outcome, 'failed');
  assert.equal(completedClaims[0].opts.cadenceSeconds, 30);

  await worker._flushBatch();
  assert.equal(recordedRuns.length, 1);
  assert.equal(recordedRuns[0].total, 1);
  assert.equal(recordedRuns[0].passed, 0);
  assert.equal(recordedRuns[0].failed, 1);
  assert.equal(recordedRuns[0].avg_ms, 120);
});

test('Coordinator transport error produces canonical error outcome and advances schedule', async () => {
  const completedClaims = [];

  const errorCoordinator = async () => {
    return {
      outcome: 'error',
      result: 'error',
      status_code: null,
      response_time: 15,
      error_type: 'CONNECTION_REFUSED',
      error_message: 'Connection refused by destination',
    };
  };

  const mockSchedulerRepo = {
    claimDueMonitors: async () => [
      {
        scheduleId: 12,
        apiId: 44,
        claimToken: 'token-44',
        monitor: { id: 44, name: 'Dead Endpoint' },
      },
    ],
    completeClaim: async (apiId, claimToken, opts) => {
      completedClaims.push({ apiId, claimToken, opts });
      return { completed: true };
    },
    repairMissingSchedules: async () => 0,
  };

  const worker = new SchedulerWorker({
    config: loadConfig({
      WORKER_CONCURRENCY: '2',
      SCHEDULER_INTERVAL_MS: '30000',
      LOG_LEVEL: 'silent',
    }),
    schedulerRepo: mockSchedulerRepo,
    coordinatorFn: errorCoordinator,
  });

  await worker.pollOnce();

  while (worker.activeJobs.size > 0) {
    await new Promise((r) => setTimeout(r, 5));
  }

  assert.equal(completedClaims.length, 1);
  assert.equal(completedClaims[0].opts.outcome, 'error');
  // Both failed and error count as failures in scheduler_runs
  assert.equal(worker.completedBatch[0].result, 'error');
});