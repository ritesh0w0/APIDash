// backend/data/testResultRepository.js
'use strict';

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

function normalizeResultRow(row) {
  if (!row) return null;
  return {
    ...row,
    assertion_results: parseJsonField(row.assertion_results),
  };
}

class TestResultRepository {
  constructor(pool = null) {
    this._pool = pool;
  }

  get pool() {
    return this._pool || getPool();
  }

  async create({ api_id, status_code, response_time, result, error_message = null, assertion_results = null, error_type = null }) {
    const serializedAssertions = assertion_results
      ? (typeof assertion_results === 'string' ? assertion_results : JSON.stringify(assertion_results))
      : null;

    const [insertResult] = await this.pool.execute(
      `INSERT INTO test_results (api_id, status_code, response_time, result, error_message, assertion_results, error_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        api_id,
        status_code,
        response_time,
        result,
        error_message,
        serializedAssertions,
        error_type,
      ]
    );

    return {
      id: insertResult.insertId,
      api_id,
      status_code,
      response_time,
      result,
      error_message,
      assertion_results: parseJsonField(serializedAssertions),
      error_type,
    };
  }

  async findRecentByApiId(apiId, limit = 20) {
    const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const [rows] = await this.pool.execute(
      `SELECT id, api_id, status_code, response_time, result, error_message, assertion_results, error_type, tested_at
       FROM test_results
       WHERE api_id = ?
       ORDER BY tested_at DESC
       LIMIT ${safeLimit}`,
      [apiId]
    );
    return rows.map(normalizeResultRow);
  }

  async findChartPoints(apiId, limit = 10) {
    const safeLimit = Math.max(1, Math.min(50, parseInt(limit, 10) || 10));
    const [rows] = await this.pool.execute(
      `SELECT response_time, result, tested_at
       FROM test_results
       WHERE api_id = ?
       ORDER BY tested_at DESC
       LIMIT ${safeLimit}`,
      [apiId]
    );
    return rows.reverse();
  }

  async findWithinHours(apiId, hours = 24) {
    const safeHours = Math.max(1, Math.min(168, parseInt(hours, 10) || 24));
    const [rows] = await this.pool.execute(
      `SELECT status_code, response_time, result, error_message, assertion_results, error_type, tested_at
       FROM test_results
       WHERE api_id = ?
         AND tested_at >= NOW() - INTERVAL ${safeHours} HOUR
       ORDER BY tested_at ASC`,
      [apiId]
    );
    return rows.map(normalizeResultRow);
  }
}

const testResultRepository = new TestResultRepository();

module.exports = {
  TestResultRepository,
  testResultRepository,
};
