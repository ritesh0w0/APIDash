# 11. AI Incident Investigation Subsystem

APIDash incorporates an optional, out-of-band **AI Incident Investigation Subsystem**. When an incident occurs, users can request an automated root-cause analysis. The platform packages diagnostic telemetry into an evidence snapshot (`[E-001]`, `[E-002]`...) and queries an LLM provider to generate structured hypotheses and actionable remediation checks.

> [!IMPORTANT]
> **Production Policy:** All external AI providers remain strictly **user-triggered and out-of-band**. AI is never invoked automatically on monitoring failure and never blocks the monitoring hot path. When disabled (`AI_PROVIDER=disabled`), monitoring operates with 100% deterministic fidelity.

---

## 🔬 Subsystem Architecture

```mermaid
sequenceDiagram
    autonumber
    participant UI as User Interface
    participant API as Express API Server
    participant DB as MySQL Database
    participant Worker as AI Worker Daemon
    participant Fallback as FallbackAiProvider
    participant Primary as Primary LLM (Groq)
    participant Secondary as Fallback LLM (OpenRouter / NVIDIA)

    UI->>API: POST /api/workspaces/:ws/incidents/:id/ai-analysis
    API->>API: Build sanitized evidence snapshot ([E-001], [E-002]...)
    API->>DB: INSERT INTO incident_ai_analyses (status: pending)
    API-->>UI: 201 Created (Analysis job queued)

    loop Polling Loop (Every 2 Seconds)
        Worker->>DB: Claim pending job (FOR UPDATE SKIP LOCKED)
        Worker->>Fallback: generateAnalysis(evidenceSnapshot, options)
        
        alt Primary Provider Succeeds
            Fallback->>Primary: POST /chat/completions (openai/gpt-oss-20b)
            Primary-->>Fallback: 200 OK with Structured JSON
        else Primary Fails (429 / 5xx / Timeout / Schema Failure)
            Note over Fallback: Preserve failure diagnostic & update ProcessRateLimitTracker
            Fallback->>Secondary: POST /chat/completions (nvidia/nemotron-3.5-lightning:free via OpenRouter)
            Secondary-->>Fallback: 200 OK with Structured JSON
        end

        Worker->>Worker: Validate JSON against responseJsonSchema & verify citations
        Worker->>DB: UPDATE incident_ai_analyses SET status: completed, provider, model, result
    end

    UI->>API: GET /api/workspaces/:ws/incidents/:id/ai-analysis
    API-->>UI: 200 OK (Displays winning provider, model, duration, facts, hypotheses)
```

---

## 🔀 Resilient Dual-Provider Fallback Orchestrator

The `FallbackAiProvider` (`backend/services/aiProviderService.js`) orchestrates multi-provider resilience without introducing unnecessary external infrastructure:

* **Primary Provider:** Groq
  - **Model:** `openai/gpt-oss-20b`
  - **Base URL:** `https://api.groq.com/openai/v1`
  - **Characteristics:** Ultra-low latency inference (~1.7s–2.0s) with OpenAI-compatible chat completions.
* **Fallback Gateway:** OpenRouter
  - **Underlying Model:** NVIDIA Nemotron 3.5 Lightning Free
  - **Model Identifier:** `nvidia/nemotron-3.5-lightning:free`
  - **Base URL:** `https://openrouter.ai/api/v1`
  - **Role:** OpenRouter serves as the unified API gateway providing access to NVIDIA's model with reasoning control (`reasoning: { effort: 'none' }` for deterministic fast JSON output).

### Error Classification & Failover Matrix

| Error Condition | HTTP Code / Classification | Failover Eligible? | Primary Action | Fallback Action |
| :--- | :--- | :--- | :--- | :--- |
| **Rate Limiting** | HTTP `429` (`AI_RATE_LIMIT`) | **Yes** | Updates `ProcessRateLimitTracker` | Dispatches immediately to OpenRouter / NVIDIA |
| **Server Errors** | HTTP `500` / `502` / `503` / `504` | **Yes** | Records diagnostic | Dispatches immediately to OpenRouter / NVIDIA |
| **Timeouts** | `AI_TIMEOUT` (exceeded timeout budget) | **Yes** | Records diagnostic | Dispatches immediately to OpenRouter / NVIDIA |
| **Network Failure**| `AI_NETWORK_ERROR` (connection refused/reset)| **Yes** | Records diagnostic | Dispatches immediately to OpenRouter / NVIDIA |
| **Schema/Citation Failure** | HTTP `422` / `INVALID_AI_OUTPUT` | **Yes** | Records validation error | Dispatches immediately to OpenRouter / NVIDIA |
| **Authentication Error** | HTTP `401` / `403` | **Yes** | Preserves config diagnostic | Dispatches to OpenRouter / NVIDIA |
| **Malformed Snapshot** | HTTP `400` (`INVALID_EVIDENCE_SNAPSHOT`)| **No** | Rejects locally | Neither provider is contacted |
| **Dual Exhaustion**| Both providers fail | **Terminal** | Throws `AI_DUAL_PROVIDER_EXHAUSTION` | Marks job non-retryable; safe user message without leaking keys |

### Fast-Path In-Memory Circuit Breaker

`ProcessRateLimitTracker` monitors rate limit response headers (`x-ratelimit-remaining-tokens`, `x-ratelimit-reset-tokens`, `retry-after`). When the primary Groq provider is rate-limited:
1. `recordRateLimit()` marks the primary provider blocked until the reset timestamp expires.
2. Subsequent investigations within the reset window automatically **fast-path** to OpenRouter / NVIDIA without incurring failed network round-trips to Groq.
3. Upon expiration of the block window, traffic naturally probes Groq first.

---

## 🛡️ Anti-Hallucination & Evidence Grounding

To prevent LLMs from generating speculative explanations, APIDash enforces a strict verification pipeline:

1. **Evidence Snapshot Generation (`incidentEvidenceBuilder.js`):**
   - Telemetry is assembled into immutable, numbered observation tokens:
     * `[E-001]`: Incident lifecycle state, duration, consecutive failure streak.
     * `[E-002]`: Monitor HTTP configuration (method, sanitized URL).
     * `[E-003]`: Execution telemetry (status code, latency, error category).
2. **Strict JSON Schema Enforcement (`aiResponseValidator.js`):**
   - Both Groq and OpenRouter outputs are validated against `responseJsonSchema`.
   - Every hypothesis must include `supporting_evidence_ids` referencing real observation tokens.
3. **Programmatic Citation Verification:**
   - Any response citing non-existent evidence tags (e.g., hallucinated `[E-999]`) is rejected with `INVALID_AI_OUTPUT`.

---

## 🔒 Diagnostic Privacy & Sanitization

Before evidence leaves the VM to either Groq or OpenRouter:
- **Authorization Headers:** Stripped completely (`Authorization`, `Proxy-Authorization`).
- **URL Credentials:** Converted to `https://***:***@domain.com`.
- **Sensitive Query Parameters:** Redacted (`token`, `key`, `secret`, `password`, `apiKey`).
- **Client Sanitization:** When returning investigation records to the web browser, `serializeAnalysisForClient()` strips worker lease tokens (`lease_owner_token`, `lease_expires_at`) and redacts API keys matching `gsk_*` and `sk-or-*`.
