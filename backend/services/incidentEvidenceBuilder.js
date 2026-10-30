// backend/services/incidentEvidenceBuilder.js
'use strict';

const crypto = require('crypto');
const { getPool } = require('../db');
const { incidentRepository: defaultIncidentRepo } = require('../data/incidentRepository');

const SENSITIVE_QUERY_KEYS = new Set([
  'token', 'key', 'apikey', 'api_key', 'secret', 'password', 'passwd', 'auth',
  'authorization', 'signature', 'sig', 'access_token', 'refresh_token', 'bearer',
  'client_secret', 'session', 'sid', 'jwt',
]);

/**
 * Sanitizes URLs by stripping credentials and masking sensitive query parameters.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
function sanitizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '***';
    }

    for (const [key] of parsed.searchParams.entries()) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, '***REDACTED***');
      }
    }
    return parsed.toString();
  } catch (_e) {
    // If URL parse fails, regex replace sensitive query param patterns
    return rawUrl
      .replace(/:\/\/[^:]+:[^@]+@/, '://***:***@')
      .replace(/([?&](?:token|key|secret|password|auth|sig|signature)=)[^&#]*/gi, '$1***REDACTED***');
  }
}

/**
 * Categorizes and bounds error messages into safe transport/diagnostic classifications.
 *
 * @param {string|null} errMsg
 * @param {string|null} errType
 * @param {number|null} statusCode
 * @returns {{ category: string, bounded_message: string }}
 */
function categorizeError(errMsg, errType, statusCode) {
  const msg = (errMsg || '').trim();
  const type = (errType || '').toUpperCase();

  let category = 'GENERAL_ERROR';
  if (type === 'CONTRACT_REQUEST_INVALID') {
    category = 'CONTRACT_PREFLIGHT_REJECTED';
  } else if (type === 'CONTRACT_RESPONSE_INVALID' || type === 'CONTRACT_VIOLATION') {
    category = 'CONTRACT_SCHEMA_MISMATCH';
  } else if (type === 'ASSERTION_FAILURE') {
    category = 'ASSERTION_FAILED';
  } else if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo') || msg.includes('EAI_AGAIN')) {
    category = 'DNS_RESOLUTION_FAILURE';
  } else if (msg.includes('ECONNREFUSED')) {
    category = 'CONNECTION_REFUSED';
  } else if (msg.includes('ETIMEDOUT') || msg.includes('timeout') || msg.includes('timed out')) {
    category = 'TIMEOUT_EXCEEDED';
  } else if (msg.includes('CERT_') || msg.includes('certificate') || msg.includes('SSL') || msg.includes('TLS')) {
    category = 'TLS_CERTIFICATE_ERROR';
  } else if (statusCode && statusCode >= 500) {
    category = `HTTP_SERVER_ERROR_${statusCode}`;
  } else if (statusCode && statusCode >= 400) {
    category = `HTTP_CLIENT_ERROR_${statusCode}`;
  }

  // Bound message length to 200 chars and strip credentials
  const bounded_message = msg
    .replace(/(bearer\s+)[a-zA-Z0-9_\-\.]+/gi, '$1***')
    .slice(0, 200);

  return { category, bounded_message };
}

/**
 * Canonical JSON stringifier (sorted keys) for deterministic SHA-256 fingerprinting.
 *
 * @param {*} value
 * @returns {string}
 */
function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const entries = keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k]));
  return '{' + entries.join(',') + '}';
}

class IncidentEvidenceBuilder {
  /**
   * @param {Object} [options]
   * @param {import('../data/incidentRepository').IncidentRepository} [options.incidentRepo]
   * @param {import('mysql2/promise').Pool} [options.pool]
   */
  constructor(options = {}) {
    this.incidentRepo = options.incidentRepo || defaultIncidentRepo;
    this.pool = options.pool || getPool();
  }

  /**
   * Builds a sanitized, deterministic, size-bounded evidence snapshot for an incident.
   *
   * @param {number} incidentId
   * @param {number} workspaceId
   * @param {Object} [options]
   * @param {number} [options.maxResults=20]
   * @returns {Promise<{ evidenceSnapshot: Object, evidenceFingerprint: string, incident: Object, monitor: Object }>}
   */
  async buildEvidenceSnapshot(incidentId, workspaceId, options = {}) {
    const maxResults = Math.max(5, Math.min(30, parseInt(options.maxResults, 10) || 20));

    // 1. Fetch incident record scoped to workspace
    const incident = await this.incidentRepo.findById(incidentId, workspaceId);
    if (!incident) {
      const err = new Error(`Incident #${incidentId} not found in workspace #${workspaceId}`);
      err.statusCode = 404;
      throw err;
    }

    // 2. Fetch monitor metadata
    const [monitorRows] = await this.pool.execute(
      'SELECT id, workspace_id, name, url, method, expected_status, timeout_ms FROM apis WHERE id = ? AND workspace_id = ?',
      [incident.api_id, workspaceId]
    );

    if (monitorRows.length === 0) {
      const err = new Error(`Associated monitor #${incident.api_id} not found`);
      err.statusCode = 404;
      throw err;
    }
    const monitor = monitorRows[0];

    // 3. Fetch recent test results with contract validation outcomes (Phase 6 join)
    const [resultRows] = await this.pool.execute(
      `SELECT
         tr.id, tr.api_id, tr.status_code, tr.response_time, tr.result,
         tr.error_message, tr.error_type, tr.assertion_results, tr.tested_at,
         cvr.verdict AS contract_verdict, cvr.findings AS contract_findings
       FROM test_results tr
       LEFT JOIN contract_validation_results cvr ON cvr.test_result_id = tr.id
       WHERE tr.api_id = ?
       ORDER BY tr.tested_at DESC
       LIMIT ?`,
      [incident.api_id, maxResults]
    );

    // 4. Compute deterministic baseline metrics across prior healthy runs (if any)
    const passingRuns = resultRows.filter((r) => r.result === 'PASS' && r.response_time != null);
    let baseline = null;
    if (passingRuns.length > 0) {
      const latencies = passingRuns.map((r) => r.response_time).sort((a, b) => a - b);
      const sum = latencies.reduce((acc, val) => acc + val, 0);
      const avg = Math.round(sum / latencies.length);
      const p95Idx = Math.floor(latencies.length * 0.95);
      baseline = {
        sample_count: passingRuns.length,
        avg_latency_ms: avg,
        p95_latency_ms: latencies[p95Idx] || avg,
        min_latency_ms: latencies[0],
        max_latency_ms: latencies[latencies.length - 1],
      };
    }

    // Calculate incident duration in seconds
    const openedTime = new Date(incident.opened_at).getTime();
    const resolvedTime = incident.resolved_at ? new Date(incident.resolved_at).getTime() : Date.now();
    const durationSeconds = Math.max(0, Math.round((resolvedTime - openedTime) / 1000));

    // 5. Structure evidence items with stable IDs
    const observations = [];
    let evidenceIndex = 1;
    const nextEvidenceId = () => `E-${String(evidenceIndex++).padStart(3, '0')}`;

    // E-001: Core Incident Overview
    observations.push({
      id: nextEvidenceId(),
      type: 'INCIDENT_LIFECYCLE',
      title: `Incident #${incident.id} Status: ${incident.status.toUpperCase()}`,
      status: incident.status,
      opened_at: incident.opened_at,
      resolved_at: incident.resolved_at || null,
      duration_seconds: durationSeconds,
      unhealthy_streak: incident.unhealthy_count,
      error_summary: incident.error_summary ? incident.error_summary.slice(0, 300) : null,
    });

    // E-002: Monitor Configuration (Sanitized)
    observations.push({
      id: nextEvidenceId(),
      type: 'MONITOR_CONFIGURATION',
      title: `Monitor Configuration: ${monitor.name || 'API #' + monitor.id}`,
      method: (monitor.method || 'GET').toUpperCase(),
      url_sanitized: sanitizeUrl(monitor.url),
      expected_status: monitor.expected_status || 200,
      timeout_ms: monitor.timeout_ms || 10000,
    });

    // E-003: Performance Baseline (if available)
    if (baseline) {
      observations.push({
        id: nextEvidenceId(),
        type: 'PERFORMANCE_BASELINE',
        title: `Historical Latency Baseline (${baseline.sample_count} successful samples)`,
        ...baseline,
      });
    }

    // E-004 onwards: Bounded recent executions (ordered chronologically from oldest to newest)
    const chronologicalResults = [...resultRows].reverse();
    for (const r of chronologicalResults) {
      const { category, bounded_message } = categorizeError(r.error_message, r.error_type, r.status_code);

      let parsedAssertions = null;
      if (r.assertion_results) {
        try {
          const raw = typeof r.assertion_results === 'string' ? JSON.parse(r.assertion_results) : r.assertion_results;
          if (Array.isArray(raw)) {
            // Keep up to 5 assertion summaries
            parsedAssertions = raw.slice(0, 5).map((a) => ({
              type: a.type,
              passed: Boolean(a.passed),
              reason: a.reason ? String(a.reason).slice(0, 150) : null,
            }));
          }
        } catch (_e) {
          // Ignore JSON parse errors for assertions
        }
      }

      let parsedContractFindings = null;
      if (r.contract_findings) {
        try {
          const raw = typeof r.contract_findings === 'string' ? JSON.parse(r.contract_findings) : r.contract_findings;
          if (Array.isArray(raw)) {
            parsedContractFindings = raw.slice(0, 5).map((f) => ({
              rule: f.rule,
              message: f.message ? String(f.message).slice(0, 150) : null,
            }));
          }
        } catch (_e) {
          // Ignore
        }
      }

      observations.push({
        id: nextEvidenceId(),
        type: 'EXECUTION_OBSERVATION',
        test_result_id: r.id,
        timestamp: r.tested_at,
        outcome: r.result,
        status_code: r.status_code,
        latency_ms: r.response_time,
        error_category: category,
        error_message: bounded_message || null,
        contract_verdict: r.contract_verdict || null,
        contract_findings: parsedContractFindings,
        assertion_results: parsedAssertions,
      });
    }

    const evidenceSnapshot = {
      incident_id: incident.id,
      workspace_id: workspaceId,
      monitor_id: monitor.id,
      captured_at: new Date().toISOString(),
      latest_result_id: incident.latest_result_id || (resultRows[0] ? resultRows[0].id : null),
      observations,
    };

    // Calculate deterministic fingerprint across data content (excluding transient captured_at timestamp)
    const { captured_at, ...fingerprintData } = evidenceSnapshot;
    const canonicalJson = canonicalStringify(fingerprintData);
    const evidenceFingerprint = crypto.createHash('sha256').update(canonicalJson).digest('hex');

    return {
      evidenceSnapshot,
      evidenceFingerprint,
      incident,
      monitor,
    };
  }
}

const incidentEvidenceBuilder = new IncidentEvidenceBuilder();

module.exports = {
  IncidentEvidenceBuilder,
  incidentEvidenceBuilder,
  sanitizeUrl,
  categorizeError,
  canonicalStringify,
};
