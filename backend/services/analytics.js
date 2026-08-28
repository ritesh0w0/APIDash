// backend/services/analytics.js
const { pool } = require('../db');

// ─── Per-API deep analytics ───────────────────────────────────────────────────
/**
 * Returns rich analytics for a single API.
 * @param {number} apiId
 * @param {number} [limitHours=24] — window in hours
 */
async function getApiAnalytics(apiId, limitHours = 24) {
  const [rows] = await pool.execute(
    `SELECT status_code, response_time, result, error_message, tested_at
     FROM test_results
     WHERE api_id = ?
       AND tested_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     ORDER BY tested_at ASC`,
    [apiId, limitHours]
  );

  if (rows.length === 0) {
    return { apiId, window_hours: limitHours, total: 0 };
  }

  const total   = rows.length;
  const passed  = rows.filter(r => r.result === 'PASS').length;
  const failed  = total - passed;
  const uptimePct = +((passed / total) * 100).toFixed(2);

  // Response times (exclude nulls)
  const times = rows
    .map(r => r.response_time)
    .filter(t => t != null)
    .sort((a, b) => a - b);

  const avgMs  = times.length ? Math.round(times.reduce((s, t) => s + t, 0) / times.length) : null;
  const minMs  = times.length ? times[0] : null;
  const maxMs  = times.length ? times[times.length - 1] : null;
  const p50    = times.length ? times[Math.floor(times.length * 0.50)] : null;
  const p95    = times.length ? times[Math.floor(times.length * 0.95)] : null;

  // Current failure streak (from latest backwards)
  let failStreak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].result === 'FAIL') failStreak++;
    else break;
  }

  // Hourly breakdown
  const hourlyMap = {};
  rows.forEach(r => {
    const h = new Date(r.tested_at).toISOString().slice(0, 13); // "2026-04-26T10"
    if (!hourlyMap[h]) hourlyMap[h] = { hour: h, total: 0, passed: 0, avg_ms_sum: 0, count_ms: 0 };
    hourlyMap[h].total++;
    if (r.result === 'PASS') hourlyMap[h].passed++;
    if (r.response_time != null) { hourlyMap[h].avg_ms_sum += r.response_time; hourlyMap[h].count_ms++; }
  });
  const hourly = Object.values(hourlyMap).map(h => ({
    hour:      h.hour,
    total:     h.total,
    passed:    h.passed,
    failed:    h.total - h.passed,
    uptime_pct: +((h.passed / h.total) * 100).toFixed(1),
    avg_ms:    h.count_ms ? Math.round(h.avg_ms_sum / h.count_ms) : null,
  }));

  // Top errors
  const errorMap = {};
  rows.filter(r => r.error_message).forEach(r => {
    errorMap[r.error_message] = (errorMap[r.error_message] || 0) + 1;
  });
  const top_errors = Object.entries(errorMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([msg, count]) => ({ msg, count }));

  // Simple health score (0–100)
  const healthScore = calcHealthScore({ uptimePct, p95, failStreak });

  // Last 50 data-points for sparkline
  const sparkline = rows.slice(-50).map(r => ({
    t:      r.tested_at,
    ms:     r.response_time,
    result: r.result,
    code:   r.status_code,
  }));

  return {
    apiId,
    window_hours: limitHours,
    total, passed, failed,
    uptime_pct: uptimePct,
    avg_ms: avgMs, min_ms: minMs, max_ms: maxMs,
    p50_ms: p50, p95_ms: p95,
    fail_streak: failStreak,
    health_score: healthScore,
    hourly,
    top_errors,
    sparkline,
  };
}

// ─── Global summary analytics ─────────────────────────────────────────────────
async function getGlobalAnalytics(limitHours = 24) {
  // Per-API last stats
  const [apis] = await pool.execute('SELECT id, name, url, method FROM apis');

  const perApi = await Promise.all(
    apis.map(async api => {
      const a = await getApiAnalytics(api.id, limitHours);
      return { ...a, name: api.name, url: api.url, method: api.method };
    })
  );

  const withData = perApi.filter(a => a.total > 0);

  const globalTotal  = withData.reduce((s, a) => s + a.total, 0);
  const globalPassed = withData.reduce((s, a) => s + a.passed, 0);
  const globalFailed = withData.reduce((s, a) => s + a.failed, 0);

  const allTimes = withData.flatMap(a =>
    (a.sparkline || []).map(s => s.ms).filter(t => t != null)
  ).sort((a, b) => a - b);

  const globalAvgMs = allTimes.length
    ? Math.round(allTimes.reduce((s, t) => s + t, 0) / allTimes.length)
    : null;
  const globalP95   = allTimes.length ? allTimes[Math.floor(allTimes.length * 0.95)] : null;
  const globalUptime = globalTotal
    ? +((globalPassed / globalTotal) * 100).toFixed(2)
    : null;

  // Slowest & fastest APIs
  const ranked = [...withData].filter(a => a.avg_ms != null)
    .sort((a, b) => b.avg_ms - a.avg_ms);

  // Scheduler run history (last 48 entries)
  const [runs] = await pool.execute(
    `SELECT * FROM scheduler_runs ORDER BY ran_at DESC LIMIT 48`
  ).catch(() => [[]]);

  return {
    window_hours: limitHours,
    total_checks:  globalTotal,
    total_passed:  globalPassed,
    total_failed:  globalFailed,
    uptime_pct:    globalUptime,
    avg_ms:        globalAvgMs,
    p95_ms:        globalP95,
    api_count:     apis.length,
    per_api:       perApi,
    slowest_apis:  ranked.slice(0, 3).map(a => ({ name: a.name, avg_ms: a.avg_ms })),
    fastest_apis:  ranked.slice(-3).reverse().map(a => ({ name: a.name, avg_ms: a.avg_ms })),
    scheduler_runs: runs,
  };
}

// ─── Health score helper ──────────────────────────────────────────────────────
function calcHealthScore({ uptimePct, p95, failStreak }) {
  let score = 100;
  // Uptime deduction (up to -50)
  score -= Math.round((1 - uptimePct / 100) * 50);
  // Latency deduction (up to -30 if p95 > 2000ms)
  if (p95 != null) {
    if (p95 > 5000)       score -= 30;
    else if (p95 > 2000)  score -= 20;
    else if (p95 > 1000)  score -= 10;
    else if (p95 > 500)   score -=  5;
  }
  // Fail streak deduction (up to -20)
  score -= Math.min(failStreak * 5, 20);
  return Math.max(0, Math.min(100, score));
}

module.exports = { getApiAnalytics, getGlobalAnalytics };
