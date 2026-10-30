// backend/test/groqProvider.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GroqAiProvider, createAiProvider, AiProviderError } = require('../services/aiProviderService');
const { responseJsonSchema } = require('../services/aiResponseValidator');

const MOCK_SNAPSHOT = {
  incident_id: 201,
  workspace_id: 1,
  monitor_id: 20,
  observations: [
    { id: 'E-001', type: 'INCIDENT_LIFECYCLE', status: 'open', error_summary: 'HTTP 502 Bad Gateway' },
    { id: 'E-002', type: 'EXECUTION_OBSERVATION', outcome: 'FAIL', status_code: 502, latency_ms: 850 },
  ],
};

const VALID_RESPONSE_PAYLOAD = {
  summary: 'Upstream gateway failure resulting in HTTP 502 responses.',
  observed_facts: [
    { fact: 'HTTP 502 Bad Gateway returned consistently with 850ms latency.', evidence_ids: ['E-001', 'E-002'] },
  ],
  hypotheses: [
    {
      hypothesis: 'Reverse proxy cannot connect to upstream application server.',
      rationale: '502 status indicates gateway reached but upstream backend was unreachable.',
      supporting_evidence_ids: ['E-002'],
      contradicting_evidence_ids: [],
      strength: 'strong',
    },
  ],
  recommended_checks: [
    { check: 'Inspect ingress reverse proxy error logs and upstream health checks.', rationale: 'Confirm backend connectivity.', evidence_ids: ['E-002'] },
  ],
  unknowns: ['Upstream application container CPU and process memory are missing from probe data.'],
  overall_assessment: {
    confidence: 'high',
    rationale: 'Observed HTTP 502 status conclusively points to upstream gateway layer.',
  },
};

test('Groq Provider — Throws when GROQ_API_KEY is not configured', async () => {
  const provider = new GroqAiProvider({
    ai: { groq: { apiKey: '', model: 'openai/gpt-oss-20b' } },
  });

  await assert.rejects(
    async () => {
      await provider.generateAnalysis(MOCK_SNAPSHOT);
    },
    (err) => {
      assert.equal(err.code, 'GROQ_AUTH_MISSING');
      assert.equal(err.status, 401);
      assert.equal(err.isRetryable, false);
      return true;
    }
  );
});

test('Groq Provider — Selects compatible json_object format directly by default (avoiding predictable 400 rejection)', async () => {
  const originalFetch = global.fetch;
  let interceptedUrl = null;
  let interceptedOptions = null;

  global.fetch = async (url, options) => {
    interceptedUrl = url;
    interceptedOptions = options;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'chatcmpl-groq-12345',
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify(VALID_RESPONSE_PAYLOAD),
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 350,
          completion_tokens: 160,
          total_tokens: 510,
        },
      }),
    };
  };

  try {
    const provider = new GroqAiProvider({
      ai: {
        groq: {
          apiKey: 'gsk_mock_valid_key_1234567890abcdef',
          baseUrl: 'https://api.groq.com/openai/v1',
          model: 'openai/gpt-oss-20b',
          timeoutMs: 30000,
        },
      },
    });

    const result = await provider.generateAnalysis(MOCK_SNAPSHOT);

    assert.equal(interceptedUrl, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(interceptedOptions.method, 'POST');
    assert.equal(interceptedOptions.headers['Authorization'], 'Bearer gsk_mock_valid_key_1234567890abcdef');
    assert.equal(interceptedOptions.headers['Content-Type'], 'application/json');

    const body = JSON.parse(interceptedOptions.body);
    assert.equal(body.model, 'openai/gpt-oss-20b');
    assert.equal(body.temperature, 0.1);
    assert.equal(body.max_tokens, 4000);
    assert.deepEqual(body.response_format, { type: 'json_object' });

    assert.equal(result.provider, 'groq');
    assert.equal(result.model, 'openai/gpt-oss-20b');
    assert.equal(result.tokens.prompt, 350);
    assert.equal(result.tokens.completion, 160);
    assert.equal(result.tokens.total, 510);
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.requestAttempts, 1);
    assert.deepEqual(JSON.parse(result.rawText), VALID_RESPONSE_PAYLOAD);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Groq Provider — Gracefully falls back from explicit json_schema to json_object when 400 is returned', async () => {
  const originalFetch = global.fetch;
  const attempts = [];

  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    attempts.push(body.response_format);

    if (attempts.length === 1) {
      // First attempt with json_schema is rejected by model route with 400
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: 'Provider does not support json_schema format' } }),
      };
    }

    // Second attempt with json_object succeeds
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(VALID_RESPONSE_PAYLOAD) } }],
        usage: { prompt_tokens: 350, completion_tokens: 160, total_tokens: 510 },
      }),
    };
  };

  try {
    const provider = new GroqAiProvider({
      ai: {
        groq: {
          apiKey: 'gsk_test_fallback_key',
          model: 'openai/gpt-oss-20b',
        },
      },
    });

    const result = await provider.generateAnalysis(MOCK_SNAPSHOT, {
      responseFormat: {
        type: 'json_schema',
        json_schema: {
          name: 'incident_investigation',
          strict: true,
          schema: responseJsonSchema,
        },
      },
    });

    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].type, 'json_schema');
    assert.equal(attempts[1].type, 'json_object');
    assert.equal(result.requestAttempts, 2);
    assert.deepEqual(JSON.parse(result.rawText), VALID_RESPONSE_PAYLOAD);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Groq Provider — Correctly strips markdown code fences from response', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: `\`\`\`json\n${JSON.stringify(VALID_RESPONSE_PAYLOAD)}\n\`\`\``,
          },
        },
      ],
      usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
    }),
  });

  try {
    const provider = new GroqAiProvider({
      ai: { groq: { apiKey: 'gsk_test', model: 'openai/gpt-oss-20b' } },
    });

    const result = await provider.generateAnalysis(MOCK_SNAPSHOT);
    assert.equal(result.rawText.startsWith('```'), false);
    assert.deepEqual(JSON.parse(result.rawText), VALID_RESPONSE_PAYLOAD);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Groq Provider — Redacts API keys and Bearer tokens in error messages', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () =>
      JSON.stringify({
        error: {
          message: 'Invalid key gsk_super_secret_groq_key_99999 or Bearer secret-token-xyz provided in Authorization',
        },
      }),
  });

  try {
    const provider = new GroqAiProvider({
      ai: { groq: { apiKey: 'gsk_super_secret_groq_key_99999', model: 'openai/gpt-oss-20b' } },
    });

    await assert.rejects(
      async () => {
        await provider.generateAnalysis(MOCK_SNAPSHOT);
      },
      (err) => {
        assert.equal(err.message.includes('gsk_super_secret'), false);
        assert.equal(err.message.includes('secret-token-xyz'), false);
        assert.equal(err.message.includes('[REDACTED_API_KEY]'), true);
        assert.equal(err.message.includes('Bearer [REDACTED]'), true);
        assert.equal(err.code, 'AI_AUTH_FAILED');
        assert.equal(err.status, 401);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('Groq Provider — Maps error codes: 400, 403, 404, 413, 422, 429, 500', async () => {
  const originalFetch = global.fetch;

  const testCases = [
    { status: 400, body: 'Bad request invalid payload', expectedCode: 'AI_BAD_REQUEST', retryable: false },
    { status: 403, body: 'Access denied: quota exceeded', expectedCode: 'AI_QUOTA_EXHAUSTED', retryable: false },
    { status: 403, body: 'Forbidden resource', expectedCode: 'AI_FORBIDDEN', retryable: false },
    { status: 404, body: 'Model not found', expectedCode: 'AI_MODEL_NOT_FOUND', retryable: false },
    { status: 413, body: 'Request entity too large', expectedCode: 'AI_PAYLOAD_TOO_LARGE', retryable: false },
    { status: 422, body: 'Unprocessable entity', expectedCode: 'AI_UNPROCESSABLE_ENTITY', retryable: false },
    { status: 429, body: 'Rate limit reached', expectedCode: 'AI_RATE_LIMIT', retryable: true },
    { status: 503, body: 'Service temporarily unavailable', expectedCode: 'AI_UPSTREAM_ERROR', retryable: true },
  ];

  for (const tc of testCases) {
    global.fetch = async () => ({
      ok: false,
      status: tc.status,
      text: async () => JSON.stringify({ error: { message: tc.body } }),
    });

    try {
      const provider = new GroqAiProvider({
        ai: { groq: { apiKey: 'gsk_test', model: 'openai/gpt-oss-20b' } },
      });

      await assert.rejects(
        async () => {
          await provider.generateAnalysis(MOCK_SNAPSHOT);
        },
        (err) => {
          assert.equal(err.code, tc.expectedCode, `Expected ${tc.expectedCode} for status ${tc.status}`);
          assert.equal(err.status, tc.status);
          assert.equal(err.isRetryable, tc.retryable);
          return true;
        }
      );
    } finally {
      global.fetch = originalFetch;
    }
  }
});

test('Groq Provider — Handles request timeout cleanly as AI_TIMEOUT', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    throw err;
  };

  try {
    const provider = new GroqAiProvider({
      ai: { groq: { apiKey: 'gsk_test', model: 'openai/gpt-oss-20b', timeoutMs: 5000 } },
    });

    await assert.rejects(
      async () => {
        await provider.generateAnalysis(MOCK_SNAPSHOT);
      },
      (err) => {
        assert.equal(err.code, 'AI_TIMEOUT');
        assert.equal(err.status, 504);
        assert.equal(err.isRetryable, true);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('Groq Provider — Throws AI_EMPTY_RESPONSE when choices are empty', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    }),
  });

  try {
    const provider = new GroqAiProvider({
      ai: { groq: { apiKey: 'gsk_test', model: 'openai/gpt-oss-20b' } },
    });

    await assert.rejects(
      async () => {
        await provider.generateAnalysis(MOCK_SNAPSHOT);
      },
      (err) => {
        assert.equal(err.code, 'AI_EMPTY_RESPONSE');
        assert.equal(err.status, 502);
        assert.equal(err.isRetryable, false);
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('createAiProvider factory creates GroqAiProvider when AI_PROVIDER=groq', () => {
  const provider = createAiProvider({
    ai: {
      provider: 'groq',
      groq: {
        apiKey: 'gsk_test_key_factory',
        model: 'openai/gpt-oss-20b',
      },
    },
  });

  assert.equal(provider instanceof GroqAiProvider, true);
  assert.equal(provider.model, 'openai/gpt-oss-20b');
});

test('Groq Provider — Respects explicit max_tokens option override', async () => {
  const originalFetch = global.fetch;
  let interceptedBody = null;

  global.fetch = async (_url, options) => {
    interceptedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(VALID_RESPONSE_PAYLOAD) } }],
        usage: { prompt_tokens: 300, completion_tokens: 150, total_tokens: 450 },
      }),
    };
  };

  try {
    const provider = new GroqAiProvider({
      ai: {
        groq: {
          apiKey: 'gsk_test_max_tokens',
          model: 'openai/gpt-oss-20b',
        },
      },
    });

    await provider.generateAnalysis(MOCK_SNAPSHOT, { maxTokens: 2000 });
    assert.equal(interceptedBody.max_tokens, 2000);

    await provider.generateAnalysis(MOCK_SNAPSHOT, { max_tokens: 5000 });
    assert.equal(interceptedBody.max_tokens, 5000);
  } finally {
    global.fetch = originalFetch;
  }
});

