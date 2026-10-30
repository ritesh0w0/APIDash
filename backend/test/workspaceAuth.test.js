// backend/test/workspaceAuth.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../app');
const { createWorkspaceRouter } = require('../routes/workspaceRoutes');
const { createAuthMiddleware } = require('../middleware/auth');
const { AppError } = require('../middleware/errors');

function setupWorkspaceTestHarness() {
  const users = [
    { id: 1, email: 'usera@example.com', display_name: 'User A' },
    { id: 2, email: 'userb@example.com', display_name: 'User B' },
    { id: 3, email: 'userc@example.com', display_name: 'User C' },
  ];

  const workspaces = [
    { id: 10, name: 'Workspace A', created_by: 1 },
    { id: 20, name: 'Workspace B', created_by: 2 },
  ];

  const memberships = [
    { id: 1, workspace_id: 10, user_id: 1, role: 'owner' },
    { id: 2, workspace_id: 20, user_id: 2, role: 'owner' },
    { id: 3, workspace_id: 10, user_id: 3, role: 'member' }, // User C is member in Workspace A
  ];

  const apis = [
    { id: 101, workspace_id: 10, name: 'API A1', url: 'https://api-a.example.com', method: 'GET', expected_status: 200 },
    { id: 201, workspace_id: 20, name: 'API B1', url: 'https://api-b.example.com', method: 'GET', expected_status: 200 },
  ];

  const mockUserRepo = {
    findById: async (id) => users.find((u) => u.id === Number(id)) || null,
    findByEmail: async (email) => users.find((u) => u.email === email.trim().toLowerCase()) || null,
  };

  const mockWorkspaceRepo = {
    findById: async (id) => workspaces.find((w) => w.id === Number(id)) || null,
    findUserWorkspaces: async (userId) => {
      return memberships
        .filter((m) => m.user_id === Number(userId))
        .map((m) => {
          const ws = workspaces.find((w) => w.id === m.workspace_id);
          return { id: ws.id, name: ws.name, role: m.role };
        });
    },
    findMembership: async (wsId, userId) => {
      return memberships.find((m) => m.workspace_id === Number(wsId) && m.user_id === Number(userId)) || null;
    },
    findMembers: async (wsId) => {
      return memberships
        .filter((m) => m.workspace_id === Number(wsId))
        .map((m) => {
          const user = users.find((u) => u.id === m.user_id);
          return { id: m.id, user_id: user.id, email: user.email, display_name: user.display_name, role: m.role };
        });
    },
    countOwners: async (wsId) => {
      return memberships.filter((m) => m.workspace_id === Number(wsId) && m.role === 'owner').length;
    },
    createMember: async ({ workspace_id, user_id, role }) => {
      const mem = { id: memberships.length + 1, workspace_id, user_id, role };
      memberships.push(mem);
      return mem;
    },
    removeMember: async (wsId, userId) => {
      const idx = memberships.findIndex((m) => m.workspace_id === Number(wsId) && m.user_id === Number(userId));
      if (idx !== -1) memberships.splice(idx, 1);
      return true;
    },
    update: async (id, data) => {
      const ws = workspaces.find((w) => w.id === Number(id));
      if (ws && data.name) ws.name = data.name;
      return ws;
    },
  };

  const mockApiRepo = {
    create: async (data) => {
      const newApi = { id: 300 + apis.length, ...data };
      apis.push(newApi);
      return newApi;
    },
    findById: async (id, workspaceId) => {
      return apis.find((a) => a.id === Number(id) && a.workspace_id === Number(workspaceId)) || null;
    },
    findAll: async (workspaceId) => {
      return apis.filter((a) => a.workspace_id === Number(workspaceId));
    },
    findAllWithLatestResult: async (workspaceId) => {
      return apis.filter((a) => a.workspace_id === Number(workspaceId));
    },
    deleteById: async (id, workspaceId) => {
      const idx = apis.findIndex((a) => a.id === Number(id) && a.workspace_id === Number(workspaceId));
      if (idx !== -1) {
        apis.splice(idx, 1);
        return true;
      }
      return false;
    },
    getStats: async (workspaceId) => {
      const count = apis.filter((a) => a.workspace_id === Number(workspaceId)).length;
      return { total: count, passing: count, failing: 0, avg_response_time: 100 };
    },
  };

  const realAuthMiddleware = createAuthMiddleware({
    userRepo: mockUserRepo,
    workspaceRepo: mockWorkspaceRepo,
  });

  const testAuthMiddleware = {
    requireAuth: async (req, _res, next) => {
      const userId = Number(req.headers['x-test-user-id'] || (req.session && req.session.userId));
      if (!userId) {
        return next(new AppError('Authentication required. Please log in.', 401));
      }
      const user = await mockUserRepo.findById(userId);
      if (!user) return next(new AppError('User account not found', 401));
      req.user = user;
      next();
    },
    requireWorkspaceMember: realAuthMiddleware.requireWorkspaceMember,
    requireWorkspaceOwner: realAuthMiddleware.requireWorkspaceOwner,
  };

  const workspaceRouter = createWorkspaceRouter({
    workspaceRepo: mockWorkspaceRepo,
    apiRepo: mockApiRepo,
    userRepo: mockUserRepo,
    requireAuth: testAuthMiddleware.requireAuth,
    requireWorkspaceMember: testAuthMiddleware.requireWorkspaceMember,
    requireWorkspaceOwner: testAuthMiddleware.requireWorkspaceOwner,
  });

  const app = createApp({
    workspaceRouter,
    csrfProtection: (_req, _res, next) => next(),
  });

  return {
    app,
    users,
    workspaces,
    memberships,
    apis,
  };
}

/**
 * Helper to simulate an authenticated session in tests.
 */
function createAuthenticatedSession(app, userId) {
  const sessionMiddleware = (req, _res, next) => {
    if (req.session) {
      req.session.userId = userId;
    }
    next();
  };
  return sessionMiddleware;
}

test('Unauthenticated requests to /api/workspaces are rejected with 401', async () => {
  const { app } = setupWorkspaceTestHarness();

  const resList = await request(app).get('/api/workspaces');
  assert.equal(resList.status, 401);

  const resDetail = await request(app).get('/api/workspaces/10');
  assert.equal(resDetail.status, 401);
});

test('User A can view their own workspaces but not workspaces of User B', async () => {
  const { app } = setupWorkspaceTestHarness();

  // Test User A (id: 1)
  const agentA = request(app);
  const resA = await agentA.get('/api/workspaces').set('x-test-user-id', '1');
  assert.equal(resA.status, 200);
  assert.equal(resA.body.length, 1);
  assert.equal(resA.body[0].id, 10);
  assert.equal(resA.body[0].name, 'Workspace A');

  // User A requesting Workspace A details -> 200
  const resWsA = await agentA.get('/api/workspaces/10').set('x-test-user-id', '1');
  assert.equal(resWsA.status, 200);
  assert.equal(resWsA.body.name, 'Workspace A');

  // User A requesting Workspace B (id: 20) details -> 404 (IDOR defense)
  const resWsB = await agentA.get('/api/workspaces/20').set('x-test-user-id', '1');
  assert.equal(resWsB.status, 404);
  assert.match(resWsB.body.error, /Workspace not found or access denied/);
});

test('Cross-tenant IDOR protection: User A cannot read, modify, or delete User B monitor', async () => {
  const { app, apis } = setupWorkspaceTestHarness();

  const agentA = request.agent(app);

  // Monitor 201 belongs to Workspace B. User A attempts to view it under Workspace A:
  const resRead = await agentA.get('/api/workspaces/10/apis/201').set('x-test-user-id', '1');
  assert.equal(resRead.status, 404);

  // User A attempts to delete Monitor 201 under Workspace A:
  const resDeleteA = await agentA.delete('/api/workspaces/10/apis/201').set('x-test-user-id', '1');
  assert.equal(resDeleteA.status, 404);
  assert.ok(apis.some((a) => a.id === 201), 'Monitor 201 must not be deleted');

  // User A attempts to delete Monitor 201 under Workspace B directly:
  const resDeleteB = await agentA.delete('/api/workspaces/20/apis/201').set('x-test-user-id', '1');
  assert.equal(resDeleteB.status, 404); // Blocked at workspace boundary
  assert.ok(apis.some((a) => a.id === 201), 'Monitor 201 must still exist');
});

test('Role-based authorization: Members can view monitors but cannot manage members or settings', async () => {
  const { app } = setupWorkspaceTestHarness();
  const agentC = request.agent(app); // User C is member in Workspace A

  // Member can view monitors in Workspace A
  const resList = await agentC.get('/api/workspaces/10/apis').set('x-test-user-id', '3');
  assert.equal(resList.status, 200);

  // Member attempts to add another member -> 403 Forbidden
  const resAddMember = await agentC
    .post('/api/workspaces/10/members')
    .set('x-test-user-id', '3')
    .send({ email: 'userB@example.com', role: 'member' });
  assert.equal(resAddMember.status, 403);
  assert.match(resAddMember.body.error, /Owner permission is required/);

  // Member attempts to update workspace name -> 403 Forbidden
  const resUpdate = await agentC
    .patch('/api/workspaces/10')
    .set('x-test-user-id', '3')
    .send({ name: 'Hacked Workspace Name' });
  assert.equal(resUpdate.status, 403);

  // Member attempts to delete workspace -> 403 Forbidden
  const resDelete = await agentC
    .delete('/api/workspaces/10')
    .set('x-test-user-id', '3');
  assert.equal(resDelete.status, 403);
});

test('Owner can manage members and settings, but cannot remove the final owner', async () => {
  const { app, memberships } = setupWorkspaceTestHarness();
  const agentA = request.agent(app); // User A is owner of Workspace A

  // Owner adds User B as member
  const resAdd = await agentA
    .post('/api/workspaces/10/members')
    .set('x-test-user-id', '1')
    .send({ email: 'userB@example.com', role: 'member' });
  assert.equal(resAdd.status, 201);
  assert.equal(resAdd.body.member.email, 'userb@example.com');

  // Owner updates workspace name
  const resUpdate = await agentA
    .patch('/api/workspaces/10')
    .set('x-test-user-id', '1')
    .send({ name: 'Renamed Workspace A' });
  assert.equal(resUpdate.status, 200);
  assert.equal(resUpdate.body.name, 'Renamed Workspace A');

  // Owner cannot remove themselves if they are the only owner
  const resRemoveSelf = await agentA
    .delete('/api/workspaces/10/members/1')
    .set('x-test-user-id', '1');
  assert.equal(resRemoveSelf.status, 400);
  assert.match(resRemoveSelf.body.error, /Cannot remove the final owner/);

  // Owner CAN remove member User C
  const resRemoveC = await agentA
    .delete('/api/workspaces/10/members/3')
    .set('x-test-user-id', '1');
  assert.equal(resRemoveC.status, 200);
  assert.equal(resRemoveC.body.message, 'Member removed successfully');
});
