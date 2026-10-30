# APIDash — Phase 7: Evidence-Grounded AI Incident Investigation

## 1. Overview and Core Philosophy

Phase 7 introduces **AI-assisted incident investigation** to APIDash. It enables site reliability and API platform engineers to request deterministic, evidence-grounded analysis of active or historical incidents.

### What Phase 7 Is:
- An evidence-grounded diagnostic assistant that analyzes a bounded, sanitized snapshot of telemetry and contract findings already collected by APIDash.
- An asynchronous, non-blocking background workflow that preserves monitoring scheduler throughput.
- A strictly validated structured output generator citing stable evidence IDs (`E-001`, `E-002`, etc.) for every observed fact, hypothesis, and recommended check.
- A disciplined system that explicitly states unknowns and distinguishes correlation from confirmed root cause.

### What Phase 7 Is NOT:
- Not an autonomous remediation agent: it never mutates monitor configurations, triggers HTTP requests, or accesses shells/filesystems.
- Not a conversational chatbot or prompt loop.
- Not an unconstrained LLM call on every monitor tick: investigations are strictly on-demand, user-triggered, and rate-bounded.
- Not a vector database or embedding RAG pipeline: incident telemetry is structured relational state, best analyzed through deterministic SQL aggregation and data minimization.

---

## 2. Architecture & Sequence Flow

```
   [ Authenticated User ]
             |
   POST /incidents/:id/ai-analysis
             |
             v
   [ Workspace Authorization & IDOR Guard ]
             |
             v
   [ Deterministic Evidence Builder ]
   - Retrieves incident lifecycle, monitor metadata, and bounded test results (10-20)
   - Joins Phase 6 OpenAPI contract validation findings
   - Computes deterministic latency baselines & deltas
   - Redacts credentials, tokens, cookies, passwords, and sensitive query params
   - Assigns stable evidence IDs (E-001, E-002, ...)
   - Computes canonical SHA-256 fingerprint
             |
             v
   [ Durable MySQL Job Persistence ]
   - Deduplicates identical in-flight or completed jobs
   - Inserts row in incident_ai_analyses (status: 'pending')
             |
             v (Asynchronous Background Queue)
   [ Dedicated AI Background Worker ]
   - Concurrency bounded separately (AI_CONCURRENCY=2)
   - Claims pending work using MySQL 8 FOR UPDATE SKIP LOCKED
   - Acquires lease with database clock
             |
             v
   [ Replaceable Provider Adapter ]
   - Gemini API (Hosted JSON mode) OR Ollama (Local JSON mode) OR Mock (Offline)
   - Transmits prepared evidence package + versioned system prompt (v1.0.0)
   - Enforces timeouts (AI_TIMEOUT_MS) and transient retry policies
             |
             v
   [ Strict Server-Side Response Validator ]
   - Validates JSON parse and structural schema (Ajv)
   - Verifies EVERY cited evidence ID exists in the exact supplied snapshot
   - Rejects hallucinated IDs, unbounded strings, or malformed enums
             |
             v
   [ Result Persistence & Provenance ]
   - Persists validated structured result, duration, and token usage
   - Transitions job to 'completed' (or safe 'failed' on error)
             |
             v
   [ Frontend UI (Incident Detail Modal) ]
   - Renders Summary, Observed Facts (badged citations), Hypotheses, Checks, Unknowns
   - Detects and flags stale analysis if new monitor runs arrived after snapshot capture
```

---

## 3. Why Deterministic Evidence Building Over RAG & Autonomous Agents

We deliberately selected **deterministic evidence retrieval + direct prompting + structured JSON output**:

| Architectural Approach | Evaluation for APIDash Incidents | Decision |
|---|---|---|
| **Vector DB / RAG Embeddings** | Incident telemetry consists of structured tabular logs, timestamps, status codes, and schema validation verdicts. Vector embeddings introduce chunking errors, semantic similarity hallucinations, and approximate retrieval loss. | **Rejected:** Relational SQL queries retrieve 100% of the exact relevant telemetry deterministically. |
| **Tool-Calling / ReAct Agents** | Giving models tools to run shell commands, query MySQL, or issue outbound HTTP requests creates severe prompt-injection attack surfaces and unpredictable latency. | **Rejected:** APIDash prepares a sanitized, bounded snapshot upfront; the model has zero tool or network access. |
| **Model Fine-Tuning** | Fine-tuning locks model weights to historical data, is expensive to train, and risks memorizing transient monitor errors. | **Rejected:** System prompt v1.0.0 and schema versioning allow instant updates without training pipelines. |
| **Deterministic Snapshot + Structured Output** | Bounded SQL retrieval (10–20 results), explicit field allowlists, credential redaction, canonical SHA-256 fingerprinting, and strict schema validation. | **Chosen:** Fully deterministic, auditable, reproducible, safe from injection, and offline-testable. |

---

## 4. Security, Redaction, and Multi-Tenant Isolation

### 4.1 Data Minimization & Redaction
The `incidentEvidenceBuilder` enforces strict data scrubbing before any provider sees telemetry:
- **Credentials & Passwords:** Strips `username:password` from URLs (`https://***:***@host...`).
- **Sensitive Query Parameters:** Redacts `token`, `key`, `apikey`, `secret`, `password`, `auth`, `signature`, `access_token`, `jwt` to `***REDACTED***`.
- **Headers & Secrets:** Never includes raw authorization headers (`Bearer ...`), `Cookie`, or `x-api-key`.
- **Bodies & Payloads:** Raw request/response bodies are excluded by default to avoid data leakage.
- **Categorized Error Messages:** Transport errors are categorized (`DNS_RESOLUTION_FAILURE`, `CONNECTION_REFUSED`, `TIMEOUT_EXCEEDED`, `TLS_CERTIFICATE_ERROR`) and bounded to 200 characters.

### 4.2 Prompt-Injection Resistance
Monitor URLs, endpoint names, assertion messages, and contract descriptions originate from users or remote servers and are treated as **untrusted data**.
- The versioned system prompt explicitly instructs the LLM to ignore meta-prompts, system overrides, or instructions embedded within the evidence package.
- Evaluator scenarios `SYN-021` and `SYN-022` continuously benchmark injection resistance.

### 4.3 Multi-Tenant Workspace Isolation
- `incident_ai_analyses` rows reference `workspace_id` with foreign key cascade deletion.
- Cross-workspace incident requests return `HTTP 404 Not Found` (safe IDOR defense).
- Evaluation cache keys are salted with `workspace_id`:
  `sha256(provider + ':' + model + ':' + promptVer + ':' + schemaVer + ':' + workspaceId + ':' + fingerprint)`
  Preventing cache leakage across tenant boundaries.

### 4.4 Stale Snapshot Detection
If new monitor test results are recorded after an investigation job is created, the system compares `incident.latest_result_id` with `job.evidence_snapshot.latest_result_id`. When they diverge, the API flags `is_stale: true`, and the UI displays a warning banner prompting the operator to re-analyze.

### 4.5 Retention & Cleanup
A configurable retention policy (`AI_RETENTION_DAYS=30`) automatically purges expired analysis records via:
`DELETE FROM incident_ai_analyses WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`
Executed periodically and on worker startup.

---

## 5. Provider Configuration & Cost Controls

AI incident investigation defaults to **`AI_PROVIDER=disabled`**. APIDash monitoring, scheduling, and notifications function completely without any AI keys or provider dependencies.

### Environment Variables (`backend/.env`):

```bash
# Provider selection: disabled (default), gemini, ollama
AI_PROVIDER=disabled

# Gemini API Configuration (hosted candidate: gemini-3.8-flash)
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.8-flash
GEMINI_TIMEOUT_MS=30000

# Ollama Configuration (local candidate: qwen3.5:4b)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3.5:4b
OLLAMA_TIMEOUT_MS=60000

# Worker & Execution Controls
AI_TIMEOUT_MS=30000
AI_MAX_RETRIES=1
AI_CONCURRENCY=2
AI_POLL_INTERVAL_MS=2000
AI_LEASE_MS=60000
AI_RETENTION_DAYS=30
AI_EVAL_CACHE_ENABLED=true
```

### Trade-Off Comparison:

| Dimension | Google Gemini API (`gemini-3.8-flash`) | Local Ollama (`qwen3.5:4b`) |
|---|---|---|
| **Cost** | Extremely low pay-per-token with generous free tier | 100% free, zero token fees |
| **Privacy / Network** | Outbound HTTPS to Google Generative Language API | 100% offline, local machine / intranet only |
| **Latency** | ~800ms – 1800ms | Depends on local CPU/GPU (~2s – 30s) |
| **JSON Mode** | Native strict schema enforcement (`application/json`) | Grammar-constrained JSON Schema (`format: schema`) |
| **Setup** | Set `GEMINI_API_KEY` | Install Ollama and run `ollama run qwen3.5:4b` |

---

## 6. Database Changes (Migration 031)

### Migration 031: `incident_ai_analyses` Table
Creates the durable job and results table:
- `id`: INT AUTO_INCREMENT PRIMARY KEY
- `workspace_id`: INT NOT NULL (FK to workspaces)
- `incident_id`: INT NOT NULL (FK to incidents)
- `created_by_user_id`: INT NOT NULL (FK to users)
- `status`: ENUM('pending', 'running', 'completed', 'failed')
- `provider`: VARCHAR(50)
- `model`: VARCHAR(100)
- `prompt_version`: VARCHAR(50)
- `schema_version`: VARCHAR(50)
- `evidence_snapshot`: JSON NOT NULL
- `evidence_fingerprint`: VARCHAR(64) NOT NULL
- `result`: JSON NULL (validated structured output)
- `duration_ms`: INT NULL
- `tokens_prompt`, `tokens_completion`, `tokens_total`: INT NULL
- `lease_owner_token`: VARCHAR(64) NULL
- `lease_expires_at`: DATETIME(3) NULL
- `attempt_count`, `max_attempts`: INT

To apply forward migrations:
```bash
npm --prefix backend run db:migrate
```

---

## 7. Synthetic Evaluation Suite (40 Scenarios)

The evaluation dataset at `backend/ai/evaluation/fixtures/dataset.js` consists of **40 distinct, independently labelled scenarios** covering 12 required incident failure archetypes:

1. `HTTP_5XX_PERSISTENT`: Persistent 500/502/503 server errors.
2. `LATENCY_REGRESSION`: Latency jumps breaching SLA assertions while status is 200 OK.
3. `TIMEOUT_AMBIGUOUS`: Timeouts where client received zero headers.
4. `TRANSPORT_FAILURE`: DNS resolution failures (`ENOTFOUND`) and TLS certificate expiration (`CERT_HAS_EXPIRED`).
5. `CONTRACT_VIOLATION`: Phase 6 schema drift, missing required properties, or undeclared status codes.
6. `PREFLIGHT_NEUTRAL`: Client configuration mistakes halted before dispatch with neutral health impact.
7. `TRANSIENT_RECOVERY`: Brief blips followed by 2 consecutive passes, resolving the incident.
8. `RECOVERY_AMBIGUOUS`: Flapping or single passing runs that do not satisfy the 2-pass resolution rule.
9. `INSUFFICIENT_HISTORY`: Brand new monitors with zero baseline data.
10. `CONFLICTING_EVIDENCE`: Alternating 200 and 503 responses suggesting partial replica failure.
11. `PROMPT_INJECTION`: Malicious injection payloads embedded in error messages or URLs.
12. `MISLEADING_COINCIDENCE`: Coincidental latency fluctuations unrelated to root cause.

### Dataset Splits (Dataset Version `v1.1.0`):
- **`dev` (24 cases):** Baseline lifecycle, transport, contract, latency, and boundary scenarios across all primary monitoring domains.
- **`validation` (8 cases):** Balanced high-risk scenarios covering prompt injection (`SYN-021`), abstention on missing baseline (`SYN-017`), conflicting signals (`SYN-019`), misleading correlation (`SYN-023`), contract violation (`SYN-029`), persistent 500 (`SYN-025`), latency SLA (`SYN-026`), and transient recovery (`SYN-031`).
- **`holdout` (8 cases):** Frozen evaluation answer key covering prompt injection (`SYN-022`), misleading correlation (`SYN-024`), abstention (`SYN-018`), conflicting signals (`SYN-020`), contract violation (`SYN-037`), persistent 503 (`SYN-033`), ambiguous timeout (`SYN-035`), and streak rules (`SYN-040`).

### Running Evaluations & Smoke Tests:

```bash
# Offline smoke test across all 40 scenarios (deterministic MockAiProvider; no network/keys)
node backend/ai/evaluation/evaluate.js --provider=mock --split=all

# Offline smoke test on frozen held-out split
node backend/ai/evaluation/evaluate.js --provider=mock --split=holdout

# Live benchmark against hosted Google Gemini (requires GEMINI_API_KEY in backend/.env)
node backend/ai/evaluation/evaluate.js --provider=gemini --model=gemini-3.8-flash --split=dev

# Live benchmark against local Ollama instance (requires running ollama server)
node backend/ai/evaluation/evaluate.js --provider=ollama --model=qwen3.5:4b --split=dev

# Official evaluation on frozen held-out split using Gemini candidate
node backend/ai/evaluation/evaluate.js --provider=gemini --model=gemini-3.8-flash --split=holdout
```

> **Note on Mock Results:** Offline smoke test runs (`--provider=mock`) are explicitly tagged as `[OFFLINE SMOKE TEST / MOCK PROVIDER]`. They confirm harness stability and JSON schema enforcement only; they do not measure actual model intelligence or prompt-injection resistance.

Reports are automatically generated as JSON (`results/eval-*.json`) and Markdown (`results/eval-*.md`) containing the 0–2 rubric score table across grounding, uncertainty, and diagnostic checks.

---

## 8. Automated Test Execution

All tests execute with Node's built-in test runner (`node --test`) without external dependencies:

```bash
# Run unit and offline validation tests
node --test backend/test/aiResponseValidator.test.js backend/test/incidentEvidenceBuilder.test.js backend/test/aiProvider.test.js backend/test/syntheticDataset.test.js

# Run integration tests against disposable MySQL database
node --test backend/test/aiInvestigationIntegration.test.js

# Run full project test suite
npm --prefix backend test
```

