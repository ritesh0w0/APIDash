# 09. Notification System & Durable Outbox

The APIDash notification subsystem is responsible for delivering timely, reliable incident alerts to authorized workspace stakeholders without blocking HTTP operations or dropping messages during transport outages.

---

## 📬 The Durable Outbox Pattern

To guarantee that email notifications are never lost if the email delivery service or network experiences temporary downtime, APIDash implements the **Durable Outbox Pattern**:

```mermaid
sequenceDiagram
    autonumber
    participant Coord as Monitoring Coordinator
    participant DB as MySQL (notification_outbox)
    participant W as Notification Dispatcher (Worker)
    participant SMTP as Gmail SMTP Relay
    participant Recipient as Workspace Owner / Member

    Coord->>DB: INSERT INTO notification_outbox<br/>(status='PENDING', recipient_email, payload)
    Note over Coord,DB: Written inside the same transaction<br/>that marks incident OPEN/RESOLVED

    loop Every 1 Second
        W->>DB: SELECT * FROM notification_outbox WHERE status='PENDING' LIMIT 5 FOR UPDATE SKIP LOCKED
        W->>SMTP: Send Email via TLS (smtp.gmail.com:587)
        alt Delivery Succeeded
            SMTP-->>W: 250 2.0.0 OK
            W->>DB: UPDATE notification_outbox SET status='SENT', sent_at=NOW()
            SMTP->>Recipient: Deliver Alert to Inbox
        else Delivery Failed / Network Timeout
            SMTP-->>W: Connection Refused / Timeout
            W->>DB: UPDATE notification_outbox SET attempts=attempts+1, next_retry_at=NOW()+INTERVAL (attempts * 60)s
        end
    end
```

### Outbox Reliability Principles
1. **Transactional Insertion:** Outbox entries are inserted in the exact same database transaction as the incident state change. If the transaction rolls back, no ghost notification is sent; if it commits, the notification is guaranteed to be in the queue.
2. **Exponential Backoff:** If the SMTP server returns an error or times out, the message enters exponential retry intervals ($1 \times 60\text{s}$, $2 \times 60\text{s}$, $4 \times 60\text{s}$, etc.) up to a maximum of 5 attempts before being flagged `FAILED`.
3. **Graceful Degradation:** If SMTP credentials are not configured in the environment (`SMTP_USER` is empty), the outbox marks items `SKIPPED` and surfaces a warning banner in the dashboard without failing the monitoring run.

---

## 👥 Authorized Recipient Security & Workspace Isolation

To prevent workspace users from entering arbitrary external email addresses (which could turn the platform into an open email relay or spam proxy), notifications can **only** be routed to verified members of that workspace.

```mermaid
graph TD
    UI["Workspace Notification Settings"] -->|PUT /api/workspaces/:id/notification-settings| Route["workspaceRoutes.js"]
    Route --> AuthCheck{"1. Is Caller Workspace Owner?"}
    AuthCheck -->|No| Reject403["403 Forbidden"]
    AuthCheck -->|Yes| MemberCheck{"2. Are all recipient_user_ids<br/>active members of this workspace?"}
    MemberCheck -->|Contains Invalid/External ID| Reject400["400 Bad Request<br/>(Unauthorized Recipient)"]
    MemberCheck -->|All IDs Valid| Save["Persist Settings in workspace_notification_settings"]
```

### The Numeric User ID Architecture & Hardening
During production integration, an issue was resolved where frontend checkbox serialization converted undefined membership fields into `NaN`, serializing to `[null]` in JSON and triggering a Zod schema validation error (`recipient_user_ids.0: Invalid input: expected number, received null`).

The fix hardened both ends of the pipeline:
* **Repository Alignment:** `workspaceRepository.findMembers` explicitly aliases `u.id AS id, wm.user_id`, guaranteeing a numeric identifier across all object representations.
* **Frontend Strict Parsing:** `frontend/app.js` extracts `Number(m.user_id ?? m.id)` and filters against `Number.isInteger(id) && id > 0`, explicitly rejecting `null`, `undefined`, or `0`.
* **Backend Zod Schema:** Strictly validates `recipient_user_ids` as `z.array(z.number().int().positive())`.

---

## ✉️ SMTP Configuration & Transport

In the production deployment, emails are delivered through a dedicated Google Workspace SMTP Relay:

* **Host:** `smtp.gmail.com`
* **Port:** `587` (STARTTLS)
* **Authentication:** App Password authentication (`ryyf lzwa xurh yatx`) associated with `apidash.alerts@gmail.com`.
* **Security:** Enforces opportunistic TLS 1.3 encryption during transport.
