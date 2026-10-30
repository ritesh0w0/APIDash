// backend/test/syntheticDataset.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FIXTURES, getFixtures, validateDataset, DATASET_VERSION } = require('../ai/evaluation/fixtures/dataset');
const { runFixtureAudit } = require('../ai/evaluation/auditDryRun');

test('Synthetic Dataset — Validates full 40-scenario dataset integrity', () => {
  const result = validateDataset();
  assert.equal(result.valid, true, `Validation failed with errors: ${result.errors.join('; ')}`);
  assert.equal(result.total, 40);
  assert.equal(result.errors.length, 0);
  assert.equal(result.version, 'v1.1.0');
  assert.equal(DATASET_VERSION, 'v1.1.0');

  // Exact split counts
  assert.equal(result.countsBySplit.dev, 24);
  assert.equal(result.countsBySplit.validation, 8);
  assert.equal(result.countsBySplit.holdout, 8);

  // Check that all 12 categories have at least 2 distinct fixtures
  const categories = Object.keys(result.countsByCategory);
  assert.equal(categories.length, 12);
  for (const cat of categories) {
    assert.ok(result.countsByCategory[cat] >= 2, `Category ${cat} has fewer than 2 fixtures`);
  }
});

test('Synthetic Dataset — getFixtures filter behaves correctly', () => {
  const devCases = getFixtures({ split: 'dev' });
  assert.equal(devCases.length, 24);
  assert.ok(devCases.every((f) => f.split === 'dev'));

  const validationCases = getFixtures({ split: 'validation' });
  assert.equal(validationCases.length, 8);
  assert.ok(validationCases.every((f) => f.split === 'validation'));

  const holdoutCases = getFixtures({ split: 'holdout' });
  assert.equal(holdoutCases.length, 8);
  assert.ok(holdoutCases.every((f) => f.split === 'holdout'));

  const http5xxCases = getFixtures({ category: 'HTTP_5XX_PERSISTENT' });
  assert.equal(http5xxCases.length, 4);

  const allCases = getFixtures({ split: 'all' });
  assert.equal(allCases.length, 40);
});

test('Synthetic Dataset — High-risk failure modes covered in validation and holdout splits', () => {
  const valCategories = new Set(getFixtures({ split: 'validation' }).map((f) => f.category));
  const holdoutCategories = new Set(getFixtures({ split: 'holdout' }).map((f) => f.category));

  // Both validation and holdout must include prompt injection resistance
  assert.ok(valCategories.has('PROMPT_INJECTION'), 'Validation split missing PROMPT_INJECTION');
  assert.ok(holdoutCategories.has('PROMPT_INJECTION'), 'Holdout split missing PROMPT_INJECTION');

  // Both validation and holdout must include insufficient evidence / abstention
  assert.ok(valCategories.has('INSUFFICIENT_HISTORY'), 'Validation split missing INSUFFICIENT_HISTORY');
  assert.ok(holdoutCategories.has('INSUFFICIENT_HISTORY'), 'Holdout split missing INSUFFICIENT_HISTORY');

  // Both validation and holdout must include conflicting signals
  assert.ok(valCategories.has('CONFLICTING_EVIDENCE'), 'Validation split missing CONFLICTING_EVIDENCE');
  assert.ok(holdoutCategories.has('CONFLICTING_EVIDENCE'), 'Holdout split missing CONFLICTING_EVIDENCE');

  // Both validation and holdout must include misleading correlation
  assert.ok(valCategories.has('MISLEADING_COINCIDENCE'), 'Validation split missing MISLEADING_COINCIDENCE');
  assert.ok(holdoutCategories.has('MISLEADING_COINCIDENCE'), 'Holdout split missing MISLEADING_COINCIDENCE');

  // Both validation and holdout must include OpenAPI contract violations
  assert.ok(valCategories.has('CONTRACT_VIOLATION'), 'Validation split missing CONTRACT_VIOLATION');
  assert.ok(holdoutCategories.has('CONTRACT_VIOLATION'), 'Holdout split missing CONTRACT_VIOLATION');

  // Both validation and holdout must include persistent failure
  assert.ok(valCategories.has('HTTP_5XX_PERSISTENT'), 'Validation split missing HTTP_5XX_PERSISTENT');
  assert.ok(holdoutCategories.has('HTTP_5XX_PERSISTENT'), 'Holdout split missing HTTP_5XX_PERSISTENT');
});

test('Synthetic Dataset — Ground truth is completely separated from evidence packages', () => {
  for (const f of FIXTURES) {
    const pkg = f.evidence_package;
    // Ensure ground-truth labels are not leaked into the payload sent to the LLM
    assert.equal(pkg.ground_truth, undefined);
    assert.equal(pkg.required_facts, undefined);
    assert.equal(pkg.forbidden_claims, undefined);
    assert.equal(pkg.allowed_hypotheses, undefined);

    // Ensure all evidence observations have stable IDs
    assert.ok(Array.isArray(pkg.observations));
    for (const obs of pkg.observations) {
      assert.ok(obs.id && obs.id.startsWith('E-'));
    }
  }
});

test('Synthetic Dataset — Comprehensive 40-scenario dry-run parity audit passes with zero defects', () => {
  const audit = runFixtureAudit();
  assert.equal(audit.total, 40);
  assert.equal(audit.valid, true, `Audit encountered defects: ${JSON.stringify(audit.results.filter((r) => !r.valid))}`);
  for (const r of audit.results) {
    assert.equal(r.valid, true, `Fixture ${r.id} failed audit`);
    assert.equal(r.chrono_valid, true, `Fixture ${r.id} failed chrono check`);
    assert.equal(r.no_gt_leak, true, `Fixture ${r.id} leaked ground truth`);
    assert.equal(r.parity_valid, true, `Fixture ${r.id} failed parity check`);
    assert.equal(r.prompt_valid, true, `Fixture ${r.id} failed prompt check`);
    assert.equal(r.sanitized, true, `Fixture ${r.id} failed sanitization check`);
  }
});

test('Synthetic Dataset — Explicit split membership matches frozen design by ID', () => {
  const expectedDev = [
    'SYN-001', 'SYN-002', 'SYN-003', 'SYN-004', 'SYN-005', 'SYN-006',
    'SYN-007', 'SYN-008', 'SYN-009', 'SYN-010', 'SYN-011', 'SYN-012',
    'SYN-013', 'SYN-014', 'SYN-015', 'SYN-016', 'SYN-027', 'SYN-028',
    'SYN-030', 'SYN-032', 'SYN-034', 'SYN-036', 'SYN-038', 'SYN-039',
  ];
  const expectedVal = [
    'SYN-017', 'SYN-019', 'SYN-021', 'SYN-023', 'SYN-025', 'SYN-026',
    'SYN-029', 'SYN-031',
  ];
  const expectedHoldout = [
    'SYN-018', 'SYN-020', 'SYN-022', 'SYN-024', 'SYN-033', 'SYN-035',
    'SYN-037', 'SYN-040',
  ];

  const actualDev = getFixtures({ split: 'dev' }).map((f) => f.id).sort();
  const actualVal = getFixtures({ split: 'validation' }).map((f) => f.id).sort();
  const actualHoldout = getFixtures({ split: 'holdout' }).map((f) => f.id).sort();

  assert.deepEqual(actualDev, expectedDev.sort(), 'Development split membership mismatch');
  assert.deepEqual(actualVal, expectedVal.sort(), 'Validation split membership mismatch');
  assert.deepEqual(actualHoldout, expectedHoldout.sort(), 'Holdout split membership mismatch');

  // Verify holdout cases were never evaluated during candidate selection
  const candidateSelectionCases = ['SYN-001', 'SYN-003', 'SYN-005', 'SYN-009', 'SYN-011'];
  for (const caseId of candidateSelectionCases) {
    assert.ok(actualDev.includes(caseId), `Candidate case ${caseId} must be in dev split`);
    assert.ok(!actualHoldout.includes(caseId), `Holdout contamination: case ${caseId} was in holdout split!`);
    assert.ok(!actualVal.includes(caseId), `Validation contamination: case ${caseId} was in validation split!`);
  }
});


