// backend/services/tester.js
'use strict';

const { testResultRepository } = require('../data/testResultRepository');
const { apiRepository } = require('../data/apiRepository');
const { schedulerRunRepository } = require('../data/schedulerRunRepository');
const { executeMonitoringRun } = require('./monitoringCoordinator');
const { logger: defaultLogger } = require('../logger');

/**
 * Tests a single API by delegating to the unified monitoring coordinator.
 *
 * @param {Object} api - { id, name, url, method, expected_status, ... }
 * @param {Object} [deps]
 * @returns {Promise<Object>} test result
 */
async function testApi(api, deps = {}) {
  const coordinatorFn = deps.coordinatorFn || executeMonitoringRun;
  return coordinatorFn(api, deps);
}

/**
 * Fetches all APIs from the DB and tests each one.
 * Called by the scheduler.
 *
 * @param {Object} [deps]
 * @param {import('../data/apiRepository').ApiRepository} [deps.apiRepo]
 * @param {import('../data/schedulerRunRepository').SchedulerRunRepository} [deps.runRepo]
 * @param {typeof testApi} [deps.testApiFn]
 * @param {import('pino').Logger} [deps.logger]
 */
async function testAllApis(deps = {}) {
  const apiRepo = deps.apiRepo || apiRepository;
  const runRepo = deps.runRepo || schedulerRunRepository;
  const testFn = deps.testApiFn || ((api) => testApi(api, deps));
  const log = deps.logger || defaultLogger;

  const rows = await apiRepo.findAll();
  if (rows.length === 0) {
    log.info('Scheduler: no APIs registered yet — skipping cycle');
    return null;
  }

  const startCycle = Date.now();
  log.info(`Scheduler running ${rows.length} API test(s)...`);

  const results = await Promise.all(rows.map(testFn));

  // Summarise cycle: both failed and error count as unhealthy/failed
  const isPassed = (r) => r.result === 'PASS' || r.result === 'passed';
  const passed = results.filter(isPassed).length;
  const failed = results.length - passed;
  const times = results.map((r) => r.response_time).filter((t) => t != null);
  const avgMs = times.length ? Math.round(times.reduce((s, t) => s + t, 0) / times.length) : null;

  // Persist scheduler run summary
  await runRepo.create({
    total: results.length,
    passed,
    failed,
    avg_ms: avgMs,
  }).catch((err) => log.warn({ err: err.message }, 'Could not log scheduler run'));

  const duration = Date.now() - startCycle;
  results.forEach((r) => {
    const icon = isPassed(r) ? '✅' : '❌';
    console.log(`  ${icon}  [${r.api_name}] ${r.result} | HTTP ${r.status_code ?? 'ERR'} | ${r.response_time ?? '?'}ms`);
  });
  console.log(`  ↳ Cycle complete in ${duration}ms — ${passed} passed, ${failed} failed | avg ${avgMs ?? '?'}ms`);

  return {
    total: results.length,
    passed,
    failed,
    avg_ms: avgMs,
    duration,
    results,
  };
}

module.exports = {
  testApi,
  testAllApis,
};
