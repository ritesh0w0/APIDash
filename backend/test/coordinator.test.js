// backend/test/coordinator.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeMonitoringRun } = require('../services/monitoringCoordinator');

test('Coordinator — Successful run produces canonical "passed" outcome and persists result', async () => {
  let savedRecord = null;
  const mockResultRepo = {
    create: async (data) => {
      savedRecord = { id: 99, ...data };
      return savedRecord;
    },
  };

  const mockExecutor = async () => ({
    success: true,
    observation: {
      status_code: 200,
      response_time: 85,
      headers: { 'content-type': 'application/json' },
      json_body: { status: 'healthy' },
      json_parse_error: false,
    },
  });

  const monitor = {
    id: 1,
    name: 'Health Service',
    url: 'https://service.example.com/health',
    method: 'GET',
    assertions: [
      { type: 'status', operator: 'equals', expected: 200 },
      { type: 'latency', max_ms: 200 },
      { type: 'body_json', path: 'status', operator: 'equals', value: 'healthy' },
    ],
  };

  const result = await executeMonitoringRun(monitor, {
    resultRepo: mockResultRepo,
    executorFn: mockExecutor,
  });

  assert.equal(result.outcome, 'passed');
  assert.equal(result.result, 'passed');
  assert.equal(result.status_code, 200);
  assert.equal(result.assertions.length, 3);
  assert.equal(result.assertions.every((a) => a.passed), true);
  assert.equal(savedRecord.result, 'passed');
  assert.equal(savedRecord.status_code, 200);
});

test('Coordinator — Assertion failure produces canonical "failed" outcome (unhealthy)', async () => {
  let savedRecord = null;
  const mockResultRepo = {
    create: async (data) => {
      savedRecord = { id: 100, ...data };
      return savedRecord;
    },
  };

  const mockExecutor = async () => ({
    success: true,
    observation: {
      status_code: 503,
      response_time: 40,
      headers: { 'content-type': 'application/json' },
      json_body: { status: 'down' },
      json_parse_error: false,
    },
  });

  const monitor = {
    id: 2,
    name: 'Flaky Service',
    url: 'https://service.example.com/health',
    method: 'GET',
    assertions: [{ type: 'status', operator: 'equals', expected: 200 }],
  };

  const result = await executeMonitoringRun(monitor, {
    resultRepo: mockResultRepo,
    executorFn: mockExecutor,
  });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.result, 'failed');
  assert.equal(result.status_code, 503);
  assert.match(result.error_message, /503/);
  assert.equal(savedRecord.result, 'failed');
  assert.equal(savedRecord.status_code, 503);
  assert.equal(savedRecord.error_type, 'ASSERTION_FAILED');
});

test('Coordinator — Transport failure produces canonical "error" outcome and persists diagnostics', async () => {
  let savedRecord = null;
  const mockResultRepo = {
    create: async (data) => {
      savedRecord = { id: 101, ...data };
      return savedRecord;
    },
  };

  const mockExecutor = async () => ({
    success: false,
    error: {
      error_type: 'TIMEOUT',
      message: 'Connection timed out after 5000ms',
      response_time: 5000,
    },
  });

  const monitor = {
    id: 3,
    name: 'Dead Service',
    url: 'https://service.example.com/health',
    method: 'GET',
    assertions: [{ type: 'status', operator: 'equals', expected: 200 }],
  };

  const result = await executeMonitoringRun(monitor, {
    resultRepo: mockResultRepo,
    executorFn: mockExecutor,
  });

  assert.equal(result.outcome, 'error');
  assert.equal(result.result, 'error');
  assert.equal(result.status_code, null);
  assert.equal(result.error_type, 'TIMEOUT');
  assert.match(result.error_message, /timed out/);
  assert.equal(savedRecord.result, 'error');
  assert.equal(savedRecord.status_code, null);
  assert.equal(savedRecord.error_type, 'TIMEOUT');
});

test('Coordinator — Database persistence failure is surfaced honestly without claiming saved result', async () => {
  const mockResultRepo = {
    create: async () => {
      throw new Error('MySQL connection pool closed unexpectedly');
    },
  };

  const mockExecutor = async () => ({
    success: true,
    observation: { status_code: 200, response_time: 50 },
  });

  const monitor = {
    id: 4,
    name: 'DB Fail Test',
    url: 'https://service.example.com',
  };

  await assert.rejects(
    async () => {
      await executeMonitoringRun(monitor, {
        resultRepo: mockResultRepo,
        executorFn: mockExecutor,
      });
    },
    /MySQL connection pool closed/
  );
});

test('Coordinator — Stored assertions snapshot is evaluated at execution time and prevents historical drift', async () => {
  const mockResultRepo = { create: async (d) => d };
  const mockExecutor = async () => ({
    success: true,
    observation: { status_code: 204, response_time: 30 },
  });

  // Stored monitor with 204 expectation
  const monitorAtRunTime = {
    id: 5,
    name: 'Versioned Expectation',
    url: 'https://api.example.com',
    assertions: [{ type: 'status', operator: 'equals', expected: 204 }],
  };

  const runResult = await executeMonitoringRun(monitorAtRunTime, {
    resultRepo: mockResultRepo,
    executorFn: mockExecutor,
  });

  assert.equal(runResult.outcome, 'passed');
  assert.equal(runResult.assertions[0].expected, 204);
});
