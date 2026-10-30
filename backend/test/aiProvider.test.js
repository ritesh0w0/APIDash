// backend/test/aiProvider.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAiProvider,
  computeCacheKey,
  DisabledAiProvider,
  MockAiProvider,
  AiProviderError,
} = require('../services/aiProviderService');

test('AI Provider — DisabledAiProvider throws safe error when called', async () => {
  const provider = new DisabledAiProvider();
  await assert.rejects(
    async () => provider.generateAnalysis({ incident_id: 1 }),
    (err) => err instanceof AiProviderError && err.code === 'AI_DISABLED' && err.statusCode === 503
  );
});

test('AI Provider — createAiProvider respects AI_PROVIDER configuration', () => {
  const disabledProvider = createAiProvider({ ai: { provider: 'disabled' } });
  assert.ok(disabledProvider instanceof DisabledAiProvider);

  const mockProvider = createAiProvider({ ai: { provider: 'mock' } });
  assert.ok(mockProvider instanceof MockAiProvider);
});

test('AI Provider — MockAiProvider generates valid structured response citing evidence', async () => {
  const mockProvider = new MockAiProvider();
  const output = await mockProvider.generateAnalysis({
    incident_id: 42,
    observations: [{ id: 'E-001', type: 'INCIDENT_LIFECYCLE' }],
  });

  assert.equal(output.provider, 'mock');
  assert.ok(output.rawText);
  assert.ok(output.tokens);

  const parsed = JSON.parse(output.rawText);
  assert.ok(parsed.summary);
  assert.ok(Array.isArray(parsed.observed_facts));
  assert.deepEqual(parsed.observed_facts[0].evidence_ids, ['E-001']);
});

test('AI Provider — computeCacheKey provides multi-tenant workspace isolation', () => {
  const keyWs1 = computeCacheKey('gemini', 'gemini-3.8-flash', 'hash123', 1);
  const keyWs2 = computeCacheKey('gemini', 'gemini-3.8-flash', 'hash123', 2); // Different workspace!

  // Same evidence fingerprint for two different workspaces must produce DIFFERENT cache keys
  assert.notEqual(keyWs1, keyWs2);

  // Same inputs produce identical deterministic key
  const keyWs1Repeat = computeCacheKey('gemini', 'gemini-3.8-flash', 'hash123', 1);
  assert.equal(keyWs1, keyWs1Repeat);
});

