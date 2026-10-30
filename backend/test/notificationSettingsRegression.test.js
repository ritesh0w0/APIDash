// backend/test/notificationSettingsRegression.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../app');
const { createWorkspaceRouter } = require('../routes/workspaceRoutes');
const { createAuthMiddleware } = require('../middleware/auth');
const { AppError } = require('../middleware/errors');
const { loadConfig } = require('../config');

function setupTestHarness() {
  const users = [
    { id: 1, email: 'owner@example.com', display_name: 'Workspace Owner' },
    { id: 2, email: 'member@example.com', display_name: 'Regular Member' },
    { id: 3, email: 'external@example.com', display_name: 'External Non-Member' },
  ];

  const memberships = [
    { id: 101, workspace_id: 10, user_id: 1, role: 'owner' },
    { id: 102, workspace_id: 10, user_id: 2, role: 'member' },
  ];

  let notificationSettings = {
    workspace_id: 10,
    notify_on_open: true,
    notify_on_resolve: true,
  };

  let notificationRecipients = [];

  const mockUserRepo = {
    findById: async (id) => users.find((u) => u.id === Number(id)) || null,
  };

  const mockWorkspaceRepo = {
    findById: async (id) => (Number(id) === 10 ? { id: 10, name: 'Workspace 10', created_by: 1 } : null),
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

  const mockNotificationRepo = {
    getSettings: async (wsId) => ({ ...notificationSettings, workspace_id: Number(wsId) }),
    updateSettings: async (wsId, settings) => {
      const existing = notificationSettings;
      notificationSettings = {
        workspace_id: Number(wsId),
        notify_on_open: settings.notify_on_open !== undefined ? Boolean(settings.notify_on_open) : existing.notify_on_open,
        notify_on_resolve: settings.notify_on_resolve !== undefined ? Boolean(settings.notify_on_resolve) : existing.notify_on_resolve,
      };
      return notificationSettings;
    },
    getRecipients: async (wsId) => notificationRecipients,
    setRecipients: async (wsId, userIds) => {
      const validMembers = memberships.filter((m) => m.workspace_id === Number(wsId));
      const validMemberIds = new Set(validMembers.map((m) => m.user_id));

      for (const uid of userIds) {
        if (!validMemberIds.has(Number(uid))) {
          const err = new AppError(`User ID ${uid} is not an authorized member of workspace ${wsId}`, 400);
          throw err;
        }
      }

      notificationRecipients = userIds.map((uid) => {
        const u = users.find((user) => user.id === Number(uid));
        const m = memberships.find((mem) => mem.workspace_id === Number(wsId) && mem.user_id === Number(uid));
        return { id: u.id, user_id: u.id, email: u.email, display_name: u.display_name, role: m.role };
      });
      return notificationRecipients;
    },
  };

  const realAuth = createAuthMiddleware({
    userRepo: mockUserRepo,
    workspaceRepo: mockWorkspaceRepo,
  });

  const testAuth = {
    requireAuth: async (req, _res, next) => {
      const userId = Number(req.headers['x-test-user-id']);
      if (!userId) return next(new AppError('Auth required', 401));
      const user = await mockUserRepo.findById(userId);
      if (!user) return next(new AppError('User not found', 401));
      req.user = user;
      next();
    },
    requireWorkspaceMember: realAuth.requireWorkspaceMember,
    requireWorkspaceOwner: realAuth.requireWorkspaceOwner,
  };

  const workspaceRouter = createWorkspaceRouter({
    workspaceRepo: mockWorkspaceRepo,
    notificationRepo: mockNotificationRepo,
    requireAuth: testAuth.requireAuth,
    requireWorkspaceMember: testAuth.requireWorkspaceMember,
    requireWorkspaceOwner: testAuth.requireWorkspaceOwner,
    config: loadConfig({ LOG_LEVEL: 'silent' }),
  });

  const app = createApp({
    workspaceRouter,
    csrfProtection: (_req, _res, next) => next(),
    config: loadConfig({ LOG_LEVEL: 'silent', APP_ORIGIN: 'http://localhost:5000' }),
  });

  return { app, mockNotificationRepo, mockWorkspaceRepo };
}

test('Workspace Notification Settings — Regression & Integrity Suite', async (t) => {
  const { app } = setupTestHarness();

  await t.test('1. Member read query returns valid numeric user_id and id for all members', async () => {
    const res = await request(app)
      .get('/api/workspaces/10/notification-settings')
      .set('x-test-user-id', '1');

    assert.equal(res.status, 200);
    assert.equal(res.body.members.length, 2);

    for (const member of res.body.members) {
      assert.ok(typeof member.user_id === 'number', 'member.user_id must be a number');
      assert.ok(typeof member.id === 'number', 'member.id must be a number');
      assert.equal(member.user_id, member.id, 'user_id and id must both represent the user identifier');
      assert.ok(member.user_id > 0, 'user_id must be a positive integer');
    }
  });

  await t.test('2. Owner selection: selecting owner user ID persists successfully', async () => {
    const res = await request(app)
      .put('/api/workspaces/10/notification-settings')
      .set('x-test-user-id', '1')
      .send({
        notify_on_open: true,
        notify_on_resolve: true,
        recipient_user_ids: [1],
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.recipients.length, 1);
    assert.equal(res.body.recipients[0].id, 1);
    assert.equal(res.body.recipients[0].user_id, 1);
    assert.equal(res.body.recipients[0].role, 'owner');
  });

  await t.test('3. Member selection: selecting non-owner member persists successfully', async () => {
    const res = await request(app)
      .put('/api/workspaces/10/notification-settings')
      .set('x-test-user-id', '1')
      .send({
        recipient_user_ids: [2],
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.recipients.length, 1);
    assert.equal(res.body.recipients[0].id, 2);
    assert.equal(res.body.recipients[0].user_id, 2);
    assert.equal(res.body.recipients[0].role, 'member');
  });

  await t.test('4. Multiple recipients: selecting both owner and member persists both', async () => {
    const res = await request(app)
      .put('/api/workspaces/10/notification-settings')
      .set('x-test-user-id', '1')
      .send({
        recipient_user_ids: [1, 2],
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.recipients.length, 2);
    const ids = res.body.recipients.map((r) => r.id);
    assert.ok(ids.includes(1) && ids.includes(2));
  });

  await t.test('5. Empty recipient selection: passing empty array clears recipients safely', async () => {
    const res = await request(app)
      .put('/api/workspaces/10/notification-settings')
      .set('x-test-user-id', '1')
      .send({
        recipient_user_ids: [],
      });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.recipients, []);
  });

  await t.test('6. Invalid input: null recipient ID is rejected by schema with 400', async () => {
    const res = await request(app)
      .put('/api/workspaces/10/notification-settings')
      .set('x-test-user-id', '1')
      .send({
        recipient_user_ids: [null],
      });

    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes('recipient_user_ids') || res.body.details);
  });

  await t.test('7. Invalid input: non-positive and non-integer recipient IDs are rejected', async () => {
    const zeroRes = await request(app)
      .put('/api/workspaces/10/notification-settings')
      .set('x-test-user-id', '1')
      .send({ recipient_user_ids: [0] });
    assert.equal(zeroRes.status, 400);

    const negRes = await request(app)
      .put('/api/workspaces/10/notification-settings')
      .set('x-test-user-id', '1')
      .send({ recipient_user_ids: [-1] });
    assert.equal(negRes.status, 400);

    const strRes = await request(app)
      .put('/api/workspaces/10/notification-settings')
      .set('x-test-user-id', '1')
      .send({ recipient_user_ids: ['invalid'] });
    assert.equal(strRes.status, 400);
  });

  await t.test('8. Unauthorized recipient rejection: external user ID is rejected', async () => {
    const res = await request(app)
      .put('/api/workspaces/10/notification-settings')
      .set('x-test-user-id', '1')
      .send({
        recipient_user_ids: [3], // User 3 is not in Workspace 10
      });

    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes('not an authorized member'));
  });

  await t.test('9. Existing notification settings are preserved when only updating recipients', async () => {
    // First, set notify_on_open to false
    await request(app)
      .put('/api/workspaces/10/notification-settings')
      .set('x-test-user-id', '1')
      .send({
        notify_on_open: false,
        notify_on_resolve: true,
        recipient_user_ids: [1],
      });

    // Update only recipients without passing notify_on_open
    const res = await request(app)
      .put('/api/workspaces/10/notification-settings')
      .set('x-test-user-id', '1')
      .send({
        recipient_user_ids: [2],
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.settings.notify_on_open, false, 'notify_on_open: false must be preserved');
    assert.equal(res.body.settings.notify_on_resolve, true);
  });

  await t.test('10. Persistence and retrieval: GET reflects previous PUT updates', async () => {
    await request(app)
      .put('/api/workspaces/10/notification-settings')
      .set('x-test-user-id', '1')
      .send({
        notify_on_open: true,
        notify_on_resolve: false,
        recipient_user_ids: [1, 2],
      });

    const getRes = await request(app)
      .get('/api/workspaces/10/notification-settings')
      .set('x-test-user-id', '1');

    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.settings.notify_on_open, true);
    assert.equal(getRes.body.settings.notify_on_resolve, false);
    assert.equal(getRes.body.recipients.length, 2);
    assert.equal(getRes.body.canEdit, true);
  });
});
