// backend/test/app.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../app');

test('createApp() produces a testable Express app without network port or DB connection', async () => {
  const app = createApp();
  assert.ok(app, 'createApp should return an application');
  assert.equal(typeof app.listen, 'function', 'app should be an Express instance');

  // Exercise GET /health
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(typeof res.body.uptime, 'number');
});

test('GET /health preserves exact response shape', async () => {
  const app = createApp();
  const res = await request(app).get('/health');

  assert.equal(res.status, 200);
  assert.ok('status' in res.body);
  assert.ok('uptime' in res.body);
  assert.equal(res.body.status, 'ok');
  assert.ok(res.body.uptime >= 0);
});

test('Unmatched GET routes fallback to static index.html or 404 safely', async () => {
  const app = createApp();
  const res = await request(app).get('/random-path-that-does-not-exist');

  // The wildcard handler serves index.html (status 200 with HTML)
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /html/);
});
