# ⚡ APIDash — Automated API Testing & Observability Platform (MVP)

[![Node.js](https://img.shields.io/badge/Node.js-v18+-68a063?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express.js](https://img.shields.io/badge/Express.js-4.19-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
[![MySQL](https://img.shields.io/badge/MySQL-8.0-4479A1?style=for-the-badge&logo=mysql&logoColor=white)](https://www.mysql.com/)
[![Chart.js](https://img.shields.io/badge/Chart.js-4.4-FF6384?style=for-the-badge&logo=chartdotjs&logoColor=white)](https://www.chartjs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)](LICENSE)

> **A lightweight, automated API health monitoring and observability platform that runs continuous background probes, records latency trends, computes percentile telemetry (P95, Uptime %, Failure Streaks), and visualizes system reliability through an interactive dashboard.**

---

## 📌 Executive Summary

Modern web and microservice architectures depend on dozens of interconnected APIs. Standard uptime monitors only answer a binary question: *"Did the server respond?"* They frequently miss **silent degradations**, such as:
- A server returning HTTP `500` or `404` while remaining reachable.
- High latency tail-events where average response time looks fine, but the 95th percentile (P95) exceeds acceptable SLAs.
- Intermittent failure bursts that cause cascading microservice failures.

**APIDash** solves this by operating as an automated background observability agent. It continuously probes registered endpoints at 30-second cycles, validates HTTP status codes and response latencies, persists telemetry in MySQL, and provides deep operational metrics (P50, P95, uptime percentage, failure streaks, and hourly error breakdowns).

---

## 🏗️ Architecture & Data Flow

```text
 ┌────────────────────────────────────────────────────────┐
 │                   User / Dashboard                     │
 │          (HTML5 / Modern Glassmorphism CSS / Vanilla JS) │
 └──────────────┬─────────────────────────▲───────────────┘
                │ Register / Test         │ Telemetry & Charts
                ▼                         │ (Chart.js)
 ┌────────────────────────────────────────────────────────┐
 │               Express.js REST API Server               │
 │                    (Node.js Runtime)                   │
 └──────┬───────────────────┬──────────────────────▲──────┘
        │ Schedule          │ Persist              │ Query
        ▼                   ▼                      │
 ┌──────────────┐    ┌──────────────┐     ┌────────┴─────────┐
 │ Background   │    │ MySQL Relational│  │ Analytics &      │
 │ Scheduler    ├───►│ Database     │     │ Telemetry Engine │
 │ (30s cycle)  │    │ (mysql2 pool)│     │ (P95, Uptime,    │
 └──────┬───────┘    └──────────────┘     │  Streak, Errors) │
        │ Dispatches                      └──────────────────┘
        ▼
 ┌──────────────┐
 │ Axios Engine │ ──── HTTP Requests ───►  Target External /
 │ (10s timeout)│ ◄─── Status & Latency ── Internal APIs
 └──────────────┘
```

### End-to-End Workflow:
1. **API Registration:** User registers an endpoint with its URL, HTTP method (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`), and expected status code (e.g., `200`).
2. **Asynchronous Background Scheduling:** A Node.js background timer triggers concurrent probe cycles across all registered endpoints every **30 seconds**.
3. **Execution Engine:** Axios sends the outbound HTTP request with a 10-second hard timeout, recording exact millisecond elapsed latency, HTTP status code, and any socket/network errors.
4. **Validation Layer:** Evaluates response criteria (`status_code === expected_status`) to tag the run as `PASS` or `FAIL`.
5. **Persistence:** Raw test telemetry is written to MySQL (`test_results` table) and scheduler batch aggregates are written to `scheduler_runs`.
6. **Analytics Computation:** Calculates uptime %, rolling average latency, P50/P95 tail latencies, consecutive failure streaks, and aggregate health scores (0–100).
7. **Visualization:** Chart.js streams real-time latency graphs, scheduler cycle breakdown bar charts, and individual endpoint health cards.

---

## 💻 Tech Stack & Engineering Rationale

| Layer | Technology | Engineering Rationale |
| :--- | :--- | :--- |
| **Backend Runtime** | **Node.js** (v18+) | Asynchronous, non-blocking event loop ideal for high-concurrency network I/O and non-blocking external API pings. |
| **Server Framework** | **Express.js** | Minimalist, predictable REST API routing with lightweight JSON middleware. |
| **HTTP Client** | **Axios** | Robust promise-based client supporting custom timeouts (10s), headers, and non-throwing status validation (`validateStatus: () => true`). |
| **Background Scheduler** | **Native Timer Loop** (`setInterval`) | Lightweight, dependency-free timer mechanism executing concurrent probes every 30s with automatic warm-up delay. |
| **Database** | **MySQL 8.0** (`mysql2/promise`) | Relational persistence with connection pooling (`connectionLimit: 10`) for structured historical time-series queries and cascading deletes. |
| **Frontend UI** | **HTML5, CSS3, Vanilla JS** | Pure native DOM manipulation without heavy framework overhead; fast rendering with modern glassmorphism aesthetics and dark mode. |
| **Data Visualization** | **Chart.js (v4.4)** | Canvas-rendered time-series graphs for latency trends and stacked bar charts for scheduler cycle passes/fails. |

---

## 🗄️ Database Schema Design

The application utilizes three normalized tables in MySQL with referential integrity (`ON DELETE CASCADE`):

```sql
-- 1. Registered API Endpoints
CREATE TABLE IF NOT EXISTS apis (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  name            VARCHAR(255)   NOT NULL,
  url             TEXT           NOT NULL,
  method          VARCHAR(10)    NOT NULL DEFAULT 'GET',
  expected_status INT            NOT NULL DEFAULT 200,
  created_at      DATETIME       DEFAULT CURRENT_TIMESTAMP
);

-- 2. Granular Test Execution History
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

-- 3. High-level Scheduler Batch Cycle Logs
CREATE TABLE IF NOT EXISTS scheduler_runs (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  total      INT NOT NULL DEFAULT 0,
  passed     INT NOT NULL DEFAULT 0,
  failed     INT NOT NULL DEFAULT 0,
  avg_ms     INT,
  ran_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 📊 Core Observability Metrics Explained

* **Uptime Percentage:**  
  $$\text{Uptime \%} = \left(\frac{\text{Passed Checks}}{\text{Total Checks}}\right) \times 100$$  
  Computed dynamically across selectable time windows (1h, 6h, 24h, 48h, 7d).
* **P95 Latency (95th Percentile):**  
  Response time below which 95% of all requests fell. Crucial because simple arithmetic averages mask severe tail-latency spikes that degrade end-user experience.
* **Failure Streak:**  
  Tracks consecutive failures in reverse chronological order. A sudden streak of 3+ failures flags critical downtime requiring immediate attention.
* **Composite Health Score (0–100):**  
  A weighted heuristic combining uptime deductions (up to -50), latency penalties (up to -30 for $P95 > 2000\text{ms}$)$, and consecutive failure streaks (-5 per consecutive fail, up to -20).

---

## 🔌 REST API Reference

| Method | Endpoint | Description | Sample Query / Body |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/add` | Register an API endpoint | `{"name": "Auth API", "url": "https://api.example.com/health", "method": "GET", "expected_status": 200}` |
| `GET` | `/api/list` | List all monitored APIs with last known status | — |
| `GET` | `/api/test/:id` | Trigger an immediate manual probe for an API | — |
| `DELETE` | `/api/delete/:id`| Remove an API and its associated test history | — |
| `GET` | `/api/history/:id`| Fetch the last 20 raw executions for an API | — |
| `GET` | `/api/stats` | Aggregated dashboard stats (total, passing, failing, avg ms) | — |
| `GET` | `/api/chart-data`| Last 10 execution data points per API formatted for Chart.js | — |
| `GET` | `/api/analytics/summary` | Global observability summary over $N$ hours (`?hours=24`) | `?hours=24` |
| `GET` | `/api/analytics/:id` | Detailed telemetry & error breakdown for a single API | `?hours=24` |
| `GET` | `/api/scheduler-runs` | Batch cycle logs for the scheduler timeline graph | — |
| `GET` | `/health` | Backend server self-health probe | Returns `{ status: "ok", uptime: seconds }` |

---

## 🚀 Getting Started & Local Setup

### 1. Prerequisites
- **Node.js** (v18.0.0 or higher)
- **npm** (v9.0.0 or higher)
- **MySQL Server** (local instance or cloud database like AWS RDS / PlanetScale / Aiven)

### 2. Clone the Repository
```bash
git clone https://github.com/ritesh0w0/api-health-monitor.git
cd api-health-monitor
```

### 3. Configure Database & Environment
Navigate to the `backend` directory:
```bash
cd backend
cp .env.example .env
```

Open `.env` and fill in your MySQL credentials:
```env
PORT=5000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=api_monitor
```

> **Note:** The server will automatically create the database `api_monitor` and all required tables upon starting if they do not exist.

### 4. Install Dependencies & Launch
```bash
# Install backend dependencies
npm install

# Start the server (serves both API and static dashboard)
npm start

# Or run with auto-reload during development
npm run dev
```

### 5. Open the Dashboard
Open your browser and navigate to:
```text
http://localhost:5000
```
- **Dashboard Tab:** Add endpoints, trigger on-demand tests, view the live response time line chart.
- **Analytics Tab:** Inspect global uptime, P95 latency, scheduler execution timeline, and individual endpoint error distributions.

---

## 🎯 Current Implementation vs. Future Scope (No Buzzword Exaggerations)

To maintain absolute credibility on resumes and technical interviews, here is the honest delineation of what is built versus what is planned:

### ✅ Implemented in MVP:
- [x] Full-stack architecture with single-server static frontend serving.
- [x] Dynamic API registration (CRUD endpoints with method and status constraints).
- [x] Automated 30-second background testing loop via Node.js event loop.
- [x] On-demand single API manual execution with modal JSON payload inspection.
- [x] Status-code and elapsed-latency validation.
- [x] Relational historical persistence with indexed queries and cascading cleanups.
- [x] Telemetry math: Uptime %, Average ms, P50 ms, P95 ms, consecutive failure streaks.
- [x] Interactive Chart.js multi-dataset line graph and stacked scheduler bar chart.
- [x] Time-windowed analytics (1h, 6h, 24h, 48h, 7d).

### 🔮 Planned Enhancements (Phase 2 Roadmap):
- [ ] Automated email and webhook notifications (Slack / Discord / PagerDuty alerts on failure streaks).
- [ ] Custom request body and authentication headers (Bearer token, API key, Basic auth).
- [ ] JSON response schema validation (using Zod or JSON Schema).
- [ ] Multi-region distributed probe workers for geolocation-based latency benchmarking.
- [ ] User authentication and multi-tenant organization workspaces.

