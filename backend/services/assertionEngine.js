// backend/services/assertionEngine.js
'use strict';

const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

class AssertionValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'AssertionValidationError';
    this.details = details;
  }
}

/**
 * Validates a single path string for safe JSON traversal.
 * Rejects prototype pollution attack vectors and malformed segments.
 *
 * @param {string} path
 * @returns {string[]} segments
 */
function parseAndValidatePropertyPath(path) {
  if (typeof path !== 'string' || !path.trim()) {
    throw new AssertionValidationError('JSON body property path must be a non-empty string');
  }

  const trimmed = path.trim();
  const segments = trimmed.split('.');

  for (const seg of segments) {
    if (!seg) {
      throw new AssertionValidationError(`Invalid property path "${trimmed}": empty path segment detected`);
    }
    if (FORBIDDEN_PATH_SEGMENTS.has(seg)) {
      throw new AssertionValidationError(`Forbidden property path segment: "${seg}". Path traversal rejected for security`);
    }
  }

  return segments;
}

/**
 * Safely traverses an object along property segments without risking prototype pollution.
 *
 * @param {any} root
 * @param {string[]} segments
 * @returns {{ found: boolean, value: any }}
 */
function safelyGetProperty(root, segments) {
  if (root === null || typeof root !== 'object') {
    return { found: false, value: undefined };
  }

  let current = root;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (current === null || typeof current !== 'object') {
      return { found: false, value: undefined };
    }

    // Guard against prototype pollution and prototype properties
    if (FORBIDDEN_PATH_SEGMENTS.has(seg) || !Object.prototype.hasOwnProperty.call(current, seg)) {
      return { found: false, value: undefined };
    }

    current = current[seg];
  }

  return { found: true, value: current };
}

/**
 * Deep equality helper for JSON-serializable values.
 */
function areJsonValuesEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!areJsonValuesEqual(a[key], b[key])) return false;
  }

  return true;
}

/**
 * Validates assertion configurations.
 *
 * @param {any} assertions
 * @returns {Array<Object>} validated assertions
 */
function validateAssertionConfig(assertions) {
  if (assertions === null || assertions === undefined) {
    return [];
  }

  let list = assertions;
  if (typeof assertions === 'string') {
    try {
      list = JSON.parse(assertions);
    } catch (_e) {
      throw new AssertionValidationError('Assertion configuration must be a valid JSON array');
    }
  }

  if (!Array.isArray(list)) {
    throw new AssertionValidationError('Assertion configuration must be an array');
  }

  if (list.length > 20) {
    throw new AssertionValidationError('Maximum of 20 assertions permitted per monitor');
  }

  const validated = [];

  for (let idx = 0; idx < list.length; idx++) {
    const item = list[idx];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AssertionValidationError(`Assertion at index ${idx} must be an object`);
    }

    const { type } = item;
    if (!['status', 'latency', 'header', 'body_json'].includes(type)) {
      throw new AssertionValidationError(
        `Assertion at index ${idx} has invalid type "${type}". Allowed: status, latency, header, body_json`
      );
    }

    if (type === 'status') {
      const rawExpected = item.expected !== undefined ? item.expected : (item.equals !== undefined ? item.equals : item.status);
      const operator = item.operator || (rawExpected === '2xx' ? '2xx' : 'equals');
      if (!['equals', '2xx'].includes(operator)) {
        throw new AssertionValidationError(`Status assertion at index ${idx}: operator must be "equals" or "2xx"`);
      }
      if (operator === 'equals') {
        const expected = Number(rawExpected);
        if (!Number.isInteger(expected) || expected < 100 || expected > 599) {
          throw new AssertionValidationError(`Status assertion at index ${idx}: expected status must be between 100 and 599`);
        }
        validated.push({ type: 'status', operator: 'equals', expected });
      } else {
        validated.push({ type: 'status', operator: '2xx', expected: '2xx' });
      }
    } else if (type === 'latency') {
      const maxMs = Number(item.max_ms !== undefined ? item.max_ms : item.expected);
      if (!Number.isInteger(maxMs) || maxMs < 1 || maxMs > 60000) {
        throw new AssertionValidationError(`Latency assertion at index ${idx}: max_ms must be an integer between 1 and 60000`);
      }
      validated.push({ type: 'latency', max_ms: maxMs, expected: maxMs });
    } else if (type === 'header') {
      const headerName = item.name || item.header;
      if (!headerName || typeof headerName !== 'string' || !headerName.trim()) {
        throw new AssertionValidationError(`Header assertion at index ${idx}: header name is required and must be a string`);
      }
      const operator = item.operator || (item.contains !== undefined ? 'contains' : (item.equals !== undefined ? 'equals' : 'exists'));
      if (!['exists', 'equals', 'contains'].includes(operator)) {
        throw new AssertionValidationError(
          `Header assertion at index ${idx}: operator must be "exists", "equals", or "contains"`
        );
      }
      const val = item.value !== undefined ? item.value : (item.contains !== undefined ? item.contains : item.equals);
      if (operator !== 'exists' && (val === undefined || val === null || typeof val !== 'string')) {
        throw new AssertionValidationError(`Header assertion at index ${idx}: value must be a string for operator "${operator}"`);
      }
      validated.push({
        type: 'header',
        name: headerName.trim().toLowerCase(),
        operator,
        value: operator !== 'exists' ? String(val).trim() : null,
      });
    } else if (type === 'body_json') {
      const segments = parseAndValidatePropertyPath(item.path);
      const operator = item.operator || (item.equals !== undefined ? 'equals' : 'exists');
      if (!['exists', 'equals'].includes(operator)) {
        throw new AssertionValidationError(`JSON body assertion at index ${idx}: operator must be "exists" or "equals"`);
      }
      const val = item.value !== undefined ? item.value : item.equals;
      if (operator === 'equals' && val === undefined) {
        throw new AssertionValidationError(`JSON body assertion at index ${idx}: value must be provided for operator "equals"`);
      }
      validated.push({
        type: 'body_json',
        path: segments.join('.'),
        segments,
        operator,
        value: operator === 'equals' ? val : undefined,
      });
    }
  }

  return validated;
}

/**
 * Returns the effective assertion list for a monitor, falling back to default 2xx or expected_status.
 *
 * @param {Object} monitor
 * @returns {Array<Object>}
 */
function getDefaultAssertions(monitor = {}) {
  let list = monitor.assertions;
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch (_e) {
      list = [];
    }
  }

  if (Array.isArray(list) && list.length > 0) {
    try {
      return validateAssertionConfig(list);
    } catch (_e) {
      // Malformed persisted assertion configuration fallback
    }
  }

  // Fallback default: explicit expected_status if present, otherwise 2xx
  if (monitor.expected_status !== undefined && monitor.expected_status !== null) {
    const statusNum = Number(monitor.expected_status);
    if (Number.isInteger(statusNum) && statusNum >= 100 && statusNum <= 599) {
      return [{ type: 'status', operator: 'equals', expected: statusNum }];
    }
  }

  return [{ type: 'status', operator: '2xx', expected: '2xx' }];
}

/**
 * Evaluates configured assertions against an observation.
 *
 * @param {Array<Object>} assertions
 * @param {Object} observation
 * @param {number|null} observation.status_code
 * @param {number} observation.response_time
 * @param {Object} [observation.headers={}]
 * @param {string|null} [observation.body=null]
 * @param {any} [observation.json_body=null]
 * @param {boolean} [observation.json_parse_error=false]
 * @returns {{ passed: boolean, results: Array<Object>, passedCount: number, failedCount: number }}
 */
function evaluateAssertions(assertions, observation = {}) {
  const normAssertions = validateAssertionConfig(assertions);
  const results = [];

  const headers = observation.headers || {};
  const lowerHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    lowerHeaders[k.toLowerCase()] = v;
  }

  for (const ast of normAssertions) {
    if (ast.type === 'status') {
      const statusCode = observation.status_code;
      if (statusCode === null || statusCode === undefined) {
        results.push({
          type: 'status',
          passed: false,
          expected: ast.expected,
          actual: null,
          message: `Expected HTTP status ${ast.expected}, but no response status was received`,
        });
        continue;
      }

      if (ast.operator === '2xx') {
        const passed = statusCode >= 200 && statusCode <= 299;
        results.push({
          type: 'status',
          passed,
          expected: '2xx (200-299)',
          actual: statusCode,
          message: passed
            ? `Status code ${statusCode} is within expected 2xx range`
            : `Expected HTTP status 2xx, got ${statusCode}`,
        });
      } else {
        const passed = statusCode === ast.expected;
        results.push({
          type: 'status',
          passed,
          expected: ast.expected,
          actual: statusCode,
          message: passed
            ? `Status code ${statusCode} matched expected status`
            : `Expected HTTP status ${ast.expected}, got ${statusCode}`,
        });
      }
    } else if (ast.type === 'latency') {
      const responseTime = observation.response_time;
      const passed = typeof responseTime === 'number' && responseTime <= ast.max_ms;
      results.push({
        type: 'latency',
        passed,
        expected: `<= ${ast.max_ms} ms`,
        actual: responseTime != null ? `${responseTime} ms` : 'N/A',
        message: passed
          ? `Response time of ${responseTime} ms is within limit of ${ast.max_ms} ms`
          : `Response time of ${responseTime} ms exceeded maximum limit of ${ast.max_ms} ms`,
      });
    } else if (ast.type === 'header') {
      const headerName = ast.name.toLowerCase();
      const actualVal = lowerHeaders[headerName];

      if (ast.operator === 'exists') {
        const passed = actualVal !== undefined && actualVal !== null;
        results.push({
          type: 'header',
          name: headerName,
          passed,
          expected: `Header "${headerName}" exists`,
          actual: passed ? 'present' : 'missing',
          message: passed
            ? `Header "${headerName}" is present in response`
            : `Expected response header "${headerName}" to exist, but it was not present`,
        });
      } else if (ast.operator === 'equals') {
        const strVal = actualVal != null ? String(actualVal).trim() : null;
        const passed = strVal === ast.value;
        results.push({
          type: 'header',
          name: headerName,
          passed,
          expected: `"${ast.value}"`,
          actual: strVal != null ? `"${strVal}"` : null,
          message: passed
            ? `Header "${headerName}" equals "${ast.value}"`
            : `Header "${headerName}" expected "${ast.value}", got "${strVal ?? 'missing'}"`,
        });
      } else if (ast.operator === 'contains') {
        const strVal = actualVal != null ? String(actualVal) : null;
        const passed = strVal != null && strVal.toLowerCase().includes(ast.value.toLowerCase());
        results.push({
          type: 'header',
          name: headerName,
          passed,
          expected: `Contains "${ast.value}"`,
          actual: strVal != null ? `"${strVal}"` : null,
          message: passed
            ? `Header "${headerName}" contains "${ast.value}"`
            : `Header "${headerName}" did not contain "${ast.value}" (actual: "${strVal ?? 'missing'}")`,
        });
      }
    } else if (ast.type === 'body_json') {
      const segments = ast.segments || parseAndValidatePropertyPath(ast.path);

      if (observation.body_truncated) {
        results.push({
          type: 'body_json',
          path: ast.path,
          passed: false,
          expected: ast.operator === 'exists' ? `Property "${ast.path}" exists` : `"${ast.path}" == ${JSON.stringify(ast.value)}`,
          actual: 'Inspection Limit Exceeded',
          message: `Cannot evaluate JSON assertion on "${ast.path}": response body exceeds safe inspection limit (64 KB)`,
        });
        continue;
      }

      if (observation.json_parse_error || observation.json_body === null || typeof observation.json_body !== 'object') {
        results.push({
          type: 'body_json',
          path: ast.path,
          passed: false,
          expected: ast.operator === 'exists' ? `Property "${ast.path}" exists` : `"${ast.path}" == ${JSON.stringify(ast.value)}`,
          actual: 'Malformed JSON',
          message: `Cannot evaluate JSON assertion on "${ast.path}": response body is not valid JSON`,
        });
        continue;
      }

      const { found, value } = safelyGetProperty(observation.json_body, segments);

      if (ast.operator === 'exists') {
        results.push({
          type: 'body_json',
          path: ast.path,
          passed: found,
          expected: `Property "${ast.path}" exists`,
          actual: found ? 'present' : 'missing',
          message: found
            ? `JSON property "${ast.path}" exists`
            : `Expected JSON property "${ast.path}" to exist, but it was not found`,
        });
      } else if (ast.operator === 'equals') {
        const passed = found && areJsonValuesEqual(value, ast.value);
        results.push({
          type: 'body_json',
          path: ast.path,
          passed,
          expected: ast.value,
          actual: found ? value : undefined,
          message: passed
            ? `JSON property "${ast.path}" matched expected value`
            : found
            ? `JSON property "${ast.path}" expected ${JSON.stringify(ast.value)}, got ${JSON.stringify(value)}`
            : `JSON property "${ast.path}" was not found in response`,
        });
      }
    }
  }

  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.length - passedCount;

  return {
    passed: results.length > 0 && failedCount === 0,
    results,
    passedCount,
    failedCount,
  };
}

module.exports = {
  AssertionValidationError,
  parseAndValidatePropertyPath,
  validateAssertionConfig,
  getDefaultAssertions,
  evaluateAssertions,
  safelyGetProperty,
  areJsonValuesEqual,
};
