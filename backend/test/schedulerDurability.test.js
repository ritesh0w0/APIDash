// backend/test/schedulerDurability.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SchedulerWorker } = require('../services/schedulerWorker');
const { loadConfig } = require('../config');

test('Scheduler durability: test_results is authoritative and written immediately per run', async () => {
  const persistedResults = [];
  const recordedSummaryRuns = [];

  const mockCoordinator = async (monitor) => {
    // Authoritative per-execution record persisted immediately through coordinator
    const record = {
      api_id: monitor.id,
      status_code: 200,
      response_time: 35,
      result: 'passed',
      tested_at: new Date(),
    };
    persistedResults.push(record);
    return record;
  };

  const mockSchedulerRepo = {
    claimDueMonitors: async () => [
      {
        scheduleId: 1,
        apiId: 101,
        claimToken: 'token-1',
        scheduledRunAt: new Date(Date.now() - 1000),
        monitor: { id: 101, name: 'Auth API', url: 'http://example.com/auth' },
      },
    ],
    completeClaim: async () => ({ completed: true }),
    repairMissingSchedules: async () => 0,
  };

  const mockSchedulerRunRepo = {
    create: async (data) => {
      recordedSummaryRuns.push(data);
      return { id: 1, ...data };
    },
  };

  const worker = new SchedulerWorker({
    config: loadConfig({
      WORKER_CONCURRENCY: '5', // Higher concurrency so buffer does NOT automatically flush on 1 item
      WORKER_POLL_INTERVAL_MS: '500',
      LOG_LEVEL: 'silent',
    }),
    schedulerRepo: mockSchedulerRepo,
    schedulerRunRepo: mockSchedulerRunRepo,
    coordinatorFn: mockCoordinator,
  });

  await worker.pollOnce();

  while (worker.activeJobs.size > 0) {
    await new Promise((r) => setTimeout(r, 5));
  }

  // 1. Authoritative test_results record was persisted IMMEDIATELY
  assert.equal(persistedResults.length, 1);
  assert.equal(persistedResults[0].api_id, 101);
  assert.equal(persistedResults[0].result, 'passed');

  // 2. Best-effort scheduler_runs aggregate is buffered in memory (not flushed yet because batch size < concurrency)
  assert.equal(recordedSummaryRuns.length, 0);
  assert.equal(worker.completedBatch.length, 1);

  // 3. Graceful shutdown: pending summary buffer is explicitly flushed to scheduler_runs
  await worker.stop();
  assert.equal(recordedSummaryRuns.length, 1);
  assert.equal(recordedSummaryRuns[0].total, 1);
  assert.equal(recordedSummaryRuns[0].passed, 1);
  assert.equal(recordedSummaryRuns[0].failed, 0);
  assert.equal(worker.completedBatch.length, 0);
});

test('Scheduler durability: simulated crash before flush documents in-memory batch loss while test_results is preserved', async () => {
  const persistedResults = [];
  const recordedSummaryRuns = [];

  const mockCoordinator = async (monitor) => {
    const record = { api_id: monitor.id, result: 'passed', response_time: 40 };
    persistedResults.push(record);
    return record;
  };

  const mockSchedulerRepo = {
    claimDueMonitors: async () => [
      {
        scheduleId: 2,
        apiId: 102,
        claimToken: 'token-2',
        scheduledRunAt: new Date(),
        monitor: { id: 102, name: 'Payment API' },
      },
    ],
    completeClaim: async () => ({ completed: true }),
    repairMissingSchedules: async () => 0,
  };

  const mockSchedulerRunRepo = {
    create: async (data) => {
      recordedSummaryRuns.push(data);
    },
  };

  const worker = new SchedulerWorker({
    config: loadConfig({
      WORKER_CONCURRENCY: '5',
      LOG_LEVEL: 'silent',
    }),
    schedulerRepo: mockSchedulerRepo,
    schedulerRunRepo: mockSchedulerRunRepo,
    coordinatorFn: mockCoordinator,
  });

  await worker.pollOnce();
  while (worker.activeJobs.size > 0) {
    await new Promise((r) => setTimeout(r, 5));
  }

  // Authoritative result is saved
  assert.equal(persistedResults.length, 1);

  // Simulate abrupt process crash: worker stops without graceful stop() invocation
  // (In-memory buffer is discarded)
  worker.completedBatch = []; // buffer lost on process termination

  // Verify that test_results was unaffected by the crash
  assert.equal(persistedResults.length, 1);
  assert.equal(persistedResults[0].api_id, 102);

  // scheduler_runs did not receive the lost summary
  assert.equal(recordedSummaryRuns.length, 0);
});
