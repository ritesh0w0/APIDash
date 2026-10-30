// backend/test/phase5ReliabilityHardening.test.js
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const request = require('supertest');

const { runMigrations } = require('../scripts/migrate');
const { loadConfig, ConfigError } = require('../config');
const { createApp } = require('../app');
const { NotificationRepository } = require('../data/notificationRepository');
const { NotificationDispatcher } = require('../services/notificationDispatcher');
const { EmailService } = require('../services/emailService');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function getAdminConnection() {
  const config = loadConfig();
  try {
    const conn = await mysql.createConnection({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
    });
    return conn;
  } catch (_err) {
    return null;
  }
}

test('Reliability Hardening 1: Zero-recipient and disabled-event suppression on disposable DB', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible');
    return;
  }

  const dbName = `apidash_test_suppression_${Date.now()}`;
  let pool = null;

  try {
    await adminConn.execute(`CREATE DATABASE \`${dbName}\``);
    await adminConn.end();

    const config = loadConfig();
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: dbName,
      connectionLimit: 5,
    });

    await runMigrations(pool, MIGRATIONS_DIR);

    const notifRepo = new NotificationRepository(pool);

    // Setup base workspace, user, and incident
    const [userRes] = await pool.execute(
      'INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)',
      ['owner@example.com', 'dummy_hash', 'Workspace Owner']
    );
    const userId = userRes.insertId;

    const [wsRes] = await pool.execute(
      'INSERT INTO workspaces (name, created_by) VALUES (?, ?)',
      ['Suppression Test WS', userId]
    );
    const workspaceId = wsRes.insertId;

    await pool.execute(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, "owner")',
      [workspaceId, userId]
    );

    const [apiRes] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method) VALUES (?, ?, ?, "GET")',
      [workspaceId, 'Target API', 'https://api.example.com/test']
    );
    const apiId = apiRes.insertId;

    const [incRes] = await pool.execute(
      'INSERT INTO incidents (workspace_id, api_id, status, first_unhealthy_at, opened_at, unhealthy_count) VALUES (?, ?, "open", NOW(), NOW(), 2)',
      [workspaceId, apiId]
    );
    const incidentId = incRes.insertId;

    // Subtest A: Opening notification disabled in settings -> suppressed
    await notifRepo.updateSettings(workspaceId, { notify_on_open: false, notify_on_resolve: true });
    await notifRepo.enqueueOutboxEvent({
      idempotency_key: `suppress-test-open-${Date.now()}`,
      workspace_id: workspaceId,
      incident_id: incidentId,
      event_type: 'incident_opened',
      payload: { api_name: 'Target API', incident_id: incidentId },
    });

    const sentEmails = [];
    const mockEmailService = {
      config: { smtp: { isConfigured: true } },
      sendIncidentEmail: async (opts) => {
        sentEmails.push(opts);
        return { messageId: 'msg-1' };
      },
    };

    const dispatcher = new NotificationDispatcher({
      config: loadConfig({ LOG_LEVEL: 'silent' }),
      notificationRepo: notifRepo,
      emailService: mockEmailService,
      workerId: 'suppress-worker',
    });

    const claimsA = await notifRepo.claimDueEvents(1);
    assert.equal(claimsA.length, 1);
    await dispatcher._processClaimedEvent(claimsA[0]);

    const [rowA] = await pool.execute('SELECT * FROM notification_outbox WHERE id = ?', [claimsA[0].id]);
    assert.equal(rowA[0].delivery_state, 'suppressed');
    assert.equal(rowA[0].last_error, 'DISABLED_IN_SETTINGS_OPEN');
    assert.equal(rowA[0].sent_at, null);
    assert.equal(sentEmails.length, 0, 'No email must be sent when disabled in settings');

    // Subtest B: Resolution notification disabled in settings -> suppressed
    await notifRepo.updateSettings(workspaceId, { notify_on_open: true, notify_on_resolve: false });
    await notifRepo.enqueueOutboxEvent({
      idempotency_key: `suppress-test-resolve-${Date.now()}`,
      workspace_id: workspaceId,
      incident_id: incidentId,
      event_type: 'incident_resolved',
      payload: { api_name: 'Target API', incident_id: incidentId },
    });

    const claimsB = await notifRepo.claimDueEvents(1);
    assert.equal(claimsB.length, 1);
    await dispatcher._processClaimedEvent(claimsB[0]);

    const [rowB] = await pool.execute('SELECT * FROM notification_outbox WHERE id = ?', [claimsB[0].id]);
    assert.equal(rowB[0].delivery_state, 'suppressed');
    assert.equal(rowB[0].last_error, 'DISABLED_IN_SETTINGS_RESOLVE');
    assert.equal(rowB[0].sent_at, null);
    assert.equal(sentEmails.length, 0);

    // Subtest C: Notifications enabled, but zero recipients configured -> suppressed
    await notifRepo.updateSettings(workspaceId, { notify_on_open: true, notify_on_resolve: true });
    // recipients list is empty
    await notifRepo.enqueueOutboxEvent({
      idempotency_key: `suppress-test-no-recipients-${Date.now()}`,
      workspace_id: workspaceId,
      incident_id: incidentId,
      event_type: 'incident_opened',
      payload: { api_name: 'Target API', incident_id: incidentId },
    });

    const claimsC = await notifRepo.claimDueEvents(1);
    assert.equal(claimsC.length, 1);
    await dispatcher._processClaimedEvent(claimsC[0]);

    const [rowC] = await pool.execute('SELECT * FROM notification_outbox WHERE id = ?', [claimsC[0].id]);
    assert.equal(rowC[0].delivery_state, 'suppressed');
    assert.equal(rowC[0].last_error, 'ZERO_RECIPIENTS_CONFIGURED');
    assert.equal(rowC[0].sent_at, null);

    // Terminal verification: suppressed rows are never re-claimed
    const subsequentClaims = await notifRepo.claimDueEvents(10);
    assert.equal(subsequentClaims.length, 0, 'Suppressed events must be in a terminal state and never re-claimed');
  } finally {
    if (pool) await pool.end();
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});

test('Reliability Hardening 2: Dynamic membership re-evaluation prevents sending mail to revoked members', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible');
    return;
  }

  const dbName = `apidash_test_membership_${Date.now()}`;
  let pool = null;

  try {
    await adminConn.execute(`CREATE DATABASE \`${dbName}\``);
    await adminConn.end();

    const config = loadConfig();
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: dbName,
      connectionLimit: 5,
    });

    await runMigrations(pool, MIGRATIONS_DIR);
    const notifRepo = new NotificationRepository(pool);

    // Setup workspace with 2 members: Alice (owner) and Bob (member)
    const [u1] = await pool.execute('INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)', [
      'alice@example.com',
      'hash',
      'Alice',
    ]);
    const aliceId = u1.insertId;

    const [u2] = await pool.execute('INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)', [
      'bob@example.com',
      'hash',
      'Bob',
    ]);
    const bobId = u2.insertId;

    const [ws] = await pool.execute('INSERT INTO workspaces (name, created_by) VALUES (?, ?)', ['Member Test WS', aliceId]);
    const workspaceId = ws.insertId;

    await pool.execute('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, "owner")', [workspaceId, aliceId]);
    await pool.execute('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, "member")', [workspaceId, bobId]);

    // Configure BOTH Alice and Bob as notification recipients
    await notifRepo.setRecipients(workspaceId, [aliceId, bobId]);

    const [apiRes] = await pool.execute('INSERT INTO apis (workspace_id, name, url, method) VALUES (?, ?, ?, "GET")', [
      workspaceId,
      'Test API',
      'https://example.com',
    ]);
    const [incRes] = await pool.execute(
      'INSERT INTO incidents (workspace_id, api_id, status, first_unhealthy_at, opened_at, unhealthy_count) VALUES (?, ?, "open", NOW(), NOW(), 2)',
      [workspaceId, apiRes.insertId]
    );
    const incidentId = incRes.insertId;

    // 1. Enqueue outbox event while both Alice and Bob are members
    await notifRepo.enqueueOutboxEvent({
      idempotency_key: `event-alice-bob-${Date.now()}`,
      workspace_id: workspaceId,
      incident_id: incidentId,
      event_type: 'incident_opened',
      payload: { api_name: 'Test API', incident_id: incidentId },
    });

    // 2. Bob is revoked/removed from workspace BEFORE dispatcher processes the event
    await pool.execute('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [workspaceId, bobId]);

    // 3. Dispatch event
    let capturedRecipients = null;
    const mockEmailService = {
      config: { smtp: { isConfigured: true } },
      sendIncidentEmail: async ({ recipients }) => {
        capturedRecipients = recipients;
        return { messageId: 'msg-membership-1' };
      },
    };

    const dispatcher = new NotificationDispatcher({
      config: loadConfig({ LOG_LEVEL: 'silent' }),
      notificationRepo: notifRepo,
      emailService: mockEmailService,
      workerId: 'membership-worker',
    });

    const claims = await notifRepo.claimDueEvents(1);
    assert.equal(claims.length, 1);
    await dispatcher._processClaimedEvent(claims[0]);

    // Alice received email; Bob was strictly excluded because he is no longer an active workspace member
    assert.deepEqual(capturedRecipients, ['alice@example.com']);

    // 4. Now Alice is also removed from workspace
    await pool.execute('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [workspaceId, aliceId]);

    // Enqueue another event
    await notifRepo.enqueueOutboxEvent({
      idempotency_key: `event-all-revoked-${Date.now()}`,
      workspace_id: workspaceId,
      incident_id: incidentId,
      event_type: 'incident_resolved',
      payload: { api_name: 'Test API', incident_id: incidentId },
    });

    const claims2 = await notifRepo.claimDueEvents(1);
    assert.equal(claims2.length, 1);
    capturedRecipients = null;
    await dispatcher._processClaimedEvent(claims2[0]);

    const [row] = await pool.execute('SELECT * FROM notification_outbox WHERE id = ?', [claims2[0].id]);
    assert.equal(row[0].delivery_state, 'suppressed');
    assert.equal(row[0].last_error, 'ALL_RECIPIENTS_REVOKED');
    assert.equal(capturedRecipients, null, 'No email must be sent when all recipients are revoked');
  } finally {
    if (pool) await pool.end();
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});

test('Reliability Hardening 3: Bounded transport timeouts and unexpired lease protection', async (t) => {
  // Test A: Configuration safety enforces OUTBOX_LEASE_MS >= total SMTP transport timeout
  assert.throws(
    () => {
      loadConfig({
        OUTBOX_LEASE_MS: '35000',
        SMTP_CONNECTION_TIMEOUT_MS: '20000',
        SMTP_GREETING_TIMEOUT_MS: '15000',
        SMTP_SOCKET_TIMEOUT_MS: '15000', // total 50,000ms > 35,000ms lease!
      });
    },
    (err) => {
      return err instanceof ConfigError && err.message.includes('OUTBOX_LEASE_MS (35000ms) must be greater than');
    }
  );

  // Test A2: EmailService enforces hard wall-clock deadline and forcibly closes lingering transport
  let closed = false;
  const mockSlowTransporter = {
    sendMail: async () => {
      // Simulate slow hanging socket that exceeds deadline
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { messageId: 'too-late' };
    },
    close: () => {
      closed = true;
    },
  };

  const slowEmailService = new EmailService({
    config: {
      smtp: {
        isConfigured: true,
        from: 'alerts@test.local',
        deliveryDeadlineMs: 20, // 20ms hard deadline
      },
      appOrigin: 'http://localhost:5000',
    },
    transporter: mockSlowTransporter,
  });

  await assert.rejects(
    async () => {
      await slowEmailService.sendIncidentEmail({
        recipients: ['admin@example.com'],
        eventType: 'incident_opened',
        payload: { api_name: 'Slow Monitor', incident_id: 99 },
      });
    },
    (err) => {
      assert.equal(err.code, 'ETIMEDOUT');
      assert.ok(err.message.includes('hard wall-clock deadline'));
      assert.equal(closed, true, 'Transporter must be forcibly closed on wall-clock timeout');
      return true;
    }
  );

  // Test B: Live unexpired lease protection and abandoned lease recovery on disposable DB
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible');
    return;
  }

  const dbName = `apidash_test_lease_${Date.now()}`;
  let pool = null;

  try {
    await adminConn.execute(`CREATE DATABASE \`${dbName}\``);
    await adminConn.end();

    const config = loadConfig();
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: dbName,
      connectionLimit: 5,
    });

    await runMigrations(pool, MIGRATIONS_DIR);
    const notifRepo = new NotificationRepository(pool);

    const [u] = await pool.execute('INSERT INTO users (email, password_hash, display_name) VALUES ("u@test.local", "hash", "Lease User")');
    const [ws] = await pool.execute('INSERT INTO workspaces (name, created_by) VALUES ("Lease WS", ?)', [u.insertId]);
    await pool.execute('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, "owner")', [ws.insertId, u.insertId]);
    const [api] = await pool.execute('INSERT INTO apis (workspace_id, name, url, method) VALUES (?, "API", "https://t", "GET")', [ws.insertId]);
    const [inc] = await pool.execute('INSERT INTO incidents (workspace_id, api_id, status, first_unhealthy_at, opened_at) VALUES (?, ?, "open", NOW(), NOW())', [ws.insertId, api.insertId]);

    await notifRepo.enqueueOutboxEvent({
      idempotency_key: `lease-protection-test-${Date.now()}`,
      workspace_id: ws.insertId,
      incident_id: inc.insertId,
      event_type: 'incident_opened',
      payload: {},
    });

    // Worker 1 claims event with 60-second lease
    const claimsWorker1 = await notifRepo.claimDueEvents(1, { workerId: 'worker-1', leaseMs: 60000 });
    assert.equal(claimsWorker1.length, 1);
    const claimedEvent = claimsWorker1[0];

    // Worker 2 attempts concurrent claim while Worker 1 is still processing (lease active)
    const claimsWorker2 = await notifRepo.claimDueEvents(1, { workerId: 'worker-2', leaseMs: 60000 });
    assert.equal(claimsWorker2.length, 0, 'Unexpired lease held by Worker 1 must not be claimed by Worker 2');

    // Worker 1 completes delivery successfully
    const completion = await notifRepo.completeEvent(claimedEvent.id, claimedEvent.claimToken, {
      deliveryState: 'sent',
    });
    assert.equal(completion.completed, true);

    // Stale completion attempt with wrong or expired token fails safely
    const staleCompletion = await notifRepo.completeEvent(claimedEvent.id, 'stale-token-xyz', {
      deliveryState: 'sent',
    });
    assert.equal(staleCompletion.completed, false);
    assert.equal(staleCompletion.reason, 'LEASE_LOST_OR_EXPIRED');

    // Test C: Abandoned expired lease is safely recovered by concurrent worker
    await notifRepo.enqueueOutboxEvent({
      idempotency_key: `abandoned-lease-test-${Date.now()}`,
      workspace_id: ws.insertId,
      incident_id: inc.insertId,
      event_type: 'incident_resolved',
      payload: {},
    });

    const [abandonedClaim] = await notifRepo.claimDueEvents(1, { workerId: 'crashed-worker' });
    // Simulate worker crash before completion: lease expires in past
    await pool.execute(
      'UPDATE notification_outbox SET lease_expires_at = DATE_SUB(NOW(), INTERVAL 5 SECOND) WHERE id = ?',
      [abandonedClaim.id]
    );

    // Recovery worker claims the expired event
    const recoveryClaims = await notifRepo.claimDueEvents(1, { workerId: 'recovery-worker' });
    assert.equal(recoveryClaims.length, 1);
    assert.equal(recoveryClaims[0].id, abandonedClaim.id);
  } finally {
    if (pool) await pool.end();
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});

test('Reliability Hardening 4: Workspace notification settings authorization and validation', async () => {
  // Test harness with 3 users: Owner, Member, and Stranger
  const users = [
    { id: 10, email: 'owner@example.com', display_name: 'Owner' },
    { id: 20, email: 'member@example.com', display_name: 'Member' },
    { id: 30, email: 'stranger@example.com', display_name: 'Stranger' },
  ];

  const workspaces = [{ id: 100, name: 'Secure WS', created_by: 10 }];

  const memberships = [
    { id: 1, workspace_id: 100, user_id: 10, role: 'owner' },
    { id: 2, workspace_id: 100, user_id: 20, role: 'member' },
  ];

  let currentSettings = { workspace_id: 100, notify_on_open: true, notify_on_resolve: true };
  let currentRecipients = [{ id: 10, email: 'owner@example.com', display_name: 'Owner', role: 'owner' }];

  const mockNotificationRepo = {
    getSettings: async () => currentSettings,
    updateSettings: async (_wsId, patch) => {
      currentSettings = { ...currentSettings, ...patch };
      return currentSettings;
    },
    getRecipients: async () => currentRecipients,
    setRecipients: async (wsId, userIds) => {
      // Validate members
      for (const uid of userIds) {
        if (!memberships.some((m) => m.workspace_id === wsId && m.user_id === uid)) {
          const err = new Error(`User ID ${uid} is not an authorized member of workspace ${wsId}`);
          err.statusCode = 400;
          throw err;
        }
      }
      currentRecipients = users
        .filter((u) => userIds.includes(u.id))
        .map((u) => ({ ...u, role: memberships.find((m) => m.user_id === u.id).role }));
      return currentRecipients;
    },
  };

  const mockWorkspaceRepo = {
    findById: async (id) => workspaces.find((w) => w.id === id) || null,
    findMembership: async (wsId, userId) => memberships.find((m) => m.workspace_id === wsId && m.user_id === userId) || null,
    findMembers: async (wsId) =>
      memberships
        .filter((m) => m.workspace_id === wsId)
        .map((m) => {
          const u = users.find((usr) => usr.id === m.user_id);
          return { id: u.id, email: u.email, display_name: u.display_name, role: m.role };
        }),
  };

  const { createWorkspaceRouter } = require('../routes/workspaceRoutes');

  let authenticatedUser = null;
  const mockRequireAuth = (req, res, next) => {
    if (!authenticatedUser) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = authenticatedUser;
    next();
  };

  const mockRequireWorkspaceMember = async (req, res, next) => {
    const wsId = Number(req.params.workspaceId);
    req.workspaceId = wsId;
    const membership = await mockWorkspaceRepo.findMembership(wsId, req.user.id);
    if (!membership) {
      return res.status(404).json({ error: 'Workspace not found or access denied' });
    }
    req.membership = membership;
    next();
  };

  const mockRequireWorkspaceOwner = (req, res, next) => {
    if (!req.membership || req.membership.role !== 'owner') {
      return res.status(403).json({ error: 'Forbidden: Owner role required' });
    }
    next();
  };

  const router = createWorkspaceRouter({
    notificationRepo: mockNotificationRepo,
    workspaceRepo: mockWorkspaceRepo,
    requireAuth: mockRequireAuth,
    requireWorkspaceMember: mockRequireWorkspaceMember,
    requireWorkspaceOwner: mockRequireWorkspaceOwner,
  });

  const app = createApp({
    workspaceRouter: router,
    csrfProtection: (_req, _res, next) => next(),
    config: loadConfig({ LOG_LEVEL: 'silent' }),
  });

  // 1. Unauthenticated request -> 401
  authenticatedUser = null;
  const unauthRes = await request(app).get('/api/workspaces/100/notification-settings');
  assert.equal(unauthRes.status, 401);

  // 2. Stranger request -> 404 (access denied)
  authenticatedUser = users[2]; // Stranger
  const strangerRes = await request(app).get('/api/workspaces/100/notification-settings');
  assert.equal(strangerRes.status, 404);

  // 3. Member read request -> 200 with canEdit: false
  authenticatedUser = users[1]; // Member
  const memberGetRes = await request(app).get('/api/workspaces/100/notification-settings');
  assert.equal(memberGetRes.status, 200);
  assert.equal(memberGetRes.body.canEdit, false);
  assert.equal(memberGetRes.body.settings.notify_on_open, true);

  // 4. Member update request -> 403 Forbidden
  const memberPutRes = await request(app)
    .put('/api/workspaces/100/notification-settings')
    .send({ notify_on_open: false, recipient_user_ids: [20] });
  assert.equal(memberPutRes.status, 403);
  assert.ok(memberPutRes.body.error.includes('Owner role required'));

  // 5. Owner attempting to set non-member recipient (Stranger ID 30) -> 400 Bad Request
  authenticatedUser = users[0]; // Owner
  const badRecipientRes = await request(app)
    .put('/api/workspaces/100/notification-settings')
    .send({ notify_on_open: false, recipient_user_ids: [10, 30] });
  assert.equal(badRecipientRes.status, 400);
  assert.ok(badRecipientRes.body.error.includes('not an authorized member'));

  // 6. Owner updating with valid workspace members -> 200 OK
  const validPutRes = await request(app)
    .put('/api/workspaces/100/notification-settings')
    .send({ notify_on_open: false, notify_on_resolve: true, recipient_user_ids: [10, 20] });
  assert.equal(validPutRes.status, 200);
  assert.equal(validPutRes.body.settings.notify_on_open, false);
  assert.equal(validPutRes.body.recipients.length, 2);
});
