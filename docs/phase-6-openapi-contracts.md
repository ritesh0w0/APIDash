# APIDash — Phase 6: Versioned OpenAPI Contract Management and Runtime Validation

## 1. Overview and Core Philosophy

Phase 6 evolves APIDash from simple HTTP availability and synthetic assertion monitoring into contract-driven API quality assurance.

A contract tells APIDash what behavior is **expected**. A monitor observes what behavior **actually occurs**. Phase 6 connects the two securely, deterministically, and immutably:
- **Contract as Source of Truth:** OpenAPI specifications (OpenAPI 3.0.x, 3.1.x, and 3.2.x in JSON or YAML) are imported and stored as immutable revisions.
- **Explicit Pinning:** Monitors bind to an exact contract revision and operation. Deploying a new revision never mutates existing monitor bindings.
- **Preflight Request Validation:** Validates outbound monitor configuration before dispatch. If a monitor's method, path, parameters, or payload violate the contract, the dispatch is halted with **zero outbound network calls**.
- **Response Contract Validation:** Validates real upstream HTTP responses against the operation's declared status codes, headers, Content-Type, and JSON schemas.
- **Deterministic Incident Integration:** Preflight contract configuration errors are classified with **neutral health impact** (`neutral`), resetting failure streaks without opening spurious outage incidents or resolving existing real outages. Upstream contract non-conformance is classified as **unhealthy**, driving the Phase 5 incident lifecycle.

---

## 2. Supported Dialects & Parsing Pipeline

### Dialect Support
APIDash supports OpenAPI specifications in either JSON or YAML:
- **OpenAPI 3.0.0 – 3.0.4**
- **OpenAPI 3.1.0 – 3.1.2**
- **OpenAPI 3.2.x**

Legacy Swagger 2.0 specifications are rejected with a clear migration error.

### Pipeline Stages
1. **Size Ceiling:** Specifications exceeding 1 MiB (1,048,576 bytes) are rejected immediately with HTTP 400 before parsing.
2. **YAML Alias Explosion Guard:** For YAML specs, a custom AST token scanner counts YAML aliases (`*aliasName`). If alias references exceed 100, parsing is rejected to prevent Billion Laughs / entity expansion denial-of-service.
3. **Reference Security Scanner:** Before dereferencing, the AST is recursively inspected for prohibited external and remote `$ref` pointers.
4. **Structural Validation & In-Memory Dereferencing:** Powered by `@scalar/openapi-parser`. Validates structural compliance and safely dereferences local internal `$ref` pointers (e.g. `#/components/schemas/...`).
5. **Canonical Hashing & Deduplication:** Calculates a deterministic canonical SHA-256 hash across sorted object keys. If the hash matches an existing revision in the contract, the existing revision is returned without duplicating database storage.
6. **Operations Catalog Extraction:** Pre-extracts all declared paths and HTTP methods into an indexed operations catalog (`operation_id`, `method`, `path_template`, `summary`, `tags`, `request_body_schema`, `parameters_schema`).

---

## 3. Security Architecture

### Strict Prohibited Reference Rules
External reference resolution is prohibited:
- **Forbidden Reference Types:**
  - Remote HTTP/HTTPS URLs (`http://...`, `https://...`)
  - File system schemes (`file://...`)
  - Relative or parent traversal paths (`../...`, `./...`)
  - Cross-document URIs
- **Allowed Reference Types:**
  - Local internal document pointers only: `#/components/...` or `#/paths/...`
- **Zero Network/Disk I/O:** The parser issues zero external HTTP requests and performs zero file-system lookups during specification validation or dereferencing.

### Multi-Tenant Workspace Isolation & Foreign-Key Integrity
- All contracts, revisions, bindings, and validation findings belong strictly to a workspace.
- Cross-tenant IDOR protection: A user in Workspace A cannot bind an API to a contract in Workspace B, view contract revisions of Workspace B, or query validation results belonging to another workspace.
- Composite foreign keys enforce tenant boundaries at the database engine level:
  - `(api_id, workspace_id)` in `api_contract_bindings` references `apis(id, workspace_id)`.
  - `(contract_id, workspace_id)` in `api_contract_bindings` references `api_contracts(id, workspace_id)`.
  - `(revision_id, contract_id)` in `api_contract_bindings` references `api_contract_revisions(id, contract_id)`.
  - Analogous composite foreign keys protect `contract_validation_results`.
- Unassigned legacy monitors (`workspace_id IS NULL`) cannot be bound to contracts until explicitly assigned to a workspace.

---

## 4. Versioned Immutable Revisions & Monitor Binding

### Immutable Revisions
- Every imported specification creates an immutable row in `api_contract_revisions`.
- Revision numbers are sequential per contract: `1, 2, 3, ...`.
- Revisions store the raw specification, dereferenced specification, extracted operations catalog, and canonical SHA-256 digest.
- Once created, a revision is **never updated**. Modifications require publishing a new revision.

### Explicit Monitor Pinning
- Monitors bind to a contract via `api_contract_bindings`.
- A binding explicitly pins a monitor (`api_id`) to a specific `contract_revision_id` and `operation_path` + `operation_method`.
- **Immutability Guarantee:** Publishing revision $N+1$ does **not** update existing bindings pinned to revision $N$. Contract upgrades require explicit operator rebinding.

---

## 5. Runtime Validation Pipeline

Runtime contract validation is seamlessly integrated into `backend/services/monitoringCoordinator.js`:

```
                 [ Monitor Execution Triggered ]
                                |
               Has Active Contract Binding?
              /                            \
           [YES]                           [NO]
             |                               |
    [ Request Preflight ]                    |
    Method, Path, Params, Body               |
             |                               |
          Valid?                             |
         /      \                            |
      [NO]      [YES]                        |
       |          |                          |
   HALT (0 I/O)   +------> [ Safe HTTP Dispatch ]
   Verdict:                (SSRF Protected, Pinned IPs)
   'preflight_rejected'              |
   Health: 'neutral'                 v
                         [ Response Contract Validation ]
                         Status, Headers, Content-Type, Body
                                     |
                                  Verdict:
                          'passed' / 'failed' / 'partial'
                                     |
                                     v
                       [ Evaluate Health & Incident ]
```

### 1. Request Preflight Validation
Before the outbound HTTP request is dispatched:
- **HTTP Method Matching:** Verifies the monitor's HTTP method matches the bound operation method.
- **Path Template Matching:** Validates the monitor URL against the OpenAPI path template (e.g. `/users/{userId}`), accounting for server base-paths.
- **Parameter Validation:**
  - Verifies all declared `required: true` path, query, and header parameters are present.
  - Validates parameter values against declared type schemas (e.g. integer, UUID).
- **Request Body Validation:** If the operation specifies a JSON request body schema, the monitor's configured payload is validated against it using Ajv.
- **Preflight Failure Action:**
  - **Zero outbound network calls** are made.
  - Result outcome: `error`.
  - Error type: `CONTRACT_REQUEST_INVALID`.
  - Verdict: `preflight_rejected`.
  - Health impact: `neutral`.

### 2. Response Contract Validation
After the HTTP response is received from upstream:
- **Status Code Matching Precedence:**
  1. Exact status code match (e.g. `200`).
  2. Range match (e.g. `2XX`).
  3. Default response fallback (`default`).
  4. Undeclared status code: produces finding `"Undeclared HTTP status code {status}"`.
- **204 No Content / 304 Not Modified Checks:** Validates that response bodies are empty.
- **Content-Type Validation:** Matches upstream `Content-Type` header against declared response media types (ignoring parameters like `; charset=utf-8`).
- **Body Schema Validation:**
  - Evaluates response body against the declared schema using cached compiled Ajv validators.
  - **OpenAPI 3.0.x:** Ajv Draft 7 with native `nullable: true`.
  - **OpenAPI 3.1.x / 3.2.x:** Ajv2020 (`ajv/dist/2020`) supporting Draft 2020-12 constructs (`type: ["string", "null"]`).
- **Inspection Limit (64 KB):**
  - If the response body exceeds 64 KB, deep schema validation is skipped to protect memory and event loop responsiveness.
  - If status code and headers match, the verdict is recorded as `partial` with finding code `INSPECTION_LIMIT_EXCEEDED`.
- **Bounded Findings:** Findings are capped at 20 items per execution to prevent database bloating, with a `has_more` truncation indicator.

---

## 6. Phase 5 Incident Integration: Neutral Health Impact

APIDash distinguishes client-side monitor configuration mistakes from upstream operational outages:

| Execution Outcome | Verdict | Health Impact | Consecutive Streaks | Incident Transition |
|---|---|---|---|---|
| HTTP 200, Assertions Pass, Contract Pass | `passed` | `healthy` | Healthy +1, Unhealthy = 0 | 2 consecutive passes resolve active incident. |
| HTTP 500 or Assertions Fail or Contract Fail | `failed` | `unhealthy` | Unhealthy +1, Healthy = 0 | 2 consecutive failures open active incident. |
| Network Timeout / DNS Refused | `error` | `unhealthy` | Unhealthy +1, Healthy = 0 | 2 consecutive failures open active incident. |
| **Request Preflight Rejected** | `preflight_rejected` | **`neutral`** | **Healthy = 0, Unhealthy = 0** | **None (leaves open incidents open, opens no new incident)** |

### Neutral Health State Transition Invariants:
1. **Streak Reset:** When `health_impact = 'neutral'`, both `consecutive_healthy` and `consecutive_unhealthy` are reset to 0 in `monitor_health_states`.
2. **No Bridge Across Disjoint Outages:** A misconfigured monitor cannot bridge two distinct upstream outages into a single continuous incident.
3. **No False Resolutions:** A misconfigured monitor never resolves an ongoing real incident.
4. **No Spurious Incidents:** Preflight failures never open new incidents or dispatch false alarm outbox notifications.

---

## 7. Database Migrations (022 – 030)

The database schema is upgraded using forward-only migrations executed by `backend/scripts/migrate.js`:

### Migration 022: `api_contracts`
- Defines contract entities scoped to `workspace_id`.
- Columns: `id`, `workspace_id`, `name`, `description`, `created_at`, `updated_at`.

### Migration 023: `api_contract_revisions`
- Stores immutable revisions.
- Columns: `id`, `contract_id`, `revision_number`, `spec_raw`, `spec_dereferenced`, `spec_sha256`, `operations_catalog` (JSON), `created_at`.
- Unique key: `(contract_id, revision_number)`.

### Migration 024: `api_contract_bindings`
- Binds a monitor to an explicit contract revision and operation.
- Columns: `id`, `api_id`, `contract_id`, `revision_id`, `operation_path`, `operation_method`, `created_at`, `updated_at`.
- Unique key: `(api_id)`.

### Migration 025: `contract_validation_results`
- Stores 1:1 validation findings linked to `test_results`.
- Columns: `id`, `test_result_id`, `api_id`, `contract_id`, `revision_id`, `verdict` (`'passed'`, `'failed'`, `'partial'`, `'preflight_rejected'`, `'not_evaluated'`), `findings` (JSON), `created_at`.
- Unique key: `(test_result_id)`.

### Migration 026: Contract Archival & Composite Key
- Adds `archived_at DATETIME NULL` to `api_contracts` to support soft-archival when historical validation findings exist.
- Adds `UNIQUE KEY uk_contracts_id_workspace (id, workspace_id)` to enable composite foreign key referencing.

### Migration 027: API Composite Key
- Adds `UNIQUE KEY uk_apis_id_workspace (id, workspace_id)` to `apis` to guarantee database-level tenant isolation.

### Migration 028: Revision Composite Key
- Adds `UNIQUE KEY uk_revisions_id_contract (id, contract_id)` to `api_contract_revisions` to prevent cross-contract revision binding.

### Migration 029: Composite Foreign Keys on Bindings
- Enforces composite foreign keys:
  - `fk_bindings_api_workspace`: `(api_id, workspace_id) REFERENCES apis(id, workspace_id) ON DELETE CASCADE`
  - `fk_bindings_contract_workspace`: `(contract_id, workspace_id) REFERENCES api_contracts(id, workspace_id) ON DELETE RESTRICT`
  - `fk_bindings_revision_contract`: `(revision_id, contract_id) REFERENCES api_contract_revisions(id, contract_id) ON DELETE RESTRICT`

### Migration 030: Composite Foreign Keys & Retention on Validation Results
- Drops destructive cascade keys and enforces audit retention:
  - `fk_cvr_contract_workspace`: `(contract_id, workspace_id) REFERENCES api_contracts(id, workspace_id) ON DELETE RESTRICT`
  - `fk_cvr_revision_contract`: `(revision_id, contract_id) REFERENCES api_contract_revisions(id, contract_id) ON DELETE RESTRICT`
  - `fk_cvr_api_workspace`: `(api_id, workspace_id) REFERENCES apis(id, workspace_id) ON DELETE CASCADE`
- Updates `verdict` ENUM to include `'preflight_rejected'`.

---

## 8. Workspace REST Endpoints & Role Model

The workspace permission model follows the database schema (`role ENUM('owner', 'member')`). Mutating contract routes require workspace ownership (`requireWorkspaceOwner`), returning HTTP 403 Forbidden for members. Non-members receive HTTP 404 Not Found to prevent workspace enumeration.

| Method | Endpoint | Authorization | Description |
|---|---|---|---|
| `GET` | `/api/workspaces/:workspaceId/contracts` | Member / Owner | List all non-archived contracts in the workspace with revision counts. |
| `POST` | `/api/workspaces/:workspaceId/contracts` | Owner Only | Create a contract and initial revision from OpenAPI JSON/YAML. |
| `GET` | `/api/workspaces/:workspaceId/contracts/:contractId` | Member / Owner | Get contract details with latest revision and operations. |
| `DELETE` | `/api/workspaces/:workspaceId/contracts/:contractId` | Owner Only | Archive contract (if validation history exists) or delete (if clean). Rejects with 409 Conflict if active monitor bindings exist. |
| `GET` | `/api/workspaces/:workspaceId/contracts/:contractId/revisions` | Member / Owner | List all immutable revisions for a contract. |
| `POST` | `/api/workspaces/:workspaceId/contracts/:contractId/revisions` | Owner Only | Publish a new immutable revision. |
| `GET` | `/api/workspaces/:workspaceId/contracts/:contractId/revisions/:revisionNumber` | Member / Owner | Get a specific revision and operations catalog. |
| `GET` | `/api/workspaces/:workspaceId/apis/:apiId/contract-binding` | Member / Owner | Get the active contract binding for a monitor. |
| `PUT` | `/api/workspaces/:workspaceId/apis/:apiId/contract-binding` | Owner Only | Bind or update a monitor to a contract revision & operation. Rejects archived contracts and cross-workspace IDs. |
| `DELETE` | `/api/workspaces/:workspaceId/apis/:apiId/contract-binding` | Owner Only | Remove contract binding from a monitor. |
| `GET` | `/api/workspaces/:workspaceId/apis/:apiId/contract-results` | Member / Owner | Query historical contract validation results. |
| `GET` | `/api/workspaces/:workspaceId/test-results/:resultId/contract-result` | Member / Owner | Query contract validation findings for a specific test run. |

---

## 9. Verification & Automated Test Coverage

The test suite covers unit, integration, database migration, and security paths using Node's built-in test runner (`node --test`):

- **Unit Tests:**
  - `backend/test/openapiParser.test.js`: OpenAPI 3.0/3.1/3.2 parser, YAML alias explosion protection, remote reference security, canonical SHA-256 deduplication.
  - `backend/test/contractValidation.test.js`: Path template matching, parameter extraction, preflight checks, response contract validation, 204 No Content, 64 KB truncation, Ajv Draft 7 vs Ajv2020.
- **Integration Tests:**
  - `backend/test/contractIntegration.test.js`: Preflight rejection halting dispatch with 0 outbound calls, neutral health state transitions, binding immutability across revisions, cross-workspace isolation.
  - `backend/test/contractMigration.test.js`: Fresh install migrations 001–030 on disposable MySQL database, upgrade path 001–021 to 022–030 preserving unowned monitors.
  - `backend/test/phase6IntegrityAndAuthorization.test.js`: Comprehensive verification of:
    1. Contract deletion vs archival, active binding conflict (409), validation history retention (`ON DELETE RESTRICT`), and unbinding lifecycle.
    2. Database composite foreign keys enforcing cross-workspace isolation, foreign revision rejection, and unassigned monitor rejection.
    3. Workspace role enforcement (`owner` vs `member`), read-only member access, and safe 404 IDOR defense for outsiders.
- **Total Test Suite:** 161 automated tests passing with zero failures.

