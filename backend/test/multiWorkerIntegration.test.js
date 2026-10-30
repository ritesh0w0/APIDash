// backend/test/multiWorkerIntegration.test.js
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { runMigrations } = require('../scripts/migrate');
const { SchedulerRepository } = require('../data/schedulerRepository');
const { SchedulerWorker } = require('../services/schedulerWorker');
const { loadConfig } = require('../config');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function getAdminConnection() {
  const config = loadConfig();
  try {
    const conn = await mysql.createConnection({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
    });
    return conn;
  } catch (err) {
    return null;
  }
}

test('Multi-worker concurrency integration: simultaneous claims prevent double-execution and guarantee distinct ownership', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible for multi-worker integration test');
    return;
  }

  const dbName = `apidash_multi_worker_${Date.now()}`;
  let pool = null;

  try {
    await adminConn.execute(`CREATE DATABASE \`${dbName}\``);
    await adminConn.end();

    const config = loadConfig();
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: dbName,
      connectionLimit: 10,
    });

    // 1. Run migrations to setup complete schema
    await runMigrations(pool, MIGRATIONS_DIR);

    // Create user and workspace
    const [userRes] = await pool.execute(
      'INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)',
      ['worker_test@example.com', 'hash123', 'Worker User']
    );
    const [wsRes] = await pool.execute(
      'INSERT INTO workspaces (name, created_by) VALUES (?, ?)',
      ['Multi Worker Workspace', userRes.insertId]
    );

    // 2. Insert 6 due monitors belonging to workspace
    const createdApiIds = [];
    for (let i = 1; i <= 6; i++) {
      const [res] = await pool.execute(
        'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
        [wsRes.insertId, `Monitor ${i}`, `http://example.com/check/${i}`, 'GET', 200]
      );
      createdApiIds.push(res.insertId);
      await pool.execute(
        'INSERT INTO monitor_schedules (api_id, next_run_at) VALUES (?, NOW() - INTERVAL 10 SECOND)',
        [res.insertId]
      );
    }

    // Insert 1 unassigned legacy monitor without workspace to verify it remains unclaimable
    const [nullWsApi] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [null, 'Unassigned Monitor', 'http://example.com/check/null-ws', 'GET', 200]
    );
    await pool.execute(
      'INSERT INTO monitor_schedules (api_id, next_run_at) VALUES (?, NOW() - INTERVAL 10 SECOND)',
      [nullWsApi.insertId]
    );

    // 3. Create two independent SchedulerRepository instances representing Worker A and Worker B
    const repoWorkerA = new SchedulerRepository(pool);
    const repoWorkerB = new SchedulerRepository(pool);

    // 4. Run concurrent claims simultaneously from both workers
    const [claimedA, claimedB] = await Promise.all([
      repoWorkerA.claimDueMonitors(3, { workerId: 'worker-instance-A', leaseDurationMs: 60000 }),
      repoWorkerB.claimDueMonitors(3, { workerId: 'worker-instance-B', leaseDurationMs: 60000 }),
    ]);

    // Verify claim limits
    assert.ok(claimedA.length <= 3);
    assert.ok(claimedB.length <= 3);
    assert.equal(claimedA.length + claimedB.length, 6, 'All 6 due monitors must be claimed across both workers');

    // Verify no monitor is claimed by both workers
    const apiIdsA = claimedA.map(c => c.apiId);
    const apiIdsB = claimedB.map(c => c.apiId);
    for (const id of apiIdsA) {
      assert.ok(!apiIdsB.includes(id), `Monitor ${id} was claimed by both workers! Simultaneous race detected`);
    }

    // Verify unassigned monitor without workspace was NOT claimed by either worker
    assert.ok(!apiIdsA.includes(nullWsApi.insertId), 'Worker A must not claim null-workspace monitor');
    assert.ok(!apiIdsB.includes(nullWsApi.insertId), 'Worker B must not claim null-workspace monitor');

    // Verify distinct ownership tokens
    const tokensA = claimedA.map(c => c.claimToken);
    const tokensB = claimedB.map(c => c.claimToken);
    for (const tA of tokensA) {
      assert.ok(tA.startsWith('worker-instance-A:'));
    }
    for (const tB of tokensB) {
      assert.ok(tB.startsWith('worker-instance-B:'));
    }

    // 5. Verify worker with valid lease can complete work using database time calculations
    const claimToComplete = claimedA[0];
    const compResult = await repoWorkerA.completeClaim(claimToComplete.apiId, claimToComplete.claimToken, {
      outcome: 'passed',
      cadenceSeconds: 30,
    });
    assert.equal(compResult.completed, true);

    const [completedRows] = await pool.execute('SELECT * FROM monitor_schedules WHERE api_id = ?', [claimToComplete.apiId]);
    assert.equal(completedRows[0].leased_by, null);
    assert.equal(completedRows[0].lease_expires_at, null);
    assert.equal(completedRows[0].last_outcome, 'passed');
    const [futureCheck] = await pool.execute('SELECT (next_run_at > NOW()) AS is_future FROM monitor_schedules WHERE api_id = ?', [claimToComplete.apiId]);
    assert.equal(futureCheck[0].is_future, 1);

    // 6. Verify another worker cannot overwrite that claim's scheduling state
    const staleResult = await repoWorkerB.completeClaim(claimToComplete.apiId, 'worker-instance-B:counterfeit-token', {
      outcome: 'failed',
      cadenceSeconds: 30,
    });
    assert.equal(staleResult.completed, false);
    assert.equal(staleResult.reason, 'LEASE_LOST_OR_EXPIRED');

    // 7. Verify an expired claim can subsequently be recovered
    const uncompletedClaim = claimedB[0];
    // Force claim B to expire by rewinding its lease_expires_at
    await pool.execute(
      'UPDATE monitor_schedules SET lease_expires_at = NOW() - INTERVAL 5 SECOND WHERE api_id = ?',
      [uncompletedClaim.apiId]
    );

    // Worker A claims again and should recover uncompletedClaim
    const recovered = await repoWorkerA.claimDueMonitors(1, { workerId: 'worker-instance-A', leaseDurationMs: 60000 });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].apiId, uncompletedClaim.apiId);
    assert.ok(recovered[0].claimToken.startsWith('worker-instance-A:'));
  } finally {
    if (pool) {
      await pool.end();
    }
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});

test('Database clock authority: host clock skew does not cause premature lease expiry or incorrect cadence advancement', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible for clock authority test');
    return;
  }

  const dbName = `apidash_clock_auth_${Date.now()}`;
  let pool = null;

  try {
    await adminConn.execute(`CREATE DATABASE \`${dbName}\``);
    await adminConn.end();

    const config = loadConfig();
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: dbName,
      connectionLimit: 5,
    });

    await runMigrations(pool, MIGRATIONS_DIR);

    const [userRes] = await pool.execute(
      'INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)',
      ['clock_test@example.com', 'hash123', 'Clock User']
    );
    const [wsRes] = await pool.execute(
      'INSERT INTO workspaces (name, created_by) VALUES (?, ?)',
      ['Clock Workspace', userRes.insertId]
    );
    const [apiRes] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method, expected_status) VALUES (?, ?, ?, ?, ?)',
      [wsRes.insertId, 'Clock Target API', 'http://example.com/check', 'GET', 200]
    );

    // Initial schedule: due 10 seconds in the past according to MySQL NOW()
    await pool.execute(
      'INSERT INTO monitor_schedules (api_id, next_run_at) VALUES (?, NOW() - INTERVAL 10 SECOND)',
      [apiRes.insertId]
    );

    const repo = new SchedulerRepository(pool);

    // 1. Claim monitor with 60s lease
    const claimed = await repo.claimDueMonitors(1, { workerId: 'clock-skew-worker', leaseDurationMs: 60000 });
    assert.equal(claimed.length, 1);

    // 2. Verify lease_expires_at was calculated on MySQL server clock (between 58s and 60s ahead of MySQL NOW())
    const [leaseCheck] = await pool.execute(
      'SELECT TIMESTAMPDIFF(SECOND, NOW(), lease_expires_at) AS remaining_sec FROM monitor_schedules WHERE api_id = ?',
      [apiRes.insertId]
    );
    const remainingSec = Number(leaseCheck[0].remaining_sec);
    assert.ok(remainingSec >= 58 && remainingSec <= 60, `Lease remaining seconds (${remainingSec}) must be ~60s on database clock`);

    // 3. Complete claim using database server clock calculation
    const completeRes = await repo.completeClaim(apiRes.insertId, claimed[0].claimToken, {
      outcome: 'passed',
      cadenceSeconds: 30,
    });
    assert.equal(completeRes.completed, true);

    // 4. Verify next_run_at advancement uses database time while preserving cadence anchor
    const [nextCheck] = await pool.execute(
      'SELECT TIMESTAMPDIFF(SECOND, NOW(), next_run_at) AS diff_sec FROM monitor_schedules WHERE api_id = ?',
      [apiRes.insertId]
    );
    const diffSec = Number(nextCheck[0].diff_sec);
    assert.ok(diffSec >= 15 && diffSec <= 30, `Next run time diff (${diffSec}s) must be in future on database clock`);

    // 5. Test overlong execution skipping missed slots on database clock:
    // Set next_run_at to 45 seconds in the past (overran 1 interval)
    await pool.execute(
      'UPDATE monitor_schedules SET next_run_at = NOW() - INTERVAL 45 SECOND, leased_by = ? WHERE api_id = ?',
      ['clock-skew-worker:overrun-token', apiRes.insertId]
    );

    await repo.completeClaim(apiRes.insertId, 'clock-skew-worker:overrun-token', {
      outcome: 'passed',
      cadenceSeconds: 30,
    });

    const [overrunCheck] = await pool.execute(
      'SELECT TIMESTAMPDIFF(SECOND, NOW(), next_run_at) AS next_slot_sec FROM monitor_schedules WHERE api_id = ?',
      [apiRes.insertId]
    );
    const nextSlotSec = Number(overrunCheck[0].next_slot_sec);
    // 45s ago + 2*30s = 15s in the future
    assert.ok(nextSlotSec >= 10 && nextSlotSec <= 20, `Overrun must advance to next future slot (~15s) without catch-up burst (got: ${nextSlotSec}s)`);
  } finally {
    if (pool) {
      await pool.end();
    }
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});