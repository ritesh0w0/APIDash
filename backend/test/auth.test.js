// backend/test/auth.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../app');
const { createAuthRouter } = require('../routes/authRoutes');
const { hashPassword } = require('../services/passwordService');

function createMockAuthRepositories() {
  const users = [];
  const workspaces = [];
  const memberships = [];
  let nextUserId = 1;
  let nextWsId = 1;

  const mockUserRepo = {
    create: async ({ email, password_hash, display_name }) => {
      const canonicalEmail = email.trim().toLowerCase();
      const user = {
        id: nextUserId++,
        email: canonicalEmail,
        password_hash,
        display_name: display_name || canonicalEmail.split('@')[0],
        created_at: new Date(),
        updated_at: new Date(),
      };
      users.push(user);
      return user;
    },
    findByEmail: async (email) => {
      const canonical = email.trim().toLowerCase();
      return users.find((u) => u.email === canonical) || null;
    },
    findById: async (id) => {
      return users.find((u) => u.id === Number(id)) || null;
    },
  };

  const mockWorkspaceRepo = {
    registerUserWithWorkspace: async ({ email, password_hash, display_name, workspace_name }, uRepo) => {
      const user = await uRepo.create({ email, password_hash, display_name });
      const ws = {
        id: nextWsId++,
        name: workspace_name || 'My Workspace',
        created_by: user.id,
        created_at: new Date(),
      };
      workspaces.push(ws);
      memberships.push({
        id: memberships.length + 1,
        workspace_id: ws.id,
        user_id: user.id,
        role: 'owner',
      });
      return { user, workspace: ws };
    },
    findUserWorkspaces: async (userId) => {
      const userMemberships = memberships.filter((m) => m.user_id === Number(userId));
      return userMemberships.map((m) => {
        const ws = workspaces.find((w) => w.id === m.workspace_id);
        return {
          id: ws.id,
          name: ws.name,
          role: m.role,
        };
      });
    },
  };

  return {
    users,
    workspaces,
    memberships,
    mockUserRepo,
    mockWorkspaceRepo,
  };
}

test('POST /api/auth/register transactionally creates user and initial workspace with owner role', async () => {
  const { users, workspaces, memberships, mockUserRepo, mockWorkspaceRepo } = createMockAuthRepositories();
  const authRouter = createAuthRouter({
    userRepo: mockUserRepo,
    workspaceRepo: mockWorkspaceRepo,
  });
  const app = createApp({ authRouter, csrfProtection: (_req, _res, next) => next() });

  const res = await request(app)
    .post('/api/auth/register')
    .send({
      email: 'Alice@Example.com',
      password: 'SuperSecretPassword123!',
      display_name: 'Alice',
      workspace_name: 'Alice Team',
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.message, 'Account created successfully');
  assert.equal(res.body.user.email, 'alice@example.com');
  assert.equal(res.body.user.display_name, 'Alice');
  assert.equal(res.body.workspace.name, 'Alice Team');
  assert.equal(res.body.workspace.role, 'owner');
  assert.ok(res.body.csrfToken);

  // Security checks: Password hash must NOT be exposed in response or stored as plaintext
  assert.equal(res.body.user.password_hash, undefined);
  assert.equal(users.length, 1);
  assert.equal(users[0].email, 'alice@example.com');
  assert.notEqual(users[0].password_hash, 'SuperSecretPassword123!');
  assert.match(users[0].password_hash, /^\$argon2id\$/); // Argon2id hash prefix
  assert.equal(workspaces.length, 1);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].role, 'owner');
});

test('POST /api/auth/register rejects duplicate canonicalized email', async () => {
  const { mockUserRepo, mockWorkspaceRepo } = createMockAuthRepositories();
  const authRouter = createAuthRouter({
    userRepo: mockUserRepo,
    workspaceRepo: mockWorkspaceRepo,
  });
  const app = createApp({ authRouter, csrfProtection: (_req, _res, next) => next() });

  await request(app)
    .post('/api/auth/register')
    .send({ email: 'bob@example.com', password: 'Password123!' });

  const resDuplicate = await request(app)
    .post('/api/auth/register')
    .send({ email: '  BOB@example.com  ', password: 'Password123!' });

  assert.equal(resDuplicate.status, 400);
  assert.match(resDuplicate.body.error, /already registered/);
});

test('POST /api/auth/register validates email and password length bounds', async () => {
  const { mockUserRepo, mockWorkspaceRepo } = createMockAuthRepositories();
  const authRouter = createAuthRouter({
    userRepo: mockUserRepo,
    workspaceRepo: mockWorkspaceRepo,
  });
  const app = createApp({ authRouter, csrfProtection: (_req, _res, next) => next() });

  // Invalid email
  const resBadEmail = await request(app)
    .post('/api/auth/register')
    .send({ email: 'not-an-email', password: 'Password123!' });
  assert.equal(resBadEmail.status, 400);

  // Password too short (< 8 chars)
  const resShortPass = await request(app)
    .post('/api/auth/register')
    .send({ email: 'charlie@example.com', password: 'short' });
  assert.equal(resShortPass.status, 400);
  assert.match(resShortPass.body.error, /at least 8 characters/);
});

test('POST /api/auth/login succeeds with valid credentials and issues session cookie', async () => {
  const { mockUserRepo, mockWorkspaceRepo } = createMockAuthRepositories();
  const passwordHash = await hashPassword('ValidPassword123!');
  await mockUserRepo.create({ email: 'dave@example.com', password_hash: passwordHash, display_name: 'Dave' });

  const authRouter = createAuthRouter({
    userRepo: mockUserRepo,
    workspaceRepo: mockWorkspaceRepo,
  });
  const app = createApp({ authRouter, csrfProtection: (_req, _res, next) => next() });

  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/login')
    .send({ email: '  DAVE@example.com ', password: 'ValidPassword123!' });

  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Login successful');
  assert.equal(res.body.user.email, 'dave@example.com');
  assert.equal(res.body.user.password_hash, undefined);
  assert.ok(res.body.csrfToken);

  // Subsequent request with the agent preserves session and loads /api/auth/me
  const resMe = await agent.get('/api/auth/me');
  assert.equal(resMe.status, 200);
  assert.equal(resMe.body.user.email, 'dave@example.com');

  // Logout invalidates session
  const resLogout = await agent.post('/api/auth/logout');
  assert.equal(resLogout.status, 200);

  // After logout, /api/auth/me is rejected with 401
  const resMeAfterLogout = await agent.get('/api/auth/me');
  assert.equal(resMeAfterLogout.status, 401);
});

test('POST /api/auth/login returns generic 401 failure for non-existent email or wrong password', async () => {
  const { mockUserRepo, mockWorkspaceRepo } = createMockAuthRepositories();
  const passwordHash = await hashPassword('CorrectPassword123!');
  await mockUserRepo.create({ email: 'eve@example.com', password_hash: passwordHash });

  const authRouter = createAuthRouter({
    userRepo: mockUserRepo,
    workspaceRepo: mockWorkspaceRepo,
  });
  const app = createApp({ authRouter, csrfProtection: (_req, _res, next) => next() });

  // Non-existent email
  const resNoUser = await request(app)
    .post('/api/auth/login')
    .send({ email: 'nonexistent@example.com', password: 'AnyPassword123!' });
  assert.equal(resNoUser.status, 401);
  assert.equal(resNoUser.body.error, 'Invalid email or password');

  // Wrong password
  const resWrongPass = await request(app)
    .post('/api/auth/login')
    .send({ email: 'eve@example.com', password: 'WrongPassword123!' });
  assert.equal(resWrongPass.status, 401);
  assert.equal(resWrongPass.body.error, 'Invalid email or password');
});

test('GET /api/auth/me without active session returns 401 safely without leaking internal data', async () => {
  const authRouter = createAuthRouter();
  const app = createApp({ authRouter, csrfProtection: (_req, _res, next) => next() });

  const res = await request(app).get('/api/auth/me');
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Not authenticated');
});
