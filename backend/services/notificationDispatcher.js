// backend/services/notificationDispatcher.js
'use strict';

const crypto = require('crypto');
const { loadConfig } = require('../config');
const { notificationRepository: defaultNotificationRepo } = require('../data/notificationRepository');
const { emailService: defaultEmailService } = require('./emailService');
const { logger: defaultLogger } = require('../logger');

class NotificationDispatcher {
  /**
   * @param {Object} [options]
   * @param {Object} [options.config]
   * @param {import('../data/notificationRepository').NotificationRepository} [options.notificationRepo]
   * @param {import('./emailService').EmailService} [options.emailService]
   * @param {import('pino').Logger} [options.logger]
   * @param {string} [options.workerId]
   */
  constructor(options = {}) {
    const config = options.config || loadConfig();
    this.config = config;
    this.concurrency = (config.outbox && config.outbox.concurrency) || 5;
    this.pollIntervalMs = (config.outbox && config.outbox.pollIntervalMs) || 1000;
    this.leaseDurationMs = (config.outbox && config.outbox.leaseMs) || 60000;
    this.maxAttempts = (config.outbox && config.outbox.maxAttempts) || 5;
    this.shutdownTimeoutMs = (config.worker && config.worker.shutdownTimeoutMs) || 35000;

    this.notificationRepo = options.notificationRepo || defaultNotificationRepo;
    this.emailService = options.emailService || defaultEmailService;
    this.logger = options.logger || defaultLogger;
    this.workerId = options.workerId || `dispatcher-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

    this.activeJobs = new Map(); // claimToken -> Promise
    this.isRunning = false;
    this.isShuttingDown = false;
    this.isPolling = false;
    this.pollTimer = null;
    this.lastSmtpWarningTime = 0;
  }

  /**
   * Starts the background outbox polling loop.
   */
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isShuttingDown = false;

    this.logger.info(
      {
        workerId: this.workerId,
        concurrency: this.concurrency,
        pollIntervalMs: this.pollIntervalMs,
        leaseDurationMs: this.leaseDurationMs,
      },
      'Starting APIDash notification dispatcher'
    );

    this._scheduleNextPoll(0);
  }

  /**
   * Executes a single poll cycle: claims due events and initiates async delivery.
   *
   * @returns {Promise<number>} number of events claimed
   */
  async pollOnce() {
    if (this.isShuttingDown) return 0;

    const availableSlots = this.concurrency - this.activeJobs.size;
    if (availableSlots <= 0) {
      return 0;
    }

    let claimed = [];
    try {
      claimed = await this.notificationRepo.claimDueEvents(availableSlots, {
        workerId: this.workerId,
        leaseMs: this.leaseDurationMs,
      });
    } catch (err) {
      this.logger.error({ err: err.message, workerId: this.workerId }, 'Database error during outbox claim poll');
      return 0;
    }

    if (claimed.length === 0) {
      return 0;
    }

    for (const item of claimed) {
      const jobPromise = this._processClaimedEvent(item);
      this.activeJobs.set(item.claimToken, jobPromise);

      jobPromise.finally(() => {
        this.activeJobs.delete(item.claimToken);
        if (this.isRunning && !this.isShuttingDown && !this.pollTimer && !this.isPolling) {
          this._scheduleNextPoll(0);
        }
      });
    }

    return claimed.length;
  }

  /**
   * Internal polling cycle wrapper.
   */
  async _pollTick() {
    if (this.isShuttingDown || !this.isRunning) return;
    if (this.isPolling) return;

    this.isPolling = true;
    try {
      await this.pollOnce();
    } catch (err) {
      this.logger.error({ err: err.message }, 'Unexpected error in notification dispatcher poll tick');
    } finally {
      this.isPolling = false;
      if (this.isRunning && !this.isShuttingDown) {
        this._scheduleNextPoll(this.pollIntervalMs);
      }
    }
  }

  /**
   * Schedules the next poll cycle after delay.
   */
  _scheduleNextPoll(delayMs) {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (!this.isRunning || this.isShuttingDown) return;

    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this._pollTick();
    }, delayMs);
    if (this.pollTimer && typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref();
    }
  }

  /**
   * Processes a single claimed outbox notification event:
   * 1. Checks workspace notification preferences
   * 2. Resolves authorized active recipients
   * 3. Sends email via EmailService
   * 4. Updates outbox delivery state with conditional lease ownership check
   *
   * @param {Object} event
   */
  async _processClaimedEvent(event) {
    const { id, claimToken, workspaceId, eventType, payload, attemptCount, maxAttempts } = event;

    try {
      // 1. Check workspace settings
      const settings = await this.notificationRepo.getSettings(workspaceId);
      const isOpeningDisabled = eventType === 'incident_opened' && !settings.notify_on_open;
      const isRecoveryDisabled = eventType === 'incident_resolved' && !settings.notify_on_resolve;

      if (isOpeningDisabled || isRecoveryDisabled) {
        const reason = isOpeningDisabled ? 'DISABLED_IN_SETTINGS_OPEN' : 'DISABLED_IN_SETTINGS_RESOLVE';
        this.logger.info(
          { eventId: id, workspaceId, eventType, reason },
          'Notification suppressed: disabled in workspace settings'
        );
        await this.notificationRepo.completeEvent(id, claimToken, {
          deliveryState: 'suppressed',
          error: reason,
        });
        return;
      }

      // 2. Fetch active authorized recipients for workspace (re-evaluated dynamically at dispatch time)
      const recipients = await this.notificationRepo.getRecipients(workspaceId);
      if (recipients.length === 0) {
        const configuredCount = await this.notificationRepo.getConfiguredRecipientCount(workspaceId);
        const reason = configuredCount === 0 ? 'ZERO_RECIPIENTS_CONFIGURED' : 'ALL_RECIPIENTS_REVOKED';
        this.logger.info(
          { eventId: id, workspaceId, eventType, reason },
          `Notification suppressed: ${reason}`
        );
        await this.notificationRepo.completeEvent(id, claimToken, {
          deliveryState: 'suppressed',
          error: reason,
        });
        return;
      }

      // 3. Verify SMTP configuration
      const isSmtpConfigured = this.emailService.config.smtp && this.emailService.config.smtp.isConfigured;
      if (!isSmtpConfigured) {
        const now = Date.now();
        if (now - this.lastSmtpWarningTime > 60000) {
          this.logger.warn(
            { eventId: id, workspaceId },
            'SMTP is not configured. Email notifications paused without consuming retry attempts.'
          );
          this.lastSmtpWarningTime = now;
        }

        // Re-schedule without advancing attempt_count beyond limit
        await this.notificationRepo.completeEvent(id, claimToken, {
          deliveryState: 'pending',
          error: 'SMTP_NOT_CONFIGURED',
          nextAttemptDelaySeconds: 300, // pause 5 minutes
          decrementAttemptCount: true,
        });
        return;
      }

      // 4. Send email outside any database transaction
      const recipientEmails = recipients.map((r) => r.email).filter(Boolean);
      await this.emailService.sendIncidentEmail({
        recipients: recipientEmails,
        eventType,
        payload,
      });

      // 5. Mark successfully sent with lease check
      const completion = await this.notificationRepo.completeEvent(id, claimToken, {
        deliveryState: 'sent',
      });

      if (!completion.completed) {
        this.logger.warn(
          { eventId: id, claimToken, reason: completion.reason },
          'Notification completion skipped: lease lost or expired before completion'
        );
      }
    } catch (sendErr) {
      this.logger.error(
        { eventId: id, err: sendErr.message, attemptCount, maxAttempts },
        'Failed to deliver incident email notification'
      );

      if (attemptCount >= maxAttempts) {
        this.logger.error(
          { eventId: id, attemptCount, maxAttempts },
          'Notification exhausted maximum delivery attempts — moving to dead_letter'
        );
        await this.notificationRepo.completeEvent(id, claimToken, {
          deliveryState: 'dead_letter',
          error: sendErr.message,
        });
      } else {
        // Exponential backoff: 2^attempt * 10 seconds + jitter (max 1 hour)
        const backoffSeconds = Math.min(
          3600,
          Math.pow(2, attemptCount) * 10 + Math.floor(Math.random() * 5)
        );
        await this.notificationRepo.completeEvent(id, claimToken, {
          deliveryState: 'pending',
          error: sendErr.message,
          nextAttemptDelaySeconds: backoffSeconds,
        });
      }
    }
  }

  /**
   * Initiates graceful shutdown: stops polling and waits for in-flight jobs.
   */
  async stop() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.isRunning = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    const activeCount = this.activeJobs.size;
    if (activeCount > 0) {
      this.logger.info(
        { activeCount, shutdownTimeoutMs: this.shutdownTimeoutMs },
        'Graceful dispatcher shutdown: waiting for active sends to finish'
      );

      let timeoutHandle = null;
      const timeoutPromise = new Promise((resolve) => {
        timeoutHandle = setTimeout(() => {
          this.logger.warn('Dispatcher shutdown timeout reached before active sends completed.');
          resolve();
        }, this.shutdownTimeoutMs);
      });

      const allJobsPromise = Promise.allSettled(Array.from(this.activeJobs.values()));
      await Promise.race([allJobsPromise, timeoutPromise]);

      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }

    this.logger.info('Notification dispatcher stopped cleanly');
  }
}

const notificationDispatcher = new NotificationDispatcher();

module.exports = {
  NotificationDispatcher,
  notificationDispatcher,
};
