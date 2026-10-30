# 12. Security Architecture & Threat Defense

Security in APIDash is implemented as a multi-layered defense-in-depth framework spanning authentication, session isolation, request forgery defenses, egress network boundaries, and multi-tenant access control.

---

## 🛡️ Security Architecture Matrix

| Attack Vector | Defense Mechanism | Implementation Details |
| :--- | :--- | :--- |
| **Credential Cracking** | Argon2id Hashing | High-cost hashing parameters (`memoryCost: 65536`, `timeCost: 3`, `parallelism: 1`) resisting GPU/ASIC brute-force attacks. |
| **Session Hijacking** | Hardened Cookies & DB Store | `HttpOnly`, `SameSite=Lax`, `Secure` cookies stored server-side in MySQL via `express-mysql-session`. |
| **Cross-Site Request Forgery** | Double-Submit Token | Custom `x-csrf-token` header validated on all state-mutating methods (`POST`, `PUT`, `DELETE`). |
| **Server-Side Request Forgery** | Socket-Pinned Egress Agent | DNS pre-resolution against IP blacklists + socket connection pinned to pre-validated IP to eliminate DNS rebinding. |
| **Insecure Direct Object Reference** | Workspace-Scoped RBAC | Every SQL query binds `workspace_id` and verifies user membership before reading or writing resources. |
| **Prototype Pollution** | Strict Object Key Filtering | Evaluator explicitly rejects `__proto__`, `constructor`, and `prototype` in dynamic JSON assertion paths. |
| **SQL Injection** | Prepared Statements | Exclusively utilizes `mysql2/promise` parameterized statements (`?` placeholders). No string concatenation. |

---

## 🔑 Authentication & Password Security

APIDash uses **Argon2id**, the winner of the Password Hashing Competition (PHC), for all password storage:
* **Salt Generation:** 16-byte cryptographically secure random salt generated per user via `crypto.randomBytes()`.
* **Resource Cost:** Configured with a 64 MB memory cost (`65536` KiB), 3 iterations, and 1 parallel thread, imposing severe computational costs on offline cracking attempts.
* **Email Canonicalization:** All emails are trimmed and converted to lowercase prior to hashing and database querying, preventing case-variant duplicate account creation.

---

## 🍪 Session Management & CSRF Defense

```mermaid
sequenceDiagram
    autonumber
    participant Browser as Client Browser
    participant API as Express API Server
    participant DB as MySQL Sessions Table

    Note over Browser,API: 1. Authentication Handshake
    Browser->>API: POST /api/auth/login with credentials
    API->>API: Verify Argon2id hash
    API->>DB: INSERT session with user_id and expires
    API-->>Browser: Set-Cookie: connect.sid HttpOnly Secure SameSite=Lax<br/>Set-Cookie: XSRF-TOKEN Path=/
    
    Note over Browser,API: 2. State-Mutating Request - Create Monitor
    Browser->>API: POST /api/monitors<br/>Header: x-csrf-token<br/>Cookie: connect.sid and XSRF-TOKEN
    API->>API: Validate csrfToken matches XSRF-TOKEN cookie
    API->>DB: Validate session in sessions table
    API-->>Browser: 201 Created
```

* **Server-Side Sessions:** Session identifiers are random 128-bit strings. Session payloads reside exclusively in the MySQL `sessions` table.
* **Double-Submit CSRF Protection:** The server issues an un-hashed CSRF token in an accessible cookie (`XSRF-TOKEN`). Frontend JavaScript reads this cookie and transmits it via the `x-csrf-token` HTTP header on mutating requests. The middleware validates header-cookie equality before invoking route handlers.

---

## 🏢 Multi-Tenancy & Workspace IDOR Defense

APIDash implements strict workspace isolation:
1. **Multi-Tenant Hierarchy:** Users belong to one or more Workspaces with either `OWNER` or `MEMBER` roles.
2. **Context Resolution:** The active workspace is passed via request parameter (`/api/workspaces/:workspaceId/...`) or session context.
3. **Guard Middleware (`authMiddleware.js`):**
   * Verifies that the authenticated `user_id` has an active entry in `workspace_members` for the targeted workspace.
   * Enforces role requirements: administrative operations (inviting members, editing notification settings, deleting monitors) strictly require role `OWNER`.
4. **Parameterized Isolation in SQL:** All repository queries explicitly include `workspace_id = ?`:
   ```sql
   SELECT * FROM api_monitors WHERE id = ? AND workspace_id = ?;
   ```
   An authenticated user cannot read or mutate another workspace's monitors simply by guessing or iterating monitor IDs (Insecure Direct Object Reference).


---

## 🤖 AI Telemetry Sanitization & Privacy Defenses

When the optional AI investigation subsystem is enabled (Groq primary, OpenRouter / NVIDIA Nemotron fallback):
* **Egress Credential Scrubbing:** Authorization headers (`Authorization`, `Proxy-Authorization`), cookies, and API keys are stripped from execution traces prior to LLM prompt serialization.
* **URL Credential Stripping:** Embedded user credentials in URLs are replaced with `***:***@`, and sensitive query keys (`token`, `key`, `secret`, `password`, `apiKey`) are masked as `***REDACTED***`.
* **Out-of-Band Boundary:** AI is never in the synchronous monitoring probe or notification hot path; failure of an external AI provider can never disrupt monitor state transitions or email alert delivery.
* **Client Data Sanitization:** `serializeAnalysisForClient()` strips worker lease tokens (`lease_owner_token`, `lease_expires_at`) and redacts API keys matching `gsk_*` and `sk-or-*` from JSON payloads returned to browsers.
