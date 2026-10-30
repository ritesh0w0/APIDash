# 03. Deployment Architecture

APIDash is deployed to a hardened, cost-efficient cloud environment on Microsoft Azure. It follows a lean infrastructure paradigm: a single, properly sized Virtual Machine hosting the reverse proxy, API server, background worker daemon, and relational database without the complexity and overhead of container orchestration layers like Docker or Kubernetes.

---

## ☁️ Azure Cloud Infrastructure Topology

```mermaid
graph TB
    subgraph AzureRegion ["Microsoft Azure — Region: Central India"]
        subgraph RG ["Resource Group: rg-apidash"]
            subgraph VNet ["Virtual Network / NSG"]
                subgraph VM ["Ubuntu 24.04 LTS VM (Standard_B2ls_v2)"]
                    
                    subgraph Edge ["Nginx Reverse Proxy (Ports 80 & 443)"]
                        Certbot["Certbot TLS 1.3<br/>(Let's Encrypt Auto-Renewal)"]
                        Nginx["Nginx Web Server"]
                    end

                    subgraph AppServices ["Systemd Managed Daemons"]
                        APIService["apidash-api.service<br/>(Node.js API, 127.0.0.1:5000)"]
                        WorkerService["apidash-worker.service<br/>(Background Worker Daemon)"]
                        BackupTimer["apidash-backup.timer<br/>(Nightly 02:00 UTC MySQL Dumps)"]
                    end

                    subgraph DBEngine ["Local Storage & Database"]
                        MySQL["MySQL 8.0 Engine<br/>(127.0.0.1:3306)"]
                        Storage["Local NVMe OS Disk<br/>(/opt/apidash & /var/backups)"]
                    end
                end
            end
        end
    end

    Internet["Public Internet / Client Browser"] -->|Port 443 HTTPS| Nginx
    Internet -->|Port 80 HTTP (Redirected)| Nginx
    Nginx -->|Reverse Proxy /api/ & static frontend| APIService
    Nginx -->|Serves Static Files directly| Storage

    APIService -->|Loopback TCP| MySQL
    WorkerService -->|Loopback TCP| MySQL
    BackupTimer -->|Dumps SQL| Storage

    WorkerService -->|Egress HTTP/S Probes| RemoteAPIs["Monitored External APIs"]
    WorkerService -->|Egress Port 587 TLS| Gmail["smtp.gmail.com:587"]
    WorkerService -->|Egress Port 443 HTTPS| GroqOpenRouter["AI Inference APIs"]
```

---

## 🖥️ Virtual Machine Specifications

| Parameter | Azure Production Configuration |
| :--- | :--- |
| **Resource Group** | `rg-apidash` |
| **VM Name** | `apidash` |
| **Region** | `centralindia` (Central India) |
| **VM Size** | `Standard_B2ls_v2` (2 vCPU, 4 GiB Memory) |
| **Operating System** | Ubuntu Server 24.04.5 LTS (Noble Numbat) |
| **Public IP** | `20.219.5.208` (Dynamic Public IP allocated under Azure DNS) |
| **Fully Qualified Domain Name (FQDN)** | `apidash-7f29a6.centralindia.cloudapp.azure.com` |
| **Live Origin URL** | `https://apidash-7f29a6.centralindia.cloudapp.azure.com` |
| **SSH Management** | ED25519 key-pair (`apidash-oracle-ed25519`) with non-root user `azureuser` |

> [!NOTE]
> **Cloud Cost Control & Deallocation Policy:**
> To eliminate unnecessary cloud compute expenditures when demonstrations or active quality assurance audits are not in progress, the Azure VM instance `apidash` is systematically stopped and deallocated (`az vm deallocate`). During deallocated intervals, compute billing is paused ($0.00/hour) while disk storage and networking configurations are preserved. Upon starting the VM, all systemd services (`mysql`, `nginx`, `apidash-api`, `apidash-worker`) automatically bootstrap and resume operations seamlessly.

---

## 🔒 Nginx Reverse Proxy & TLS Configuration

Nginx acts as the edge gateway, terminating TLS, serving static frontend assets directly, enforcing HTTPS redirection, and proxying API traffic to Express.

### Nginx Routing & Directives
* **Port 80 (HTTP):** Enforces a permanent `301 Moved Permanently` redirect to `https://$host$request_uri`.
* **Port 443 (HTTPS):**
  * **TLS Certificate:** Publicly trusted Let's Encrypt certificate managed via `certbot` and `python3-certbot-nginx`.
  * **Protocols:** `TLSv1.2` and `TLSv1.3` with high-security cipher suites.
  * **HSTS:** `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
  * **Static Ingestion:** Requests to `/` serve `/opt/apidash/current/frontend/index.html` with cache invalidation policies for HTML and aggressive caching for immutable JS/CSS.
  * **API Reverse Proxy:** Requests matching `/api/` are forwarded to `http://127.0.0.1:5000` with standard upstream proxy headers (`X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`, `Host`).

---

## 🛠️ Systemd Daemon Architecture

The backend runtime on Ubuntu is managed via two independent systemd unit services and an automated backup timer.

### 1. Web API Daemon (`/etc/systemd/system/apidash-api.service`)
```ini
[Unit]
Description=APIDash Express API Server
After=network.target mysql.service
Wants=mysql.service

[Service]
Type=simple
User=azureuser
WorkingDirectory=/opt/apidash/current/backend
EnvironmentFile=/etc/apidash/db.env
EnvironmentFile=/etc/apidash/app.env
ExecStart=/usr/bin/node /opt/apidash/current/backend/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=apidash-api

[Install]
WantedBy=multi-user.target
```

### 2. Dedicated Worker Daemon (`/etc/systemd/system/apidash-worker.service`)
```ini
[Unit]
Description=APIDash Background Monitoring and Notification Worker
After=network.target mysql.service
Wants=mysql.service

[Service]
Type=simple
User=azureuser
WorkingDirectory=/opt/apidash/current/backend
EnvironmentFile=/etc/apidash/db.env
EnvironmentFile=/etc/apidash/app.env
ExecStart=/usr/bin/node /opt/apidash/current/backend/worker.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=apidash-worker

[Install]
WantedBy=multi-user.target
```

### 3. Automated Backup Timer (`/etc/systemd/system/apidash-backup.timer`)
* Triggers `/usr/local/bin/apidash-backup.sh` every night at `02:00 UTC`.
* Executes a consistent `mysqldump --single-transaction --quick` of the `apidash` database.
* Compresses dumps into `/var/backups/apidash/` and rotates backups older than 14 days.

---

## 🔐 Environment & Secret Isolation

Sensitive configuration values are isolated from the Git repository and stored strictly on the VM filesystem:
* `/etc/apidash/db.env` (Permissions `0600`, owned by `azureuser`): Contains `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD`.
* `/etc/apidash/app.env` (Permissions `0600`, owned by `azureuser`): Contains `PORT`, `NODE_ENV=production`, `SESSION_SECRET`, `SMTP_*` credentials, and optional `AI_*` inference tokens.
