// backend/data/contractRepository.js
'use strict';

const { getPool } = require('../db');

class ContractRepository {
  constructor(pool = null) {
    this._pool = pool;
  }

  get pool() {
    return this._pool || getPool();
  }

  /**
   * Creates a new logical contract in a workspace.
   *
   * @param {number} workspaceId
   * @param {Object} data
   * @param {string} data.name
   * @param {string} [data.description]
   * @param {number} [data.createdBy]
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<Object>}
   */
  async createContract(workspaceId, data, conn = null) {
    const executor = conn || this.pool;
    const name = String(data.name || '').trim();
    const description = data.description ? String(data.description).trim() : null;
    const createdBy = data.createdBy || null;

    const [res] = await executor.execute(
      `INSERT INTO api_contracts (workspace_id, name, description, created_by)
       VALUES (?, ?, ?, ?)`,
      [workspaceId, name, description, createdBy]
    );

    return {
      id: res.insertId,
      workspace_id: workspaceId,
      name,
      description,
      created_by: createdBy,
    };
  }

  /**
   * Finds a contract by ID, verifying workspace ownership.
   *
   * @param {number} contractId
   * @param {number} workspaceId
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<Object|null>}
   */
  async findContractById(contractId, workspaceId, conn = null) {
    const executor = conn || this.pool;
    const [rows] = await executor.execute(
      `SELECT c.*,
              COUNT(r.id) AS revisions_count,
              MAX(r.revision_number) AS latest_revision_number
       FROM api_contracts c
       LEFT JOIN api_contract_revisions r ON r.contract_id = c.id
       WHERE c.id = ? AND c.workspace_id = ?
       GROUP BY c.id`,
      [contractId, workspaceId]
    );

    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      ...row,
      revisions_count: Number(row.revisions_count || 0),
      latest_revision_number: row.latest_revision_number ? Number(row.latest_revision_number) : null,
    };
  }

  /**
   * Lists contracts in a workspace with revision summary.
   * By default excludes archived contracts unless options.includeArchived is true.
   *
   * @param {number} workspaceId
   * @param {Object} [options]
   * @param {boolean} [options.includeArchived]
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<Array<Object>>}
   */
  async listContractsByWorkspace(workspaceId, options = {}, conn = null) {
    const executor = conn || this.pool;
    const includeArchived = Boolean(options && options.includeArchived);
    const whereClause = includeArchived
      ? 'WHERE c.workspace_id = ?'
      : 'WHERE c.workspace_id = ? AND c.archived_at IS NULL';

    const [rows] = await executor.execute(
      `SELECT c.id, c.workspace_id, c.name, c.description, c.archived_at, c.created_at, c.updated_at,
              COUNT(r.id) AS revisions_count,
              MAX(r.revision_number) AS latest_revision_number,
              MAX(r.openapi_version) AS latest_openapi_version
       FROM api_contracts c
       LEFT JOIN api_contract_revisions r ON r.contract_id = c.id
       ${whereClause}
       GROUP BY c.id
       ORDER BY c.updated_at DESC, c.id DESC`,
      [workspaceId]
    );

    return rows.map((r) => ({
      ...r,
      revisions_count: Number(r.revisions_count || 0),
      latest_revision_number: r.latest_revision_number ? Number(r.latest_revision_number) : null,
    }));
  }

  /**
   * Archives a contract, preserving all revisions and historical validation results.
   *
   * @param {number} contractId
   * @param {number} workspaceId
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<boolean>}
   */
  async archiveContract(contractId, workspaceId, conn = null) {
    const executor = conn || this.pool;
    const [res] = await executor.execute(
      'UPDATE api_contracts SET archived_at = NOW() WHERE id = ? AND workspace_id = ? AND archived_at IS NULL',
      [contractId, workspaceId]
    );
    return res.affectedRows > 0;
  }

  /**
   * Counts active monitor bindings currently attached to a contract.
   *
   * @param {number} contractId
   * @param {number} [workspaceId]
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<number>}
   */
  async countActiveBindingsByContractId(contractId, workspaceId = null, conn = null) {
    const executor = conn || this.pool;
    const sql = workspaceId
      ? 'SELECT COUNT(*) AS count FROM api_contract_bindings WHERE contract_id = ? AND workspace_id = ?'
      : 'SELECT COUNT(*) AS count FROM api_contract_bindings WHERE contract_id = ?';
    const params = workspaceId ? [contractId, workspaceId] : [contractId];
    const [rows] = await executor.execute(sql, params);
    return Number(rows[0].count);
  }

  /**
   * Counts historical validation results referencing a contract.
   *
   * @param {number} contractId
   * @param {number} [workspaceId]
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<number>}
   */
  async countValidationResultsByContractId(contractId, workspaceId = null, conn = null) {
    const executor = conn || this.pool;
    const sql = workspaceId
      ? 'SELECT COUNT(*) AS count FROM contract_validation_results WHERE contract_id = ? AND workspace_id = ?'
      : 'SELECT COUNT(*) AS count FROM contract_validation_results WHERE contract_id = ?';
    const params = workspaceId ? [contractId, workspaceId] : [contractId];
    const [rows] = await executor.execute(sql, params);
    return Number(rows[0].count);
  }

  /**
   * Deletes a contract from api_contracts (only safe when 0 bindings and 0 historical results exist).
   *
   * @param {number} contractId
   * @param {number} workspaceId
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<boolean>}
   */
  async deleteContract(contractId, workspaceId, conn = null) {
    const executor = conn || this.pool;
    const [res] = await executor.execute(
      'DELETE FROM api_contracts WHERE id = ? AND workspace_id = ?',
      [contractId, workspaceId]
    );
    return res.affectedRows > 0;
  }

  /**
   * Returns the next monotonically increasing revision number for a contract.
   *
   * @param {number} contractId
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<number>}
   */
  async getNextRevisionNumber(contractId, conn = null) {
    const executor = conn || this.pool;
    const [rows] = await executor.execute(
      'SELECT COALESCE(MAX(revision_number), 0) + 1 AS next_rev FROM api_contract_revisions WHERE contract_id = ?',
      [contractId]
    );
    return Number(rows[0].next_rev);
  }

  /**
   * Finds an existing revision for a contract with identical SHA-256 digest.
   *
   * @param {number} contractId
   * @param {string} contentSha256
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<Object|null>}
   */
  async findRevisionByHash(contractId, contentSha256, conn = null) {
    const executor = conn || this.pool;
    const [rows] = await executor.execute(
      'SELECT * FROM api_contract_revisions WHERE contract_id = ? AND content_sha256 = ? LIMIT 1',
      [contractId, contentSha256]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Inserts an immutable contract revision.
   *
   * @param {number} contractId
   * @param {Object} data
   * @param {number} data.revisionNumber
   * @param {string} data.openapiVersion
   * @param {string|Object} data.specificationContent
   * @param {string} [data.specificationRaw]
   * @param {string} data.contentSha256
   * @param {Array<Object>|string} data.operationsCatalog
   * @param {number} [data.createdBy]
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<Object>}
   */
  async createRevision(contractId, data, conn = null) {
    const executor = conn || this.pool;
    const specContentStr = typeof data.specificationContent === 'string'
      ? data.specificationContent
      : JSON.stringify(data.specificationContent);

    const catalogStr = typeof data.operationsCatalog === 'string'
      ? data.operationsCatalog
      : JSON.stringify(data.operationsCatalog);

    const [res] = await executor.execute(
      `INSERT INTO api_contract_revisions (
         contract_id, revision_number, openapi_version,
         specification_content, specification_raw,
         content_sha256, operations_catalog, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        contractId,
        data.revisionNumber,
        data.openapiVersion,
        specContentStr,
        data.specificationRaw || null,
        data.contentSha256,
        catalogStr,
        data.createdBy || null,
      ]
    );

    // Bump contract updated_at timestamp
    await executor.execute(
      'UPDATE api_contracts SET updated_at = NOW() WHERE id = ?',
      [contractId]
    );

    return {
      id: res.insertId,
      contract_id: contractId,
      revision_number: data.revisionNumber,
      openapi_version: data.openapiVersion,
      content_sha256: data.contentSha256,
      created_by: data.createdBy || null,
    };
  }

  /**
   * Retrieves the latest valid revision for a contract.
   *
   * @param {number} contractId
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<Object|null>}
   */
  async getLatestRevision(contractId, conn = null) {
    const executor = conn || this.pool;
    const [rows] = await executor.execute(
      'SELECT * FROM api_contract_revisions WHERE contract_id = ? ORDER BY revision_number DESC LIMIT 1',
      [contractId]
    );
    if (rows.length === 0) return null;
    return this._formatRevision(rows[0]);
  }

  /**
   * Retrieves a revision by ID.
   *
   * @param {number} revisionId
   * @param {number} [contractId]
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<Object|null>}
   */
  async getRevisionById(revisionId, contractId = null, conn = null) {
    const executor = conn || this.pool;
    const sql = contractId
      ? 'SELECT * FROM api_contract_revisions WHERE id = ? AND contract_id = ?'
      : 'SELECT * FROM api_contract_revisions WHERE id = ?';
    const params = contractId ? [revisionId, contractId] : [revisionId];

    const [rows] = await executor.execute(sql, params);
    if (rows.length === 0) return null;
    return this._formatRevision(rows[0]);
  }

  /**
   * Retrieves a revision by contract ID and revision number.
   *
   * @param {number} contractId
   * @param {number} revisionNumber
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<Object|null>}
   */
  async getRevisionByNumber(contractId, revisionNumber, conn = null) {
    const executor = conn || this.pool;
    const [rows] = await executor.execute(
      'SELECT * FROM api_contract_revisions WHERE contract_id = ? AND revision_number = ?',
      [contractId, revisionNumber]
    );
    if (rows.length === 0) return null;
    return this._formatRevision(rows[0]);
  }

  /**
   * Lists all revisions for a contract.
   *
   * @param {number} contractId
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<Array<Object>>}
   */
  async listRevisionsByContract(contractId, conn = null) {
    const executor = conn || this.pool;
    const [rows] = await executor.execute(
      `SELECT id, contract_id, revision_number, openapi_version,
              content_sha256, created_by, created_at,
              JSON_LENGTH(operations_catalog) AS operations_count
       FROM api_contract_revisions
       WHERE contract_id = ?
       ORDER BY revision_number DESC`,
      [contractId]
    );
    return rows.map((r) => ({
      ...r,
      operations_count: Number(r.operations_count || 0),
    }));
  }

  /**
   * Creates or updates a monitor's contract binding.
   * Enforces authoritative workspace scoping, non-null monitor workspace,
   * active (non-archived) contract status, and revision-contract parentage.
   *
   * @param {number} workspaceId
   * @param {number} apiId
   * @param {Object} bindingData
   * @param {number} bindingData.contractId
   * @param {number} bindingData.revisionId
   * @param {string} [bindingData.operationId]
   * @param {string} bindingData.method
   * @param {string} bindingData.pathTemplate
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<Object>}
   */
  async createOrUpdateBinding(workspaceId, apiId, bindingData, conn = null) {
    const executor = conn || this.pool;
    const contractId = Number(bindingData.contractId);
    const revisionId = Number(bindingData.revisionId);
    const method = String(bindingData.method || '').toUpperCase();
    const pathTemplate = String(bindingData.pathTemplate || '').trim();
    const operationId = bindingData.operationId ? String(bindingData.operationId).trim() : null;

    // 1. Verify monitor exists, has explicit workspace assignment, and matches workspaceId
    const [apiRows] = await executor.execute(
      'SELECT id, workspace_id FROM apis WHERE id = ?',
      [apiId]
    );
    if (apiRows.length === 0) {
      throw new Error(`API monitor ${apiId} not found`);
    }
    const api = apiRows[0];
    if (api.workspace_id === null) {
      throw new Error(`Cannot bind monitor ${apiId}: legacy unassigned monitors cannot have contract bindings`);
    }
    if (Number(api.workspace_id) !== Number(workspaceId)) {
      throw new Error(`Cannot bind monitor ${apiId}: monitor belongs to workspace ${api.workspace_id}, not ${workspaceId}`);
    }

    // 2. Verify contract exists, matches workspaceId, and is NOT archived
    const [contractRows] = await executor.execute(
      'SELECT id, workspace_id, archived_at FROM api_contracts WHERE id = ?',
      [contractId]
    );
    if (contractRows.length === 0) {
      throw new Error(`Contract ${contractId} not found`);
    }
    const contract = contractRows[0];
    if (Number(contract.workspace_id) !== Number(workspaceId)) {
      throw new Error(`Cannot bind monitor: contract ${contractId} belongs to workspace ${contract.workspace_id}, not ${workspaceId}`);
    }
    if (contract.archived_at !== null) {
      throw new Error(`Cannot bind monitor: contract ${contractId} is archived`);
    }

    // 3. Verify revision exists and belongs to contractId
    const [revRows] = await executor.execute(
      'SELECT id, contract_id FROM api_contract_revisions WHERE id = ?',
      [revisionId]
    );
    if (revRows.length === 0) {
      throw new Error(`Revision ${revisionId} not found`);
    }
    const rev = revRows[0];
    if (Number(rev.contract_id) !== Number(contractId)) {
      throw new Error(`Cannot bind monitor: revision ${revisionId} belongs to contract ${rev.contract_id}, not ${contractId}`);
    }

    await executor.execute(
      `INSERT INTO api_contract_bindings (
         api_id, workspace_id, contract_id, revision_id, operation_id, method, path_template
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         contract_id = VALUES(contract_id),
         revision_id = VALUES(revision_id),
         operation_id = VALUES(operation_id),
         method = VALUES(method),
         path_template = VALUES(path_template),
         updated_at = NOW()`,
      [
        apiId,
        workspaceId,
        contractId,
        revisionId,
        operationId,
        method,
        pathTemplate,
      ]
    );

    return this.getBindingByApiId(apiId, workspaceId, executor);
  }

  /**
   * Retrieves the contract binding for an API monitor.
   *
   * @param {number} apiId
   * @param {number} [workspaceId]
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<Object|null>}
   */
  async getBindingByApiId(apiId, workspaceId = null, conn = null) {
    const executor = conn || this.pool;
    const sql = workspaceId
      ? `SELECT b.*,
                c.name AS contract_name,
                r.revision_number,
                r.openapi_version,
                r.content_sha256
         FROM api_contract_bindings b
         JOIN api_contracts c ON c.id = b.contract_id
         JOIN api_contract_revisions r ON r.id = b.revision_id
         WHERE b.api_id = ? AND b.workspace_id = ?`
      : `SELECT b.*,
                c.name AS contract_name,
                r.revision_number,
                r.openapi_version,
                r.content_sha256
         FROM api_contract_bindings b
         JOIN api_contracts c ON c.id = b.contract_id
         JOIN api_contract_revisions r ON r.id = b.revision_id
         WHERE b.api_id = ?`;

    const params = workspaceId ? [apiId, workspaceId] : [apiId];
    const [rows] = await executor.execute(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Removes a monitor's contract binding.
   *
   * @param {number} apiId
   * @param {number} [workspaceId]
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<boolean>}
   */
  async deleteBinding(apiId, workspaceId = null, conn = null) {
    const executor = conn || this.pool;
    const sql = workspaceId
      ? 'DELETE FROM api_contract_bindings WHERE api_id = ? AND workspace_id = ?'
      : 'DELETE FROM api_contract_bindings WHERE api_id = ?';
    const params = workspaceId ? [apiId, workspaceId] : [apiId];
    const [res] = await executor.execute(sql, params);
    return res.affectedRows > 0;
  }

  /**
   * Persists a contract validation result linked to a test_results row.
   *
   * @param {Object} data
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<Object>}
   */
  async saveValidationResult(data, conn = null) {
    const executor = conn || this.pool;
    const findingsJson = typeof data.findings === 'string'
      ? data.findings
      : JSON.stringify(data.findings || []);

    const [res] = await executor.execute(
      `INSERT INTO contract_validation_results (
         test_result_id, api_id, workspace_id, contract_id, revision_id,
         operation_id, method, path_template, verdict, failure_category,
         findings, findings_count, findings_truncated, tested_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        data.test_result_id,
        data.api_id,
        data.workspace_id,
        data.contract_id,
        data.revision_id,
        data.operation_id || null,
        data.method,
        data.path_template,
        data.verdict,
        data.failure_category || null,
        findingsJson,
        data.findings_count || 0,
        data.findings_truncated ? 1 : 0,
      ]
    );

    return {
      id: res.insertId,
      ...data,
    };
  }

  /**
   * Finds the contract validation result for a given test_result_id.
   *
   * @param {number} testResultId
   * @param {number} [workspaceId]
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<Object|null>}
   */
  async getValidationResultByTestResultId(testResultId, workspaceId = null, conn = null) {
    const executor = conn || this.pool;
    const sql = workspaceId
      ? `SELECT cvr.*, c.name AS contract_name, r.revision_number
         FROM contract_validation_results cvr
         JOIN api_contracts c ON c.id = cvr.contract_id
         JOIN api_contract_revisions r ON r.id = cvr.revision_id
         WHERE cvr.test_result_id = ? AND cvr.workspace_id = ?`
      : `SELECT cvr.*, c.name AS contract_name, r.revision_number
         FROM contract_validation_results cvr
         JOIN api_contracts c ON c.id = cvr.contract_id
         JOIN api_contract_revisions r ON r.id = cvr.revision_id
         WHERE cvr.test_result_id = ?`;

    const params = workspaceId ? [testResultId, workspaceId] : [testResultId];
    const [rows] = await executor.execute(sql, params);
    if (rows.length === 0) return null;
    return this._formatValidationResult(rows[0]);
  }

  /**
   * Lists recent contract validation results for an API monitor.
   *
   * @param {number} apiId
   * @param {number} workspaceId
   * @param {Object} [options]
   * @param {number} [options.limit=20]
   * @param {number} [options.offset=0]
   * @param {import('mysql2/promise').Connection} [conn]
   * @returns {Promise<Array<Object>>}
   */
  async listValidationHistoryByApiId(apiId, workspaceId, options = {}, conn = null) {
    const executor = conn || this.pool;
    const limit = Math.max(1, Math.min(100, parseInt(options.limit, 10) || 20));
    const offset = Math.max(0, parseInt(options.offset, 10) || 0);

    const [rows] = await executor.execute(
      `SELECT cvr.*, c.name AS contract_name, r.revision_number
       FROM contract_validation_results cvr
       JOIN api_contracts c ON c.id = cvr.contract_id
       JOIN api_contract_revisions r ON r.id = cvr.revision_id
       WHERE cvr.api_id = ? AND cvr.workspace_id = ?
       ORDER BY cvr.id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      [apiId, workspaceId]
    );

    return rows.map((r) => this._formatValidationResult(r));
  }

  _formatRevision(row) {
    let parsedContent = row.specification_content;
    if (typeof parsedContent === 'string') {
      try {
        parsedContent = JSON.parse(parsedContent);
      } catch (_e) {}
    }

    let parsedCatalog = row.operations_catalog;
    if (typeof parsedCatalog === 'string') {
      try {
        parsedCatalog = JSON.parse(parsedCatalog);
      } catch (_e) {}
    }

    return {
      ...row,
      specification_content: parsedContent,
      operations_catalog: parsedCatalog,
    };
  }

  _formatValidationResult(row) {
    let parsedFindings = row.findings;
    if (typeof parsedFindings === 'string') {
      try {
        parsedFindings = JSON.parse(parsedFindings);
      } catch (_e) {
        parsedFindings = [];
      }
    }

    return {
      ...row,
      findings: parsedFindings,
      findings_truncated: Boolean(row.findings_truncated),
    };
  }
}

const contractRepository = new ContractRepository();

module.exports = {
  ContractRepository,
  contractRepository,
};

