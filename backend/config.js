// backend/config.js
'use strict';

class ConfigError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ConfigError';
    this.details = details;
  }
}

/**
 * Validates and loads application configuration from an environment object.
 * Pure function: does not mutate or read global process.env unless passed.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Object} validated configuration
 */
function loadConfig(env = process.env) {
  const errors = [];

  const nodeEnv = (env.NODE_ENV || 'development').trim();
  const validEnvironments = ['development', 'production', 'test'];
  if (!validEnvironments.includes(nodeEnv)) {
    errors.push(`NODE_ENV must be one of: ${validEnvironments.join(', ')} (got: "${nodeEnv}")`);
  }

  // PORT validation
  const rawPort = env.PORT !== undefined && env.PORT !== '' ? env.PORT : '5000';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push(`PORT must be an integer between 1 and 65535 (got: "${rawPort}")`);
  }

  // Database Host
  const dbHost = (env.DB_HOST || 'localhost').trim();
  if (!dbHost) {
    errors.push('DB_HOST cannot be empty');
  }

  // Database Port
  const rawDbPort = env.DB_PORT !== undefined && env.DB_PORT !== '' ? env.DB_PORT : '3306';
  const dbPort = Number(rawDbPort);
  if (!Number.isInteger(dbPort) || dbPort < 1 || dbPort > 65535) {
    errors.push(`DB_PORT must be an integer between 1 and 65535 (got: "${rawDbPort}")`);
  }

  // Database User
  const dbUser = env.DB_USER !== undefined ? env.DB_USER.trim() : 'root';
  if (!dbUser) {
    errors.push('DB_USER is required and cannot be empty');
  }

  // Database Password
  const dbPassword = env.DB_PASSWORD !== undefined ? env.DB_PASSWORD : '';
  if (nodeEnv === 'production' && !dbPassword) {
    errors.push('DB_PASSWORD is required in production environment');
  }

  // Database Name
  const dbName = env.DB_NAME !== undefined ? env.DB_NAME.trim() : 'api_monitor';
  if (!dbName) {
    errors.push('DB_NAME is required and cannot be empty');
  }

  // Session Secret
  const sessionSecret = env.SESSION_SECRET ? env.SESSION_SECRET.trim() : '';
  if (nodeEnv === 'production') {
    if (!sessionSecret || sessionSecret.length < 32) {
      errors.push('SESSION_SECRET is required and must be at least 32 characters in production');
    }
  }

  // Cookie Secure
  let cookieSecure = nodeEnv === 'production';
  if (env.COOKIE_SECURE !== undefined) {
    const rawSecure = String(env.COOKIE_SECURE).trim().toLowerCase();
    if (rawSecure === 'true' || rawSecure === '1') {
      cookieSecure = true;
    } else if (rawSecure === 'false' || rawSecure === '0') {
      cookieSecure = false;
    } else {
      errors.push(`COOKIE_SECURE must be a boolean ('true' or 'false', got: "${env.COOKIE_SECURE}")`);
    }
  }

  // App Origin (for CSRF and CORS verification)
  const appOrigin = env.APP_ORIGIN ? env.APP_ORIGIN.trim() : `http://localhost:${port}`;

  // SSRF Protection settings
  const rawMaxRedirects = env.SSRF_MAX_REDIRECTS !== undefined && env.SSRF_MAX_REDIRECTS !== '' ? env.SSRF_MAX_REDIRECTS : '3';
  const ssrfMaxRedirects = Number(rawMaxRedirects);
  if (!Number.isInteger(ssrfMaxRedirects) || ssrfMaxRedirects < 0 || ssrfMaxRedirects > 10) {
    errors.push(`SSRF_MAX_REDIRECTS must be an integer between 0 and 10 (got: "${rawMaxRedirects}")`);
  }

  const rawTimeout = env.SSRF_TIMEOUT_MS !== undefined && env.SSRF_TIMEOUT_MS !== '' ? env.SSRF_TIMEOUT_MS : '10000';
  const ssrfTimeoutMs = Number(rawTimeout);
  if (!Number.isInteger(ssrfTimeoutMs) || ssrfTimeoutMs < 100 || ssrfTimeoutMs > 60000) {
    errors.push(`SSRF_TIMEOUT_MS must be an integer between 100 and 60000 (got: "${rawTimeout}")`);
  }

  const rawMaxBody = env.SSRF_MAX_BODY_BYTES !== undefined && env.SSRF_MAX_BODY_BYTES !== '' ? env.SSRF_MAX_BODY_BYTES : '1048576';
  const ssrfMaxBodyBytes = Number(rawMaxBody);
  if (!Number.isInteger(ssrfMaxBodyBytes) || ssrfMaxBodyBytes < 1024 || ssrfMaxBodyBytes > 52428800) {
    errors.push(`SSRF_MAX_BODY_BYTES must be an integer between 1024 and 52428800 (got: "${rawMaxBody}")`);
  }

  // Safe local test target setting (strictly forbidden in production)
  let allowLocalTestTargets = false;
  if (env.APIDASH_ALLOW_LOCAL_TEST_TARGETS !== undefined && env.APIDASH_ALLOW_LOCAL_TEST_TARGETS !== '') {
    const rawAllow = String(env.APIDASH_ALLOW_LOCAL_TEST_TARGETS).trim().toLowerCase();
    if (rawAllow === 'true' || rawAllow === '1') {
      if (nodeEnv === 'production') {
        errors.push('APIDASH_ALLOW_LOCAL_TEST_TARGETS cannot be enabled in production environment');
      } else {
        allowLocalTestTargets = true;
      }
    }
  }

  // Legacy scheduler flag (deprecated in Phase 4)
  let enableLegacyScheduler = false;
  if (env.ENABLE_LEGACY_SCHEDULER !== undefined) {
    const rawScheduler = String(env.ENABLE_LEGACY_SCHEDULER).trim().toLowerCase();
    if (rawScheduler === 'true' || rawScheduler === '1') {
      enableLegacyScheduler = true;
    } else if (rawScheduler === 'false' || rawScheduler === '0' || rawScheduler === '') {
      enableLegacyScheduler = false;
    } else {
      errors.push(`ENABLE_LEGACY_SCHEDULER must be a boolean ('true' or 'false', got: "${env.ENABLE_LEGACY_SCHEDULER}")`);
    }
  }

  // Phase 4 Worker & Scheduler settings
  const rawConcurrency = env.WORKER_CONCURRENCY !== undefined && env.WORKER_CONCURRENCY !== '' ? env.WORKER_CONCURRENCY : '5';
  const workerConcurrency = Number(rawConcurrency);
  if (!Number.isInteger(workerConcurrency) || workerConcurrency < 1 || workerConcurrency > 50) {
    errors.push(`WORKER_CONCURRENCY must be an integer between 1 and 50 (got: "${rawConcurrency}")`);
  }

  const rawPollInterval = env.WORKER_POLL_INTERVAL_MS !== undefined && env.WORKER_POLL_INTERVAL_MS !== '' ? env.WORKER_POLL_INTERVAL_MS : '1000';
  const workerPollIntervalMs = Number(rawPollInterval);
  if (!Number.isInteger(workerPollIntervalMs) || workerPollIntervalMs < 10 || workerPollIntervalMs > 60000) {
    errors.push(`WORKER_POLL_INTERVAL_MS must be an integer between 10 and 60000 (got: "${rawPollInterval}")`);
  }

  const rawLeaseMs = env.WORKER_LEASE_MS !== undefined && env.WORKER_LEASE_MS !== '' ? env.WORKER_LEASE_MS : '60000';
  const workerLeaseMs = Number(rawLeaseMs);
  if (!Number.isInteger(workerLeaseMs) || workerLeaseMs < 35000 || workerLeaseMs > 600000) {
    errors.push(`WORKER_LEASE_MS must be an integer between 35000 and 600000 (got: "${rawLeaseMs}")`);
  }

  const rawSchedulerInterval = env.SCHEDULER_INTERVAL_MS !== undefined && env.SCHEDULER_INTERVAL_MS !== '' ? env.SCHEDULER_INTERVAL_MS : '30000';
  const schedulerIntervalMs = Number(rawSchedulerInterval);
  if (!Number.isInteger(schedulerIntervalMs) || schedulerIntervalMs < 1000 || schedulerIntervalMs > 86400000) {
    errors.push(`SCHEDULER_INTERVAL_MS must be an integer between 1000 and 86400000 (got: "${rawSchedulerInterval}")`);
  }

  const rawShutdownTimeout = env.WORKER_SHUTDOWN_TIMEOUT_MS !== undefined && env.WORKER_SHUTDOWN_TIMEOUT_MS !== '' ? env.WORKER_SHUTDOWN_TIMEOUT_MS : '35000';
  const workerShutdownTimeoutMs = Number(rawShutdownTimeout);
  if (!Number.isInteger(workerShutdownTimeoutMs) || workerShutdownTimeoutMs < 5000 || workerShutdownTimeoutMs > 120000) {
    errors.push(`WORKER_SHUTDOWN_TIMEOUT_MS must be an integer between 5000 and 120000 (got: "${rawShutdownTimeout}")`);
  }

  // Phase 5 SMTP & Email notification settings
  const smtpHost = env.SMTP_HOST !== undefined ? env.SMTP_HOST.trim() : '';
  const rawSmtpPort = env.SMTP_PORT !== undefined && env.SMTP_PORT !== '' ? env.SMTP_PORT : '587';
  const smtpPort = Number(rawSmtpPort);
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    errors.push(`SMTP_PORT must be an integer between 1 and 65535 (got: "${rawSmtpPort}")`);
  }

  let smtpSecure = false;
  if (env.SMTP_SECURE !== undefined && env.SMTP_SECURE !== '') {
    const rawSecure = String(env.SMTP_SECURE).trim().toLowerCase();
    if (rawSecure === 'true' || rawSecure === '1') {
      smtpSecure = true;
    } else if (rawSecure === 'false' || rawSecure === '0') {
      smtpSecure = false;
    } else {
      errors.push(`SMTP_SECURE must be a boolean ('true' or 'false', got: "${env.SMTP_SECURE}")`);
    }
  }

  const smtpUser = env.SMTP_USER !== undefined ? env.SMTP_USER.trim() : '';
  const smtpPass = env.SMTP_PASS !== undefined ? env.SMTP_PASS : '';
  const smtpFrom = env.SMTP_FROM !== undefined && env.SMTP_FROM.trim() !== ''
    ? env.SMTP_FROM.trim()
    : 'APIDash Alerts <alerts@apidash.local>';

  const isSmtpConfigured = Boolean(smtpHost && smtpPort);

  // SMTP Transport Timeouts (bounded relative to outbox lease duration)
  const rawSmtpConnTimeout = env.SMTP_CONNECTION_TIMEOUT_MS !== undefined && env.SMTP_CONNECTION_TIMEOUT_MS !== ''
    ? env.SMTP_CONNECTION_TIMEOUT_MS : '10000';
  const smtpConnectionTimeoutMs = Number(rawSmtpConnTimeout);
  if (!Number.isInteger(smtpConnectionTimeoutMs) || smtpConnectionTimeoutMs < 1000 || smtpConnectionTimeoutMs > 60000) {
    errors.push(`SMTP_CONNECTION_TIMEOUT_MS must be an integer between 1000 and 60000 (got: "${rawSmtpConnTimeout}")`);
  }

  const rawSmtpGreetingTimeout = env.SMTP_GREETING_TIMEOUT_MS !== undefined && env.SMTP_GREETING_TIMEOUT_MS !== ''
    ? env.SMTP_GREETING_TIMEOUT_MS : '10000';
  const smtpGreetingTimeoutMs = Number(rawSmtpGreetingTimeout);
  if (!Number.isInteger(smtpGreetingTimeoutMs) || smtpGreetingTimeoutMs < 1000 || smtpGreetingTimeoutMs > 60000) {
    errors.push(`SMTP_GREETING_TIMEOUT_MS must be an integer between 1000 and 60000 (got: "${rawSmtpGreetingTimeout}")`);
  }

  const rawSmtpSocketTimeout = env.SMTP_SOCKET_TIMEOUT_MS !== undefined && env.SMTP_SOCKET_TIMEOUT_MS !== ''
    ? env.SMTP_SOCKET_TIMEOUT_MS : '15000';
  const smtpSocketTimeoutMs = Number(rawSmtpSocketTimeout);
  if (!Number.isInteger(smtpSocketTimeoutMs) || smtpSocketTimeoutMs < 1000 || smtpSocketTimeoutMs > 60000) {
    errors.push(`SMTP_SOCKET_TIMEOUT_MS must be an integer between 1000 and 60000 (got: "${rawSmtpSocketTimeout}")`);
  }

  // Absolute wall-clock delivery deadline covering the complete sendMail transaction
  const rawSmtpDeliveryDeadline = env.SMTP_DELIVERY_DEADLINE_MS !== undefined && env.SMTP_DELIVERY_DEADLINE_MS !== ''
    ? env.SMTP_DELIVERY_DEADLINE_MS : '30000';
  const smtpDeliveryDeadlineMs = Number(rawSmtpDeliveryDeadline);
  if (!Number.isInteger(smtpDeliveryDeadlineMs) || smtpDeliveryDeadlineMs < 5000 || smtpDeliveryDeadlineMs > 120000) {
    errors.push(`SMTP_DELIVERY_DEADLINE_MS must be an integer between 5000 and 120000 (got: "${rawSmtpDeliveryDeadline}")`);
  }

  const totalSmtpTimeoutMs = smtpConnectionTimeoutMs + smtpGreetingTimeoutMs + smtpSocketTimeoutMs;

  // Phase 5 Notification Outbox Dispatcher settings
  const rawOutboxConcurrency = env.OUTBOX_CONCURRENCY !== undefined && env.OUTBOX_CONCURRENCY !== '' ? env.OUTBOX_CONCURRENCY : '5';
  const outboxConcurrency = Number(rawOutboxConcurrency);
  if (!Number.isInteger(outboxConcurrency) || outboxConcurrency < 1 || outboxConcurrency > 20) {
    errors.push(`OUTBOX_CONCURRENCY must be an integer between 1 and 20 (got: "${rawOutboxConcurrency}")`);
  }

  const rawOutboxPollInterval = env.OUTBOX_POLL_INTERVAL_MS !== undefined && env.OUTBOX_POLL_INTERVAL_MS !== '' ? env.OUTBOX_POLL_INTERVAL_MS : '1000';
  const outboxPollIntervalMs = Number(rawOutboxPollInterval);
  if (!Number.isInteger(outboxPollIntervalMs) || outboxPollIntervalMs < 10 || outboxPollIntervalMs > 60000) {
    errors.push(`OUTBOX_POLL_INTERVAL_MS must be an integer between 10 and 60000 (got: "${rawOutboxPollInterval}")`);
  }

  const rawOutboxLeaseMs = env.OUTBOX_LEASE_MS !== undefined && env.OUTBOX_LEASE_MS !== '' ? env.OUTBOX_LEASE_MS : '60000';
  const outboxLeaseMs = Number(rawOutboxLeaseMs);
  if (!Number.isInteger(outboxLeaseMs) || outboxLeaseMs < 35000 || outboxLeaseMs > 600000) {
    errors.push(`OUTBOX_LEASE_MS must be an integer between 35000 and 600000 (got: "${rawOutboxLeaseMs}")`);
  } else if (outboxLeaseMs < totalSmtpTimeoutMs) {
    errors.push(`OUTBOX_LEASE_MS (${outboxLeaseMs}ms) must be greater than or equal to total SMTP transport timeout (${totalSmtpTimeoutMs}ms)`);
  } else if (outboxLeaseMs <= smtpDeliveryDeadlineMs + 5000) {
    errors.push(`OUTBOX_LEASE_MS (${outboxLeaseMs}ms) must be at least 5000ms greater than SMTP_DELIVERY_DEADLINE_MS (${smtpDeliveryDeadlineMs}ms)`);
  }

  const rawOutboxMaxAttempts = env.OUTBOX_MAX_ATTEMPTS !== undefined && env.OUTBOX_MAX_ATTEMPTS !== '' ? env.OUTBOX_MAX_ATTEMPTS : '5';
  const outboxMaxAttempts = Number(rawOutboxMaxAttempts);
  if (!Number.isInteger(outboxMaxAttempts) || outboxMaxAttempts < 1 || outboxMaxAttempts > 10) {
    errors.push(`OUTBOX_MAX_ATTEMPTS must be an integer between 1 and 10 (got: "${rawOutboxMaxAttempts}")`);
  }

  // Phase 7 AI-Assisted Incident Investigation settings
  const rawAiProvider = (env.AI_PROVIDER || 'disabled').trim().toLowerCase();
  const validAiProviders = ['disabled', 'gemini', 'ollama', 'openrouter', 'groq', 'fallback'];
  if (nodeEnv !== 'production') {
    validAiProviders.push('mock');
  }
  if (!validAiProviders.includes(rawAiProvider)) {
    errors.push(`AI_PROVIDER must be one of: ${validAiProviders.join(', ')} (got: "${env.AI_PROVIDER}")`);
  }
  const aiProvider = rawAiProvider;

  let aiFallbackEnabled = false;
  if (env.AI_FALLBACK_ENABLED !== undefined && env.AI_FALLBACK_ENABLED !== '') {
    const rawFallback = String(env.AI_FALLBACK_ENABLED).trim().toLowerCase();
    if (rawFallback === 'true' || rawFallback === '1') {
      aiFallbackEnabled = true;
    } else if (rawFallback === 'false' || rawFallback === '0') {
      aiFallbackEnabled = false;
    } else {
      errors.push(`AI_FALLBACK_ENABLED must be a boolean ('true' or 'false', got: "${env.AI_FALLBACK_ENABLED}")`);
    }
  }

  const geminiApiKey = env.GEMINI_API_KEY !== undefined ? env.GEMINI_API_KEY.trim() : '';
  if (aiProvider === 'gemini' && !geminiApiKey) {
    errors.push('GEMINI_API_KEY is required when AI_PROVIDER is "gemini"');
  }

  const geminiModel = env.GEMINI_MODEL !== undefined && env.GEMINI_MODEL.trim() !== ''
    ? env.GEMINI_MODEL.trim()
    : 'gemini-3.8-flash';

  const ollamaBaseUrl = env.OLLAMA_BASE_URL !== undefined && env.OLLAMA_BASE_URL.trim() !== ''
    ? env.OLLAMA_BASE_URL.trim().replace(/\/+$/, '')
    : 'http://localhost:11434';
  if (aiProvider === 'ollama' && !ollamaBaseUrl) {
    errors.push('OLLAMA_BASE_URL cannot be empty when AI_PROVIDER is "ollama"');
  }

  const ollamaModel = env.OLLAMA_MODEL !== undefined && env.OLLAMA_MODEL.trim() !== ''
    ? env.OLLAMA_MODEL.trim()
    : 'qwen3.5:4b';

  const openrouterApiKey = env.OPENROUTER_API_KEY !== undefined ? env.OPENROUTER_API_KEY.trim() : '';
  if (aiProvider === 'openrouter' && !openrouterApiKey) {
    errors.push('OPENROUTER_API_KEY is required when AI_PROVIDER is "openrouter"');
  }

  const openrouterBaseUrl = env.OPENROUTER_BASE_URL !== undefined && env.OPENROUTER_BASE_URL.trim() !== ''
    ? env.OPENROUTER_BASE_URL.trim().replace(/\/+$/, '')
    : 'https://openrouter.ai/api/v1';

  const openrouterModel = env.OPENROUTER_MODEL !== undefined && env.OPENROUTER_MODEL.trim() !== ''
    ? env.OPENROUTER_MODEL.trim()
    : 'nvidia/nemotron-3.5-lightning:free';

  const rawAiTimeout = env.AI_TIMEOUT_MS !== undefined && env.AI_TIMEOUT_MS !== '' ? env.AI_TIMEOUT_MS : '30000';
  const aiTimeoutMs = Number(rawAiTimeout);
  if (!Number.isInteger(aiTimeoutMs) || aiTimeoutMs < 2000 || aiTimeoutMs > 120000) {
    errors.push(`AI_TIMEOUT_MS must be an integer between 2000 and 120000 (got: "${rawAiTimeout}")`);
  }

  const rawGeminiTimeout = env.GEMINI_TIMEOUT_MS !== undefined && env.GEMINI_TIMEOUT_MS !== ''
    ? env.GEMINI_TIMEOUT_MS
    : String(aiTimeoutMs);
  const geminiTimeoutMs = Number(rawGeminiTimeout);
  if (!Number.isInteger(geminiTimeoutMs) || geminiTimeoutMs < 2000 || geminiTimeoutMs > 120000) {
    errors.push(`GEMINI_TIMEOUT_MS must be an integer between 2000 and 120000 (got: "${rawGeminiTimeout}")`);
  }

  const rawOllamaTimeout = env.OLLAMA_TIMEOUT_MS !== undefined && env.OLLAMA_TIMEOUT_MS !== ''
    ? env.OLLAMA_TIMEOUT_MS
    : String(Math.max(aiTimeoutMs, 120000));
  const ollamaTimeoutMs = Number(rawOllamaTimeout);
  if (!Number.isInteger(ollamaTimeoutMs) || ollamaTimeoutMs < 2000 || ollamaTimeoutMs > 300000) {
    errors.push(`OLLAMA_TIMEOUT_MS must be an integer between 2000 and 300000 (got: "${rawOllamaTimeout}")`);
  }

  const rawOpenrouterTimeout = env.OPENROUTER_TIMEOUT_MS !== undefined && env.OPENROUTER_TIMEOUT_MS !== ''
    ? env.OPENROUTER_TIMEOUT_MS
    : String(aiTimeoutMs);
  const openrouterTimeoutMs = Number(rawOpenrouterTimeout);
  if (!Number.isInteger(openrouterTimeoutMs) || openrouterTimeoutMs < 2000 || openrouterTimeoutMs > 120000) {
    errors.push(`OPENROUTER_TIMEOUT_MS must be an integer between 2000 and 120000 (got: "${rawOpenrouterTimeout}")`);
  }

  const rawOpenrouterMaxTokens = env.OPENROUTER_MAX_TOKENS !== undefined && env.OPENROUTER_MAX_TOKENS !== ''
    ? env.OPENROUTER_MAX_TOKENS
    : null;
  let openrouterMaxTokens = null;
  if (rawOpenrouterMaxTokens !== null) {
    const parsed = Number(rawOpenrouterMaxTokens);
    if (!Number.isInteger(parsed) || parsed < 500 || parsed > 32000) {
      errors.push(`OPENROUTER_MAX_TOKENS must be an integer between 500 and 32000 (got: "${rawOpenrouterMaxTokens}")`);
    } else {
      openrouterMaxTokens = parsed;
    }
  }

  const groqApiKey = env.GROQ_API_KEY !== undefined ? env.GROQ_API_KEY.trim() : '';
  if (aiProvider === 'groq' && !groqApiKey) {
    errors.push('GROQ_API_KEY is required when AI_PROVIDER is "groq"');
  }

  const groqBaseUrl = env.GROQ_BASE_URL !== undefined && env.GROQ_BASE_URL.trim() !== ''
    ? env.GROQ_BASE_URL.trim().replace(/\/+$/, '')
    : 'https://api.groq.com/openai/v1';

  const groqModel = env.GROQ_MODEL !== undefined && env.GROQ_MODEL.trim() !== ''
    ? env.GROQ_MODEL.trim()
    : 'openai/gpt-oss-20b';

  const rawGroqTimeout = env.GROQ_TIMEOUT_MS !== undefined && env.GROQ_TIMEOUT_MS !== ''
    ? env.GROQ_TIMEOUT_MS
    : String(aiTimeoutMs);
  const groqTimeoutMs = Number(rawGroqTimeout);
  if (!Number.isInteger(groqTimeoutMs) || groqTimeoutMs < 2000 || groqTimeoutMs > 120000) {
    errors.push(`GROQ_TIMEOUT_MS must be an integer between 2000 and 120000 (got: "${rawGroqTimeout}")`);
  }

  const rawGroqMaxTokens = env.GROQ_MAX_TOKENS !== undefined && env.GROQ_MAX_TOKENS !== ''
    ? env.GROQ_MAX_TOKENS
    : null;
  let groqMaxTokens = null;
  if (rawGroqMaxTokens !== null) {
    const parsed = Number(rawGroqMaxTokens);
    if (!Number.isInteger(parsed) || parsed < 500 || parsed > 65536) {
      errors.push(`GROQ_MAX_TOKENS must be an integer between 500 and 65536 (got: "${rawGroqMaxTokens}")`);
    } else {
      groqMaxTokens = parsed;
    }
  }

  if (aiFallbackEnabled || aiProvider === 'fallback') {
    if (!groqApiKey) {
      errors.push('GROQ_API_KEY is required when AI fallback is enabled');
    }
    if (!openrouterApiKey) {
      errors.push('OPENROUTER_API_KEY is required when AI fallback is enabled');
    }
  }

  const rawAiRetries = env.AI_MAX_RETRIES !== undefined && env.AI_MAX_RETRIES !== '' ? env.AI_MAX_RETRIES : '1';
  const aiMaxRetries = Number(rawAiRetries);
  if (!Number.isInteger(aiMaxRetries) || aiMaxRetries < 0 || aiMaxRetries > 3) {
    errors.push(`AI_MAX_RETRIES must be an integer between 0 and 3 (got: "${rawAiRetries}")`);
  }

  const rawAiConcurrency = env.AI_CONCURRENCY !== undefined && env.AI_CONCURRENCY !== '' ? env.AI_CONCURRENCY : '2';
  const aiConcurrency = Number(rawAiConcurrency);
  if (!Number.isInteger(aiConcurrency) || aiConcurrency < 1 || aiConcurrency > 5) {
    errors.push(`AI_CONCURRENCY must be an integer between 1 and 5 (got: "${rawAiConcurrency}")`);
  }

  const rawAiPollInterval = env.AI_POLL_INTERVAL_MS !== undefined && env.AI_POLL_INTERVAL_MS !== '' ? env.AI_POLL_INTERVAL_MS : '2000';
  const aiPollIntervalMs = Number(rawAiPollInterval);
  if (!Number.isInteger(aiPollIntervalMs) || aiPollIntervalMs < 100 || aiPollIntervalMs > 60000) {
    errors.push(`AI_POLL_INTERVAL_MS must be an integer between 100 and 60000 (got: "${rawAiPollInterval}")`);
  }

  const rawAiLease = env.AI_LEASE_MS !== undefined && env.AI_LEASE_MS !== '' ? env.AI_LEASE_MS : '60000';
  const aiLeaseMs = Number(rawAiLease);
  if (!Number.isInteger(aiLeaseMs) || aiLeaseMs < 35000 || aiLeaseMs > 600000) {
    errors.push(`AI_LEASE_MS must be an integer between 35000 and 600000 (got: "${rawAiLease}")`);
  }

  const rawAiRetention = env.AI_RETENTION_DAYS !== undefined && env.AI_RETENTION_DAYS !== '' ? env.AI_RETENTION_DAYS : '30';
  const aiRetentionDays = Number(rawAiRetention);
  if (!Number.isInteger(aiRetentionDays) || aiRetentionDays < 1 || aiRetentionDays > 365) {
    errors.push(`AI_RETENTION_DAYS must be an integer between 1 and 365 (got: "${rawAiRetention}")`);
  }

  let aiEvalCacheEnabled = true;
  if (env.AI_EVAL_CACHE_ENABLED !== undefined && env.AI_EVAL_CACHE_ENABLED !== '') {
    const rawCache = String(env.AI_EVAL_CACHE_ENABLED).trim().toLowerCase();
    if (rawCache === 'false' || rawCache === '0') {
      aiEvalCacheEnabled = false;
    } else {
      aiEvalCacheEnabled = true;
    }
  }

  // Logging level
  const logLevel = (env.LOG_LEVEL || (nodeEnv === 'test' ? 'silent' : 'info')).trim();

  if (errors.length > 0) {
    throw new ConfigError(`Configuration validation failed:\n- ${errors.join('\n- ')}`, errors);
  }

  return {
    nodeEnv,
    port,
    db: {
      host: dbHost,
      port: dbPort,
      user: dbUser,
      password: dbPassword,
      database: dbName,
      connectionLimit: 10,
    },
    session: {
      secret: sessionSecret || 'apidash_dev_insecure_session_secret_for_local_testing_only_32_chars',
      cookieSecure,
      name: cookieSecure ? '__Host-apidash_sid' : 'apidash_sid',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
    },
    appOrigin,
    ssrf: {
      maxRedirects: ssrfMaxRedirects,
      timeoutMs: ssrfTimeoutMs,
      maxBodyBytes: ssrfMaxBodyBytes,
      allowLocalTestTargets,
    },
    rateLimit: {
      authWindowMs: 15 * 60 * 1000,
      authMax: 10,
      apiWindowMs: 60 * 1000,
      apiMax: 120,
    },
    worker: {
      concurrency: workerConcurrency,
      pollIntervalMs: workerPollIntervalMs,
      leaseMs: workerLeaseMs,
      shutdownTimeoutMs: workerShutdownTimeoutMs,
    },
    smtp: {
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      user: smtpUser,
      pass: smtpPass,
      from: smtpFrom,
      isConfigured: isSmtpConfigured,
      connectionTimeoutMs: smtpConnectionTimeoutMs,
      greetingTimeoutMs: smtpGreetingTimeoutMs,
      socketTimeoutMs: smtpSocketTimeoutMs,
      totalTimeoutMs: totalSmtpTimeoutMs,
      deliveryDeadlineMs: smtpDeliveryDeadlineMs,
    },
    outbox: {
      concurrency: outboxConcurrency,
      pollIntervalMs: outboxPollIntervalMs,
      leaseMs: outboxLeaseMs,
      maxAttempts: outboxMaxAttempts,
    },
    ai: {
      provider: aiProvider,
      gemini: {
        apiKey: geminiApiKey,
        model: geminiModel,
        timeoutMs: geminiTimeoutMs,
      },
      ollama: {
        baseUrl: ollamaBaseUrl,
        model: ollamaModel,
        timeoutMs: ollamaTimeoutMs,
      },
      openrouter: {
        apiKey: openrouterApiKey,
        baseUrl: openrouterBaseUrl,
        model: openrouterModel,
        timeoutMs: openrouterTimeoutMs,
        maxTokens: openrouterMaxTokens,
      },
      groq: {
        apiKey: groqApiKey,
        baseUrl: groqBaseUrl,
        model: groqModel,
        timeoutMs: groqTimeoutMs,
        maxTokens: groqMaxTokens,
      },
      timeoutMs: aiTimeoutMs,
      maxRetries: aiMaxRetries,
      concurrency: aiConcurrency,
      pollIntervalMs: aiPollIntervalMs,
      leaseMs: aiLeaseMs,
      retentionDays: aiRetentionDays,
      evalCacheEnabled: aiEvalCacheEnabled,
      fallback: {
        enabled: aiFallbackEnabled || aiProvider === 'fallback',
        primaryModel: groqModel || 'openai/gpt-oss-20b',
        alternativeModel: openrouterModel || 'nvidia/nemotron-3.5-lightning:free',
      },
      fallbackEnabled: aiFallbackEnabled || aiProvider === 'fallback',
      isEnabled: aiProvider !== 'disabled',
    },
    schedulerIntervalMs,
    enableLegacyScheduler,
    logLevel,
  };
}

module.exports = {
  loadConfig,
  ConfigError,
};
