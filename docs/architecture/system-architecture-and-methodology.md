# APIDash — System Architecture & Methodology (Presentation & Report Edition)

> **College Presentation & Report Summary:**  
> This document contains simplified, high-impact diagrams designed specifically for **project reports (fits on a single page in Word)** and **PowerPoint slides (clean, readable on projectors)**, accompanied by concise viva-defense talking points.

---

## 🏛️ 1. System Architecture Diagram

```mermaid
graph TB
    subgraph Client ["1. Presentation Layer (Frontend SPA)"]
        UI["Web Dashboard (Vanilla JS + Chart.js)<br/>Interactive Telemetry • Live Health Gauges • Incident Console • Contract Inspector"]
    end

    subgraph AppLayer ["2. Application Layer (Azure VM Ubuntu)"]
        direction LR
        API["Express API Server (127.0.0.1:5000)<br/>User Auth • Workspace RBAC • Monitor Management • REST Endpoints"]
        Worker["Dedicated Background Worker<br/>30s Probing Loop • Outbox Email Dispatcher • AI Analysis Worker"]
    end

    subgraph DataStore ["3. Persistence Layer (MySQL 8.0)"]
        DB[("MySQL Relational Database<br/>Users • API Monitors • Test Results • Contract Specs • Incidents • Outbox Queue")]
    end

    subgraph External ["4. External Ecosystem & Third-Party Services"]
        direction LR
        Targets["Monitored APIs<br/>(Target Web Services)"]
        SMTP["Gmail SMTP Relay<br/>(Port 587 TLS Alerts)"]
        AI["AI Cloud Providers<br/>(Groq Primary / NVIDIA Nemotron Fallback)"]
    end

    UI <-->|"HTTPS (Terminated by Nginx Reverse Proxy)"| API
    API <-->|"Read / Write Application State"| DB
    Worker <-->|"Atomic Lease Claim & Result Storage"| DB

    Worker -->|"Scheduled Probes (SSRF Pinned Socket)"| Targets
    Worker -->|"Email Alert Dispatch"| SMTP
    Worker -->|"Telemetry Root Cause Investigation"| AI
```

### 🎤 1-Minute Presentation Script (System Architecture)
> *"Examiners, our system architecture is organized into four clean layers:*
> 1. * **Presentation Layer:** A zero-framework Vanilla JavaScript Single Page Application that renders real-time telemetry and latency distributions using Chart.js without heavyweight framework overhead.*
> 2. * **Application Layer:** Deployed on an Azure Ubuntu VM using Nginx as an edge reverse proxy. Crucially, we enforce strict **process separation**: the user-facing Express API server and the background worker daemon run as separate operating system processes, ensuring scheduled background network probes never freeze the user interface.*
> 3. * **Persistence Layer:** A local MySQL 8.0 database storing monitors, time-series test results, OpenAPI contracts, and durable outbox queues with InnoDB row-level locking.*
> 4. * **External Ecosystem:** The worker dispatches secure, SSRF-defended probes to target APIs, triggers real-time email alerts via Gmail SMTP relay, and orchestrates dual-provider AI root cause analysis using Groq as primary and NVIDIA Nemotron via OpenRouter as fallback."*

---

## 🔄 2. Operational Methodology Diagram

```mermaid
flowchart TD
    S1["<b>STEP 1: Target Definition & Contract Ingestion</b><br/>User configures endpoint URL, SLA thresholds (ms), assertion rules, and uploads OpenAPI 3.0 specification"]
    
    S2["<b>STEP 2: Scheduled Probing & SSRF Defense</b><br/>Background worker claims due monitor on a 30s cadence, validates destination IP, and pins socket to block DNS rebinding"]
    
    S3["<b>STEP 3: Multi-Layer Outcome Evaluation</b><br/>Probes target and evaluates 3 tiers: HTTP status code, deterministic SLA assertions, and OpenAPI schema drift (AJV)"]
    
    S4["<b>STEP 4: Dual-Threshold Incident State Machine</b><br/>Anti-flapping logic: 2 consecutive failures transition incident to OPEN; 2 consecutive passes confirm RECOVERY"]
    
    S5["<b>STEP 5: Durable Outbox Alert Dispatch</b><br/>Transactionally queues alert in database outbox; worker delivers HTML email notifications to authorized members via SMTP"]
    
    S6["<b>STEP 6: Grounded AI Root Cause Investigation</b><br/>User triggers AI review: packages sanitized telemetry tokens [E-001]..[E-006] into Groq primary (fallback to NVIDIA Nemotron)"]

    S1 --> S2 --> S3 --> S4 --> S5 --> S6
```

### 🎤 1-Minute Presentation Script (Methodology)
> *"Our engineering methodology follows an automated, 6-step closed-loop quality assurance pipeline:*
> 1. * **Configure:** The developer specifies the target endpoint, SLA latency limit, multi-rule assertions, and optionally binds it to an OpenAPI contract.*
> 2. * **Secure Probe:** Every 30 seconds, the background worker executes a probe. Before sending packets, it runs an SSRF defense check to block private IP access and pins the socket to prevent DNS rebinding.*
> 3. * **Evaluate:** The response is evaluated across three tiers: status code, deterministic assertions, and contract schema compliance (catching silent schema drift).*
> 4. * **State Machine:** To prevent false alarms from network hiccups (flapping), our incident state machine requires **two consecutive failures** to open an incident, and **two consecutive passes** to mark it resolved.*
> 5. * **Alert Dispatch:** State changes write an entry to a durable database outbox, where the dispatcher safely relays email alerts to verified workspace members.*
> 6. * **AI Root Cause Analysis:** If the developer needs fast troubleshooting, a single click packages redacted failure evidence into our dual-provider AI engine (Groq primary, NVIDIA Nemotron fallback) to produce evidence-grounded hypotheses with zero hallucinations."*

---

## 📊 Summary Table for Report Inclusion

| Architectural Dimension | Implementation in APIDash | Primary Benefit |
| :--- | :--- | :--- |
| **System Pattern** | Modular Monolith with Process Decoupling | High performance, zero microservice complexity, isolated failure domains. |
| **Edge Security** | Nginx Reverse Proxy with TLS 1.3 & HSTS | Secure HTTPS termination and automated Let's Encrypt certificate renewal. |
| **Network Egress Defense** | Custom Agent Socket IP Pinning | Total immunity against SSRF and Time-of-Check Time-of-Use DNS rebinding. |
| **Contract Quality** | OpenAPI 3.0/3.1 validation via Scalar + AJV | Catches unexpected breaking payload mutations before downstream users do. |
| **Incident Stability** | Dual-threshold state machine (2-fail / 2-pass) | Completely eliminates false alarms and alerting noise from transient network blips. |
| **Alerting Reliability** | Transactional Outbox Pattern | Guarantees zero lost alerts during server restarts or transient SMTP outages. |
| **AI Investigation** | Dual-Provider Fallback (Groq + OpenRouter/Nemotron) | High speed (~1.7s Groq) with seamless fallback if rate-limited, strictly cited. |
