// backend/test/evaluatorRubric.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreOutputAgainstGroundTruth, isForbiddenClaimAsserted } = require('../ai/evaluation/evaluate');
const { FIXTURES } = require('../ai/evaluation/fixtures/dataset');

test('Evaluator Rubric — isForbiddenClaimAsserted detects affirmative assertions', () => {
  const forbidden1 = 'Claiming the service is down or failing HTTP status checks';
  assert.equal(isForbiddenClaimAsserted('The service is down due to an unknown outage.', forbidden1), true);
  assert.equal(isForbiddenClaimAsserted('We observed failing HTTP status checks across the cluster.', forbidden1), true);
  assert.equal(isForbiddenClaimAsserted('The service is dead.', forbidden1), true);

  const forbidden2 = 'Claiming network packet loss';
  assert.equal(isForbiddenClaimAsserted('Severe packet loss was observed between nodes.', forbidden2), true);
  assert.equal(isForbiddenClaimAsserted('Network is dropping packets continuously.', forbidden2), true);

  const forbidden3 = 'Claiming DNS failure';
  assert.equal(isForbiddenClaimAsserted('DNS resolution failed for the target host.', forbidden3), true);
});

test('Evaluator Rubric — isForbiddenClaimAsserted does NOT penalize negative assertions', () => {
  const forbidden1 = 'Claiming the service is down or failing HTTP status checks';
  assert.equal(isForbiddenClaimAsserted('The service is not down and latency is normal.', forbidden1), false);
  assert.equal(isForbiddenClaimAsserted('The monitor is not failing HTTP status checks; it returned 200 OK.', forbidden1), false);
  assert.equal(isForbiddenClaimAsserted('Status checks passed successfully with 200 OK.', forbidden1), false);
  assert.equal(isForbiddenClaimAsserted('Service is up and operational.', forbidden1), false);

  const forbidden2 = 'Claiming network packet loss';
  assert.equal(isForbiddenClaimAsserted('Observed clean response times with no packet loss.', forbidden2), false);
  assert.equal(isForbiddenClaimAsserted('Without packet loss or transport anomalies.', forbidden2), false);

  const forbidden3 = 'Claiming DNS failure';
  assert.equal(isForbiddenClaimAsserted('Confirmed this was not a DNS failure.', forbidden3), false);
  assert.equal(isForbiddenClaimAsserted('No DNS issues observed.', forbidden3), false);
});

test('Evaluator Rubric — isForbiddenClaimAsserted does NOT penalize mere word co-occurrences', () => {
  const forbidden1 = 'Claiming the service is down or failing HTTP status checks';
  // Words "service", "status", "checks" appear, but in an unrelated or benign sentence
  assert.equal(isForbiddenClaimAsserted('We ran diagnostic checks on the user service to inspect contract status.', forbidden1), false);
  assert.equal(isForbiddenClaimAsserted('Service configuration specifies status 200 as expected.', forbidden1), false);
});

test('Evaluator Rubric — SYN-009 regression: False positive resolved for compliant contract violation analysis', () => {
  const syn9 = FIXTURES.find((f) => f.id === 'SYN-009');
  assert.ok(syn9, 'SYN-009 fixture not found');

  const evidenceSnapshot = syn9.evidence_package;
  const groundTruth = syn9.ground_truth;

  // Realistic model response for SYN-009 that accurately notes status 200 passing while contract failed
  const compliantOutput = {
    valid: true,
    invalidEvidenceIds: [],
    result: {
      summary: 'Monitor for /users/42 returned HTTP 200 OK with normal latency (80ms), so the service is not down and not failing HTTP status checks. However, runtime contract validation failed due to schema violations.',
      observed_facts: [
        { fact: 'HTTP status checks passed with 200 OK across recent probes.', evidence_ids: ['E-002', 'E-003', 'E-004'] },
        { fact: 'Phase 6 runtime validation flagged contract verdict as failed.', evidence_ids: ['E-003', 'E-004'] },
        { fact: 'Findings show missing required property "email" and type mismatch on "age".', evidence_ids: ['E-003'] },
      ],
      hypotheses: [
        {
          hypothesis: 'Upstream deployed a breaking API change omitting "email" without updating the contract.',
          rationale: 'Service responds normally but serialization omits the field.',
          supporting_evidence_ids: ['E-003', 'E-004'],
          contradicting_evidence_ids: [],
          strength: 'strong',
        },
      ],
      recommended_checks: [
        { check: 'Review recent code commits modifying user serialization.', rationale: 'Identify schema drift.', evidence_ids: ['E-003'] },
        { check: 'Compare OpenAPI contract revision against documentation.', rationale: 'Verify spec version.', evidence_ids: ['E-002'] },
      ],
      unknowns: [
        'Internal server application logs',
        'Recent deployment changelog',
      ],
      overall_assessment: {
        confidence: 'high',
        rationale: 'Direct contract validation findings in evidence.',
      },
    },
  };

  const scores = scoreOutputAgainstGroundTruth(compliantOutput, groundTruth, evidenceSnapshot, false);

  assert.equal(scores.unsupported_claims_detected, 0, 'Compliant model output was falsely penalized for unsupported claims!');
  assert.equal(scores.schema_valid, true);
  assert.equal(scores.evidence_refs_valid, true);
  assert.equal(scores.grounding_score, 1);
  assert.equal(scores.hypothesis_discipline_score, 1);
  assert.ok(scores.factual_score >= 0.66);
});

test('Evaluator Rubric — SYN-009 catches true positive when model actually makes forbidden claim', () => {
  const syn9 = FIXTURES.find((f) => f.id === 'SYN-009');
  const evidenceSnapshot = syn9.evidence_package;
  const groundTruth = syn9.ground_truth;

  const hallucinatedOutput = {
    valid: true,
    invalidEvidenceIds: [],
    result: {
      summary: 'The service is down and failing HTTP status checks due to widespread packet loss.',
      observed_facts: [
        { fact: 'The service is down.', evidence_ids: ['E-001'] },
      ],
      hypotheses: [
        {
          hypothesis: 'Network packet loss caused the service to go down.',
          rationale: 'Continuous packet loss.',
          supporting_evidence_ids: ['E-001'],
          strength: 'strong',
        },
      ],
      recommended_checks: [],
      unknowns: [],
    },
  };

  const scores = scoreOutputAgainstGroundTruth(hallucinatedOutput, groundTruth, evidenceSnapshot, false);
  assert.ok(scores.unsupported_claims_detected >= 1, 'Failed to catch actual forbidden claims in hallucinated output');
});

test('Evaluator Rubric — Hallucinated citations are penalized in grounding_score and evidence_refs_valid', () => {
  const syn1 = FIXTURES.find((f) => f.id === 'SYN-001');
  const evidenceSnapshot = syn1.evidence_package;
  // Valid IDs in SYN-001 are E-001 through E-007

  const outputWithHallucinatedIds = {
    valid: true,
    invalidEvidenceIds: ['E-999'],
    result: {
      summary: 'Persistent HTTP 500 server error.',
      observed_facts: [
        { fact: 'Server returned HTTP 500.', evidence_ids: ['E-005'] }, // Valid
        { fact: 'Database query crashed on index lookup.', evidence_ids: ['E-999'] }, // Hallucinated ID
      ],
      hypotheses: [
        {
          hypothesis: 'Database connection pool exhausted.',
          rationale: 'Pool timeout in logs.',
          supporting_evidence_ids: ['E-005', 'E-006'], // Valid
          strength: 'strong',
        },
      ],
      recommended_checks: [],
      unknowns: [],
    },
  };

  const scores = scoreOutputAgainstGroundTruth(outputWithHallucinatedIds, syn1.ground_truth, evidenceSnapshot, false);

  assert.equal(scores.evidence_refs_valid, false, 'evidence_refs_valid must be false when hallucinated ID is cited');
  assert.equal(scores.grounding_score, 0.5, 'Grounding score must reflect only the 1 valid fact out of 2 total facts');
});

test('Evaluator Rubric — Inquiries in unknowns and recommended_checks do not trigger unsupported claim penalties', () => {
  const syn9 = FIXTURES.find((f) => f.id === 'SYN-009');
  const evidenceSnapshot = syn9.evidence_package;
  const groundTruth = syn9.ground_truth;

  const outputWithInquiries = {
    valid: true,
    invalidEvidenceIds: [],
    result: {
      summary: 'Contract schema validation error observed on 200 response.',
      observed_facts: [
        { fact: 'Status 200 returned with schema failure.', evidence_ids: ['E-003'] },
      ],
      hypotheses: [
        {
          hypothesis: 'Schema version mismatch.',
          rationale: 'Missing email field.',
          supporting_evidence_ids: ['E-003'],
          strength: 'strong',
        },
      ],
      recommended_checks: [
        { check: 'Check whether service is down or failing HTTP status checks elsewhere in cluster', rationale: 'Diagnostic probe', evidence_ids: ['E-003'] },
      ],
      unknowns: [
        'Unknown if network packet loss occurred between proxy and backend',
      ],
    },
  };

  const scores = scoreOutputAgainstGroundTruth(outputWithInquiries, groundTruth, evidenceSnapshot, false);
  assert.equal(scores.unsupported_claims_detected, 0, 'Inquiries in checks/unknowns must not count as affirmative claims');
});

