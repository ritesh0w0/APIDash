// backend/test/services.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { testApi } = require('../services/tester');
const { calcHealthScore, getApiAnalytics } = require('../services/analytics');

test('testApi marks passed when status matches expected_status', async () => {
  let savedResult = null;
  const mockRepo = {
    create: async (data) => {
      savedResult = data;
      return { id: 1, ...data };
    },
  };

  const mockHttpClient = async () => ({
    status: 200,
    data: { ok: true },
  });

  const api = { id: 10, name: 'Auth API', url: 'https://auth.example.com', method: 'GET', expected_status: 200 };
  const result = await testApi(api, { resultRepo: mockRepo, httpClient: mockHttpClient });

  assert.equal(result.result, 'passed');
  assert.equal(result.outcome, 'passed');
  assert.equal(result.status_code, 200);
  assert.equal(result.error_message, null);
  assert.ok(typeof result.response_time === 'number');
  assert.equal(savedResult.result, 'passed');
});

test('testApi marks failed when status does not match expected_status', async () => {
  const mockRepo = { create: async (d) => d };
  const mockHttpClient = async () => ({ status: 500 });

  const api = { id: 11, name: 'User API', url: 'https://user.example.com', method: 'GET', expected_status: 200 };
  const result = await testApi(api, { resultRepo: mockRepo, httpClient: mockHttpClient });

  assert.equal(result.result, 'failed');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.status_code, 500);
  assert.match(result.error_message, /500/);
});

test('testApi catches network errors and marks error with status_code null', async () => {
  const mockRepo = { create: async (d) => d };
  const mockHttpClient = async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:9999');
  };

  const api = { id: 12, name: 'Dead API', url: 'http://127.0.0.1:9999', method: 'GET', expected_status: 200 };
  const result = await testApi(api, { resultRepo: mockRepo, httpClient: mockHttpClient });

  assert.equal(result.result, 'error');
  assert.equal(result.outcome, 'error');
  assert.equal(result.status_code, null);
  assert.equal(result.error_type, 'CONNECTION_REFUSED');
  assert.match(result.error_message, /ECONNREFUSED/i);
});

test('calcHealthScore calculates appropriate score deductions and clamps between 0-100', () => {
  // Perfect score
  assert.equal(calcHealthScore({ uptimePct: 100, p95: 120, failStreak: 0 }), 100);

  // Uptime reduction
  const halfUptime = calcHealthScore({ uptimePct: 50, p95: 200, failStreak: 0 });
  assert.equal(halfUptime, 75); // 100 - (1 - 0.50)*50 = 75

  // Latency deduction for p95 > 2000ms (-20)
  const slowP95 = calcHealthScore({ uptimePct: 100, p95: 2500, failStreak: 0 });
  assert.equal(slowP95, 80); // 100 - 20 = 80

  // Extreme failure streak and 0 uptime clamps to 0
  const deadApi = calcHealthScore({ uptimePct: 0, p95: 6000, failStreak: 10 });
  assert.equal(deadApi, 0);
});

test('getApiAnalytics computes uptime, percentiles, failure streak, and hourly aggregation', async () => {
  const now = new Date();
  const mockRows = [
    { status_code: 200, response_time: 100, result: 'PASS', error_message: null, tested_at: new Date(now - 3000) },
    { status_code: 200, response_time: 150, result: 'PASS', error_message: null, tested_at: new Date(now - 2000) },
    { status_code: 500, response_time: 400, result: 'FAIL', error_message: 'Server Error', tested_at: new Date(now - 1000) },
    { status_code: 500, response_time: 420, result: 'FAIL', error_message: 'Server Error', tested_at: now },
  ];

  const mockRepo = {
    findWithinHours: async () => mockRows,
  };

  const analytics = await getApiAnalytics(1, 24, { testResultRepo: mockRepo });

  assert.equal(analytics.total, 4);
  assert.equal(analytics.passed, 2);
  assert.equal(analytics.failed, 2);
  assert.equal(analytics.uptime_pct, 50);
  assert.equal(analytics.min_ms, 100);
  assert.equal(analytics.max_ms, 420);
  assert.equal(analytics.fail_streak, 2); // Two consecutive failures at the end
  assert.equal(analytics.top_errors.length, 1);
  assert.equal(analytics.top_errors[0].msg, 'Server Error');
  assert.equal(analytics.top_errors[0].count, 2);
});
