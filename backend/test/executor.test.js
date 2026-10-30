// backend/test/executor.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  executeRequest,
  classifyExecutionError,
  redactHeaders,
  sanitizeErrorMessage,
} = require('../services/executor');

test('Executor — Successful request returns structured observation', async () => {
  const mockSafeClient = async (options) => {
    assert.equal(options.url, 'https://api.example.com/health');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers['x-custom'], 'hello');
    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Powered-By': 'Express',
      },
      data: { status: 'healthy', timestamp: 123456 },
    };
  };

  const monitor = {
    url: 'https://api.example.com/health',
    method: 'GET',
    headers: { 'x-custom': 'hello' },
    timeout_ms: 3000,
  };

  const result = await executeRequest(monitor, { safeClient: mockSafeClient });

  assert.equal(result.success, true);
  assert.equal(result.observation.status_code, 200);
  assert.equal(result.observation.headers['content-type'], 'application/json');
  assert.equal(result.observation.json_body.status, 'healthy');
  assert.equal(result.observation.json_parse_error, false);
  assert.ok(typeof result.observation.response_time === 'number');
});

test('Executor — Server enforces timeout ceiling (clamped to max 30000ms)', async () => {
  let capturedTimeout = null;
  const mockSafeClient = async (options) => {
    capturedTimeout = options.timeout;
    return { status: 200, data: 'OK' };
  };

  // User attempts to set 999,999 ms timeout -> clamped to 30000 ms
  await executeRequest(
    { url: 'https://api.example.com/health', timeout_ms: 999999 },
    { safeClient: mockSafeClient }
  );
  assert.equal(capturedTimeout, 30000);

  // User attempts to set 5 ms timeout -> clamped to min 100 ms
  await executeRequest(
    { url: 'https://api.example.com/health', timeout_ms: 5 },
    { safeClient: mockSafeClient }
  );
  assert.equal(capturedTimeout, 100);
});

test('Executor — Error classification for transport failures', () => {
  assert.equal(classifyExecutionError({ code: 'ECONNABORTED', message: 'timeout of 5000ms exceeded' }), 'TIMEOUT');
  assert.equal(classifyExecutionError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' }), 'DNS_FAILURE');
  assert.equal(classifyExecutionError({ code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' }), 'TLS_ERROR');
  assert.equal(classifyExecutionError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }), 'CONNECTION_REFUSED');
  assert.equal(classifyExecutionError({ code: 'ECONNRESET', message: 'read ECONNRESET' }), 'CONNECTION_RESET');
  assert.equal(classifyExecutionError({ message: 'maxContentLength size of 1048576 exceeded' }), 'RESPONSE_TOO_LARGE');
  assert.equal(classifyExecutionError({ isSsrfBlocked: true, message: 'SSRF blocked' }), 'SSRF_BLOCKED');
  assert.equal(classifyExecutionError({ message: 'Maximum redirect count reached' }), 'REDIRECT_ERROR');
});

test('Executor — Sanitization of sensitive error messages and headers', () => {
  const dirtyMsg = 'Failed with token: Bearer secret_token_xyz and api_key: key_12345!';
  const cleanMsg = sanitizeErrorMessage(dirtyMsg);
  assert.ok(!cleanMsg.includes('secret_token_xyz'));
  assert.ok(!cleanMsg.includes('key_12345'));
  assert.match(cleanMsg, /Bearer \[REDACTED\]/);

  const headers = {
    authorization: 'Bearer secret_jwt',
    'x-api-key': 'topsecret',
    cookie: 'session_id=abc',
    'content-type': 'application/json',
  };
  const sanitizedHeaders = redactHeaders(headers);
  assert.equal(sanitizedHeaders.authorization, '[REDACTED]');
  assert.equal(sanitizedHeaders['x-api-key'], '[REDACTED]');
  assert.equal(sanitizedHeaders.cookie, '[REDACTED]');
  assert.equal(sanitizedHeaders['content-type'], 'application/json');
});

test('Executor — Response body below 64 KB is parsed and fully inspectable', async () => {
  const smallJson = JSON.stringify({ message: 'hello world', count: 123 });
  const mockSafeClient = async () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    data: smallJson,
  });

  const res = await executeRequest({ url: 'https://api.example.com' }, { safeClient: mockSafeClient });
  assert.equal(res.success, true);
  assert.equal(res.observation.body_truncated, false);
  assert.equal(res.observation.json_parse_error, false);
  assert.equal(res.observation.json_body.message, 'hello world');
});

test('Executor — Valid JSON exceeding 64 KB limit but below 1 MB sets body_truncated and nulls json_body', async () => {
  const largeObj = { data: 'a'.repeat(100 * 1024) };
  const largeJson = JSON.stringify(largeObj);
  const mockSafeClient = async () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    data: largeJson,
  });

  const res = await executeRequest({ url: 'https://api.example.com' }, { safeClient: mockSafeClient });
  assert.equal(res.success, true);
  assert.equal(res.observation.body_truncated, true);
  assert.equal(res.observation.json_body, null);
  assert.equal(res.observation.status_code, 200);
});

test('Executor — Invalid or incomplete JSON sets json_parse_error and leaves json_body null', async () => {
  const brokenJson = '{"status": "ok", "truncated":';
  const mockSafeClient = async () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    data: brokenJson,
  });

  const res = await executeRequest({ url: 'https://api.example.com' }, { safeClient: mockSafeClient });
  assert.equal(res.success, true);
  assert.equal(res.observation.json_parse_error, true);
  assert.equal(res.observation.json_body, null);
});

test('Executor — Response exceeding 1 MB hard limit triggers RESPONSE_TOO_LARGE', async () => {
  const mockSafeClient = async () => {
    const err = new Error('maxContentLength size of 1048576 exceeded');
    err.code = 'ERR_BAD_RESPONSE';
    throw err;
  };

  const res = await executeRequest({ url: 'https://api.example.com' }, { safeClient: mockSafeClient });
  assert.equal(res.success, false);
  assert.equal(res.error.error_type, 'RESPONSE_TOO_LARGE');
  assert.match(res.error.message, /1048576/);
});

