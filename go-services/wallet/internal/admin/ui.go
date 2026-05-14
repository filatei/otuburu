package admin

const adminHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Otuburu Admin</title>
<style>
  :root {
    --bg: #0d0f14; --panel: #151820; --border: #242836;
    --text: #e2e8f0; --dim: #64748b; --brand: #6366f1;
    --up: #22c55e; --down: #ef4444; --warn: #f59e0b;
    --radius: 8px; --font: 'SF Mono', 'Fira Code', monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif;
         font-size: 14px; min-height: 100vh; }
  header { background: var(--panel); border-bottom: 1px solid var(--border);
           padding: 0 24px; height: 52px; display: flex; align-items: center; gap: 16px; }
  header .logo { font-weight: 700; font-size: 18px; color: var(--brand); letter-spacing: -.5px; }
  header .sub  { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: 2px; }
  header .spacer { flex: 1; }
  #auth-status { font-size: 12px; }
  #auth-status.ok  { color: var(--up); }
  #auth-status.bad { color: var(--down); }

  main { max-width: 1280px; margin: 0 auto; padding: 24px 16px; }

  /* Tabs */
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 24px; }
  .tab  { padding: 8px 16px; font-size: 13px; font-weight: 600; border: none; background: none;
          color: var(--dim); cursor: pointer; border-bottom: 2px solid transparent;
          text-transform: uppercase; letter-spacing: .5px; transition: color .15s; }
  .tab.active { color: var(--brand); border-bottom-color: var(--brand); }
  .tab:hover:not(.active) { color: var(--text); }
  .pane { display: none; } .pane.active { display: block; }

  /* Stat cards */
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card  { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
           padding: 16px 18px; }
  .card .label { font-size: 10px; color: var(--dim); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .card .value { font-size: 22px; font-weight: 700; font-family: var(--font); }
  .card .value.green { color: var(--up); }
  .card .value.red   { color: var(--down); }
  .card .value.amber { color: var(--warn); }
  .card .sub   { font-size: 11px; color: var(--dim); margin-top: 4px; font-family: var(--font); }

  /* Tables */
  .tbl-wrap { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th    { text-align: left; padding: 10px 14px; font-size: 10px; font-weight: 600;
          color: var(--dim); text-transform: uppercase; letter-spacing: .8px;
          border-bottom: 1px solid var(--border); background: var(--bg); }
  td    { padding: 10px 14px; border-bottom: 1px solid var(--border)/40; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(255,255,255,.02); }
  .mono { font-family: var(--font); font-size: 12px; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: 600; }
  .pill.pending  { background: var(--warn)/15; color: var(--warn); }
  .pill.approved { background: var(--brand)/15; color: var(--brand); }
  .pill.sent     { background: var(--up)/15; color: var(--up); }
  .pill.rejected { background: var(--down)/15; color: var(--down); }
  .pill.swept    { background: var(--up)/15; color: var(--up); }
  .pill.unswept  { background: var(--warn)/15; color: var(--warn); }
  .pill.error    { background: var(--down)/15; color: var(--down); }

  /* Buttons */
  .btn { padding: 5px 12px; border-radius: 6px; border: 1px solid; font-size: 12px;
         font-weight: 600; cursor: pointer; transition: opacity .15s; }
  .btn:disabled { opacity: .4; cursor: not-allowed; }
  .btn.approve { background: var(--up)/10; border-color: var(--up)/40; color: var(--up); }
  .btn.reject  { background: var(--down)/10; border-color: var(--down)/40; color: var(--down); }
  .btn.primary { background: var(--brand)/15; border-color: var(--brand)/40; color: var(--brand); }

  /* Login overlay */
  #login-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.8); backdrop-filter: blur(8px);
                   display: flex; align-items: center; justify-content: center; z-index: 99; }
  #login-box { background: var(--panel); border: 1px solid var(--border); border-radius: 16px;
               padding: 40px; width: 340px; display: flex; flex-direction: column; gap: 20px; }
  #login-box h2 { font-size: 20px; color: var(--brand); font-weight: 700; }
  #login-box p  { font-size: 13px; color: var(--dim); }
  #login-box input { background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
                     color: var(--text); padding: 10px 14px; font-size: 14px; width: 100%;
                     outline: none; font-family: var(--font); }
  #login-box input:focus { border-color: var(--brand); }
  #login-btn { background: var(--brand); border: none; color: #fff; padding: 11px;
               border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
  #login-err { color: var(--down); font-size: 12px; display: none; }

  .section-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .section-head h3 { font-size: 14px; font-weight: 600; }
  .section-head .refresh { font-size: 11px; color: var(--dim); cursor: pointer; padding: 4px 10px;
                           border: 1px solid var(--border); border-radius: 6px; background: none;
                           color: var(--dim); }
  .section-head .refresh:hover { color: var(--text); }
  .treasury-addr { font-family: var(--font); font-size: 11px; color: var(--dim); margin-bottom: 20px;
                   background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
                   padding: 8px 14px; display: flex; align-items: center; gap: 8px; }
  .treasury-addr span { flex: 1; }
  .copy-btn { font-size: 10px; color: var(--brand); cursor: pointer; border: none; background: none; }
  .empty { text-align: center; padding: 40px; color: var(--dim); font-size: 13px; }
  .sweep-btn { margin-left: auto; }
  #sweep-status { font-size: 12px; color: var(--up); display: none; }
</style>
</head>
<body>

<div id="login-overlay">
  <div id="login-box">
    <h2>OTUBURU Admin</h2>
    <p>Enter your admin secret to continue.</p>
    <input type="password" id="secret-input" placeholder="Admin secret" />
    <div id="login-err">Invalid secret — try again.</div>
    <button id="login-btn">Unlock</button>
  </div>
</div>

<header>
  <span class="logo">OTUBURU</span>
  <span class="sub">Admin</span>
  <span class="spacer"></span>
  <span id="auth-status"></span>
</header>

<main>
  <div class="tabs">
    <button class="tab active" data-tab="dashboard">Dashboard</button>
    <button class="tab" data-tab="users">Users</button>
    <button class="tab" data-tab="deposits">Deposits</button>
    <button class="tab" data-tab="withdrawals">Withdrawals</button>
  </div>

  <!-- ── Dashboard ─────────────────────────────────────────────── -->
  <div class="pane active" id="tab-dashboard">
    <div id="treasury-addr-bar" class="treasury-addr" style="display:none">
      <span id="treasury-addr-txt"></span>
      <button class="copy-btn" onclick="copyTreasury()">copy</button>
      <a id="tronscan-link" href="#" target="_blank" style="font-size:10px;color:var(--brand)">tronscan ↗</a>
    </div>
    <div class="cards" id="stat-cards"></div>
    <div class="section-head">
      <h3>Quick actions</h3>
      <button class="btn primary sweep-btn" id="sweep-now-btn">Sweep now</button>
      <span id="sweep-status">Triggered ✓</span>
    </div>
  </div>

  <!-- ── Users ─────────────────────────────────────────────────── -->
  <div class="pane" id="tab-users">
    <div class="section-head">
      <h3>All Users</h3>
      <button class="refresh" onclick="loadUsers()">↻ Refresh</button>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr>
          <th>Name / Email</th>
          <th>Real Balance</th>
          <th>Demo Balance</th>
          <th>Deposit Address</th>
          <th>Joined</th>
        </tr></thead>
        <tbody id="users-tbody"><tr><td colspan="5" class="empty">Loading…</td></tr></tbody>
      </table>
    </div>
  </div>

  <!-- ── Deposits ───────────────────────────────────────────────── -->
  <div class="pane" id="tab-deposits">
    <div class="section-head">
      <h3>Recent Deposits</h3>
      <button class="refresh" onclick="loadDeposits()">↻ Refresh</button>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr>
          <th>Amount (USDT)</th>
          <th>Address</th>
          <th>Credited</th>
          <th>Sweep</th>
          <th>Sweep TXID</th>
          <th>When</th>
        </tr></thead>
        <tbody id="deposits-tbody"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody>
      </table>
    </div>
  </div>

  <!-- ── Withdrawals ────────────────────────────────────────────── -->
  <div class="pane" id="tab-withdrawals">
    <div class="section-head">
      <h3>Withdrawal Queue</h3>
      <select id="wd-status-filter" onchange="loadWithdrawals()" style="background:var(--panel);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:6px;font-size:12px">
        <option value="pending">Pending</option>
        <option value="approved">Approved</option>
        <option value="sent">Sent</option>
        <option value="rejected">Rejected</option>
      </select>
      <button class="refresh" onclick="loadWithdrawals()">↻ Refresh</button>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr>
          <th>User</th>
          <th>Amount (USDT)</th>
          <th>Destination</th>
          <th>Status</th>
          <th>TXID</th>
          <th>Requested</th>
          <th>Action</th>
        </tr></thead>
        <tbody id="withdrawals-tbody"><tr><td colspan="7" class="empty">Loading…</td></tr></tbody>
      </table>
    </div>
  </div>
</main>

<script>
const API = '';  // same origin
let SECRET = sessionStorage.getItem('otuburu_admin_secret') || '';

// ── Auth ─────────────────────────────────────────────────────────────────────
document.getElementById('login-btn').onclick = async () => {
  const s = document.getElementById('secret-input').value.trim();
  const ok = await verifySecret(s);
  if (ok) {
    SECRET = s;
    sessionStorage.setItem('otuburu_admin_secret', s);
    document.getElementById('login-overlay').style.display = 'none';
    document.getElementById('auth-status').textContent = '● Authenticated';
    document.getElementById('auth-status').className = 'ok';
    loadDashboard();
  } else {
    document.getElementById('login-err').style.display = 'block';
  }
};
document.getElementById('secret-input').onkeydown = e => { if (e.key === 'Enter') document.getElementById('login-btn').click(); };

async function verifySecret(s) {
  try {
    const r = await apiFetch('/admin/dashboard', s);
    return r.ok;
  } catch { return false; }
}

// ── API ───────────────────────────────────────────────────────────────────────
async function apiFetch(path, secret, opts = {}) {
  return fetch(API + path, {
    ...opts,
    headers: { 'Authorization': 'Bearer ' + (secret || SECRET), 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
}

async function apiGet(path)         { const r = await apiFetch(path); return r.json(); }
async function apiPost(path, body)  { const r = await apiFetch(path, SECRET, { method: 'POST', body: JSON.stringify(body) }); return r.json(); }

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.pane').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('tab-' + t.dataset.tab).classList.add('active');
    if (t.dataset.tab === 'users')       loadUsers();
    if (t.dataset.tab === 'deposits')    loadDeposits();
    if (t.dataset.tab === 'withdrawals') loadWithdrawals();
  };
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function loadDashboard() {
  const d = await apiGet('/admin/dashboard');
  if (d.error) return;

  // Treasury address bar
  const bar = document.getElementById('treasury-addr-bar');
  bar.style.display = 'flex';
  document.getElementById('treasury-addr-txt').textContent = d.treasury_address;
  document.getElementById('tronscan-link').href =
    'https://tronscan.org/#/address/' + d.treasury_address;

  const pnlSign = d.house_pnl >= 0 ? '+' : '';
  const cards = [
    { label: 'Treasury USDT', value: '$' + fmt(d.treasury_usdt), cls: 'green', sub: d.treasury_trx.toFixed(1) + ' TRX for fees' },
    { label: 'User Liability', value: '$' + fmt(d.total_user_balances), cls: '', sub: d.user_count + ' users' },
    { label: 'House P&L', value: pnlSign + '$' + fmt(d.house_pnl), cls: d.house_pnl >= 0 ? 'green' : 'red', sub: 'on-chain − liability' },
    { label: 'Total Deposited', value: '$' + fmt(d.total_deposited), cls: '', sub: 'all time' },
    { label: 'Total Withdrawn', value: '$' + fmt(d.total_withdrawn), cls: '', sub: 'all time' },
    { label: 'Pending Withdrawals', value: d.pending_withdrawals, cls: d.pending_withdrawals > 0 ? 'amber' : '', sub: 'awaiting approval' },
    { label: 'Unswept Deposits', value: d.unswept_deposits, cls: d.unswept_deposits > 0 ? 'amber' : '', sub: 'pending on-chain sweep' },
  ];
  document.getElementById('stat-cards').innerHTML = cards.map(c => `
    <div class="card">
      <div class="label">${c.label}</div>
      <div class="value ${c.cls}">${c.value}</div>
      <div class="sub">${c.sub}</div>
    </div>`).join('');
  document.getElementById('sweep-now-btn').onclick = triggerSweep;
}

async function triggerSweep() {
  const btn = document.getElementById('sweep-now-btn');
  btn.disabled = true;
  await apiPost('/admin/sweep', {});
  const st = document.getElementById('sweep-status');
  st.style.display = 'inline';
  setTimeout(() => { st.style.display = 'none'; btn.disabled = false; }, 3000);
}

function copyTreasury() {
  navigator.clipboard.writeText(document.getElementById('treasury-addr-txt').textContent);
}

// ── Users ─────────────────────────────────────────────────────────────────────
async function loadUsers() {
  const d = await apiGet('/admin/users');
  const tbody = document.getElementById('users-tbody');
  if (!d.users || d.users.length === 0) { tbody.innerHTML = '<tr><td colspan="5" class="empty">No users yet</td></tr>'; return; }
  tbody.innerHTML = d.users.map(u => `
    <tr>
      <td><div style="font-weight:600">${esc(u.name||'')}</div><div class="mono" style="font-size:11px;color:var(--dim)">${esc(u.email)}</div></td>
      <td class="mono" style="color:var(--up)">$${fmt(u.real_balance)}</td>
      <td class="mono" style="color:var(--dim)">$${fmt(u.demo_balance)}</td>
      <td class="mono" style="font-size:11px;color:var(--dim)">${u.deposit_address ? shortAddr(u.deposit_address) : '—'}</td>
      <td style="color:var(--dim);font-size:12px">${timeAgo(u.created_at)}</td>
    </tr>`).join('');
}

// ── Deposits ──────────────────────────────────────────────────────────────────
async function loadDeposits() {
  const d = await apiGet('/admin/deposits');
  const tbody = document.getElementById('deposits-tbody');
  if (!d.deposits || d.deposits.length === 0) { tbody.innerHTML = '<tr><td colspan="6" class="empty">No deposits yet</td></tr>'; return; }
  tbody.innerHTML = d.deposits.map(dep => {
    let sweepPill;
    if (dep.sweep_err)      sweepPill = '<span class="pill error">error</span>';
    else if (dep.swept_at)  sweepPill = '<span class="pill swept">swept</span>';
    else                    sweepPill = '<span class="pill unswept">pending</span>';
    const sweepTxid = dep.sweep_txid
      ? '<a href="https://tronscan.org/#/transaction/' + dep.sweep_txid + '" target="_blank" style="color:var(--brand);font-size:11px" class="mono">' + dep.sweep_txid.slice(0,12) + '…</a>'
      : '—';
    return `
    <tr>
      <td class="mono" style="color:var(--up)">$${fmt(dep.amount)}</td>
      <td class="mono" style="font-size:11px;color:var(--dim)">${shortAddr(dep.address)}</td>
      <td>${dep.credited ? '✓' : '—'}</td>
      <td>${sweepPill}</td>
      <td>${sweepTxid}</td>
      <td style="color:var(--dim);font-size:12px">${timeAgo(dep.created_at)}</td>
    </tr>`;
  }).join('');
}

// ── Withdrawals ───────────────────────────────────────────────────────────────
async function loadWithdrawals() {
  const status = document.getElementById('wd-status-filter').value;
  const d = await apiGet('/admin/withdrawals?status=' + status);
  const tbody = document.getElementById('withdrawals-tbody');
  if (!d.withdrawals || d.withdrawals.length === 0) { tbody.innerHTML = '<tr><td colspan="7" class="empty">None</td></tr>'; return; }
  tbody.innerHTML = d.withdrawals.map(w => {
    const txLink = w.txid
      ? '<a href="https://tronscan.org/#/transaction/' + w.txid + '" target="_blank" style="color:var(--brand);font-size:11px">' + w.txid.slice(0,12) + '…</a>'
      : '—';
    const actions = w.status === 'pending' ? `
      <button class="btn approve" onclick="approveWd('${w.id}', this)">Approve</button>
      <button class="btn reject"  onclick="rejectWd('${w.id}', this)">Reject</button>` : '';
    return `
    <tr>
      <td><div style="font-size:12px;font-weight:600">${esc(w.name||'')}</div><div class="mono" style="font-size:11px;color:var(--dim)">${esc(w.email)}</div></td>
      <td class="mono" style="color:var(--text);font-weight:600">$${fmt(w.amount)}</td>
      <td class="mono" style="font-size:11px;color:var(--dim)">${shortAddr(w.address)}</td>
      <td><span class="pill ${w.status}">${w.status}</span></td>
      <td>${txLink}</td>
      <td style="color:var(--dim);font-size:12px">${timeAgo(w.created_at)}</td>
      <td style="display:flex;gap:6px">${actions}</td>
    </tr>`;
  }).join('');
}

async function approveWd(id, btn) {
  if (!confirm('Approve and broadcast this withdrawal from treasury?')) return;
  btn.disabled = true; btn.textContent = 'Sending…';
  const r = await apiPost('/admin/withdrawals/' + id + '/approve', {});
  if (r.error) { alert('Error: ' + r.error); btn.disabled = false; btn.textContent = 'Approve'; return; }
  loadWithdrawals();
  loadDashboard();
}

async function rejectWd(id, btn) {
  const reason = prompt('Reason for rejection (optional):') || '';
  btn.disabled = true;
  await apiPost('/admin/withdrawals/' + id + '/reject', { reason });
  loadWithdrawals();
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function fmt(n)        { return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function esc(s)        { return String(s).replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function shortAddr(a)  { return a ? a.slice(0,8) + '…' + a.slice(-6) : '—'; }
function timeAgo(iso)  {
  const d = new Date(iso), now = new Date();
  const s = Math.floor((now - d) / 1000);
  if (s < 60)   return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  if (SECRET) {
    const ok = await verifySecret(SECRET);
    if (ok) {
      document.getElementById('login-overlay').style.display = 'none';
      document.getElementById('auth-status').textContent = '● Authenticated';
      document.getElementById('auth-status').className = 'ok';
      loadDashboard();
    } else {
      sessionStorage.removeItem('otuburu_admin_secret');
      SECRET = '';
    }
  }
})();
</script>
</body>
</html>`
