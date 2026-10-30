// backend/test/incidentRoutes.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../app');
const { createWorkspaceRouter } = require('../routes/workspaceRoutes');
const { createAuthMiddleware } = require('../middleware/auth');
const { AppError } = require('../middleware/errors');
const { loadConfig } = require('../config');

function setupIncidentRoutesTestHarness() {
  const users = [
    { id: 1, email: 'owner@example.com', display_name: 'Workspace Owner' },
    { id: 2, email: 'member@example.com', display_name: 'Workspace Member' },
    { id: 3, email: 'stranger@example.com', display_name: 'Stranger' },
  ];

  const workspaces = [
    { id: 10, name: 'Workspace 10', created_by: 1 },
    { id: 20, name: 'Workspace 20', created_by: 3 },
  ];

  const memberships = [
    { id: 1, workspace_id: 10, user_id: 1, role: 'owner' },
    { id: 2, workspace_id: 10, user_id: 2, role: 'member' },
    { id: 3, workspace_id: 20, user_id: 3, role: 'owner' },
  ];

  const incidents = [
    {
      id: 101,
      workspace_id: 10,
      api_id: 1,
      api_name: 'Payment Gateway',
      api_url: 'https://payment.example.com',
      status: 'open',
      first_unhealthy_at: new Date('2026-10-28T10:00:00Z'),
      opened_at: new Date('2026-10-28T10:00:30Z'),
      unhealthy_count: 3,
      error_summary: 'HTTP 500 - Internal Server Error',
    },
    {
      id: 102,
      workspace_id: 10,
      api_id: 2,
      api_name: 'Auth API',
      api_url: 'https://auth.example.com',
      status: 'resolved',
      first_unhealthy_at: new Date('2026-10-28T09:00:00Z'),
      opened_at: new Date('2026-10-28T09:00:30Z'),
      resolved_at: new Date('2026-10-28T09:05:00Z'),
      unhealthy_count: 2,
      error_summary: 'TIMEOUT',
    },
    {
      id: 201,
      workspace_id: 20,
      api_id: 3,
      api_name: 'Workspace 20 API',
      api_url: 'https://secret.example.com',
      status: 'open',
      first_unhealthy_at: new Date(),
      opened_at: new Date(),
      unhealthy_count: 2,
      error_summary: 'Database connection failed',
    },
  ];

  let notificationSettings = {
    workspace_id: 10,
    notify_on_open: true,
    notify_on_resolve: true,
  };

  let notificationRecipients = [
    { id: 1, email: 'owner@example.com', display_name: 'Workspace Owner', role: 'owner' },
  ];

  const mockUserRepo = {
    findById: async (id) => users.find((u) => u.id === Number(id)) || null,
    findByEmail: async (email) => users.find((u) => u.email === email.trim().toLowerCase()) || null,
  };

  const mockWorkspaceRepo = {
    findById: async (id) => workspaces.find((w) => w.id === Number(id)) || null,
    findMembership: async (wsId, userId) => {
      return memberships.find((m) => m.workspace_id === Number(wsId) && m.user_id === Number(userId)) || null;
    },
    findMembers: async (wsId) => {
      return memberships
        .filter((m) => m.workspace_id === Number(wsId))
        .map((m) => {
          const user = users.find((u) => u.id === m.user_id);
          return {
            membership_id: m.id,
            workspace_id: m.workspace_id,
            user_id: user.id,
            id: user.id,
            email: user.email,
            display_name: user.display_name,
            role: m.role,
          };
        });
    },
  };

  const mockIncidentRepo = {
    listByWorkspace: async (wsId, { status = 'all', limit = 20, offset = 0 } = {}) => {
      let filtered = incidents.filter((i) => i.workspace_id === Number(wsId));
      if (status === 'open') filtered = filtered.filter((i) => i.status === 'open');
      if (status === 'resolved') filtered = filtered.filter((i) => i.status === 'resolved');
      return filtered.slice(offset, offset + limit);
    },
    countByWorkspace: async (wsId, { status = 'all' } = {}) => {
      let filtered = incidents.filter((i) => i.workspace_id === Number(wsId));
      if (status === 'open') filtered = filtered.filter((i) => i.status === 'open');
      if (status === 'resolved') filtered = filtered.filter((i) => i.status === 'resolved');
      return filtered.length;
    },
    findById: async (id, wsId) => {
      return incidents.find((i) => i.id === Number(id) && i.workspace_id === Number(wsId)) || null;
    },
  };

  const mockTestResultRepo = {
    findRecentByApiId: async () => [
      { id: 1, status_code: 500, response_time: 120, result: 'failed', tested_at: new Date().toISOString() },
    ],
  };

  const mockNotificationRepo = {
    getSettings: async (wsId) => ({ ...notificationSettings, workspace_id: Number(wsId) }),
    updateSettings: async (wsId, settings) => {
      notificationSettings = { ...notificationSettings, ...settings, workspace_id: Number(wsId) };
      return notificationSettings;
    },
    getRecipients: async (wsId) => notificationRecipients,
    setRecipients: async (wsId, userIds) => {
      const validMembers = memberships.filter((m) => m.workspace_id === Number(wsId));
      const validMemberIds = new Set(validMembers.map((m) => m.user_id));

      for (const uid of userIds) {
        if (!validMemberIds.has(Number(uid))) {
          throw new Error(`User ID ${uid} is not an authorized member of workspace ${wsId}`);
        }
      }

      notificationRecipients = userIds.map((uid) => {
        const u = users.find((user) => user.id === Number(uid));
        const m = memberships.find((mem) => mem.workspace_id === Number(wsId) && mem.user_id === Number(uid));
        return { id: u.id, email: u.email, display_name: u.display_name, role: m.role };
      });
      return notificationRecipients;
    },
  };

  const realAuthMiddleware = createAuthMiddleware({
    userRepo: mockUserRepo,
    workspaceRepo: mockWorkspaceRepo,
  });

  const testAuthMiddleware = {
    requireAuth: async (req, _res, next) => {
      const userId = Number(req.headers['x-test-user-id']);
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
    incidentRepo: mockIncidentRepo,
    notificationRepo: mockNotificationRepo,
    testResultRepo: mockTestResultRepo,
    requireAuth: testAuthMiddleware.requireAuth,
    requireWorkspaceMember: testAuthMiddleware.requireWorkspaceMember,
    requireWorkspaceOwner: testAuthMiddleware.requireWorkspaceOwner,
    config: loadConfig({ LOG_LEVEL: 'silent' }),
  });

  const app = createApp({
    workspaceRouter,
    csrfProtection: (_req, _res, next) => next(),
  });

  return { app };
}

test('Incident Routes — Workspace authorization, IDOR protection, and role permissions', async (t) => {
  const { app } = setupIncidentRoutesTestHarness();

  // 1. Unauthenticated request rejected with 401
  await t.test('Unauthenticated request to /api/workspaces/10/incidents is rejected with 401', async () => {
    const res = await request(app).get('/api/workspaces/10/incidents');
    assert.equal(res.status, 401);
  });

  // 2. User 1 (Owner in WS 10) can list incidents in WS 10
  await t.test('Owner can list incidents for their workspace', async () => {
    const res = await request(app)
      .get('/api/workspaces/10/incidents')
      .set('x-test-user-id', '1');

    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.incidents.length, 2);
    assert.equal(res.body.incidents[0].id, 101);
  });

  // 3. Status filtering: open vs resolved
  await t.test('Incidents status filtering returns correct subset', async () => {
    const resOpen = await request(app)
      .get('/api/workspaces/10/incidents?status=open')
      .set('x-test-user-id', '1');

    assert.equal(resOpen.status, 200);
    assert.equal(resOpen.body.total, 1);
    assert.equal(resOpen.body.incidents[0].status, 'open');

    const resResolved = await request(app)
      .get('/api/workspaces/10/incidents?status=resolved')
      .set('x-test-user-id', '1');

    assert.equal(resResolved.status, 200);
    assert.equal(resResolved.body.total, 1);
    assert.equal(resResolved.body.incidents[0].status, 'resolved');
  });

  // 4. Cross-tenant IDOR protection: Stranger (User 3) cannot list WS 10 incidents
  await t.test('Stranger cannot read Workspace 10 incidents (safe 404 IDOR defense)', async () => {
    const res = await request(app)
      .get('/api/workspaces/10/incidents')
      .set('x-test-user-id', '3');

    assert.equal(res.status, 404);
  });

  // 5. Viewing single incident with result history
  await t.test('Member can view incident detail and linked test results', async () => {
    const res = await request(app)
      .get('/api/workspaces/10/incidents/101')
      .set('x-test-user-id', '2'); // User 2 is member

    assert.equal(res.status, 200);
    assert.equal(res.body.incident.id, 101);
    assert.ok(Array.isArray(res.body.results));
    assert.equal(res.body.results.length, 1);
  });

  // 6. Accessing non-existent incident or incident from another workspace returns 404
  await t.test('Accessing unknown incident ID returns 404', async () => {
    const res = await request(app)
      .get('/api/workspaces/10/incidents/999')
      .set('x-test-user-id', '1');

    assert.equal(res.status, 404);
  });

  // 7. GET /notification-settings returns settings, recipients, and membership
  await t.test('Member can read notification settings and recipients', async () => {
    const res = await request(app)
      .get('/api/workspaces/10/notification-settings')
      .set('x-test-user-id', '2');

    assert.equal(res.status, 200);
    assert.equal(res.body.canEdit, false); // User 2 is member, not owner
    assert.equal(res.body.settings.notify_on_open, true);
    assert.ok(Array.isArray(res.body.recipients));
  });

  // 8. PUT /notification-settings by non-owner member is rejected with 403 Forbidden
  await t.test('Non-owner member cannot modify notification settings (403 Forbidden)', async () => {
    const res = await request(app)
      .put('/api/workspaces/10/notification-settings')
      .set('x-test-user-id', '2')
      .send({ notify_on_open: false });

    assert.equal(res.status, 403);
  });

  // 9. PUT /notification-settings by owner succeeds
  await t.test('Owner can update notification settings and select valid recipients', async () => {
    const res = await request(app)
      .put('/api/workspaces/10/notification-settings')
      .set('x-test-user-id', '1')
      .send({
        notify_on_open: true,
        notify_on_resolve: false,
        recipient_user_ids: [1, 2],
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.settings.notify_on_resolve, false);
    assert.equal(res.body.recipients.length, 2);
  });

  // 10. PUT /notification-settings rejecting non-member recipient ID
  await t.test('Selecting non-member user ID for recipients is rejected', async () => {
    const res = await request(app)
      .put('/api/workspaces/10/notification-settings')
      .set('x-test-user-id', '1')
      .send({
        recipient_user_ids: [3], // User 3 is NOT in Workspace 10
      });

    assert.equal(res.status, 500); // Throws error and central error handler catches safely
  });
});

