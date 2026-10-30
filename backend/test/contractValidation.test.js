// backend/test/contractValidation.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchOperationPath,
  validateRequestPreflight,
  validateResponseContract,
} = require('../services/contractValidatorService');

test('Contract Validator — Path template matching and base-path normalization', () => {
  // 1. Direct path matching
  const match1 = matchOperationPath('https://api.example.com/users/42', '/users/{id}');
  assert.ok(match1.matched);
  assert.equal(match1.params.id, '42');

  // 2. Base path with server prefix
  const match2 = matchOperationPath(
    'https://api.example.com/v1/orders/ORD-99/items/3',
    '/orders/{orderId}/items/{itemId}',
    [{ url: '/v1' }]
  );
  assert.ok(match2.matched);
  assert.equal(match2.params.orderId, 'ORD-99');
  assert.equal(match2.params.itemId, '3');

  // 3. Absolute server url prefix
  const match3 = matchOperationPath(
    'https://staging.api.com/v2/health',
    '/health',
    [{ url: 'https://staging.api.com/v2' }]
  );
  assert.ok(match3.matched);

  // 4. Mismatched path
  const match4 = matchOperationPath('https://api.example.com/other', '/users/{id}');
  assert.equal(match4.matched, false);
});

test('Contract Validator — Request Preflight: HTTP method and path parameter validation', () => {
  const binding = {
    operation_method: 'GET',
    operation_path: '/users/{userId}',
  };

  const revision = {
    id: 1,
    openapi_version: '3.0.3',
    content_sha256: 'abc123456789',
    dereferenced_spec: {
      openapi: '3.0.3',
      paths: {
        '/users/{userId}': {
          get: {
            parameters: [
              {
                name: 'userId',
                in: 'path',
                required: true,
                schema: { type: 'integer' },
              },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    },
  };

  // 1. Mismatched HTTP method rejects preflight
  const postMonitor = {
    method: 'POST',
    url: 'https://api.example.com/users/123',
  };
  const preflight1 = validateRequestPreflight(postMonitor, binding, revision);
  assert.equal(preflight1.valid, false);
  assert.equal(preflight1.verdict, 'preflight_rejected');
  assert.ok(preflight1.findings.some((f) => f.rule === 'method'));

  // 2. Mismatched path rejects preflight
  const wrongUrlMonitor = {
    method: 'GET',
    url: 'https://api.example.com/not-users',
  };
  const preflight2 = validateRequestPreflight(wrongUrlMonitor, binding, revision);
  assert.equal(preflight2.valid, false);
  assert.ok(preflight2.findings.some((f) => f.rule === 'path_match'));

  // 3. Invalid parameter type (string instead of integer) rejects preflight
  const stringParamMonitor = {
    method: 'GET',
    url: 'https://api.example.com/users/not-an-int',
  };
  const preflight3 = validateRequestPreflight(stringParamMonitor, binding, revision);
  assert.equal(preflight3.valid, false);
  assert.ok(preflight3.findings.some((f) => f.rule === 'parameter_type' || f.rule === 'schema'));

  // 4. Valid request passes preflight
  const validMonitor = {
    method: 'GET',
    url: 'https://api.example.com/users/42',
  };
  const preflight4 = validateRequestPreflight(validMonitor, binding, revision);
  assert.equal(preflight4.valid, true);
  assert.equal(preflight4.findings.length, 0);
});

test('Contract Validator — Request Preflight: Required query parameters, headers, and body validation', () => {
  const binding = {
    operation_method: 'POST',
    operation_path: '/items',
  };

  const revision = {
    id: 2,
    openapi_version: '3.0.3',
    content_sha256: 'xyz987654321',
    dereferenced_spec: {
      openapi: '3.0.3',
      paths: {
        '/items': {
          post: {
            parameters: [
              { name: 'category', in: 'query', required: true, schema: { type: 'string' } },
              { name: 'X-API-Key', in: 'header', required: true, schema: { type: 'string' } },
            ],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['name', 'price'],
                    properties: {
                      name: { type: 'string' },
                      price: { type: 'number' },
                    },
                  },
                },
              },
            },
            responses: { '201': { description: 'Created' } },
          },
        },
      },
    },
  };

  // 1. Missing required query param & header
  const badMonitor = {
    method: 'POST',
    url: 'https://api.example.com/items',
    headers: {},
    body: JSON.stringify({ name: 'Widget' }), // missing price
  };
  const res1 = validateRequestPreflight(badMonitor, binding, revision);
  assert.equal(res1.valid, false);
  assert.ok(res1.findings.some((f) => f.location.startsWith('request.query')));
  assert.ok(res1.findings.some((f) => f.location.startsWith('request.header')));
  assert.ok(res1.findings.some((f) => f.location.startsWith('request.body')));

  // 2. Valid request passes
  const goodMonitor = {
    method: 'POST',
    url: 'https://api.example.com/items?category=tools',
    headers: { 'X-API-Key': 'secret123' },
    body: JSON.stringify({ name: 'Hammer', price: 19.99 }),
  };
  const res2 = validateRequestPreflight(goodMonitor, binding, revision);
  assert.equal(res2.valid, true);
  assert.equal(res2.findings.length, 0);
});

test('Contract Validator — Response Contract: Status code matching precedence', () => {
  const binding = {
    operation_method: 'GET',
    operation_path: '/status-test',
  };

  const revision = {
    id: 3,
    openapi_version: '3.0.3',
    content_sha256: 'status_spec_sha',
    dereferenced_spec: {
      openapi: '3.0.3',
      paths: {
        '/status-test': {
          get: {
            responses: {
              '200': { description: 'Exact 200' },
              '2XX': { description: 'Range 2XX' },
              'default': { description: 'Default catch-all' },
            },
          },
        },
      },
    },
  };

  // Exact 200 matches exact declaration
  const res200 = validateResponseContract(
    { status_code: 200, headers: {}, body: '' },
    binding,
    revision
  );
  assert.equal(res200.valid, true);
  assert.equal(res200.verdict, 'passed');

  // 201 matches 2XX range
  const res201 = validateResponseContract(
    { status_code: 201, headers: {}, body: '' },
    binding,
    revision
  );
  assert.equal(res201.valid, true);
  assert.equal(res201.verdict, 'passed');

  // 500 matches default catch-all
  const res500 = validateResponseContract(
    { status_code: 500, headers: {}, body: '' },
    binding,
    revision
  );
  assert.equal(res500.valid, true);
  assert.equal(res500.verdict, 'passed');

  // When no default and undeclared status occurs: violation
  const revisionNoDefault = {
    id: 4,
    openapi_version: '3.0.3',
    content_sha256: 'no_default_sha',
    dereferenced_spec: {
      openapi: '3.0.3',
      paths: {
        '/status-test': {
          get: {
            responses: {
              '200': { description: 'Only 200' },
            },
          },
        },
      },
    },
  };
  const undeclaredRes = validateResponseContract(
    { status_code: 404, headers: {}, body: '' },
    binding,
    revisionNoDefault
  );
  assert.equal(undeclaredRes.valid, false);
  assert.equal(undeclaredRes.verdict, 'failed');
  assert.ok(undeclaredRes.findings.some((f) => f.rule === 'status_code'));
});

test('Contract Validator — Response Contract: Content-Type and Body Schema validation', () => {
  const binding = {
    operation_method: 'GET',
    operation_path: '/users/{id}',
  };

  const revision = {
    id: 5,
    openapi_version: '3.0.3',
    content_sha256: 'body_schema_sha',
    dereferenced_spec: {
      openapi: '3.0.3',
      paths: {
        '/users/{id}': {
          get: {
            responses: {
              '200': {
                description: 'User details',
                headers: {
                  'X-Rate-Limit': {
                    required: true,
                    schema: { type: 'integer' },
                  },
                },
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['id', 'username', 'email'],
                      properties: {
                        id: { type: 'integer' },
                        username: { type: 'string' },
                        email: { type: 'string', format: 'email' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  // 1. Wrong Content-Type
  const wrongContentType = validateResponseContract(
    {
      status_code: 200,
      headers: { 'content-type': 'text/plain', 'x-rate-limit': '100' },
      body: 'plain text',
    },
    binding,
    revision
  );
  assert.equal(wrongContentType.valid, false);
  assert.ok(wrongContentType.findings.some((f) => f.rule === 'content_type'));

  // 2. Missing required response header
  const missingHeader = validateResponseContract(
    {
      status_code: 200,
      headers: { 'content-type': 'application/json' },
      json_body: { id: 1, username: 'alice', email: 'alice@example.com' },
      body: JSON.stringify({ id: 1, username: 'alice', email: 'alice@example.com' }),
    },
    binding,
    revision
  );
  assert.equal(missingHeader.valid, false);
  assert.ok(missingHeader.findings.some((f) => f.rule === 'header' && f.location.startsWith('response.header')));

  // 3. Schema validation failure (missing required field 'email')
  const invalidBody = validateResponseContract(
    {
      status_code: 200,
      headers: { 'content-type': 'application/json', 'x-rate-limit': '60' },
      json_body: { id: 1, username: 'alice' }, // missing email
      body: JSON.stringify({ id: 1, username: 'alice' }),
    },
    binding,
    revision
  );
  assert.equal(invalidBody.valid, false);
  assert.ok(invalidBody.findings.some((f) => f.rule === 'schema' && f.location === 'response.body'));

  // 4. Fully conforming response passes
  const validResponse = validateResponseContract(
    {
      status_code: 200,
      headers: { 'content-type': 'application/json', 'x-rate-limit': '60' },
      json_body: { id: 1, username: 'alice', email: 'alice@example.com' },
      body: JSON.stringify({ id: 1, username: 'alice', email: 'alice@example.com' }),
    },
    binding,
    revision
  );
  assert.equal(validResponse.valid, true);
  assert.equal(validResponse.verdict, 'passed');
  assert.equal(validResponse.findings.length, 0);
});

test('Contract Validator — 204 No Content body validation and 64 KB truncation handling', () => {
  const binding = {
    operation_method: 'DELETE',
    operation_path: '/items/{id}',
  };

  const revision = {
    id: 6,
    openapi_version: '3.0.3',
    content_sha256: 'no_content_sha',
    dereferenced_spec: {
      openapi: '3.0.3',
      paths: {
        '/items/{id}': {
          delete: {
            responses: {
              '204': { description: 'Deleted' },
            },
          },
        },
      },
    },
  };

  // 1. 204 with empty body passes
  const valid204 = validateResponseContract(
    { status_code: 204, headers: {}, body: '' },
    binding,
    revision
  );
  assert.equal(valid204.valid, true);
  assert.equal(valid204.verdict, 'passed');

  // 2. 204 with non-empty body fails
  const invalid204 = validateResponseContract(
    { status_code: 204, headers: { 'content-type': 'application/json' }, body: '{"error": false}' },
    binding,
    revision
  );
  assert.equal(invalid204.valid, false);
  assert.ok(invalid204.findings.some((f) => f.rule === 'no_content_body'));

  // 3. Inspection limit (>64 KB) truncated response yields verdict 'partial'
  const truncatedBinding = {
    operation_method: 'GET',
    operation_path: '/large-data',
  };
  const truncatedRevision = {
    id: 7,
    openapi_version: '3.0.3',
    content_sha256: 'large_data_sha',
    dereferenced_spec: {
      openapi: '3.0.3',
      paths: {
        '/large-data': {
          get: {
            responses: {
              '200': {
                description: 'Big data',
                content: { 'application/json': { schema: { type: 'object' } } },
              },
            },
          },
        },
      },
    },
  };

  const truncatedRes = validateResponseContract(
    {
      status_code: 200,
      headers: { 'content-type': 'application/json' },
      body_truncated: true,
      body: 'a'.repeat(65536),
    },
    truncatedBinding,
    truncatedRevision
  );
  assert.equal(truncatedRes.inspection_truncated, true);
  assert.equal(truncatedRes.verdict, 'partial');
});

test('Contract Validator — Dialects: OpenAPI 3.0 nullable vs OpenAPI 3.1/3.2 type arrays', () => {
  // 1. OpenAPI 3.0 with nullable: true
  const binding30 = { operation_method: 'GET', operation_path: '/nullable-30' };
  const rev30 = {
    id: 8,
    openapi_version: '3.0.3',
    content_sha256: 'rev30_sha',
    dereferenced_spec: {
      openapi: '3.0.3',
      paths: {
        '/nullable-30': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        nickname: { type: 'string', nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  const res30Null = validateResponseContract(
    {
      status_code: 200,
      headers: { 'content-type': 'application/json' },
      json_body: { nickname: null },
      body: '{"nickname": null}',
    },
    binding30,
    rev30
  );
  assert.equal(res30Null.valid, true);

  // 2. OpenAPI 3.1 with type: ["string", "null"]
  const binding31 = { operation_method: 'GET', operation_path: '/type-array-31' };
  const rev31 = {
    id: 9,
    openapi_version: '3.1.0',
    content_sha256: 'rev31_sha',
    dereferenced_spec: {
      openapi: '3.1.0',
      paths: {
        '/type-array-31': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        bio: { type: ['string', 'null'] },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  const res31Null = validateResponseContract(
    {
      status_code: 200,
      headers: { 'content-type': 'application/json' },
      json_body: { bio: null },
      body: '{"bio": null}',
    },
    binding31,
    rev31
  );
  assert.equal(res31Null.valid, true);
});
