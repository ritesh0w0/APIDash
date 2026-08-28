// backend/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { initDB } = require('./db');
const { testAllApis } = require('./services/tester');
const apiRoutes = require('./routes/apiRoutes');

const app = express();
const PORT = process.env.PORT || 5000;
const SCHEDULER_INTERVAL_MS = 30_000; // 30 seconds

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve the frontend
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api', apiRoutes);

// Health probe
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Fallback to frontend for any unmatched route
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────
(async () => {
  try {
    await initDB();

    app.listen(PORT, () => {
      console.log(`🚀  API Health Monitor running on http://localhost:${PORT}`);
      console.log(`📅  Scheduler: all APIs tested every ${SCHEDULER_INTERVAL_MS / 1000}s`);
    });

    // ── 30-second scheduler ──────────────────────────────────────────────────
    // Run once immediately, then every 30 s
    setTimeout(async () => {
      await testAllApis();
      setInterval(testAllApis, SCHEDULER_INTERVAL_MS);
    }, 2000); // 2-sec warm-up so the server is fully up before the first run

  } catch (err) {
    console.error('❌  Failed to start server:', err.message);
    process.exit(1);
  }
})();
