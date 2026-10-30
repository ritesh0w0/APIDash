// backend/test/aiResponseValidator.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAiResponse, extractAndParseJson } = require('../services/aiResponseValidator');

const validEvidenceSnapshot = {
  incident_id: 101,
  workspace_id: 1,
  monitor_id: 5,
  observations: [
    { id: 'E-001', type: 'INCIDENT_LIFECYCLE', status: 'open' },
    { id: 'E-002', type: 'MONITOR_CONFIGURATION', method: 'GET' },
    { id: 'E-003', type: 'EXECUTION_OBSERVATION', outcome: 'FAIL', status_code: 500 },
  ],
};

const validModelResponse = {
  summary: 'Persistent HTTP 500 internal server error observed on payment endpoint.',
  observed_facts: [
    {
      fact: 'The endpoint returned status code 500 during the last run.',
      evidence_ids: ['E-001', 'E-003'],
    },
  ],
  hypotheses: [
    {
      hypothesis: 'Upstream database connection failure.',
      rationale: '500 error occurred immediately after database connection pool saturation.',
      supporting_evidence_ids: ['E-003'],
      contradicting_evidence_ids: [],
      strength: 'strong',
    },
  ],
  recommended_checks: [
    {
      check: 'Inspect database connection pool metrics.',
      rationale: 'Verify if active connection count reached pool maximum.',
      evidence_ids: ['E-003'],
    },
  ],
  unknowns: [
    'Internal server logs and SQL queries are not visible in APIDash telemetry.',
  ],
  overall_assessment: {
    confidence: 'high',
    rationale: 'Telemetry clearly indicates persistent 500 status code.',
  },
};

test('AI Response Validator — Valid response matching schema passes cleanly', () => {
  const result = validateAiResponse(validModelResponse, validEvidenceSnapshot);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.invalidEvidenceIds.length, 0);
  assert.equal(result.result.summary, validModelResponse.summary);
});

test('AI Response Validator — Parses JSON string wrapped in markdown fences', () => {
  const markdownWrapped = `\`\`\`json\n${JSON.stringify(validModelResponse, null, 2)}\n\`\`\``;
  const result = validateAiResponse(markdownWrapped, validEvidenceSnapshot);
  assert.equal(result.valid, true);
  assert.equal(result.result.summary, validModelResponse.summary);
});

test('AI Response Validator — Rejects malformed JSON with clear parse error', () => {
  const malformed = '{ summary: "broken json without quotes", ';
  const result = validateAiResponse(malformed, validEvidenceSnapshot);
  assert.equal(result.valid, false);
  assert.ok(result.errors[0].includes('JSON parse failure'));
});

test('AI Response Validator — Rejects missing required schema properties', () => {
  const incomplete = {
    summary: 'Just a summary',
    observed_facts: [{ fact: 'Fact 1', evidence_ids: ['E-001'] }],
    // missing hypotheses, recommended_checks, unknowns, overall_assessment
  };
  const result = validateAiResponse(incomplete, validEvidenceSnapshot);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must have required property')));
});

test('AI Response Validator — Rejects hallucinated or unknown evidence IDs', () => {
  const hallucinated = JSON.parse(JSON.stringify(validModelResponse));
  hallucinated.observed_facts[0].evidence_ids = ['E-001', 'E-999']; // E-999 does not exist!

  const result = validateAiResponse(hallucinated, validEvidenceSnapshot);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('Invalid evidence citation "E-999"')));
  assert.ok(result.invalidEvidenceIds.includes('E-999'));
});

test('AI Response Validator — Rejects invalid hypothesis strength enum', () => {
  const badEnum = JSON.parse(JSON.stringify(validModelResponse));
  badEnum.hypotheses[0].strength = 'guaranteed_100_percent_true'; // Invalid enum

  const result = validateAiResponse(badEnum, validEvidenceSnapshot);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must be equal to one of the allowed values')));
});

test('AI Response Validator — Rejects excessively long strings exceeding limits', () => {
  const tooLong = JSON.parse(JSON.stringify(validModelResponse));
  tooLong.summary = 'A'.repeat(1500); // Max is 1000

  const result = validateAiResponse(tooLong, validEvidenceSnapshot);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must NOT have more than 1000 characters')));
});

