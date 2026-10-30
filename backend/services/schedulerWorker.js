// backend/services/schedulerWorker.js
'use strict';

const crypto = require('crypto');
const { loadConfig } = require('../config');
const { schedulerRepository: defaultSchedulerRepo, calculateNextRunAt } = require('../data/schedulerRepository');
const { schedulerRunRepository: defaultSchedulerRunRepo } = require('../data/schedulerRunRepository');
const { executeMonitoringRun: defaultExecuteCoordinator } = require('./monitoringCoordinator');
const { NotificationDispatcher, notificationDispatcher: defaultNotificationDispatcher } = require('./notificationDispatcher');
const { AiAnalysisWorker } = require('./aiAnalysisWorker');
const { logger: defaultLogger } = require('../logger');

class SchedulerWorker {
  /**
   * @param {Object} [options]
   * @param {Object} [options.config]
   * @param {import('../data/schedulerRepository').SchedulerRepository} [options.schedulerRepo]
   * @param {import('../data/schedulerRunRepository').SchedulerRunRepository} [options.schedulerRunRepo]
   * @param {typeof defaultExecuteCoordinator} [options.coordinatorFn]
   * @param {import('pino').Logger} [options.logger]
   * @param {string} [options.workerId]
   */
  constructor(options = {}) {
    const config = options.config || loadConfig();
    this.config = config;
    this.concurrency = config.worker ? config.worker.concurrency : 5;
    this.pollIntervalMs = config.worker ? config.worker.pollIntervalMs : 1000;
    this.leaseDurationMs = config.worker ? config.worker.leaseMs : 60000;
    this.cadenceMs = config.schedulerIntervalMs || 30000;
    this.shutdownTimeoutMs = config.worker ? config.worker.shutdownTimeoutMs : 35000;

    this.schedulerRepo = options.schedulerRepo || defaultSchedulerRepo;
    this.schedulerRunRepo = options.schedulerRunRepo || defaultSchedulerRunRepo;
    this.coordinatorFn = options.coordinatorFn || defaultExecuteCoordinator;
    this.logger = options.logger || defaultLogger;
    this.workerId = options.workerId || `worker-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

    this.activeJobs = new Map(); // claimToken -> Promise
    this.completedBatch = []; // buffer of { result, response_time }
    this.lastBatchFlushTime = Date.now();

    if (options.disableDispatcher) {
      this.notificationDispatcher = null;
    } else if (options.notificationDispatcher) {
      this.notificationDispatcher = options.notificationDispatcher;
    } else if (options.schedulerRepo && !options.notificationRepo) {
      // In isolated unit tests where schedulerRepo is mocked without a notification dispatcher,
      // disable dispatcher to avoid touching real database pool
      this.notificationDispatcher = null;
    } else {
      this.notificationDispatcher = new NotificationDispatcher({
        config,
        logger: this.logger,
      });
    }

    if (options.disableAiWorker) {
      this.aiWorker = null;
    } else if (options.aiWorker) {
      this.aiWorker = options.aiWorker;
    } else if (options.schedulerRepo && !options.aiRepo) {
      // In isolated unit tests where schedulerRepo is mocked without an ai repo, disable ai worker
      this.aiWorker = null;
    } else {
      this.aiWorker = new AiAnalysisWorker({
        config,
        logger: this.logger,
      });
    }

    this.isRunning = false;
    this.isShuttingDown = false;
    this.isPolling = false;
    this.pollTimer = null;
    this.backoffDelayMs = 0;
  }

  /**
   * Starts the worker background loop.
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
        cadenceMs: this.cadenceMs,
      },
      'Starting APIDash scheduler worker'
    );

    // Initial idempotent repair of any monitors lacking a schedule record
    try {
      const repaired = await this.schedulerRepo.repairMissingSchedules();
      if (repaired > 0) {
        this.logger.info({ repaired }, 'Repaired missing monitor schedules on startup');
      }
    } catch (err) {
      this.logger.warn({ err: err.message }, 'Could not run initial schedule repair (will retry during poll)');
    }

    // Start background notification dispatcher alongside scheduler
    if (this.notificationDispatcher) {
      try {
        await this.notificationDispatcher.start();
      } catch (dispatchErr) {
        this.logger.error(
          { err: dispatchErr.message },
          'Notification dispatcher failed to start — monitoring scheduler will continue running'
        );
      }
    }

    // Start background AI analysis worker alongside scheduler
    if (this.aiWorker) {
      try {
        await this.aiWorker.start();
      } catch (aiErr) {
        this.logger.error(
          { err: aiErr.message },
          'AI analysis worker failed to start — monitoring scheduler will continue running'
        );
      }
    }

    this._scheduleNextPoll(0);
  }

  /**
   * Executes a single poll-and-execute cycle.
   * Useful for testing and step-by-step verification.
   *
   * @returns {Promise<number>} number of jobs claimed in this cycle
   */
  async pollOnce() {
    if (this.isShuttingDown) return 0;

    const availableSlots = this.concurrency - this.activeJobs.size;
    if (availableSlots <= 0) {
      return 0;
    }

    let claimed = [];
    try {
      claimed = await this.schedulerRepo.claimDueMonitors(availableSlots, {
        workerId: this.workerId,
        leaseDurationMs: this.leaseDurationMs,
      });

      // Clear any previous error backoff on successful query
      this.backoffDelayMs = 0;
    } catch (dbErr) {
      this.logger.error({ err: dbErr.message, workerId: this.workerId }, 'Database error during claim poll — backing off');
      this.backoffDelayMs = Math.min(30000, Math.max(2000, (this.backoffDelayMs || 1000) * 2));
      return 0;
    }

    if (claimed.length === 0) {
      return 0;
    }

    for (const item of claimed) {
      const jobPromise = this._executeClaimedMonitor(item);
      this.activeJobs.set(item.claimToken, jobPromise);

      jobPromise.finally(() => {
        this.activeJobs.delete(item.claimToken);
        // Wake up poll loop if capacity just became available and not shutting down
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
    if (this.isPolling) return; // Prevent overlapping poll cycles

    this.isPolling = true;
    try {
      await this.pollOnce();
      await this._maybeFlushBatch();
    } catch (err) {
      this.logger.error({ err: err.message }, 'Unexpected error in scheduler poll tick');
    } finally {
      this.isPolling = false;
      if (this.isRunning && !this.isShuttingDown) {
        const delay = this.backoffDelayMs > 0 ? this.backoffDelayMs : this.pollIntervalMs;
        this._scheduleNextPoll(delay);
      }
    }
  }

  /**
   * Schedules next poll cycle after given delay.
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
   * Executes a single claimed monitor through the Phase 3 monitoringCoordinator,
   * updates the schedule state with conditional lease ownership check,
   * and buffers the result for scheduler_runs summary.
   *
   * @param {Object} claimed
   */
  async _executeClaimedMonitor(claimed) {
    const { monitor, claimToken, apiId } = claimed;
    let runResult = null;
    let outcome = 'error';

    try {
      // Phase 3 Coordinator: executes SSRF-protected request, evaluates assertions, persists in test_results
      runResult = await this.coordinatorFn(monitor, {
        logger: this.logger,
      });

      outcome = runResult.outcome || (runResult.result === 'PASS' || runResult.result === 'passed' ? 'passed' : 'failed');
    } catch (execErr) {
      this.logger.error({ err: execErr.message, api_id: apiId }, 'Executor or coordinator failure during scheduled run');
      outcome = 'error';
    }

    // Fixed-rate cadence policy: database clock computes next slot anchored to stored next_run_at,
    // advancing by intervals and skipping missed slots during overruns without catch-up bursts.
    const cadenceSeconds = Math.max(1, Math.round(this.cadenceMs / 1000));
    try {
      const completion = await this.schedulerRepo.completeClaim(apiId, claimToken, {
        outcome,
        cadenceSeconds,
      });

      if (!completion.completed) {
        this.logger.warn(
          { api_id: apiId, claimToken, reason: completion.reason },
          'Schedule completion skipped: lease ownership was lost or expired'
        );
      }
    } catch (dbErr) {
      this.logger.error({ err: dbErr.message, api_id: apiId }, 'Database failure updating schedule state');
    }

    // Buffer result for scheduler_runs aggregate summary
    this.completedBatch.push({
      result: outcome,
      response_time: runResult ? runResult.response_time : null,
    });

    // Check if batch is full enough to flush
    if (this.completedBatch.length >= this.concurrency) {
      await this._flushBatch();
    }
  }

  /**
   * Flushes completed runs buffer into scheduler_runs table if threshold reached or time elapsed.
   */
  async _maybeFlushBatch() {
    const timeSinceLastFlush = Date.now() - this.lastBatchFlushTime;
    if (this.completedBatch.length > 0 && (timeSinceLastFlush >= 30000 || this.completedBatch.length >= this.concurrency)) {
      await this._flushBatch();
    }
  }

  /**
   * Flushes any buffered execution outcomes to scheduler_runs.
   */
  async _flushBatch() {
    if (this.completedBatch.length === 0) return;

    const batch = this.completedBatch.splice(0, this.completedBatch.length);
    this.lastBatchFlushTime = Date.now();

    const total = batch.length;
    const isPassed = (r) => r.result === 'PASS' || r.result === 'passed';
    const passed = batch.filter(isPassed).length;
    const failed = total - passed;
    const times = batch.map((r) => r.response_time).filter((t) => t != null);
    const avgMs = times.length ? Math.round(times.reduce((s, t) => s + t, 0) / times.length) : null;

    try {
      await this.schedulerRunRepo.create({
        total,
        passed,
        failed,
        avg_ms: avgMs,
      });
      this.logger.info({ total, passed, failed, avgMs }, 'Recorded scheduler run batch');
    } catch (err) {
      this.logger.warn({ err: err.message }, 'Failed to record scheduler_runs batch summary');
    }
  }

  /**
   * Initiates graceful shutdown:
   * 1. Stops claiming new work.
   * 2. Waits for active in-flight executions to finish within shutdownTimeoutMs.
   * 3. Flushes any remaining completed batch to scheduler_runs.
   * 4. Leaves any unfinished jobs' leases to expire safely so recovery is safe.
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
      this.logger.info({ activeCount, shutdownTimeoutMs: this.shutdownTimeoutMs }, 'Graceful shutdown: waiting for active jobs to finish');

      let timeoutHandle = null;
      const timeoutPromise = new Promise((resolve) => {
        timeoutHandle = setTimeout(() => {
          this.logger.warn('Shutdown timeout reached before all in-flight jobs completed. Leaving leases to expire safely.');
          resolve();
        }, this.shutdownTimeoutMs);
      });

      const allJobsPromise = Promise.allSettled(Array.from(this.activeJobs.values()));

      await Promise.race([allJobsPromise, timeoutPromise]);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }

    // Flush any pending execution summaries before stopping
    await this._flushBatch();

    if (this.notificationDispatcher) {
      try {
        await this.notificationDispatcher.stop();
      } catch (err) {
        this.logger.error({ err: err.message }, 'Error stopping notification dispatcher');
      }
    }

    if (this.aiWorker) {
      try {
        await this.aiWorker.stop();
      } catch (err) {
        this.logger.error({ err: err.message }, 'Error stopping AI analysis worker');
      }
    }

    this.logger.info('Scheduler worker stopped cleanly');
  }
}

module.exports = {
  SchedulerWorker,
};
