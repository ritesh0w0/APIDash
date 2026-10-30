# 11. AI Incident Investigation Subsystem

APIDash incorporates an optional, out-of-band **AI Incident Investigation Subsystem**. When an incident occurs, the platform can automatically synthesize diagnostic telemetry, package it into an evidence snapshot, and query an LLM to generate structured hypotheses and remediation steps.

> [!IMPORTANT]
> **Production Policy:** In accordance with production design requirements, all external AI providers remain **disabled by default** (`AI_PROVIDER=disabled`). Incident monitoring, contract validation, and alerting operate with 100% deterministic fidelity without requiring AI. When enabled, AI operations run strictly out-of-band and never impede core monitoring pipelines.

---

## 🔬 Subsystem Architecture

```mermaid
sequenceDiagram
    autonumber
    participant Inc as Incident Service
    participant DB as MySQL Incident AI Analyses
    participant Worker as AI Worker Daemon
    participant Fallback as Fallback AI Provider
    participant Primary as Primary LLM Groq
    participant Secondary as Fallback LLM OpenRouter

    Inc->>DB: INSERT INTO incident_ai_analyses<br/>status PENDING with evidence package
    Note over Inc: Non-blocking - HTTP execution completes immediately

    loop Every 2 Seconds
        Worker->>DB: Claim pending analysis job - lease acquisition
        Worker->>Fallback: analyzeIncident(evidencePackage)
        
        alt Primary Provider Succeeds
            Fallback->>Primary: POST /chat/completions - Strict Schema
            Primary-->>Fallback: Valid JSON Response with Citations
        else Primary Returns 429 / 5xx / Timeout
            Fallback->>Secondary: POST /chat/completions - Fallback
            Secondary-->>Fallback: Valid JSON Response with Citations
        end

        Worker->>Worker: Validate Response Schema and Verify Citations
        Worker->>DB: UPDATE incident_ai_analyses<br/>SET status COMPLETED with JSON result
    end
```

---

## 🛡️ Anti-Hallucination & Evidence Citation Grounding

To prevent LLMs from generating speculative or hallucinated explanations, APIDash implements **Evidence-Grounded Prompting**:

1. **Deterministic Evidence Packaging:** The `incidentEvidenceBuilder` constructs a standardized JSON evidence bundle containing:
   * `[E1]`: Failed HTTP status code and status text.
   * `[E2]`: Target endpoint URL and HTTP method.
   * `[E3]`: Response latency and historical baseline averages.
   * `[E4]`: Response headers (excluding sensitive cookies/auth).
   * `[E5]`: Sanitized response body (safely truncated).
   * `[E6]`: Specific assertion violation or contract drift error message.
2. **Mandatory Citation Validation:** Every hypothesis returned by the LLM must cite the specific evidence tag (e.g., `"cited_evidence": ["E1", "E5"]`).
3. **Citation Verifier:** `aiResponseValidator.js` programmatically validates that every cited identifier exists in the original evidence package. Responses citing non-existent evidence IDs are rejected as hallucinations.

---

## 🔀 Resilient Dual-Provider Fallback Orchestrator

The `FallbackAiProvider` provides high-availability inference across upstream AI infrastructure:

* **Primary Provider:** Typically configured for high-speed inference (e.g., Groq with `llama-3.3-70b-versatile`).
* **Secondary Provider:** Activated automatically on failures (e.g., OpenRouter with `google/gemini-2.0-flash-exp:free` or OpenAI-compatible endpoints).
* **Automatic Failover Triggers:**
  * Upstream HTTP `429 Too Many Requests` (Rate Limits).
  * Upstream HTTP `500`/`503` Server Errors.
  * Inference Timeout (`AI_TIMEOUT` exceeded).
  * Malformed JSON or schema validation failure on primary output.
* **Fast-Path In-Memory Circuit Breaker:** When a provider is rate-limited, subsequent requests within the reset window automatically bypass the primary provider without incurring network latency.

---

## 🔒 Diagnostic Privacy & Sanitization

Before telemetry is transmitted to any external AI provider:
* Authorization headers (`Authorization`, `Proxy-Authorization`), session cookies, and API keys are scrubbed.
* URL credentials (`https://user:pass@domain.com`) are stripped.
* Payloads are bounded to strict token budgets to prevent token exhaustion and data leakage.

