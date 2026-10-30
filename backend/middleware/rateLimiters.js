// backend/middleware/rateLimiters.js
'use strict';

const rateLimit = require('express-rate-limit');

const isTest = process.env.NODE_ENV === 'test';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isTest ? 10000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many authentication attempts. Please try again later.',
  },
});

const probeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: isTest ? 10000 : 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many test requests. Please wait before triggering another probe.',
  },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: isTest ? 10000 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Rate limit exceeded. Please slow down your requests.',
  },
});

module.exports = {
  authLimiter,
  probeLimiter,
  apiLimiter,
};
