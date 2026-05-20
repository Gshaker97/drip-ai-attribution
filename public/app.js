const fmtMoney = (n) => {
  if (n === null || n === undefined) return '$0';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
};
const fmtPct = (n) => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return (Number(n) * 100).toFixed(0) + '%';
};
const fmtDate = (d) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const fmtDateTime = (d) => {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

async function loadSummary() {
  const res = await fetch('/api/summary');
  const data = await res.json();

  document.getElementById('metric-mctb').textContent = data.mctb_sent.toLocaleString();
  document.getElementById('metric-saved').textContent = data.leads_saved.toLocaleString();
  document.getElementById('metric-save-rate').textContent = fmtPct(data.save_rate);
  document.getElementById('metric-converted').textContent = data.converted.toLocaleString();
  document.getElementById('metric-conv-rate').textContent = fmtPct(data.conversion_rate);
  document.getElementById('metric-revenue').textContent = fmtMoney(data.total_first_job_revenue);

  document.getElementById('new-count').textContent = data.new_acquisition.count.toLocaleString();
  document.getElementById('new-revenue').textContent = fmtMoney(data.new_acquisition.first_job_revenue);
  document.getElementById('new-recurring').textContent = data.new_acquisition.recurring_count.toLocaleString();

  document.getElementById('react-count').textContent = data.reactivation.count.toLocaleString();
  document.getElementById('react-revenue').textContent = fmtMoney(data.reactivation.first_job_revenue);
  document.getElementById('react-recurring').textContent = data.reactivation.recurring_count.toLocaleString();

  // Populate client view stats
  document.getElementById('cv-reached').textContent = data.mctb_sent.toLocaleString();
  document.getElementById('cv-contacted').textContent = data.leads_saved.toLocaleString();
  document.getElementById('cv-revenue').textContent = fmtMoney(data.total_first_job_revenue);

  const lastSyncEl = document.getElementById('last-sync');
  if (data.last_sync) {
    const when = fmtDateTime(data.last_sync.started_at);
    const status = data.last_sync.status;
    lastSyncEl.textContent = `Last sync: ${when} (${status})`;
  } else {
    lastSyncEl.textContent = 'No syncs yet';
  }
}

async function loadAttributions() {
  const res = await fetch('/api/attributions');
  const rows = await res.json();
  const head = document.getElementById('table-head');
  head.innerHTML = `
    <th>Contact</th>
    <th>Phone</th>
    <th>MCTB sent</th>
    <th>Type</th>
    <th>First job</th>
    <th>Amount</th>
    <th>Recurring</th>
    <th>Match</th>
  `;
  const body = document.getElementById('table-body');
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="8" class="empty">No attributions yet. Run a sync to populate.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(r => {
    const name = r.contact_name || `${r.hcp_first_name || ''} ${r.hcp_last_name || ''}`.trim() || '(unknown)';
    const typeBadge = r.attribution_type === 'new_acquisition'
      ? '<span class="badge badge-new">New</span>'
      : '<span class="badge badge-react">Reactivation</span>';
    const recurring = r.is_recurring ? '<span class="badge badge-recurring">Recurring</span>' : '—';
    return `
      <tr>
        <td>${escapeHtml(name)}</td>
        <td>${escapeHtml(r.contact_phone || '—')}</td>
        <td>${fmtDate(r.mctb_sent_at)}</td>
        <td>${typeBadge}</td>
        <td>${fmtDate(r.first_job_date)}</td>
        <td>${fmtMoney(r.first_job_amount)}</td>
        <td>${recurring}</td>
        <td><span class="muted">${escapeHtml(r.match_method || '—')}</span></td>
      </tr>
    `;
  }).join('');
}

async function loadAllEvents() {
  const res = await fetch('/api/mctb-events');
  const rows = await res.json();
  const head = document.getElementById('table-head');
  head.innerHTML = `
    <th>Contact</th>
    <th>Phone</th>
    <th>MCTB sent</th>
    <th>Replied?</th>
    <th>Messages</th>
    <th>Converted?</th>
    <th>Type</th>
    <th>Revenue</th>
  `;
  const body = document.getElementById('table-body');
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="8" class="empty">No MCTB events yet. Run a sync to populate.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(r => {
    const repliedBadge = r.lead_replied
      ? '<span class="badge badge-replied">Replied</span>'
      : '<span class="badge badge-noreply">No reply</span>';
    const converted = r.attribution_type ? 'Yes' : 'No';
    const typeBadge = !r.attribution_type ? '—' :
      r.attribution_type === 'new_acquisition'
        ? '<span class="badge badge-new">New</span>'
        : '<span class="badge badge-react">Reactivation</span>';
    return `
      <tr>
        <td>${escapeHtml(r.contact_name || '(unknown)')}</td>
        <td>${escapeHtml(r.contact_phone || '—')}</td>
        <td>${fmtDate(r.mctb_sent_at)}</td>
        <td>${repliedBadge}</td>
        <td>${r.message_count || 0}</td>
        <td>${converted}</td>
        <td>${typeBadge}</td>
        <td>${r.first_job_amount ? fmtMoney(r.first_job_amount) : '—'}</td>
      </tr>
    `;
  }).join('');
}

async function loadSyncRuns() {
  const res = await fetch('/api/sync-runs');
  const rows = await res.json();
  const body = document.getElementById('sync-body');
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="empty">No syncs yet.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(r => {
    const duration = r.finished_at
      ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000) + 's'
      : '—';
    const statusBadge = `<span class="badge badge-${r.status}">${r.status}</span>`;
    return `
      <tr>
        <td>${fmtDateTime(r.started_at)}</td>
        <td>${escapeHtml(r.triggered_by)}</td>
        <td>${statusBadge}</td>
        <td>${r.mctb_events_found || 0}</td>
        <td>${r.attributions_created || 0}</td>
        <td>${duration}</td>
      </tr>
    `;
  }).join('');
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

let currentTab = 'attributed';
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTab = btn.dataset.tab;
    if (currentTab === 'attributed') loadAttributions();
    else loadAllEvents();
  });
});

document.getElementById('sync-btn').addEventListener('click', async () => {
  const btn = document.getElementById('sync-btn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    // Poll for completion by watching sync-runs
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      const r = await fetch('/api/sync-runs');
      const rows = await r.json();
      const latest = rows[0];
      if (latest && latest.status !== 'running') {
        clearInterval(poll);
        btn.disabled = false;
        btn.textContent = 'Sync Now';
        refreshAll();
      } else if (attempts > 120) {
        clearInterval(poll);
        btn.disabled = false;
        btn.textContent = 'Sync Now';
        alert('Sync is taking longer than 10 minutes — check the sync history table.');
      }
    }, 5000);
  } catch (e) {
    alert('Sync failed to start: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Sync Now';
  }
});

// Client view toggle
document.getElementById('client-view-btn').addEventListener('click', () => {
  document.getElementById('main-dashboard').style.display = 'none';
  document.getElementById('client-view').style.display = 'block';
});

document.getElementById('exit-client-view').addEventListener('click', () => {
  document.getElementById('client-view').style.display = 'none';
  document.getElementById('main-dashboard').style.display = 'block';
});

function refreshAll() {
  loadSummary();
  if (currentTab === 'attributed') loadAttributions();
  else loadAllEvents();
  loadSyncRuns();
}

refreshAll();
setInterval(refreshAll, 60000); // auto refresh every minute
