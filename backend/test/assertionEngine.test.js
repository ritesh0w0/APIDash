// backend/test/assertionEngine.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AssertionValidationError,
  validateAssertionConfig,
  getDefaultAssertions,
  evaluateAssertions,
  safelyGetProperty,
} = require('../services/assertionEngine');

test('Assertion Engine — Default status behavior', () => {
  // When no assertions and no expected_status, defaults to 2xx
  const defaultAst = getDefaultAssertions({});
  assert.equal(defaultAst.length, 1);
  assert.equal(defaultAst[0].type, 'status');
  assert.equal(defaultAst[0].operator, '2xx');

  // When monitor has expected_status: 201
  const customStatusAst = getDefaultAssertions({ expected_status: 201 });
  assert.equal(customStatusAst.length, 1);
  assert.equal(customStatusAst[0].type, 'status');
  assert.equal(customStatusAst[0].expected, 201);

  // When monitor has explicit assertions, uses them
  const explicit = getDefaultAssertions({
    assertions: [{ type: 'status', expected: 204 }],
  });
  assert.equal(explicit.length, 1);
  assert.equal(explicit[0].expected, 204);
});

test('Assertion Engine — HTTP status assertion (2xx and explicit)', () => {
  // 2xx passes for 200, 201, 204
  const ast2xx = [{ type: 'status', operator: '2xx' }];
  assert.equal(evaluateAssertions(ast2xx, { status_code: 200, response_time: 50 }).passed, true);
  assert.equal(evaluateAssertions(ast2xx, { status_code: 204, response_time: 50 }).passed, true);
  assert.equal(evaluateAssertions(ast2xx, { status_code: 404, response_time: 50 }).passed, false);
  assert.equal(evaluateAssertions(ast2xx, { status_code: 500, response_time: 50 }).passed, false);

  // Explicit status
  const ast404 = [{ type: 'status', operator: 'equals', expected: 404 }];
  assert.equal(evaluateAssertions(ast404, { status_code: 404, response_time: 50 }).passed, true);
  assert.equal(evaluateAssertions(ast404, { status_code: 200, response_time: 50 }).passed, false);

  // No status received (null)
  const noStatusEval = evaluateAssertions(ast404, { status_code: null, response_time: 50 });
  assert.equal(noStatusEval.passed, false);
  assert.match(noStatusEval.results[0].message, /no response status/);
});

test('Assertion Engine — Latency assertion', () => {
  const ast = [{ type: 'latency', max_ms: 250 }];

  // Below limit -> pass
  const res1 = evaluateAssertions(ast, { status_code: 200, response_time: 120 });
  assert.equal(res1.passed, true);
  assert.equal(res1.results[0].passed, true);

  // Exactly at limit -> pass
  const res2 = evaluateAssertions(ast, { status_code: 200, response_time: 250 });
  assert.equal(res2.passed, true);

  // Above limit -> fail
  const res3 = evaluateAssertions(ast, { status_code: 200, response_time: 251 });
  assert.equal(res3.passed, false);
  assert.match(res3.results[0].message, /exceeded maximum limit/);
});

test('Assertion Engine — Header assertion (exists, equals, contains, case-insensitivity)', () => {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Request-Id': 'req-12345',
    'Cache-Control': 'no-cache',
  };

  // Exists (case-insensitive)
  const astExists = [{ type: 'header', name: 'x-request-id', operator: 'exists' }];
  assert.equal(evaluateAssertions(astExists, { headers, response_time: 50 }).passed, true);

  const astMissing = [{ type: 'header', name: 'authorization', operator: 'exists' }];
  assert.equal(evaluateAssertions(astMissing, { headers, response_time: 50 }).passed, false);

  // Equals
  const astEquals = [{ type: 'header', name: 'cache-control', operator: 'equals', value: 'no-cache' }];
  assert.equal(evaluateAssertions(astEquals, { headers, response_time: 50 }).passed, true);

  // Contains
  const astContains = [{ type: 'header', name: 'content-type', operator: 'contains', value: 'application/json' }];
  assert.equal(evaluateAssertions(astContains, { headers, response_time: 50 }).passed, true);
});

test('Assertion Engine — JSON body assertion (nested paths, exists, equals)', () => {
  const jsonBody = {
    status: 'healthy',
    data: {
      version: '1.2.3',
      metrics: {
        active: true,
        count: 42,
      },
    },
  };

  // Property exists
  const astExists = [{ type: 'body_json', path: 'data.metrics.active', operator: 'exists' }];
  assert.equal(evaluateAssertions(astExists, { json_body: jsonBody, response_time: 50 }).passed, true);

  // Property equals string
  const astString = [{ type: 'body_json', path: 'status', operator: 'equals', value: 'healthy' }];
  assert.equal(evaluateAssertions(astString, { json_body: jsonBody, response_time: 50 }).passed, true);

  // Property equals number
  const astNum = [{ type: 'body_json', path: 'data.metrics.count', operator: 'equals', value: 42 }];
  assert.equal(evaluateAssertions(astNum, { json_body: jsonBody, response_time: 50 }).passed, true);

  // Non-existent property
  const astNonExistent = [{ type: 'body_json', path: 'data.missing_prop', operator: 'exists' }];
  assert.equal(evaluateAssertions(astNonExistent, { json_body: jsonBody, response_time: 50 }).passed, false);

  // Value mismatch
  const astMismatch = [{ type: 'body_json', path: 'status', operator: 'equals', value: 'degraded' }];
  assert.equal(evaluateAssertions(astMismatch, { json_body: jsonBody, response_time: 50 }).passed, false);

  // Malformed JSON observation handling
  const astOnMalformed = [{ type: 'body_json', path: 'status', operator: 'exists' }];
  const malformedRes = evaluateAssertions(astOnMalformed, { json_parse_error: true, response_time: 50 });
  assert.equal(malformedRes.passed, false);
  assert.match(malformedRes.results[0].message, /not valid JSON/);
});

test('Assertion Engine — Security: Prototype pollution paths are rejected strictly', () => {
  assert.throws(
    () => validateAssertionConfig([{ type: 'body_json', path: '__proto__.isAdmin', operator: 'exists' }]),
    AssertionValidationError
  );
  assert.throws(
    () => validateAssertionConfig([{ type: 'body_json', path: 'data.constructor.prototype', operator: 'exists' }]),
    AssertionValidationError
  );
  assert.throws(
    () => validateAssertionConfig([{ type: 'body_json', path: 'data..empty', operator: 'exists' }]),
    AssertionValidationError
  );
});

test('Assertion Engine — Validation rejects invalid types, values, and bounds', () => {
  // Invalid type
  assert.throws(() => validateAssertionConfig([{ type: 'invalid_type' }]), AssertionValidationError);

  // Invalid status code
  assert.throws(() => validateAssertionConfig([{ type: 'status', expected: 99 }]), AssertionValidationError);
  assert.throws(() => validateAssertionConfig([{ type: 'status', expected: 600 }]), AssertionValidationError);

  // Negative latency limit
  assert.throws(() => validateAssertionConfig([{ type: 'latency', max_ms: -50 }]), AssertionValidationError);

  // Header missing name
  assert.throws(() => validateAssertionConfig([{ type: 'header', name: '' }]), AssertionValidationError);

  // Too many assertions (> 20)
  const tooMany = Array.from({ length: 21 }, () => ({ type: 'status', expected: 200 }));
  assert.throws(() => validateAssertionConfig(tooMany), AssertionValidationError);
});

test('Assertion Engine — Multi-assertion aggregation', () => {
  const assertions = [
    { type: 'status', operator: 'equals', expected: 200 },
    { type: 'latency', max_ms: 150 },
    { type: 'header', name: 'content-type', operator: 'contains', value: 'json' },
    { type: 'body_json', path: 'status', operator: 'equals', value: 'ok' },
  ];

  // All pass
  const observationAllGood = {
    status_code: 200,
    response_time: 95,
    headers: { 'content-type': 'application/json' },
    json_body: { status: 'ok' },
  };
  const eval1 = evaluateAssertions(assertions, observationAllGood);
  assert.equal(eval1.passed, true);
  assert.equal(eval1.passedCount, 4);
  assert.equal(eval1.failedCount, 0);

  // 1 assertion fails (latency too high) -> entire run fails
  const observationSlow = {
    ...observationAllGood,
    response_time: 180,
  };
  const eval2 = evaluateAssertions(assertions, observationSlow);
  assert.equal(eval2.passed, false);
  assert.equal(eval2.passedCount, 3);
  assert.equal(eval2.failedCount, 1);
});

test('Assertion Engine — Status, latency, and header assertions evaluate safely when body exceeds 64 KB', () => {
  const assertions = [
    { type: 'status', operator: 'equals', expected: 200 },
    { type: 'latency', max_ms: 500 },
    { type: 'header', name: 'content-type', operator: 'contains', value: 'json' },
  ];

  const observationLarge = {
    status_code: 200,
    response_time: 120,
    headers: { 'content-type': 'application/json' },
    body_truncated: true,
    body_bytes: 85000,
    json_body: null,
  };

  const evalResult = evaluateAssertions(assertions, observationLarge);
  assert.equal(evalResult.passed, true);
  assert.equal(evalResult.passedCount, 3);
  assert.equal(evalResult.failedCount, 0);
});

test('Assertion Engine — JSON body assertions fail with clear Inspection Limit Exceeded reason when body exceeds 64 KB', () => {
  const assertions = [
    { type: 'status', operator: 'equals', expected: 200 },
    { type: 'body_json', path: 'data.items', operator: 'exists' },
  ];

  const observationLarge = {
    status_code: 200,
    response_time: 120,
    body_truncated: true,
    body_bytes: 90000,
    json_body: null,
  };

  const evalResult = evaluateAssertions(assertions, observationLarge);
  assert.equal(evalResult.passed, false);
  assert.equal(evalResult.passedCount, 1);
  assert.equal(evalResult.failedCount, 1);
  const jsonAstResult = evalResult.results.find((r) => r.type === 'body_json');
  assert.equal(jsonAstResult.actual, 'Inspection Limit Exceeded');
  assert.match(jsonAstResult.message, /safe inspection limit \(64 KB\)/);
});

test('Assertion Engine — Explicit precedence: explicit assertions > legacy expected_status > default 2xx', () => {
  // Case 1: New monitor with no assertions and no expected_status -> defaults to 2xx
  const defaultAst = getDefaultAssertions({});
  assert.equal(defaultAst.length, 1);
  assert.equal(defaultAst[0].type, 'status');
  assert.equal(defaultAst[0].operator, '2xx');

  // Case 2: Monitor with explicit 2xx assertion
  const explicit2xx = getDefaultAssertions({ assertions: [{ type: 'status', operator: '2xx' }] });
  assert.equal(explicit2xx.length, 1);
  assert.equal(explicit2xx[0].operator, '2xx');

  // Case 3: Monitor with explicit exact-status assertion (e.g. 201) overrides expected_status (e.g. 200)
  const explicitExact = getDefaultAssertions({
    expected_status: 200,
    assertions: [{ type: 'status', operator: 'equals', expected: 201 }],
  });
  assert.equal(explicitExact.length, 1);
  assert.equal(explicitExact[0].expected, 201);

  // Case 4: Legacy monitor relying on expected_status (no assertions)
  const legacyMonitor = getDefaultAssertions({ expected_status: 404 });
  assert.equal(legacyMonitor.length, 1);
  assert.equal(legacyMonitor[0].type, 'status');
  assert.equal(legacyMonitor[0].operator, 'equals');
  assert.equal(legacyMonitor[0].expected, 404);

  // Case 5: Monitor with malformed persisted assertion configuration falls back to expected_status
  const malformedWithStatus = getDefaultAssertions({
    expected_status: 202,
    assertions: 'INVALID_JSON{[[',
  });
  assert.equal(malformedWithStatus.length, 1);
  assert.equal(malformedWithStatus[0].expected, 202);

  // Case 6: Monitor with invalid assertion structure in array falls back safely to default 2xx
  const invalidArrayItems = getDefaultAssertions({
    assertions: [{ type: 'unknown_type' }],
  });
  assert.equal(invalidArrayItems.length, 1);
  assert.equal(invalidArrayItems[0].operator, '2xx');
});

