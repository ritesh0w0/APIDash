// backend/data/notificationRepository.js
'use strict';

const crypto = require('crypto');
const { getPool } = require('../db');

class NotificationRepository {
  constructor(pool = null) {
    this._pool = pool;
  }

  get pool() {
    return this._pool || getPool();
  }

  /**
   * Retrieves notification preferences for a workspace.
   *
   * @param {number} workspaceId
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<Object>}
   */
  async getSettings(workspaceId, conn = null) {
    const executor = conn || this.pool;
    const [rows] = await executor.execute(
      'SELECT workspace_id, notify_on_open, notify_on_resolve FROM workspace_notification_settings WHERE workspace_id = ?',
      [workspaceId]
    );

    if (rows.length > 0) {
      return {
        workspace_id: workspaceId,
        notify_on_open: Boolean(rows[0].notify_on_open),
        notify_on_resolve: Boolean(rows[0].notify_on_resolve),
      };
    }

    return {
      workspace_id: workspaceId,
      notify_on_open: true,
      notify_on_resolve: true,
    };
  }

  /**
   * Upserts notification preferences for a workspace.
   *
   * @param {number} workspaceId
   * @param {Object} settings
   * @param {boolean} [settings.notify_on_open=true]
   * @param {boolean} [settings.notify_on_resolve=true]
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<Object>}
   */
  async updateSettings(workspaceId, settings, conn = null) {
    const executor = conn || this.pool;
    const existing = await this.getSettings(workspaceId, executor);
    const notifyOnOpen = settings.notify_on_open !== undefined ? Boolean(settings.notify_on_open) : existing.notify_on_open;
    const notifyOnResolve = settings.notify_on_resolve !== undefined ? Boolean(settings.notify_on_resolve) : existing.notify_on_resolve;

    await executor.execute(
      `INSERT INTO workspace_notification_settings (workspace_id, notify_on_open, notify_on_resolve)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         notify_on_open = VALUES(notify_on_open),
         notify_on_resolve = VALUES(notify_on_resolve),
         updated_at = NOW()`,
      [workspaceId, notifyOnOpen, notifyOnResolve]
    );

    return {
      workspace_id: workspaceId,
      notify_on_open: notifyOnOpen,
      notify_on_resolve: notifyOnResolve,
    };
  }

  /**
   * Retrieves authorized recipient users for a workspace.
   * Joins with workspace_members to strictly exclude revoked or non-members.
   *
   * @param {number} workspaceId
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<Array<Object>>}
   */
  async getRecipients(workspaceId, conn = null) {
    const executor = conn || this.pool;
    const [rows] = await executor.execute(
      `SELECT u.id, u.id AS user_id, u.email, u.display_name, wm.role
       FROM workspace_notification_recipients wnr
       JOIN workspace_members wm ON wm.workspace_id = wnr.workspace_id AND wm.user_id = wnr.user_id
       JOIN users u ON u.id = wnr.user_id
       WHERE wnr.workspace_id = ?
       ORDER BY u.display_name ASC, u.id ASC`,
      [workspaceId]
    );
    return rows;
  }

  /**
   * Returns total count of recipients configured in workspace_notification_recipients.
   * Used to distinguish between zero recipients configured vs all recipients revoked.
   *
   * @param {number} workspaceId
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<number>}
   */
  async getConfiguredRecipientCount(workspaceId, conn = null) {
    const executor = conn || this.pool;
    const [rows] = await executor.execute(
      'SELECT COUNT(*) AS cnt FROM workspace_notification_recipients WHERE workspace_id = ?',
      [workspaceId]
    );
    return Number(rows[0] ? rows[0].cnt : 0);
  }

  /**
   * Updates recipient user IDs for a workspace.
   * Validates each user against active workspace_members before associating.
   *
   * @param {number} workspaceId
   * @param {Array<number>} userIds
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<Array<Object>>}
   */
  async setRecipients(workspaceId, userIds, conn = null) {
    const localConn = !conn;
    const connection = conn || (await this.pool.getConnection());

    try {
      if (localConn) {
        await connection.beginTransaction();
      }

      // 1. Clear existing recipients for workspace
      await connection.execute(
        'DELETE FROM workspace_notification_recipients WHERE workspace_id = ?',
        [workspaceId]
      );

      // 2. Validate userIds are active workspace members
      const uniqueUserIds = Array.from(new Set(userIds.map((id) => Number(id)).filter(Boolean)));

      if (uniqueUserIds.length > 0) {
        const placeholders = uniqueUserIds.map(() => '?').join(', ');
        const [validMembers] = await connection.execute(
          `SELECT user_id FROM workspace_members WHERE workspace_id = ? AND user_id IN (${placeholders})`,
          [workspaceId, ...uniqueUserIds]
        );

        const validIdSet = new Set(validMembers.map((m) => m.user_id));

        for (const uid of uniqueUserIds) {
          if (!validIdSet.has(uid)) {
            const err = new Error(`User ID ${uid} is not an authorized member of workspace ${workspaceId}`);
            err.statusCode = 400;
            throw err;
          }
          await connection.execute(
            'INSERT INTO workspace_notification_recipients (workspace_id, user_id) VALUES (?, ?)',
            [workspaceId, uid]
          );
        }
      }

      if (localConn) {
        await connection.commit();
      }

      return this.getRecipients(workspaceId, connection);
    } catch (err) {
      if (localConn) {
        await connection.rollback();
      }
      throw err;
    } finally {
      if (localConn) {
        connection.release();
      }
    }
  }

  /**
   * Enqueues an outbox event idempotently inside a transaction.
   *
   * @param {Object} eventData
   * @param {import('mysql2/promise').Connection} conn
   * @returns {Promise<Object>}
   */
  async enqueueOutboxEvent(eventData, conn) {
    const executor = conn || this.pool;
    const {
      idempotency_key,
      workspace_id,
      incident_id,
      event_type,
      payload,
    } = eventData;

    const payloadJson = typeof payload === 'string' ? payload : JSON.stringify(payload);

    try {
      const [res] = await executor.execute(
        `INSERT INTO notification_outbox (
          idempotency_key, workspace_id, incident_id, event_type, delivery_state,
          payload, next_attempt_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, NOW())`,
        [idempotency_key, workspace_id, incident_id, event_type, payloadJson]
      );

      return {
        id: res.insertId,
        idempotency_key,
        enqueued: true,
      };
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY' || err.message.includes('Duplicate entry')) {
        // Event already exists (idempotency key collision)
        return {
          idempotency_key,
          enqueued: false,
          duplicate: true,
        };
      }
      throw err;
    }
  }

  /**
   * Claims due and eligible notification events using database clock and SKIP LOCKED.
   *
   * @param {number} limit
   * @param {Object} options
   * @param {string} options.workerId
   * @param {number} [options.leaseMs=60000]
   * @returns {Promise<Array<Object>>}
   */
  async claimDueEvents(limit = 5, options = {}) {
    const safeLimit = Math.max(1, Math.min(20, parseInt(limit, 10) || 5));
    const leaseSeconds = Math.max(35, Math.round((options.leaseMs || 60000) / 1000));
    const workerToken = options.workerId || `dispatcher-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const claimToken = `${workerToken}:${crypto.randomBytes(8).toString('hex')}`;

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      const [rows] = await conn.execute(
        `SELECT id, idempotency_key, workspace_id, incident_id, event_type, payload, attempt_count, max_attempts
         FROM notification_outbox
         WHERE delivery_state IN ('pending', 'processing')
           AND next_attempt_at <= NOW()
           AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
         ORDER BY next_attempt_at ASC
         LIMIT ${safeLimit}
         FOR UPDATE SKIP LOCKED`
      );

      if (rows.length === 0) {
        await conn.commit();
        return [];
      }

      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(', ');

      await conn.execute(
        `UPDATE notification_outbox
         SET
           delivery_state = 'processing',
           lease_owner_token = ?,
           lease_expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND),
           attempt_count = attempt_count + 1,
           updated_at = NOW()
         WHERE id IN (${placeholders})`,
        [claimToken, leaseSeconds, ...ids]
      );

      await conn.commit();

      return rows.map((r) => {
        let parsedPayload = r.payload;
        if (typeof parsedPayload === 'string') {
          try {
            parsedPayload = JSON.parse(parsedPayload);
          } catch (_e) {
            // Keep raw if JSON parse fails
          }
        }
        return {
          id: r.id,
          idempotencyKey: r.idempotency_key,
          workspaceId: r.workspace_id,
          incidentId: r.incident_id,
          eventType: r.event_type,
          payload: parsedPayload,
          attemptCount: r.attempt_count + 1,
          maxAttempts: r.max_attempts,
          claimToken,
        };
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Conditionally marks an outbox event as completed, retrying, dead-lettered, or suppressed,
   * strictly verifying lease ownership to prevent stale workers from overwriting newer claims.
   *
   * @param {number} id
   * @param {string} claimToken
   * @param {Object} outcome
   * @param {string} outcome.deliveryState - 'sent', 'pending', 'dead_letter', 'suppressed'
   * @param {string} [outcome.error=null]
   * @param {number} [outcome.nextAttemptDelaySeconds=null]
   * @param {boolean} [outcome.decrementAttemptCount=false]
   * @returns {Promise<{ completed: boolean, reason?: string }>}
   */
  async completeEvent(id, claimToken, outcome) {
    const {
      deliveryState,
      error = null,
      nextAttemptDelaySeconds = null,
      decrementAttemptCount = false,
    } = outcome;

    let nextAttemptExpr = 'next_attempt_at';
    const params = [
      deliveryState,
      deliveryState,
      error ? String(error).slice(0, 500) : null,
    ];

    let attemptCountExpr = 'attempt_count';
    if (decrementAttemptCount) {
      attemptCountExpr = 'GREATEST(0, attempt_count - 1)';
    }

    if (nextAttemptDelaySeconds !== null && nextAttemptDelaySeconds !== undefined) {
      nextAttemptExpr = 'DATE_ADD(NOW(), INTERVAL ? SECOND)';
      params.push(Math.max(1, Math.round(nextAttemptDelaySeconds)));
    }

    params.push(id, claimToken);

    const [res] = await this.pool.execute(
      `UPDATE notification_outbox
       SET
         delivery_state = ?,
         sent_at = IF(? = 'sent', NOW(), sent_at),
         last_error = ?,
         attempt_count = ${attemptCountExpr},
         next_attempt_at = ${nextAttemptExpr},
         lease_owner_token = NULL,
         lease_expires_at = NULL,
         updated_at = NOW()
       WHERE id = ? AND lease_owner_token = ?`,
      params
    );

    if (res.affectedRows === 0) {
      return { completed: false, reason: 'LEASE_LOST_OR_EXPIRED' };
    }

    return { completed: true };
  }
}

const notificationRepository = new NotificationRepository();

module.exports = {
  NotificationRepository,
  notificationRepository,
};

