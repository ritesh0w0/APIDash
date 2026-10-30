// backend/services/analytics.js
'use strict';

const { testResultRepository } = require('../data/testResultRepository');
const { apiRepository } = require('../data/apiRepository');
const { schedulerRunRepository } = require('../data/schedulerRunRepository');

/**
 * Returns rich analytics for a single API.
 *
 * @param {number} apiId
 * @param {number} [limitHours=24] — window in hours
 * @param {Object} [deps]
 * @param {import('../data/testResultRepository').TestResultRepository} [deps.testResultRepo]
 */
async function getApiAnalytics(apiId, limitHours = 24, deps = {}) {
  const testResultRepo = deps.testResultRepo || testResultRepository;
  const rows = await testResultRepo.findWithinHours(apiId, limitHours, deps.workspaceId);

  if (rows.length === 0) {
    return { apiId, window_hours: limitHours, total: 0 };
  }

  const total = rows.length;
  const isPassing = (r) => r.result === 'PASS' || r.result === 'passed';
  const isUnhealthy = (r) => r.result === 'FAIL' || r.result === 'failed' || r.result === 'error';

  const passed = rows.filter(isPassing).length;
  const errors = rows.filter((r) => r.result === 'error').length;
  const failed = rows.filter((r) => r.result === 'FAIL' || r.result === 'failed').length;
  const uptimePct = +((passed / total) * 100).toFixed(2);

  // Response times (exclude nulls)
  const times = rows
    .map((r) => r.response_time)
    .filter((t) => t != null)
    .sort((a, b) => a - b);

  const avgMs = times.length ? Math.round(times.reduce((s, t) => s + t, 0) / times.length) : null;
  const minMs = times.length ? times[0] : null;
  const maxMs = times.length ? times[times.length - 1] : null;
  const p50 = times.length ? times[Math.floor(times.length * 0.50)] : null;
  const p95 = times.length ? times[Math.floor(times.length * 0.95)] : null;

  // Current failure streak (from latest backwards, counting failed and error as unhealthy)
  let failStreak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (isUnhealthy(rows[i])) failStreak++;
    else break;
  }

  // Hourly breakdown
  const hourlyMap = {};
  rows.forEach((r) => {
    const h = new Date(r.tested_at).toISOString().slice(0, 13); // "2026-04-26T10"
    if (!hourlyMap[h]) {
      hourlyMap[h] = { hour: h, total: 0, passed: 0, avg_ms_sum: 0, count_ms: 0 };
    }
    hourlyMap[h].total++;
    if (isPassing(r)) hourlyMap[h].passed++;
    if (r.response_time != null) {
      hourlyMap[h].avg_ms_sum += r.response_time;
      hourlyMap[h].count_ms++;
    }
  });

  const hourly = Object.values(hourlyMap).map((h) => ({
    hour: h.hour,
    total: h.total,
    passed: h.passed,
    failed: h.total - h.passed,
    uptime_pct: +((h.passed / h.total) * 100).toFixed(1),
    avg_ms: h.count_ms ? Math.round(h.avg_ms_sum / h.count_ms) : null,
  }));

  // Top errors (include classification type)
  const errorMap = {};
  rows.filter((r) => r.error_message || r.error_type).forEach((r) => {
    const key = JSON.stringify({
      msg: r.error_message || (r.result === 'error' ? 'Execution error' : 'Check failed'),
      type: r.error_type || (r.result === 'error' ? 'TRANSPORT' : 'ASSERTION'),
    });
    errorMap[key] = (errorMap[key] || 0) + 1;
  });
  const top_errors = Object.entries(errorMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => {
      try {
        const item = JSON.parse(key);
        return { msg: item.msg, error_type: item.type, count };
      } catch (_e) {
        return { msg: key, error_type: null, count };
      }
    });

  // Health score (0–100)
  const healthScore = calcHealthScore({ uptimePct, p95, failStreak });

  // Last 50 data-points for sparkline
  const sparkline = rows.slice(-50).map((r) => ({
    t: r.tested_at,
    ms: r.response_time,
    result: r.result,
    code: r.status_code,
    error_type: r.error_type || null,
  }));

  return {
    apiId,
    window_hours: limitHours,
    total,
    passed,
    failed,
    errors,
    uptime_pct: uptimePct,
    avg_ms: avgMs,
    min_ms: minMs,
    max_ms: maxMs,
    p50_ms: p50,
    p95_ms: p95,
    fail_streak: failStreak,
    health_score: healthScore,
    hourly,
    top_errors,
    sparkline,
  };
}

/**
 * Returns global summary analytics across all APIs.
 *
 * @param {number} [limitHours=24]
 * @param {Object} [deps]
 * @param {import('../data/apiRepository').ApiRepository} [deps.apiRepo]
 * @param {import('../data/testResultRepository').TestResultRepository} [deps.testResultRepo]
 * @param {import('../data/schedulerRunRepository').SchedulerRunRepository} [deps.runRepo]
 */
async function getGlobalAnalytics(limitHours = 24, deps = {}) {
  const apiRepo = deps.apiRepo || apiRepository;
  const runRepo = deps.runRepo || schedulerRunRepository;

  const apis = await apiRepo.findAll(deps.workspaceId);

  const perApi = await Promise.all(
    apis.map(async (api) => {
      const a = await getApiAnalytics(api.id, limitHours, deps);
      return { ...a, name: api.name, url: api.url, method: api.method };
    })
  );

  const withData = perApi.filter((a) => a.total > 0);

  const globalTotal = withData.reduce((s, a) => s + a.total, 0);
  const globalPassed = withData.reduce((s, a) => s + a.passed, 0);
  const globalFailed = withData.reduce((s, a) => s + a.failed, 0);
  const globalErrors = withData.reduce((s, a) => s + (a.errors || 0), 0);

  const allTimes = withData
    .flatMap((a) => (a.sparkline || []).map((s) => s.ms).filter((t) => t != null))
    .sort((a, b) => a - b);

  const globalAvgMs = allTimes.length
    ? Math.round(allTimes.reduce((s, t) => s + t, 0) / allTimes.length)
    : null;
  const globalP95 = allTimes.length ? allTimes[Math.floor(allTimes.length * 0.95)] : null;
  const globalUptime = globalTotal
    ? +((globalPassed / globalTotal) * 100).toFixed(2)
    : null;

  // Slowest & fastest APIs
  const ranked = [...withData]
    .filter((a) => a.avg_ms != null)
    .sort((a, b) => b.avg_ms - a.avg_ms);

  // Scheduler run history (last 48 entries)
  const runs = deps.workspaceId && runRepo.findRecentByWorkspace
    ? await runRepo.findRecentByWorkspace(deps.workspaceId, 48).catch(() => [])
    : await runRepo.findRecent(48).catch(() => []);

  return {
    window_hours: limitHours,
    total_checks: globalTotal,
    total_passed: globalPassed,
    total_failed: globalFailed,
    total_errors: globalErrors,
    uptime_pct: globalUptime,
    avg_ms: globalAvgMs,
    p95_ms: globalP95,
    api_count: apis.length,
    per_api: perApi,
    slowest_apis: ranked.slice(0, 3).map((a) => ({ name: a.name, avg_ms: a.avg_ms })),
    fastest_apis: ranked.slice(-3).reverse().map((a) => ({ name: a.name, avg_ms: a.avg_ms })),
    scheduler_runs: runs,
  };
}

/**
 * Health score calculator helper (0–100)
 */
function calcHealthScore({ uptimePct, p95, failStreak }) {
  let score = 100;
  // Uptime deduction (up to -50)
  score -= Math.round((1 - uptimePct / 100) * 50);
  // Latency deduction (up to -30 if p95 > 2000ms)
  if (p95 != null) {
    if (p95 > 5000) score -= 30;
    else if (p95 > 2000) score -= 20;
    else if (p95 > 1000) score -= 10;
    else if (p95 > 500) score -= 5;
  }
  // Fail streak deduction (up to -20)
  score -= Math.min(failStreak * 5, 20);
  return Math.max(0, Math.min(100, score));
}

module.exports = {
  getApiAnalytics,
  getGlobalAnalytics,
  calcHealthScore,
};
