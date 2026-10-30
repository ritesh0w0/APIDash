// backend/test/incidentEvidenceBuilder.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeUrl,
  categorizeError,
  canonicalStringify,
  IncidentEvidenceBuilder,
} = require('../services/incidentEvidenceBuilder');

test('Evidence Builder — sanitizeUrl strips credentials and redacts sensitive query parameters', () => {
  // 1. Credentials in URL
  const credUrl = 'https://admin:superSecret123@api.internal.net/v1/data';
  const sanitizedCred = sanitizeUrl(credUrl);
  assert.ok(!sanitizedCred.includes('superSecret123'));
  assert.ok(!sanitizedCred.includes('admin:'));
  assert.ok(sanitizedCred.includes('***:***@'));

  // 2. Sensitive query parameters
  const queryUrl = 'https://api.example.com/pay?token=xyz987&key=secretApiKey&user=john&apiKey=pk_live_123';
  const sanitizedQuery = sanitizeUrl(queryUrl);
  assert.ok(!sanitizedQuery.includes('xyz987'));
  assert.ok(!sanitizedQuery.includes('secretApiKey'));
  assert.ok(!sanitizedQuery.includes('pk_live_123'));
  assert.ok(sanitizedQuery.includes('token=***REDACTED***'));
  assert.ok(sanitizedQuery.includes('key=***REDACTED***'));
  assert.ok(sanitizedQuery.includes('user=john')); // non-sensitive query param preserved
});

test('Evidence Builder — categorizeError classifies transport, status, and contract errors', () => {
  // DNS failure
  const dns = categorizeError('getaddrinfo ENOTFOUND api.broken.org', null, null);
  assert.equal(dns.category, 'DNS_RESOLUTION_FAILURE');

  // Connection refused
  const conn = categorizeError('connect ECONNREFUSED 127.0.0.1:80', null, null);
  assert.equal(conn.category, 'CONNECTION_REFUSED');

  // Timeout
  const timeout = categorizeError('Client timeout after 10000ms', null, null);
  assert.equal(timeout.category, 'TIMEOUT_EXCEEDED');

  // TLS Certificate
  const tls = categorizeError('certificate has expired: CERT_HAS_EXPIRED', null, null);
  assert.equal(tls.category, 'TLS_CERTIFICATE_ERROR');

  // HTTP status
  const s500 = categorizeError('Internal Server Error', null, 500);
  assert.equal(s500.category, 'HTTP_SERVER_ERROR_500');

  const s404 = categorizeError('Not Found', null, 404);
  assert.equal(s404.category, 'HTTP_CLIENT_ERROR_404');

  // Contract preflight
  const preflight = categorizeError('Preflight rejected', 'CONTRACT_REQUEST_INVALID', null);
  assert.equal(preflight.category, 'CONTRACT_PREFLIGHT_REJECTED');

  // Bearer tokens in error messages are stripped
  const bearer = categorizeError('Failed to auth with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz', null, 401);
  assert.ok(!bearer.bounded_message.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
  assert.ok(bearer.bounded_message.includes('Bearer ***'));
});

test('Evidence Builder — canonicalStringify produces sorted, deterministic JSON for fingerprinting', () => {
  const objA = { b: 2, a: 1, c: { z: 26, y: 25 } };
  const objB = { c: { y: 25, z: 26 }, a: 1, b: 2 };

  const strA = canonicalStringify(objA);
  const strB = canonicalStringify(objB);

  assert.equal(strA, strB);
  assert.equal(strA, '{"a":1,"b":2,"c":{"y":25,"z":26}}');
});

test('Evidence Builder — buildEvidenceSnapshot constructs bounded evidence package with stable IDs', async () => {
  // Mock repository and pool
  const mockIncidentRepo = {
    async findById(id, wsId) {
      if (id !== 101 || wsId !== 1) return null;
      return {
        id: 101,
        api_id: 12,
        workspace_id: 1,
        status: 'open',
        opened_at: '2026-10-29T10:00:00Z',
        unhealthy_count: 3,
        error_summary: 'HTTP 500 Internal Server Error',
        latest_result_id: 205,
      };
    },
  };

  const mockPool = {
    async execute(query, params) {
      if (query.includes('FROM apis')) {
        return [[{ id: 12, workspace_id: 1, name: 'Payment API', url: 'https://api.test.com/pay?key=secret', method: 'POST', expected_status: 200 }]];
      }
      if (query.includes('FROM test_results')) {
        return [[
          { id: 205, api_id: 12, status_code: 500, response_time: 120, result: 'FAIL', error_message: 'HTTP 500 Server Error', tested_at: '2026-10-29T10:10:00Z', contract_verdict: null },
          { id: 204, api_id: 12, status_code: 500, response_time: 110, result: 'FAIL', error_message: 'HTTP 500 Server Error', tested_at: '2026-10-29T10:05:00Z', contract_verdict: null },
          { id: 203, api_id: 12, status_code: 200, response_time: 45, result: 'PASS', error_message: null, tested_at: '2026-10-29T09:55:00Z', contract_verdict: 'passed' },
        ]];
      }
      return [[]];
    },
  };

  const builder = new IncidentEvidenceBuilder({ incidentRepo: mockIncidentRepo, pool: mockPool });
  const result = await builder.buildEvidenceSnapshot(101, 1);

  assert.ok(result.evidenceSnapshot);
  assert.ok(result.evidenceFingerprint);
  assert.equal(typeof result.evidenceFingerprint, 'string');
  assert.equal(result.evidenceFingerprint.length, 64);

  const obs = result.evidenceSnapshot.observations;
  assert.ok(obs.length >= 3);
  assert.equal(obs[0].id, 'E-001');
  assert.equal(obs[1].id, 'E-002');
  assert.equal(obs[0].type, 'INCIDENT_LIFECYCLE');
  assert.equal(obs[1].type, 'MONITOR_CONFIGURATION');

  // Verify URL was sanitized in E-002
  assert.ok(!obs[1].url_sanitized.includes('key=secret'));
  assert.ok(obs[1].url_sanitized.includes('key=***REDACTED***'));

  // Verify baseline was computed from passing run
  const baselineObs = obs.find((o) => o.type === 'PERFORMANCE_BASELINE');
  assert.ok(baselineObs);
  assert.equal(baselineObs.sample_count, 1);
  assert.equal(baselineObs.avg_latency_ms, 45);
});

