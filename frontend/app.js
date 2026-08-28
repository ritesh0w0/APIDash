/* app.js — API Health Monitor Frontend Logic */
const API_BASE = 'http://localhost:5000/api';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const addApiForm   = document.getElementById('addApiForm');
const addBtn       = document.getElementById('addBtn');
const addFeedback  = document.getElementById('addFeedback');
const apiListEl    = document.getElementById('apiList');
const emptyState   = document.getElementById('emptyState');
const refreshBtn   = document.getElementById('refreshBtn');
const totalCountEl = document.getElementById('totalCount');

const resultModal  = document.getElementById('resultModal');
const modalClose   = document.getElementById('modalClose');
const modalTitle   = document.getElementById('modalTitle');
const resultBadge  = document.getElementById('resultBadge');
const resultGrid   = document.getElementById('resultGrid');
const resultJsonEl = document.getElementById('resultJson');
const toastEl      = document.getElementById('toast');

// ── Stat card refs ────────────────────────────────────────────────────────────
const scTotal   = document.getElementById('scTotal');
const scPassing = document.getElementById('scPassing');
const scFailing = document.getElementById('scFailing');
const scAvgTime = document.getElementById('scAvgTime');
const chartLegendEl = document.getElementById('chartLegend');
const chartEmptyEl  = document.getElementById('chartEmpty');

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
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3000);
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
  if (diff < 5)  return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// ── Load API list ─────────────────────────────────────────────────────────────
async function loadApis() {
  try {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '↺ Loading…';

    const res  = await fetch(`${API_BASE}/list`);
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
  // No test run yet
  if (!api.last_result) {
    return `<div class="card-result card-result-pending">⏳ Not tested yet</div>`;
  }

  const isPass = api.last_result === 'PASS';
  const ago    = timeAgo(api.last_tested_at);

  return `
    <div class="card-result ${isPass ? 'card-result-pass' : 'card-result-fail'}">
      <span class="cr-badge ${isPass ? 'cr-pass' : 'cr-fail'}">${api.last_result}</span>
      <span class="cr-stat">
        <span class="cr-label">Status</span>
        <span class="cr-value">${api.last_status_code ?? 'N/A'}</span>
      </span>
      <span class="cr-divider"></span>
      <span class="cr-stat">
        <span class="cr-label">Time</span>
        <span class="cr-value">${api.last_response_time != null ? api.last_response_time + ' ms' : 'N/A'}</span>
      </span>
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

    const dotClass = api.last_result === 'PASS' ? 'pass'
                   : api.last_result === 'FAIL' ? 'fail' : '';

    card.innerHTML = `
      <div class="card-top">
        <span class="card-status-dot ${dotClass}" id="dot-${api.id}"></span>
        <span class="api-method-badge badge-${api.method}">${api.method}</span>
        <div class="api-info">
          <div class="api-name" title="${escHtml(api.name)}">${escHtml(api.name)}</div>
          <div class="api-url"  title="${escHtml(api.url)}">${escHtml(api.url)}</div>
          <div class="api-meta">Expected: <strong>${api.expected_status}</strong> &nbsp;·&nbsp; ID: ${api.id}</div>
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

    // ── Attach listeners AFTER the card is in the DOM ────────────────────────
    document.getElementById(`testBtn-${api.id}`)
      .addEventListener('click', () => runTest(api.id, api.name));

    // Two-step delete: first click asks, second click within 3s confirms
    const delBtn = document.getElementById(`delBtn-${api.id}`);
    let delPending = false;
    let delTimer;
    delBtn.addEventListener('click', () => {
      if (!delPending) {
        // First click — ask for confirmation on the button itself
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
        // Second click — actually delete
        clearTimeout(delTimer);
        deleteApi(api.id);
      }
    });
  });
}

// ── Update a single card's result strip (after manual test) ──────────────────
function updateCardResult(id, data) {
  const wrap = document.getElementById(`result-${id}`);
  const dot  = document.getElementById(`dot-${id}`);
  if (!wrap) return;

  const isPass = data.result === 'PASS';

  // Synthesise a fake "api" shape so we can reuse buildResultStrip
  wrap.innerHTML = buildResultStrip({
    last_result:        data.result,
    last_status_code:   data.status_code,
    last_response_time: data.response_time,
    last_tested_at:     new Date().toISOString(),
  });

  if (dot) {
    dot.className = `card-status-dot ${isPass ? 'pass' : 'fail'}`;
  }
}

// ── Escape HTML helper ─────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── ADD API ───────────────────────────────────────────────────────────────────
addApiForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const name            = document.getElementById('apiName').value.trim();
  const url             = document.getElementById('apiUrl').value.trim();
  const method          = document.getElementById('apiMethod').value;
  const expected_status = parseInt(document.getElementById('expectedStatus').value, 10);

  if (!name || !url) {
    showFeedback('⚠ Name and URL are required.', 'error');
    return;
  }

  addBtn.disabled = true;
  addBtn.innerHTML = '<span class="spinner"></span> Adding…';

  try {
    const res  = await fetch(`${API_BASE}/add`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, url, method, expected_status }),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Failed to add API');

    showFeedback(`✅ "${data.api.name}" added (ID: ${data.api.id})`, 'success');
    addApiForm.reset();
    await loadApis();
    showToast(`"${data.api.name}" is now being monitored!`, 'success');
  } catch (err) {
    showFeedback(`❌ ${err.message}`, 'error');
    showToast(err.message, 'error');
  } finally {
    addBtn.disabled = false;
    addBtn.innerHTML = '<span class="btn-icon">＋</span> Add &amp; Monitor';
  }
});

// ── RUN TEST ──────────────────────────────────────────────────────────────────
async function runTest(id, name) {
  const btn = document.getElementById(`testBtn-${id}`);
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Testing…'; }

  try {
    const res  = await fetch(`${API_BASE}/test/${id}`);
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Test failed');

    // ① Update the card's result strip immediately — no full page reload needed
    updateCardResult(id, data);

    // ② Also open the result modal as before
    openResultModal(name, data);

  } catch (err) {
    showToast(`Test error: ${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '▶ Test Now'; }
  }
}

// ── DELETE API ────────────────────────────────────────────────────────────────
async function deleteApi(id) {
  try {
    const res = await fetch(`${API_BASE}/delete/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server returned ${res.status}`);
    }
    showToast('API removed successfully.', 'success');
    await loadApis();
  } catch (err) {
    showToast(`Delete failed: ${err.message}`, 'error');
  }
}

// ── Result Modal ──────────────────────────────────────────────────────────────
function openResultModal(name, data) {
  modalTitle.textContent = `Test Result — ${name}`;

  const isPass = data.result === 'PASS';
  resultBadge.textContent = data.result;
  resultBadge.className   = `result-badge ${isPass ? 'badge-pass' : 'badge-fail'}`;

  const items = [
    { label: 'Status Code',   value: data.status_code   ?? 'N/A', color: isPass ? 'green' : 'red' },
    { label: 'Response Time', value: data.response_time != null ? `${data.response_time} ms` : 'N/A', color: 'cyan' },
    { label: 'Expected',      value: data.expected_status ?? '—', color: '' },
    { label: 'Method',        value: data.method ?? '—',          color: '' },
  ];

  resultGrid.innerHTML = items.map(({ label, value, color }) => `
    <div class="result-item">
      <div class="result-item-label">${label}</div>
      <div class="result-item-value ${color ? 'value-' + color : ''}">${value}</div>
    </div>
  `).join('');

  const display = {
    status:        data.status_code,
    response_time: data.response_time,
    result:        data.result,
    ...(data.error_message ? { error: data.error_message } : {}),
  };

  resultJsonEl.textContent = JSON.stringify(display, null, 2);
  resultModal.classList.remove('hidden');
}

function closeModal() { resultModal.classList.add('hidden'); }

modalClose.addEventListener('click', closeModal);
resultModal.addEventListener('click', (e) => { if (e.target === resultModal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ── Refresh button ────────────────────────────────────────────────────────────
refreshBtn.addEventListener('click', () => { loadApis(); loadStats(); loadChart(); });

// ── Load stats cards ─────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const res  = await fetch(`${API_BASE}/stats`);
    const data = await res.json();

    scTotal.textContent   = data.total   ?? 0;
    scPassing.textContent = data.passing  ?? 0;
    scFailing.textContent = data.failing  ?? 0;
    scAvgTime.textContent = data.avg_response_time != null
      ? `${data.avg_response_time} ms` : '—';
  } catch (_) { /* silent fail — stats are non-critical */ }
}

// ── Load & render the response-time chart ────────────────────────────────────
async function loadChart() {
  try {
    const res  = await fetch(`${API_BASE}/chart-data`);
    const data = await res.json();

    const apiIds = Object.keys(data);

    // Hide chart / show empty state if no data at all
    const hasAnyPoints = apiIds.some(id => data[id].points.length > 0);
    chartEmptyEl.classList.toggle('hidden', hasAnyPoints);
    document.getElementById('responseChart').parentElement
      .style.display = hasAnyPoints ? '' : 'none';
    if (!hasAnyPoints) { chartLegendEl.innerHTML = ''; return; }

    // Build datasets
    const datasets = apiIds.map((id, idx) => {
      const color  = CHART_COLORS[idx % CHART_COLORS.length];
      const points = data[id].points;

      return {
        label:           data[id].name,
        data:            points.map(p => p.response_time ?? null),
        borderColor:     color,
        backgroundColor: color + '22',
        pointBackgroundColor: points.map(p =>
          p.result === 'PASS' ? '#3dffa0' :
          p.result === 'FAIL' ? '#ff5c77' : color
        ),
        pointRadius:     5,
        pointHoverRadius: 8,
        borderWidth:     2,
        tension:         0.4,
        fill:            false,
        spanGaps:        true,
      };
    });

    // X-axis labels = timestamps from the API with the most points
    const richestId  = apiIds.reduce((best, id) =>
      data[id].points.length >= data[best].points.length ? id : best, apiIds[0]);
    const labels = data[richestId].points.map(p => {
      const d = new Date(p.tested_at);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    });

    // Chart.js global defaults (dark theme)
    const defaults = {
      color:  '#8b96c8',
      font:   { family: "'Inter', sans-serif", size: 11 },
    };

    if (responseChart) {
      // Update existing chart (smooth data update)
      responseChart.data.labels   = labels;
      responseChart.data.datasets = datasets;
      responseChart.update('none');  // no animation on refresh
    } else {
      // Create chart for the first time
      const ctx = document.getElementById('responseChart').getContext('2d');
      Chart.defaults.color     = defaults.color;
      Chart.defaults.font.family = defaults.font.family;
      Chart.defaults.font.size   = defaults.font.size;

      responseChart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },  // we build our own legend
            tooltip: {
              backgroundColor: 'rgba(8,12,24,0.92)',
              borderColor:     'rgba(99,130,255,0.35)',
              borderWidth:     1,
              titleColor:      '#e8ecff',
              bodyColor:       '#8b96c8',
              padding:         12,
              callbacks: {
                label: (ctx) => {
                  const v = ctx.parsed.y;
                  const pt = data[apiIds[ctx.datasetIndex]]?.points[ctx.dataIndex];
                  const badge = pt?.result === 'PASS' ? '✅' : pt?.result === 'FAIL' ? '❌' : '';
                  return ` ${ctx.dataset.label}: ${v != null ? v + ' ms' : 'N/A'} ${badge}`;
                },
              },
            },
          },
          scales: {
            x: {
              grid:  { color: 'rgba(99,130,255,0.08)' },
              ticks: { maxRotation: 0, maxTicksLimit: 6 },
            },
            y: {
              grid:    { color: 'rgba(99,130,255,0.08)' },
              title:   { display: true, text: 'Response Time (ms)', color: '#4a5582' },
              beginAtZero: true,
              ticks: {
                callback: (v) => v + ' ms',
              },
            },
          },
        },
      });
    }

    // Render custom legend
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

// ── Auto-refresh every 30 s ───────────────────────────────────────────────────
setInterval(() => {
  loadApis(); loadStats(); loadChart();
  if (activeTab === 'analytics') loadAnalytics();
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

    if (tab === 'analytics') loadAnalytics();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS
// ─────────────────────────────────────────────────────────────────────────────
let analyticsHours = 24;
let schedulerChart = null;

// Time-window buttons
document.getElementById('windowTabs').addEventListener('click', e => {
  const btn = e.target.closest('.win-btn');
  if (!btn) return;
  document.querySelectorAll('.win-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  analyticsHours = parseInt(btn.dataset.hours, 10);
  loadAnalytics();
});

document.getElementById('analyticsRefreshBtn').addEventListener('click', loadAnalytics);

async function loadAnalytics() {
  await Promise.all([loadGlobalAnalytics(), loadSchedulerRuns()]);
}

// ── Global summary hero ───────────────────────────────────────────────────────
async function loadGlobalAnalytics() {
  try {
    const res  = await fetch(`${API_BASE}/analytics/summary?hours=${analyticsHours}`);
    const data = await res.json();

    // Hero cards
    document.getElementById('aGlobalUptime').textContent =
      data.uptime_pct != null ? `${data.uptime_pct}%` : '—';
    document.getElementById('aGlobalP95').textContent =
      data.p95_ms != null ? `${data.p95_ms} ms` : '—';
    document.getElementById('aGlobalChecks').textContent =
      data.total_checks ?? '—';
    document.getElementById('aGlobalAvg').textContent =
      data.avg_ms != null ? `${data.avg_ms} ms` : '—';
    document.getElementById('aGlobalChecksSub').textContent =
      `${data.total_passed ?? 0} passed · ${data.total_failed ?? 0} failed`;

    // Colour uptime card
    const uptimeEl = document.getElementById('aGlobalUptime');
    const pct = data.uptime_pct ?? 100;
    uptimeEl.style.color = pct >= 99 ? '#3dffa0' : pct >= 95 ? '#ffc84a' : '#ff5c77';

    // Per-API cards
    renderPerApiCards(data.per_api || []);
  } catch (err) {
    console.warn('Analytics load error:', err.message);
  }
}

// ── Per-API grid ──────────────────────────────────────────────────────────────
function renderPerApiCards(perApi) {
  const grid   = document.getElementById('perApiGrid');
  const empty  = document.getElementById('analyticsEmpty');
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
                      : (api.uptime_pct ?? 100) >= 90  ? '#ffc84a' : '#ff5c77';
    const scoreColor  = (api.health_score ?? 100) >= 80 ? '#3dffa0'
                      : (api.health_score ?? 100) >= 60 ? '#ffc84a' : '#ff5c77';

    const topErrors = (api.top_errors || []).slice(0, 2)
      .map(e => `<div class="err-row"><span class="err-count">${e.count}×</span><span class="err-msg">${escHtml(e.msg)}</span></div>`)
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
      </div>
      <div class="aac-section-label">Top Errors</div>
      <div class="aac-errors">${topErrors}</div>
    </div>`;
  }).join('');
}

// ── Scheduler timeline chart ──────────────────────────────────────────────────
async function loadSchedulerRuns() {
  try {
    const res  = await fetch(`${API_BASE}/scheduler-runs`);
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

    const labels   = runs.map(r => new Date(r.ran_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const passData = runs.map(r => r.passed);
    const failData = runs.map(r => r.failed);

    if (schedulerChart) {
      schedulerChart.data.labels            = labels;
      schedulerChart.data.datasets[0].data  = passData;
      schedulerChart.data.datasets[1].data  = failData;
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
          { label: 'Failed', data: failData, backgroundColor: 'rgba(255,92,119,0.7)',  borderRadius: 4 },
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

// ── Init ──────────────────────────────────────────────────────────────────────
loadApis();
loadStats();
loadChart();

