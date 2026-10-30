// backend/data/schedulerRepository.js
'use strict';

const crypto = require('crypto');
const { getPool } = require('../db');

function parseJsonField(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch (_e) {
    return val;
  }
}

function normalizeApiRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    url: row.url,
    method: (row.method || 'GET').toUpperCase(),
    expected_status: row.expected_status || 200,
    headers: parseJsonField(row.headers),
    body: parseJsonField(row.body),
    timeout_ms: row.timeout_ms || 10000,
    assertions: parseJsonField(row.assertions),
  };
}

/**
 * Calculates the next scheduled run time using a fixed-rate cadence policy
 * anchored to the previous schedule, skipping missed slots during overruns.
 *
 * @param {Date|string|number} scheduledRunAt - previous scheduled anchor
 * @param {number} intervalMs - recurring cadence interval in ms (default 30000)
 * @param {Date|number} [currentTime] - reference time (default Date.now())
 * @returns {Date} next fixed-rate run time
 */
function calculateNextRunAt(scheduledRunAt, intervalMs = 30000, currentTime = Date.now()) {
  const nowMs = currentTime instanceof Date ? currentTime.getTime() : Number(currentTime);
  const anchorMs = scheduledRunAt instanceof Date
    ? scheduledRunAt.getTime()
    : (scheduledRunAt ? new Date(scheduledRunAt).getTime() : nowMs);

  if (isNaN(anchorMs) || anchorMs > nowMs) {
    return new Date(nowMs + intervalMs);
  }

  const intervalsElapsed = Math.floor((nowMs - anchorMs) / intervalMs) + 1;
  const nextMs = anchorMs + (intervalsElapsed * intervalMs);
  return new Date(nextMs);
}

/**
 * Repository for durable monitor scheduling, atomic job claiming,
 * lease renewal, and completion.
 */
class SchedulerRepository {
  constructor(pool = null) {
    this._pool = pool;
  }

  get pool() {
    return this._pool || getPool();
  }

  /**
   * Idempotently ensures that every registered monitor in `apis` that possesses
   * a valid workspace ownership has a corresponding scheduling record.
   * Monitors without workspace ownership (workspace_id IS NULL) are strictly excluded.
   *
   * @returns {Promise<number>} number of newly created schedules
   */
  async repairMissingSchedules() {
    const [result] = await this.pool.execute(
      `INSERT IGNORE INTO monitor_schedules (api_id, next_run_at)
       SELECT id, NOW() FROM apis
       WHERE workspace_id IS NOT NULL`
    );
    return result.affectedRows || 0;
  }

  /**
   * Idempotently creates scheduling state for a single monitor if it has workspace ownership.
   *
   * @param {number} apiId
   * @param {Date} [nextRunAt]
   * @returns {Promise<boolean>} true if inserted
   */
  async ensureSchedule(apiId, nextRunAt = new Date()) {
    const [result] = await this.pool.execute(
      `INSERT IGNORE INTO monitor_schedules (api_id, next_run_at)
       SELECT id, ? FROM apis
       WHERE id = ? AND workspace_id IS NOT NULL`,
      [nextRunAt, apiId]
    );
    return Boolean(result.affectedRows > 0);
  }

  /**
   * Fetches scheduling record for a given API monitor.
   *
   * @param {number} apiId
   * @returns {Promise<Object | null>}
   */
  async findByApiId(apiId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM monitor_schedules WHERE api_id = ?',
      [apiId]
    );
    return rows[0] || null;
  }

  /**
   * Atomically claims up to `limit` due monitors for the given worker.
   * Uses MySQL 8 `SELECT ... FOR UPDATE SKIP LOCKED` inside a short database transaction.
   *
   * Invariant: Outbound HTTP requests are NEVER executed while holding this transaction.
   * The transaction commits immediately after updating the lease columns.
   *
   * @param {number} limit - maximum monitors to claim (bounded concurrency slots)
   * @param {Object} options
   * @param {string} [options.workerId] - worker instance identifier
   * @param {number} [options.leaseDurationMs] - lease duration in ms (e.g. 60000)
   * @returns {Promise<Array<{ scheduleId: number, apiId: number, claimToken: string, leaseExpiresAt: Date, monitor: Object }>>}
   */
  async claimDueMonitors(limit = 5, { workerId = 'worker-1', leaseDurationMs = 60000 } = {}) {
    if (limit <= 0) return [];

    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();

      // Find due and unleased (or lease-expired) monitors
      const [dueRows] = await connection.execute(
        `SELECT
          ms.id AS schedule_id,
          ms.api_id,
          ms.next_run_at,
          ms.leased_by,
          ms.lease_expires_at,
          a.id,
          a.workspace_id,
          a.name,
          a.url,
          a.method,
          a.expected_status,
          a.headers,
          a.body,
          a.timeout_ms,
          a.assertions
        FROM monitor_schedules ms
        INNER JOIN apis a ON ms.api_id = a.id
        WHERE ms.next_run_at <= NOW()
          AND (ms.lease_expires_at IS NULL OR ms.lease_expires_at <= NOW())
          AND a.workspace_id IS NOT NULL
        ORDER BY ms.next_run_at ASC
        LIMIT ${Number(limit)}
        FOR UPDATE SKIP LOCKED`
      );

      if (!dueRows || dueRows.length === 0) {
        await connection.commit();
        return [];
      }

      const leaseDurationSec = Math.max(1, Math.round(leaseDurationMs / 1000));
      const claimed = [];

      for (const row of dueRows) {
        const claimToken = `${workerId}:${crypto.randomUUID()}`;

        // Compute lease_expires_at on the MySQL server clock via DATE_ADD(NOW(), ...)
        await connection.execute(
          `UPDATE monitor_schedules
           SET leased_by = ?,
               lease_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
           WHERE id = ?`,
          [claimToken, leaseDurationSec, row.schedule_id]
        );

        claimed.push({
          scheduleId: row.schedule_id,
          apiId: row.api_id,
          claimToken,
          scheduledRunAt: row.next_run_at,
          monitor: normalizeApiRow(row),
        });
      }

      await connection.commit();
      return claimed;
    } catch (err) {
      try {
        await connection.rollback();
      } catch (_rollbackErr) {
        // Suppress rollback errors if connection already closed
      }
      throw err;
    } finally {
      connection.release();
    }
  }

  /**
   * Completes a scheduled execution by releasing the lease and scheduling the next run,
   * strictly verifying that the caller still owns the lease.
   *
   * Database clock serves as the single authority:
   * Next run is calculated using database time NOW() anchored to the stored next_run_at,
   * completely decoupling correctness from application host clock synchronization.
   *
   * @param {number} apiId
   * @param {string} claimToken
   * @param {Object} options
   * @param {string} options.outcome - 'passed' | 'failed' | 'error'
   * @param {number} [options.cadenceSeconds=30] - fixed cadence in seconds
   * @param {Date} [options.nextRunAt] - optional explicit timestamp override (e.g. tests)
   * @returns {Promise<{ completed: boolean, reason?: string }>}
   */
  async completeClaim(apiId, claimToken, { outcome, cadenceSeconds = 30, nextRunAt = null }) {
    let sql;
    let params;

    if (nextRunAt !== null && nextRunAt !== undefined) {
      // Explicit timestamp provided (e.g. unit test overrides)
      sql = `UPDATE monitor_schedules
             SET leased_by = NULL,
                 lease_expires_at = NULL,
                 last_run_at = NOW(),
                 last_outcome = ?,
                 next_run_at = ?
             WHERE api_id = ? AND leased_by = ?`;
      params = [outcome, nextRunAt, apiId, claimToken];
    } else {
      // Production path: Database server clock computes next fixed-rate slot anchored to stored next_run_at
      const sec = Math.max(1, Math.round(cadenceSeconds));
      sql = `UPDATE monitor_schedules
             SET leased_by = NULL,
                 lease_expires_at = NULL,
                 last_run_at = NOW(),
                 last_outcome = ?,
                 next_run_at = CASE
                   WHEN next_run_at IS NULL OR next_run_at > NOW() THEN DATE_ADD(NOW(), INTERVAL ? SECOND)
                   ELSE DATE_ADD(next_run_at, INTERVAL ((FLOOR(TIMESTAMPDIFF(SECOND, next_run_at, NOW()) / ?) + 1) * ?) SECOND)
                 END
             WHERE api_id = ? AND leased_by = ?`;
      params = [outcome, sec, sec, sec, apiId, claimToken];
    }

    const [result] = await this.pool.execute(sql, params);

    if (result.affectedRows === 0) {
      return {
        completed: false,
        reason: 'LEASE_LOST_OR_EXPIRED',
      };
    }

    return {
      completed: true,
    };
  }

  /**
   * Releases an active claim without recording a completed execution (e.g. during worker shutdown).
   *
   * @param {number} apiId
   * @param {string} claimToken
   * @returns {Promise<{ released: boolean }>}
   */
  async releaseClaim(apiId, claimToken) {
    const [result] = await this.pool.execute(
      `UPDATE monitor_schedules
       SET leased_by = NULL,
           lease_expires_at = NULL
       WHERE api_id = ? AND leased_by = ?`,
      [apiId, claimToken]
    );
    return {
      released: result.affectedRows > 0,
    };
  }
}

const schedulerRepository = new SchedulerRepository();

module.exports = {
  SchedulerRepository,
  schedulerRepository,
  normalizeApiRow,
  calculateNextRunAt,
};