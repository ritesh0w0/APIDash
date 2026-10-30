// backend/test/schedulerClaim.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SchedulerRepository } = require('../data/schedulerRepository');

function createMockClaimPool(initialRows = []) {
  // In-memory representation of monitor_schedules and apis
  let schedules = initialRows.map(r => ({ ...r }));
  let apis = [
    { id: 1, name: 'API 1', url: 'http://example.com/1', method: 'GET', expected_status: 200, workspace_id: 1 },
    { id: 2, name: 'API 2', url: 'http://example.com/2', method: 'GET', expected_status: 200, workspace_id: 1 },
    { id: 3, name: 'API 3', url: 'http://example.com/3', method: 'POST', expected_status: 201, workspace_id: 1 },
  ];

  const pool = {
    schedules,
    apis,
    getConnection: async () => {
      let inTx = false;
      return {
        beginTransaction: async () => { inTx = true; },
        commit: async () => { inTx = false; },
        rollback: async () => { inTx = false; },
        release: () => {},
        execute: async (sql, params = []) => {
          const sqlLower = sql.toLowerCase();

          // SELECT ... FOR UPDATE SKIP LOCKED
          if (sqlLower.includes('select') && sqlLower.includes('from monitor_schedules')) {
            const now = new Date();
            const due = schedules.filter(s => {
              const api = apis.find(a => a.id === s.api_id);
              if (sqlLower.includes('workspace_id is not null') && (!api || api.workspace_id == null)) {
                return false;
              }
              const nextRun = new Date(s.next_run_at);
              const leaseExp = s.lease_expires_at ? new Date(s.lease_expires_at) : null;
              const isDue = nextRun <= now;
              const isUnleasedOrExpired = !s.leased_by || !leaseExp || leaseExp <= now;
              return isDue && isUnleasedOrExpired;
            });

            // Match limit
            const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
            const limit = limitMatch ? parseInt(limitMatch[1], 10) : 5;
            const selected = due.slice(0, limit);

            // Join with apis
            const rows = selected.map(s => {
              const api = apis.find(a => a.id === s.api_id) || {};
              return {
                schedule_id: s.id,
                api_id: s.api_id,
                next_run_at: s.next_run_at,
                leased_by: s.leased_by,
                lease_expires_at: s.lease_expires_at,
                last_run_at: s.last_run_at,
                last_outcome: s.last_outcome,
                id: api.id,
                workspace_id: api.workspace_id,
                name: api.name,
                url: api.url,
                method: api.method,
                expected_status: api.expected_status,
                headers: null,
                body: null,
                timeout_ms: 10000,
                assertions: null,
              };
            });

            return [rows];
          }

          // UPDATE monitor_schedules SET leased_by = ?, lease_expires_at = ... WHERE id = ?
          if (sqlLower.includes('update monitor_schedules') && sqlLower.includes('set leased_by = ?')) {
            const [leasedBy, leaseSecOrExpiry, id] = params;
            const target = schedules.find(s => s.id === id);
            if (target) {
              target.leased_by = leasedBy;
              target.lease_expires_at = typeof leaseSecOrExpiry === 'number'
                ? new Date(Date.now() + leaseSecOrExpiry * 1000).toISOString()
                : leaseSecOrExpiry;
              return [{ affectedRows: 1 }];
            }
            return [{ affectedRows: 0 }];
          }

          return [{ affectedRows: 0 }];
        },
      };
    },

    execute: async (sql, params = []) => {
      const sqlLower = sql.toLowerCase();

      // UPDATE completion: WHERE api_id = ? AND leased_by = ?
      if (sqlLower.includes('update monitor_schedules') && sqlLower.includes('where api_id = ? and leased_by = ?')) {
        let outcome, nextRunAt, apiId, leasedBy, lastRunAt = new Date().toISOString();
        if (params.length === 6) {
          // Database clock calculation path: [outcome, sec, sec, sec, apiId, leasedBy]
          outcome = params[0];
          const sec = params[1];
          apiId = params[4];
          leasedBy = params[5];
          const target = schedules.find(s => s.api_id === apiId && s.leased_by === leasedBy);
          if (target) {
            target.leased_by = null;
            target.lease_expires_at = null;
            target.last_run_at = lastRunAt;
            target.last_outcome = outcome;
            target.next_run_at = new Date(Date.now() + sec * 1000).toISOString();
            return [{ affectedRows: 1 }];
          }
          return [{ affectedRows: 0 }];
        } else if (params.length === 4) {
          // Explicit path: [outcome, nextRunAt, apiId, leasedBy]
          outcome = params[0];
          nextRunAt = params[1];
          apiId = params[2];
          leasedBy = params[3];
        } else {
          // Legacy 5 params: [lastRunAt, outcome, nextRunAt, apiId, leasedBy]
          lastRunAt = params[0];
          outcome = params[1];
          nextRunAt = params[2];
          apiId = params[3];
          leasedBy = params[4];
        }

        const target = schedules.find(s => s.api_id === apiId && s.leased_by === leasedBy);
        if (target) {
          target.leased_by = null;
          target.lease_expires_at = null;
          target.last_run_at = lastRunAt;
          target.last_outcome = outcome;
          target.next_run_at = nextRunAt;
          return [{ affectedRows: 1 }];
        }
        return [{ affectedRows: 0 }];
      }

      // SELECT * FROM monitor_schedules WHERE api_id = ?
      if (sqlLower.includes('select * from monitor_schedules where api_id = ?')) {
        const [apiId] = params;
        const target = schedules.find(s => s.api_id === apiId);
        return [target ? [target] : []];
      }

      // INSERT IGNORE INTO monitor_schedules (api_id, next_run_at)
      if (sqlLower.includes('insert ignore into monitor_schedules')) {
        if (sqlLower.includes('select id, now() from apis')) {
          let count = 0;
          for (const api of apis) {
            if (sqlLower.includes('workspace_id is not null') && api.workspace_id == null) {
              continue;
            }
            if (!schedules.some(s => s.api_id === api.id)) {
              schedules.push({
                id: schedules.length + 1,
                api_id: api.id,
                next_run_at: new Date().toISOString(),
                leased_by: null,
                lease_expires_at: null,
              });
              count++;
            }
          }
          return [{ affectedRows: count }];
        }
        const [apiId, nextRun] = params;
        if (!schedules.some(s => s.api_id === apiId)) {
          schedules.push({
            id: schedules.length + 1,
            api_id: apiId,
            next_run_at: nextRun,
            leased_by: null,
            lease_expires_at: null,
          });
          return [{ affectedRows: 1 }];
        }
        return [{ affectedRows: 0 }];
      }

      return [{ affectedRows: 0 }];
    },
  };

  return pool;
}

test('SchedulerRepository claims only due and unleased monitors', async () => {
  const now = new Date();
  const past = new Date(now.getTime() - 10000).toISOString();
  const future = new Date(now.getTime() + 60000).toISOString();

  const mockPool = createMockClaimPool([
    { id: 1, api_id: 1, next_run_at: past, leased_by: null, lease_expires_at: null },
    { id: 2, api_id: 2, next_run_at: future, leased_by: null, lease_expires_at: null }, // not due
  ]);

  const repo = new SchedulerRepository(mockPool);
  const claimed = await repo.claimDueMonitors(5, { workerId: 'worker-A', leaseDurationMs: 60000 });

  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].apiId, 1);
  assert.ok(claimed[0].claimToken.startsWith('worker-A:'));
  assert.ok(mockPool.schedules[0].leased_by.startsWith('worker-A:'));
});

test('SchedulerRepository does not claim monitors currently held by active unexpired lease', async () => {
  const past = new Date(Date.now() - 10000).toISOString();
  const activeLease = new Date(Date.now() + 50000).toISOString();

  const mockPool = createMockClaimPool([
    { id: 1, api_id: 1, next_run_at: past, leased_by: 'other-worker:token-99', lease_expires_at: activeLease },
  ]);

  const repo = new SchedulerRepository(mockPool);
  const claimed = await repo.claimDueMonitors(5, { workerId: 'worker-B', leaseDurationMs: 60000 });

  assert.equal(claimed.length, 0, 'Must not claim row held by active unexpired lease');
});

test('SchedulerRepository recovers expired leases after simulated worker crash', async () => {
  const pastRun = new Date(Date.now() - 60000).toISOString();
  const expiredLease = new Date(Date.now() - 1000).toISOString(); // expired 1s ago

  const mockPool = createMockClaimPool([
    { id: 1, api_id: 1, next_run_at: pastRun, leased_by: 'dead-worker:crashed-token', lease_expires_at: expiredLease },
  ]);

  const repo = new SchedulerRepository(mockPool);
  const claimed = await repo.claimDueMonitors(5, { workerId: 'worker-rescuer', leaseDurationMs: 60000 });

  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].apiId, 1);
  assert.ok(claimed[0].claimToken.startsWith('worker-rescuer:'));
  assert.ok(mockPool.schedules[0].leased_by.startsWith('worker-rescuer:'));
});

test('completeClaim verifies ownership and prevents stale worker from overwriting newer lease', async () => {
  const mockPool = createMockClaimPool([
    { id: 1, api_id: 1, next_run_at: new Date().toISOString(), leased_by: 'worker-2:new-token', lease_expires_at: new Date().toISOString() },
  ]);

  const repo = new SchedulerRepository(mockPool);

  // Stale worker tries to complete using old token
  const staleResult = await repo.completeClaim(1, 'worker-1:old-stale-token', {
    outcome: 'passed',
    nextRunAt: new Date(Date.now() + 30000),
  });

  assert.equal(staleResult.completed, false);
  assert.equal(staleResult.reason, 'LEASE_LOST_OR_EXPIRED');

  // Verify schedule state was NOT overwritten by stale worker
  assert.equal(mockPool.schedules[0].leased_by, 'worker-2:new-token');

  // Legitimate owner completes
  const validResult = await repo.completeClaim(1, 'worker-2:new-token', {
    outcome: 'passed',
    nextRunAt: new Date(Date.now() + 30000),
  });

  assert.equal(validResult.completed, true);
  assert.equal(mockPool.schedules[0].leased_by, null);
  assert.equal(mockPool.schedules[0].last_outcome, 'passed');
});

test('completeClaim behaves correctly for passed, failed, and error outcomes', async () => {
  const mockPool = createMockClaimPool([
    { id: 1, api_id: 1, next_run_at: new Date().toISOString(), leased_by: 'token-pass', lease_expires_at: new Date().toISOString() },
    { id: 2, api_id: 2, next_run_at: new Date().toISOString(), leased_by: 'token-fail', lease_expires_at: new Date().toISOString() },
    { id: 3, api_id: 3, next_run_at: new Date().toISOString(), leased_by: 'token-err', lease_expires_at: new Date().toISOString() },
  ]);

  const repo = new SchedulerRepository(mockPool);

  await repo.completeClaim(1, 'token-pass', { outcome: 'passed', nextRunAt: new Date(Date.now() + 30000) });
  assert.equal(mockPool.schedules[0].last_outcome, 'passed');

  await repo.completeClaim(2, 'token-fail', { outcome: 'failed', nextRunAt: new Date(Date.now() + 30000) });
  assert.equal(mockPool.schedules[1].last_outcome, 'failed');

  await repo.completeClaim(3, 'token-err', { outcome: 'error', nextRunAt: new Date(Date.now() + 30000) });
  assert.equal(mockPool.schedules[2].last_outcome, 'error');
});

test('repairMissingSchedules safely and idempotently initializes schedules for unregistered monitors', async () => {
  const mockPool = createMockClaimPool([
    { id: 1, api_id: 1, next_run_at: new Date().toISOString(), leased_by: null, lease_expires_at: null },
  ]);

  const repo = new SchedulerRepository(mockPool);

  // APIs 2 and 3 exist in mockPool.apis but have no schedule yet
  const repaired = await repo.repairMissingSchedules();
  assert.equal(repaired, 2);
  assert.equal(mockPool.schedules.length, 3);

  // Second run: nothing to repair
  const secondRepair = await repo.repairMissingSchedules();
  assert.equal(secondRepair, 0);
  assert.equal(mockPool.schedules.length, 3);
});

test('Workspace isolation: due monitor with workspace_id IS NULL cannot be claimed', async () => {
  const past = new Date(Date.now() - 10000).toISOString();
  const mockPool = createMockClaimPool([
    { id: 1, api_id: 1, next_run_at: past, leased_by: null, lease_expires_at: null }, // workspace_id: 1
    { id: 2, api_id: 2, next_run_at: past, leased_by: null, lease_expires_at: null }, // we will set workspace_id = null
  ]);

  // Set API 2 to null workspace
  const api2 = mockPool.apis.find(a => a.id === 2);
  api2.workspace_id = null;

  const repo = new SchedulerRepository(mockPool);
  const claimed = await repo.claimDueMonitors(10, { workerId: 'worker-test' });

  // Only API 1 (with workspace) can be claimed; API 2 (null workspace) is excluded
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].apiId, 1);
  assert.equal(claimed.some(c => c.apiId === 2), false);
});

test('Workspace isolation: missing-schedule repair does not make null-workspace monitor runnable', async () => {
  const mockPool = createMockClaimPool([]);
  // Set API 3 to null workspace
  const api3 = mockPool.apis.find(a => a.id === 3);
  api3.workspace_id = null;

  const repo = new SchedulerRepository(mockPool);
  const repaired = await repo.repairMissingSchedules();

  // Only APIs 1 and 2 (valid workspace) get schedules; API 3 (null workspace) does not
  assert.equal(repaired, 2);
  assert.equal(mockPool.schedules.some(s => s.api_id === 3), false);

  // Even if claimed now, API 3 cannot be claimed
  const claimed = await repo.claimDueMonitors(5, { workerId: 'worker-test' });
  assert.equal(claimed.length, 2);
  assert.ok(claimed.every(c => c.apiId !== 3));
});

test('Workspace isolation: existing orphaned schedule rows for null-workspace monitors remain unclaimable and preserved', async () => {
  const past = new Date(Date.now() - 10000).toISOString();
  const mockPool = createMockClaimPool([
    { id: 99, api_id: 999, next_run_at: past, leased_by: null, lease_expires_at: null },
  ]);

  // Add an orphaned monitor with workspace_id: null
  mockPool.apis.push({
    id: 999,
    name: 'Orphaned Legacy API',
    url: 'http://example.com/orphan',
    method: 'GET',
    workspace_id: null,
  });

  const repo = new SchedulerRepository(mockPool);
  const claimed = await repo.claimDueMonitors(5, { workerId: 'worker-test' });

  // Unclaimable: claim returns 0 items
  assert.equal(claimed.length, 0);

  // Preserved: schedule and monitor records remain intact (not deleted)
  assert.equal(mockPool.schedules.length, 1);
  assert.equal(mockPool.schedules[0].api_id, 999);
  assert.equal(mockPool.apis.some(a => a.id === 999), true);
});
