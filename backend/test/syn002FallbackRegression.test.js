// backend/test/syn002FallbackRegression.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FallbackAiProvider,
  ProcessRateLimitTracker,
  AiProviderError,
} = require('../services/aiProviderService');
const { validateAiResponse } = require('../services/aiResponseValidator');
const { AiAnalysisWorker } = require('../services/aiAnalysisWorker');
const { getFixtures } = require('../ai/evaluation/fixtures/dataset');
const defaultWorkspaceRouter = require('../routes/workspaceRoutes');
const serializeAnalysisForClient = defaultWorkspaceRouter.serializeAnalysisForClient;

// Retrieve real frozen SYN-002 fixture from dataset v1.1.0
const syn002Fixture = getFixtures().find((f) => f.id === 'SYN-002');
const syn002Evidence = syn002Fixture.evidence_package;

// Plausible primary output that mimics the exact recorded failure of SYN-002:
// Valid fields, valid citations ('E-003'), but omitting top-level 'overall_assessment'
const syn002PrimaryOutputMissingOverallAssessment = JSON.stringify({
  summary: 'Persistent HTTP 500 internal server error observed during monitor execution.',
  observed_facts: [
    { fact: 'HTTP status is 500 Internal Server Error.', evidence_ids: ['E-003'] },
  ],
  hypotheses: [
    {
      hypothesis: 'Application database connection pool exhaustion.',
      rationale: 'Persistent 500 status returned on orders endpoint.',
      supporting_evidence_ids: ['E-003'],
      contradicting_evidence_ids: [],
      strength: 'strong',
    },
  ],
  recommended_checks: [
    { check: 'Inspect application server error logs.', rationale: 'Locate 500 stack trace.', evidence_ids: ['E-003'] },
  ],
  unknowns: ['Database health metrics and connection pool utilization'],
  // 'overall_assessment' intentionally omitted!
});

// Valid alternative output that includes 'overall_assessment' and valid citations
const syn002AlternativeValidOutput = JSON.stringify({
  summary: 'Persistent HTTP 500 internal server error observed during monitor execution.',
  observed_facts: [
    { fact: 'HTTP status is 500 Internal Server Error.', evidence_ids: ['E-003'] },
  ],
  hypotheses: [
    {
      hypothesis: 'Application database connection pool exhaustion.',
      rationale: 'Persistent 500 status returned on orders endpoint.',
      supporting_evidence_ids: ['E-003'],
      contradicting_evidence_ids: [],
      strength: 'strong',
    },
  ],
  recommended_checks: [
    { check: 'Inspect application server error logs.', rationale: 'Locate 500 stack trace.', evidence_ids: ['E-003'] },
  ],
  unknowns: ['Database health metrics and connection pool utilization'],
  overall_assessment: {
    confidence: 'high',
    rationale: 'Consecutive HTTP 500 failures confirm an active server-side outage.',
  },
});

test('SYN-002 Regression (1) — Primary missing overall_assessment is rejected by validator, alternative invoked once and succeeds', async () => {
  // Step 1: Prove real validator rejects the primary output
  const primaryValidation = validateAiResponse(syn002PrimaryOutputMissingOverallAssessment, syn002Evidence);
  assert.equal(primaryValidation.valid, false, 'Validator must reject output missing overall_assessment');
  assert.ok(
    primaryValidation.errors.some((e) => e.includes("must have required property 'overall_assessment'")),
    'Error message must indicate missing overall_assessment'
  );

  let primaryCalls = 0;
  let alternativeCalls = 0;

  const mockPrimary = {
    async generateAnalysis() {
      primaryCalls++;
      return {
        rawText: syn002PrimaryOutputMissingOverallAssessment,
        provider: 'groq',
        model: 'openai/gpt-oss-20b',
        durationMs: 1450,
        tokens: { prompt: 1359, completion: 779, total: 2138 },
      };
    },
  };

  const mockAlternative = {
    async generateAnalysis() {
      alternativeCalls++;
      return {
        rawText: syn002AlternativeValidOutput,
        provider: 'openrouter',
        model: 'nvidia/nemotron-3.5-super-vl:free',
        durationMs: 1100,
        tokens: { prompt: 1400, completion: 900, total: 2300 },
      };
    },
  };

  const tracker = new ProcessRateLimitTracker();
  const fallbackProvider = new FallbackAiProvider({
    primary: mockPrimary,
    alternative: mockAlternative,
    tracker,
  });

  const result = await fallbackProvider.generateAnalysis(syn002Evidence);

  // Assertions:
  assert.equal(primaryCalls, 1, 'Primary must be called exactly once');
  assert.equal(alternativeCalls, 1, 'Alternative must be called exactly once upon primary schema failure');
  assert.equal(result.fallback_occurred, true, 'Fallback occurred flag must be true');
  assert.equal(result.provider, 'openrouter', 'Actual successful provider must be openrouter');
  assert.equal(result.model, 'nvidia/nemotron-3.5-super-vl:free', 'Actual successful model must be Nemotron');
  assert.equal(result.composite_provider, 'groq->openrouter');
  assert.equal(result.primary_provider, 'groq');
  assert.equal(result.primary_model, 'openai/gpt-oss-20b');
  assert.equal(result.primary_failure_category, 'SCHEMA_OR_CITATION_FAILURE');
  assert.ok(result.primary_error.message.includes('overall_assessment'));

  // Ensure the final returned output passes server-side validation
  const finalValidation = validateAiResponse(result.rawText, syn002Evidence);
  assert.equal(finalValidation.valid, true, 'Alternative output must be valid');
  assert.ok(finalValidation.result.overall_assessment, 'Final result must contain overall_assessment');
  assert.equal(finalValidation.result.overall_assessment.confidence, 'high');
});

test('SYN-002 Regression (2) — If alternative response is ALSO invalid, analysis fails safely with dual exhaustion', async () => {
  let primaryCalls = 0;
  let alternativeCalls = 0;

  const mockPrimary = {
    async generateAnalysis() {
      primaryCalls++;
      return {
        rawText: syn002PrimaryOutputMissingOverallAssessment,
        provider: 'groq',
        model: 'openai/gpt-oss-20b',
        durationMs: 1400,
      };
    },
  };

  const mockAlternative = {
    async generateAnalysis() {
      alternativeCalls++;
      // Alternative also returns invalid schema
      return {
        rawText: JSON.stringify({ summary: 'Also missing required fields' }),
        provider: 'openrouter',
        model: 'nvidia/nemotron-3.5-super-vl:free',
        durationMs: 900,
      };
    },
  };

  const tracker = new ProcessRateLimitTracker();
  const fallbackProvider = new FallbackAiProvider({
    primary: mockPrimary,
    alternative: mockAlternative,
    tracker,
  });

  await assert.rejects(
    async () => {
      await fallbackProvider.generateAnalysis(syn002Evidence);
    },
    (err) => {
      assert.equal(err.code, 'AI_DUAL_PROVIDER_EXHAUSTION');
      assert.equal(err.statusCode, 503);
      assert.equal(err.retryable, false, 'Must be marked non-retryable to prevent worker loops');
      assert.equal(err.alternativeError.category, 'SCHEMA_OR_CITATION_FAILURE');
      return true;
    }
  );

  assert.equal(primaryCalls, 1);
  assert.equal(alternativeCalls, 1);
});

test('SYN-002 Regression (3) — Worker completes job with _fallback metadata and never repeats fallback cycle', async () => {
  let completedPayload = null;

  const mockAiRepo = {
    async completeJob(jobId, claimToken, payload) {
      completedPayload = payload;
    },
    async failJob() {},
    async cleanupExpired() {
      return 0;
    },
  };

  const mockFallbackProvider = {
    async generateAnalysis() {
      return {
        rawText: syn002AlternativeValidOutput,
        provider: 'openrouter',
        model: 'nvidia/nemotron-3.5-super-vl:free',
        fallback_occurred: true,
        primary_provider: 'groq',
        primary_model: 'openai/gpt-oss-20b',
        primary_failure_category: 'SCHEMA_OR_CITATION_FAILURE',
        primary_error: { code: 'INVALID_AI_OUTPUT', message: "Schema error: must have required property 'overall_assessment'" },
        durationMs: 1100,
        tokens: { prompt: 1400, completion: 900, total: 2300 },
      };
    },
  };

  const worker = new AiAnalysisWorker({
    aiRepo: mockAiRepo,
    aiProvider: mockFallbackProvider,
    isEnabled: true,
  });

  const job = {
    id: 42,
    claimToken: 'token-42',
    provider: 'fallback',
    model: 'openai/gpt-oss-20b',
    evidenceSnapshot: syn002Evidence,
  };

  await worker._processClaimedJob(job);

  assert.ok(completedPayload, 'Worker must complete job successfully');
  assert.equal(completedPayload.durationMs, 1100);
  assert.equal(completedPayload.result._fallback.fallback_occurred, true);
  assert.equal(completedPayload.result._fallback.provider, 'openrouter');
  assert.equal(completedPayload.result._fallback.primary_failure_category, 'SCHEMA_OR_CITATION_FAILURE');
  assert.ok(completedPayload.result.overall_assessment, 'Saved result must have overall_assessment');
});

test('SYN-002 Regression (4) — Local evidence snapshot validation failure calls NEITHER provider', async () => {
  let primaryCalls = 0;
  let alternativeCalls = 0;

  const mockPrimary = {
    async generateAnalysis() {
      primaryCalls++;
    },
  };

  const mockAlternative = {
    async generateAnalysis() {
      alternativeCalls++;
    },
  };

  const fallbackProvider = new FallbackAiProvider({
    primary: mockPrimary,
    alternative: mockAlternative,
    tracker: new ProcessRateLimitTracker(),
  });

  // Invalid evidence snapshot (missing observations)
  await assert.rejects(
    async () => {
      await fallbackProvider.generateAnalysis({ invalid: true });
    },
    (err) => {
      assert.equal(err.code, 'INVALID_EVIDENCE_SNAPSHOT');
      assert.equal(err.statusCode, 400);
      assert.equal(err.retryable, false);
      return true;
    }
  );

  assert.equal(primaryCalls, 0, 'Primary must NOT be called when evidence snapshot is invalid');
  assert.equal(alternativeCalls, 0, 'Alternative must NOT be called when evidence snapshot is invalid');
});

test('SYN-002 Regression (5) — Primary success bypasses alternative completely', async () => {
  let primaryCalls = 0;
  let alternativeCalls = 0;

  const mockPrimary = {
    async generateAnalysis() {
      primaryCalls++;
      return {
        rawText: syn002AlternativeValidOutput, // primary returns valid output directly
        provider: 'groq',
        model: 'openai/gpt-oss-20b',
        durationMs: 1200,
        tokens: { prompt: 1359, completion: 900, total: 2259 },
      };
    },
  };

  const mockAlternative = {
    async generateAnalysis() {
      alternativeCalls++;
      throw new Error('Should never be called on primary success');
    },
  };

  const fallbackProvider = new FallbackAiProvider({
    primary: mockPrimary,
    alternative: mockAlternative,
    tracker: new ProcessRateLimitTracker(),
  });

  const result = await fallbackProvider.generateAnalysis(syn002Evidence);

  assert.equal(primaryCalls, 1);
  assert.equal(alternativeCalls, 0, 'Alternative must be bypassed when primary succeeds');
  assert.equal(result.fallback_occurred, false);
  assert.equal(result.provider, 'groq');
  assert.equal(result.model, 'openai/gpt-oss-20b');
});

test('SYN-002 Regression (6) — Privacy check: serialized client payload strips worker lease tokens and redacts credentials', () => {
  const analysisRecord = {
    id: 101,
    incident_id: 202,
    workspace_id: 1,
    status: 'completed',
    provider: 'openrouter',
    model: 'nvidia/nemotron-3.5-super-vl:free',
    lease_owner_token: 'worker-secret-uuid-12345',
    lease_expires_at: '2026-10-30T10:00:00Z',
    error_message: 'Primary failure with Bearer sk-or-v1-secretKey and gsk_groqSecretKey123',
    result: {
      summary: 'Analysis completed after fallback.',
      _fallback: {
        fallback_occurred: true,
        primary_failure_category: 'SCHEMA_OR_CITATION_FAILURE',
      },
    },
  };

  const clientPayload = serializeAnalysisForClient(analysisRecord);

  assert.equal(clientPayload.id, 101);
  assert.equal(clientPayload.lease_owner_token, undefined, 'lease_owner_token must be stripped');
  assert.equal(clientPayload.lease_expires_at, undefined, 'lease_expires_at must be stripped');
  assert.ok(!clientPayload.error_message.includes('sk-or-v1-secretKey'), 'OpenRouter key must be redacted');
  assert.ok(!clientPayload.error_message.includes('gsk_groqSecretKey123'), 'Groq key must be redacted');
  assert.ok(clientPayload.error_message.includes('[REDACTED_API_KEY]'));
  assert.ok(clientPayload.error_message.includes('Bearer [REDACTED]'));
});

