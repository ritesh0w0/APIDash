// backend/test/openapiParser.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAndValidateOpenAPI,
  calculateCanonicalSpecSha256,
  scanReferences,
} = require('../services/openapiParserService');

test('OpenAPI Parser — Validates OpenAPI 3.0.x in JSON and YAML', async () => {
  const jsonSpec = JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Test 3.0 API', version: '1.0.0' },
    paths: {
      '/users': {
        get: {
          summary: 'List users',
          responses: {
            '200': { description: 'Successful' },
          },
        },
      },
    },
  });

  const parsedJson = await parseAndValidateOpenAPI(jsonSpec);
  assert.equal(parsedJson.openapiVersion, '3.0.3');
  assert.equal(parsedJson.valid, true);
  assert.equal(parsedJson.operationsCatalog.length, 1);
  assert.equal(parsedJson.operationsCatalog[0].method, 'GET');
  assert.equal(parsedJson.operationsCatalog[0].pathTemplate, '/users');

  const yamlSpec = `
openapi: "3.0.1"
info:
  title: "YAML 3.0 API"
  version: "1.0.0"
paths:
  /health:
    get:
      summary: "Health probe"
      responses:
        "200":
          description: "OK"
`;

  const parsedYaml = await parseAndValidateOpenAPI(yamlSpec);
  assert.equal(parsedYaml.openapiVersion, '3.0.1');
  assert.equal(parsedYaml.valid, true);
  assert.equal(parsedYaml.operationsCatalog[0].pathTemplate, '/health');
});

test('OpenAPI Parser — Validates OpenAPI 3.1.x and 3.2.x', async () => {
  const spec31 = `
openapi: 3.1.0
info:
  title: Test 3.1 API
  version: 2.0.0
paths:
  /orders/{orderId}:
    post:
      summary: Create order
      parameters:
        - name: orderId
          in: path
          required: true
          schema:
            type: string
      responses:
        '201':
          description: Created
`;

  const parsed31 = await parseAndValidateOpenAPI(spec31);
  assert.equal(parsed31.openapiVersion, '3.1.0');
  assert.equal(parsed31.operationsCatalog.length, 1);
  assert.equal(parsed31.operationsCatalog[0].parametersCount, 1);

  const spec32 = `
openapi: 3.2.0
info:
  title: Test 3.2 API
  version: 3.0.0
paths:
  /v3/ping:
    get:
      summary: Ping
      responses:
        '200':
          description: Pong
`;

  const parsed32 = await parseAndValidateOpenAPI(spec32);
  assert.equal(parsed32.openapiVersion, '3.2.0');
  assert.equal(parsed32.operationsCatalog[0].pathTemplate, '/v3/ping');
});

test('OpenAPI Parser — Rejects malformed JSON and invalid YAML', async () => {
  await assert.rejects(
    async () => {
      await parseAndValidateOpenAPI('{ "openapi": "3.0.0", paths: {');
    },
    (err) => {
      assert.match(err.message, /Invalid JSON syntax/);
      return true;
    }
  );

  await assert.rejects(
    async () => {
      await parseAndValidateOpenAPI('openapi: 3.0.0\npaths:\n  /test:\n    [unclosed list');
    },
    (err) => {
      assert.match(err.message, /Invalid YAML syntax/);
      return true;
    }
  );
});

test('OpenAPI Parser — Rejects Swagger 2.0 and missing openapi field', async () => {
  const swagger2 = JSON.stringify({
    swagger: '2.0',
    info: { title: 'Legacy Swagger', version: '1.0' },
    paths: {},
  });

  await assert.rejects(
    async () => {
      await parseAndValidateOpenAPI(swagger2);
    },
    (err) => {
      assert.match(err.message, /OpenAPI 2\.0 \(Swagger\) is not supported/);
      return true;
    }
  );

  const missingOpenapi = JSON.stringify({
    info: { title: 'Missing Version', version: '1.0' },
    paths: {},
  });

  await assert.rejects(
    async () => {
      await parseAndValidateOpenAPI(missingOpenapi);
    },
    (err) => {
      assert.match(err.message, /Missing required 'openapi' version field/);
      return true;
    }
  );
});

test('OpenAPI Parser — Size ceiling rejects documents > 1 MiB', async () => {
  const largeContent = 'a'.repeat(1024 * 1024 + 50);
  await assert.rejects(
    async () => {
      await parseAndValidateOpenAPI(largeContent);
    },
    (err) => {
      assert.match(err.message, /exceeds maximum allowed size of 1 MiB/);
      return true;
    }
  );
});

test('OpenAPI Parser — Security: Internal references succeed while external references are strictly forbidden', async () => {
  // 1. Internal reference succeeds
  const internalRefSpec = `
openapi: 3.0.3
info:
  title: Internal Ref Spec
  version: 1.0.0
paths:
  /user:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/User'
components:
  schemas:
    User:
      type: object
      properties:
        id:
          type: integer
`;

  const parsed = await parseAndValidateOpenAPI(internalRefSpec);
  assert.equal(parsed.operationsCatalog.length, 1);

  // 2. HTTP external $ref rejected
  const httpRefDoc = `
openapi: 3.0.3
info:
  title: Malicious Remote
  version: 1.0
paths:
  /test:
    get:
      responses:
        '200':
          $ref: 'https://evil.com/spec.json#/User'
`;
  await assert.rejects(
    async () => {
      await parseAndValidateOpenAPI(httpRefDoc);
    },
    (err) => {
      assert.match(err.message, /External or remote reference prohibited/);
      return true;
    }
  );

  // 3. File external $ref rejected
  const fileRefDoc = `
openapi: 3.0.3
info:
  title: File Stealer
  version: 1.0
paths:
  /test:
    get:
      responses:
        '200':
          $ref: 'file:///etc/passwd'
`;
  await assert.rejects(
    async () => {
      await parseAndValidateOpenAPI(fileRefDoc);
    },
    (err) => {
      assert.match(err.message, /External or remote reference prohibited/);
      return true;
    }
  );

  // 4. Relative file $ref rejected
  const relRefDoc = `
openapi: 3.0.3
info:
  title: Path Traversal
  version: 1.0
paths:
  /test:
    get:
      responses:
        '200':
          $ref: '../secrets.json'
`;
  await assert.rejects(
    async () => {
      await parseAndValidateOpenAPI(relRefDoc);
    },
    (err) => {
      assert.match(err.message, /External or remote reference prohibited/);
      return true;
    }
  );
});

test('OpenAPI Parser — Security: YAML alias explosion is bounded safely', async () => {
  const maliciousYaml = `
a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]
e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]
f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]
g: &g [*f,*f,*f,*f,*f,*f,*f,*f,*f]
h: &h [*g,*g,*g,*g,*g,*g,*g,*g,*g]
i: &i [*h,*h,*h,*h,*h,*h,*h,*h,*h]
openapi: 3.0.3
info:
  title: Bomb
  version: 1.0
paths: {}
`;

  await assert.rejects(
    async () => {
      await parseAndValidateOpenAPI(maliciousYaml);
    },
    (err) => {
      assert.ok(err.message.includes('alias') || err.message.includes('Invalid') || err.message.includes('exceeded'));
      return true;
    }
  );
});

test('OpenAPI Parser — Deterministic canonical SHA-256 calculation', () => {
  const obj1 = {
    b: 2,
    a: 1,
    nested: { y: 'hello', x: 'world' },
  };

  const obj2 = {
    a: 1,
    nested: { x: 'world', y: 'hello' },
    b: 2,
  };

  const hash1 = calculateCanonicalSpecSha256(obj1);
  const hash2 = calculateCanonicalSpecSha256(obj2);

  assert.equal(typeof hash1, 'string');
  assert.equal(hash1.length, 64);
  assert.equal(hash1, hash2, 'Canonical hash must match regardless of key order');
});
