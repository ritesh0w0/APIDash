// backend/test/openrouterProvider.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenRouterAiProvider, createAiProvider, AiProviderError } = require('../services/aiProviderService');
const { responseJsonSchema } = require('../services/aiResponseValidator');
const { getSystemPrompt, formatEvidencePrompt } = require('../ai/prompts/systemPrompt.v1');

const MOCK_SNAPSHOT = {
  incident_id: 101,
  workspace_id: 1,
  monitor_id: 10,
  observations: [
    { id: 'E-001', type: 'INCIDENT_LIFECYCLE', status: 'open', error_summary: 'HTTP 500 Internal Server Error' },
    { id: 'E-002', type: 'EXECUTION_OBSERVATION', outcome: 'FAIL', status_code: 500, latency_ms: 1200 },
  ],
};

const VALID_RESPONSE_PAYLOAD = {
  summary: 'Database connection pool exhausted during peak request volume.',
  observed_facts: [
    { fact: 'HTTP 500 returned consistently with 1200ms latency.', evidence_ids: ['E-001', 'E-002'] },
  ],
  hypotheses: [
    {
      hypothesis: 'Database connection pool starvation.',
      rationale: 'Long execution duration before 500 indicates connection acquisition wait.',
      supporting_evidence_ids: ['E-002'],
      contradicting_evidence_ids: [],
      strength: 'strong',
    },
  ],
  recommended_checks: [
    { check: 'Review active database connections and pool metrics.', rationale: 'Confirm pool exhaustion.', evidence_ids: ['E-002'] },
  ],
  unknowns: ['Database server CPU and disk utilization are not present in probe telemetry.'],
  overall_assessment: {
    confidence: 'high',
    rationale: 'Telemetry conclusively proves upstream 500 response pattern.',
  },
};

test('OpenRouter Provider — Throws when OPENROUTER_API_KEY is not configured', async () => {
  const provider = new OpenRouterAiProvider({
    ai: { openrouter: { apiKey: '', model: 'openai/gpt-oss-20b:free' } },
  });

  await assert.rejects(
    async () => {
      await provider.generateAnalysis(MOCK_SNAPSHOT);
    },
    (err) => {
      assert.equal(err.code, 'OPENROUTER_AUTH_MISSING');
      assert.equal(err.status, 401);
      return true;
    }
  );
});

test('OpenRouter Provider — Correctly formats model, headers, and request body for GPT-OSS 20B (strict json_schema)', async () => {
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
        id: 'gen-test-123',
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
          prompt_tokens: 450,
          completion_tokens: 180,
          total_tokens: 630,
        },
      }),
    };
  };

  try {
    const provider = new OpenRouterAiProvider({
      ai: {
        openrouter: {
          apiKey: 'sk-or-v1-mock-secret-key-12345',
          baseUrl: 'https://openrouter.ai/api/v1',
          model: 'openai/gpt-oss-20b:free',
          timeoutMs: 30000,
        },
      },
    });

    const result = await provider.generateAnalysis(MOCK_SNAPSHOT);

    assert.equal(interceptedUrl, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(interceptedOptions.method, 'POST');
    assert.equal(interceptedOptions.headers['Authorization'], 'Bearer sk-or-v1-mock-secret-key-12345');
    assert.equal(interceptedOptions.headers['Content-Type'], 'application/json');
    assert.equal(interceptedOptions.headers['HTTP-Referer'], 'https://apidash.local');
    assert.equal(interceptedOptions.headers['X-Title'], 'APIDash Incident Investigation');

    const body = JSON.parse(interceptedOptions.body);
    assert.equal(body.model, 'openai/gpt-oss-20b:free');
    assert.equal(body.temperature, 0.1);
    assert.equal(body.max_tokens, 2500);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.name, 'incident_investigation');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(body.response_format.json_schema.schema, responseJsonSchema);

    assert.equal(result.provider, 'openrouter');
    assert.equal(result.model, 'openai/gpt-oss-20b:free');
    assert.equal(result.tokens.prompt, 450);
    assert.equal(result.tokens.completion, 180);
    assert.equal(result.tokens.total, 630);
    assert.deepEqual(JSON.parse(result.rawText), VALID_RESPONSE_PAYLOAD);
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenRouter Provider — Gemma model defaults to json_object format', async () => {
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
    const provider = new OpenRouterAiProvider({
      ai: {
        openrouter: {
          apiKey: 'sk-or-v1-test',
          model: 'google/gemma-4-26b-a4b-it:free',
        },
      },
    });

    await provider.generateAnalysis(MOCK_SNAPSHOT);

    assert.equal(interceptedBody.model, 'google/gemma-4-26b-a4b-it:free');
    // Gemma must use json_object and preserves standard 2500 max_tokens
    assert.deepEqual(interceptedBody.response_format, { type: 'json_object' });
    assert.equal(interceptedBody.max_tokens, 2500);
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenRouter Provider — Nemotron model defaults to strict json_schema format and 4000 max_tokens', async () => {
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
    const provider = new OpenRouterAiProvider({
      ai: {
        openrouter: {
          apiKey: 'sk-or-v1-test',
          model: 'nvidia/nemotron-3.5-super-vl:free',
        },
      },
    });

    await provider.generateAnalysis(MOCK_SNAPSHOT);

    assert.equal(interceptedBody.model, 'nvidia/nemotron-3.5-super-vl:free');
    assert.equal(interceptedBody.response_format.type, 'json_schema');
    assert.equal(interceptedBody.max_tokens, 4000);
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenRouter Provider — Gracefully falls back from json_schema to json_object when 400 is returned', async () => {
  const originalFetch = global.fetch;
  const attempts = [];

  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    attempts.push(body.response_format);

    if (attempts.length === 1) {
      // First attempt with json_schema is rejected by model route
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
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
      }),
    };
  };

  try {
    const provider = new OpenRouterAiProvider({
      ai: {
        openrouter: {
          apiKey: 'sk-or-v1-test',
          model: 'openai/gpt-oss-20b:free',
        },
      },
    });

    const result = await provider.generateAnalysis(MOCK_SNAPSHOT);

    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].type, 'json_schema');
    assert.deepEqual(attempts[1], { type: 'json_object' });
    assert.ok(result.rawText);
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenRouter Provider — Correctly strips markdown code fences from response', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: '```json\n' + JSON.stringify(VALID_RESPONSE_PAYLOAD) + '\n```',
          },
        },
      ],
      usage: { total_tokens: 100 },
    }),
  });

  try {
    const provider = new OpenRouterAiProvider({
      ai: { openrouter: { apiKey: 'sk-or-test', model: 'openai/gpt-oss-20b:free' } },
    });

    const result = await provider.generateAnalysis(MOCK_SNAPSHOT);
    assert.ok(!result.rawText.startsWith('```'));
    assert.deepEqual(JSON.parse(result.rawText), VALID_RESPONSE_PAYLOAD);
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenRouter Provider — Redacts API keys and Bearer tokens in error messages', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({
      error: {
        message: 'Invalid key sk-or-v1-abcdef0123456789. Bearer sk-or-secret-token is expired.',
      },
    }),
  });

  try {
    const provider = new OpenRouterAiProvider({
      ai: { openrouter: { apiKey: 'sk-or-v1-test', model: 'openai/gpt-oss-20b:free' } },
    });

    await assert.rejects(
      async () => {
        await provider.generateAnalysis(MOCK_SNAPSHOT);
      },
      (err) => {
        assert.equal(err.name, 'AiProviderError');
        assert.ok(!err.message.includes('abcdef0123456789'));
        assert.ok(!err.message.includes('sk-or-secret-token'));
        assert.ok(err.message.includes('[REDACTED_API_KEY]'));
        assert.ok(err.message.includes('Bearer [REDACTED]'));
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenRouter Provider — Maps 429 to AI_RATE_LIMIT (retryable) and 402/403 to AI_QUOTA_EXHAUSTED (non-retryable)', async () => {
  const originalFetch = global.fetch;

  // 1. Rate limit (429)
  global.fetch = async () => ({
    ok: false,
    status: 429,
    text: async () => JSON.stringify({ error: { message: 'Rate limit exceeded: 20 requests per minute.' } }),
  });

  const provider = new OpenRouterAiProvider({
    ai: { openrouter: { apiKey: 'sk-or-test', model: 'openai/gpt-oss-20b:free' } },
  });

  await assert.rejects(
    async () => {
      await provider.generateAnalysis(MOCK_SNAPSHOT);
    },
    (err) => {
      assert.equal(err.code, 'AI_RATE_LIMIT');
      assert.equal(err.isRetryable, true);
      assert.equal(err.status, 429);
      return true;
    }
  );

  // 2. Quota / Credit limit (402)
  global.fetch = async () => ({
    ok: false,
    status: 402,
    text: async () => JSON.stringify({ error: { message: 'Insufficient credits or quota limit reached.' } }),
  });

  await assert.rejects(
    async () => {
      await provider.generateAnalysis(MOCK_SNAPSHOT);
    },
    (err) => {
      assert.equal(err.code, 'AI_QUOTA_EXHAUSTED');
      assert.equal(err.isRetryable, false);
      assert.equal(err.status, 402);
      return true;
    }
  );

  global.fetch = originalFetch;
});

test('OpenRouter Provider — Handles request timeout cleanly as AI_TIMEOUT', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    throw error;
  };

  try {
    const provider = new OpenRouterAiProvider({
      ai: { openrouter: { apiKey: 'sk-or-test', model: 'openai/gpt-oss-20b:free' } },
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

test('createAiProvider factory creates OpenRouterAiProvider when AI_PROVIDER=openrouter', () => {
  const provider = createAiProvider({
    ai: {
      provider: 'openrouter',
      openrouter: {
        apiKey: 'sk-or-test-key',
        model: 'openai/gpt-oss-20b:free',
      },
    },
  });

  assert.equal(provider instanceof OpenRouterAiProvider, true);
  assert.equal(provider.model, 'openai/gpt-oss-20b:free');
});

test('OpenRouter Provider — Respects explicit max_tokens option override', async () => {
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
    const provider = new OpenRouterAiProvider({
      ai: {
        openrouter: {
          apiKey: 'sk-or-v1-test',
          model: 'nvidia/nemotron-3.5-super-vl:free',
        },
      },
    });

    await provider.generateAnalysis(MOCK_SNAPSHOT, { maxTokens: 3500 });
    assert.equal(interceptedBody.max_tokens, 3500);

    await provider.generateAnalysis(MOCK_SNAPSHOT, { max_tokens: 5000 });
    assert.equal(interceptedBody.max_tokens, 5000);
  } finally {
    global.fetch = originalFetch;
  }
});

test('System Prompt & Evidence Formatter — Instructs model on bounded output and concise limits', () => {
  const systemPrompt = getSystemPrompt();
  assert.equal(systemPrompt.includes('CONCISE & BOUNDED OUTPUT'), true);
  assert.equal(systemPrompt.includes('observed_facts: At most 5 items'), true);
  assert.equal(systemPrompt.includes('hypotheses: At most 3 items'), true);
  assert.equal(systemPrompt.includes('recommended_checks: At most 3 items'), true);
  assert.equal(systemPrompt.includes('unknowns: At most 5 items'), true);

  const formatted = formatEvidencePrompt(MOCK_SNAPSHOT);
  assert.equal(formatted.includes('OUTPUT CONSTRAINTS:'), true);
  assert.equal(formatted.includes('observed_facts <= 5'), true);
  assert.equal(formatted.includes('hypotheses <= 3'), true);
  assert.equal(formatted.includes('recommended_checks <= 3'), true);
  assert.equal(formatted.includes('unknowns <= 5'), true);
});

