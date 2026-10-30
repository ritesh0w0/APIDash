# APIDash — Phase 1: Backend Foundation Documentation

- **Phase:** Phase 1 (Complete Backend Foundation)
- **Status:** Complete & Verified
- **Date:** 2026-10-27
- **Auditor & Author:** Senior Software Engineer (Antigravity Agentic Pair)

---

## 1. Executive Summary

Phase 1 refactors APIDash from a tightly coupled script into a **modular, testable, and predictable backend foundation**. All existing business rules, analytics algorithms, and API contracts are fully preserved, while database schema mutations, scheduler triggers, and network listeners have been decoupled from module imports.

### Key Accomplishments in Phase 1

1. **Application Factory Separation (`createApp`)**:  
   `backend/app.js` exposes `createApp()`. Constructing or importing the app does not open an HTTP port, connect to MySQL, run migrations, or start any timer loops.
2. **Controlled Process Lifecycle (`startServer` / `stopServer`)**:  
   `backend/server.js` manages explicit startup, database connectivity verification, graceful signal handling (`SIGINT`, `SIGTERM`), and server/pool drainage.
3. **Legacy Scheduler Disabled by Default**:  
   The recurring 30-second in-process monitoring loop is **disabled by default**. It can only be activated via the transitional flag `ENABLE_LEGACY_SCHEDULER=true`.
4. **Structured Data Access Layer (`backend/data/`)**:  
   Raw SQL queries have been extracted from Express route handlers into cohesive repositories: `apiRepository`, `testResultRepository`, and `schedulerRunRepository`.
5. **Environment Configuration & Validation (`backend/config.js`)**:  
   `loadConfig()` provides pure, testable environment validation with strict bounds (port checks, production password enforcement, boolean flag parsing).
6. **Explicit Versioned Migration System (`backend/migrations/` & `npm run db:migrate`)**:  
   Replaced runtime DDL auto-creation with a deterministic migration runner (`backend/scripts/migrate.js`) tracking applied scripts in `schema_migrations`.
7. **Structured Logging & Centralized Error Handling**:  
   Integrated `pino` and `pino-http` with sensitive field redaction (passwords, tokens, cookies). Centralized error middleware prevents stack trace or credential leaks.
8. **Same-Origin Frontend API Compatibility**:  
   Updated `frontend/app.js` from hardcoded `http://localhost:5000/api` to relative `/api`, supporting any port, hostname, or reverse proxy.
9. **Automated Testing Suite (28 Tests Passing)**:  
   Standard `npm test` script executing via Node.js built-in `node:test` and `supertest`. All tests run without requiring MySQL credentials or external network access.
10. **Dependency Vulnerability Triage**:  
    Resolved the critical vulnerability (`proxy-addr`) and high vulnerabilities (`follow-redirects`, `brace-expansion`, `form-data`, `axios`, `mysql2`).

---

## 2. Resulting Architecture & Module Responsibilities

```text
┌─────────────────────────────────────────────────────────────┐
│                       Browser Client                        │
│          (HTML5, CSS3, app.js [API_BASE = '/api'])          │
└──────────────────────────────┬──────────────────────────────┘
                               │ fetch()
                               ▼
┌─────────────────────────────────────────────────────────────┐
│           Express Application (backend/app.js)              │
│                                                             │
│  • Middleware: cors(), express.json(), requestLogger (pino) │
│  • Static Files: ../frontend -> index.html, style.css       │
│  • Router: /api -> backend/routes/apiRoutes.js              │
│  • Health Probe: GET /health -> { status: 'ok', uptime }    │
│  • Error Handler: backend/middleware/errors.js              │
└──────────────────────────────┬──────────────────────────────┘
                               │
            ┌──────────────────┴──────────────────┐
            ▼                                     ▼
┌──────────────────────────────┐    ┌──────────────────────────────┐
│   HTTP Routes & Handlers     │    │       Services Layer         │
│ (backend/routes/apiRoutes.js)│    │ (tester.js, analytics.js)    │
└──────────────┬───────────────┘    └─────────────┬────────────────┘
               │                                  │
               └─────────────────┬────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────┐
│          Data Access Layer (backend/data/)                  │
│                                                             │
│  • apiRepository.js        (CRUD, stats, monitor queries)   │
│  • testResultRepository.js (history, sparkline, time-window)│
│  • schedulerRunRepository.js (batch run history)            │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│          Database Connection Pool (backend/db.js)           │
│                                                             │
│  • getPool(), closePool(), pingDatabase()                   │
│  • Lazy initialization (no connection on require)           │
└─────────────────────────────────────────────────────────────┘
```

### Module Inventory

| File Path | Primary Responsibility |
| :--- | :--- |
| `backend/app.js` | Pure Express application factory (`createApp`). Zero network, DB, or scheduler side-effects. |
| `backend/server.js` | Process entry point (`startServer`, `stopServer`), signal handlers, transitional scheduler guard. |
| `backend/config.js` | Pure environment validation (`loadConfig`). Validates types, ranges, production security rules. |
| `backend/logger.js` | Shared structured logger (`pino`) with field redaction and test auto-muting. |
| `backend/db.js` | Connection pool lifecycle (`getPool`, `closePool`, `pingDatabase`). |
| `backend/data/apiRepository.js` | Encapsulates all SQL queries for the `apis` table. |
| `backend/data/testResultRepository.js` | Encapsulates all SQL queries for the `test_results` table. |
| `backend/data/schedulerRunRepository.js` | Encapsulates all SQL queries for the `scheduler_runs` table. |
| `backend/services/tester.js` | Outbound HTTP probing engine (`testApi`, `testAllApis`) with dependency injection. |
| `backend/services/analytics.js` | Uptime %, P50/P95 tail latency, failure streaks, and composite health score math. |
| `backend/middleware/errors.js` | AppError, ValidationError, NotFoundError, asyncHandler, and centralized error handler. |
| `backend/middleware/requestLogger.js`| Structured HTTP request logging via `pino-http`. |
| `backend/scripts/migrate.js` | Deterministic migration runner tracking applied migrations in `schema_migrations`. |
| `backend/migrations/*.sql` | Ordered baseline migrations (001_apis, 002_test_results, 003_scheduler_runs). |
| `frontend/app.js` | Client-side dashboard logic using same-origin `API_BASE = '/api'`. |

---

## 3. Configuration & Environment Variables

Environment variables are validated via `loadConfig()` in `backend/config.js`:

| Variable | Type | Default | Description / Validation Rules |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | string | `development` | Must be `development`, `production`, or `test`. |
| `PORT` | integer | `5000` | Port for the HTTP server (1–65535). |
| `DB_HOST` | string | `localhost` | MySQL server hostname or IP. Cannot be empty. |
| `DB_PORT` | integer | `3306` | MySQL server port (1–65535). |
| `DB_USER` | string | `root` | MySQL user. Cannot be empty. |
| `DB_PASSWORD` | string | `""` | MySQL password. **Required and cannot be empty if `NODE_ENV=production`**. |
| `DB_NAME` | string | `api_monitor` | Target database name. Cannot be empty. |
| `ENABLE_LEGACY_SCHEDULER` | boolean | `false` | Transitional switch. Accepts `true`, `false`, `1`, `0`. |
| `LOG_LEVEL` | string | `info` | Logging level (`debug`, `info`, `warn`, `error`, `silent`). Silent in tests. |

---

## 4. Database Setup & Migration Workflow

### Fresh Installation Procedure

1. **Create the Target Database in MySQL:**
   ```sql
   CREATE DATABASE IF NOT EXISTS api_monitor CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```
2. **Configure Environment:**
   ```bash
   cp backend/.env.example backend/.env
   # Edit backend/.env with your DB_USER, DB_PASSWORD, and DB_NAME
   ```
3. **Execute Versioned Migrations:**
   ```bash
   npm run db:migrate --prefix backend
   ```
4. **Launch the Application:**
   ```bash
   npm start --prefix backend
   ```

### Migration Technical Design
- The runner creates and inspects `schema_migrations (id, name, applied_at)`.
- Discovers SQL files in `backend/migrations/` sorted alphabetically.
- Each migration file contains exactly **one statement**, avoiding MySQL multi-statement hazards.
- If a migration fails, the runner logs the error, terminates immediately with exit code 1, and does **not** record the failed file in `schema_migrations`.
- **MySQL Limitation Note:** DDL statements in MySQL cannot be rolled back inside a transaction. In the event of a failed migration, manual cleanup of any partially created objects is required before re-running `npm run db:migrate`.

---

## 5. How to Run Tests

The test suite utilizes Node.js's native test runner (`node:test`) and `supertest`:

```bash
cd backend
npm test
```

### Verified Test Categories (28 Passing Tests):
- **Application Factory Tests (`backend/test/app.test.js`)**: Tests `createApp()` and `/health` contract without opening ports or requiring MySQL.
- **Configuration Tests (`backend/test/config.test.js`)**: Tests bounds checking, invalid ports, missing users, and production password enforcement.
- **Import Side-Effect Tests (`backend/test/importSideEffects.test.js`)**: Verifies that importing any backend module causes zero network, DB, or timer side effects.
- **Route Integration Tests (`backend/test/routes.test.js`)**: Exercises all 10 REST endpoints with mock repositories.
- **Service Unit Tests (`backend/test/services.test.js`)**: Verifies probe pass/fail rules, latency measurements, uptime %, P95 calculations, and health score math.
- **Migration Runner Tests (`backend/test/migrate.test.js`)**: Tests schema creation, deterministic order, and failure abortion.

---

## 6. Dependency Vulnerability Status

| Package | Severity | Dependency Path | Status | Resolution / Action |
| :--- | :--- | :--- | :--- | :--- |
| `proxy-addr` | **Critical** | `express -> proxy-addr` | **RESOLVED** | Updated via semver patch `~2.0.7` to `2.0.8`. |
| `follow-redirects` | **High** | `axios -> follow-redirects` | **RESOLVED** | Updated via semver patch to `1.16.1`. |
| `form-data` | **High** | `axios -> form-data` | **RESOLVED** | Updated via semver patch to `4.0.6`. |
| `brace-expansion` | **High** | `nodemon -> minimatch -> brace-expansion` | **RESOLVED** | Updated via semver patch to `5.0.12`. |
| `axios` | **High** | Direct dependency | **RESOLVED** | Updated to `^1.21.0` (fixes ReDoS and resource limits). |
| `mysql2` | **Moderate** | Direct dependency | **RESOLVED** | Updated to `^3.24.6` (fixes zlib protocol decompress bomb). |
| `body-parser` / `qs` | **High** / **Mod** | `express@4.22.3 -> body-parser` | **DEFERRED (Phase 2+)** | Requires upgrading to Express 5.x (`express@^5.3.0`), which introduces breaking routing and error handling changes. Retained for stability in Phase 1. |

---

## 7. Security Warnings & Remaining Limitations

> [!WARNING]
> **Phase 1 does NOT implement Authentication, Authorization, or comprehensive SSRF Protection.**  
> APIDash remains an internal developer tool. It must **NOT** be exposed publicly or to untrusted networks until Phase 2 (Security, Authentication, and SSRF Protections) is completed.

### Known Limitations in Phase 1:
1. **Transitional Scheduler:** The in-process scheduler (`testAllApis`) remains embedded in `server.js` behind `ENABLE_LEGACY_SCHEDULER=true`. Phase 4 will migrate this to an isolated, standalone worker process.
2. **Express 5 Migration:** Transitive advisories in `body-parser` are deferred until Express 5 is adopted.
3. **Outbound Probe Customization:** Target APIs currently only support URL and Method. Custom headers, authentication tokens, and request body payloads are planned for Phase 3.
