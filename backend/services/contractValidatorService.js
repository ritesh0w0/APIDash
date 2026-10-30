// backend/services/contractValidatorService.js
'use strict';

const Ajv07 = require('ajv');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { logger: defaultLogger } = require('../logger');

const MAX_VALIDATOR_CACHE_SIZE = 200;
const MAX_FINDINGS_COUNT = 20;

/**
 * Simple in-memory bounded LRU-like cache for compiled schema validators.
 */
class ValidatorCache {
  constructor(maxSize = MAX_VALIDATOR_CACHE_SIZE) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const val = this.cache.get(key);
    // Refresh access order
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }

  set(key, val) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest entry
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, val);
  }

  clear() {
    this.cache.clear();
  }
}

class ContractValidatorService {
  constructor(options = {}) {
    this.logger = options.logger || defaultLogger;
    this.cache = new ValidatorCache(options.cacheSize || MAX_VALIDATOR_CACHE_SIZE);

    // Ajv instance for OpenAPI 3.0.x (JSON Schema Draft-07 + native nullable support)
    this.ajv07 = new Ajv07({
      strict: false,
      allErrors: true,
      coerceTypes: true,
    });
    addFormats(this.ajv07);

    // Ajv instance for OpenAPI 3.1.x and 3.2.x (JSON Schema Draft 2020-12)
    this.ajv2020 = new Ajv2020({
      strict: false,
      allErrors: true,
      coerceTypes: true,
    });
    addFormats(this.ajv2020);
  }

  /**
   * Returns the appropriate Ajv instance based on the OpenAPI version.
   *
   * @param {string} openapiVersion
   * @returns {import('ajv').default}
   */
  getAjvForVersion(openapiVersion = '3.0.0') {
    const version = String(openapiVersion).trim();
    if (version.startsWith('3.1') || version.startsWith('3.2')) {
      return this.ajv2020;
    }
    return this.ajv07;
  }

  /**
   * Compiles or retrieves a cached schema validator.
   *
   * @param {Object} schema
   * @param {string} cacheKey
   * @param {string} openapiVersion
   * @returns {import('ajv').ValidateFunction}
   */
  getCompiledValidator(schema, cacheKey, openapiVersion = '3.0.0') {
    if (cacheKey) {
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }

    const ajv = this.getAjvForVersion(openapiVersion);
    const validate = ajv.compile(schema);

    if (cacheKey) {
      this.cache.set(cacheKey, validate);
    }
    return validate;
  }

  /**
   * Matches a concrete request URL pathname against an OpenAPI path template.
   * Supports base path prefixes derived from the contract's server metadata.
   *
   * @param {string} pathTemplate e.g. "/users/{id}"
   * @param {string} actualPath e.g. "/v1/users/123"
   * @param {Array<string>} [basePaths] e.g. ["/v1"]
   * @returns {{ matched: boolean, pathParams: Record<string, string> }}
   */
  matchPath(pathTemplate, actualPath, basePaths = []) {
    const candidates = [pathTemplate];
    for (const bp of basePaths) {
      const cleanBp = bp.endsWith('/') ? bp.slice(0, -1) : bp;
      if (cleanBp && !pathTemplate.startsWith(cleanBp)) {
        candidates.push(`${cleanBp}${pathTemplate.startsWith('/') ? '' : '/'}${pathTemplate}`);
      }
    }

    for (const candidate of candidates) {
      const paramNames = [];
      const regexStr = '^' + candidate.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => {
        paramNames.push(name);
        return '([^/]+)';
      }) + '$';

      try {
        const regex = new RegExp(regexStr);
        const match = actualPath.match(regex);
        if (match) {
          const pathParams = {};
          paramNames.forEach((name, i) => {
            pathParams[name] = decodeURIComponent(match[i + 1]);
          });
          return { matched: true, pathParams };
        }
      } catch (_e) {}
    }

    return { matched: false, pathParams: {} };
  }

  /**
   * Helper that accepts an actual URL/pathname and path template (with optional basePaths).
   */
  matchOperationPath(actualUrlOrPath, pathTemplate, serversOrBasePaths = []) {
    let pathname = actualUrlOrPath;
    try {
      if (typeof actualUrlOrPath === 'string' && (actualUrlOrPath.startsWith('http://') || actualUrlOrPath.startsWith('https://'))) {
        const u = new URL(actualUrlOrPath);
        pathname = u.pathname;
      }
    } catch (_) {}

    let basePaths = [];
    if (Array.isArray(serversOrBasePaths)) {
      if (serversOrBasePaths.length > 0 && typeof serversOrBasePaths[0] === 'object' && serversOrBasePaths[0] !== null) {
        basePaths = this.extractServerBasePaths(serversOrBasePaths);
      } else {
        basePaths = serversOrBasePaths;
      }
    }

    const res = this.matchPath(pathTemplate, pathname, basePaths);
    return {
      matched: res.matched,
      params: res.pathParams,
      pathParams: res.pathParams,
    };
  }

  /**
   * Extracts base paths declared in OpenAPI servers object.
   *
   * @param {Array<Object>} [servers]
   * @returns {Array<string>}
   */
  extractServerBasePaths(servers = []) {
    if (!Array.isArray(servers)) return [];
    const basePaths = [];
    for (const s of servers) {
      if (!s || !s.url) continue;
      try {
        if (s.url.startsWith('http://') || s.url.startsWith('https://')) {
          const u = new URL(s.url);
          if (u.pathname && u.pathname !== '/') {
            basePaths.push(u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname);
          }
        } else if (s.url.startsWith('/') && s.url !== '/') {
          basePaths.push(s.url.endsWith('/') ? s.url.slice(0, -1) : s.url);
        }
      } catch (_e) {}
    }
    return Array.from(new Set(basePaths));
  }

  /**
   * Validates outgoing request configuration before outbound HTTP dispatch (Request Preflight).
   * Supports both (operation, pathTemplate, monitorRequest, options) and (monitorRequest, binding, revision) signatures.
   *
   * @returns {Object} { valid, verdict, failureCategory, findings, findingsCount, findingsTruncated }
   */
  validateRequestPreflight(arg1, arg2, arg3, arg4 = {}) {
    let operation;
    let pathTemplate;
    let monitorRequest;
    let options = {};

    if (arg2 && typeof arg2 === 'object' && arg3 && typeof arg3 === 'object') {
      // Signature: validateRequestPreflight(monitor, binding, revision)
      monitorRequest = arg1;
      const binding = arg2;
      const revision = arg3;
      pathTemplate = binding.operation_path || binding.path_template;
      const method = (binding.operation_method || binding.method || 'GET').toLowerCase();
      options = {
        openapiVersion: revision.openapi_version,
        contentSha256: revision.content_sha256,
      };

      const spec = revision.dereferenced_spec || revision.specification_content || {};
      const pathItem = spec.paths ? (spec.paths[pathTemplate] || {}) : {};
      operation = pathItem[method] || { method, parameters: [], responses: {} };
      if (!operation.method) operation.method = method;
      if (spec.servers && !operation.servers) operation.servers = spec.servers;
    } else {
      operation = arg1;
      pathTemplate = arg2;
      monitorRequest = arg3;
      options = arg4 || {};
    }

    const findings = [];
    const openapiVersion = options.openapiVersion || '3.0.0';
    const contentSha256 = options.contentSha256 || 'unknown';

    // 1. Method verification
    const expectedMethod = String(operation.method || '').toUpperCase();
    const actualMethod = String(monitorRequest.method || 'GET').toUpperCase();
    if (expectedMethod && actualMethod !== expectedMethod) {
      findings.push({
        rule: 'method',
        location: 'request.method',
        expected: expectedMethod,
        actual: actualMethod,
        message: `HTTP method mismatch: expected ${expectedMethod}, got ${actualMethod}`,
      });
    }

    // 2. Path matching
    let actualPath = '/';
    let queryParams = {};
    try {
      const parsedUrl = new URL(monitorRequest.url);
      actualPath = parsedUrl.pathname || '/';
      parsedUrl.searchParams.forEach((val, key) => {
        queryParams[key] = val;
      });
    } catch (_e) {
      actualPath = monitorRequest.url || '/';
    }

    const basePaths = this.extractServerBasePaths(operation.servers);
    const pathMatchResult = this.matchPath(pathTemplate, actualPath, basePaths);
    if (!pathMatchResult.matched) {
      findings.push({
        rule: 'path_match',
        location: 'request.path',
        expected: pathTemplate,
        actual: actualPath,
        message: `URL path "${actualPath}" does not match operation template "${pathTemplate}"`,
      });
    }

    const extractedPathParams = pathMatchResult.pathParams || {};

    // 3. Parameters validation (path, query, header)
    const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
    const requestHeaders = monitorRequest.headers || {};
    const lowerHeaders = {};
    for (const [k, v] of Object.entries(requestHeaders)) {
      lowerHeaders[k.toLowerCase()] = v;
    }

    for (const param of parameters) {
      if (!param || !param.name) continue;
      const paramName = param.name;
      const paramIn = param.in;
      const isRequired = Boolean(param.required);

      let actualVal = undefined;
      if (paramIn === 'path') {
        actualVal = extractedPathParams[paramName];
      } else if (paramIn === 'query') {
        actualVal = queryParams[paramName];
      } else if (paramIn === 'header') {
        actualVal = lowerHeaders[paramName.toLowerCase()];
      }

      if (actualVal === undefined || actualVal === null || actualVal === '') {
        if (isRequired) {
          findings.push({
            rule: 'parameter_required',
            location: `request.${paramIn}.${paramName}`,
            expected: 'required parameter present',
            actual: 'missing',
            message: `Missing required ${paramIn} parameter: "${paramName}"`,
          });
        }
        continue;
      }

      // Validate parameter schema if defined
      if (param.schema && typeof param.schema === 'object') {
        let valToValidate = actualVal;
        const schemaType = param.schema.type;

        // Type coercion for URL strings
        if (schemaType === 'integer') {
          const parsed = Number(actualVal);
          valToValidate = Number.isInteger(parsed) ? parsed : actualVal;
        } else if (schemaType === 'number') {
          const parsed = Number(actualVal);
          valToValidate = !isNaN(parsed) ? parsed : actualVal;
        } else if (schemaType === 'boolean') {
          if (actualVal === 'true') valToValidate = true;
          else if (actualVal === 'false') valToValidate = false;
        }

        try {
          const cacheKey = `${contentSha256}:${pathTemplate}:${paramIn}:${paramName}`;
          const validator = this.getCompiledValidator(param.schema, cacheKey, openapiVersion);
          const valid = validator(valToValidate);
          if (!valid && validator.errors) {
            for (const err of validator.errors) {
              findings.push({
                rule: 'parameter_type',
                location: `request.${paramIn}.${paramName}`,
                expected: err.message || 'schema match',
                actual: typeof actualVal === 'string' ? actualVal.slice(0, 100) : typeof actualVal,
                message: `Parameter "${paramName}" validation failed: ${err.message}`,
              });
            }
          }
        } catch (_compErr) {
          // Schema compilation error in parameter definition
        }
      }
    }

    // 4. Request body validation
    if (operation.requestBody && typeof operation.requestBody === 'object') {
      const isBodyRequired = Boolean(operation.requestBody.required);
      const hasBody = monitorRequest.body !== undefined && monitorRequest.body !== null && monitorRequest.body !== '';
      const content = operation.requestBody.content || {};

      if (isBodyRequired && !hasBody) {
        findings.push({
          rule: 'body_required',
          location: 'request.body',
          expected: 'required request body',
          actual: 'missing',
          message: 'Request body is required by contract but was not provided',
        });
      } else if (hasBody) {
        const rawContentType = lowerHeaders['content-type'] || 'application/json';
        const normalizedContentType = rawContentType.split(';')[0].trim().toLowerCase();

        // Match declared media type in content
        const declaredMediaTypes = Object.keys(content);
        let matchingMediaKey = declaredMediaTypes.find((mt) => mt.toLowerCase() === normalizedContentType);

        if (!matchingMediaKey && (normalizedContentType === 'application/json' || normalizedContentType.endsWith('+json'))) {
          matchingMediaKey = declaredMediaTypes.find(
            (mt) => mt.toLowerCase() === 'application/json' || mt.toLowerCase().endsWith('+json')
          );
        }

        if (declaredMediaTypes.length > 0 && !matchingMediaKey) {
          findings.push({
            rule: 'content_type',
            location: 'request.header.content-type',
            expected: declaredMediaTypes.join(', '),
            actual: normalizedContentType,
            message: `Unsupported request Content-Type "${normalizedContentType}". Declared: ${declaredMediaTypes.join(', ')}`,
          });
        } else if (matchingMediaKey) {
          const mediaObj = content[matchingMediaKey];
          if (mediaObj && mediaObj.schema) {
            let parsedBody = monitorRequest.body;
            if (typeof parsedBody === 'string') {
              try {
                parsedBody = JSON.parse(parsedBody);
              } catch (parseErr) {
                findings.push({
                  rule: 'schema',
                  location: 'request.body',
                  expected: 'valid JSON',
                  actual: 'invalid JSON syntax',
                  message: `Request body is not valid JSON: ${parseErr.message}`,
                });
                parsedBody = null;
              }
            }

            if (parsedBody !== null) {
              try {
                const cacheKey = `${contentSha256}:${pathTemplate}:requestBody:${matchingMediaKey}`;
                const validator = this.getCompiledValidator(mediaObj.schema, cacheKey, openapiVersion);
                const valid = validator(parsedBody);
                if (!valid && validator.errors) {
                  for (const err of validator.errors) {
                    const propPath = err.instancePath ? `body${err.instancePath}` : 'body';
                    findings.push({
                      rule: 'schema',
                      location: 'request.body',
                      expected: err.message || 'schema match',
                      actual: err.params ? JSON.stringify(err.params).slice(0, 100) : 'invalid',
                      message: `Request body schema error at ${propPath}: ${err.message}`,
                    });
                  }
                }
              } catch (compErr) {
                this.logger.warn({ err: compErr.message }, 'Failed to compile request body schema validator');
              }
            }
          }
        }
      }
    }

    const totalFindingsCount = findings.length;
    const truncated = totalFindingsCount > MAX_FINDINGS_COUNT;
    const boundedFindings = findings.slice(0, MAX_FINDINGS_COUNT);

    if (totalFindingsCount > 0) {
      return {
        valid: false,
        verdict: 'preflight_rejected',
        failureCategory: 'PREFLIGHT_REJECTED',
        findings: boundedFindings,
        findingsCount: totalFindingsCount,
        findingsTruncated: truncated,
      };
    }

    return {
      valid: true,
      verdict: 'passed',
      failureCategory: null,
      findings: [],
      findingsCount: 0,
      findingsTruncated: false,
    };
  }

  /**
   * Validates the actual HTTP response against the bound operation contract.
   * Supports both (operation, pathTemplate, observation, options) and (observation, binding, revision) signatures.
   *
   * @returns {Object} { valid, verdict, failureCategory, findings, findingsCount, findingsTruncated }
   */
  validateResponseContract(arg1, arg2, arg3, arg4 = {}) {
    let operation;
    let pathTemplate;
    let observation;
    let options = {};

    if (arg2 && typeof arg2 === 'object' && arg3 && typeof arg3 === 'object') {
      // Signature: validateResponseContract(observation, binding, revision)
      observation = arg1;
      const binding = arg2;
      const revision = arg3;
      pathTemplate = binding.operation_path || binding.path_template;
      const method = (binding.operation_method || binding.method || 'GET').toLowerCase();
      options = {
        openapiVersion: revision.openapi_version,
        contentSha256: revision.content_sha256,
      };

      const spec = revision.dereferenced_spec || revision.specification_content || {};
      const pathItem = spec.paths ? (spec.paths[pathTemplate] || {}) : {};
      operation = pathItem[method] || { method, responses: {} };
      if (!operation.method) operation.method = method;
      if (spec.servers && !operation.servers) operation.servers = spec.servers;
    } else {
      operation = arg1;
      pathTemplate = arg2;
      observation = arg3;
      options = arg4 || {};
    }

    const findings = [];
    const openapiVersion = options.openapiVersion || '3.0.0';
    const contentSha256 = options.contentSha256 || 'unknown';
    const responses = operation.responses || {};

    const statusCode = Number(observation.status_code);
    const statusCodeStr = String(statusCode);
    const statusRangeKey = `${statusCodeStr[0]}XX`;

    // 1. Resolve matching response definition (exact > range > default)
    let responseDef = responses[statusCodeStr] || responses[statusRangeKey] || responses['default'] || null;

    if (!responseDef) {
      findings.push({
        rule: 'status_code',
        location: 'response.status',
        expected: Object.keys(responses).join(', ') || 'declared response',
        actual: statusCodeStr,
        message: `HTTP status code ${statusCode} is not documented in contract responses`,
      });

      return {
        valid: false,
        verdict: 'failed',
        failureCategory: 'RESPONSE_STATUS_UNDECLARED',
        findings,
        findingsCount: findings.length,
        findingsTruncated: false,
      };
    }

    // 2. Validate response headers if defined
    if (responseDef.headers && typeof responseDef.headers === 'object') {
      const actualHeaders = observation.headers || {};
      const lowerActualHeaders = {};
      for (const [k, v] of Object.entries(actualHeaders)) {
        lowerActualHeaders[k.toLowerCase()] = v;
      }

      for (const [headerName, headerDef] of Object.entries(responseDef.headers)) {
        const lowerName = headerName.toLowerCase();
        const isRequired = Boolean(headerDef.required);
        const headerVal = lowerActualHeaders[lowerName];

        if (headerVal === undefined) {
          if (isRequired) {
            findings.push({
              rule: 'header',
              location: `response.header.${headerName}`,
              expected: 'required header present',
              actual: 'missing',
              message: `Missing required response header: "${headerName}"`,
            });
          }
          continue;
        }

        if (headerDef.schema && typeof headerDef.schema === 'object') {
          try {
            const cacheKey = `${contentSha256}:${pathTemplate}:respHeader:${lowerName}`;
            const validator = this.getCompiledValidator(headerDef.schema, cacheKey, openapiVersion);
            const valid = validator(headerVal);
            if (!valid && validator.errors) {
              for (const err of validator.errors) {
                findings.push({
                  rule: 'header',
                  location: `response.header.${headerName}`,
                  expected: err.message,
                  actual: String(headerVal).slice(0, 100),
                  message: `Response header "${headerName}" validation failed: ${err.message}`,
                });
              }
            }
          } catch (_e) {}
        }
      }
    }

    // 3. No-body responses check (204 No Content, 304 Not Modified)
    if (statusCode === 204 || statusCode === 304) {
      const rawBody = observation.raw_body !== undefined
        ? observation.raw_body
        : (typeof observation.body === 'string' ? observation.body : '');

      if (rawBody && String(rawBody).trim() !== '') {
        findings.push({
          rule: 'no_content_body',
          location: 'response.body',
          expected: 'empty body for HTTP ' + statusCode,
          actual: 'body present',
          message: `HTTP ${statusCode} response must not contain a response body`,
        });
      }

      const totalFindingsCount = findings.length;
      return {
        valid: totalFindingsCount === 0,
        verdict: totalFindingsCount > 0 ? 'failed' : 'passed',
        failureCategory: totalFindingsCount > 0 ? 'RESPONSE_BODY_UNEXPECTED' : null,
        findings: findings.slice(0, MAX_FINDINGS_COUNT),
        findingsCount: totalFindingsCount,
        findingsTruncated: totalFindingsCount > MAX_FINDINGS_COUNT,
      };
    }

    // 4. Content and Body Schema Validation
    const content = responseDef.content;
    if (content && typeof content === 'object') {
      const declaredMediaTypes = Object.keys(content);
      const actualHeaders = observation.headers || {};
      const headerContentType = actualHeaders['content-type'] || actualHeaders['Content-Type'] || '';
      const rawContentType = (observation.content_type || headerContentType || '').trim().toLowerCase();
      const normalizedContentType = rawContentType.split(';')[0].trim();

      const rawBody = observation.raw_body !== undefined
        ? observation.raw_body
        : (typeof observation.body === 'string' ? observation.body : JSON.stringify(observation.body || ''));
      const bodyBytes = Buffer.byteLength(String(rawBody || ''), 'utf8');
      const isTruncated = Boolean(observation.body_truncated) || bodyBytes > 65536;

      // Check if response body exceeded 64 KB inspection limit
      if (isTruncated) {
        findings.push({
          rule: 'inspection_limit',
          location: 'response.body',
          expected: 'body <= 64 KB for complete inspection',
          actual: 'truncated (>64 KB)',
          message: 'Response body exceeded 64 KB inspection limit. Schema validation could not be completed.',
        });
        return {
          valid: false,
          verdict: 'partial',
          failureCategory: 'RESPONSE_INSPECTION_LIMIT_EXCEEDED',
          inspection_truncated: true,
          findings,
          findingsCount: findings.length,
          findingsTruncated: false,
        };
      }

      // Match media type
      let matchingMediaKey = declaredMediaTypes.find((mt) => mt.toLowerCase() === normalizedContentType);

      if (!matchingMediaKey && (normalizedContentType === 'application/json' || normalizedContentType.endsWith('+json'))) {
        matchingMediaKey = declaredMediaTypes.find(
          (mt) => mt.toLowerCase() === 'application/json' || mt.toLowerCase().endsWith('+json')
        );
      }

      if (declaredMediaTypes.length > 0 && !matchingMediaKey) {
        findings.push({
          rule: 'content_type',
          location: 'response.header.content-type',
          expected: declaredMediaTypes.join(', '),
          actual: normalizedContentType || 'none',
          message: `Response Content-Type "${normalizedContentType || 'none'}" does not match declared media types: ${declaredMediaTypes.join(', ')}`,
        });
      } else if (matchingMediaKey) {
        const mediaObj = content[matchingMediaKey];
        const isJsonMedia = matchingMediaKey.toLowerCase() === 'application/json' || matchingMediaKey.toLowerCase().endsWith('+json');

        if (isJsonMedia && mediaObj && mediaObj.schema) {
          if (observation.json_parse_error) {
            findings.push({
              rule: 'schema',
              location: 'response.body',
              expected: 'valid JSON',
              actual: 'JSON parse error',
              message: `Response body is not valid JSON: ${observation.json_parse_error}`,
            });
          } else {
            let bodyData = observation.json_body;
            if (bodyData === undefined && typeof observation.body === 'string') {
              try {
                bodyData = JSON.parse(observation.body);
              } catch (_e) {
                bodyData = null;
              }
            } else if (bodyData === undefined && typeof observation.body === 'object') {
              bodyData = observation.body;
            }

            if (bodyData === null || bodyData === undefined) {
              findings.push({
                rule: 'schema',
                location: 'response.body',
                expected: 'response body present',
                actual: 'empty body',
                message: 'Contract documents a JSON response body, but empty response was received',
              });
            } else {
              try {
                const cacheKey = `${contentSha256}:${pathTemplate}:respBody:${statusCodeStr}:${matchingMediaKey}`;
                const validator = this.getCompiledValidator(mediaObj.schema, cacheKey, openapiVersion);
                const valid = validator(bodyData);
                if (!valid && validator.errors) {
                  for (const err of validator.errors) {
                    const propPath = err.instancePath ? `body${err.instancePath}` : 'body';
                    findings.push({
                      rule: 'schema',
                      location: 'response.body',
                      property: propPath,
                      expected: err.message || 'schema match',
                      actual: err.params ? JSON.stringify(err.params).slice(0, 100) : 'invalid',
                      message: `Response body schema violation at ${propPath}: ${err.message}`,
                    });
                  }
                }
              } catch (compErr) {
                this.logger.warn({ err: compErr.message }, 'Failed to compile response body schema validator');
                findings.push({
                  rule: 'schema_unsupported',
                  location: 'response.schema',
                  expected: 'valid schema dialect construct',
                  actual: 'unsupported dialect construct',
                  message: `Schema construct could not be evaluated: ${compErr.message}`,
                });
                return {
                  valid: false,
                  verdict: 'partial',
                  failureCategory: 'UNSUPPORTED_SCHEMA_CONSTRUCT',
                  findings,
                  findingsCount: findings.length,
                  findingsTruncated: false,
                };
              }
            }
          }
        } else if (!isJsonMedia) {
          // Non-JSON media type (e.g. image/png, text/plain)
          findings.push({
            rule: 'non_json_media',
            location: 'response.body',
            expected: matchingMediaKey,
            actual: normalizedContentType,
            message: `Media type "${matchingMediaKey}" validated for Content-Type match; body schema validation unsupported for non-JSON media types`,
          });
          return {
            valid: false,
            verdict: 'partial',
            failureCategory: 'NON_JSON_MEDIA_TYPE',
            findings,
            findingsCount: findings.length,
            findingsTruncated: false,
          };
        }
      }
    }

    const totalFindingsCount = findings.length;
    const truncated = totalFindingsCount > MAX_FINDINGS_COUNT;
    const boundedFindings = findings.slice(0, MAX_FINDINGS_COUNT);

    if (totalFindingsCount > 0) {
      return {
        valid: false,
        verdict: 'failed',
        failureCategory: 'RESPONSE_SCHEMA_VIOLATION',
        findings: boundedFindings,
        findingsCount: totalFindingsCount,
        findingsTruncated: truncated,
      };
    }

    return {
      valid: true,
      verdict: 'passed',
      failureCategory: null,
      findings: [],
      findingsCount: 0,
      findingsTruncated: false,
    };
  }
}

const contractValidatorService = new ContractValidatorService();

module.exports = {
  ContractValidatorService,
  contractValidatorService,
  MAX_FINDINGS_COUNT,
  matchOperationPath: contractValidatorService.matchOperationPath.bind(contractValidatorService),
  validateRequestPreflight: contractValidatorService.validateRequestPreflight.bind(contractValidatorService),
  validateResponseContract: contractValidatorService.validateResponseContract.bind(contractValidatorService),
};

