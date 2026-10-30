// backend/app.js
'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const session = require('express-session');
const path = require('path');

const defaultAuthRouter = require('./routes/authRoutes');
const defaultWorkspaceRouter = require('./routes/workspaceRoutes');
const defaultApiRouter = require('./routes/apiRoutes');
const { createRequestLogger } = require('./middleware/requestLogger');
const { createErrorHandler } = require('./middleware/errors');
const { createCsrfProtection } = require('./middleware/csrf');
const { apiLimiter } = require('./middleware/rateLimiters');
const { loadConfig } = require('./config');
const { logger: defaultLogger } = require('./logger');
const { getPool } = require('./db');

/**
 * Creates and configures the Express application with complete security,
 * authentication, workspace authorization, and SSRF defenses.
 *
 * @param {Object} [options]
 * @param {express.Router} [options.authRouter]
 * @param {express.Router} [options.workspaceRouter]
 * @param {express.Router} [options.apiRouter]
 * @param {import('express-session').Store} [options.sessionStore]
 * @param {import('pino').Logger} [options.logger]
 * @param {string} [options.staticDir]
 * @param {Object} [options.config]
 * @returns {express.Application}
 */
function createApp(options = {}) {
  const app = express();
  const config = options.config || loadConfig();
  const logger = options.logger || defaultLogger;
  const staticDir = options.staticDir || path.join(__dirname, '..', 'frontend');

  // Trust reverse proxy if configured
  if (config.nodeEnv === 'production') {
    app.set('trust proxy', 1);
  }

  // ─── Security Headers (Helmet) ──────────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  // ─── CORS (Restricted) ──────────────────────────────────────────────────────
  app.use(
    cors({
      origin: config.appOrigin,
      credentials: true,
    })
  );

  // ─── Body Parsers & Request Logging ────────────────────────────────────────
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(createRequestLogger(logger));

  // ─── Session Management ────────────────────────────────────────────────────
  let sessionStore = options.sessionStore;
  const isTestMode = config.nodeEnv === 'test' || Boolean(process.env.NODE_TEST_CONTEXT);

  if (!sessionStore) {
    if (isTestMode) {
      sessionStore = new session.MemoryStore();
    } else {
      try {
        const MySQLStore = require('express-mysql-session')(session);
        sessionStore = new MySQLStore(
          {
            createDatabaseTable: false, // DDL explicitly managed via migrations
            clearExpired: true,
            checkExpirationInterval: 900000,
            schema: {
              tableName: 'sessions',
              columnNames: {
                session_id: 'session_id',
                expires: 'expires',
                data: 'data',
              },
            },
          },
          getPool()
        );
      } catch (err) {
        if (config.nodeEnv === 'production') {
          throw new Error(`Failed to initialize MySQL session store in production: ${err.message}`);
        }
        logger.warn({ err: err.message }, 'Failed to initialize MySQL session store, falling back to memory store');
        sessionStore = new session.MemoryStore();
      }
    }
  }

  const sessionMiddleware = session({
    name: config.session.name,
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
      httpOnly: true,
      secure: config.session.cookieSecure,
      sameSite: 'lax',
      maxAge: config.session.maxAge,
    },
  });
  app.use(sessionMiddleware);
  app.set('sessionCookieName', config.session.name);

  // ─── CSRF Protection on Mutating API Requests ──────────────────────────────
  const csrfProtection = options.csrfProtection || createCsrfProtection(config);
  app.use('/api', csrfProtection);

  // ─── General Rate Limiting ─────────────────────────────────────────────────
  app.use('/api', apiLimiter);

  // ─── Health Probe (Public) ─────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
    });
  });

  // ─── Static Frontend Assets ────────────────────────────────────────────────
  app.use(express.static(staticDir));

  // ─── API Routes ────────────────────────────────────────────────────────────
  app.use('/api/auth', options.authRouter || defaultAuthRouter);
  app.use('/api/workspaces', options.workspaceRouter || defaultWorkspaceRouter);
  app.use('/api', options.apiRouter || defaultApiRouter);

  // ─── Fallback to frontend for unmatched routes (SPA) ───────────────────────
  app.get('*', (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });

  // ─── Centralized Error Handler ─────────────────────────────────────────────
  app.use(createErrorHandler(logger));

  return app;
}

module.exports = {
  createApp,
};
