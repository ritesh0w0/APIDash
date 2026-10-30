// backend/data/schedulerRunRepository.js
'use strict';

const { getPool } = require('../db');

/**
 * Repository for managing `scheduler_runs` database table operations.
 */
class SchedulerRunRepository {
  constructor(pool = null) {
    this._pool = pool;
  }

  get pool() {
    return this._pool || getPool();
  }

  async create({ total, passed, failed, avg_ms }) {
    const [result] = await this.pool.execute(
      'INSERT INTO scheduler_runs (total, passed, failed, avg_ms) VALUES (?, ?, ?, ?)',
      [total, passed, failed, avg_ms]
    );
    return {
      id: result.insertId,
      total,
      passed,
      failed,
      avg_ms,
    };
  }

  async findRecent(limit = 60) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM scheduler_runs ORDER BY ran_at DESC LIMIT ?',
      [Number(limit)]
    );
    return rows;
  }

  async findRecentByWorkspace(workspaceId, limit = 60) {
    if (!workspaceId) return [];
    const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 60));
    const [rows] = await this.pool.execute(
      `SELECT
        DATE_SUB(tr.tested_at, INTERVAL MOD(SECOND(tr.tested_at), 30) SECOND) AS ran_at,
        CAST(SUM(CASE WHEN tr.result IN ('PASS', 'passed') THEN 1 ELSE 0 END) AS SIGNED) AS passed,
        CAST(SUM(CASE WHEN tr.result IN ('FAIL', 'failed', 'error') THEN 1 ELSE 0 END) AS SIGNED) AS failed,
        ROUND(AVG(tr.response_time)) AS avg_ms
      FROM test_results tr
      INNER JOIN apis a ON tr.api_id = a.id
      WHERE a.workspace_id = ?
      GROUP BY ran_at
      ORDER BY ran_at DESC
      LIMIT ${safeLimit}`,
      [workspaceId]
    );
    return rows;
  }
}

module.exports = {
  SchedulerRunRepository,
  schedulerRunRepository: new SchedulerRunRepository(),
};
