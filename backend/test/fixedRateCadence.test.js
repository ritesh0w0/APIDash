// backend/test/fixedRateCadence.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateNextRunAt, SchedulerRepository } = require('../data/schedulerRepository');
const { SchedulerWorker } = require('../services/schedulerWorker');
const { loadConfig } = require('../config');

test('calculateNextRunAt retains original cadence anchor when execution completes before next interval', () => {
  const CADENCE_MS = 30000;
  // Anchor at 12:00:00.000 (T=1,000,000)
  const anchorTime = new Date(1000000);

  // Execution finishes 5 seconds later at T=1,005,000 (12:00:05.000)
  const completionTime = new Date(1005000);

  const nextRunAt = calculateNextRunAt(anchorTime, CADENCE_MS, completionTime);

  // Must be exactly anchored to 12:00:30.000 (T=1,030,000) — zero drift
  assert.equal(nextRunAt.getTime(), 1030000);
});

test('calculateNextRunAt advances to next future slot and skips 1 missed interval during slight overrun', () => {
  const CADENCE_MS = 30000;
  // Anchor at 12:00:00.000 (T=1,000,000)
  const anchorTime = new Date(1000000);

  // Execution took 35 seconds, finishing at T=1,035,000 (12:00:35.000)
  // The 12:00:30 slot was missed during execution
  const completionTime = new Date(1035000);

  const nextRunAt = calculateNextRunAt(anchorTime, CADENCE_MS, completionTime);

  // Missed slot (12:00:30) skipped! Next scheduled slot is exactly 12:01:00.000 (T=1,060,000)
  assert.equal(nextRunAt.getTime(), 1060000);
});

test('calculateNextRunAt skips multiple missed intervals without catch-up bursts on long delays', () => {
  const CADENCE_MS = 30000;
  // Anchor at 12:00:00.000 (T=1,000,000)
  const anchorTime = new Date(1000000);

  // Execution took 85 seconds, finishing at T=1,085,000 (12:01:25.000)
  // Missed slots at 12:00:30 (T=1,030,000) and 12:01:00 (T=1,060,000)
  const completionTime = new Date(1085000);

  const nextRunAt = calculateNextRunAt(anchorTime, CADENCE_MS, completionTime);

  // Both missed slots skipped! Next slot is 12:01:30.000 (T=1,090,000)
  assert.equal(nextRunAt.getTime(), 1090000);
  assert.ok(nextRunAt.getTime() > completionTime.getTime(), 'Next run must be strictly in the future');
});

test('calculateNextRunAt handles future or invalid anchor safely', () => {
  const CADENCE_MS = 30000;
  const now = 1000000;

  // Anchor in future
  const futureAnchor = new Date(now + 10000);
  const nextFromFuture = calculateNextRunAt(futureAnchor, CADENCE_MS, now);
  assert.equal(nextFromFuture.getTime(), now + CADENCE_MS);

  // Invalid / null anchor
  const nextFromNull = calculateNextRunAt(null, CADENCE_MS, now);
  assert.equal(nextFromNull.getTime(), now + CADENCE_MS);
});

test('Worker execution integrates fixed-rate scheduling and passes cadenceSeconds to completeClaim', async () => {
  const CADENCE_MS = 30000;
  let receivedOpts = null;

  const mockSchedulerRepo = {
    claimDueMonitors: async () => [
      {
        scheduleId: 1,
        apiId: 10,
        claimToken: 'token-fixed-rate',
        scheduledRunAt: new Date(Date.now() - 5000),
        monitor: { id: 10, name: 'Fixed Rate API', url: 'http://example.com' },
      },
    ],
    completeClaim: async (_apiId, _token, opts) => {
      receivedOpts = opts;
      return { completed: true };
    },
    repairMissingSchedules: async () => 0,
  };

  const worker = new SchedulerWorker({
    config: loadConfig({
      WORKER_CONCURRENCY: '1',
      SCHEDULER_INTERVAL_MS: String(CADENCE_MS),
      LOG_LEVEL: 'silent',
    }),
    schedulerRepo: mockSchedulerRepo,
    schedulerRunRepo: { create: async () => ({ id: 1 }) },
    coordinatorFn: async () => ({ outcome: 'passed', response_time: 20 }),
  });

  await worker.pollOnce();

  while (worker.activeJobs.size > 0) {
    await new Promise((r) => setTimeout(r, 5));
  }

  assert.ok(receivedOpts);
  assert.equal(receivedOpts.outcome, 'passed');
  assert.equal(receivedOpts.cadenceSeconds, 30);
});
