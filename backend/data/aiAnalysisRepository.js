// backend/data/aiAnalysisRepository.js
'use strict';

const crypto = require('crypto');
const { getPool } = require('../db');

class AiAnalysisRepository {
  /**
   * @param {import('mysql2/promise').Pool} [pool]
   */
  constructor(pool = null) {
    this._pool = pool;
  }

  get pool() {
    return this._pool || getPool();
  }

  /**
   * Enqueues or deduplicates an AI analysis job.
   * If an active job (pending/running) or recent completed job with identical evidence fingerprint exists,
   * returns that existing record unless forceNew is true.
   *
   * @param {Object} data
   * @param {number} data.workspace_id
   * @param {number} data.incident_id
   * @param {number} data.created_by_user_id
   * @param {string} data.provider
   * @param {string} data.model
   * @param {string} data.prompt_version
   * @param {string} data.schema_version
   * @param {Object} data.evidence_snapshot
   * @param {string} data.evidence_fingerprint
   * @param {boolean} [data.forceNew=false]
   * @returns {Promise<{ job: Object, isExisting: boolean }>}
   */
  async createJob(data) {
    const {
      workspace_id,
      incident_id,
      created_by_user_id,
      provider,
      model,
      prompt_version,
      schema_version,
      evidence_snapshot,
      evidence_fingerprint,
      forceNew = false,
    } = data;

    // Check for existing matching job on same incident and fingerprint
    if (!forceNew) {
      const [existing] = await this.pool.execute(
        `SELECT * FROM incident_ai_analyses
         WHERE workspace_id = ? AND incident_id = ? AND evidence_fingerprint = ?
           AND status IN ('pending', 'running', 'completed')
         ORDER BY id DESC LIMIT 1`,
        [workspace_id, incident_id, evidence_fingerprint]
      );

      if (existing.length > 0) {
        return {
          job: this._formatRow(existing[0]),
          isExisting: true,
        };
      }
    }

    const snapshotJson = typeof evidence_snapshot === 'string'
      ? evidence_snapshot
      : JSON.stringify(evidence_snapshot);

    const [res] = await this.pool.execute(
      `INSERT INTO incident_ai_analyses (
         workspace_id, incident_id, created_by_user_id, status,
         provider, model, prompt_version, schema_version,
         evidence_snapshot, evidence_fingerprint, max_attempts
       ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 3)`,
      [
        workspace_id,
        incident_id,
        created_by_user_id,
        provider,
        model,
        prompt_version,
        schema_version,
        snapshotJson,
        evidence_fingerprint,
      ]
    );

    const createdJob = await this.findById(res.insertId, workspace_id);
    return {
      job: createdJob,
      isExisting: false,
    };
  }

  /**
   * Claims pending/stale analysis jobs for worker processing using SKIP LOCKED.
   *
   * @param {number} limit
   * @param {Object} options
   * @param {string} options.workerId
   * @param {number} [options.leaseMs=60000]
   * @returns {Promise<Array<Object>>}
   */
  async claimDueJobs(limit = 2, options = {}) {
    const safeLimit = Math.max(1, Math.min(10, parseInt(limit, 10) || 2));
    const leaseSeconds = Math.max(35, Math.round((options.leaseMs || 60000) / 1000));
    const workerToken = options.workerId || `ai-worker-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const claimToken = `${workerToken}:${crypto.randomBytes(8).toString('hex')}`;

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      const [rows] = await conn.execute(
        `SELECT id, workspace_id, incident_id, provider, model, prompt_version, schema_version,
                evidence_snapshot, evidence_fingerprint, attempt_count, max_attempts
         FROM incident_ai_analyses
         WHERE status IN ('pending', 'running')
           AND (lease_expires_at IS NULL OR lease_expires_at <= NOW(3))
           AND attempt_count < max_attempts
         ORDER BY created_at ASC
         LIMIT ${safeLimit}
         FOR UPDATE SKIP LOCKED`
      );

      if (rows.length === 0) {
        await conn.commit();
        return [];
      }

      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(', ');

      await conn.execute(
        `UPDATE incident_ai_analyses
         SET
           status = 'running',
           lease_owner_token = ?,
           lease_expires_at = DATE_ADD(NOW(3), INTERVAL ? SECOND),
           attempt_count = attempt_count + 1,
           updated_at = NOW(3)
         WHERE id IN (${placeholders})`,
        [claimToken, leaseSeconds, ...ids]
      );

      await conn.commit();

      return rows.map((r) => {
        let snapshot = r.evidence_snapshot;
        if (typeof snapshot === 'string') {
          try {
            snapshot = JSON.parse(snapshot);
          } catch (_e) {
            // Keep as is
          }
        }
        return {
          id: r.id,
          workspaceId: r.workspace_id,
          incidentId: r.incident_id,
          provider: r.provider,
          model: r.model,
          promptVersion: r.prompt_version,
          schemaVersion: r.schema_version,
          evidenceSnapshot: snapshot,
          evidenceFingerprint: r.evidence_fingerprint,
          attemptCount: r.attempt_count + 1,
          maxAttempts: r.max_attempts,
          claimToken,
        };
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Completes an analysis job and stores the validated structured result.
   *
   * @param {number} jobId
   * @param {string} claimToken
   * @param {Object} data
   * @returns {Promise<boolean>}
   */
  async completeJob(jobId, claimToken, data = {}) {
    const { result, durationMs = null, tokens = {}, provider = null, model = null } = data;
    const resultJson = typeof result === 'string' ? result : JSON.stringify(result);

    const [res] = await this.pool.execute(
      `UPDATE incident_ai_analyses
       SET
         status = 'completed',
         result = ?,
         duration_ms = ?,
         tokens_prompt = ?,
         tokens_completion = ?,
         tokens_total = ?,
         provider = COALESCE(?, provider),
         model = COALESCE(?, model),
         error_message = NULL,
         error_code = NULL,
         lease_owner_token = NULL,
         lease_expires_at = NULL,
         updated_at = NOW(3)
       WHERE id = ? AND lease_owner_token = ?`,
      [
        resultJson,
        durationMs,
        tokens.prompt || null,
        tokens.completion || null,
        tokens.total || null,
        provider,
        model,
        jobId,
        claimToken,
      ]
    );

    return res.affectedRows > 0;
  }

  /**
   * Marks a job as failed or resets to pending if retryable.
   *
   * @param {number} jobId
   * @param {string} claimToken
   * @param {Object} data
   * @returns {Promise<boolean>}
   */
  async failJob(jobId, claimToken, data = {}) {
    const { errorMessage = 'Analysis failed', errorCode = 'AI_ERROR', retryable = false } = data;
    const boundedError = String(errorMessage).slice(0, 500);

    // If retryable and attempts remaining, reset to pending
    const status = retryable ? 'pending' : 'failed';

    const [res] = await this.pool.execute(
      `UPDATE incident_ai_analyses
       SET
         status = ?,
         error_message = ?,
         error_code = ?,
         lease_owner_token = NULL,
         lease_expires_at = NULL,
         updated_at = NOW(3)
       WHERE id = ? AND lease_owner_token = ?`,
      [status, boundedError, errorCode, jobId, claimToken]
    );

    return res.affectedRows > 0;
  }

  /**
   * Finds an analysis by ID scoped to workspace.
   *
   * @param {number} id
   * @param {number} workspaceId
   * @returns {Promise<Object|null>}
   */
  async findById(id, workspaceId) {
    const [rows] = await this.pool.execute(
      `SELECT a.*, u.email AS created_by_email, u.display_name AS created_by_name
       FROM incident_ai_analyses a
       LEFT JOIN users u ON a.created_by_user_id = u.id
       WHERE a.id = ? AND a.workspace_id = ?
       LIMIT 1`,
      [id, workspaceId]
    );

    return rows.length > 0 ? this._formatRow(rows[0]) : null;
  }

  /**
   * Retrieves the latest analysis for an incident.
   *
   * @param {number} incidentId
   * @param {number} workspaceId
   * @returns {Promise<Object|null>}
   */
  async getLatestByIncident(incidentId, workspaceId) {
    const [rows] = await this.pool.execute(
      `SELECT a.*, u.email AS created_by_email, u.display_name AS created_by_name
       FROM incident_ai_analyses a
       LEFT JOIN users u ON a.created_by_user_id = u.id
       WHERE a.incident_id = ? AND a.workspace_id = ?
       ORDER BY a.id DESC
       LIMIT 1`,
      [incidentId, workspaceId]
    );

    return rows.length > 0 ? this._formatRow(rows[0]) : null;
  }

  /**
   * Lists prior analyses for an incident.
   *
   * @param {number} incidentId
   * @param {number} workspaceId
   * @param {Object} [options]
   * @returns {Promise<Array<Object>>}
   */
  async listByIncident(incidentId, workspaceId, options = {}) {
    const limit = Math.max(1, Math.min(50, parseInt(options.limit, 10) || 10));
    const offset = Math.max(0, parseInt(options.offset, 10) || 0);

    const [rows] = await this.pool.execute(
      `SELECT a.id, a.workspace_id, a.incident_id, a.status, a.provider, a.model,
              a.prompt_version, a.schema_version, a.duration_ms, a.error_code,
              a.created_at, a.updated_at, u.email AS created_by_email, u.display_name AS created_by_name
       FROM incident_ai_analyses a
       LEFT JOIN users u ON a.created_by_user_id = u.id
       WHERE a.incident_id = ? AND a.workspace_id = ?
       ORDER BY a.id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      [incidentId, workspaceId]
    );

    return rows;
  }

  /**
   * Safely cleans up analyses older than retentionDays.
   *
   * @param {number} [retentionDays=30]
   * @returns {Promise<number>} rows deleted
   */
  async cleanupExpired(retentionDays = 30) {
    const days = Math.max(1, Math.min(365, parseInt(retentionDays, 10) || 30));
    const [res] = await this.pool.execute(
      'DELETE FROM incident_ai_analyses WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [days]
    );
    return res.affectedRows;
  }

  /**
   * Internal helper to deserialize JSON fields in database row.
   *
   * @private
   */
  _formatRow(row) {
    let parsedSnapshot = row.evidence_snapshot;
    if (typeof parsedSnapshot === 'string') {
      try {
        parsedSnapshot = JSON.parse(parsedSnapshot);
      } catch (_e) {
        // Keep as string
      }
    }

    let parsedResult = row.result;
    if (typeof parsedResult === 'string') {
      try {
        parsedResult = JSON.parse(parsedResult);
      } catch (_e) {
        // Keep as string
      }
    }

    return {
      ...row,
      evidence_snapshot: parsedSnapshot,
      result: parsedResult,
    };
  }
}

const aiAnalysisRepository = new AiAnalysisRepository();

module.exports = {
  AiAnalysisRepository,
  aiAnalysisRepository,
};

