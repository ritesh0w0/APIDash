/* app.js — API Health Monitor Frontend Logic (Phase 2 Multi-tenant & Security) */
const API_BASE = '/api';

// ── Application State ─────────────────────────────────────────────────────────
let currentCsrfToken = null;
let currentUser = null;
let userWorkspaces = [];
let activeWorkspaceId = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const addApiForm = document.getElementById('addApiForm');
const addBtn = document.getElementById('addBtn');
const addFeedback = document.getElementById('addFeedback');
const apiListEl = document.getElementById('apiList');
const emptyState = document.getElementById('emptyState');
const refreshBtn = document.getElementById('refreshBtn');
const totalCountEl = document.getElementById('totalCount');

const resultModal = document.getElementById('resultModal');
const modalClose = document.getElementById('modalClose');
const modalTitle = document.getElementById('modalTitle');
const resultBadge = document.getElementById('resultBadge');
const resultGrid = document.getElementById('resultGrid');
const resultJsonEl = document.getElementById('resultJson');
const toastEl = document.getElementById('toast');

// ── Auth & Workspace DOM refs ────────────────────────────────────────────────
const authModal = document.getElementById('authModal');
const authTabLogin = document.getElementById('authTabLogin');
const authTabRegister = document.getElementById('authTabRegister');
const authError = document.getElementById('authError');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const loginSubmitBtn = document.getElementById('loginSubmitBtn');
const registerSubmitBtn = document.getElementById('registerSubmitBtn');
const userPill = document.getElementById('userPill');
const userDisplayName = document.getElementById('userDisplayName');
const logoutBtn = document.getElementById('logoutBtn');
const workspaceSelect = document.getElementById('workspaceSelect');
const newWorkspaceBtn = document.getElementById('newWorkspaceBtn');
const createWorkspaceModal = document.getElementById('createWorkspaceModal');
const createWsClose = document.getElementById('createWsClose');
const createWorkspaceForm = document.getElementById('createWorkspaceForm');
const createWsSubmitBtn = document.getElementById('createWsSubmitBtn');

// ── Stat card refs ────────────────────────────────────────────────────────────
const scTotal = document.getElementById('scTotal');
const scPassing = document.getElementById('scPassing');
const scFailing = document.getElementById('scFailing');
const scErrors = document.getElementById('scErrors');
const scAvgTime = document.getElementById('scAvgTime');
const chartLegendEl = document.getElementById('chartLegend');
const chartEmptyEl = document.getElementById('chartEmpty');

// ── Chart palette — one colour per API ───────────────────────────────────────
const CHART_COLORS = [
  '#6382ff', '#3dffa0', '#ff5c77', '#ffc84a',
  '#38d9f5', '#9b6dff', '#ff9f43', '#00d2d3',
  '#ff6b81', '#a29bfe',
];
let responseChart = null; // Chart.js instance

// ── Utility: show toast ───────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = 'success') {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.className = `toast toast-${type}`;
  toastEl.classList.remove('hidden');
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3500);
}

// ── Utility: show inline feedback ─────────────────────────────────────────────
function showFeedback(msg, type = 'success') {
  addFeedback.textContent = msg;
  addFeedback.className = `feedback ${type}`;
}

// ── Time ago helper ───────────────────────────────────────────────────────────
function timeAgo(dateStr) {
  if (!dateStr) return null;
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// ── Escape HTML helper ─────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Security Wrapper: apiFetch with CSRF Token and Credential Handling ────────
async function apiFetch(url, options = {}) {
  const opts = { ...options };
  opts.headers = { ...(opts.headers || {}) };
  opts.credentials = 'same-origin';

  const method = (opts.method || 'GET').toUpperCase();
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    if (currentCsrfToken) {
      opts.headers['x-csrf-token'] = currentCsrfToken;
    }
  }

  const res = await fetch(url, opts);

  // If 401 Unauthorized occurs on protected operations
  if (res.status === 401 && !url.includes('/api/auth/login') && !url.includes('/api/auth/register')) {
    if (currentUser) {
      showToast('Session expired. Please sign in again.', 'error');
    }
    currentUser = null;
    activeWorkspaceId = null;
    userPill.classList.add('hidden');
    authModal.classList.remove('hidden');
  }

  return res;
}

// ── Utility: Safe JSON response parser ─────────────────────────────────────────
async function parseJsonResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (_e) {
    if (!res.ok) {
      throw new Error(`Server returned HTTP ${res.status}: ${res.statusText || 'Unexpected non-JSON response'}`);
    }
    throw new Error('Received unexpected non-JSON response from server');
  }
}

// ── Fetch CSRF Token ──────────────────────────────────────────────────────────
async function fetchCsrfToken() {
  try {
    const res = await fetch(`${API_BASE}/auth/csrf`, { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      currentCsrfToken = data.csrfToken;
    }
  } catch (err) {
    console.warn('Could not fetch CSRF token:', err.message);
  }
}

// ── Helper: Active Workspace Base URL ─────────────────────────────────────────
function getWorkspaceBaseUrl() {
  if (!activeWorkspaceId) {
    throw new Error('No workspace selected');
  }
  return `${API_BASE}/workspaces/${activeWorkspaceId}`;
}

// ── Render Workspace Selector ─────────────────────────────────────────────────
function renderWorkspaceSelector() {
  workspaceSelect.innerHTML = '';
  if (userWorkspaces.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No workspaces';
    workspaceSelect.appendChild(opt);
    return;
  }

  userWorkspaces.forEach((ws) => {
    const opt = document.createElement('option');
    opt.value = ws.id;
    opt.textContent = `${ws.name} (${ws.role})`;
    if (ws.id === activeWorkspaceId) {
      opt.selected = true;
    }
    workspaceSelect.appendChild(opt);
  });
}

// ── Load All Data for Active Workspace ────────────────────────────────────────
async function refreshDashboardData() {
  if (!activeWorkspaceId) return;
  await Promise.all([
    loadApis(),
    loadStats(),
    loadChart(),
  ]);
  if (activeTab === 'analytics') {
    await loadAnalytics();
  }
  if (activeTab === 'incidents') {
    await loadIncidents();
  }
  if (typeof updateIncidentBadge === 'function') {
    await updateIncidentBadge();
  }
}

// ── Check Current Session (on load) ───────────────────────────────────────────
async function initSession() {
  await fetchCsrfToken();

  try {
    const res = await fetch(`${API_BASE}/auth/me`, { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      currentUser = data.user;
      userWorkspaces = data.workspaces || [];
      if (data.csrfToken) currentCsrfToken = data.csrfToken;

      userDisplayName.textContent = currentUser.display_name || currentUser.email;
      userPill.classList.remove('hidden');
      authModal.classList.add('hidden');

      if (userWorkspaces.length > 0) {
        activeWorkspaceId = userWorkspaces[0].id;
        renderWorkspaceSelector();
        await refreshDashboardData();
      }
    } else {
      // Unauthenticated: present login dialog
      authModal.classList.remove('hidden');
      userPill.classList.add('hidden');
    }
  } catch (_err) {
    authModal.classList.remove('hidden');
  }
}

// ── Workspace Change Handler ──────────────────────────────────────────────────
workspaceSelect.addEventListener('change', async (e) => {
  const selectedId = Number(e.target.value);
  if (selectedId && selectedId !== activeWorkspaceId) {
    activeWorkspaceId = selectedId;
    await refreshDashboardData();
    showToast(`Switched workspace`, 'success');
  }
});

// ── Workspace Creation Modal ──────────────────────────────────────────────────
newWorkspaceBtn.addEventListener('click', () => {
  createWorkspaceModal.classList.remove('hidden');
  document.getElementById('newWsName').focus();
});

createWsClose.addEventListener('click', () => {
  createWorkspaceModal.classList.add('hidden');
});

createWorkspaceForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('newWsName').value.trim();
  if (!name) return;

  createWsSubmitBtn.disabled = true;
  createWsSubmitBtn.textContent = 'Creating...';

  try {
    const res = await apiFetch(`${API_BASE}/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await parseJsonResponse(res);

    if (!res.ok) throw new Error(data.error || 'Failed to create workspace');

    userWorkspaces.push(data.workspace);
    activeWorkspaceId = data.workspace.id;
    renderWorkspaceSelector();
    createWorkspaceModal.classList.add('hidden');
    createWorkspaceForm.reset();
    showToast(`Workspace "${name}" created!`, 'success');
    await refreshDashboardData();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    createWsSubmitBtn.disabled = false;
    createWsSubmitBtn.textContent = 'Create Workspace';
  }
});

// ── Auth Tab Switcher ─────────────────────────────────────────────────────────
authTabLogin.addEventListener('click', () => {
  authTabLogin.classList.add('active');
  authTabRegister.classList.remove('active');
  authTabLogin.setAttribute('aria-selected', 'true');
  authTabRegister.setAttribute('aria-selected', 'false');
  loginForm.classList.remove('hidden');
  registerForm.classList.add('hidden');
  authError.classList.add('hidden');
});

authTabRegister.addEventListener('click', () => {
  authTabRegister.classList.add('active');
  authTabLogin.classList.remove('active');
  authTabRegister.setAttribute('aria-selected', 'true');
  authTabLogin.setAttribute('aria-selected', 'false');
  registerForm.classList.remove('hidden');
  loginForm.classList.add('hidden');
  authError.classList.add('hidden');
});

// ── Login Form Submission ─────────────────────────────────────────────────────
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.classList.add('hidden');

  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;

  if (!email || !password) {
    authError.textContent = 'Please enter both email and password';
    authError.classList.remove('hidden');
    return;
  }

  loginSubmitBtn.disabled = true;
  loginSubmitBtn.textContent = 'Signing in...';

  try {
    await fetchCsrfToken(); // Ensure fresh token before auth
    const res = await apiFetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const data = await parseJsonResponse(res);
    if (!res.ok) {
      throw new Error(data.error || 'Login failed');
    }

    currentUser = data.user;
    userWorkspaces = data.workspaces || [];
    if (data.csrfToken) currentCsrfToken = data.csrfToken;

    userDisplayName.textContent = currentUser.display_name || currentUser.email;
    userPill.classList.remove('hidden');
    authModal.classList.add('hidden');
    loginForm.reset();

    if (userWorkspaces.length > 0) {
      activeWorkspaceId = userWorkspaces[0].id;
      renderWorkspaceSelector();
      await refreshDashboardData();
    }
    showToast(`Welcome back, ${currentUser.display_name || currentUser.email}!`, 'success');
  } catch (err) {
    authError.textContent = err.message;
    authError.classList.remove('hidden');
  } finally {
    loginSubmitBtn.disabled = false;
    loginSubmitBtn.textContent = 'Sign In';
  }
});

// ── Register Form Submission ──────────────────────────────────────────────────
registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.classList.add('hidden');

  const display_name = document.getElementById('registerName').value.trim();
  const email = document.getElementById('registerEmail').value.trim();
  const password = document.getElementById('registerPassword').value;
  const workspace_name = document.getElementById('registerWsName').value.trim();

  if (!email || !password) {
    authError.textContent = 'Email and password are required';
    authError.classList.remove('hidden');
    return;
  }

  if (password.length < 8) {
    authError.textContent = 'Password must be at least 8 characters long';
    authError.classList.remove('hidden');
    return;
  }

  registerSubmitBtn.disabled = true;
  registerSubmitBtn.textContent = 'Creating account...';

  try {
    await fetchCsrfToken(); // Ensure fresh token
    const res = await apiFetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, display_name, workspace_name }),
    });

    const data = await parseJsonResponse(res);
    if (!res.ok) {
      throw new Error(data.error || 'Registration failed');
    }

    currentUser = data.user;
    userWorkspaces = [data.workspace];
    activeWorkspaceId = data.workspace.id;
    if (data.csrfToken) currentCsrfToken = data.csrfToken;

    userDisplayName.textContent = currentUser.display_name || currentUser.email;
    userPill.classList.remove('hidden');
    authModal.classList.add('hidden');
    registerForm.reset();

    renderWorkspaceSelector();
    await refreshDashboardData();
    showToast(`Account created! Welcome to APIDash.`, 'success');
  } catch (err) {
    authError.textContent = err.message;
    authError.classList.remove('hidden');
  } finally {
    registerSubmitBtn.disabled = false;
    registerSubmitBtn.textContent = 'Create Account & Workspace';
  }
});

// ── Logout ────────────────────────────────────────────────────────────────────
logoutBtn.addEventListener('click', async () => {
  try {
    await apiFetch(`${API_BASE}/auth/logout`, { method: 'POST' });
  } catch (_) { }

  currentUser = null;
  activeWorkspaceId = null;
  userWorkspaces = [];
  userPill.classList.add('hidden');
  authModal.classList.remove('hidden');
  workspaceSelect.innerHTML = '<option value="">Not signed in</option>';
  totalCountEl.textContent = '0';
  apiListEl.innerHTML = '';
  apiListEl.appendChild(emptyState);
  emptyState.classList.remove('hidden');
  showToast('Signed out successfully', 'success');
});

// ── Load API list (Workspace Scoped) ──────────────────────────────────────────
async function loadApis() {
  if (!activeWorkspaceId) return;

  try {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '↺ Loading…';

    const res = await apiFetch(`${getWorkspaceBaseUrl()}/apis`);
    if (!res.ok) return;
    const data = await res.json();

    totalCountEl.textContent = data.length;
    renderApiList(data);
  } catch (err) {
    showToast('Could not reach backend — is the server running?', 'error');
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = '↺ Refresh';
  }
}

// ── Build the inline result strip shown on each card ─────────────────────────
function buildResultStrip(api) {
  if (!api.last_result) {
    return `<div class="card-result card-result-pending">⏳ Not tested yet</div>`;
  }

  const res = api.last_result;
  const isPass = res === 'PASS' || res === 'passed';
  const isError = res === 'error';
  const ago = timeAgo(api.last_tested_at);

  const cardClass = isPass ? 'card-result-pass' : isError ? 'card-result-error' : 'card-result-fail';
  const badgeClass = isPass ? 'cr-pass' : isError ? 'cr-error' : 'cr-fail';
  const displayResult = isPass ? 'PASSED' : isError ? 'ERROR' : 'FAILED';

  const errorTypeBadge = (isError && api.last_error_type)
    ? `<span class="cr-badge cr-error-type" title="Error Category: ${escHtml(api.last_error_type)}">${escHtml(api.last_error_type)}</span>`
    : '';

  const errorSnippet = (isError && api.last_error)
    ? `<span class="cr-error-msg" title="${escHtml(api.last_error)}">${escHtml(api.last_error)}</span>`
    : '';

  return `
    <div class="card-result ${cardClass}">
      <span class="cr-badge ${badgeClass}">${displayResult}</span>
      ${errorTypeBadge}
      <span class="cr-stat">
        <span class="cr-label">Status</span>
        <span class="cr-value">${api.last_status_code ?? 'N/A'}</span>
      </span>
      <span class="cr-divider"></span>
      <span class="cr-stat">
        <span class="cr-label">Time</span>
        <span class="cr-value">${api.last_response_time != null ? api.last_response_time + ' ms' : 'N/A'}</span>
      </span>
      ${errorSnippet ? `<span class="cr-divider"></span>${errorSnippet}` : ''}
      ${ago ? `<span class="cr-divider"></span><span class="cr-ago">${ago}</span>` : ''}
    </div>
  `;
}

// ── Render API cards ──────────────────────────────────────────────────────────
function renderApiList(apis) {
  apiListEl.innerHTML = '';

  if (apis.length === 0) {
    apiListEl.appendChild(emptyState);
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');

  apis.forEach((api) => {
    const card = document.createElement('div');
    card.className = 'api-card';
    card.id = `card-${api.id}`;

    const dotClass = (api.last_result === 'PASS' || api.last_result === 'passed') ? 'pass'
      : api.last_result === 'error' ? 'error'
        : (api.last_result === 'FAIL' || api.last_result === 'failed') ? 'fail' : '';

    card.innerHTML = `
      <div class="card-top">
        <span class="card-status-dot ${dotClass}" id="dot-${api.id}"></span>
        <span class="api-method-badge badge-${api.method}">${api.method}</span>
        <div class="api-info">
          <div class="api-name" title="${escHtml(api.name)}">${escHtml(api.name)}</div>
          <div class="api-url"  title="${escHtml(api.url)}">${escHtml(api.url)}</div>
          <div class="api-meta">
            Expected: <strong>${api.expected_status}</strong> &nbsp;·&nbsp; ID: ${api.id} &nbsp;·&nbsp;
            <button type="button" class="badge-binding" id="bindBtn-${api.id}" title="OpenAPI Contract Binding">📜 Contract</button>
          </div>
        </div>
        <div class="api-actions">
          <button class="btn btn-test" id="testBtn-${api.id}">▶ Test Now</button>
          <button class="btn btn-delete" id="delBtn-${api.id}">✕ Remove</button>
        </div>
      </div>
      <div class="card-result-wrap" id="result-${api.id}">
        ${buildResultStrip(api)}
      </div>
    `;

    apiListEl.appendChild(card);

    document.getElementById(`testBtn-${api.id}`)
      .addEventListener('click', () => runTest(api.id, api.name));

    document.getElementById(`bindBtn-${api.id}`)
      ?.addEventListener('click', () => openBindContractModal(api));



    const delBtn = document.getElementById(`delBtn-${api.id}`);
    let delPending = false;
    let delTimer;
    delBtn.addEventListener('click', () => {
      if (!delPending) {
        delPending = true;
        delBtn.textContent = '✓ Sure?';
        delBtn.style.background = 'rgba(255,92,119,0.3)';
        delBtn.style.borderColor = 'rgba(255,92,119,0.7)';
        delTimer = setTimeout(() => {
          delPending = false;
          delBtn.textContent = '✕ Remove';
          delBtn.style.background = '';
          delBtn.style.borderColor = '';
        }, 3000);
      } else {
        clearTimeout(delTimer);
        deleteApi(api.id);
      }
    });
  });
}

// ── Update a single card's result strip ───────────────────────────────────────
function updateCardResult(id, data) {
  const wrap = document.getElementById(`result-${id}`);
  const dot = document.getElementById(`dot-${id}`);
  if (!wrap) return;

  const isPass = data.result === 'PASS' || data.result === 'passed';
  const isError = data.result === 'error';

  wrap.innerHTML = buildResultStrip({
    last_result: data.result,
    last_status_code: data.status_code,
    last_response_time: data.response_time,
    last_error_type: data.error_type,
    last_error: data.error_message,
    last_tested_at: new Date().toISOString(),
  });

  if (dot) {
    dot.className = `card-status-dot ${isPass ? 'pass' : isError ? 'error' : 'fail'}`;
  }
}

// ── Quick Assertion Presets Helper ───────────────────────────────────────────
function appendAssertionPreset(assertion) {
  const el = document.getElementById('apiAssertions');
  if (!el) return;
  let current = [];
  try {
    if (el.value.trim()) current = JSON.parse(el.value.trim());
    if (!Array.isArray(current)) current = [];
  } catch (_) {
    current = [];
  }
  current.push(assertion);
  el.value = JSON.stringify(current, null, 2);
}

document.getElementById('presetStatus200')?.addEventListener('click', () => {
  appendAssertionPreset({ type: 'status', operator: 'equals', expected: 200 });
});
document.getElementById('presetLatency1000')?.addEventListener('click', () => {
  appendAssertionPreset({ type: 'latency', operator: 'less_than', expected: 1000 });
});
document.getElementById('presetLatency500')?.addEventListener('click', () => {
  appendAssertionPreset({ type: 'latency', operator: 'less_than', expected: 500 });
});
document.getElementById('presetClearAssertions')?.addEventListener('click', () => {
  const el = document.getElementById('apiAssertions');
  if (el) el.value = '';
});

// ── ADD API (Workspace Scoped) ────────────────────────────────────────────────
addApiForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!activeWorkspaceId) {
    showToast('Please select or create a workspace first', 'error');
    return;
  }

  const name = document.getElementById('apiName').value.trim();
  const url = document.getElementById('apiUrl').value.trim();
  const method = document.getElementById('apiMethod').value;
  const expected_status = parseInt(document.getElementById('expectedStatus').value, 10);

  if (!name || !url) {
    showFeedback('⚠ Name and URL are required.', 'error');
    return;
  }

  const timeoutVal = document.getElementById('apiTimeout')?.value;
  const headersVal = document.getElementById('apiHeaders')?.value.trim();
  const bodyVal = document.getElementById('apiBody')?.value.trim();
  const assertionsVal = document.getElementById('apiAssertions')?.value.trim();

  let headers = null;
  if (headersVal) {
    try {
      headers = JSON.parse(headersVal);
    } catch (_e) {
      headers = {};
      headersVal.split('\n').forEach(line => {
        const idx = line.indexOf(':');
        if (idx > 0) {
          const k = line.slice(0, idx).trim();
          const v = line.slice(idx + 1).trim();
          if (k) headers[k] = v;
        }
      });
    }
  }

  let body = null;
  if (bodyVal) {
    try {
      body = JSON.parse(bodyVal);
    } catch (_e) {
      body = bodyVal;
    }
  }

  let assertions = null;
  if (assertionsVal) {
    try {
      assertions = JSON.parse(assertionsVal);
      if (!Array.isArray(assertions)) {
        throw new Error('Assertions must be a JSON array');
      }
    } catch (err) {
      showFeedback(`❌ Invalid assertions format: ${err.message}`, 'error');
      return;
    }
  }

  addBtn.disabled = true;
  addBtn.innerHTML = '<span class="spinner"></span> Adding…';

  try {
    const payload = {
      name,
      url,
      method,
      expected_status,
      timeout_ms: timeoutVal ? parseInt(timeoutVal, 10) : 10000,
      headers,
      body,
      assertions,
    };

    const res = await apiFetch(`${getWorkspaceBaseUrl()}/apis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to add API');

    showFeedback(`✅ "${data.api.name}" added (ID: ${data.api.id})`, 'success');
    addApiForm.reset();
    if (document.getElementById('apiTimeout')) document.getElementById('apiTimeout').value = '10000';
    if (document.getElementById('apiHeaders')) document.getElementById('apiHeaders').value = '';
    if (document.getElementById('apiBody')) document.getElementById('apiBody').value = '';
    if (document.getElementById('apiAssertions')) document.getElementById('apiAssertions').value = '';
    await loadApis();
    await loadStats();
    showToast(`"${data.api.name}" is now being monitored!`, 'success');
  } catch (err) {
    showFeedback(`❌ ${err.message}`, 'error');
    showToast(err.message, 'error');
  } finally {
    addBtn.disabled = false;
    addBtn.innerHTML = '<span class="btn-icon">＋</span> Add &amp; Monitor';
  }
});

// ── RUN TEST (Workspace Scoped) ───────────────────────────────────────────────
async function runTest(id, name) {
  const btn = document.getElementById(`testBtn-${id}`);
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Testing…'; }

  try {
    const res = await apiFetch(`${getWorkspaceBaseUrl()}/apis/${id}/test`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Test failed');

    updateCardResult(id, data);
    openResultModal(name, data);
    await loadStats();
    await loadChart();
  } catch (err) {
    showToast(`Test error: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '▶ Test Now'; }
  }
}

// ── DELETE API (Workspace Scoped) ─────────────────────────────────────────────
async function deleteApi(id) {
  try {
    const res = await apiFetch(`${getWorkspaceBaseUrl()}/apis/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server returned ${res.status}`);
    }
    showToast('API removed successfully.', 'success');
    await loadApis();
    await loadStats();
    await loadChart();
  } catch (err) {
    showToast(`Delete failed: ${err.message}`, 'error');
  }
}

// ── Result Modal ──────────────────────────────────────────────────────────────
function openResultModal(name, data) {
  modalTitle.textContent = `Test Result — ${name}`;

  const isPass = data.result === 'PASS' || data.result === 'passed';
  const isError = data.result === 'error';
  const badgeClass = isPass ? 'badge-pass' : isError ? 'badge-error' : 'badge-fail';
  const displayResult = (data.result || '').toUpperCase();

  resultBadge.textContent = displayResult;
  resultBadge.className = `result-badge ${badgeClass}`;

  const items = [
    { label: 'Status Code', value: data.status_code ?? 'N/A', color: isPass ? 'green' : isError ? 'amber' : 'red' },
    { label: 'Response Time', value: data.response_time != null ? `${data.response_time} ms` : 'N/A', color: 'cyan' },
    { label: 'Expected', value: data.expected_status ?? '—', color: '' },
    { label: 'Method', value: data.method ?? '—', color: '' },
  ];

  let gridHtml = items.map(({ label, value, color }) => `
    <div class="result-item">
      <div class="result-item-label">${label}</div>
      <div class="result-item-value ${color ? 'value-' + color : ''}">${value}</div>
    </div>
  `).join('');

  if (data.error_type) {
    gridHtml += `
      <div class="result-item" style="grid-column: 1 / -1;">
        <div class="result-item-label">Error Classification</div>
        <div class="result-item-value value-amber">${escHtml(data.error_type)}</div>
      </div>
    `;
  }

  if (Array.isArray(data.assertions) && data.assertions.length > 0) {
    const passedCount = data.assertions.filter(a => a.passed).length;
    const assertionRows = data.assertions.map(a => `
      <div class="assertion-item ${a.passed ? 'pass' : 'fail'}">
        <span class="assertion-status">${a.passed ? '✓' : '✗'}</span>
        <div class="assertion-details">
          <div class="assertion-title">${escHtml(a.type || 'check')}: ${escHtml(a.message || (a.passed ? 'Passed' : 'Failed'))}</div>
          <div class="assertion-meta">Expected: ${escHtml(JSON.stringify(a.expected ?? ''))} ${a.actual !== undefined ? `· Actual: ${escHtml(JSON.stringify(a.actual))}` : ''}</div>
        </div>
      </div>
    `).join('');

    gridHtml += `
      <div class="assertions-container" style="grid-column: 1 / -1; margin-top: 10px;">
        <div class="result-item-label" style="margin-bottom: 6px;">Assertions (${passedCount}/${data.assertions.length} passed)</div>
        <div class="assertions-list">${assertionRows}</div>
      </div>
    `;
  }

  resultGrid.innerHTML = gridHtml;

  // OpenAPI Contract Validation (Phase 6)
  const contractResultSection = document.getElementById('contractResultSection');
  const contractVerdictBadge = document.getElementById('contractVerdictBadge');
  const contractTruncatedNotice = document.getElementById('contractTruncatedNotice');
  const contractFindingsList = document.getElementById('contractFindingsList');

  if (contractResultSection) {
    if (data.contract_verdict) {
      contractResultSection.classList.remove('hidden');
      const v = String(data.contract_verdict).toLowerCase();
      contractVerdictBadge.textContent = String(data.contract_verdict).toUpperCase();
      contractVerdictBadge.className = `badge verdict-${v === 'preflight_rejected' ? 'preflight-rejected' : v}`;

      if (data.inspection_truncated || v === 'partial') {
        contractTruncatedNotice?.classList.remove('hidden');
      } else {
        contractTruncatedNotice?.classList.add('hidden');
      }

      if (Array.isArray(data.contract_findings) && data.contract_findings.length > 0) {
        contractFindingsList.innerHTML = data.contract_findings.map(f => `
          <div class="finding-item ${f.severity === 'warning' ? 'finding-warning' : ''}">
            <div class="finding-meta">[${escHtml(f.rule || 'RULE')}] ${escHtml(f.location || '')}${f.path ? ' · ' + escHtml(f.path) : ''}</div>
            <div class="finding-message">${escHtml(f.message || '')}</div>
          </div>
        `).join('');
      } else {
        contractFindingsList.innerHTML = '<div class="text-muted" style="font-size: 0.8rem; padding: 4px 0;">✓ All contract rules satisfied. Zero findings.</div>';
      }
    } else {
      contractResultSection.classList.add('hidden');
    }
  }

  const display = {
    result: data.result,
    status: data.status_code,
    response_time: data.response_time,
    ...(data.error_type ? { error_type: data.error_type } : {}),
    ...(data.error_message ? { error: data.error_message } : {}),
    ...(data.assertions ? { assertions: data.assertions } : {}),
    ...(data.contract_verdict ? { contract_verdict: data.contract_verdict } : {}),
    ...(data.contract_findings ? { contract_findings: data.contract_findings } : {}),
  };

  resultJsonEl.textContent = JSON.stringify(display, null, 2);
  resultModal.classList.remove('hidden');
}

function closeModal() { resultModal.classList.add('hidden'); }

modalClose.addEventListener('click', closeModal);
resultModal.addEventListener('click', (e) => { if (e.target === resultModal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ── Refresh button ────────────────────────────────────────────────────────────
refreshBtn.addEventListener('click', () => { refreshDashboardData(); });

// ── Load stats cards (Workspace Scoped) ───────────────────────────────────────
async function loadStats() {
  if (!activeWorkspaceId) return;
  try {
    const res = await apiFetch(`${getWorkspaceBaseUrl()}/stats`);
    if (!res.ok) return;
    const data = await res.json();

    scTotal.textContent = data.total ?? 0;
    scPassing.textContent = data.passing ?? 0;
    scFailing.textContent = data.failing ?? 0;
    if (scErrors) scErrors.textContent = data.errors ?? 0;
    scAvgTime.textContent = data.avg_response_time != null
      ? `${data.avg_response_time} ms` : '—';
  } catch (_) { /* silent fail */ }
}

// ── Load & render response-time chart (Workspace Scoped) ──────────────────────
async function loadChart() {
  if (!activeWorkspaceId) return;
  try {
    const res = await apiFetch(`${getWorkspaceBaseUrl()}/chart-data`);
    if (!res.ok) return;
    const data = await res.json();

    const apiIds = Object.keys(data);
    const hasAnyPoints = apiIds.some(id => data[id].points && data[id].points.length > 0);
    chartEmptyEl.classList.toggle('hidden', hasAnyPoints);
    document.getElementById('responseChart').parentElement
      .style.display = hasAnyPoints ? '' : 'none';
    if (!hasAnyPoints) { chartLegendEl.innerHTML = ''; return; }

    const datasets = apiIds.map((id, idx) => {
      const color = CHART_COLORS[idx % CHART_COLORS.length];
      const points = data[id].points || [];

      return {
        label: data[id].name,
        data: points.map(p => p.response_time ?? null),
        borderColor: color,
        backgroundColor: color + '22',
        pointBackgroundColor: points.map(p =>
          (p.result === 'PASS' || p.result === 'passed') ? '#3dffa0' :
            p.result === 'error' ? '#ffc84a' :
              (p.result === 'FAIL' || p.result === 'failed') ? '#ff5c77' : color
        ),
        pointRadius: 5,
        pointHoverRadius: 8,
        borderWidth: 2,
        tension: 0.4,
        fill: false,
        spanGaps: true,
      };
    });

    const richestId = apiIds.reduce((best, id) =>
      (data[id].points || []).length >= (data[best].points || []).length ? id : best, apiIds[0]);
    const labels = (data[richestId].points || []).map(p => {
      const d = new Date(p.tested_at);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    });

    const defaults = {
      color: '#8b96c8',
      font: { family: "'Inter', sans-serif", size: 11 },
    };

    if (responseChart) {
      responseChart.data.labels = labels;
      responseChart.data.datasets = datasets;
      responseChart.update('none');
    } else {
      const ctx = document.getElementById('responseChart').getContext('2d');
      Chart.defaults.color = defaults.color;
      Chart.defaults.font.family = defaults.font.family;
      Chart.defaults.font.size = defaults.font.size;

      responseChart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgba(8,12,24,0.92)',
              borderColor: 'rgba(99,130,255,0.35)',
              borderWidth: 1,
              titleColor: '#e8ecff',
              bodyColor: '#8b96c8',
              padding: 12,
              callbacks: {
                label: (ctx) => {
                  const v = ctx.parsed.y;
                  const pt = data[apiIds[ctx.datasetIndex]]?.points[ctx.dataIndex];
                  const isPass = pt?.result === 'PASS' || pt?.result === 'passed';
                  const isError = pt?.result === 'error';
                  const badge = isPass ? '✅' : isError ? '⚠️' : pt ? '❌' : '';
                  return ` ${ctx.dataset.label}: ${v != null ? v + ' ms' : 'N/A'} ${badge}`;
                },
              },
            },
          },
          scales: {
            x: {
              grid: { color: 'rgba(99,130,255,0.08)' },
              ticks: { maxRotation: 0, maxTicksLimit: 6 },
            },
            y: {
              grid: { color: 'rgba(99,130,255,0.08)' },
              title: { display: true, text: 'Response Time (ms)', color: '#4a5582' },
              beginAtZero: true,
              ticks: {
                callback: (v) => v + ' ms',
              },
            },
          },
        },
      });
    }

    chartLegendEl.innerHTML = datasets.map(ds => `
      <span class="legend-item">
        <span class="legend-dot" style="background:${ds.borderColor}"></span>
        ${ds.label}
      </span>
    `).join('');
  } catch (err) {
    console.warn('Chart load error:', err.message);
  }
}

// ── Auto-refresh interval ─────────────────────────────────────────────────────
setInterval(() => {
  if (currentUser && activeWorkspaceId) {
    loadApis();
    loadStats();
    loadChart();
    if (activeTab === 'analytics') loadAnalytics();
  }
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────
// TAB NAVIGATION
// ─────────────────────────────────────────────────────────────────────────────
let activeTab = 'dashboard';

document.querySelectorAll('.nav-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    if (tab === activeTab) return;
    activeTab = tab;

    document.querySelectorAll('.nav-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
      b.setAttribute('aria-selected', b.dataset.tab === tab);
    });
    document.getElementById('viewDashboard').classList.toggle('hidden', tab !== 'dashboard');
    document.getElementById('viewAnalytics').classList.toggle('hidden', tab !== 'analytics');
    const viewIncidentsEl = document.getElementById('viewIncidents');
    if (viewIncidentsEl) viewIncidentsEl.classList.toggle('hidden', tab !== 'incidents');
    const viewContractsEl = document.getElementById('viewContracts');
    if (viewContractsEl) viewContractsEl.classList.toggle('hidden', tab !== 'contracts');

    if (tab === 'analytics' && activeWorkspaceId) loadAnalytics();
    if (tab === 'incidents' && activeWorkspaceId) loadIncidents();
    if (tab === 'contracts' && activeWorkspaceId) loadContracts();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS (Workspace Scoped)
// ─────────────────────────────────────────────────────────────────────────────
let analyticsHours = 24;
let schedulerChart = null;

document.getElementById('windowTabs').addEventListener('click', e => {
  const btn = e.target.closest('.win-btn');
  if (!btn) return;
  document.querySelectorAll('.win-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  analyticsHours = parseInt(btn.dataset.hours, 10);
  if (activeWorkspaceId) loadAnalytics();
});

document.getElementById('analyticsRefreshBtn').addEventListener('click', () => {
  if (activeWorkspaceId) loadAnalytics();
});

async function loadAnalytics() {
  if (!activeWorkspaceId) return;
  await Promise.all([loadGlobalAnalytics(), loadSchedulerRuns()]);
}

async function loadGlobalAnalytics() {
  if (!activeWorkspaceId) return;
  try {
    const res = await apiFetch(`${getWorkspaceBaseUrl()}/analytics/summary?hours=${analyticsHours}`);
    if (!res.ok) return;
    const data = await res.json();

    document.getElementById('aGlobalUptime').textContent =
      data.uptime_pct != null ? `${data.uptime_pct}%` : '—';
    document.getElementById('aGlobalP95').textContent =
      data.p95_ms != null ? `${data.p95_ms} ms` : '—';
    document.getElementById('aGlobalChecks').textContent =
      data.total_checks ?? '—';
    document.getElementById('aGlobalAvg').textContent =
      data.avg_ms != null ? `${data.avg_ms} ms` : '—';
    document.getElementById('aGlobalChecksSub').textContent =
      `${data.total_passed ?? 0} passed · ${data.total_failed ?? 0} failed · ${data.total_errors ?? 0} errors`;

    const uptimeEl = document.getElementById('aGlobalUptime');
    const pct = data.uptime_pct ?? 100;
    uptimeEl.style.color = pct >= 99 ? '#3dffa0' : pct >= 95 ? '#ffc84a' : '#ff5c77';

    renderPerApiCards(data.per_api || []);
  } catch (err) {
    console.warn('Analytics load error:', err.message);
  }
}

function renderPerApiCards(perApi) {
  const grid = document.getElementById('perApiGrid');
  const empty = document.getElementById('analyticsEmpty');
  const hasData = perApi.some(a => a.total > 0);

  if (!hasData) {
    empty.classList.remove('hidden');
    grid.innerHTML = '';
    grid.appendChild(empty);
    return;
  }
  empty.classList.add('hidden');

  grid.innerHTML = perApi.map(api => {
    if (!api.total) return '';
    const uptimeColor = (api.uptime_pct ?? 100) >= 99 ? '#3dffa0'
      : (api.uptime_pct ?? 100) >= 90 ? '#ffc84a' : '#ff5c77';
    const scoreColor = (api.health_score ?? 100) >= 80 ? '#3dffa0'
      : (api.health_score ?? 100) >= 60 ? '#ffc84a' : '#ff5c77';

    const topErrors = (api.top_errors || []).slice(0, 3)
      .map(e => `
        <div class="err-row">
          <span class="err-count">${e.count}×</span>
          ${e.error_type ? `<span class="err-type-badge">${escHtml(e.error_type)}</span>` : ''}
          <span class="err-msg" title="${escHtml(e.msg)}">${escHtml(e.msg)}</span>
        </div>
      `)
      .join('') || '<div class="err-none">No errors ✅</div>';

    const streakBadge = api.fail_streak > 0
      ? `<span class="streak-badge">🔴 ${api.fail_streak} consecutive fail${api.fail_streak > 1 ? 's' : ''}</span>` : '';

    return `
    <div class="api-analytics-card">
      <div class="aac-header">
        <div class="aac-name">
          <span class="api-method-badge badge-${api.method || 'GET'}">${api.method || 'GET'}</span>
          ${escHtml(api.name || 'API #' + api.apiId)}
        </div>
        <div class="aac-score" style="color:${scoreColor}">
          ${api.health_score ?? '—'}<span class="aac-score-unit">/100</span>
        </div>
      </div>
      <div class="aac-url">${escHtml((api.url || '').replace(/^https?:\/\//, ''))}</div>
      ${streakBadge}
      <div class="aac-metrics">
        <div class="aac-metric">
          <div class="aac-metric-val" style="color:${uptimeColor}">${api.uptime_pct ?? '—'}%</div>
          <div class="aac-metric-lbl">Uptime</div>
        </div>
        <div class="aac-metric">
          <div class="aac-metric-val">${api.avg_ms != null ? api.avg_ms + ' ms' : '—'}</div>
          <div class="aac-metric-lbl">Avg</div>
        </div>
        <div class="aac-metric">
          <div class="aac-metric-val">${api.p95_ms != null ? api.p95_ms + ' ms' : '—'}</div>
          <div class="aac-metric-lbl">P95</div>
        </div>
        <div class="aac-metric">
          <div class="aac-metric-val">${api.total}</div>
          <div class="aac-metric-lbl">Checks</div>
        </div>
        <div class="aac-metric">
          <div class="aac-metric-val" style="color:#3dffa0">${api.passed ?? 0}</div>
          <div class="aac-metric-lbl">Pass</div>
        </div>
        <div class="aac-metric">
          <div class="aac-metric-val" style="color:#ff5c77">${api.failed ?? 0}</div>
          <div class="aac-metric-lbl">Fail</div>
        </div>
        <div class="aac-metric">
          <div class="aac-metric-val" style="color:#ffc84a">${api.errors ?? 0}</div>
          <div class="aac-metric-lbl">Error</div>
        </div>
      </div>
      <div class="aac-section-label">Top Errors</div>
      <div class="aac-errors">${topErrors}</div>
    </div>`;
  }).join('');
}

async function loadSchedulerRuns() {
  if (!activeWorkspaceId) return;
  try {
    const res = await apiFetch(`${getWorkspaceBaseUrl()}/scheduler-runs`);
    if (!res.ok) return;
    const runs = await res.json();

    const empty = document.getElementById('schedulerChartEmpty');
    const canvas = document.getElementById('schedulerChart');

    if (!runs.length) {
      empty.classList.remove('hidden');
      canvas.parentElement.style.display = 'none';
      return;
    }
    empty.classList.add('hidden');
    canvas.parentElement.style.display = '';

    const labels = runs.map(r => new Date(r.ran_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const passData = runs.map(r => r.passed);
    const failData = runs.map(r => r.failed);

    if (schedulerChart) {
      schedulerChart.data.labels = labels;
      schedulerChart.data.datasets[0].data = passData;
      schedulerChart.data.datasets[1].data = failData;
      schedulerChart.update('none');
      return;
    }

    const ctx = canvas.getContext('2d');
    schedulerChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Passed', data: passData, backgroundColor: 'rgba(61,255,160,0.7)', borderRadius: 4 },
          { label: 'Failed', data: failData, backgroundColor: 'rgba(255,92,119,0.7)', borderRadius: 4 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#8b96c8', font: { family: "'Inter', sans-serif" } } },
          tooltip: {
            backgroundColor: 'rgba(8,12,24,0.92)', borderColor: 'rgba(99,130,255,0.35)',
            borderWidth: 1, titleColor: '#e8ecff', bodyColor: '#8b96c8',
          },
        },
        scales: {
          x: { stacked: true, grid: { color: 'rgba(99,130,255,0.08)' }, ticks: { color: '#4a5582', maxTicksLimit: 10 } },
          y: { stacked: true, grid: { color: 'rgba(99,130,255,0.08)' }, ticks: { color: '#4a5582', precision: 0 }, beginAtZero: true },
        },
      },
    });
  } catch (err) {
    console.warn('Scheduler runs load error:', err.message);
  }
}

// ── Initialize Authentication & Session ───────────────────────────────────────
initSession();


// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5: INCIDENTS & NOTIFICATIONS FRONTEND LOGIC
// ─────────────────────────────────────────────────────────────────────────────

let currentIncidentFilter = 'open';

const filterIncidentsOpen = document.getElementById('filterIncidentsOpen');
const filterIncidentsResolved = document.getElementById('filterIncidentsResolved');
const filterIncidentsAll = document.getElementById('filterIncidentsAll');
const incidentsRefreshBtn = document.getElementById('incidentsRefreshBtn');
const notificationSettingsBtn = document.getElementById('notificationSettingsBtn');
const smtpNoticeBanner = document.getElementById('smtpNoticeBanner');
const incidentsLoading = document.getElementById('incidentsLoading');
const incidentsEmpty = document.getElementById('incidentsEmpty');
const incidentsEmptyTitle = document.getElementById('incidentsEmptyTitle');
const incidentsEmptySub = document.getElementById('incidentsEmptySub');
const incidentsContainer = document.getElementById('incidentsContainer');
const incidentCountBadge = document.getElementById('incidentCountBadge');

const incidentDetailModal = document.getElementById('incidentDetailModal');
const incidentModalClose = document.getElementById('incidentModalClose');
const incidentModalBadge = document.getElementById('incidentModalBadge');
const incidentModalTitle = document.getElementById('incidentModalTitle');
const incidentModalMeta = document.getElementById('incidentModalMeta');
const incidentModalSummary = document.getElementById('incidentModalSummary');
const incidentResultsBody = document.getElementById('incidentResultsBody');

const notificationSettingsModal = document.getElementById('notificationSettingsModal');
const notifSettingsClose = document.getElementById('notifSettingsClose');
const notifSettingsCancel = document.getElementById('notifSettingsCancel');
const notificationSettingsForm = document.getElementById('notificationSettingsForm');
const notifNotifyOnOpen = document.getElementById('notifNotifyOnOpen');
const notifNotifyOnResolve = document.getElementById('notifNotifyOnResolve');
const recipientsListContainer = document.getElementById('recipientsListContainer');
const notifSettingsSaveBtn = document.getElementById('notifSettingsSaveBtn');
const settingsFeedback = document.getElementById('settingsFeedback');

// Filter button clicks
if (filterIncidentsOpen) {
  filterIncidentsOpen.addEventListener('click', () => {
    setIncidentFilter('open', filterIncidentsOpen);
  });
}
if (filterIncidentsResolved) {
  filterIncidentsResolved.addEventListener('click', () => {
    setIncidentFilter('resolved', filterIncidentsResolved);
  });
}
if (filterIncidentsAll) {
  filterIncidentsAll.addEventListener('click', () => {
    setIncidentFilter('all', filterIncidentsAll);
  });
}

function setIncidentFilter(status, btn) {
  currentIncidentFilter = status;
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  if (btn) btn.classList.add('active');
  if (activeWorkspaceId) loadIncidents();
}

if (incidentsRefreshBtn) {
  incidentsRefreshBtn.addEventListener('click', () => {
    if (activeWorkspaceId) loadIncidents();
  });
}

// Modal close handlers
if (incidentModalClose) {
  incidentModalClose.addEventListener('click', () => {
    incidentDetailModal.classList.add('hidden');
    if (typeof aiPollTimer !== 'undefined' && aiPollTimer) {
      clearTimeout(aiPollTimer);
    }
  });
}
if (notifSettingsClose) {
  notifSettingsClose.addEventListener('click', () => {
    notificationSettingsModal.classList.add('hidden');
  });
}
if (notifSettingsCancel) {
  notifSettingsCancel.addEventListener('click', () => {
    notificationSettingsModal.classList.add('hidden');
  });
}

// Notification Settings button click
if (notificationSettingsBtn) {
  notificationSettingsBtn.addEventListener('click', () => {
    openNotificationSettingsModal();
  });
}

/**
 * Updates the incident count badge on the navigation tab.
 */
async function updateIncidentBadge() {
  if (!activeWorkspaceId || !incidentCountBadge) return;
  try {
    const res = await apiFetch(`${getWorkspaceBaseUrl()}/incidents?status=open&limit=1`);
    if (res.ok) {
      const data = await res.json();
      const openCount = data.total || 0;
      incidentCountBadge.textContent = openCount;
      incidentCountBadge.classList.toggle('hidden', openCount === 0);
    }
  } catch (_e) {
    // Non-critical badge update failure
  }
}

/**
 * Loads incidents for the current workspace and active filter.
 */
async function loadIncidents() {
  if (!activeWorkspaceId) return;

  incidentsLoading.classList.remove('hidden');
  incidentsEmpty.classList.add('hidden');
  incidentsContainer.innerHTML = '';

  try {
    const res = await apiFetch(`${getWorkspaceBaseUrl()}/incidents?status=${currentIncidentFilter}&limit=50`);
    if (!res.ok) {
      throw new Error(`Failed to load incidents (HTTP ${res.status})`);
    }

    const data = await res.json();
    const items = data.incidents || [];

    incidentsLoading.classList.add('hidden');

    if (items.length === 0) {
      incidentsEmpty.classList.remove('hidden');
      if (incidentsEmptySub) {
        incidentsEmptySub.textContent = 'All monitors in this workspace are operating normally.';
      }
      if (currentIncidentFilter === 'open') {
        incidentsEmptyTitle.textContent = 'No Open Incidents';
      } else if (currentIncidentFilter === 'resolved') {
        incidentsEmptyTitle.textContent = 'No Resolved Incidents';
      } else {
        incidentsEmptyTitle.textContent = 'No Incidents Recorded';
      }
      return;
    }

    // Render cards using safe DOM construction and escHtml
    items.forEach((inc) => {
      const card = document.createElement('div');
      const isOpen = inc.status === 'open';
      card.className = `incident-card ${isOpen ? 'incident-card-open' : 'incident-card-resolved'}`;

      const openedAgo = timeAgo(inc.opened_at) || 'recently';
      const resolvedAgo = inc.resolved_at ? timeAgo(inc.resolved_at) : null;
      const statusBadgeClass = isOpen ? 'badge-fail' : 'badge-pass';

      card.innerHTML = `
        <div class="incident-card-header">
          <span class="badge ${statusBadgeClass}">${escHtml(inc.status.toUpperCase())}</span>
          <span class="incident-card-meta">Incident #${escHtml(inc.id)}</span>
        </div>
        <h4 class="incident-card-title">${escHtml(inc.api_name || 'Monitor #' + inc.api_id)}</h4>
        <div class="incident-card-meta">
          <span>Detected: ${escHtml(openedAgo)}</span>
          ${resolvedAgo ? `<span>Resolved: ${escHtml(resolvedAgo)}</span>` : ''}
          <span>Failures: ${escHtml(inc.unhealthy_count || 1)}</span>
        </div>
        ${inc.error_summary ? `<div class="incident-card-summary">${escHtml(inc.error_summary)}</div>` : ''}
      `;

      card.addEventListener('click', () => {
        openIncidentDetailModal(inc.id);
      });

      incidentsContainer.appendChild(card);
    });

    updateIncidentBadge();
  } catch (err) {
    incidentsLoading.classList.add('hidden');
    incidentsEmpty.classList.remove('hidden');
    incidentsEmptyTitle.textContent = 'Error loading incidents';
    if (incidentsEmptySub) {
      incidentsEmptySub.textContent = 'Could not load workspace incidents. Please check your connection or server status.';
    }
    console.error('loadIncidents error:', err.message);
  }
}

/**
 * Opens the Incident Detail Modal and loads chronological execution history.
 *
 * @param {number} incidentId
 */
async function openIncidentDetailModal(incidentId) {
  if (!activeWorkspaceId) return;

  try {
    const res = await apiFetch(`${getWorkspaceBaseUrl()}/incidents/${incidentId}`);
    if (!res.ok) {
      showToast('Could not load incident details', 'error');
      return;
    }

    const { incident, results } = await res.json();
    const isOpen = incident.status === 'open';

    incidentModalBadge.textContent = incident.status.toUpperCase();
    incidentModalBadge.className = `badge ${isOpen ? 'badge-fail' : 'badge-pass'}`;
    incidentModalTitle.textContent = `${incident.api_name || 'Monitor #' + incident.api_id} (Incident #${incident.id})`;

    incidentModalMeta.innerHTML = `
      <div><strong>Endpoint:</strong> <span class="font-mono text-muted">${escHtml(incident.api_url || '')}</span></div>
      <div><strong>Detected:</strong> ${escHtml(new Date(incident.opened_at).toLocaleString())}</div>
      <div><strong>First Unhealthy:</strong> ${escHtml(new Date(incident.first_unhealthy_at).toLocaleString())}</div>
      ${incident.resolved_at ? `<div><strong>Resolved:</strong> ${escHtml(new Date(incident.resolved_at).toLocaleString())}</div>` : ''}
      <div><strong>Unhealthy Streak Count:</strong> ${escHtml(incident.unhealthy_count || 1)}</div>
    `;

    incidentModalSummary.textContent = incident.error_summary || 'No error details recorded.';

    // Populate recent results table
    incidentResultsBody.innerHTML = '';
    if (results && results.length > 0) {
      results.forEach((r) => {
        const tr = document.createElement('tr');
        const isPassed = r.result === 'PASS' || r.result === 'passed';
        const badgeHtml = isPassed
          ? '<span class="badge badge-pass" style="font-size:0.7rem;padding:2px 6px">PASS</span>'
          : '<span class="badge badge-fail" style="font-size:0.7rem;padding:2px 6px">FAIL</span>';

        tr.innerHTML = `
          <td>${badgeHtml}</td>
          <td>${escHtml(timeAgo(r.tested_at) || 'recently')}</td>
          <td>${r.response_time != null ? `${escHtml(r.response_time)}ms` : '—'}</td>
          <td class="text-muted" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${escHtml(r.error_message || (isPassed ? 'OK' : 'Assertion failed'))}
          </td>
        `;
        incidentResultsBody.appendChild(tr);
      });
    } else {
      incidentResultsBody.innerHTML = '<tr><td colspan="4" class="text-muted text-center" style="padding:16px">No linked results found.</td></tr>';
    }

    incidentDetailModal.classList.remove('hidden');
    currentActiveIncidentId = incident.id;
    loadAiInvestigation(incident.id);
  } catch (err) {
    showToast('Failed to open incident detail', 'error');
  }
}

// ─── Phase 7 AI Incident Investigation Logic ─────────────────────────────
let currentActiveIncidentId = null;
let aiPollTimer = null;
let aiSystemStatus = null;

const aiStatusBadge = document.getElementById('aiStatusBadge');
const triggerAiAnalysisBtn = document.getElementById('triggerAiAnalysisBtn');
const aiStaleWarning = document.getElementById('aiStaleWarning');
const aiReanalyzeBtn = document.getElementById('aiReanalyzeBtn');
const aiLoadingContainer = document.getElementById('aiLoadingContainer');
const aiLoadingText = document.getElementById('aiLoadingText');
const aiErrorContainer = document.getElementById('aiErrorContainer');
const aiErrorTitle = document.getElementById('aiErrorTitle');
const aiErrorMessage = document.getElementById('aiErrorMessage');
const aiRetryBtn = document.getElementById('aiRetryBtn');
const aiResultContainer = document.getElementById('aiResultContainer');
const aiSummaryText = document.getElementById('aiSummaryText');
const aiMetaLine = document.getElementById('aiMetaLine');
const aiFactsList = document.getElementById('aiFactsList');
const aiHypothesesList = document.getElementById('aiHypothesesList');
const aiChecksList = document.getElementById('aiChecksList');
const aiUnknownsList = document.getElementById('aiUnknownsList');
const aiConfidenceBox = document.getElementById('aiConfidenceBox');

async function fetchAiSystemStatus() {
  if (!activeWorkspaceId) return;
  try {
    const res = await apiFetch(`${getWorkspaceBaseUrl()}/ai-status`);
    if (res.ok) {
      aiSystemStatus = await res.json();
    }
  } catch (_e) {
    aiSystemStatus = { enabled: false, provider: 'disabled' };
  }
}

async function loadAiInvestigation(incidentId) {
  clearTimeout(aiPollTimer);
  if (!activeWorkspaceId || !incidentId) return;

  // Reset UI containers
  aiStaleWarning?.classList.add('hidden');
  aiLoadingContainer?.classList.add('hidden');
  aiErrorContainer?.classList.add('hidden');
  aiResultContainer?.classList.add('hidden');

  if (!aiSystemStatus) {
    await fetchAiSystemStatus();
  }

  try {
    const res = await apiFetch(`${getWorkspaceBaseUrl()}/incidents/${incidentId}/ai-analysis`);
    if (!res.ok) {
      if (aiStatusBadge) {
        aiStatusBadge.textContent = 'NOT REQUESTED';
        aiStatusBadge.className = 'badge';
      }
      return;
    }

    const data = await res.json();
    const { analysis, is_stale } = data;

    if (!analysis) {
      if (aiStatusBadge) {
        if (!aiSystemStatus?.enabled) {
          aiStatusBadge.textContent = 'AI DISABLED';
          aiStatusBadge.className = 'badge';
          if (triggerAiAnalysisBtn) {
            triggerAiAnalysisBtn.title = 'AI is disabled in server configuration (AI_PROVIDER=disabled)';
          }
        } else {
          aiStatusBadge.textContent = 'NOT REQUESTED';
          aiStatusBadge.className = 'badge';
        }
      }
      return;
    }

    renderAiAnalysis(analysis, is_stale);

    // If job is pending or running, poll until terminal state
    if (analysis.status === 'pending' || analysis.status === 'running') {
      aiPollTimer = setTimeout(() => {
        if (currentActiveIncidentId === incidentId) {
          loadAiInvestigation(incidentId);
        }
      }, 2000);
    }
  } catch (err) {
    console.error('Error loading AI investigation:', err);
  }
}

function renderAiAnalysis(analysis, isStale = false) {
  if (!analysis) return;

  if (aiStatusBadge) {
    aiStatusBadge.textContent = (analysis.status || '').toUpperCase();
    if (analysis.status === 'completed') {
      aiStatusBadge.className = 'badge badge-pass';
    } else if (analysis.status === 'failed') {
      aiStatusBadge.className = 'badge badge-fail';
    } else {
      aiStatusBadge.className = 'badge badge-warn';
    }
  }

  if (isStale && analysis.status === 'completed') {
    aiStaleWarning?.classList.remove('hidden');
  } else {
    aiStaleWarning?.classList.add('hidden');
  }

  if (analysis.status === 'pending' || analysis.status === 'running') {
    aiLoadingContainer?.classList.remove('hidden');
    if (aiLoadingText) {
      aiLoadingText.textContent = analysis.status === 'pending'
        ? 'Analysis job queued in background worker...'
        : 'Analyzing incident evidence and contract validation findings...';
    }
    aiErrorContainer?.classList.add('hidden');
    aiResultContainer?.classList.add('hidden');
    return;
  }

  if (analysis.status === 'failed') {
    aiLoadingContainer?.classList.add('hidden');
    aiErrorContainer?.classList.remove('hidden');
    aiResultContainer?.classList.add('hidden');
    if (aiErrorTitle) aiErrorTitle.textContent = analysis.error_code || 'Investigation Failed';
    if (aiErrorMessage) aiErrorMessage.textContent = analysis.error_message || 'Could not complete AI investigation.';
    return;
  }

  if (analysis.status === 'completed' && analysis.result) {
    aiLoadingContainer?.classList.add('hidden');
    aiErrorContainer?.classList.add('hidden');
    aiResultContainer?.classList.remove('hidden');

    const res = analysis.result;

    if (aiSummaryText) {
      aiSummaryText.textContent = res.summary || 'No summary provided.';
    }

    if (aiMetaLine) {
      const dur = analysis.duration_ms ? `${analysis.duration_ms}ms` : '';
      const prov = analysis.provider ? `Provider: ${analysis.provider} (${analysis.model})` : '';
      const tok = analysis.tokens_total ? `${analysis.tokens_total} tokens` : '';
      aiMetaLine.textContent = [prov, dur, tok].filter(Boolean).join(' • ');
    }

    // Observed Facts
    if (aiFactsList) {
      aiFactsList.innerHTML = '';
      (res.observed_facts || []).forEach((f) => {
        const li = document.createElement('li');
        const pills = (f.evidence_ids || [])
          .map((id) => `<span class="ai-evidence-pill">${escHtml(id)}</span>`)
          .join('');
        li.innerHTML = `${pills} <span>${escHtml(f.fact)}</span>`;
        aiFactsList.appendChild(li);
      });
    }

    // Hypotheses
    if (aiHypothesesList) {
      aiHypothesesList.innerHTML = '';
      (res.hypotheses || []).forEach((h) => {
        const item = document.createElement('div');
        item.className = 'ai-hypothesis-item';
        const strengthClass = `strength-${(h.strength || 'moderate').toLowerCase()}`;
        const suppPills = (h.supporting_evidence_ids || [])
          .map((id) => `<span class="ai-evidence-pill">${escHtml(id)}</span>`)
          .join('');
        const contPills = (h.contradicting_evidence_ids || []).length > 0
          ? ` • Contradicted by: ` + (h.contradicting_evidence_ids || []).map((id) => `<span class="ai-evidence-pill">${escHtml(id)}</span>`).join('')
          : '';

        item.innerHTML = `
          <div class="ai-hypothesis-header">
            <span>${escHtml(h.hypothesis)}</span>
            <span class="ai-strength-badge ${strengthClass}">${escHtml(h.strength || 'moderate')}</span>
          </div>
          <div class="ai-hypothesis-rationale">${escHtml(h.rationale || '')}</div>
          <div>${suppPills}${contPills}</div>
        `;
        aiHypothesesList.appendChild(item);
      });
    }

    // Recommended Checks
    if (aiChecksList) {
      aiChecksList.innerHTML = '';
      (res.recommended_checks || []).forEach((c) => {
        const li = document.createElement('li');
        const pills = (c.evidence_ids || [])
          .map((id) => `<span class="ai-evidence-pill">${escHtml(id)}</span>`)
          .join('');
        li.innerHTML = `${pills} <strong>${escHtml(c.check)}</strong>: ${escHtml(c.rationale || '')}`;
        aiChecksList.appendChild(li);
      });
    }

    // Unknowns & Assessment
    if (aiUnknownsList) {
      aiUnknownsList.innerHTML = '';
      (res.unknowns || []).forEach((u) => {
        const li = document.createElement('li');
        li.textContent = u;
        aiUnknownsList.appendChild(li);
      });
    }

    if (aiConfidenceBox && res.overall_assessment) {
      const conf = res.overall_assessment.confidence || 'unknown';
      aiConfidenceBox.innerHTML = `
        <strong>Confidence: <span class="badge ${conf === 'high' ? 'badge-pass' : 'badge-warn'}">${escHtml(conf.toUpperCase())}</span></strong>
        <p style="margin:0.25rem 0 0 0;color:var(--text-muted)">${escHtml(res.overall_assessment.rationale || '')}</p>
      `;
    }
  }
}

async function triggerInvestigation(forceNew = false) {
  if (!activeWorkspaceId || !currentActiveIncidentId) return;

  if (triggerAiAnalysisBtn) {
    triggerAiAnalysisBtn.disabled = true;
    triggerAiAnalysisBtn.textContent = 'Enqueuing...';
  }

  try {
    const res = await apiFetch(`${getWorkspaceBaseUrl()}/incidents/${currentActiveIncidentId}/ai-analysis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: forceNew }),
    });

    if (!res.ok) {
      const data = await parseJsonResponse(res);
      throw new Error(data.error || 'Failed to request investigation');
    }

    showToast('AI analysis job enqueued', 'info');
    await loadAiInvestigation(currentActiveIncidentId);
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    if (triggerAiAnalysisBtn) {
      triggerAiAnalysisBtn.disabled = false;
      triggerAiAnalysisBtn.textContent = 'Investigate with AI';
    }
  }
}

triggerAiAnalysisBtn?.addEventListener('click', () => triggerInvestigation(false));
aiReanalyzeBtn?.addEventListener('click', () => triggerInvestigation(true));
aiRetryBtn?.addEventListener('click', () => triggerInvestigation(true));

/**
 * Opens and populates the Notification Settings Modal.
 */
async function openNotificationSettingsModal() {
  if (!activeWorkspaceId) return;

  settingsFeedback.textContent = '';
  settingsFeedback.className = 'feedback';

  try {
    const res = await apiFetch(`${getWorkspaceBaseUrl()}/notification-settings`);
    if (!res.ok) {
      showToast('Could not load notification settings', 'error');
      return;
    }

    const data = await res.json();
    const { settings, recipients, members, smtpConfigured, canEdit } = data;

    // Show/hide SMTP warning banner in Incidents view
    if (smtpNoticeBanner) {
      smtpNoticeBanner.classList.toggle('hidden', Boolean(smtpConfigured));
    }

    notifNotifyOnOpen.checked = Boolean(settings.notify_on_open);
    notifNotifyOnResolve.checked = Boolean(settings.notify_on_resolve);

    notifNotifyOnOpen.disabled = !canEdit;
    notifNotifyOnResolve.disabled = !canEdit;
    notifSettingsSaveBtn.disabled = !canEdit;

    const recipientIdSet = new Set(
      (recipients || [])
        .map((r) => r.user_id ?? r.id)
        .filter((id) => id !== null && id !== undefined && !isNaN(Number(id)))
        .map((id) => Number(id))
    );

    // Render workspace members with checkboxes
    recipientsListContainer.innerHTML = '';
    if (members && members.length > 0) {
      members.forEach((m) => {
        const rawUserId = m.user_id ?? m.id;
        const numUserId = Number(rawUserId);
        if (rawUserId === undefined || rawUserId === null || isNaN(numUserId) || !Number.isInteger(numUserId) || numUserId <= 0) {
          console.error('Invalid member record without valid user ID:', m);
          return;
        }

        const item = document.createElement('div');
        item.className = 'recipient-checkbox-item';
        const isChecked = recipientIdSet.has(numUserId);

        item.innerHTML = `
          <label class="checkbox-label" style="margin-bottom:0">
            <input type="checkbox" class="recipient-checkbox" value="${numUserId}" ${isChecked ? 'checked' : ''} ${!canEdit ? 'disabled' : ''} />
            <div class="recipient-info">
              <span>${escHtml(m.display_name || m.email)}</span>
              <span class="text-muted font-mono" style="font-size:0.75rem">&lt;${escHtml(m.email)}&gt;</span>
            </div>
          </label>
          <span class="recipient-role-badge">${escHtml(m.role || 'member')}</span>
        `;
        recipientsListContainer.appendChild(item);
      });
    } else {
      recipientsListContainer.innerHTML = '<p class="text-muted" style="font-size:0.8rem">No workspace members found.</p>';
    }

    if (!canEdit) {
      settingsFeedback.textContent = 'Only workspace owners can modify notification preferences.';
      settingsFeedback.className = 'feedback';
    }

    notificationSettingsModal.classList.remove('hidden');
  } catch (err) {
    showToast('Failed to open notification settings', 'error');
  }
}

// Notification Settings Form Submit
if (notificationSettingsForm) {
  notificationSettingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeWorkspaceId) return;

    notifSettingsSaveBtn.disabled = true;
    notifSettingsSaveBtn.textContent = 'Saving...';
    settingsFeedback.textContent = '';

    let recipientUserIds;
    try {
      const selectedCheckboxes = recipientsListContainer.querySelectorAll('.recipient-checkbox:checked');
      recipientUserIds = Array.from(selectedCheckboxes).map((cb) => {
        const val = cb.value;
        if (val === '' || val === 'null' || val === 'undefined') {
          throw new Error('Invalid recipient user ID: value is null or undefined');
        }
        const num = Number(val);
        if (isNaN(num) || !Number.isInteger(num) || num <= 0) {
          throw new Error(`Invalid recipient user ID: "${val}"`);
        }
        return num;
      });
    } catch (parseErr) {
      settingsFeedback.textContent = parseErr.message;
      settingsFeedback.className = 'feedback error';
      notifSettingsSaveBtn.disabled = false;
      notifSettingsSaveBtn.textContent = 'Save Settings';
      return;
    }

    const payload = {
      notify_on_open: notifNotifyOnOpen.checked,
      notify_on_resolve: notifNotifyOnResolve.checked,
      recipient_user_ids: recipientUserIds,
    };

    try {
      const res = await apiFetch(`${getWorkspaceBaseUrl()}/notification-settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await parseJsonResponse(res);
      if (!res.ok) {
        throw new Error(data.error || 'Failed to update settings');
      }

      showToast('Notification settings saved successfully!', 'success');
      notificationSettingsModal.classList.add('hidden');
    } catch (err) {
      settingsFeedback.textContent = err.message || 'Error updating settings';
      settingsFeedback.className = 'feedback error';
    } finally {
      notifSettingsSaveBtn.disabled = false;
      notifSettingsSaveBtn.textContent = 'Save Settings';
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 6: OPENAPI CONTRACTS CONTROLLER
// ─────────────────────────────────────────────────────────────────────────────

// DOM Elements
const contractsRefreshBtn = document.getElementById('contractsRefreshBtn');
const importContractBtn = document.getElementById('importContractBtn');
const contractsLoading = document.getElementById('contractsLoading');
const contractsEmpty = document.getElementById('contractsEmpty');
const contractsEmptyTitle = document.getElementById('contractsEmptyTitle');
const contractsEmptySub = document.getElementById('contractsEmptySub');
const contractsContainer = document.getElementById('contractsContainer');

// Import Contract Modal Elements
const importContractModal = document.getElementById('importContractModal');
const importContractClose = document.getElementById('importContractClose');
const importContractCancel = document.getElementById('importContractCancel');
const importContractForm = document.getElementById('importContractForm');
const importContractName = document.getElementById('importContractName');
const importContractDesc = document.getElementById('importContractDesc');
const importContractSpec = document.getElementById('importContractSpec');
const importContractFile = document.getElementById('importContractFile');
const importContractFeedback = document.getElementById('importContractFeedback');
const importContractSubmitBtn = document.getElementById('importContractSubmitBtn');

// Contract Detail Modal Elements
const contractDetailModal = document.getElementById('contractDetailModal');
const contractDetailClose = document.getElementById('contractDetailClose');
const contractDetailTitle = document.getElementById('contractDetailTitle');
const contractDetailDesc = document.getElementById('contractDetailDesc');
const archiveContractBtn = document.getElementById('archiveContractBtn');
const addRevisionBtn = document.getElementById('addRevisionBtn');
const revisionSelect = document.getElementById('revisionSelect');
const revisionMeta = document.getElementById('revisionMeta');
const operationsCountBadge = document.getElementById('operationsCountBadge');
const operationsList = document.getElementById('operationsList');

// New Revision Modal Elements
const newRevisionModal = document.getElementById('newRevisionModal');
const newRevisionClose = document.getElementById('newRevisionClose');
const newRevisionCancel = document.getElementById('newRevisionCancel');
const newRevisionForm = document.getElementById('newRevisionForm');
const newRevisionSpec = document.getElementById('newRevisionSpec');
const newRevisionFile = document.getElementById('newRevisionFile');
const newRevisionFeedback = document.getElementById('newRevisionFeedback');
const newRevisionSubmitBtn = document.getElementById('newRevisionSubmitBtn');

// Bind Contract Modal Elements
const bindContractModal = document.getElementById('bindContractModal');
const bindContractClose = document.getElementById('bindContractClose');
const bindContractCancel = document.getElementById('bindContractCancel');
const bindContractForm = document.getElementById('bindContractForm');
const bindContractSubtitle = document.getElementById('bindContractSubtitle');
const bindContractSelect = document.getElementById('bindContractSelect');
const bindRevisionSelect = document.getElementById('bindRevisionSelect');
const bindOperationSelect = document.getElementById('bindOperationSelect');
const bindContractFeedback = document.getElementById('bindContractFeedback');
const unbindContractBtn = document.getElementById('unbindContractBtn');
const bindContractSubmitBtn = document.getElementById('bindContractSubmitBtn');

let activeContractDetailId = null;
let activeBindingTargetApi = null;
let cachedContractsList = [];

// Helper: Check if current user is owner of active workspace
function isCurrentWorkspaceOwner() {
  if (!activeWorkspaceId || !userWorkspaces) return false;
  const ws = userWorkspaces.find((w) => w.id === activeWorkspaceId);
  return ws ? ws.role === 'owner' : false;
}

// ── Load Contracts List ──
async function loadContracts() {
  if (!activeWorkspaceId) return;

  const isOwner = isCurrentWorkspaceOwner();
  if (importContractBtn) {
    importContractBtn.disabled = !isOwner;
    importContractBtn.title = isOwner ? 'Import OpenAPI Contract' : 'Only workspace owners can import contracts';
  }

  if (contractsLoading) contractsLoading.classList.remove('hidden');
  if (contractsEmpty) contractsEmpty.classList.add('hidden');
  if (contractsContainer) contractsContainer.innerHTML = '';

  try {
    const res = await apiFetch(`${getWorkspaceBaseUrl()}/contracts`);
    if (!res.ok) {
      throw new Error(`Failed to load contracts (HTTP ${res.status})`);
    }

    const data = await res.json();
    cachedContractsList = Array.isArray(data) ? data : (data.contracts || []);

    if (contractsLoading) contractsLoading.classList.add('hidden');

    if (cachedContractsList.length === 0) {
      if (contractsEmpty) contractsEmpty.classList.remove('hidden');
      return;
    }

    cachedContractsList.forEach((c) => {
      const card = document.createElement('div');
      card.className = 'contract-card';
      const updatedAgo = c.updated_at ? timeAgo(c.updated_at) : 'recently';

      card.innerHTML = `
        <div>
          <div class="contract-card-header">
            <h4 class="contract-card-title">${escHtml(c.name)}</h4>
            <span class="badge" style="background: rgba(6,182,212,0.15); color: var(--accent-cyan); font-family: var(--font-mono); font-size: 0.72rem;">${escHtml(c.revisions_count || 1)} rev</span>
          </div>
          ${c.description ? `<p class="contract-card-desc">${escHtml(c.description)}</p>` : '<p class="contract-card-desc text-muted">No description provided.</p>'}
          <div class="contract-card-meta">
            <span>Updated: ${escHtml(updatedAgo)}</span>
            <span>ID: ${escHtml(c.id)}</span>
          </div>
        </div>
        <div class="contract-card-actions">
          <button class="btn btn-secondary btn-sm" id="viewContractBtn-${c.id}">View Operations</button>
          <button class="btn btn-ghost btn-sm" id="newRevBtn-${c.id}">+ New Revision</button>
        </div>
      `;

      contractsContainer.appendChild(card);

      document.getElementById(`viewContractBtn-${c.id}`)?.addEventListener('click', () => {
        openContractDetailModal(c.id);
      });

      document.getElementById(`newRevBtn-${c.id}`)?.addEventListener('click', () => {
        openNewRevisionModal(c.id);
      });
    });
  } catch (err) {
    if (contractsLoading) contractsLoading.classList.add('hidden');
    if (contractsEmpty) {
      contractsEmpty.classList.remove('hidden');
      if (contractsEmptyTitle) contractsEmptyTitle.textContent = 'Error loading contracts';
      if (contractsEmptySub) contractsEmptySub.textContent = err.message || 'Please check your connection.';
    }
  }
}

// ── Import Contract Modal ──
function openImportContractModal() {
  if (importContractForm) importContractForm.reset();
  if (importContractFeedback) {
    importContractFeedback.textContent = '';
    importContractFeedback.className = 'feedback hidden';
  }
  importContractModal?.classList.remove('hidden');
}

function closeImportContractModal() {
  importContractModal?.classList.add('hidden');
}

importContractBtn?.addEventListener('click', openImportContractModal);
importContractClose?.addEventListener('click', closeImportContractModal);
importContractCancel?.addEventListener('click', closeImportContractModal);
contractsRefreshBtn?.addEventListener('click', loadContracts);

// File upload helper for import
importContractFile?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    if (importContractSpec) importContractSpec.value = event.target.result;
  };
  reader.readAsText(file);
});

// Import Contract Submit
importContractForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activeWorkspaceId) return;

  const name = importContractName.value.trim();
  const description = importContractDesc.value.trim() || undefined;
  const specification = importContractSpec.value.trim();

  if (!name || !specification) {
    if (importContractFeedback) {
      importContractFeedback.textContent = 'Contract name and specification content are required.';
      importContractFeedback.className = 'feedback error';
      importContractFeedback.classList.remove('hidden');
    }
    return;
  }

  try {
    importContractSubmitBtn.disabled = true;
    importContractSubmitBtn.textContent = 'Validating & Importing...';
    if (importContractFeedback) importContractFeedback.classList.add('hidden');

    const res = await apiFetch(`${getWorkspaceBaseUrl()}/contracts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, specification }),
    });

    const data = await parseJsonResponse(res);
    if (!res.ok) {
      throw new Error(data.error || 'Failed to import contract');
    }

    showToast('Contract imported and validated successfully!', 'success');
    closeImportContractModal();
    loadContracts();
  } catch (err) {
    if (importContractFeedback) {
      importContractFeedback.textContent = err.message;
      importContractFeedback.className = 'feedback error';
      importContractFeedback.classList.remove('hidden');
    }
  } finally {
    importContractSubmitBtn.disabled = false;
    importContractSubmitBtn.textContent = 'Import & Validate';
  }
});

// ── Contract Detail Modal ──
async function openContractDetailModal(contractId) {
  if (!activeWorkspaceId) return;
  activeContractDetailId = contractId;

  try {
    const res = await apiFetch(`${getWorkspaceBaseUrl()}/contracts/${contractId}`);
    if (!res.ok) throw new Error('Could not load contract details');

    const { contract, revisions } = await res.json();

    if (contractDetailTitle) contractDetailTitle.textContent = contract.name;
    if (contractDetailDesc) contractDetailDesc.textContent = contract.description || 'No description provided.';

    const isOwner = isCurrentWorkspaceOwner();
    if (addRevisionBtn) {
      addRevisionBtn.style.display = isOwner ? 'inline-block' : 'none';
    }
    if (archiveContractBtn) {
      archiveContractBtn.style.display = isOwner ? 'inline-block' : 'none';
    }

    // Populate revisions dropdown
    if (revisionSelect) {
      revisionSelect.innerHTML = '';
      (revisions || []).forEach((rev) => {
        const opt = document.createElement('option');
        opt.value = rev.revision_number;
        opt.textContent = `Revision ${rev.revision_number} (${rev.openapi_version || 'OpenAPI 3.x'}${rev.is_active ? ' - active' : ''})`;
        revisionSelect.appendChild(opt);
      });

      // Default to highest/latest revision
      if (revisions && revisions.length > 0) {
        const latestRev = revisions[revisions.length - 1];
        revisionSelect.value = latestRev.revision_number;
        await loadRevisionOperations(contractId, latestRev.revision_number);
      }
    }

    contractDetailModal?.classList.remove('hidden');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function loadRevisionOperations(contractId, revisionNumber) {
  if (!activeWorkspaceId) return;

  try {
    const res = await apiFetch(`${getWorkspaceBaseUrl()}/contracts/${contractId}/revisions/${revisionNumber}`);
    if (!res.ok) throw new Error('Could not load revision details');

    const rev = await res.json();
    if (revisionMeta) {
      const hashShort = rev.content_sha256 ? rev.content_sha256.substring(0, 16) + '...' : 'unknown';
      revisionMeta.textContent = `SHA: ${hashShort} · Created: ${timeAgo(rev.created_at) || 'recently'}`;
    }

    let ops = [];
    try {
      ops = typeof rev.operations === 'string' ? JSON.parse(rev.operations) : (rev.operations || []);
    } catch (_) {
      ops = [];
    }

    if (operationsCountBadge) operationsCountBadge.textContent = ops.length;

    if (operationsList) {
      if (ops.length === 0) {
        operationsList.innerHTML = '<div style="padding: 20px; text-align: center;" class="text-muted">No operations declared in this revision.</div>';
      } else {
        const rows = ops.map((op) => `
          <tr>
            <td style="width: 80px;"><span class="op-method-tag badge-${(op.method || 'GET').toUpperCase()}">${escHtml(op.method || 'GET')}</span></td>
            <td style="font-family: var(--font-mono); font-weight: 500;">${escHtml(op.path || '/')}</td>
            <td class="text-muted">${escHtml(op.summary || op.operationId || '—')}</td>
          </tr>
        `).join('');

        operationsList.innerHTML = `
          <table class="operations-table">
            <thead>
              <tr>
                <th>Method</th>
                <th>Path Template</th>
                <th>Summary / Operation ID</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        `;
      }
    }
  } catch (err) {
    if (operationsList) {
      operationsList.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--accent-red);">${escHtml(err.message)}</div>`;
    }
  }
}

revisionSelect?.addEventListener('change', () => {
  if (activeContractDetailId && revisionSelect.value) {
    loadRevisionOperations(activeContractDetailId, Number(revisionSelect.value));
  }
});

contractDetailClose?.addEventListener('click', () => {
  contractDetailModal?.classList.add('hidden');
});

addRevisionBtn?.addEventListener('click', () => {
  if (activeContractDetailId) {
    openNewRevisionModal(activeContractDetailId);
  }
});

archiveContractBtn?.addEventListener('click', async () => {
  if (!activeWorkspaceId || !activeContractDetailId) return;
  if (!confirm('Are you sure you want to archive or delete this contract? If monitors are currently bound to it, they must be unbound first.')) {
    return;
  }

  try {
    const res = await apiFetch(`${getWorkspaceBaseUrl()}/contracts/${activeContractDetailId}`, {
      method: 'DELETE',
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Failed to archive contract', 'error');
      return;
    }

    showToast(data.message || 'Contract archived successfully', 'success');
    contractDetailModal?.classList.add('hidden');
    await loadContracts();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
});

// ── New Revision Modal ──
function openNewRevisionModal(contractId) {
  activeContractDetailId = contractId;
  if (newRevisionForm) newRevisionForm.reset();
  if (newRevisionFeedback) {
    newRevisionFeedback.textContent = '';
    newRevisionFeedback.className = 'feedback hidden';
  }
  newRevisionModal?.classList.remove('hidden');
}

function closeNewRevisionModal() {
  newRevisionModal?.classList.add('hidden');
}

newRevisionClose?.addEventListener('click', closeNewRevisionModal);
newRevisionCancel?.addEventListener('click', closeNewRevisionModal);

newRevisionFile?.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    if (newRevisionSpec) newRevisionSpec.value = event.target.result;
  };
  reader.readAsText(file);
});

newRevisionForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activeWorkspaceId || !activeContractDetailId) return;

  const specification = newRevisionSpec.value.trim();
  if (!specification) {
    if (newRevisionFeedback) {
      newRevisionFeedback.textContent = 'Specification content is required.';
      newRevisionFeedback.className = 'feedback error';
      newRevisionFeedback.classList.remove('hidden');
    }
    return;
  }

  try {
    newRevisionSubmitBtn.disabled = true;
    newRevisionSubmitBtn.textContent = 'Publishing...';
    if (newRevisionFeedback) newRevisionFeedback.classList.add('hidden');

    const res = await apiFetch(`${getWorkspaceBaseUrl()}/contracts/${activeContractDetailId}/revisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specification }),
    });

    const data = await parseJsonResponse(res);
    if (!res.ok) {
      throw new Error(data.error || 'Failed to publish revision');
    }

    showToast(`Published Revision ${data.revision.revision_number} successfully!`, 'success');
    closeNewRevisionModal();
    if (!contractDetailModal?.classList.contains('hidden')) {
      openContractDetailModal(activeContractDetailId);
    }
    loadContracts();
  } catch (err) {
    if (newRevisionFeedback) {
      newRevisionFeedback.textContent = err.message;
      newRevisionFeedback.className = 'feedback error';
      newRevisionFeedback.classList.remove('hidden');
    }
  } finally {
    newRevisionSubmitBtn.disabled = false;
    newRevisionSubmitBtn.textContent = 'Publish Revision';
  }
});

// ── Bind Monitor to Contract Modal ──
async function openBindContractModal(api) {
  if (!activeWorkspaceId) return;
  activeBindingTargetApi = api;

  if (bindContractSubtitle) {
    bindContractSubtitle.textContent = `Bind "${api.name}" (${api.method} ${api.url}) to an OpenAPI contract operation.`;
  }
  if (bindContractFeedback) {
    bindContractFeedback.textContent = '';
    bindContractFeedback.className = 'feedback hidden';
  }

  // Load contracts and current binding
  try {
    const [bindingRes, contractsRes] = await Promise.all([
      apiFetch(`${getWorkspaceBaseUrl()}/apis/${api.id}/contract-binding`),
      apiFetch(`${getWorkspaceBaseUrl()}/contracts`),
    ]);

    const bindingData = bindingRes.ok ? await bindingRes.json() : { binding: null };
    const currentBinding = bindingData.binding;

    const contractsData = contractsRes.ok ? await contractsRes.json() : [];
    const contracts = Array.isArray(contractsData) ? contractsData : (contractsData.contracts || []);
    cachedContractsList = contracts;

    if (bindContractSelect) {
      bindContractSelect.innerHTML = '<option value="">-- Choose Contract --</option>';
      contracts.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = `${c.name} (${c.revisions_count || 1} rev)`;
        bindContractSelect.appendChild(opt);
      });
    }

    if (currentBinding) {
      unbindContractBtn?.classList.remove('hidden');
      bindContractSelect.value = currentBinding.contract_id;
      await onBindContractChange(currentBinding.contract_id, currentBinding.contract_revision_id, currentBinding.operation_method, currentBinding.operation_path);
    } else {
      unbindContractBtn?.classList.add('hidden');
      if (bindRevisionSelect) bindRevisionSelect.innerHTML = '<option value="">-- Choose Revision --</option>';
      if (bindOperationSelect) bindOperationSelect.innerHTML = '<option value="">-- Choose Operation --</option>';
    }

    bindContractModal?.classList.remove('hidden');
  } catch (err) {
    showToast(`Failed to open binding: ${err.message}`, 'error');
  }
}

async function onBindContractChange(contractId, targetRevisionId = null, targetMethod = null, targetPath = null) {
  if (!contractId || !activeWorkspaceId) {
    if (bindRevisionSelect) bindRevisionSelect.innerHTML = '<option value="">-- Choose Revision --</option>';
    if (bindOperationSelect) bindOperationSelect.innerHTML = '<option value="">-- Choose Operation --</option>';
    return;
  }

  try {
    const res = await apiFetch(`${getWorkspaceBaseUrl()}/contracts/${contractId}`);
    if (!res.ok) return;
    const { revisions } = await res.json();

    if (bindRevisionSelect) {
      bindRevisionSelect.innerHTML = '';
      (revisions || []).forEach((rev) => {
        const opt = document.createElement('option');
        opt.value = rev.revision_number;
        opt.dataset.revisionId = rev.id;
        opt.textContent = `Revision ${rev.revision_number} (${rev.openapi_version || 'OpenAPI 3.x'})`;
        bindRevisionSelect.appendChild(opt);
      });

      if (revisions && revisions.length > 0) {
        if (targetRevisionId) {
          const matchRev = revisions.find((r) => r.id === targetRevisionId);
          if (matchRev) bindRevisionSelect.value = matchRev.revision_number;
        } else {
          bindRevisionSelect.value = revisions[revisions.length - 1].revision_number;
        }
      }
    }

    await onBindRevisionChange(contractId, Number(bindRevisionSelect.value), targetMethod, targetPath);
  } catch (err) {
    console.error('Error in onBindContractChange:', err);
  }
}

async function onBindRevisionChange(contractId, revisionNumber, targetMethod = null, targetPath = null) {
  if (!contractId || !revisionNumber || !activeWorkspaceId) {
    if (bindOperationSelect) bindOperationSelect.innerHTML = '<option value="">-- Choose Operation --</option>';
    return;
  }

  try {
    const res = await apiFetch(`${getWorkspaceBaseUrl()}/contracts/${contractId}/revisions/${revisionNumber}`);
    if (!res.ok) return;
    const rev = await res.json();

    let ops = [];
    try {
      ops = typeof rev.operations === 'string' ? JSON.parse(rev.operations) : (rev.operations || []);
    } catch (_) {
      ops = [];
    }

    if (bindOperationSelect) {
      bindOperationSelect.innerHTML = '';
      if (ops.length === 0) {
        bindOperationSelect.innerHTML = '<option value="">No operations in this revision</option>';
        return;
      }

      ops.forEach((op) => {
        const opt = document.createElement('option');
        opt.value = `${(op.method || 'GET').toUpperCase()}|${op.path}`;
        opt.textContent = `${(op.method || 'GET').toUpperCase()} ${op.path}${op.summary ? ' - ' + op.summary : ''}`;
        bindOperationSelect.appendChild(opt);
      });

      if (targetMethod && targetPath) {
        bindOperationSelect.value = `${targetMethod.toUpperCase()}|${targetPath}`;
      } else if (activeBindingTargetApi) {
        // Try auto-match by method and path
        const matchingOp = ops.find((o) => o.method.toUpperCase() === activeBindingTargetApi.method.toUpperCase());
        if (matchingOp) {
          bindOperationSelect.value = `${matchingOp.method.toUpperCase()}|${matchingOp.path}`;
        }
      }
    }
  } catch (err) {
    console.error('Error in onBindRevisionChange:', err);
  }
}

bindContractSelect?.addEventListener('change', () => {
  onBindContractChange(Number(bindContractSelect.value));
});

bindRevisionSelect?.addEventListener('change', () => {
  onBindRevisionChange(Number(bindContractSelect.value), Number(bindRevisionSelect.value));
});

bindContractClose?.addEventListener('click', () => {
  bindContractModal?.classList.add('hidden');
});

bindContractCancel?.addEventListener('click', () => {
  bindContractModal?.classList.add('hidden');
});

// Save Binding Submit
bindContractForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activeWorkspaceId || !activeBindingTargetApi) return;

  const contractId = Number(bindContractSelect.value);
  const revisionNumber = Number(bindRevisionSelect.value);
  const opValue = bindOperationSelect.value;

  if (!contractId || !revisionNumber || !opValue || !opValue.includes('|')) {
    if (bindContractFeedback) {
      bindContractFeedback.textContent = 'Please select a contract, revision, and operation.';
      bindContractFeedback.className = 'feedback error';
      bindContractFeedback.classList.remove('hidden');
    }
    return;
  }

  const [operation_method, operation_path] = opValue.split('|');

  try {
    bindContractSubmitBtn.disabled = true;
    bindContractSubmitBtn.textContent = 'Binding...';
    if (bindContractFeedback) bindContractFeedback.classList.add('hidden');

    const res = await apiFetch(`${getWorkspaceBaseUrl()}/apis/${activeBindingTargetApi.id}/contract-binding`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contract_id: contractId,
        revision_number: revisionNumber,
        operation_method,
        operation_path,
      }),
    });

    const data = await parseJsonResponse(res);
    if (!res.ok) throw new Error(data.error || 'Failed to bind contract');

    showToast('Monitor bound to OpenAPI contract operation!', 'success');
    bindContractModal?.classList.add('hidden');
    loadApis();
  } catch (err) {
    if (bindContractFeedback) {
      bindContractFeedback.textContent = err.message;
      bindContractFeedback.className = 'feedback error';
      bindContractFeedback.classList.remove('hidden');
    }
  } finally {
    bindContractSubmitBtn.disabled = false;
    bindContractSubmitBtn.textContent = 'Save Binding';
  }
});

// Unbind Contract Button
unbindContractBtn?.addEventListener('click', async () => {
  if (!activeWorkspaceId || !activeBindingTargetApi) return;

  try {
    unbindContractBtn.disabled = true;
    unbindContractBtn.textContent = 'Unbinding...';

    const res = await apiFetch(`${getWorkspaceBaseUrl()}/apis/${activeBindingTargetApi.id}/contract-binding`, {
      method: 'DELETE',
    });

    if (!res.ok) {
      const data = await parseJsonResponse(res);
      throw new Error(data.error || 'Failed to unbind contract');
    }

    showToast('Monitor contract binding removed', 'info');
    bindContractModal?.classList.add('hidden');
    loadApis();
  } catch (err) {
    showToast(`Error unbinding: ${err.message}`, 'error');
  } finally {
    unbindContractBtn.disabled = false;
    unbindContractBtn.textContent = 'Unbind Contract';
  }
});
