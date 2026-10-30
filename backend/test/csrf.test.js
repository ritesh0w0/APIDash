// backend/test/csrf.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const { createApp } = require('../app');
const { createCsrfProtection, getOrCreateCsrfToken } = require('../middleware/csrf');

test('CSRF protection allows safe GET and HEAD requests without token', async () => {
  const app = createApp();
  const resGet = await request(app).get('/health');
  assert.equal(resGet.status, 200);

  const resCsrf = await request(app).get('/api/auth/csrf');
  assert.equal(resCsrf.status, 200);
  assert.ok(resCsrf.body.csrfToken);
});

test('CSRF protection rejects mutating request without X-CSRF-Token header with 403', async () => {
  const app = createApp();
  const agent = request.agent(app);

  // Initialize session
  await agent.get('/api/auth/csrf');

  // Attempt mutating POST without CSRF header
  const res = await agent
    .post('/api/auth/login')
    .send({ email: 'test@example.com', password: 'Password123!' });

  assert.equal(res.status, 403);
  assert.match(res.body.error, /CSRF token/i);
});

test('CSRF protection rejects mutating request with invalid or tampered CSRF token with 403', async () => {
  const app = createApp();
  const agent = request.agent(app);

  // Initialize session
  await agent.get('/api/auth/csrf');

  // Attempt mutating POST with fraudulent token
  const res = await agent
    .post('/api/auth/login')
    .set('x-csrf-token', 'fraudulent_or_tampered_csrf_token_value_here_1234567890')
    .send({ email: 'test@example.com', password: 'Password123!' });

  assert.equal(res.status, 403);
  assert.match(res.body.error, /Invalid CSRF token/i);
});

test('CSRF protection allows mutating request with valid token and matching origin', async () => {
  const customConfig = {
    appOrigin: 'http://localhost:5000',
  };

  const dummyRouter = express.Router();
  dummyRouter.post('/action', (req, res) => res.json({ success: true }));

  const app = createApp({
    config: {
      nodeEnv: 'test',
      appOrigin: 'http://localhost:5000',
      port: 5000,
      session: {
        secret: 'test_session_secret_at_least_32_characters_long_for_security',
        cookieSecure: false,
        name: 'apidash_sid',
        maxAge: 86400000,
      },
      rateLimit: { authWindowMs: 60000, authMax: 100, apiWindowMs: 60000, apiMax: 100 },
    },
    apiRouter: dummyRouter,
  });

  const agent = request.agent(app);
  const csrfRes = await agent.get('/api/auth/csrf');
  const validToken = csrfRes.body.csrfToken;
  assert.ok(validToken);

  const resSuccess = await agent
    .post('/api/action')
    .set('origin', 'http://localhost:5000')
    .set('x-csrf-token', validToken)
    .send({ data: 'ok' });

  assert.equal(resSuccess.status, 200);
  assert.equal(resSuccess.body.success, true);
});

test('CSRF protection rejects request when origin header does not match application origin', async () => {
  const app = createApp({
    config: {
      nodeEnv: 'test',
      appOrigin: 'http://localhost:5000',
      port: 5000,
      session: {
        secret: 'test_session_secret_at_least_32_characters_long_for_security',
        cookieSecure: false,
        name: 'apidash_sid',
        maxAge: 86400000,
      },
      rateLimit: { authWindowMs: 60000, authMax: 100, apiWindowMs: 60000, apiMax: 100 },
    },
  });

  const agent = request.agent(app);
  const csrfRes = await agent.get('/api/auth/csrf');
  const validToken = csrfRes.body.csrfToken;

  const resForbiddenOrigin = await agent
    .post('/api/auth/login')
    .set('origin', 'https://attacker-controlled-site.com')
    .set('x-csrf-token', validToken)
    .send({ email: 'test@example.com', password: 'Password123!' });

  assert.equal(resForbiddenOrigin.status, 403);
  assert.match(resForbiddenOrigin.body.error, /Request origin does not match/);
});
