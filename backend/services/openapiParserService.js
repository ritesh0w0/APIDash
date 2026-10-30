// backend/services/openapiParserService.js
'use strict';

const crypto = require('crypto');
const YAML = require('yaml');
const { validate, dereference } = require('@scalar/openapi-parser');

const MAX_SPEC_BYTES = 1024 * 1024; // 1 MiB hard ceiling

/**
 * Scans an object recursively for all $ref strings.
 *
 * @param {any} obj
 * @param {Array<string>} [refs]
 * @returns {Array<string>}
 */
function scanReferences(obj, refs = []) {
  if (!obj || typeof obj !== 'object') return refs;
  if (Array.isArray(obj)) {
    for (const item of obj) scanReferences(item, refs);
    return refs;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === '$ref' && typeof v === 'string') {
      refs.push(v);
    } else if (typeof v === 'object' && v !== null) {
      scanReferences(v, refs);
    }
  }
  return refs;
}

// Deterministic canonical JSON stringification with sorted keys
function canonicalStringify(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k]));
  return '{' + pairs.join(',') + '}';
}

/**
 * Calculates a deterministic canonical SHA-256 hash for an OpenAPI specification object.
 *
 * @param {Object} spec
 * @returns {string} hex-encoded SHA-256 digest
 */
function calculateCanonicalSpecSha256(spec) {
  const json = canonicalStringify(spec);
  return crypto.createHash('sha256').update(json).digest('hex');
}

/**
 * Parses and strictly validates an OpenAPI specification document (JSON or YAML).
 * Guarantees local-only reference resolution and bounds memory/CPU.
 *
 * @param {string} rawInput
 * @returns {Promise<Object>} parsed result with metadata and catalog
 */
async function parseAndValidateOpenAPI(rawInput) {
  if (typeof rawInput !== 'string') {
    throw new Error('Specification input must be a string');
  }

  const byteLength = Buffer.byteLength(rawInput, 'utf8');
  if (byteLength > MAX_SPEC_BYTES) {
    throw new Error(`Specification exceeds maximum allowed size of 1 MiB (${byteLength} bytes)`);
  }

  let doc = null;
  const trimmed = rawInput.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      doc = JSON.parse(rawInput);
    } catch (e) {
      throw new Error(`Invalid JSON syntax: ${e.message}`);
    }
  } else {
    try {
      // Safe YAML parsing with alias limit to mitigate billion laughs / entity expansion attacks
      doc = YAML.parse(rawInput, { maxAliasCount: 100 });
    } catch (e) {
      throw new Error(`Invalid YAML syntax: ${e.message}`);
    }
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('OpenAPI specification root must be a valid non-empty object');
  }

  // Version identification
  const rawVersion = doc.openapi;
  if (!rawVersion || typeof rawVersion !== 'string') {
    if (doc.swagger) {
      throw new Error('OpenAPI 2.0 (Swagger) is not supported. Please upgrade specification to OpenAPI 3.0, 3.1, or 3.2.');
    }
    throw new Error("Missing required 'openapi' version field at root");
  }

  const semverMatch = rawVersion.trim().match(/^3\.(0|1|2)(\.\d+)?/);
  if (!semverMatch) {
    throw new Error(`Unsupported OpenAPI version: "${rawVersion}". APIDash Phase 6 supports OpenAPI 3.0.x, 3.1.x, and 3.2.x.`);
  }

  // Pre-validate all references: strictly forbid external/network/filesystem references
  const allRefs = scanReferences(doc);
  for (const ref of allRefs) {
    const trimmedRef = ref.trim();
    if (!trimmedRef.startsWith('#/')) {
      throw new Error(
        `External or remote reference prohibited: "${trimmedRef}". Only internal document references starting with '#/' are permitted.`
      );
    }
  }

  // Structural validation using Scalar OpenAPI parser
  const validationResult = await validate(doc);
  if (!validationResult.valid && validationResult.errors && validationResult.errors.length > 0) {
    const errorDetails = validationResult.errors
      .slice(0, 5)
      .map((e) => e.message || String(e))
      .join('; ');
    throw new Error(`OpenAPI structural validation failed: ${errorDetails}`);
  }

  // Dereference internal references locally
  const derefResult = await dereference(doc);
  if (derefResult.errors && derefResult.errors.length > 0) {
    const internalErrors = derefResult.errors
      .slice(0, 5)
      .map((e) => e.message || String(e))
      .join('; ');
    throw new Error(`Internal reference resolution error: ${internalErrors}`);
  }

  const dereferencedSpec = derefResult.schema || doc;

  // Extract operation catalog
  const catalog = [];
  const paths = dereferencedSpec.paths || {};
  const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];

  // Global servers
  const globalServers = Array.isArray(dereferencedSpec.servers) ? dereferencedSpec.servers : [];

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const pathLevelParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    const pathServers = Array.isArray(pathItem.servers) ? pathItem.servers : globalServers;

    for (const m of httpMethods) {
      if (pathItem[m] && typeof pathItem[m] === 'object') {
        const op = pathItem[m];
        const mergedParams = [...pathLevelParams, ...(Array.isArray(op.parameters) ? op.parameters : [])];
        const opServers = Array.isArray(op.servers) ? op.servers : pathServers;

        catalog.push({
          method: m.toUpperCase(),
          pathTemplate,
          operationId: op.operationId ? String(op.operationId).trim() : null,
          summary: op.summary ? String(op.summary).slice(0, 500) : null,
          description: op.description ? String(op.description).slice(0, 1000) : null,
          tags: Array.isArray(op.tags) ? op.tags.map(String) : [],
          hasRequestBody: Boolean(op.requestBody),
          parametersCount: mergedParams.length,
          responsesCount: op.responses ? Object.keys(op.responses).length : 0,
          servers: opServers.map((s) => ({ url: s.url, description: s.description || null })),
        });
      }
    }
  }

  // Deterministic canonical JSON and SHA-256 calculation
  const contentSha256 = calculateCanonicalSpecSha256(doc);

  return {
    valid: true,
    openapiVersion: rawVersion.trim(),
    canonicalContent: doc,
    rawText: rawInput,
    contentSha256,
    operationsCatalog: catalog,
    dereferencedSpec,
  };
}

module.exports = {
  parseAndValidateOpenAPI,
  scanReferences,
  calculateCanonicalSpecSha256,
  MAX_SPEC_BYTES,
};

