// backend/routes/apiRoutes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { testApi } = require('../services/tester');
const { getApiAnalytics, getGlobalAnalytics } = require('../services/analytics');

// ─── POST /api/add ────────────────────────────────────────────────────────────
router.post('/add', async (req, res) => {
  try {
    const { name, url, method = 'GET', expected_status = 200 } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'name and url are required' });

    const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
    const upperMethod = method.toUpperCase();
    if (!validMethods.includes(upperMethod))
      return res.status(400).json({ error: `method must be one of: ${validMethods.join(', ')}` });

    const [result] = await pool.execute(
      'INSERT INTO apis (name, url, method, expected_status) VALUES (?, ?, ?, ?)',
      [name, url, upperMethod, expected_status]
    );
    return res.status(201).json({
      message: 'API added successfully',
      api: { id: result.insertId, name, url, method: upperMethod, expected_status },
    });
  } catch (err) {
    console.error('POST /api/add error:', err.message);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// ─── GET /api/test/:id ────────────────────────────────────────────────────────
router.get('/test/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM apis WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: `No API found with id ${req.params.id}` });
    const testResult = await testApi(rows[0]);
    return res.json(testResult);
  } catch (err) {
    console.error(`GET /api/test/${req.params.id} error:`, err.message);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// ─── GET /api/list ────────────────────────────────────────────────────────────
router.get('/list', async (_req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        a.*,
        tr.status_code   AS last_status_code,
        tr.response_time AS last_response_time,
        tr.result        AS last_result,
        tr.error_message AS last_error,
        tr.tested_at     AS last_tested_at
      FROM apis a
      LEFT JOIN test_results tr
        ON tr.id = (
          SELECT id FROM test_results
          WHERE api_id = a.id
          ORDER BY tested_at DESC
          LIMIT 1
        )
      ORDER BY a.created_at DESC
    `);
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/history/:id ─────────────────────────────────────────────────────
router.get('/history/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM test_results WHERE api_id = ? ORDER BY tested_at DESC LIMIT 20`,
      [req.params.id]
    );
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/stats ──────────────────────────────────────────────────────────
// Aggregate counts for the stats cards
router.get('/stats', async (_req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        COUNT(*)                          AS total,
        SUM(last_result = 'PASS')         AS passing,
        SUM(last_result = 'FAIL')         AS failing,
        SUM(last_result IS NULL)          AS untested,
        ROUND(AVG(last_response_time), 0) AS avg_response_time
      FROM (
        SELECT
          a.id,
          tr.result        AS last_result,
          tr.response_time AS last_response_time
        FROM apis a
        LEFT JOIN test_results tr
          ON tr.id = (
            SELECT id FROM test_results
            WHERE api_id = a.id
            ORDER BY tested_at DESC LIMIT 1
          )
      ) sub
    `);
    return res.json(rows[0]);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/chart-data ──────────────────────────────────────────────────────
// Last 10 test results per API, ready for Chart.js
router.get('/chart-data', async (_req, res) => {
  try {
    const [apis] = await pool.execute('SELECT id, name FROM apis');
    const result = {};
    await Promise.all(apis.map(async (api) => {
      const [rows] = await pool.execute(
        `SELECT response_time, result, status_code, tested_at
         FROM test_results
         WHERE api_id = ?
         ORDER BY tested_at DESC LIMIT 10`,
        [api.id]
      );
      result[api.id] = { name: api.name, points: rows.reverse() };
    }));
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/delete/:id ───────────────────────────────────────────────────
router.delete('/delete/:id', async (req, res) => {
  try {
    const [result] = await pool.execute('DELETE FROM apis WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'API not found' });
    return res.json({ message: 'API deleted successfully' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/analytics/summary ──────────────────────────────────────────────
// Global analytics for the last N hours (default 24h)
router.get('/analytics/summary', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours, 10) || 24;
    const data  = await getGlobalAnalytics(hours);
    return res.json(data);
  } catch (err) {
    console.error('GET /api/analytics/summary error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/analytics/:id ───────────────────────────────────────────────────
// Per-API analytics for the last N hours (default 24h)
router.get('/analytics/:id', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours, 10) || 24;
    const [apis] = await pool.execute('SELECT id FROM apis WHERE id = ?', [req.params.id]);
    if (apis.length === 0) return res.status(404).json({ error: `No API with id ${req.params.id}` });
    const data = await getApiAnalytics(req.params.id, hours);
    return res.json(data);
  } catch (err) {
    console.error(`GET /api/analytics/${req.params.id} error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/scheduler-runs ─────────────────────────────────────────────────
// Recent scheduler cycle summaries (for timeline chart)
router.get('/scheduler-runs', async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM scheduler_runs ORDER BY ran_at DESC LIMIT 60`
    );
    return res.json(rows.reverse()); // oldest→newest for charting
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

