// backend/services/aiResponseValidator.js
'use strict';

const Ajv = require('ajv');
const { SCHEMA_VERSION } = require('../ai/prompts/systemPrompt.v1');

const ajv = new Ajv({ allErrors: true, strict: false });

const responseJsonSchema = {
  type: 'object',
  required: ['summary', 'observed_facts', 'hypotheses', 'recommended_checks', 'unknowns', 'overall_assessment'],
  additionalProperties: false,
  properties: {
    summary: {
      type: 'string',
      minLength: 5,
      maxLength: 1000,
    },
    observed_facts: {
      type: 'array',
      minItems: 1,
      maxItems: 25,
      items: {
        type: 'object',
        required: ['fact', 'evidence_ids'],
        additionalProperties: false,
        properties: {
          fact: { type: 'string', minLength: 3, maxLength: 500 },
          evidence_ids: {
            type: 'array',
            items: { type: 'string', minLength: 2, maxLength: 20 },
            maxItems: 20,
          },
        },
      },
    },
    hypotheses: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        required: ['hypothesis', 'rationale', 'supporting_evidence_ids', 'strength'],
        additionalProperties: false,
        properties: {
          hypothesis: { type: 'string', minLength: 3, maxLength: 500 },
          rationale: { type: 'string', minLength: 3, maxLength: 1000 },
          supporting_evidence_ids: {
            type: 'array',
            items: { type: 'string', minLength: 2, maxLength: 20 },
            maxItems: 20,
          },
          contradicting_evidence_ids: {
            type: 'array',
            items: { type: 'string', minLength: 2, maxLength: 20 },
            maxItems: 20,
          },
          strength: {
            type: 'string',
            enum: ['strong', 'moderate', 'weak', 'inconclusive'],
          },
        },
      },
    },
    recommended_checks: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        required: ['check', 'rationale'],
        additionalProperties: false,
        properties: {
          check: { type: 'string', minLength: 3, maxLength: 500 },
          rationale: { type: 'string', minLength: 3, maxLength: 1000 },
          evidence_ids: {
            type: 'array',
            items: { type: 'string', minLength: 2, maxLength: 20 },
            maxItems: 20,
          },
        },
      },
    },
    unknowns: {
      type: 'array',
      minItems: 1,
      maxItems: 15,
      items: { type: 'string', minLength: 3, maxLength: 500 },
    },
    overall_assessment: {
      type: 'object',
      required: ['confidence', 'rationale'],
      additionalProperties: false,
      properties: {
        confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low', 'unknown'],
        },
        rationale: { type: 'string', minLength: 3, maxLength: 1000 },
      },
    },
  },
};

const validateCompiled = ajv.compile(responseJsonSchema);

/**
 * Extracts a JSON object from an LLM response string, stripping optional markdown fences.
 *
 * @param {string} rawText
 * @returns {Object} parsed object
 */
function extractAndParseJson(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw new Error('Model output is empty or not a string');
  }

  let text = rawText.trim();

  // Strip markdown fences if present (e.g. ```json ... ``` or ``` ...)
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }

  // Also locate first { and last } if surrounded by chatter
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    text = text.substring(firstBrace, lastBrace + 1);
  }

  return JSON.parse(text);
}

/**
 * Extracts all valid evidence IDs from an evidence package.
 *
 * @param {Object} evidenceSnapshot
 * @returns {Set<string>}
 */
function extractKnownEvidenceIds(evidenceSnapshot) {
  const ids = new Set();
  if (!evidenceSnapshot || typeof evidenceSnapshot !== 'object') {
    return ids;
  }

  // Check observations or items array
  const observations = evidenceSnapshot.observations || evidenceSnapshot.evidence_items || [];
  if (Array.isArray(observations)) {
    for (const item of observations) {
      if (item && item.id) {
        ids.add(String(item.id).trim().toUpperCase());
      }
    }
  }

  // Also check top-level baseline or incident IDs if formatted as E-xxx
  if (evidenceSnapshot.baseline && evidenceSnapshot.baseline.id) {
    ids.add(String(evidenceSnapshot.baseline.id).trim().toUpperCase());
  }

  return ids;
}

/**
 * Validates a parsed model response against the schema and checks evidence references.
 *
 * @param {Object|string} response - raw text or parsed object
 * @param {Object} evidenceSnapshot - the exact evidence package sent to the model
 * @returns {{ valid: boolean, errors: string[], result: Object|null, invalidEvidenceIds: string[] }}
 */
function validateAiResponse(response, evidenceSnapshot) {
  const errors = [];
  const invalidEvidenceIds = [];

  let parsed = null;
  if (typeof response === 'string') {
    try {
      parsed = extractAndParseJson(response);
    } catch (parseErr) {
      return {
        valid: false,
        errors: [`JSON parse failure: ${parseErr.message}`],
        result: null,
        invalidEvidenceIds: [],
      };
    }
  } else if (response && typeof response === 'object') {
    parsed = response;
  } else {
    return {
      valid: false,
      errors: ['Response must be a valid JSON string or object'],
      result: null,
      invalidEvidenceIds: [],
    };
  }

  // 1. Structural validation via Ajv
  const validSchema = validateCompiled(parsed);
  if (!validSchema) {
    for (const err of validateCompiled.errors || []) {
      errors.push(`Schema error at ${err.instancePath || '/'}: ${err.message}`);
    }
  }

  // Ensure default arrays if missing
  if (parsed.hypotheses) {
    parsed.hypotheses.forEach((h) => {
      if (!Array.isArray(h.contradicting_evidence_ids)) {
        h.contradicting_evidence_ids = [];
      }
    });
  }

  // 2. Strict evidence citation verification
  const knownIds = extractKnownEvidenceIds(evidenceSnapshot);

  const checkCitations = (citedIds, location) => {
    if (!Array.isArray(citedIds)) return;
    for (const rawId of citedIds) {
      const normalizedId = String(rawId).trim().toUpperCase();
      if (!knownIds.has(normalizedId)) {
        errors.push(`Invalid evidence citation "${rawId}" at ${location} (not present in evidence package)`);
        invalidEvidenceIds.push(rawId);
      }
    }
  };

  if (Array.isArray(parsed.observed_facts)) {
    parsed.observed_facts.forEach((item, idx) => {
      checkCitations(item.evidence_ids, `observed_facts[${idx}]`);
    });
  }

  if (Array.isArray(parsed.hypotheses)) {
    parsed.hypotheses.forEach((h, idx) => {
      checkCitations(h.supporting_evidence_ids, `hypotheses[${idx}].supporting_evidence_ids`);
      checkCitations(h.contradicting_evidence_ids, `hypotheses[${idx}].contradicting_evidence_ids`);
    });
  }

  if (Array.isArray(parsed.recommended_checks)) {
    parsed.recommended_checks.forEach((c, idx) => {
      checkCitations(c.evidence_ids, `recommended_checks[${idx}].evidence_ids`);
    });
  }

  const valid = errors.length === 0;

  return {
    valid,
    errors,
    result: valid ? parsed : null,
    invalidEvidenceIds,
    schemaVersion: SCHEMA_VERSION,
  };
}

module.exports = {
  validateAiResponse,
  extractAndParseJson,
  extractKnownEvidenceIds,
  responseJsonSchema,
};

