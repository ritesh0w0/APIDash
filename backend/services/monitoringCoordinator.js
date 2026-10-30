// backend/services/monitoringCoordinator.js
'use strict';

const { executeRequest } = require('./executor');
const { getDefaultAssertions, evaluateAssertions } = require('./assertionEngine');
const { testResultRepository: defaultResultRepo } = require('../data/testResultRepository');
const { contractRepository: defaultContractRepo } = require('../data/contractRepository');
const { contractValidatorService: defaultValidatorService } = require('./contractValidatorService');
const { logger: defaultLogger } = require('../logger');

/**
 * Coordinates one complete monitoring execution run:
 * 1. Resolves monitor assertions snapshot
 * 2. Checks active contract binding and executes request preflight validation
 * 3. Invokes bounded executor (if preflight succeeds)
 * 4. Evaluates assertions and response contract against observation
 * 5. Assigns canonical outcome (passed | failed | error) & health impact (healthy | unhealthy | neutral)
 * 6. Persists result and contract validation with structured diagnostics
 *
 * @param {Object} monitor
 * @param {Object} [deps]
 * @param {import('../data/testResultRepository').TestResultRepository} [deps.resultRepo]
 * @param {import('../data/contractRepository').ContractRepository} [deps.contractRepo]
 * @param {import('./contractValidatorService').ContractValidatorService} [deps.validatorService]
 * @param {typeof executeRequest} [deps.executorFn]
 * @param {import('pino').Logger} [deps.logger]
 * @returns {Promise<Object>} complete run result
 */
async function executeMonitoringRun(monitor, deps = {}) {
  const resultRepo = deps.resultRepo || defaultResultRepo;
  const contractRepo = deps.contractRepo || defaultContractRepo;
  const validatorService = deps.validatorService || defaultValidatorService;
  const executorFn = deps.executorFn || executeRequest;
  const logger = deps.logger || defaultLogger;

  // 1. Resolve effective assertions snapshot
  const assertions = getDefaultAssertions(monitor);

  // 2. Check for active OpenAPI Contract Binding (Phase 6)
  let binding = null;
  let boundRevision = null;
  let boundOperation = null;

  try {
    if (contractRepo && typeof contractRepo.getBindingByApiId === 'function') {
      binding = await contractRepo.getBindingByApiId(monitor.id);
      if (binding) {
        boundRevision = await contractRepo.getRevisionById(binding.revision_id, binding.contract_id);
        if (boundRevision && boundRevision.specification_content) {
          const spec = boundRevision.specification_content;
          const pathItem = spec.paths && spec.paths[binding.path_template];
          const methodLower = binding.method.toLowerCase();
          boundOperation = pathItem && pathItem[methodLower];
        }
      }
    }
  } catch (bindingErr) {
    logger.warn({ err: bindingErr.message, api_id: monitor.id }, 'Failed to load contract binding for monitor');
  }

  // 3. Request Preflight Validation (if bound to contract operation)
  let preflightResult = null;
  let contractValidationData = null;

  if (binding && boundRevision) {
    if (!boundOperation) {
      // Binding points to non-existent operation
      preflightResult = {
        valid: false,
        verdict: 'preflight_rejected',
        failureCategory: 'PREFLIGHT_OPERATION_NOT_FOUND',
        findings: [
          {
            location: 'operation',
            expected: `${binding.method} ${binding.path_template}`,
            actual: 'not found in revision',
            message: `Operation ${binding.method} ${binding.path_template} was not found in contract revision ${boundRevision.revision_number}`,
          },
        ],
        findingsCount: 1,
        findingsTruncated: false,
      };
    } else {
      preflightResult = validatorService.validateRequestPreflight(
        boundOperation,
        binding.path_template,
        {
          method: monitor.method || 'GET',
          url: monitor.url,
          headers: monitor.headers,
          body: monitor.body,
        },
        {
          openapiVersion: boundRevision.openapi_version,
          contentSha256: boundRevision.content_sha256,
        }
      );
    }

    if (!preflightResult.valid) {
      // Known preflight contract violation: DO NOT send outbound HTTP request!
      const outcome = 'error';
      const errorType = 'CONTRACT_REQUEST_INVALID';
      const errorMessage = preflightResult.findings[0] ? preflightResult.findings[0].message : 'Request preflight validation failed';

      contractValidationData = {
        api_id: monitor.id,
        workspace_id: monitor.workspace_id,
        contract_id: binding.contract_id,
        revision_id: binding.revision_id,
        operation_id: binding.operation_id,
        method: binding.method,
        path_template: binding.path_template,
        verdict: preflightResult.verdict,
        failure_category: preflightResult.failureCategory,
        findings: preflightResult.findings,
        findings_count: preflightResult.findingsCount,
        findings_truncated: preflightResult.findingsTruncated,
      };

      const recordToSave = {
        api_id: monitor.id,
        status_code: null,
        response_time: 0,
        result: outcome,
        error_message: errorMessage,
        assertion_results: null,
        error_type: errorType,
        health_impact: 'neutral', // Neutral incident impact
        contract_validation: contractValidationData,
      };

      let savedRecord = null;
      let incident = null;
      let transition = null;

      try {
        if (deps.incidentService) {
          const evalRes = await deps.incidentService.recordExecutionAndEvaluateIncident(monitor, recordToSave, deps);
          savedRecord = evalRes.resultRecord;
          incident = evalRes.incident;
          transition = evalRes.transition;
        } else if (deps.resultRepo) {
          savedRecord = await deps.resultRepo.create(recordToSave);
        } else {
          const { incidentService: defaultIncidentService } = require('./incidentService');
          const evalRes = await defaultIncidentService.recordExecutionAndEvaluateIncident(monitor, recordToSave, deps);
          savedRecord = evalRes.resultRecord;
          incident = evalRes.incident;
          transition = evalRes.transition;
        }
      } catch (dbErr) {
        logger.error({ err: dbErr.message, api_id: monitor.id }, 'CRITICAL: Failed to persist preflight rejection result');
        throw dbErr;
      }

      return {
        id: savedRecord ? savedRecord.id : undefined,
        api_id: monitor.id,
        api_name: monitor.name,
        url: monitor.url,
        method: (monitor.method || 'GET').toUpperCase(),
        expected_status: monitor.expected_status,
        status_code: null,
        response_time: 0,
        result: outcome,
        outcome,
        health_impact: 'neutral',
        contract_valid: false,
        error_type: errorType,
        error_message: errorMessage,
        assertions: [],
        tested_at: new Date().toISOString(),
        incident,
        transition,
        contract_verdict: preflightResult.verdict,
        contract_findings: preflightResult.findings,
      };
    }
  }

  // 4. Execute bounded request (preflight passed or unbound monitor)
  const execResult = await executorFn(monitor, deps);

  let outcome = 'error';
  let statusCode = null;
  let responseTime = 0;
  let errorType = null;
  let errorMessage = null;
  let assertionResults = [];
  let healthImpact = 'unhealthy';

  if (!execResult.success) {
    outcome = 'error';
    statusCode = null;
    responseTime = execResult.error.response_time;
    errorType = execResult.error.error_type;
    errorMessage = execResult.error.message;
    assertionResults = [];
    healthImpact = 'unhealthy';

    if (binding && boundRevision) {
      contractValidationData = {
        api_id: monitor.id,
        workspace_id: monitor.workspace_id,
        contract_id: binding.contract_id,
        revision_id: binding.revision_id,
        operation_id: binding.operation_id,
        method: binding.method,
        path_template: binding.path_template,
        verdict: 'not_evaluated',
        failure_category: 'TRANSPORT_ERROR',
        findings: [],
        findings_count: 0,
        findings_truncated: false,
      };
    }
  } else {
    const { observation } = execResult;
    statusCode = observation.status_code;
    responseTime = observation.response_time;

    const evaluation = evaluateAssertions(assertions, observation);
    assertionResults = evaluation.results;

    if (evaluation.passed) {
      outcome = 'passed';
      errorType = null;
      errorMessage = null;
      healthImpact = 'healthy';
    } else {
      outcome = 'failed';
      errorType = 'ASSERTION_FAILED';
      const firstFail = evaluation.results.find((r) => !r.passed);
      errorMessage = firstFail ? firstFail.message : 'One or more assertions failed';
      healthImpact = 'unhealthy';
    }

    // 5. Response Contract Validation (if bound to contract operation)
    if (binding && boundRevision && boundOperation) {
      const respVal = validatorService.validateResponseContract(
        boundOperation,
        binding.path_template,
        observation,
        {
          openapiVersion: boundRevision.openapi_version,
          contentSha256: boundRevision.content_sha256,
        }
      );

      contractValidationData = {
        api_id: monitor.id,
        workspace_id: monitor.workspace_id,
        contract_id: binding.contract_id,
        revision_id: binding.revision_id,
        operation_id: binding.operation_id,
        method: binding.method,
        path_template: binding.path_template,
        verdict: respVal.verdict,
        failure_category: respVal.failureCategory,
        findings: respVal.findings,
        findings_count: respVal.findingsCount,
        findings_truncated: respVal.findingsTruncated,
      };

      if (respVal.verdict === 'failed') {
        // Contract violation turns outcome into failed / unhealthy
        outcome = 'failed';
        errorType = errorType || respVal.failureCategory || 'CONTRACT_RESPONSE_INVALID';
        if (!errorMessage) {
          errorMessage = respVal.findings[0] ? respVal.findings[0].message : 'Response contract violation';
        }
        healthImpact = 'unhealthy';
      }
      // If partial: preserves base assertion outcome
    }
  }

  // 6. Persist result & evaluate incident state atomically
  const recordToSave = {
    api_id: monitor.id,
    status_code: statusCode,
    response_time: responseTime,
    result: outcome,
    error_message: errorMessage,
    assertion_results: assertionResults.length > 0 ? assertionResults : null,
    error_type: errorType,
    health_impact: healthImpact,
    contract_validation: contractValidationData,
  };

  let savedRecord = null;
  let incident = null;
  let transition = null;

  try {
    if (deps.incidentService) {
      const evaluation = await deps.incidentService.recordExecutionAndEvaluateIncident(monitor, recordToSave, deps);
      savedRecord = evaluation.resultRecord;
      incident = evaluation.incident;
      transition = evaluation.transition;
    } else if (deps.resultRepo) {
      savedRecord = await deps.resultRepo.create(recordToSave);
    } else {
      const { incidentService: defaultIncidentService } = require('./incidentService');
      const evaluation = await defaultIncidentService.recordExecutionAndEvaluateIncident(monitor, recordToSave, deps);
      savedRecord = evaluation.resultRecord;
      incident = evaluation.incident;
      transition = evaluation.transition;
    }
  } catch (dbErr) {
    logger.error({ err: dbErr.message, api_id: monitor.id }, 'CRITICAL: Failed to persist monitoring run result');
    throw dbErr;
  }

  return {
    id: savedRecord ? savedRecord.id : undefined,
    api_id: monitor.id,
    api_name: monitor.name,
    url: monitor.url,
    method: (monitor.method || 'GET').toUpperCase(),
    expected_status: monitor.expected_status,
    status_code: statusCode,
    response_time: responseTime,
    result: outcome,
    outcome,
    health_impact: healthImpact,
    assertions_passed: assertionResults.length > 0 ? assertionResults.every((a) => a.passed) : outcome === 'passed',
    error_type: errorType,
    error_message: errorMessage,
    assertions: assertionResults,
    tested_at: new Date().toISOString(),
    incident,
    transition,
    contract_valid: contractValidationData ? contractValidationData.verdict !== 'preflight_rejected' && contractValidationData.verdict !== 'failed' : true,
    contract_verdict: contractValidationData ? contractValidationData.verdict : null,
    contract_findings: contractValidationData ? contractValidationData.findings : null,
  };
}

module.exports = {
  executeMonitoringRun,
};
