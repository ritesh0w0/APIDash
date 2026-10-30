# APIDash — Phase 2: Security, Authentication, Authorization & SSRF Protection

## 1. Executive Summary

Phase 2 transforms APIDash from a single-user API health monitoring prototype into a multi-tenant, workspace-isolated application with server-side authentication, granular role-based authorization, defensive browser controls, and outbound server-side request forgery (SSRF) defenses.

All security controls are enforced at the server and database layer, backed by a 55-test automated security suite that executes without requiring live database credentials or public Internet access.

---

## 2. Threat Model & Defenses Implemented

| Threat Identifier | Threat Description | Defense Mechanism Implemented |
|---|---|---|
| **Threat A: Cross-Tenant Data Leak / IDOR** | User A accesses or modifies User B's monitor, history, or analytics by changing an ID. | Explicit `/api/workspaces/:workspaceId/...` route scoping, server-side session membership validation, and database-level query filtering (`WHERE workspace_id = ?`). Attempting to access an unauthorized workspace returns a uniform `404 Not Found` to prevent resource enumeration. |
| **Threat B: Server-Side Request Forgery (SSRF)** | Outbound monitor requests target internal loopback, private networks, cloud metadata (`169.254.169.254`), or DNS rebinding. | Centralized URL syntax validation, IP classification via `ipaddr.js` (blocking loopback, RFC 1918, link-local, carrier-grade NAT, metadata, and IPv4-mapped IPv6), pre-request DNS record inspection (rejecting mixed or private results), and socket-level connection pinning (`createPinnedAgents`) to bind socket connections to the approved IP. Manual redirect loops limit hops (max 3) and prevent HTTPS-to-HTTP protocol downgrades. |
| **Threat C: Account & Session Hijacking** | Password leakage, session fixation, stolen localStorage tokens, or CSRF attacks. | Passwords hashed using **Argon2id** (OWASP compliant: memoryCost 19456, timeCost 2, parallelism 1). Browser sessions stored server-side via `express-session` with MySQL backing (`sessions` table). Cookies configured with `HttpOnly`, `SameSite=Lax`, and `Secure` in production. Session IDs regenerated upon login. Synchronizer-token CSRF protection (`X-CSRF-Token`) and Origin validation enforced on all mutating requests. |
| **Threat D: Abuse & Resource Exhaustion** | Password brute force, automated mass registration, connection flooding, or memory bombs from monitored targets. | Configurable rate limiting (`authLimiter`, `probeLimiter`, `apiLimiter`), bounded request payloads (`100kb`), monitor response size capping (`1MB`), and strict HTTP timeouts (`10s`). |

---

## 3. Architecture & Request Flow

```
                      Browser / Frontend
                              │
               (Same-Origin Cookie: apidash_sid)
               (Mutating Header: X-CSRF-Token)
                              ▼
                 Express Application Pipeline
    ┌────────────────────────────────────────────────────────┐
    │ 1. Helmet Security Headers (CSP, Frameguard, etc.)    │
    │ 2. CORS (Restricted to APP_ORIGIN)                    │
    │ 3. Express Body Parsers (Bounded to 100kb)            │
    │ 4. Request Logging (Pino)                             │
    │ 5. Session Middleware (MySQL-backed / Memory in test)  │
    │ 6. CSRF & Origin Verification (createCsrfProtection)  │
    │ 7. Rate Limiters (authLimiter, apiLimiter)            │
    └────────────────────────────────────────────────────────┘
                              │
             ┌────────────────┴────────────────┐
             ▼                                 ▼
   /api/auth/* Routes              /api/workspaces/:workspaceId/*
   - POST /register                 - requireAuth (validates session)
   - POST /login                    - requireWorkspaceMember (IDOR defense)
   - GET  /me                       - requireWorkspaceOwner (roles check)
   - POST /logout                   - Scoped API Monitor & Analytics CRUD
   - GET  /csrf                                │
                                               ▼
                                  Outbound Monitor Probing
                                  (backend/services/tester.js)
                                               │
                                               ▼
                                 SSRF Protection Subsystem
                     ┌──────────────────────────────────────────────┐
                     │ • validateUrlSyntax()                        │
                     │ • resolveAndValidateDestination()            │
                     │ • createPinnedAgents() (defeats rebinding)   │
                     │ • safeMonitoringRequest() (manual redirects) │
                     └──────────────────────────────────────────────┘
                                               │
                                               ▼
                                    Allowed Target Host
```

---

## 4. Authentication & Session Security

### 4.1 Password Storage (Argon2id)
- Password hashing is handled by `backend/services/passwordService.js` using native `argon2`.
- OWASP-recommended parameters:
  - Algorithm: Argon2id (variant 2)
  - Memory cost: 19456 KiB (19 MiB)
  - Time cost: 2 iterations
  - Parallelism: 1 thread
- Input bounds: Passwords must be between 8 and 128 characters.
- Passwords are never logged or returned in responses.

### 4.2 Server-Side Sessions & Cookies
- Stored server-side in MySQL (`sessions` table) in production and staging.
- Memory store used strictly in `NODE_ENV=test` to avoid active cleanup timers and keep test suites deterministic.
- Session regeneration (`req.session.regenerate()`) is performed immediately upon successful registration and login to defeat session fixation.
- Logout invokes `req.session.destroy()` and clears the cookie via `res.clearCookie()`.
- Production cookie security:
  - `httpOnly: true` (inaccessible to JavaScript).
  - `secure: true` (only transmitted over HTTPS in production).
  - `sameSite: 'lax'` (guards against top-level cross-site navigation attacks).
  - Cookie name: `__Host-apidash_sid` in production; `apidash_sid` in development.

### 4.3 CSRF & Request Security
- Synchronizer token pattern implemented in `backend/middleware/csrf.js`.
- Clients retrieve a per-session token via `GET /api/auth/csrf`.
- Mutating operations (`POST`, `PUT`, `PATCH`, `DELETE`) require the token passed in the `X-CSRF-Token` request header.
- Token comparison is performed in constant time using `crypto.timingSafeEqual` to prevent timing attacks.
- `Origin` and `Referer` headers are verified against `APP_ORIGIN`.

---

## 5. Workspaces & Authorization Model

### 5.1 Relational Schema
```
   ┌──────────────┐          ┌──────────────────────┐          ┌────────────────┐
   │    users     │          │  workspace_members   │          │   workspaces   │
   ├──────────────┤          ├──────────────────────┤          ├────────────────┤
   │ id (PK)      │◄───┐     │ id (PK)              │     ┌───►│ id (PK)        │
   │ email (UQ)   │    └─────┤ user_id (FK)         │     │    │ name           │
   │ password_hash│          │ workspace_id (FK)────┼─────┘    │ created_by (FK)│
   │ display_name │          │ role (owner/member)  │          │ created_at     │
   │ created_at   │          │ UQ(ws_id, user_id)   │          └────────────────┘
   └──────────────┘          └──────────────────────┘                   │
                                                                        ▼
                                                               ┌────────────────┐
                                                               │      apis      │
                                                               ├────────────────┤
                                                               │ id (PK)        │
                                                               │ workspace_id   │
                                                               │ name, url, ... │
                                                               └────────────────┘
```

### 5.2 Role & Capability Matrix

| Capability | Owner | Member | Non-Member / Unauthenticated |
|---|:---:|:---:|:---:|
| View workspace monitors, history, and analytics | Yes | Yes | Denied (401/404) |
| Create, edit, and delete monitors | Yes | Yes | Denied (401/404) |
| Trigger on-demand manual probe | Yes | Yes | Denied (401/404) |
| View workspace members list | Yes | Yes | Denied (401/404) |
| Add or remove workspace members | Yes | No (403) | Denied (401/404) |
| Update workspace settings/name | Yes | No (403) | Denied (401/404) |
| Delete workspace | Yes | No (403) | Denied (401/404) |

- **Invariants Enforced:**
  - Registration creates the user, initial workspace, and owner membership inside a single database transaction.
  - A workspace cannot be left without an owner (`countOwners` validation prevents removing or demoting the final owner).
  - Cross-tenant lookups fail closed with `404 Not Found` rather than `403 Forbidden`, preventing attackers from enumerating valid workspace IDs or resource IDs.

---

## 6. SSRF Protection & Outbound Execution Safety

### 6.1 Validation Pipeline (`backend/services/ssrfProtection.js`)
1. **URL Syntax Validation:**
   - Protocol check: strictly `http:` or `https:`.
   - Rejection of embedded credentials (`http://user:pass@host`).
   - Hostname normalization and blocklist check (`localhost`, `*.localhost`, `*.local`, `metadata.google.internal`).
2. **IP Classification (`isForbiddenIp`):**
   - Evaluated via `ipaddr.js`.
   - Rejects:
     - IPv4 loopback (`127.0.0.0/8`, `0.0.0.0`)
     - IPv4 private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
     - Cloud metadata and link-local (`169.254.169.254`, `fd00:ec2::254`, `169.254.0.0/16`)
     - IPv6 loopback (`::1`)
     - IPv6 link-local and unique-local (`fe80::/10`, `fc00::/7`)
     - IPv4-mapped IPv6 addresses (`::ffff:127.0.0.1`, `::ffff:169.254.169.254`)
     - Carrier-grade NAT (`100.64.0.0/10`), broadcast, multicast.
3. **Pre-Execution DNS Resolution:**
   - Evaluates all returned DNS records for the target host.
   - Rejects mixed public/private DNS answers.
4. **Socket Connection Pinning (Anti-DNS-Rebinding):**
   - Standard HTTP clients perform a secondary DNS lookup during socket creation, opening a time-of-check to time-of-use (TOCTOU) DNS rebinding window.
   - `createPinnedAgents` returns custom `http.Agent` and `https.Agent` instances that override the `lookup` socket callback. The socket connection is forced to the verified IP while preserving the original `Host` header and TLS Server Name Indication (SNI) for HTTPS certificate verification.
5. **Manual Redirect Loop:**
   - Automatic HTTP client redirects are disabled (`maxRedirects: 0`).
   - The application inspects 3xx responses manually.
   - Bounded to maximum 3 hops (`SSRF_MAX_REDIRECTS`).
   - Every redirect location is re-validated through the full URL and IP classification checks.
   - Rejects protocol downgrades (HTTPS -> HTTP).
6. **Resource Bounds:**
   - Maximum timeout: default 10s (`SSRF_TIMEOUT_MS`).
   - Maximum response size: default 1MB (`SSRF_MAX_BODY_BYTES`) via `maxContentLength` and `maxBodyLength`.

---

## 7. Database Migrations & Legacy Data Strategy

Phase 2 introduces forward-only migrations following the repository's single-statement migration runner convention:

| Migration File | Description | Rollback / Failure Safeguard |
|---|---|---|
| `004_create_users_table.sql` | Creates `users` table with canonical email uniqueness constraint. | Forward-only, atomic per runner. |
| `005_create_workspaces_table.sql` | Creates `workspaces` table with foreign key to creator. | Forward-only. |
| `006_create_workspace_members_table.sql` | Creates `workspace_members` table with unique `(workspace_id, user_id)`. | Enforces referential integrity. |
| `007_add_workspace_id_to_apis.sql` | Adds nullable `workspace_id INT NULL` column and foreign key to `apis`. | Preserves existing legacy data without destructive schema drop or arbitrary owner assignment. |
| `008_create_sessions_table.sql` | Creates `sessions` table for `express-mysql-session`. | Pre-created explicitly; automatic runtime DDL disabled. |

### Legacy Data Policy
- Legacy monitors created before Phase 2 retain `workspace_id = NULL`.
- All Phase 2 routes enforce `WHERE workspace_id = ?`, rendering unassigned legacy monitors inaccessible to arbitrary users until explicitly backfilled.
- To assign legacy monitors to a designated workspace:
  ```sql
  UPDATE apis SET workspace_id = <target_workspace_id> WHERE workspace_id IS NULL;
  ALTER TABLE apis MODIFY COLUMN workspace_id INT NOT NULL;
  ```

---

## 8. Configuration & Environment Variables

Updated `.env.example` settings:

```bash
# Server & Environment
PORT=5000
NODE_ENV=production
APP_ORIGIN=https://dash.example.com
LOG_LEVEL=info

# Database Credentials
DB_HOST=localhost
DB_PORT=3306
DB_USER=apidash
DB_PASSWORD=your_secure_db_password
DB_NAME=api_monitor

# Authentication & Session Security
# Generate a cryptographically random 32+ character secret:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=your_32_plus_character_session_secret_here
COOKIE_SECURE=true

# SSRF Protection Bounds
SSRF_MAX_REDIRECTS=3
SSRF_TIMEOUT_MS=10000
SSRF_MAX_BODY_BYTES=1048576

# Scheduler Control
ENABLE_LEGACY_SCHEDULER=false
```

---

## 9. Test Suite & Verification Results

The test suite runs using Node's native `node:test` runner and Supertest. All tests run in-memory without contacting MySQL or external network endpoints:

```bash
cd backend
npm test
```

### Test Suite Execution Summary
```
✔ createApp() produces a testable Express app without network port or DB connection (45.66ms)
✔ GET /health preserves exact response shape (8.20ms)
✔ Unmatched GET routes fallback to static index.html or 404 safely (9.88ms)
✔ POST /api/auth/register transactionally creates user and initial workspace with owner role (109.81ms)
✔ POST /api/auth/register rejects duplicate canonicalized email (65.05ms)
✔ POST /api/auth/register validates email and password length bounds (22.74ms)
✔ POST /api/auth/login succeeds with valid credentials and issues session cookie (84.88ms)
✔ POST /api/auth/login returns generic 401 failure for non-existent email or wrong password (66.23ms)
✔ GET /api/auth/me without active session returns 401 safely without leaking internal data (6.03ms)
✔ loadConfig() returns valid defaults with empty object (2.05ms)
✔ loadConfig() respects custom environment variables (0.49ms)
✔ loadConfig() throws ConfigError on invalid PORT (1.21ms)
✔ loadConfig() throws ConfigError on invalid DB_PORT (0.37ms)
✔ loadConfig() throws ConfigError on missing/empty DB_USER or DB_NAME (0.31ms)
✔ loadConfig() enforces password and session secret requirement in production environment (3.77ms)
✔ loadConfig() validates ENABLE_LEGACY_SCHEDULER boolean values (0.44ms)
✔ CSRF protection allows safe GET and HEAD requests without token (55.14ms)
✔ CSRF protection rejects mutating request without X-CSRF-Token header with 403 (21.58ms)
✔ CSRF protection rejects mutating request with invalid or tampered CSRF token with 403 (26.29ms)
✔ CSRF protection allows mutating request with valid token and matching origin (23.88ms)
✔ CSRF protection rejects request when origin header does not match application origin (19.43ms)
✔ importing backend/app does not connect to MySQL, listen, or start scheduler (642.70ms)
✔ importing backend/server does not invoke startServer or start scheduler (4.89ms)
✔ importing backend/db does not create a live MySQL connection pool automatically (0.33ms)
✔ importing services does not make outbound HTTP requests or run queries (0.54ms)
✔ ensureMigrationsTable executes table creation (1.43ms)
✔ getAppliedMigrations returns array of migration names (1.17ms)
✔ runMigrations applies pending migrations in alphabetical order and records them (5.89ms)
✔ runMigrations stops on failure and does not record failed migration (7.11ms)
✔ Unauthenticated request to legacy routes is rejected with 401 (67.08ms)
✔ POST /api/add validates request body and creates an API monitor when authenticated (34.27ms)
✔ GET /api/list returns all registered APIs with their last result when authenticated (14.45ms)
✔ GET /api/test/:id returns 404 for unknown API and test result when found (16.74ms)
✔ DELETE /api/delete/:id returns 404 for missing and 200 when deleted (19.65ms)
✔ GET /api/stats, /api/chart-data, and /api/scheduler-runs return expected shapes (13.82ms)
✔ testApi marks PASS when status matches expected_status (1.27ms)
✔ testApi marks FAIL when status does not match expected_status (0.25ms)
✔ testApi catches network errors and marks FAIL with status_code null (0.34ms)
✔ calcHealthScore calculates appropriate score deductions and clamps between 0-100 (0.25ms)
✔ getApiAnalytics computes uptime, percentiles, failure streak, and hourly aggregation (0.91ms)
✔ validateUrlSyntax permits valid http and https URLs and normalizes hostname (1.49ms)
✔ validateUrlSyntax rejects non-http schemes, malformed URLs, and embedded credentials (1.13ms)
✔ isForbiddenIp rejects IPv4 loopback, private, carrier-grade NAT, and cloud metadata (1.59ms)
✔ isForbiddenIp rejects IPv6 loopback, link-local, unique-local, and IPv4-mapped IPv6 (2.73ms)
✔ resolveAndValidateDestination rejects hostnames with mixed or forbidden DNS records (1.38ms)
✔ createPinnedAgents forces connection socket to use validated IP and prevents DNS rebinding (0.45ms)
✔ safeMonitoringRequest performs manual redirect validation and blocks forbidden redirect destinations (0.96ms)
✔ safeMonitoringRequest rejects HTTPS to HTTP redirect downgrade (0.56ms)
✔ safeMonitoringRequest halts after maximum redirect count (1.02ms)
✔ safeMonitoringRequest succeeds for approved destination and passes pinned agents to client (1.06ms)
✔ Unauthenticated requests to /api/workspaces are rejected with 401 (73.15ms)
✔ User A can view their own workspaces but not workspaces of User B (28.54ms)
✔ Cross-tenant IDOR protection: User A cannot read, modify, or delete User B monitor (21.54ms)
✔ Role-based authorization: Members can view monitors but cannot manage members or settings (31.51ms)
✔ Owner can manage members and settings, but cannot remove the final owner (27.80ms)
ℹ tests 55
ℹ suites 0
ℹ pass 55
ℹ fail 0
ℹ duration_ms 1151.16ms
```

---

## 10. Dependency Review & Unresolved Advisories

A fresh dependency review was conducted via `npm audit --json`:
1. **`body-parser` and `qs` (Moderate/High):**
   - Vulnerability: Denial of service via trailing bytes after compressed request body, and `qs` array-limit parsing bugs.
   - Status: Vendor-bundled in `express@4.22.3`. Express 4 fixes are blocked upstream until Express 5 migration.
   - Mitigation: Body parsing is bounded to `100kb` (`express.json({ limit: '100kb' })`), rate limits protect all endpoints, and compressed payloads are not accepted from untrusted origins.
2. **`express-mysql-session` -> `mysql2` (Moderate/High):**
   - Vulnerability: Unbounded zlib inflate in compressed MySQL protocol handler and auth plugin downgrade.
   - Status: `express-mysql-session@3.0.3` bundles its own internal `mysql2@3.2.0`.
   - Mitigation: APIDash connects to local or internal private MySQL without compressed protocol enabled (`compress: false`). No unencrypted remote MySQL connections are permitted.

---

## 11. Known Limitations & Future Work

1. **Email Delivery & Verification:**
   - Password reset, email verification, and email workspace invitation flows were intentionally deferred to Phase 3/4. Workspace owners currently add registered members directly by email.
2. **Egress Firewall / Network-Level Controls:**
   - Application-level SSRF protection is robust against rebinding and private addresses. However, defense-in-depth requires host-level or VPC-level egress firewalls blocking access to cloud metadata endpoints (`169.254.169.254`) at the hypervisor/network routing layer.
3. **Multi-Process Rate Limiting:**
   - Rate limiting currently uses an in-memory store suitable for single-process deployments. Clustered or containerized deployments across multiple nodes will require a shared Redis store for global rate limiting.
