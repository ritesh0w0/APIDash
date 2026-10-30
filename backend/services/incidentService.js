// backend/services/incidentService.js
'use strict';

const { getPool } = require('../db');
const { incidentRepository: defaultIncidentRepo } = require('../data/incidentRepository');
const { notificationRepository: defaultNotificationRepo } = require('../data/notificationRepository');
const { contractRepository: defaultContractRepo } = require('../data/contractRepository');
const { logger: defaultLogger } = require('../logger');

/**
 * Determines whether an observation outcome is healthy or unhealthy.
 *
 * @param {string} outcome - 'passed', 'failed', 'error', or legacy 'PASS', 'FAIL'
 * @returns {boolean} true if healthy, false if unhealthy
 */
function isHealthyOutcome(outcome) {
  if (!outcome || typeof outcome !== 'string') return false;
  const canonical = outcome.trim().toLowerCase();
  return canonical === 'passed' || canonical === 'pass';
}

/**
 * Bounds and sanitizes error summary text for incident logging and notifications.
 *
 * @param {string|null} message
 * @param {string|null} errorType
 * @param {number|null} statusCode
 * @returns {string}
 */
function sanitizeErrorSummary(message, errorType, statusCode) {
  const parts = [];
  if (statusCode) parts.push(`HTTP ${statusCode}`);
  if (errorType) parts.push(`[${errorType}]`);
  if (message) parts.push(message.trim().replace(/\s+/g, ' '));
  const raw = parts.length > 0 ? parts.join(' - ') : 'Monitoring execution failed';
  return raw.slice(0, 1000);
}

class IncidentService {
  constructor(options = {}) {
    this._pool = options.pool || null;
    this.incidentRepo = options.incidentRepo || defaultIncidentRepo;
    this.notificationRepo = options.notificationRepo || defaultNotificationRepo;
    this.contractRepo = options.contractRepo || defaultContractRepo;
    this.logger = options.logger || defaultLogger;
  }

  get pool() {
    return this._pool || getPool();
  }

  /**
   * Atomically records a completed test result, evaluates consecutive streaks,
   * transitions incident state, and enqueues outbox events in a single MySQL transaction.
   *
   * @param {Object} monitor - { id, name, url, method, workspace_id }
   * @param {Object} executionRecord - { status_code, response_time, result, error_message, error_type, assertion_results }
   * @param {Object} [deps]
   * @returns {Promise<Object>} { resultRecord, incident, transition }
   */
  async recordExecutionAndEvaluateIncident(monitor, executionRecord, deps = {}, attempt = 1) {
    const actualDeps = deps || {};
    const conn = actualDeps.connection || (await this.pool.getConnection());
    const isManagedConnection = !actualDeps.connection;

    try {
      if (isManagedConnection) {
        await conn.beginTransaction();
      }

      // 1. Lock monitor row and derive authoritative workspace_id from database
      const [apiRows] = await conn.execute(
        'SELECT id, workspace_id, name, url, method FROM apis WHERE id = ? FOR UPDATE',
        [monitor.id]
      );

      if (apiRows.length === 0) {
        throw new Error(`Monitor with ID ${monitor.id} does not exist`);
      }

      const authoritativeApi = apiRows[0];
      const workspaceId = authoritativeApi.workspace_id;

      // 2. Persist test result into test_results
      const serializedAssertions = executionRecord.assertion_results
        ? (typeof executionRecord.assertion_results === 'string'
            ? executionRecord.assertion_results
            : JSON.stringify(executionRecord.assertion_results))
        : null;

      const [insertResult] = await conn.execute(
        `INSERT INTO test_results (api_id, status_code, response_time, result, error_message, assertion_results, error_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          monitor.id,
          executionRecord.status_code,
          executionRecord.response_time,
          executionRecord.result,
          executionRecord.error_message || null,
          serializedAssertions,
          executionRecord.error_type || null,
        ]
      );

      const resultId = insertResult.insertId;
      const savedRecord = {
        id: resultId,
        api_id: monitor.id,
        status_code: executionRecord.status_code,
        response_time: executionRecord.response_time,
        result: executionRecord.result,
        error_message: executionRecord.error_message || null,
        error_type: executionRecord.error_type || null,
        assertion_results: executionRecord.assertion_results || null,
      };

      // 2b. Persist contract validation result if present
      if (executionRecord.contract_validation) {
        const savedCv = await this.contractRepo.saveValidationResult(
          {
            ...executionRecord.contract_validation,
            test_result_id: resultId,
            api_id: monitor.id,
            workspace_id: workspaceId || executionRecord.contract_validation.workspace_id,
          },
          conn
        );
        savedRecord.contract_validation = savedCv;
      }

      // 3. Reject incident processing for monitors whose workspace_id is NULL
      // Preserve existing records without inferring, assigning, or migrating ownership.
      if (!workspaceId) {
        if (isManagedConnection) {
          await conn.commit();
        }
        return {
          resultRecord: savedRecord,
          incident: null,
          transition: 'none_null_workspace',
        };
      }

      // 4. Idempotency check: record in result_processing_ledger
      try {
        await conn.execute(
          'INSERT INTO result_processing_ledger (result_id, api_id) VALUES (?, ?)',
          [resultId, monitor.id]
        );
      } catch (ledgerErr) {
        if (ledgerErr.code === 'ER_DUP_ENTRY' || ledgerErr.message.includes('Duplicate entry')) {
          // Already processed: commit test result and return safely without duplicate transitions
          if (isManagedConnection) {
            await conn.commit();
          }
          return {
            resultRecord: savedRecord,
            incident: null,
            transition: 'duplicate_skipped',
          };
        }
        throw ledgerErr;
      }

      // 5. Load and lock monitor_health_states
      const [stateRows] = await conn.execute(
        'SELECT * FROM monitor_health_states WHERE api_id = ? FOR UPDATE',
        [monitor.id]
      );

      let healthState = stateRows.length > 0 ? stateRows[0] : null;
      if (!healthState) {
        try {
          await conn.execute(
            `INSERT INTO monitor_health_states (api_id, workspace_id, consecutive_healthy, consecutive_unhealthy)
             VALUES (?, ?, 0, 0)`,
            [monitor.id, workspaceId]
          );
        } catch (insertErr) {
          if (insertErr.code !== 'ER_DUP_ENTRY' && !insertErr.message.includes('Duplicate entry')) {
            throw insertErr;
          }
        }
        const [newStateRows] = await conn.execute(
          'SELECT * FROM monitor_health_states WHERE api_id = ? FOR UPDATE',
          [monitor.id]
        );
        healthState = newStateRows[0];
      }

      // 6. Check for currently active open incident for this monitor
      let activeIncident = null;
      if (healthState.current_incident_id) {
        const [incRows] = await conn.execute(
          'SELECT * FROM incidents WHERE id = ? AND status = "open" FOR UPDATE',
          [healthState.current_incident_id]
        );
        if (incRows.length > 0) {
          activeIncident = incRows[0];
        }
      }

      if (!activeIncident) {
        const [incRows] = await conn.execute(
          'SELECT * FROM incidents WHERE api_id = ? AND status = "open" FOR UPDATE',
          [monitor.id]
        );
        if (incRows.length > 0) {
          activeIncident = incRows[0];
        }
      }

      // Derive explicit health classification (healthy, unhealthy, or neutral)
      let healthImpact = 'unhealthy';
      if (executionRecord.health_impact !== undefined) {
        healthImpact = executionRecord.health_impact;
      } else if (isHealthyOutcome(executionRecord.result)) {
        healthImpact = 'healthy';
      }

      const isHealthy = healthImpact === 'healthy';
      const sanitizedSummary = sanitizeErrorSummary(
        executionRecord.error_message,
        executionRecord.error_type,
        executionRecord.status_code
      );

      let transition = 'none';
      let incidentOutput = activeIncident;

      // 7. Apply deterministic state machine transitions
      if (healthImpact === 'neutral') {
        // Phase 6 Neutral Result (e.g. preflight rejection):
        // - Resets both consecutive healthy and consecutive unhealthy streaks to 0
        // - Does NOT increment either counter
        // - Never opens an incident on its own; never resolves an existing incident
        // - Leaves any existing open incident open
        await conn.execute(
          `UPDATE monitor_health_states
           SET consecutive_healthy = 0, consecutive_unhealthy = 0,
               last_result_id = ?, last_result_outcome = ?, updated_at = NOW()
           WHERE api_id = ?`,
          [resultId, executionRecord.result, monitor.id]
        );

        transition = 'neutral_streak_reset';
        incidentOutput = activeIncident;
      } else if (activeIncident) {
        // --- Open Incident Lifecycle ---
        if (!isHealthy) {
          // Additional failure while open: update failure streak and incident record
          const nextUnhealthy = healthState.consecutive_unhealthy + 1;
          const updatedCount = (activeIncident.unhealthy_count || 0) + 1;

          await conn.execute(
            `UPDATE incidents
             SET unhealthy_count = ?, latest_result_id = ?, error_summary = ?, updated_at = NOW()
             WHERE id = ?`,
            [updatedCount, resultId, sanitizedSummary, activeIncident.id]
          );

          await conn.execute(
            `UPDATE monitor_health_states
             SET consecutive_healthy = 0, consecutive_unhealthy = ?, last_result_id = ?, last_result_outcome = ?, updated_at = NOW()
             WHERE api_id = ?`,
            [nextUnhealthy, resultId, executionRecord.result, monitor.id]
          );

          transition = 'incident_updated';
          activeIncident.unhealthy_count = updatedCount;
          activeIncident.latest_result_id = resultId;
          activeIncident.error_summary = sanitizedSummary;
          incidentOutput = activeIncident;
        } else {
          // Healthy observation while incident is open
          const nextHealthy = healthState.consecutive_healthy + 1;

          if (nextHealthy >= 2) {
            // Threshold reached: 2 consecutive passing results RESOLVE the incident
            await conn.execute(
              `UPDATE incidents
               SET status = 'resolved', resolved_at = NOW(), resolution_result_id = ?, updated_at = NOW()
               WHERE id = ?`,
              [resultId, activeIncident.id]
            );

            await conn.execute(
              `UPDATE monitor_health_states
               SET current_incident_id = NULL, first_unhealthy_at = NULL, first_unhealthy_result_id = NULL,
                   consecutive_healthy = 0, consecutive_unhealthy = 0, last_result_id = ?, last_result_outcome = ?, updated_at = NOW()
               WHERE api_id = ?`,
              [resultId, executionRecord.result, monitor.id]
            );

            // Enqueue incident_resolved outbox event atomically
            const resolvedPayload = {
              incident_id: activeIncident.id,
              api_id: monitor.id,
              api_name: authoritativeApi.name,
              api_url: authoritativeApi.url,
              opened_at: activeIncident.opened_at,
              resolved_at: new Date().toISOString(),
              resolution_result_id: resultId,
              consecutive_passes_required: 2,
            };

            await this.notificationRepo.enqueueOutboxEvent(
              {
                idempotency_key: `incident:${activeIncident.id}:resolved`,
                workspace_id: workspaceId,
                incident_id: activeIncident.id,
                event_type: 'incident_resolved',
                payload: resolvedPayload,
              },
              conn
            );

            transition = 'incident_resolved';
            activeIncident.status = 'resolved';
            activeIncident.resolution_result_id = resultId;
            incidentOutput = activeIncident;
          } else {
            // First healthy observation while open: increment healthy streak, keep incident open
            await conn.execute(
              `UPDATE monitor_health_states
               SET consecutive_healthy = ?, consecutive_unhealthy = 0, last_result_id = ?, last_result_outcome = ?, updated_at = NOW()
               WHERE api_id = ?`,
              [nextHealthy, resultId, executionRecord.result, monitor.id]
            );

            transition = 'healthy_streak_incremented';
            incidentOutput = activeIncident;
          }
        }
      } else {
        // --- No Open Incident ---
        if (isHealthy) {
          // Healthy result resets unhealthy streak
          await conn.execute(
            `UPDATE monitor_health_states
             SET consecutive_healthy = consecutive_healthy + 1, consecutive_unhealthy = 0,
                 first_unhealthy_at = NULL, first_unhealthy_result_id = NULL,
                 last_result_id = ?, last_result_outcome = ?, updated_at = NOW()
             WHERE api_id = ?`,
            [resultId, executionRecord.result, monitor.id]
          );
          transition = 'healthy';
          incidentOutput = null;
        } else {
          // Unhealthy result
          const nextUnhealthy = healthState.consecutive_unhealthy + 1;

          if (nextUnhealthy === 1) {
            // First unhealthy result: record first_unhealthy observation anchor, do not open incident
            await conn.execute(
              `UPDATE monitor_health_states
               SET consecutive_unhealthy = 1, consecutive_healthy = 0,
                   first_unhealthy_at = NOW(), first_unhealthy_result_id = ?,
                   last_result_id = ?, last_result_outcome = ?, updated_at = NOW()
               WHERE api_id = ?`,
              [resultId, resultId, executionRecord.result, monitor.id]
            );
            transition = 'first_unhealthy';
            incidentOutput = null;
          } else if (nextUnhealthy >= 2) {
            // Second consecutive failure: OPEN INCIDENT!
            const firstUnhealthyAt = healthState.first_unhealthy_at || new Date();
            const firstResultId = healthState.first_unhealthy_result_id || resultId;

            // Database uniqueness on active_api_id prevents duplicate open incidents
            const [createRes] = await conn.execute(
              `INSERT INTO incidents (
                api_id, workspace_id, status, first_unhealthy_at, opened_at,
                first_result_id, trigger_result_id, latest_result_id, unhealthy_count, error_summary
              ) VALUES (?, ?, 'open', ?, NOW(), ?, ?, ?, ?, ?)`,
              [
                monitor.id,
                workspaceId,
                firstUnhealthyAt,
                firstResultId,
                resultId,
                resultId,
                nextUnhealthy,
                sanitizedSummary,
              ]
            );

            const newIncidentId = createRes.insertId;

            await conn.execute(
              `UPDATE monitor_health_states
               SET current_incident_id = ?, consecutive_unhealthy = ?, consecutive_healthy = 0,
                   last_result_id = ?, last_result_outcome = ?, updated_at = NOW()
               WHERE api_id = ?`,
              [newIncidentId, nextUnhealthy, resultId, executionRecord.result, monitor.id]
            );

            // Enqueue incident_opened outbox event atomically
            const openPayload = {
              incident_id: newIncidentId,
              api_id: monitor.id,
              api_name: authoritativeApi.name,
              api_url: authoritativeApi.url,
              first_unhealthy_at: firstUnhealthyAt,
              opened_at: new Date().toISOString(),
              error_summary: sanitizedSummary,
              trigger_result_id: resultId,
              unhealthy_count: nextUnhealthy,
            };

            await this.notificationRepo.enqueueOutboxEvent(
              {
                idempotency_key: `incident:${newIncidentId}:opened`,
                workspace_id: workspaceId,
                incident_id: newIncidentId,
                event_type: 'incident_opened',
                payload: openPayload,
              },
              conn
            );

            transition = 'incident_opened';
            incidentOutput = {
              id: newIncidentId,
              api_id: monitor.id,
              workspace_id: workspaceId,
              status: 'open',
              first_unhealthy_at: firstUnhealthyAt,
              opened_at: new Date(),
              first_result_id: firstResultId,
              trigger_result_id: resultId,
              latest_result_id: resultId,
              unhealthy_count: nextUnhealthy,
              error_summary: sanitizedSummary,
            };
          }
        }
      }

      if (isManagedConnection) {
        await conn.commit();
      }

      return {
        resultRecord: savedRecord,
        incident: incidentOutput,
        transition,
      };
    } catch (err) {
      if (isManagedConnection) {
        try {
          await conn.rollback();
        } catch (_rbErr) {}
        conn.release();

        if (err.code === 'ER_LOCK_DEADLOCK' && attempt < 5) {
          await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 40 + 10)));
          return this.recordExecutionAndEvaluateIncident(monitor, executionRecord, deps, attempt + 1);
        }
      }
      this.logger.error(
        { err: err.message, api_id: monitor.id },
        'Transaction failed during recordExecutionAndEvaluateIncident'
      );
      throw err;
    } finally {
      if (isManagedConnection && !conn._released) {
        try {
          conn.release();
        } catch (_) {}
      }
    }
  }
}

const incidentService = new IncidentService();

module.exports = {
  IncidentService,
  incidentService,
  isHealthyOutcome,
  sanitizeErrorSummary,
};

