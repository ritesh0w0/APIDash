// backend/services/executor.js
'use strict';

const { safeMonitoringRequest } = require('./ssrfProtection');
const { logger: defaultLogger } = require('../logger');

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
]);

const MAX_BODY_INSPECTION_BYTES = 65536; // 64 KB inspection limit for in-memory assertions

/**
 * Redacts known sensitive headers from header objects.
 *
 * @param {Record<string, string>} headers
 * @returns {Record<string, string>}
 */
function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const sanitized = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase())) {
      sanitized[k] = '[REDACTED]';
    } else {
      sanitized[k] = v;
    }
  }
  return sanitized;
}

/**
 * Classifies low-level transport errors into predictable, explainable categories.
 *
 * @param {Error} err
 * @returns {string} Error classification
 */
function classifyExecutionError(err) {
  if (!err) return 'UNKNOWN_ERROR';

  if (err.isSsrfBlocked || err.message?.includes('SSRF blocked')) {
    return 'SSRF_BLOCKED';
  }

  const code = (err.code || '').toUpperCase();
  const msg = (err.message || '').toLowerCase();

  if (code === 'ECONNABORTED' || msg.includes('timeout') || msg.includes('etimedout')) {
    return 'TIMEOUT';
  }
  if (code === 'ENOTFOUND' || msg.includes('getaddrinfo enotfound') || msg.includes('dns')) {
    return 'DNS_FAILURE';
  }
  if (
    code.startsWith('ERR_TLS') ||
    code.startsWith('CERT_') ||
    msg.includes('tls') ||
    msg.includes('certificate') ||
    msg.includes('ssl')
  ) {
    return 'TLS_ERROR';
  }
  if (code === 'ECONNREFUSED' || msg.includes('econnrefused')) {
    return 'CONNECTION_REFUSED';
  }
  if (code === 'ECONNRESET' || code === 'EPIPE' || msg.includes('econnreset') || msg.includes('socket hang up')) {
    return 'CONNECTION_RESET';
  }
  if (msg.includes('maxcontentlength') || msg.includes('maxbodylength') || msg.includes('too large')) {
    return 'RESPONSE_TOO_LARGE';
  }
  if (msg.includes('redirect')) {
    return 'REDIRECT_ERROR';
  }

  return 'TRANSPORT_ERROR';
}

/**
 * Cleans an error message to prevent accidental leakage of sensitive tokens.
 *
 * @param {string} msg
 * @returns {string}
 */
function sanitizeErrorMessage(msg) {
  if (!msg) return 'Unknown transport error';
  return String(msg)
    .replace(/(bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(basic\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key[:=]\s*)[^\s&]+/gi, '$1[REDACTED]');
}

/**
 * Executes a controlled, bounded, SSRF-protected HTTP request for a monitor.
 *
 * @param {Object} monitor
 * @param {string} monitor.url
 * @param {string} [monitor.method='GET'] - HTTP Method
 * @param {Record<string, string>} [monitor.headers] - Custom request headers
 * @param {string|Object} [monitor.body] - Request body
 * @param {number} [monitor.timeout_ms=10000] - Timeout in milliseconds
 * @param {Object} [deps]
 * @param {typeof safeMonitoringRequest} [deps.safeClient]
 * @param {import('pino').Logger} [deps.logger]
 */
async function executeRequest(monitor, deps = {}) {
  const safeClient = deps.safeClient || deps.httpClient || safeMonitoringRequest;
  const logger = deps.logger || defaultLogger;

  const url = monitor.url;
  const method = (monitor.method || 'GET').toUpperCase();

  // Enforce server-controlled bounds on timeout (min 100ms, max 30000ms, default 10000ms)
  const rawTimeout = Number(monitor.timeout_ms !== undefined ? monitor.timeout_ms : 10000);
  const timeout = Math.max(100, Math.min(30000, Number.isInteger(rawTimeout) ? rawTimeout : 10000));

  const headers = monitor.headers && typeof monitor.headers === 'object' && !Array.isArray(monitor.headers)
    ? { ...monitor.headers }
    : {};

  let body = monitor.body;
  if (typeof body === 'object' && body !== null) {
    try {
      body = JSON.stringify(body);
      if (!headers['content-type'] && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    } catch (_e) {
      body = String(body);
    }
  }

  const start = Date.now();

  try {
    const response = await safeClient(
      {
        url,
        method,
        headers,
        body,
        timeout,
        maxBodyBytes: 1048576, // 1 MB server limit
      },
      deps
    );

    const response_time = Date.now() - start;
    const rawHeaders = response.headers || {};
    const lowerHeaders = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      lowerHeaders[k.toLowerCase()] = v;
    }

    let responseBody = response.data;
    let json_body = null;
    let json_parse_error = false;
    let body_truncated = false;
    let body_bytes = 0;

    if (typeof responseBody === 'object' && responseBody !== null) {
      let serialized = '';
      try {
        serialized = JSON.stringify(responseBody);
        body_bytes = Buffer.byteLength(serialized, 'utf8');
      } catch (_e) {
        serialized = '[Complex Object]';
        body_bytes = 16;
      }

      if (body_bytes > MAX_BODY_INSPECTION_BYTES) {
        body_truncated = true;
        json_body = null;
      } else {
        json_body = responseBody;
      }
      responseBody = serialized.slice(0, MAX_BODY_INSPECTION_BYTES);
    } else if (typeof responseBody === 'string') {
      body_bytes = Buffer.byteLength(responseBody, 'utf8');
      if (body_bytes > MAX_BODY_INSPECTION_BYTES) {
        body_truncated = true;
        json_body = null;
      } else {
        try {
          json_body = JSON.parse(responseBody);
        } catch (_e) {
          json_parse_error = true;
        }
      }
      responseBody = responseBody.slice(0, MAX_BODY_INSPECTION_BYTES);
    }

    return {
      success: true,
      observation: {
        status_code: response.status,
        response_time,
        headers: lowerHeaders,
        body: responseBody,
        json_body,
        json_parse_error,
        body_truncated,
        body_bytes,
      },
    };
  } catch (err) {
    const response_time = Date.now() - start;
    const error_type = classifyExecutionError(err);
    const safeMsg = sanitizeErrorMessage(err.message);

    logger.debug({ url, method, error_type, err: safeMsg }, 'Executor encountered request error');

    return {
      success: false,
      error: {
        error_type,
        message: safeMsg,
        response_time,
      },
    };
  }
}

module.exports = {
  executeRequest,
  classifyExecutionError,
  redactHeaders,
  sanitizeErrorMessage,
};
