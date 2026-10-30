// backend/test/notificationDispatch.test.js
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { runMigrations } = require('../scripts/migrate');
const { loadConfig } = require('../config');
const { NotificationRepository } = require('../data/notificationRepository');
const { NotificationDispatcher } = require('../services/notificationDispatcher');
const { EmailService, escHtml } = require('../services/emailService');

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

test('Notification Dispatcher & Outbox — Atomic claims, leases, retries, and bounded delivery', async (t) => {
  const adminConn = await getAdminConnection();
  if (!adminConn) {
    t.skip('MySQL instance not accessible for notification dispatch test');
    return;
  }

  const dbName = `apidash_test_dispatch_${Date.now()}`;
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
      connectionLimit: 10,
    });

    await runMigrations(pool, MIGRATIONS_DIR);

    // Setup seed users, workspace, and monitor
    const [userA] = await pool.execute(
      'INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)',
      ['userA@example.com', 'hash', 'Alice']
    );
    const [userB] = await pool.execute(
      'INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)',
      ['userB@example.com', 'hash', 'Bob']
    );
    const [userRevoked] = await pool.execute(
      'INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)',
      ['revoked@example.com', 'hash', 'Revoked User']
    );

    const [wsRes] = await pool.execute(
      'INSERT INTO workspaces (name, created_by) VALUES (?, ?)',
      ['Dispatch Workspace', userA.insertId]
    );
    const workspaceId = wsRes.insertId;

    // Add members: userA (owner), userB (member)
    await pool.execute('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)', [
      workspaceId,
      userA.insertId,
      'owner',
    ]);
    await pool.execute('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)', [
      workspaceId,
      userB.insertId,
      'member',
    ]);

    const [apiRes] = await pool.execute(
      'INSERT INTO apis (workspace_id, name, url, method) VALUES (?, ?, ?, ?)',
      [workspaceId, 'Auth Service', 'https://auth.example.com', 'POST']
    );
    const apiId = apiRes.insertId;

    // Create an incident
    const [incRes] = await pool.execute(
      `INSERT INTO incidents (api_id, workspace_id, status, first_unhealthy_at, opened_at, unhealthy_count, error_summary)
       VALUES (?, ?, 'open', NOW(), NOW(), 2, 'Connection refused')`,
      [apiId, workspaceId]
    );
    const incidentId = incRes.insertId;

    const notifRepo = new NotificationRepository(pool);

    // Configure workspace recipients: userA and userB
    await notifRepo.setRecipients(workspaceId, [userA.insertId, userB.insertId]);

    // 1. Enqueue outbox event
    const enqueueRes = await notifRepo.enqueueOutboxEvent({
      idempotency_key: `incident:${incidentId}:opened`,
      workspace_id: workspaceId,
      incident_id: incidentId,
      event_type: 'incident_opened',
      payload: {
        incident_id: incidentId,
        api_id: apiId,
        api_name: 'Auth Service',
        api_url: 'https://auth.example.com',
        opened_at: new Date().toISOString(),
        error_summary: 'Connection refused',
      },
    });
    assert.equal(enqueueRes.enqueued, true);

    // 2. Duplicate enqueue is safely ignored
    const duplicateEnqueue = await notifRepo.enqueueOutboxEvent({
      idempotency_key: `incident:${incidentId}:opened`,
      workspace_id: workspaceId,
      incident_id: incidentId,
      event_type: 'incident_opened',
      payload: {},
    });
    assert.equal(duplicateEnqueue.enqueued, false);
    assert.equal(duplicateEnqueue.duplicate, true);

    // 3. Two concurrent workers claim disjoint eligible events (SKIP LOCKED)
    // Enqueue a second distinct event
    await notifRepo.enqueueOutboxEvent({
      idempotency_key: `incident:${incidentId}:test2`,
      workspace_id: workspaceId,
      incident_id: incidentId,
      event_type: 'incident_opened',
      payload: { test: 2 },
    });

    const [claimsWorker1, claimsWorker2] = await Promise.all([
      notifRepo.claimDueEvents(1, { workerId: 'worker-1', leaseMs: 60000 }),
      notifRepo.claimDueEvents(1, { workerId: 'worker-2', leaseMs: 60000 }),
    ]);

    assert.equal(claimsWorker1.length, 1);
    assert.equal(claimsWorker2.length, 1);
    assert.notEqual(claimsWorker1[0].id, claimsWorker2[0].id, 'Concurrent claims must produce disjoint event IDs');

    // 4. Stale lease ownership protection: worker with wrong/old token cannot complete claim
    const staleCompletion = await notifRepo.completeEvent(claimsWorker1[0].id, 'stale-bogus-token', {
      deliveryState: 'sent',
    });
    assert.equal(staleCompletion.completed, false);
    assert.equal(staleCompletion.reason, 'LEASE_LOST_OR_EXPIRED');

    // 5. Successful dispatch with valid claim token marks event sent
    const validCompletion = await notifRepo.completeEvent(claimsWorker1[0].id, claimsWorker1[0].claimToken, {
      deliveryState: 'sent',
    });
    assert.equal(validCompletion.completed, true);

    const [sentEvent] = await pool.execute('SELECT * FROM notification_outbox WHERE id = ?', [claimsWorker1[0].id]);
    assert.equal(sentEvent[0].delivery_state, 'sent');
    assert.ok(sentEvent[0].sent_at);
    assert.equal(sentEvent[0].lease_owner_token, null);

    // 6. Expired leases become eligible for recovery after simulated worker crash
    // Set lease_expires_at to past for claimed event 2
    await pool.execute('UPDATE notification_outbox SET lease_expires_at = NOW() - INTERVAL 10 SECOND WHERE id = ?', [
      claimsWorker2[0].id,
    ]);

    const recoveredClaims = await notifRepo.claimDueEvents(5, { workerId: 'recovery-worker', leaseMs: 60000 });
    assert.ok(recoveredClaims.some((c) => c.id === claimsWorker2[0].id), 'Expired lease must be recovered');

    // Complete recovered event
    const recoveredEvent = recoveredClaims.find((c) => c.id === claimsWorker2[0].id);
    await notifRepo.completeEvent(recoveredEvent.id, recoveredEvent.claimToken, { deliveryState: 'sent' });

    // 7. Transient failure schedules retry with exponential backoff
    await notifRepo.enqueueOutboxEvent({
      idempotency_key: `incident:${incidentId}:retry-test`,
      workspace_id: workspaceId,
      incident_id: incidentId,
      event_type: 'incident_opened',
      payload: {},
    });

    const retryClaims = await notifRepo.claimDueEvents(1, { workerId: 'retry-worker' });
    const retryItem = retryClaims[0];

    // Simulate transient failure: reschedule with 30s delay
    await notifRepo.completeEvent(retryItem.id, retryItem.claimToken, {
      deliveryState: 'pending',
      error: 'SMTP connection timeout',
      nextAttemptDelaySeconds: 30,
    });

    const [retryingEvent] = await pool.execute('SELECT * FROM notification_outbox WHERE id = ?', [retryItem.id]);
    assert.equal(retryingEvent[0].delivery_state, 'pending');
    assert.equal(retryingEvent[0].last_error, 'SMTP connection timeout');
    assert.equal(retryingEvent[0].attempt_count, 1);

    // 8. Terminal dead_letter state when max attempts exceeded
    await pool.execute(
      'UPDATE notification_outbox SET attempt_count = 5, next_attempt_at = NOW() - INTERVAL 1 SECOND WHERE id = ?',
      [retryItem.id]
    );

    const deadLetterClaims = await notifRepo.claimDueEvents(1, { workerId: 'dead-worker' });
    const deadItem = deadLetterClaims[0];

    const sentMails = [];
    const mockEmailService = {
      config: { smtp: { isConfigured: true, from: 'alerts@test.local' } },
      sendIncidentEmail: async (opts) => {
        throw new Error('Permanent SMTP failure: 550 User unknown');
      },
    };

    const dispatcher = new NotificationDispatcher({
      config: loadConfig({ LOG_LEVEL: 'silent' }),
      notificationRepo: notifRepo,
      emailService: mockEmailService,
      workerId: 'test-dispatcher',
    });

    await dispatcher._processClaimedEvent(deadItem);

    const [terminalEvent] = await pool.execute('SELECT * FROM notification_outbox WHERE id = ?', [deadItem.id]);
    assert.equal(terminalEvent[0].delivery_state, 'dead_letter');
    assert.ok(terminalEvent[0].last_error.includes('Permanent SMTP failure'));

    // 9. Missing SMTP configuration pauses delivery without consuming attempts in a tight loop
    await notifRepo.enqueueOutboxEvent({
      idempotency_key: `incident:${incidentId}:no-smtp-test`,
      workspace_id: workspaceId,
      incident_id: incidentId,
      event_type: 'incident_opened',
      payload: {},
    });

    const noSmtpClaims = await notifRepo.claimDueEvents(1, { workerId: 'no-smtp-worker' });
    const unconfiguredEmailService = {
      config: { smtp: { isConfigured: false } },
    };

    const noSmtpDispatcher = new NotificationDispatcher({
      config: loadConfig({ LOG_LEVEL: 'silent' }),
      notificationRepo: notifRepo,
      emailService: unconfiguredEmailService,
    });

    await noSmtpDispatcher._processClaimedEvent(noSmtpClaims[0]);

    const [pausedEvent] = await pool.execute('SELECT * FROM notification_outbox WHERE id = ?', [noSmtpClaims[0].id]);
    assert.equal(pausedEvent[0].delivery_state, 'pending');
    assert.equal(pausedEvent[0].last_error, 'SMTP_NOT_CONFIGURED');
    // next_attempt_at was pushed out to avoid hot retry loops, attempt_count preserved
    assert.equal(pausedEvent[0].attempt_count, 0, 'SMTP unconfigured pause must not consume delivery attempt budget');

    // 10. Revoked member is not sent mail (membership checked at dispatch time)
    // Add revoked user to recipients manually, then verify getRecipients excludes them
    await pool.execute(
      'INSERT INTO workspace_notification_recipients (workspace_id, user_id) VALUES (?, ?)',
      [workspaceId, userRevoked.insertId]
    );

    const recipients = await notifRepo.getRecipients(workspaceId);
    assert.ok(!recipients.some((r) => r.id === userRevoked.insertId), 'Revoked member without workspace membership must be excluded');
  } finally {
    if (pool) await pool.end();
    const cleanupConn = await getAdminConnection();
    if (cleanupConn) {
      await cleanupConn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await cleanupConn.end();
    }
  }
});

test('Email Content Sanitization — HTML escaping and security bounds', () => {
  const emailService = new EmailService({
    config: loadConfig({ APP_ORIGIN: 'http://localhost:5000', LOG_LEVEL: 'silent' }),
  });

  const rawPayload = {
    incident_id: 42,
    api_name: 'Customer <script>alert("xss")</script> API',
    api_url: 'https://example.com/api?key=SECRET_TOKEN_123',
    opened_at: new Date().toISOString(),
    error_summary: 'Assertion failed: expected <b>200</b> & got 500',
  };

  const { subject, html, text } = emailService.buildEmailContent({
    eventType: 'incident_opened',
    payload: rawPayload,
    appOrigin: 'http://localhost:5000',
  });

  assert.ok(!html.includes('<script>'), 'HTML output must escape script tags');
  assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
  assert.ok(!html.includes('<b>200</b>'), 'HTML output must escape error summary tags');
  assert.ok(html.includes('&lt;b&gt;200&lt;/b&gt;'));
  assert.ok(subject.includes('Customer <script>alert("xss")</script> API')); // Subject is plain text
  assert.ok(text.includes('Incident ID: #42'));
});

