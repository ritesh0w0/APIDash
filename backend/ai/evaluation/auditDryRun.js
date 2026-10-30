// backend/ai/evaluation/auditDryRun.js
'use strict';

const { FIXTURES, DATASET_VERSION, validateDataset } = require('./fixtures/dataset');
const { formatEvidencePrompt } = require('../prompts/systemPrompt.v1');

/**
 * Runs a complete dry-run parity audit across all 40 synthetic fixtures.
 * Verifies:
 *  - Chronology of timestamps
 *  - Ground-truth leakage prevention
 *  - Production parity (lifecycle, monitor configuration, observations)
 *  - Sanitization of URLs and secrets
 *  - Prompt formatting integrity
 *
 * @returns {{ valid: boolean, total: number, results: Array<Object> }}
 */
function runFixtureAudit() {
  const datasetValidation = validateDataset();
  const results = [];
  let allValid = datasetValidation.valid;

  for (const fixture of FIXTURES) {
    const ep = fixture.evidence_package;
    const gt = fixture.ground_truth;
    const issues = [];

    // 1. Chronology check
    let chronoValid = true;
    let lastTimestamp = 0;
    if (ep && Array.isArray(ep.observations)) {
      for (const obs of ep.observations) {
        if (obs.type === 'EXECUTION_OBSERVATION' && obs.timestamp) {
          const t = new Date(obs.timestamp).getTime();
          if (isNaN(t)) {
            chronoValid = false;
            issues.push(`Invalid timestamp format in ${obs.id}: ${obs.timestamp}`);
          } else if (t < lastTimestamp) {
            chronoValid = false;
            issues.push(`Chronology out of order in ${obs.id}: ${obs.timestamp}`);
          }
          lastTimestamp = t;
        }
      }
    } else {
      chronoValid = false;
      issues.push('Missing observations array');
    }

    // 2. Ground truth leakage check into raw evidence package
    let noGtLeak = true;
    const epStr = JSON.stringify(ep);
    const forbiddenGtKeys = ['required_facts', 'allowed_hypotheses', 'forbidden_claims', 'useful_checks', 'should_abstain'];
    for (const key of forbiddenGtKeys) {
      if (epStr.includes(`"${key}"`)) {
        noGtLeak = false;
        issues.push(`Evidence package contains forbidden ground truth key: ${key}`);
      }
    }

    // 3. Prompt formatting and leakage in formatted prompt
    let promptValid = true;
    let formattedPrompt = '';
    try {
      formattedPrompt = formatEvidencePrompt(ep);
      if (!formattedPrompt.includes('=== BEGIN EVIDENCE PACKAGE ===') || !formattedPrompt.includes('=== END EVIDENCE PACKAGE ===')) {
        promptValid = false;
        issues.push('Formatted prompt missing standard package boundary markers');
      }
      for (const key of forbiddenGtKeys) {
        if (formattedPrompt.includes(`"${key}"`)) {
          promptValid = false;
          issues.push(`Formatted prompt leaked ground truth key: ${key}`);
        }
      }
    } catch (err) {
      promptValid = false;
      issues.push(`Failed to format evidence prompt: ${err.message}`);
    }

    // 4. Production parity check
    // Evidence package must have incident_id, workspace_id, monitor_id, and expected observation types
    let parityValid = true;
    if (!ep.incident_id || !ep.workspace_id || !ep.monitor_id) {
      parityValid = false;
      issues.push('Missing incident_id, workspace_id, or monitor_id');
    }
    const hasLifecycle = ep.observations.some((o) => o.type === 'INCIDENT_LIFECYCLE');
    const hasConfig = ep.observations.some((o) => o.type === 'MONITOR_CONFIGURATION');
    const hasExec = ep.observations.some((o) => o.type === 'EXECUTION_OBSERVATION');
    if (!hasLifecycle || !hasConfig || !hasExec) {
      parityValid = false;
      issues.push(`Missing essential observation types (lifecycle=${hasLifecycle}, config=${hasConfig}, exec=${hasExec})`);
    }

    // 5. Sanitization check
    let sanitized = true;
    const rawLower = epStr.toLowerCase();
    if (rawLower.includes('bearer eyj') || rawLower.includes('password=') || (rawLower.includes('secret') && !rawLower.includes('[redacted]') && fixture.category !== 'PROMPT_INJECTION')) {
      sanitized = false;
      issues.push('Unredacted credential or secret pattern detected in evidence package');
    }

    const itemValid = chronoValid && noGtLeak && promptValid && parityValid && sanitized && issues.length === 0;
    if (!itemValid) {
      allValid = false;
    }

    results.push({
      id: fixture.id,
      split: fixture.split,
      category: fixture.category,
      observation_count: (ep && ep.observations) ? ep.observations.length : 0,
      chrono_valid: chronoValid,
      sanitized: sanitized,
      no_gt_leak: noGtLeak,
      prompt_valid: promptValid,
      parity_valid: parityValid,
      should_abstain: gt ? Boolean(gt.should_abstain) : false,
      valid: itemValid,
      issues,
    });
  }

  return {
    valid: allValid,
    version: DATASET_VERSION,
    total: results.length,
    results,
  };
}

function printAuditTable() {
  const audit = runFixtureAudit();
  console.log(`\n========================================================================================`);
  console.log(`APIDash Phase 7 — Synthetic Dataset Dry-Run Parity Audit Report (Version: ${audit.version})`);
  console.log(`========================================================================================\n`);

  console.log('| ID      | Split      | Category               | Obs | Chrono | Sanitized | No GT Leak | Parity | Abstain | Status |');
  console.log('|---------|------------|------------------------|-----|--------|-----------|------------|--------|---------|--------|');

  for (const r of audit.results) {
    const id = r.id.padEnd(7);
    const split = r.split.padEnd(10);
    const cat = r.category.slice(0, 22).padEnd(22);
    const obs = String(r.observation_count).padStart(3);
    const chrono = (r.chrono_valid ? 'PASS' : 'FAIL').padEnd(6);
    const sanitized = (r.sanitized ? 'PASS' : 'FAIL').padEnd(9);
    const noLeak = (r.no_gt_leak ? 'PASS' : 'FAIL').padEnd(10);
    const parity = (r.parity_valid ? 'PASS' : 'FAIL').padEnd(6);
    const abstain = (r.should_abstain ? 'YES' : 'NO').padEnd(7);
    const status = r.valid ? 'OK' : 'DEFECT';
    console.log(`| ${id} | ${split} | ${cat} | ${obs} | ${chrono} | ${sanitized} | ${noLeak} | ${parity} | ${abstain} | ${status.padEnd(6)} |`);
  }

  console.log(`\nAudit Summary:`);
  console.log(`- Total Fixtures: ${audit.total}`);
  console.log(`- Dataset Version: ${audit.version}`);
  console.log(`- Overall Result: ${audit.valid ? 'ALL 40 FIXTURES COMPLIANT WITH ZERO DEFECTS' : 'DEFECTS DETECTED'}\n`);

  return audit;
}

if (require.main === module) {
  const audit = printAuditTable();
  if (!audit.valid) {
    process.exit(1);
  }
}

module.exports = {
  runFixtureAudit,
  printAuditTable,
};

