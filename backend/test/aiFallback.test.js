// backend/test/aiFallback.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FallbackAiProvider,
  ProcessRateLimitTracker,
  AiProviderError,
  createAiProvider,
} = require('../services/aiProviderService');
const { AiAnalysisWorker } = require('../services/aiAnalysisWorker');
const defaultWorkspaceRouter = require('../routes/workspaceRoutes');
const serializeAnalysisForClient = defaultWorkspaceRouter.serializeAnalysisForClient;

// Sample mock evidence package
const mockEvidence = {
  incident_id: 1001,
  workspace_id: 1,
  monitor_id: 10,
  observations: [
    { id: 'E-001', type: 'INCIDENT_LIFECYCLE', status: 'open', duration_seconds: 600, unhealthy_streak: 5 },
    { id: 'E-002', type: 'MONITOR_CONFIGURATION', method: 'GET', url_sanitized: 'https://api.example.com/orders', expected_status: 200 },
    { id: 'E-003', type: 'EXECUTION_OBSERVATION', outcome: 'FAIL', status_code: 500, latency_ms: 1200, error_category: 'HTTP_SERVER_ERROR_500' },
  ],
};

const validStructuredResponse = JSON.stringify({
  summary: 'Persistent HTTP 500 server error observed during recent execution cycles.',
  observed_facts: [
    { fact: 'HTTP status is 500.', evidence_ids: ['E-003'] },
  ],
  hypotheses: [
    {
      hypothesis: 'Backend server connection pool exhausted.',
      rationale: 'Elevated latency and 500 status code.',
      supporting_evidence_ids: ['E-003'],
      contradicting_evidence_ids: [],
      strength: 'strong',
    },
  ],
  recommended_checks: [
    { check: 'Check server logs.', rationale: 'Inspect exception traces.', evidence_ids: ['E-003'] },
  ],
  unknowns: ['Server application logs'],
  overall_assessment: {
    confidence: 'high',
    rationale: 'Sufficient error observations.',
  },
});

test('Fallback Provider (1) — Primary succeeds: returned directly, fallback never called', async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;

  const mockPrimary = {
    async generateAnalysis() {
      primaryCalls++;
      return {
        rawText: validStructuredResponse,
        provider: 'groq',
        model: 'openai/gpt-oss-20b',
        durationMs: 120,
        tokens: { prompt: 100, completion: 50, total: 150 },
        rateLimit: { remainingTokens: 6000, resetTokens: '6s', retryAfter: null },
      };
    },
  };

  const mockAlternative = {
    async generateAnalysis() {
      fallbackCalls++;
      throw new Error('Should not be called');
    },
  };

  const tracker = new ProcessRateLimitTracker();
  const provider = new FallbackAiProvider({
    primary: mockPrimary,
    alternative: mockAlternative,
    tracker,
  });

  const result = await provider.generateAnalysis(mockEvidence);

  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 0);
  assert.equal(result.provider, 'groq');
  assert.equal(result.fallback_occurred, false);
  assert.equal(result.durationMs, 120);
  assert.equal(result.tokens.total, 150);
});

test('Fallback Provider (2) — Primary throws 429 rate limit: fallback invoked, composite indicator recorded', async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;

  const mockPrimary = {
    async generateAnalysis() {
      primaryCalls++;
      const err = new AiProviderError('Rate limit exceeded', 'AI_RATE_LIMIT', 429, true);
      err.rateLimit = { remainingTokens: 0, resetTokens: '5s', retryAfter: 5 };
      throw err;
    },
  };

  const mockAlternative = {
    async generateAnalysis() {
      fallbackCalls++;
      return {
        rawText: validStructuredResponse,
        provider: 'openrouter',
        model: 'nvidia/nemotron-3.5-super-vl:free',
        durationMs: 450,
        tokens: { prompt: 120, completion: 60, total: 180 },
      };
    },
  };

  const tracker = new ProcessRateLimitTracker();
  const provider = new FallbackAiProvider({
    primary: mockPrimary,
    alternative: mockAlternative,
    tracker,
  });

  const result = await provider.generateAnalysis(mockEvidence);

  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.equal(result.fallback_occurred, true);
  assert.equal(result.provider, 'openrouter');
  assert.equal(result.composite_provider, 'groq->openrouter');
  assert.equal(result.primary_provider, 'groq');
  assert.equal(result.primary_model, 'openai/gpt-oss-20b');
  assert.equal(result.primary_error.code, 'AI_RATE_LIMIT');
  assert.equal(result.primary_error.status, 429);
});

test('Fallback Provider (3) — Primary throws 500 server error: fallback invoked, returns valid response', async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;

  const mockPrimary = {
    async generateAnalysis() {
      primaryCalls++;
      throw new AiProviderError('Groq internal error', 'AI_UPSTREAM_ERROR', 500, true);
    },
  };

  const mockAlternative = {
    async generateAnalysis() {
      fallbackCalls++;
      return {
        rawText: validStructuredResponse,
        provider: 'openrouter',
        model: 'nvidia/nemotron-3.5-super-vl:free',
        durationMs: 380,
      };
    },
  };

  const provider = new FallbackAiProvider({
    primary: mockPrimary,
    alternative: mockAlternative,
    tracker: new ProcessRateLimitTracker(),
  });

  const result = await provider.generateAnalysis(mockEvidence);

  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.equal(result.fallback_occurred, true);
  assert.equal(result.primary_error.status, 500);
});

test('Fallback Provider (4) — Primary throws timeout (AI_TIMEOUT): fallback invoked, returns valid response', async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;

  const mockPrimary = {
    async generateAnalysis() {
      primaryCalls++;
      throw new AiProviderError('Request timed out after 30000ms', 'AI_TIMEOUT', 504, true);
    },
  };

  const mockAlternative = {
    async generateAnalysis() {
      fallbackCalls++;
      return {
        rawText: validStructuredResponse,
        provider: 'openrouter',
        model: 'nvidia/nemotron-3.5-super-vl:free',
        durationMs: 510,
      };
    },
  };

  const provider = new FallbackAiProvider({
    primary: mockPrimary,
    alternative: mockAlternative,
    tracker: new ProcessRateLimitTracker(),
  });

  const result = await provider.generateAnalysis(mockEvidence);

  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.equal(result.fallback_occurred, true);
  assert.equal(result.primary_error.code, 'AI_TIMEOUT');
});

test('Fallback Provider (5) — Fast-path fallback: in-memory state marks primary blocked; primary skipped with 0 calls', async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;

  const mockPrimary = {
    async generateAnalysis() {
      primaryCalls++;
      return { rawText: validStructuredResponse };
    },
  };

  const mockAlternative = {
    async generateAnalysis() {
      fallbackCalls++;
      return {
        rawText: validStructuredResponse,
        provider: 'openrouter',
        model: 'nvidia/nemotron-3.5-super-vl:free',
        durationMs: 200,
      };
    },
  };

  const tracker = new ProcessRateLimitTracker();
  // Manually record that primary is blocked for the next 15 seconds
  tracker.recordRateLimit({ retryAfter: 15 }, 15000);
  assert.equal(tracker.isBlocked(), true);

  const provider = new FallbackAiProvider({
    primary: mockPrimary,
    alternative: mockAlternative,
    tracker,
  });

  const result = await provider.generateAnalysis(mockEvidence);

  assert.equal(primaryCalls, 0, 'Primary should have been skipped on fast path');
  assert.equal(fallbackCalls, 1);
  assert.equal(result.fallback_occurred, true);
  assert.equal(result.primary_error.fastPath, true);
  assert.equal(result.primary_error.code, 'AI_RATE_LIMIT');
});

test('Fallback Provider (6) — In-memory state clears after reset window passes; primary attempted again', async () => {
  const tracker = new ProcessRateLimitTracker();
  // Set blockedUntil to 20ms in the future
  tracker.blockedUntil = Date.now() + 20;
  assert.equal(tracker.isBlocked(), true);

  // Wait 30ms so reset window passes
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(tracker.isBlocked(), false, 'State should clear naturally after window passes');
});

test('Fallback Provider (7) — Token budget check: remaining tokens < 2500 routes to fallback without calling primary', async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;

  const mockPrimary = {
    async generateAnalysis() {
      primaryCalls++;
      return { rawText: validStructuredResponse };
    },
  };

  const mockAlternative = {
    async generateAnalysis() {
      fallbackCalls++;
      return {
        rawText: validStructuredResponse,
        provider: 'openrouter',
        model: 'nvidia/nemotron-3.5-super-vl:free',
        durationMs: 250,
      };
    },
  };

  const tracker = new ProcessRateLimitTracker();
  // Simulate previous response leaving only 1,200 tokens with a 10s reset window
  tracker.recordSuccess({ remainingTokens: 1200, resetTokens: '10s' });
  assert.equal(tracker.isBlocked(2500), true, 'Budget < 2500 should be marked blocked');

  const provider = new FallbackAiProvider({
    primary: mockPrimary,
    alternative: mockAlternative,
    tracker,
  });

  const result = await provider.generateAnalysis(mockEvidence);

  assert.equal(primaryCalls, 0, 'Primary should have been skipped due to token budget exhaustion');
  assert.equal(fallbackCalls, 1);
  assert.equal(result.fallback_occurred, true);
});

test('Fallback Provider (8a) — Local evidence snapshot validation failure before dispatch: calls NEITHER provider', async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;

  const mockPrimary = {
    async generateAnalysis() {
      primaryCalls++;
      return { rawText: validStructuredResponse };
    },
  };

  const mockAlternative = {
    async generateAnalysis() {
      fallbackCalls++;
      return { rawText: validStructuredResponse };
    },
  };

  const provider = new FallbackAiProvider({
    primary: mockPrimary,
    alternative: mockAlternative,
    tracker: new ProcessRateLimitTracker(),
  });

  await assert.rejects(
    async () => {
      await provider.generateAnalysis(null);
    },
    (err) => {
      assert.equal(err.code, 'INVALID_EVIDENCE_SNAPSHOT');
      return true;
    }
  );

  await assert.rejects(
    async () => {
      await provider.generateAnalysis({ observations: [] });
    },
    (err) => {
      assert.equal(err.code, 'INVALID_EVIDENCE_SNAPSHOT');
      return true;
    }
  );

  assert.equal(primaryCalls, 0, 'Primary must never be called on local preflight validation failure');
  assert.equal(fallbackCalls, 0, 'Alternative must never be called on local preflight validation failure');
});

test('Fallback Provider (8b) — Primary HTTP 400/401 error: falls back to alternative with diagnostic preserved', async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;

  const mockPrimary = {
    async generateAnalysis() {
      primaryCalls++;
      throw new AiProviderError('Invalid Groq API key or unauthorized request', 'AI_AUTH_FAILED', 401, false);
    },
  };

  const mockAlternative = {
    async generateAnalysis() {
      fallbackCalls++;
      return {
        rawText: validStructuredResponse,
        provider: 'openrouter',
        model: 'nvidia/nemotron-3.5-super-vl:free',
        durationMs: 340,
      };
    },
  };

  const provider = new FallbackAiProvider({
    primary: mockPrimary,
    alternative: mockAlternative,
    tracker: new ProcessRateLimitTracker(),
  });

  const result = await provider.generateAnalysis(mockEvidence);

  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.equal(result.fallback_occurred, true);
  assert.equal(result.provider, 'openrouter');
  assert.equal(result.primary_provider, 'groq');
  assert.equal(result.primary_error.status, 401);
  assert.equal(result.primary_failure_category, 'AUTH_CONFIGURATION_ERROR');
  assert.ok(result.primary_error.message.includes('Primary provider configuration or credential error'));
});

test('Fallback Provider (8c) — Primary response schema or citation validation failure: falls back to alternative', async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;

  const mockPrimary = {
    async generateAnalysis() {
      primaryCalls++;
      // Returns malformed schema missing required properties
      return {
        rawText: JSON.stringify({ summary: 'Missing observed_facts, hypotheses, etc.' }),
        provider: 'groq',
        model: 'openai/gpt-oss-20b',
        durationMs: 150,
      };
    },
  };

  const mockAlternative = {
    async generateAnalysis() {
      fallbackCalls++;
      return {
        rawText: validStructuredResponse,
        provider: 'openrouter',
        model: 'nvidia/nemotron-3.5-super-vl:free',
        durationMs: 380,
      };
    },
  };

  const provider = new FallbackAiProvider({
    primary: mockPrimary,
    alternative: mockAlternative,
    tracker: new ProcessRateLimitTracker(),
  });

  const result = await provider.generateAnalysis(mockEvidence);

  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.equal(result.fallback_occurred, true);
  assert.equal(result.provider, 'openrouter');
  assert.equal(result.primary_error.code, 'INVALID_AI_OUTPUT');
  assert.equal(result.primary_failure_category, 'SCHEMA_OR_CITATION_FAILURE');
});

test('Fallback Provider (9) — Both providers fail: throws AI_DUAL_PROVIDER_EXHAUSTION with retryable: false', async () => {
  const mockPrimary = {
    async generateAnalysis() {
      const err = new AiProviderError('Rate limit exceeded', 'AI_RATE_LIMIT', 429, true);
      err.rateLimit = { remainingTokens: 0, resetTokens: '8s', retryAfter: 8 };
      throw err;
    },
  };

  const mockAlternative = {
    async generateAnalysis() {
      throw new AiProviderError('OpenRouter error 502 Bad Gateway', 'AI_UPSTREAM_ERROR', 502, true);
    },
  };

  const provider = new FallbackAiProvider({
    primary: mockPrimary,
    alternative: mockAlternative,
    tracker: new ProcessRateLimitTracker(),
  });

  await assert.rejects(
    async () => {
      await provider.generateAnalysis(mockEvidence);
    },
    (err) => {
      assert.equal(err.code, 'AI_DUAL_PROVIDER_EXHAUSTION');
      assert.equal(err.statusCode, 503);
      assert.equal(err.retryable, false, 'Dual failure MUST be marked non-retryable to prevent worker loops');
      assert.ok(err.primaryError);
      assert.ok(err.alternativeError);
      return true;
    }
  );
});

test('Fallback Provider (10) — Safe user failure message when rate-limited: states monitoring is operational and includes Retry-After seconds', async () => {
  const mockPrimary = {
    async generateAnalysis() {
      const err = new AiProviderError('Rate limit', 'AI_RATE_LIMIT', 429, true);
      err.rateLimit = { remainingTokens: 0, retryAfter: 12 };
      throw err;
    },
  };

  const mockAlternative = {
    async generateAnalysis() {
      throw new AiProviderError('Alternative rate limit', 'AI_RATE_LIMIT', 429, true);
    },
  };

  const provider = new FallbackAiProvider({
    primary: mockPrimary,
    alternative: mockAlternative,
    tracker: new ProcessRateLimitTracker(),
  });

  try {
    await provider.generateAnalysis(mockEvidence);
    assert.fail('Expected exception');
  } catch (err) {
    assert.ok(err.message.includes('could not be completed at this time'), 'Missing generic non-completion statement');
    assert.ok(err.message.includes('monitoring probes and incident history remain fully operational'), 'Missing monitoring operational statement');
    assert.ok(err.message.includes('12 seconds'), 'Message missing Retry-After seconds hint');
    assert.equal(err.retryAfter, 12);
  }
});

test('Fallback Provider (10b) — Safe user failure message when non-rate-limited: does NOT claim rate limit or report seconds', async () => {
  const mockPrimary = {
    async generateAnalysis() {
      throw new AiProviderError('Primary 500 internal server error', 'AI_UPSTREAM_ERROR', 500, true);
    },
  };

  const mockAlternative = {
    async generateAnalysis() {
      throw new AiProviderError('Alternative 502 bad gateway', 'AI_UPSTREAM_ERROR', 502, true);
    },
  };

  const provider = new FallbackAiProvider({
    primary: mockPrimary,
    alternative: mockAlternative,
    tracker: new ProcessRateLimitTracker(),
  });

  try {
    await provider.generateAnalysis(mockEvidence);
    assert.fail('Expected exception');
  } catch (err) {
    assert.ok(err.message.includes('could not be completed at this time'), 'Missing generic non-completion statement');
    assert.ok(err.message.includes('monitoring probes and incident history remain fully operational'), 'Missing monitoring operational statement');
    assert.ok(!err.message.includes('seconds'), 'Must NOT report seconds when failure is not rate limited');
    assert.ok(!err.message.includes('rate limit'), 'Must NOT claim rate limiting when cause is upstream 5xx');
    assert.ok(err.message.includes('You may request analysis again at any time.'), 'Must state manual retry is available at any time');
    assert.equal(err.retryAfter, null);
  }
});

test('Fallback Provider (11) — Dual failure does NOT leak API keys, auth headers, or raw provider stack traces', async () => {
  const secretKey = 'gsk_realSecretKeyThatMustNeverBeLeakedToUser';
  const secretBearer = 'Bearer sk-or-v1-secretKeyOpenRouter';

  const mockPrimary = {
    async generateAnalysis() {
      throw new AiProviderError(`Failed request with Authorization: ${secretBearer} and key ${secretKey}`, 'AI_RATE_LIMIT', 429, true);
    },
  };

  const mockAlternative = {
    async generateAnalysis() {
      throw new AiProviderError(`OpenRouter crashed with internal key ${secretKey}`, 'AI_UPSTREAM_ERROR', 500, true);
    },
  };

  const provider = new FallbackAiProvider({
    primary: mockPrimary,
    alternative: mockAlternative,
    tracker: new ProcessRateLimitTracker(),
  });

  try {
    await provider.generateAnalysis(mockEvidence);
    assert.fail('Expected exception');
  } catch (err) {
    // User-facing message must be sanitized and safe
    assert.ok(!err.message.includes(secretKey), 'Leaked secretKey in error message!');
    assert.ok(!err.message.includes('sk-or-v1'), 'Leaked bearer token in error message!');
    assert.ok(!err.message.includes('Authorization:'), 'Leaked header in error message!');
    assert.equal(err.code, 'AI_DUAL_PROVIDER_EXHAUSTION');
  }
});

test('Diagnostic Privacy (11b) — serializeAnalysisForClient sanitizes lease tokens, raw keys, and authorization headers from client payload', () => {
  const rawJob = {
    id: 42,
    incident_id: 101,
    workspace_id: 1,
    status: 'failed',
    provider: 'fallback',
    model: 'openai/gpt-oss-20b',
    lease_owner_token: 'worker-instance-abc-secret-uuid',
    lease_expires_at: '2026-10-30T12:00:00Z',
    error_code: 'AI_DUAL_PROVIDER_EXHAUSTION',
    error_message: 'Failed request with Authorization: Bearer sk-or-v1-1234567890abcdef and gsk_9999888877776666 and key=secretKeyVal123',
  };

  const serialized = serializeAnalysisForClient(rawJob);

  assert.equal(serialized.id, 42);
  assert.equal(serialized.lease_owner_token, undefined, 'lease_owner_token must be stripped');
  assert.equal(serialized.lease_expires_at, undefined, 'lease_expires_at must be stripped');
  assert.ok(!serialized.error_message.includes('worker-instance-abc-secret-uuid'));
  assert.ok(!serialized.error_message.includes('sk-or-v1-1234567890abcdef'), 'OpenRouter secret token leaked');
  assert.ok(!serialized.error_message.includes('gsk_9999888877776666'), 'Groq secret key leaked');
  assert.ok(!serialized.error_message.includes('secretKeyVal123'), 'URL key leaked');
  assert.ok(serialized.error_message.includes('[REDACTED_API_KEY]'));
  assert.ok(serialized.error_message.includes('Bearer [REDACTED]'));
});

test('Worker Retry Coordination (12) — Dual failure marks job non-retryable in repository, claim cleared, no endless polling', async () => {
  let failJobCalledWith = null;

  const mockAiRepo = {
    async claimDueJobs() {
      return [];
    },
    async completeJob() {},
    async failJob(jobId, claimToken, payload) {
      failJobCalledWith = { jobId, claimToken, payload };
    },
    async cleanupExpired() {
      return 0;
    },
  };

  // Provider that throws non-retryable dual failure
  const mockProvider = {
    async generateAnalysis() {
      throw new AiProviderError(
        'AI investigation temporarily unavailable due to upstream provider rate limits. Please try again in 15 seconds.',
        'AI_DUAL_PROVIDER_EXHAUSTION',
        503,
        false // retryable = false
      );
    },
  };

  const worker = new AiAnalysisWorker({
    aiRepo: mockAiRepo,
    aiProvider: mockProvider,
    isEnabled: true,
  });

  const job = {
    id: 999,
    claimToken: 'token-abc',
    provider: 'fallback',
    model: 'openai/gpt-oss-20b',
    evidenceSnapshot: mockEvidence,
  };

  await worker._processClaimedJob(job);

  assert.ok(failJobCalledWith, 'failJob was not called on dual failure');
  assert.equal(failJobCalledWith.jobId, 999);
  assert.equal(failJobCalledWith.claimToken, 'token-abc');
  assert.equal(failJobCalledWith.payload.retryable, false, 'Worker must mark dual failure job as non-retryable');
  assert.equal(failJobCalledWith.payload.errorCode, 'AI_DUAL_PROVIDER_EXHAUSTION');
  assert.ok(failJobCalledWith.payload.errorMessage.includes('temporarily unavailable'));
});

test('Worker Success on Fallback (13) — Analysis record stored with composite provider indicator and fallback metadata', async () => {
  let completedJobWith = null;

  const mockAiRepo = {
    async claimDueJobs() {
      return [];
    },
    async completeJob(jobId, claimToken, payload) {
      completedJobWith = { jobId, claimToken, payload };
    },
    async failJob() {},
    async cleanupExpired() {
      return 0;
    },
  };

  const mockProvider = {
    async generateAnalysis() {
      return {
        rawText: validStructuredResponse,
        provider: 'groq->openrouter',
        model: 'nvidia/nemotron-3.5-super-vl:free',
        fallback_occurred: true,
        primary_provider: 'groq',
        primary_model: 'openai/gpt-oss-20b',
        primary_error: { code: 'AI_RATE_LIMIT', status: 429, message: 'Rate limit' },
        durationMs: 350,
        tokens: { prompt: 110, completion: 55, total: 165 },
      };
    },
  };

  const worker = new AiAnalysisWorker({
    aiRepo: mockAiRepo,
    aiProvider: mockProvider,
    isEnabled: true,
  });

  const job = {
    id: 1000,
    claimToken: 'token-xyz',
    provider: 'fallback',
    model: 'openai/gpt-oss-20b',
    evidenceSnapshot: mockEvidence,
  };

  await worker._processClaimedJob(job);

  assert.ok(completedJobWith, 'completeJob was not called');
  assert.equal(completedJobWith.jobId, 1000);
  assert.equal(completedJobWith.claimToken, 'token-xyz');
  assert.equal(completedJobWith.payload.durationMs, 350);
  assert.equal(completedJobWith.payload.tokens.total, 165);

  const savedResult = completedJobWith.payload.result;
  assert.ok(savedResult._fallback, 'Missing _fallback metadata in saved result');
  assert.equal(savedResult._fallback.fallback_occurred, true);
  assert.equal(savedResult._fallback.provider, 'groq->openrouter');
  assert.equal(savedResult._fallback.primary_provider, 'groq');
  assert.equal(savedResult._fallback.primary_error.code, 'AI_RATE_LIMIT');
});

test('Factory Selection — createAiProvider returns FallbackAiProvider when AI_PROVIDER=fallback or fallback enabled', () => {
  const fallbackConfig = {
    ai: {
      provider: 'fallback',
      isEnabled: true,
      groq: { apiKey: 'dummy-groq' },
      openrouter: { apiKey: 'dummy-or' },
    },
  };

  const provider1 = createAiProvider(fallbackConfig);
  assert.ok(provider1 instanceof FallbackAiProvider, 'Should instantiate FallbackAiProvider for AI_PROVIDER=fallback');

  const groqWithFallbackConfig = {
    ai: {
      provider: 'groq',
      fallbackEnabled: true,
      isEnabled: true,
      groq: { apiKey: 'dummy-groq' },
      openrouter: { apiKey: 'dummy-or' },
    },
  };

  const provider2 = createAiProvider(groqWithFallbackConfig);
  assert.ok(provider2 instanceof FallbackAiProvider, 'Should instantiate FallbackAiProvider for AI_PROVIDER=groq with fallbackEnabled');
});

