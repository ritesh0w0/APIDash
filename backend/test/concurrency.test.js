// backend/test/concurrency.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SchedulerWorker } = require('../services/schedulerWorker');
const { loadConfig } = require('../config');

test('Worker active execution count never exceeds configured concurrency limit', async () => {
  const CONCURRENCY_LIMIT = 3;
  let maxActiveObserved = 0;
  let currentlyActive = 0;
  let claimedCount = 0;

  const mockSchedulerRepo = {
    repairMissingSchedules: async () => 0,
    claimDueMonitors: async (limit, { workerId }) => {
      // Must never be requested to claim more than available slots
      assert.ok(limit <= CONCURRENCY_LIMIT);
      assert.ok(limit >= 1);

      const items = [];
      for (let i = 0; i < limit; i++) {
        claimedCount++;
        items.push({
          scheduleId: claimedCount,
          apiId: claimedCount,
          claimToken: `${workerId}:token-${claimedCount}`,
          leaseExpiresAt: new Date(Date.now() + 60000),
          monitor: { id: claimedCount, name: `API ${claimedCount}`, url: `http://example.com/${claimedCount}` },
        });
      }
      return items;
    },
    completeClaim: async () => ({ completed: true }),
  };

  const slowCoordinator = async () => {
    currentlyActive++;
    if (currentlyActive > maxActiveObserved) {
      maxActiveObserved = currentlyActive;
    }
    await new Promise((r) => setTimeout(r, 40));
    currentlyActive--;
    return { outcome: 'passed', response_time: 40 };
  };

  const mockSchedulerRunRepo = { create: async () => ({ id: 1 }) };

  const worker = new SchedulerWorker({
    config: loadConfig({
      WORKER_CONCURRENCY: String(CONCURRENCY_LIMIT),
      WORKER_POLL_INTERVAL_MS: '10',
      LOG_LEVEL: 'silent',
    }),
    schedulerRepo: mockSchedulerRepo,
    schedulerRunRepo: mockSchedulerRunRepo,
    coordinatorFn: slowCoordinator,
  });

  await worker.start();

  // Run for 150ms
  await new Promise((r) => setTimeout(r, 150));
  await worker.stop();

  assert.ok(maxActiveObserved > 0);
  assert.ok(
    maxActiveObserved <= CONCURRENCY_LIMIT,
    `Max active executions (${maxActiveObserved}) must not exceed limit (${CONCURRENCY_LIMIT})`
  );
});

test('Worker claims only available capacity when slots are partially filled', async () => {
  const CONCURRENCY_LIMIT = 4;
  const requestedLimits = [];

  const mockSchedulerRepo = {
    repairMissingSchedules: async () => 0,
    claimDueMonitors: async (limit) => {
      requestedLimits.push(limit);
      if (requestedLimits.length === 1) {
        // Return 2 items on first poll
        return [
          { scheduleId: 1, apiId: 1, claimToken: 't1', monitor: { id: 1 } },
          { scheduleId: 2, apiId: 2, claimToken: 't2', monitor: { id: 2 } },
        ];
      }
      return [];
    },
    completeClaim: async () => ({ completed: true }),
  };

  let resolveJobs;
  const holdPromise = new Promise((r) => { resolveJobs = r; });
  const holdingCoordinator = async () => {
    await holdPromise;
    return { outcome: 'passed' };
  };

  const worker = new SchedulerWorker({
    config: loadConfig({
      WORKER_CONCURRENCY: String(CONCURRENCY_LIMIT),
      WORKER_POLL_INTERVAL_MS: '20',
      LOG_LEVEL: 'silent',
    }),
    schedulerRepo: mockSchedulerRepo,
    schedulerRunRepo: { create: async () => ({ id: 1 }) },
    coordinatorFn: holdingCoordinator,
  });

  await worker.start();

  // Wait until second poll occurs
  while (requestedLimits.length < 2) {
    await new Promise((r) => setTimeout(r, 10));
  }

  // First poll had all 4 slots available
  assert.equal(requestedLimits[0], 4);
  // Second poll had 2 in flight, so requested exactly 2
  assert.equal(requestedLimits[1], 2);

  resolveJobs();
  await worker.stop();
});

test('Temporary database polling failure initiates backoff without tight retry loops', async () => {
  let dbCalls = 0;
  const mockSchedulerRepo = {
    repairMissingSchedules: async () => 0,
    claimDueMonitors: async () => {
      dbCalls++;
      throw new Error('Deadlock or connection timeout');
    },
  };

  const worker = new SchedulerWorker({
    config: loadConfig({
      WORKER_CONCURRENCY: '3',
      WORKER_POLL_INTERVAL_MS: '10', // Short interval, but error backoff must throttle it
      LOG_LEVEL: 'silent',
    }),
    schedulerRepo: mockSchedulerRepo,
    schedulerRunRepo: { create: async () => ({ id: 1 }) },
  });

  await worker.start();

  // Wait 100ms
  await new Promise((r) => setTimeout(r, 100));

  await worker.stop();

  // Because of error backoff (min 2000ms), dbCalls should only be 1 or 2, NOT 10+
  assert.ok(dbCalls <= 3, `dbCalls (${dbCalls}) should be strictly throttled during database failure`);
  assert.ok(worker.backoffDelayMs >= 2000, 'Backoff delay must be set on database failure');
});