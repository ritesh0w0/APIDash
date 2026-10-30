# APIDash — Phase 0: Baseline Technical Audit Report

- **Date of Audit:** 2026-10-27
- **Audit Type:** Technical Baseline & Security Audit (Read-First, Evidence-Driven)
- **Repository Root:** `c:\APIDash`
- **Auditor:** Senior Software Engineer (Antigravity Agentic Pair)
- **Status:** Complete (Read-Only Baseline Established)

---

## 1. Executive Summary

APIDash is an automated API health monitoring and observability application consisting of an Express.js backend, a MySQL database for persistence, and a vanilla HTML/CSS/JavaScript single-page frontend.

### Key Audit Findings

1. **Monolithic Architecture with Coupled Background Probing `[SOURCE-VERIFIED]`:**  
   The application runs as a single Node.js process (`backend/server.js`) that simultaneously serves static frontend assets, handles 11 REST API routes, and triggers an autonomous background scheduler probing all registered HTTP targets every 30 seconds.
2. **Server Startup Blocked in Default Environment `[RUNTIME-VERIFIED]`:**  
   Attempting to start the application with default credentials from `.env.example` fails immediately with `Access denied for user 'root'@'localhost' (using password: NO)` because `backend/db.js` attempts a root connection with an empty password during `initDB()`.
3. **Startup Unconditionally Executes Outbound Probes `[SOURCE-VERIFIED]`:**  
   `backend/server.js:46-49` unconditionally schedules `testAllApis()` 2 seconds after startup. The application has **no configuration, environment variable, or flag** to disable the scheduler or run in safe/dry-run mode. Therefore, starting the server against any database containing target APIs immediately causes outbound network traffic.
4. **Critical Architectural & Security Risks `[SOURCE-VERIFIED]`:**
   - **Server-Side Request Forgery (SSRF) `[P1 - High]`:** Endpoints accept arbitrary target URLs (`POST /api/add`) with no validation against private, loopback, or link-local IP addresses (`127.0.0.1`, `169.254.169.254`, `10.0.0.0/8`, etc.), and Axios follows redirects by default.
   - **Complete Absence of Authentication / Authorization `[P1 - High]`:** All endpoints (including monitor creation, deletion, manual execution, and analytics) are completely unauthenticated and unprotected.
   - **Hardcoded Frontend Origin `[P1 - High]`:** `frontend/app.js:2` hardcodes `API_BASE = 'http://localhost:5000/api'`, breaking any deployment not served strictly on port 5000 of localhost.
   - **Unbounded Probe Concurrency `[P1 - High]`:** `testAllApis()` launches simultaneous requests for all registered APIs via `Promise.all(rows.map(testApi))` without rate limiting, connection pooling control, or batching.
   - **Overlapping Scheduler Cycles `[P1 - High]`:** The scheduler uses `setInterval` without awaiting the previous cycle, creating race conditions if probe execution time exceeds 30 seconds.
5. **Testing & Tooling Status `[RUNTIME-VERIFIED]`:**  
   The repository contains **zero automated tests**, no linting configuration, and no build scripts. `npm test` does not exist in `backend/package.json`.

---

## 2. Repository and Environment

### Repository State `[RUNTIME-VERIFIED]`
- **Local Path:** `c:\APIDash`
- **Git Branch:** `main`
- **Working Tree Status:** Clean (prior to generating this report).
- **Recent Git History:**
  - `290863d` (2026-09-01): `docs: update repository clone URL to ritesh0w0/api-health-monitor`
  - `319fad8` (2026-09-01): `docs: add comprehensive README, MIT license, .gitignore, and untrack dependencies`
  - `e5002e7` (2026-08-28): `init message` (initial repository creation by teammate)
- **Git Remotes:** `origin -> https://github.com/ritesh0w0/api-health-monitor.git` (fetch & push)
- **Configured Git User:** `Ritesh Kulakarni <riteshakofficial@gmail.com>`

### Directory Structure `[RUNTIME-VERIFIED]`
```text
c:\APIDash/
├── .git/                     # Git version control metadata
├── .gitignore                # Ignores node_modules, .env files, logs, OS files
├── LICENSE                   # MIT License (Copyright 2026 Ritesh Kulakarni)
├── README.md                 # Project README and usage documentation
├── backend/                  # Express.js REST API and background worker
│   ├── .env                  # Ignored local environment configuration (present)
│   ├── .env.example          # Template environment variable configuration
│   ├── db.js                 # MySQL pool configuration & initDB schema creation
│   ├── node_modules/         # Installed dependencies
│   ├── package-lock.json     # npm lockfile (v3)
│   ├── package.json          # Node.js project manifest
│   ├── routes/
│   │   └── apiRoutes.js      # REST API route handlers
│   ├── server.js             # Express application and scheduler entry point
│   └── services/
│       ├── analytics.js      # Telemetry, statistical calculations & aggregations
│       └── tester.js         # HTTP probe execution engine & scheduler cycle
└── frontend/                 # Client-side user interface
    ├── app.js                # Frontend controller & Chart.js rendering
    ├── index.html            # Single-page application markup & layout
    └── style.css             # Glassmorphism dark-mode stylesheet
```

### Runtime & Dependency Versions
- **Node.js Runtime:** `v24.18.0` `[RUNTIME-VERIFIED]`
- **Package Manager:** `npm v11.16.0` `[RUNTIME-VERIFIED]`
- **Declared vs. Installed Dependencies `[RUNTIME-VERIFIED]`:**

| Package | Declared in `package.json` | Installed in `node_modules` | Type | Role |
| :--- | :--- | :--- | :--- | :--- |
| `axios` | `^1.7.2` | `1.15.2` | Production | Outbound HTTP probing client |
| `cors` | `^2.8.5` | `2.8.6` | Production | Cross-origin resource sharing middleware |
| `dotenv` | `^16.4.5` | `16.6.1` | Production | Environment variable loader |
| `express` | `^4.19.2` | `4.22.1` | Production | HTTP server and routing engine |
| `mysql2` | `^3.9.7` | `3.22.2` | Production | MySQL database driver (`mysql2/promise`) |
| `nodemon` | `^3.1.3` | `3.1.14` | DevDependency | Development server auto-reloader |

### Available Scripts `[SOURCE-VERIFIED]`
In `backend/package.json`:
- `"start": "node server.js"`
- `"dev": "nodemon server.js"`
- **Test Script:** None (`npm test` returns error: `Missing script: "test"`).
- **Lint Script:** None.
- **Build Script:** None (No frontend build tool; raw files served statically).

### Environment Variables Required `[SOURCE-VERIFIED]`
The application references 5 environment variables (discovered via source inspection of `backend/server.js` and `backend/db.js`):
1. `PORT` (Optional; defaults to `5000`)
2. `DB_HOST` (Optional; defaults to `'localhost'`)
3. `DB_USER` (Optional; defaults to `'root'`)
4. `DB_PASSWORD` (Optional; defaults to `''`)
5. `DB_NAME` (Optional; defaults to `'api_monitor'`)

---

## 3. Verified Architecture

### Execution Architecture & Data Flow

```text
       ┌───────────────────────────────────────────────────────────────┐
       │                       Browser Client                          │
       │           (HTML5, style.css, app.js, Chart.js CDN)            │
       └──────────────┬────────────────────────────────▲───────────────┘
                      │                                │
      fetch() Calls   │                                │  JSON Responses
                      ▼                                │
       ┌───────────────────────────────────────────────┴───────────────┐
       │             Express.js Server (backend/server.js)             │
       │                                                               │
       │  • Middleware: cors(), express.json(), express.urlencoded()   │
       │  • Static File Serving: ../frontend -> index.html, CSS, JS   │
       │  • Router: /api -> backend/routes/apiRoutes.js                │
       │  • Health Probe: GET /health                                  │
       └──────────────┬────────────────────────────────▲───────────────┘
                      │                                │
         Queries /    │                                │  Rowsets
         Transactions ▼                                │
       ┌───────────────────────────────────────────────┴───────────────┐
       │              MySQL Database (backend/db.js)                   │
       │                                                               │
       │  Pool: 10 connections (mysql2/promise)                        │
       │  Tables:                                                      │
       │    1. apis (registered monitors)                              │
       │    2. test_results (granular execution results)               │
       │    3. scheduler_runs (batch cycle summaries)                  │
       └──────────────▲────────────────────────────────────────────────┘
                      │
        Persist Run & │ (INSERT)
        Probe Results │
                      │
       ┌──────────────┴────────────────────────────────────────────────┐
       │            Background Worker (In-Process Scheduler)           │
       │                                                               │
       │  • Trigger: setInterval every 30,000ms (2s initial warmup)    │
       │  • Dispatcher: backend/services/tester.js -> testAllApis()    │
       │  • Engine: Promise.all(apis.map(testApi))                     │
       └──────────────┬────────────────────────────────────────────────┘
                      │
          Outbound    │ Axios HTTP (timeout: 10s, validateStatus: () => true)
          Probes      ▼
       ┌───────────────────────────────────────────────────────────────┐
       │               External & Internal Target APIs                 │
       │            (HTTP GET / POST / PUT / DELETE etc.)              │
       └───────────────────────────────────────────────────────────────┘
```

### Architectural Characteristics & Coupling
1. **In-Process Background Scheduler `[SOURCE-VERIFIED]`:**
   The scheduler is not a separate service or worker thread; it is a `setInterval` timer embedded directly inside `backend/server.js:46-49`. If the web server crashes or restarts, all scheduling state is lost, and active HTTP requests are terminated abruptly without graceful drainage.
2. **Coupled Startup Schema Generation `[SOURCE-VERIFIED]`:**
   `backend/server.js:37` calls `initDB()` from `backend/db.js:17-68` on every boot. This function connects as root without a database, runs `CREATE DATABASE IF NOT EXISTS`, and executes raw DDL statements (`CREATE TABLE IF NOT EXISTS`). There are no migration records, version numbers, or rollback capabilities.
3. **No Controller / Service Boundary `[SOURCE-VERIFIED]`:**
   `backend/routes/apiRoutes.js` mixes routing, parameter extraction, database queries, and response formatting into route handlers. Only HTTP probing (`tester.js`) and statistical telemetry (`analytics.js`) are separated into services.

---

## 4. Endpoint Inventory

The application exposes 12 routes (1 self-health probe, 10 API endpoints, 1 wildcard SPA route).

| HTTP Method | Route Path | Defined In | Purpose | Parameters / Body | Auth / Access Control | Database Access | Triggers Outbound HTTP? | Side Effects | Error Handling |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `GET` | `/health` | `server.js:27` | Server self-health & uptime | None | None | None | No | None | Returns `{ status: 'ok', uptime }` |
| `POST` | `/api/add` | `apiRoutes.js:9` | Register new API monitor | JSON: `{ name, url, method?, expected_status? }` | None | `INSERT INTO apis` | No | Creates monitor record | Validates presence of `name` and `url`; checks `method` against whitelist `['GET','POST','PUT','PATCH','DELETE','HEAD']`. Defaults `method='GET'`, `expected_status=200`. Returns 400 on invalid input, 500 on DB error. |
| `GET` | `/api/list` | `apiRoutes.js:47` | List all monitored APIs with last known status | None | None | `SELECT` from `apis` LEFT JOIN correlated subquery on `test_results` | No | None | Returns array of APIs ordered by `created_at DESC`. Returns 500 on DB error. |
| `GET` | `/api/test/:id` | `apiRoutes.js:34` | Trigger immediate on-demand probe | Param: `id` (int) | None | `SELECT apis`, `INSERT test_results` | **Yes (Axios)** | Persists test result to `test_results` | Checks if API exists (404 if not found). Executes `testApi()`. Returns 500 on unexpected exception. |
| `DELETE` | `/api/delete/:id` | `apiRoutes.js:140` | Delete an API monitor & history | Param: `id` (int) | None | `DELETE FROM apis` | No | Deletes API; cascades delete to `test_results` | Returns 404 if `affectedRows === 0`. Returns 500 on DB error. |
| `GET` | `/api/history/:id` | `apiRoutes.js:74` | Fetch last 20 executions for an API | Param: `id` (int) | None | `SELECT test_results` (`LIMIT 20`) | No | None | Ordered by `tested_at DESC`. Returns 500 on DB error. |
| `GET` | `/api/stats` | `apiRoutes.js:88` | Aggregate stats for dashboard cards | None | None | `SELECT` aggregation on subquery | No | None | Counts total, passing, failing, untested, and average response time. Returns 500 on DB error. |
| `GET` | `/api/chart-data` | `apiRoutes.js:119` | Latency series for dashboard line chart | None | None | `SELECT apis`, then N parallel `SELECT test_results LIMIT 10` | No | None | Runs `Promise.all` across all APIs. Returns object `{ [apiId]: { name, points } }`. Returns 500 on error. |
| `GET` | `/api/analytics/summary` | `apiRoutes.js:152` | Global analytics summary | Query: `?hours=24` | None | Multiple queries across `apis`, `test_results`, `scheduler_runs` | No | None | Parses `hours` (default 24). Calls `getGlobalAnalytics()`. Returns 500 on error. |
| `GET` | `/api/analytics/:id` | `apiRoutes.js:164` | Deep per-API analytics | Param: `id`, Query: `?hours=24` | None | `SELECT apis`, `SELECT test_results` | No | None | Validates API existence (404). Calls `getApiAnalytics()`. Returns 500 on error. |
| `GET` | `/api/scheduler-runs` | `apiRoutes.js:180` | Batch cycle logs for scheduler timeline | None | None | `SELECT scheduler_runs LIMIT 60` | No | None | Returns last 60 runs reversed (oldest to newest). Returns 500 on error. |
| `GET` | `*` | `server.js:30` | Wildcard SPA fallback | None | None | None | No | None | Serves `frontend/index.html` |

---

## 5. Database Model

The database schema is defined in `backend/db.js:30-66` and auto-created if not present.

### Table Definitions `[SOURCE-VERIFIED]`

#### 1. `apis` Table
Stores registered target endpoints.
```sql
CREATE TABLE IF NOT EXISTS apis (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(255)   NOT NULL,
  url             TEXT           NOT NULL,
  method          VARCHAR(10)    NOT NULL DEFAULT 'GET',
  expected_status INT            NOT NULL DEFAULT 200,
  created_at      DATETIME       DEFAULT CURRENT_TIMESTAMP
);
```
- **Constraints:** Primary key `id`.
- **Missing Constraints:** No unique constraint on `url` or `(name, url)` — identical endpoints can be registered repeatedly. `url` is `TEXT` without character limits.

#### 2. `test_results` Table
Stores granular execution history for every single probe.
```sql
CREATE TABLE IF NOT EXISTS test_results (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  api_id        INT            NOT NULL,
  status_code   INT,
  response_time INT,
  result        ENUM('PASS','FAIL') NOT NULL,
  error_message TEXT,
  tested_at     DATETIME       DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (api_id) REFERENCES apis(id) ON DELETE CASCADE
);
```
- **Constraints:** Primary key `id`; Foreign key `api_id` references `apis(id)` with `ON DELETE CASCADE`.
- **Indexes:** Only the primary key and the implicit index on foreign key `api_id`.
- **Missing Indexes:** **No index on `tested_at`** or composite index on `(api_id, tested_at)`. All analytical queries filtering by `tested_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)` will perform table scans as history grows.

#### 3. `scheduler_runs` Table
Stores summary telemetry for each 30-second scheduler batch.
```sql
CREATE TABLE IF NOT EXISTS scheduler_runs (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  total      INT NOT NULL DEFAULT 0,
  passed     INT NOT NULL DEFAULT 0,
  failed     INT NOT NULL DEFAULT 0,
  avg_ms     INT,
  ran_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);
```
- **Constraints:** Primary key `id`.
- **Missing Indexes:** No index on `ran_at`.

### Connection Pool Configuration `[SOURCE-VERIFIED]`
In `backend/db.js:4-12`:
- `host`: `process.env.DB_HOST || 'localhost'`
- `user`: `process.env.DB_USER || 'root'`
- `password`: `process.env.DB_PASSWORD || ''`
- `database`: `process.env.DB_NAME || 'api_monitor'`
- `waitForConnections`: `true`
- `connectionLimit`: `10`
- `queueLimit`: `0` (unbounded queue)

### Database Deficiencies & Concerns `[SOURCE-VERIFIED]`
1. **Unbounded Data Retention:**  
   Probing at 30-second intervals produces `2,880` rows per API per day in `test_results`, plus `2,880` rows per day in `scheduler_runs`. With 20 APIs, this is ~60,000 rows/day. No data pruning, retention policy, or partitioning exists.
2. **Startup DDL Anti-pattern:**  
   `initDB()` executes raw DDL statements directly from application code on startup. This causes permission issues in production (where app users should not have `CREATE TABLE` / `CREATE DATABASE` privileges) and prevents coordinated migrations.
3. **Recommendation for Phase 1:**  
   Introduce a versioned migration tool (such as `knex` or a dedicated migration runner) to manage schemas, add necessary composite indexes (`(api_id, tested_at DESC)`), and establish automated retention pruning.

---

## 6. Monitoring Execution Lifecycle

### Detailed Probe Flow (`testApi` in `backend/services/tester.js:10-58`)
1. **Input Object:** Expects `{ id, name, url, method, expected_status }`.
2. **Timer Start:** Captures `start = Date.now()`.
3. **Request Options:**
   - `method`: `api.method.toLowerCase()`
   - `url`: `api.url`
   - `timeout`: `10000` (10-second hard limit)
   - `validateStatus: () => true` (instructs Axios not to throw for non-2xx status codes)
4. **Headers & Body Support:** **Zero support.** Requests are sent with default Axios headers and no body payloads.
5. **Latency Measurement:** `result.response_time = Date.now() - start`. Measures total socket connect, TLS handshake, request transfer, and response header transfer.
6. **Pass / Fail Determination:**
   - If HTTP response received: `result.result = (response.status === api.expected_status) ? 'PASS' : 'FAIL'`.
   - If status code differs: `error_message = 'Expected ' + api.expected_status + ', got ' + response.status`.
   - If network/socket exception occurs (DNS resolution failure, timeout, connection refused): caught in `catch (err)`, `result.result = 'FAIL'`, `result.error_message = err.message`, and `status_code` remains `null`.
   - **Crucial Note:** Response latency does NOT impact the PASS/FAIL outcome. A 9,999ms response with status 200 is marked `PASS`.
7. **Response Body Handling:** The response body stream is completely discarded; it is neither inspected, schema-validated, nor persisted.
8. **Persistence:** Raw SQL `INSERT INTO test_results` writes `api_id, status_code, response_time, result, error_message`.
9. **Manual vs. Scheduled:** Both manual tests (`GET /api/test/:id`) and automated scheduler runs invoke the exact same `testApi()` function and persist results to `test_results`.

### Scheduler Lifecycle (`backend/server.js:46-49` & `tester.js:64-95`)
1. **Warmup Delay:** `setTimeout(..., 2000)` waits 2 seconds after server boot.
2. **First Run & Recurring Loop:** Runs `testAllApis()` once, then schedules `setInterval(testAllApis, 30000)`.
3. **Batch Execution:**
   - Reads `SELECT * FROM apis`. If empty, logs skip message and exits.
   - Executes `const results = await Promise.all(rows.map(testApi));`.
   - Summarizes cycle: passed count, failed count, and arithmetic average latency across successful timings.
   - Persists summary into `scheduler_runs`.
4. **Vulnerabilities in Scheduler Design:**
   - **No Concurrency Bounds:** `Promise.all` issues all requests simultaneously. If 200 endpoints exist, 200 simultaneous network sockets and 200 concurrent DB queries fire at once, easily exceeding the DB pool limit of 10.
   - **Overlapping Runs:** If requests hang up to the 10-second timeout or network stalls, `setInterval` triggers the next cycle unconditionally at 30 seconds, leading to thread and memory exhaustion.
   - **No Shutdown Interception:** Process signals (`SIGINT`, `SIGTERM`) are unhandled.

---

## 7. Analytics Definitions and Calculations

Located in `backend/services/analytics.js`:

### 1. Uptime Percentage (`getApiAnalytics`, lines 27)
$$\text{Uptime \%} = \left(\frac{\text{Passed Checks}}{\text{Total Checks}}\right) \times 100$$
- Returned to 2 decimal places via `+((passed / total) * 100).toFixed(2)`.
- If `total === 0`, returns `0` checks and skips division.

### 2. Average, Min, and Max Latency (lines 35-37)
- Filters out null response times: `times = rows.map(r => r.response_time).filter(t => t != null).sort((a,b) => a - b)`.
- `avg_ms`: `Math.round(sum / length)`.
- `min_ms`: `times[0]`.
- `max_ms`: `times[times.length - 1]`.

### 3. P50 and P95 Tail Latencies (lines 38-39)
```javascript
const p50 = times.length ? times[Math.floor(times.length * 0.50)] : null;
const p95 = times.length ? times[Math.floor(times.length * 0.95)] : null;
```
- **Statistical Accuracy Limitation `[SOURCE-VERIFIED]`:**  
  Because the calculation uses `Math.floor(times.length * 0.95)` on a sorted array, when sample sizes are small (< 20 samples), index `floor(N * 0.95)` evaluates to `times.length - 1` (the maximum value / 100th percentile). The UI presents this as the 95th percentile, which is statistically inaccurate for low sample counts.

### 4. Failure Streak (lines 42-46)
Iterates backwards from the most recent result (`rows.length - 1` down to 0). Increments `failStreak` for each consecutive `FAIL` result, terminating immediately upon encountering the first `PASS`.

### 5. Composite Health Score (0–100) (lines 158-172)
Calculated by `calcHealthScore({ uptimePct, p95, failStreak })`:
- Base score: `100`
- **Uptime deduction:** `Math.round((1 - uptimePct / 100) * 50)` (up to -50 points)
- **Latency deduction:**
  - `p95 > 5000ms`: -30 points
  - `p95 > 2000ms`: -20 points
  - `p95 > 1000ms`: -10 points
  - `p95 > 500ms`: -5 points
- **Failure streak deduction:** `Math.min(failStreak * 5, 20)` (up to -20 points)
- Clamped: `Math.max(0, Math.min(100, score))`.

### 6. Hourly Aggregation & Error Grouping (lines 49-74)
- Groups results into hourly buckets using `new Date(r.tested_at).toISOString().slice(0, 13)`.
- Groups `error_message` strings into a frequency map, returning the top 5 distinct error messages.

---

## 8. Frontend Behavior and User-Visible States

### Page Structure & Layout
Implemented in `frontend/index.html` (467 lines) and `frontend/style.css` (625 lines):
- **Glassmorphism Dark Mode:** Background mesh aurora animation with SVG countdown ring.
- **Header:** Live API total pill and next-run 30-second countdown ring.
- **Two Tabs:**
  - `#viewDashboard`: Register API form, Monitored APIs list, 4 summary stat cards, and 10-point response time line chart.
  - `#viewAnalytics`: 4 global hero stat cards, 1h/6h/24h/48h/7d time window buttons, Scheduler timeline stacked bar chart, and per-API health score cards.
- **Modal:** `#resultModal` showing on-demand manual test details and raw JSON output.
- **Toast:** Floating feedback alert element `#toast`.

### Frontend Controller Logic (`frontend/app.js`, 684 lines)
1. **Critical URL Defect `[SOURCE-VERIFIED]`:**  
   Line 2: `const API_BASE = 'http://localhost:5000/api';`.  
   The API host is hardcoded. If the app is served via any host other than `localhost` or port other than `5000`, all frontend API calls fail.
2. **Auto-Refresh Loop `[SOURCE-VERIFIED]`:**  
   Lines 467-470:
   ```javascript
   setInterval(() => {
     loadApis(); loadStats(); loadChart();
     if (activeTab === 'analytics') loadAnalytics();
   }, 30_000);
   ```
   The frontend runs a client-side 30-second timer. It is not synchronized with the backend scheduler cycle, meaning data refreshes can occur immediately before a backend cycle finishes.
3. **Two-Step Deletion UX:**  
   `app.js:154-177`: First click on "✕ Remove" changes button text to "✓ Sure?" with a 3-second timeout. Clicking within 3 seconds executes `DELETE /api/delete/:id`.
4. **XSS & DOM Safety Review:**  
   `escHtml()` helper is applied when interpolating user-controlled values (`name`, `url`, `error_message`) into DOM template literals (`app.js:202-208`).

---

## 9. Security and Reliability Findings

Findings prioritized from **P0 (Critical)** to **P3 (Low)** with code locations and failure scenarios.

### [P1 - High] Server-Side Request Forgery (SSRF)
- **Locations:** `backend/routes/apiRoutes.js:9-31`, `backend/services/tester.js:25-30`
- **Condition:** An attacker or user can submit `url: "http://169.254.169.254/latest/meta-data/"`, `http://127.0.0.1:3306`, or private subnet IPs (`10.0.0.0/8`, `192.168.0.0/16`) in `POST /api/add`.
- **Failure Mode:** The backend tester will issue HTTP requests to internal cloud metadata services, databases, or local services. Axios follows HTTP redirects by default, allowing external URLs to redirect into local loopback addresses.

### [P1 - High] Total Absence of Authentication, Authorization & Rate Limiting
- **Locations:** `backend/server.js`, `backend/routes/apiRoutes.js`
- **Condition:** Every route on the Express server is completely unauthenticated.
- **Failure Mode:** Anyone who can reach port 5000 can add arbitrary monitoring targets, trigger manual probes continuously (denial of service against external targets), delete monitors, or view internal infrastructure URLs and error payloads.

### [P1 - High] Hardcoded Frontend API Base URL
- **Location:** `frontend/app.js:2`
- **Condition:** `const API_BASE = 'http://localhost:5000/api';`
- **Failure Mode:** If deployed on a custom domain, reverse proxy (NGINX/Caddy), Docker container, or alternate port, the frontend fails to communicate with the backend.

### [P1 - High] Unbounded Concurrency in Scheduler
- **Location:** `backend/services/tester.js:74`
- **Condition:** `const results = await Promise.all(rows.map(testApi));`
- **Failure Mode:** As the number of registered endpoints increases, all outbound connections fire concurrently. This will exhaust Node.js socket pools, operating system file descriptors, and the MySQL connection pool (`connectionLimit: 10`).

### [P1 - High] Uncontrolled Overlapping Scheduler Runs
- **Location:** `backend/server.js:48`
- **Condition:** `setInterval(testAllApis, SCHEDULER_INTERVAL_MS);`
- **Failure Mode:** If probes take longer than 30s to resolve (e.g. multiple timeouts of 10s), `setInterval` triggers a new cycle while the old one is still executing, compounding latency and database contention.

### [P1 - High] Automatic Probe Execution on Startup Without Safe Mode Switch
- **Location:** `backend/server.js:46-49`
- **Condition:** `setTimeout(async () => { await testAllApis(); ... }, 2000);`
- **Failure Mode:** Launching the server immediately contacts all external registered target URLs. There is no configuration flag (e.g. `ENABLE_SCHEDULER=false`) to disable background testing during maintenance, staging, or auditing.

### [P2 - Medium] Unindexed Database Queries & Infinite Data Retention
- **Locations:** `backend/db.js:42-53`, `backend/services/analytics.js:11-17`
- **Condition:** `test_results` has no index on `tested_at`. Analytical queries filter by `tested_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)`.
- **Failure Mode:** Continuous 30s probes will grow `test_results` by ~86,400 rows per month per API. Analytics queries will cause severe table scans and high CPU utilization.

### [P2 - Medium] Known Security Vulnerabilities in Installed Dependencies
- **Location:** `backend/package-lock.json`
- **Condition:** `npm audit` reveals 8 vulnerabilities (1 Critical, 5 High, 2 Moderate).
- **Vulnerabilities:**
  - `proxy-addr` (Critical - GHSA-jqcg-44mw-7w3h): IP spoofing vulnerability.
  - `follow-redirects` (High - GHSA-q3jh-wrc6-jgq8, GHSA-8r9p-f939-6h3c): Header credential leaks.
  - `form-data` (High - GHSA-hmw2-7cc7-3qxx): CRLF injection.
  - `brace-expansion` (High - GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p): CPU denial of service.
  - `mysql2` (Moderate - GHSA-rgwj-5xj2-c3m3): Unbounded zlib decompression bomb.
  - `qs` (Moderate - GHSA-q8mj-m7cp-5q26, GHSA-4mjr-xmp4-gh2g): Remotely triggerable DoS.

### [P2 - Medium] Missing Automated Test Suite
- **Location:** `backend/package.json`
- **Condition:** No test runner (Jest, Mocha, Vitest, Supertest) or test scripts exist.
- **Failure Mode:** Any refactoring or feature implementation lacks automated regression verification.

### [P3 - Low] Inaccurate Small-Sample P95 Calculations
- **Location:** `backend/services/analytics.js:39`
- **Condition:** `Math.floor(times.length * 0.95)` on datasets with < 20 entries returns the maximum value.
- **Failure Mode:** Misleading telemetry display for newly added monitors.

---

## 10. Verification Log

| Command / Check | Execution Status | Outcome | Findings / Proved Facts | Limitations / What Was NOT Proved |
| :--- | :--- | :--- | :--- | :--- |
| `git status` | Executed | Code 0 (Clean) | Working tree was completely clean prior to audit. | Does not verify uncommitted changes on other branches. |
| `git log -n 5 --oneline; git remote -v` | Executed | Code 0 | Confirmed 3 commits; origin points to `github.com/ritesh0w0/api-health-monitor.git`. | None. |
| `node -v; npm -v` | Executed | Code 0 | Confirmed Node.js `v24.18.0` and npm `11.16.0`. | Does not guarantee server runtime stability. |
| `npm list --depth=0` (in `backend`) | Executed | Code 0 | Established installed versions of axios, cors, dotenv, express, mysql2, nodemon. | Does not check secondary dependencies. |
| `node --check` across backend files | Executed | Code 0 | Confirmed valid JavaScript syntax across all 5 backend files. | Syntax validation only; does not prove runtime correctness. |
| `npm audit --json` (in `backend`) | Executed | Code 1 (Advisories found) | Identified 8 vulnerabilities (1 Critical, 5 High, 2 Moderate) in installed packages. | Read-only check; no dependencies were modified or fixed. |
| Server Startup (`node server.js`) | Attempted by User | Code 1 (Fatal Error) | Confirmed `Access denied for user 'root'@'localhost' (using password: NO)`. | Blocked from reaching operational HTTP listening state. |
| Runtime HTTP Probing / API Endpoints | **Blocked** | Not Executed | Server failed to start due to DB authentication error. Also blocked by Rule 8 (prohibits running server that immediately executes unmocked outbound probes). | Endpoints not runtime-exercised; verified via comprehensive source inspection. |

---

## 11. Baseline Behavior Matrix

| Feature / Behavior | Documented Claim | Verified Status | Evidence |
| :--- | :--- | :--- | :--- |
| **API Registration** | CRUD registration of endpoints with method & expected status | `[SOURCE-VERIFIED]` | `backend/routes/apiRoutes.js:9-31` implements `POST /api/add` with method whitelist. |
| **Manual On-Demand Testing** | Trigger immediate test and return JSON result | `[SOURCE-VERIFIED]` | `backend/routes/apiRoutes.js:34-44` triggers `testApi()`, writes to DB, returns JSON. |
| **30-Second Background Probing** | Scheduler tests all APIs every 30s | `[SOURCE-VERIFIED]` | `backend/server.js:46-49` sets `setInterval(testAllApis, 30000)` with 2s warmup. |
| **Tail Latency (P50 / P95)** | Computes percentiles across configurable time windows | `[SOURCE-VERIFIED]` | `backend/services/analytics.js:38-39` calculates P50/P95 on sorted response times. |
| **Consecutive Failure Streak** | Tracks consecutive failures from latest run backwards | `[SOURCE-VERIFIED]` | `backend/services/analytics.js:42-46` implements reverse loop counting `FAIL` results. |
| **Composite Health Score** | Heuristic score 0-100 based on uptime, P95, and streak | `[SOURCE-VERIFIED]` | `backend/services/analytics.js:158-172` calculates weighted health score. |
| **Scheduler Timeline Chart** | Stacked bar chart showing pass/fail history of batch runs | `[SOURCE-VERIFIED]` | `frontend/app.js:620-677` renders Chart.js stacked bar chart from `scheduler_runs`. |
| **Database Auto-Initialization** | DB and tables created automatically on startup | `[SOURCE-VERIFIED]` | `backend/db.js:17-68` executes DDL statements on boot. |
| **Server Booting with Default Credentials** | Starts out-of-the-box with `cp .env.example .env` | `[RUNTIME-VERIFIED: FAILED]` | Startup fails if local MySQL root user requires a password. |
| **Safe Mode / Scheduler Disable** | Flag to disable outbound scheduler during testing | `[SOURCE-VERIFIED: ABSENT]` | No flag exists; scheduler is hardcoded to run on startup. |
| **Authentication & Access Control** | Protects endpoints and dashboard from unauthorized access | `[SOURCE-VERIFIED: ABSENT]` | All routes are open; no middleware or session checks exist. |
| **Request Payload / Header Support** | Custom headers (Bearer, API keys) and request bodies | `[SOURCE-VERIFIED: ABSENT]` | `tester.js` passes only method, url, timeout. No headers or payload support. |

---

## 12. Phase 1 Recommendations

Before any feature work or public deployment occurs, Phase 1 should focus on establishing an enterprise-grade engineering foundation:

### 1. Scheduler Control & Isolation
- Implement an explicit `ENABLE_SCHEDULER` environment variable (defaults to `true`, can be set to `false` for testing, maintenance, and auditing).
- Replace `setInterval` with a recursive `setTimeout` or robust job runner (e.g. `bree` or `node-cron`) to eliminate overlapping cycle executions.
- Enforce concurrency bounds using a p-limit pool (e.g. max 5 concurrent probes) to prevent socket and database exhaustion.

### 2. Security Foundation (SSRF & Auth)
- Implement an outbound URL validation layer that resolves DNS before connecting and rejects private/loopback/link-local IP addresses (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`).
- Disable automatic redirect following or validate every redirect target against the SSRF filter.
- Fix `frontend/app.js` to use relative paths (`/api`) instead of hardcoding `http://localhost:5000/api`.

### 3. Database Migration & Integrity
- Replace startup DDL in `db.js` with versioned database migrations (e.g., using `knex` or standard SQL migration scripts).
- Add composite index on `test_results(api_id, tested_at DESC)` and index on `scheduler_runs(ran_at DESC)`.
- Introduce an automated data pruning/retention job (e.g., keeping granular results for 7 days).

### 4. Automated Testing Suite
- Install a lightweight test runner (e.g. `vitest` or `jest` + `supertest`).
- Write unit tests for analytics math (`calcHealthScore`, `p95`, `failStreak`) and integration tests for API routes using an in-memory or isolated mock database.

### 5. Dependency Remediations
- Update `package.json` to remediate known advisories (`proxy-addr`, `follow-redirects`, `mysql2`, `form-data`).

---

## 13. Open Questions & Technical Unknowns

1. **Production Deployment Target:** Is APIDash intended to run as a single container on a VPS, or will the frontend be hosted on a CDN (Vercel/Cloudflare Pages) with the backend running as a separate API server?
2. **Target Scope for Monitored APIs:** Will users need to monitor internal microservices within private VPCs? If so, the SSRF protection must support an explicit IP/CIDR whitelist.
3. **Database Selection:** Should MySQL remain the required store, or should SQLite be supported for zero-config local testing and quick developer onboarding?
4. **Notification Channels:** What alerting integrations (Slack, Discord, Webhooks, Email) will be prioritized when failure streaks occur?

---

## 14. Audit Completion Checklist

- [x] **Objective 1 — Establish repository identity and current state:** Completed.
- [x] **Objective 2 — Establish technology stack and entry points:** Completed.
- [x] **Objective 3 — Produce architecture map:** Completed.
- [x] **Objective 4 — Inventory all backend endpoints:** Completed (all 12 routes documented).
- [x] **Objective 5 — Inspect and document the database:** Completed (all 3 tables, indexes, pool inspected).
- [x] **Objective 6 — Trace complete monitoring execution lifecycle:** Completed (probe engine, scheduler, and analytics inspected).
- [x] **Objective 7 — Audit frontend and user-visible behavior:** Completed (app.js, index.html, style.css inspected).
- [x] **Objective 8 — Conduct source-based security and reliability review:** Completed (P1 to P3 findings prioritized).
- [x] **Objective 9 — Run only safe, relevant checks:** Completed (safe checks executed; runtime execution blocked and recorded).
- [x] **Objective 10 — Produce baseline audit report:** Completed (`docs/phase-0-baseline-audit.md` generated).
