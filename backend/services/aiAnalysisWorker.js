// backend/services/aiAnalysisWorker.js
'use strict';

const crypto = require('crypto');
const { loadConfig } = require('../config');
const { aiAnalysisRepository: defaultAiRepo } = require('../data/aiAnalysisRepository');
const { createAiProvider } = require('./aiProviderService');
const { validateAiResponse } = require('./aiResponseValidator');
const { logger: defaultLogger } = require('../logger');

class AiAnalysisWorker {
  /**
   * @param {Object} [options]
   * @param {Object} [options.config]
   * @param {import('../data/aiAnalysisRepository').AiAnalysisRepository} [options.aiRepo]
   * @param {import('./aiProviderService').BaseAiProvider} [options.aiProvider]
   * @param {import('pino').Logger} [options.logger]
   * @param {string} [options.workerId]
   */
  constructor(options = {}) {
    const config = options.config || loadConfig();
    this.config = config;
    this.concurrency = (config.ai && config.ai.concurrency) || 2;
    this.pollIntervalMs = (config.ai && config.ai.pollIntervalMs) || 2000;
    this.leaseDurationMs = (config.ai && config.ai.leaseMs) || 60000;
    this.retentionDays = (config.ai && config.ai.retentionDays) || 30;
    this.isEnabled = options.aiProvider ? true : ((config.ai && config.ai.isEnabled) || false);
    this.shutdownTimeoutMs = (config.worker && config.worker.shutdownTimeoutMs) || 35000;

    this.aiRepo = options.aiRepo || defaultAiRepo;
    this.aiProvider = options.aiProvider || (this.isEnabled ? createAiProvider(config) : null);
    this.logger = options.logger || defaultLogger;
    this.workerId = options.workerId || `ai-worker-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

    this.activeJobs = new Map(); // claimToken -> Promise
    this.isRunning = false;
    this.isShuttingDown = false;
    this.isPolling = false;
    this.pollTimer = null;
    this.lastRetentionCleanup = 0;
  }

  /**
   * Starts the background AI analysis polling loop.
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
        aiEnabled: this.isEnabled,
      },
      'Starting APIDash AI analysis worker'
    );

    // Initial retention cleanup
    try {
      const deleted = await this.aiRepo.cleanupExpired(this.retentionDays);
      if (deleted > 0) {
        this.logger.info({ deleted, retentionDays: this.retentionDays }, 'Cleaned up expired AI analysis records');
      }
      this.lastRetentionCleanup = Date.now();
    } catch (err) {
      this.logger.warn({ err: err.message }, 'Initial AI analysis cleanup failed');
    }

    this._scheduleNextPoll(0);
  }

  /**
   * Single poll cycle claiming and executing pending AI analysis jobs.
   *
   * @returns {Promise<number>} number of claimed jobs
   */
  async pollOnce() {
    if (this.isShuttingDown) return 0;

    // Periodic cleanup every 6 hours
    if (Date.now() - this.lastRetentionCleanup > 6 * 3600 * 1000) {
      try {
        await this.aiRepo.cleanupExpired(this.retentionDays);
        this.lastRetentionCleanup = Date.now();
      } catch (_e) {
        // Ignore
      }
    }

    const availableSlots = this.concurrency - this.activeJobs.size;
    if (availableSlots <= 0) {
      return 0;
    }

    let claimed = [];
    try {
      claimed = await this.aiRepo.claimDueJobs(availableSlots, {
        workerId: this.workerId,
        leaseMs: this.leaseDurationMs,
      });
    } catch (err) {
      this.logger.error({ err: err.message, workerId: this.workerId }, 'Error claiming AI analysis jobs from database');
      return 0;
    }

    if (claimed.length === 0) {
      return 0;
    }

    for (const job of claimed) {
      const jobPromise = this._processClaimedJob(job);
      this.activeJobs.set(job.claimToken, jobPromise);

      jobPromise.finally(() => {
        this.activeJobs.delete(job.claimToken);
        if (this.isRunning && !this.isShuttingDown && !this.pollTimer && !this.isPolling) {
          this._scheduleNextPoll(0);
        }
      });
    }

    return claimed.length;
  }

  /**
   * Processes a claimed analysis job: invokes provider, validates structured schema, and persists outcome.
   *
   * @private
   * @param {Object} job
   */
  async _processClaimedJob(job) {
    const { id, claimToken, provider, model, evidenceSnapshot } = job;

    this.logger.info(
      { jobId: id, incidentId: job.incidentId, provider, model },
      'Processing AI incident analysis job'
    );

    // If AI provider is disabled, record a safe failure
    if (!this.isEnabled && provider !== 'mock') {
      await this.aiRepo.failJob(id, claimToken, {
        errorMessage: 'AI incident investigation is disabled in server configuration (AI_PROVIDER=disabled)',
        errorCode: 'AI_DISABLED',
        retryable: false,
      });
      return;
    }

    const providerInstance = this.aiProvider || createAiProvider(this.config, this.logger);

    try {
      // 1. Invoke LLM provider with prepared evidence snapshot only
      const providerOutput = await providerInstance.generateAnalysis(evidenceSnapshot, { model });

      // 2. Parse and strictly validate structured response
      const validation = validateAiResponse(providerOutput.rawText, evidenceSnapshot);

      if (!validation.valid) {
        this.logger.warn(
          { jobId: id, errors: validation.errors },
          'AI response failed schema or evidence reference validation'
        );

        await this.aiRepo.failJob(id, claimToken, {
          errorMessage: `Model response validation failed: ${validation.errors.slice(0, 3).join('; ')}`,
          errorCode: 'INVALID_AI_OUTPUT',
          retryable: false, // Do not infinite loop on bad model output
        });
        return;
      }

      // 3. Persist completed analysis with validated result and token metadata
      const resultToSave = {
        ...validation.result,
        ...(providerOutput.fallback_occurred
          ? {
              _fallback: {
                fallback_occurred: true,
                provider: providerOutput.provider,
                model: providerOutput.model,
                primary_provider: providerOutput.primary_provider,
                primary_model: providerOutput.primary_model,
                primary_failure_category: providerOutput.primary_failure_category,
                primary_error: providerOutput.primary_error,
              },
            }
          : {}),
      };

      await this.aiRepo.completeJob(id, claimToken, {
        result: resultToSave,
        durationMs: providerOutput.durationMs,
        tokens: providerOutput.tokens,
        provider: providerOutput.provider || provider,
        model: providerOutput.model || model,
      });

      this.logger.info(
        { jobId: id, durationMs: providerOutput.durationMs },
        'AI incident analysis completed and saved successfully'
      );
    } catch (err) {
      const isRetryable = Boolean(err.retryable);
      this.logger.error(
        { jobId: id, err: err.message, code: err.code, retryable: isRetryable },
        'Error during AI analysis job execution'
      );

      await this.aiRepo.failJob(id, claimToken, {
        errorMessage: err.message || 'AI provider execution error',
        errorCode: err.code || 'AI_PROVIDER_ERROR',
        retryable: isRetryable,
      });
    }
  }

  /**
   * Schedules the next poll after a delay.
   *
   * @private
   */
  _scheduleNextPoll(delayMs) {
    if (this.pollTimer || this.isShuttingDown || !this.isRunning) return;

    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      if (this.isShuttingDown || !this.isRunning) return;

      this.isPolling = true;
      try {
        await this.pollOnce();
      } catch (err) {
        this.logger.error({ err: err.message }, 'Unexpected error in AI worker poll cycle');
      } finally {
        this.isPolling = false;
        if (this.isRunning && !this.isShuttingDown) {
          this._scheduleNextPoll(this.pollIntervalMs);
        }
      }
    }, delayMs);
  }

  /**
   * Gracefully stops the worker, waiting for active in-flight jobs.
   */
  async stop() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.isRunning = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    const pendingCount = this.activeJobs.size;
    if (pendingCount > 0) {
      this.logger.info(
        { pendingJobs: pendingCount, timeoutMs: this.shutdownTimeoutMs },
        'Waiting for active AI analysis jobs to finish before shutdown'
      );

      const allActive = Array.from(this.activeJobs.values());
      await Promise.race([
        Promise.allSettled(allActive),
        new Promise((resolve) => setTimeout(resolve, this.shutdownTimeoutMs)),
      ]);
    }

    this.activeJobs.clear();
    this.logger.info({ workerId: this.workerId }, 'AI analysis worker stopped cleanly');
  }
}

module.exports = {
  AiAnalysisWorker,
};
