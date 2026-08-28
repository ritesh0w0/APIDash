// backend/services/tester.js
const axios = require('axios');
const { pool } = require('../db');

/**
 * Tests a single API by its database row object.
 * @param {Object} api - { id, name, url, method, expected_status }
 * @returns {Object} test result
 */
async function testApi(api) {
  const start = Date.now();
  let result = {
    api_id: api.id,
    api_name: api.name,
    url: api.url,
    method: api.method.toUpperCase(),
    expected_status: api.expected_status,
    status_code: null,
    response_time: null,
    result: 'FAIL',
    error_message: null,
  };

  try {
    const response = await axios({
      method: api.method.toLowerCase(),
      url: api.url,
      timeout: 10000,            // 10-second hard timeout
      validateStatus: () => true, // don't throw on non-2xx
    });

    result.status_code = response.status;
    result.response_time = Date.now() - start;
    result.result = response.status === api.expected_status ? 'PASS' : 'FAIL';
    if (result.result === 'FAIL') {
      result.error_message = `Expected ${api.expected_status}, got ${response.status}`;
    }
  } catch (err) {
    result.response_time = Date.now() - start;
    result.error_message = err.message;
  }

  // Persist result
  await pool.execute(
    `INSERT INTO test_results
       (api_id, status_code, response_time, result, error_message)
     VALUES (?, ?, ?, ?, ?)`,
    [
      result.api_id,
      result.status_code,
      result.response_time,
      result.result,
      result.error_message,
    ]
  );

  return result;
}

/**
 * Fetches all APIs from the DB and tests each one.
 * Called by the scheduler every 30 seconds.
 */
async function testAllApis() {
  const [rows] = await pool.execute('SELECT * FROM apis');
  if (rows.length === 0) {
    console.log('⏭  Scheduler: no APIs registered yet — skipping cycle');
    return;
  }

  const startCycle = Date.now();
  console.log(`\n🔄  [${new Date().toLocaleTimeString()}] Scheduler running ${rows.length} API test(s)...`);

  const results = await Promise.all(rows.map(testApi));

  // Summarise cycle
  const passed  = results.filter(r => r.result === 'PASS').length;
  const failed  = results.length - passed;
  const times   = results.map(r => r.response_time).filter(t => t != null);
  const avgMs   = times.length ? Math.round(times.reduce((s, t) => s + t, 0) / times.length) : null;

  // Persist scheduler run summary
  await pool.execute(
    `INSERT INTO scheduler_runs (total, passed, failed, avg_ms) VALUES (?, ?, ?, ?)`,
    [results.length, passed, failed, avgMs]
  ).catch(err => console.warn('⚠  Could not log scheduler run:', err.message));

  // Console report
  const duration = Date.now() - startCycle;
  results.forEach(r => {
    const icon = r.result === 'PASS' ? '✅' : '❌';
    console.log(`  ${icon}  [${r.api_name}] ${r.result} | HTTP ${r.status_code ?? 'ERR'} | ${r.response_time ?? '?'}ms`);
  });
  console.log(`  ↳ Cycle complete in ${duration}ms — ${passed} passed, ${failed} failed | avg ${avgMs ?? '?'}ms`);
}

module.exports = { testApi, testAllApis };

