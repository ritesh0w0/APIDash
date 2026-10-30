// backend/data/incidentRepository.js
'use strict';

const { getPool } = require('../db');

class IncidentRepository {
  constructor(pool = null) {
    this._pool = pool;
  }

  get pool() {
    return this._pool || getPool();
  }

  /**
   * Creates a new incident record.
   *
   * @param {Object} data
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<Object>}
   */
  async create(data, conn = null) {
    const executor = conn || this.pool;
    const {
      api_id,
      workspace_id,
      status = 'open',
      first_unhealthy_at,
      opened_at,
      first_result_id = null,
      trigger_result_id = null,
      latest_result_id = null,
      unhealthy_count = 1,
      error_summary = null,
    } = data;

    const [result] = await executor.execute(
      `INSERT INTO incidents (
        api_id, workspace_id, status, first_unhealthy_at, opened_at,
        first_result_id, trigger_result_id, latest_result_id, unhealthy_count, error_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        api_id,
        workspace_id,
        status,
        first_unhealthy_at,
        opened_at,
        first_result_id,
        trigger_result_id,
        latest_result_id,
        unhealthy_count,
        error_summary ? String(error_summary).slice(0, 1000) : null,
      ]
    );

    return {
      id: result.insertId,
      api_id,
      workspace_id,
      status,
      first_unhealthy_at,
      opened_at,
      first_result_id,
      trigger_result_id,
      latest_result_id,
      unhealthy_count,
      error_summary,
    };
  }

  /**
   * Updates an existing incident record.
   *
   * @param {number} id
   * @param {Object} updates
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<boolean>}
   */
  async update(id, updates, conn = null) {
    const executor = conn || this.pool;
    const allowed = [
      'status',
      'resolved_at',
      'latest_result_id',
      'resolution_result_id',
      'unhealthy_count',
      'error_summary',
    ];

    const setClauses = [];
    const values = [];

    for (const key of allowed) {
      if (updates[key] !== undefined) {
        setClauses.push(`${key} = ?`);
        if (key === 'error_summary' && updates[key]) {
          values.push(String(updates[key]).slice(0, 1000));
        } else {
          values.push(updates[key]);
        }
      }
    }

    if (setClauses.length === 0) return false;

    setClauses.push('updated_at = NOW()');
    values.push(id);

    const [res] = await executor.execute(
      `UPDATE incidents SET ${setClauses.join(', ')} WHERE id = ?`,
      values
    );

    return res.affectedRows > 0;
  }

  /**
   * Finds the currently open incident for an API monitor (if any).
   *
   * @param {number} apiId
   * @param {import('mysql2/promise').Connection} [conn]
   * @param {boolean} [forUpdate=false]
   * @returns {Promise<Object|null>}
   */
  async findActiveByApiId(apiId, conn = null, forUpdate = false) {
    const executor = conn || this.pool;
    const lockClause = forUpdate ? ' FOR UPDATE' : '';
    const [rows] = await executor.execute(
      `SELECT * FROM incidents WHERE api_id = ? AND status = 'open' LIMIT 1${lockClause}`,
      [apiId]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Finds an incident by id scoped to workspace.
   *
   * @param {number} id
   * @param {number} workspaceId
   * @returns {Promise<Object|null>}
   */
  async findById(id, workspaceId) {
    const [rows] = await this.pool.execute(
      `SELECT i.*, a.name AS api_name, a.url AS api_url, a.method AS api_method
       FROM incidents i
       JOIN apis a ON i.api_id = a.id
       WHERE i.id = ? AND i.workspace_id = ?
       LIMIT 1`,
      [id, workspaceId]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Lists incidents for a workspace with status filtering and pagination.
   *
   * @param {number} workspaceId
   * @param {Object} [options]
   * @param {string} [options.status='all'] - 'open', 'resolved', 'all'
   * @param {number} [options.limit=20]
   * @param {number} [options.offset=0]
   * @returns {Promise<Array<Object>>}
   */
  async listByWorkspace(workspaceId, options = {}) {
    const status = options.status || 'all';
    const limit = Math.max(1, Math.min(100, parseInt(options.limit, 10) || 20));
    const offset = Math.max(0, parseInt(options.offset, 10) || 0);

    const whereClauses = ['i.workspace_id = ?'];
    const params = [workspaceId];

    if (status === 'open') {
      whereClauses.push("i.status = 'open'");
    } else if (status === 'resolved') {
      whereClauses.push("i.status = 'resolved'");
    }

    const whereSql = whereClauses.join(' AND ');
    const [rows] = await this.pool.execute(
      `SELECT i.*, a.name AS api_name, a.url AS api_url, a.method AS api_method
       FROM incidents i
       JOIN apis a ON i.api_id = a.id
       WHERE ${whereSql}
       ORDER BY (i.status = 'open') DESC, i.opened_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    return rows;
  }

  /**
   * Counts incidents for a workspace with status filter.
   *
   * @param {number} workspaceId
   * @param {Object} [options]
   * @param {string} [options.status='all']
   * @returns {Promise<number>}
   */
  async countByWorkspace(workspaceId, options = {}) {
    const status = options.status || 'all';
    const whereClauses = ['workspace_id = ?'];
    const params = [workspaceId];

    if (status === 'open') {
      whereClauses.push("status = 'open'");
    } else if (status === 'resolved') {
      whereClauses.push("status = 'resolved'");
    }

    const whereSql = whereClauses.join(' AND ');
    const [rows] = await this.pool.execute(
      `SELECT COUNT(*) AS cnt FROM incidents WHERE ${whereSql}`,
      params
    );

    return rows[0].cnt;
  }
}

const incidentRepository = new IncidentRepository();

module.exports = {
  IncidentRepository,
  incidentRepository,
};

