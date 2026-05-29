package admin

const adminHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Otuburu Admin</title>
<style>
  :root {
    --bg:#0d0f14;--panel:#151820;--border:#242836;
    --text:#e2e8f0;--dim:#64748b;--brand:#6366f1;
    --up:#22c55e;--down:#ef4444;--warn:#f59e0b;
    --r:8px;--mono:'SF Mono','Fira Code',monospace;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:system-ui,sans-serif;font-size:14px;min-height:100vh}
  header{background:var(--panel);border-bottom:1px solid var(--border);padding:0 24px;height:52px;display:flex;align-items:center;gap:16px}
  .logo{font-weight:700;font-size:18px;color:var(--brand);letter-spacing:-.5px}
  .sub{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:2px}
  .spacer{flex:1}
  #auth-status{font-size:12px}
  #auth-status.ok{color:var(--up)}
  main{max-width:1280px;margin:0 auto;padding:24px 16px}
  .tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:24px}
  .tab{padding:8px 16px;font-size:13px;font-weight:600;border:none;background:none;color:var(--dim);cursor:pointer;border-bottom:2px solid transparent;text-transform:uppercase;letter-spacing:.5px;transition:color .15s}
  .tab.active{color:var(--brand);border-bottom-color:var(--brand)}
  .tab:hover:not(.active){color:var(--text)}
  .pane{display:none}.pane.active{display:block}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:24px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:var(--r);padding:16px 18px}
  .card .lbl{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px}
  .card .val{font-size:22px;font-weight:700;font-family:var(--mono)}
  .card .val.g{color:var(--up)}.card .val.r{color:var(--down)}.card .val.a{color:var(--warn)}
  .card .csub{font-size:11px;color:var(--dim);margin-top:4px;font-family:var(--mono)}
  .tw{background:var(--panel);border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:10px 14px;font-size:10px;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.8px;border-bottom:1px solid var(--border);background:var(--bg)}
  td{padding:10px 14px;border-bottom:1px solid rgba(36,40,54,.4)}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:rgba(255,255,255,.02)}
  .mono{font-family:var(--mono);font-size:12px}
  .pill{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600}
  .p-pending{background:rgba(245,158,11,.15);color:var(--warn)}
  .p-approved{background:rgba(99,102,241,.15);color:var(--brand)}
  .p-sent,.p-swept{background:rgba(34,197,94,.15);color:var(--up)}
  .p-rejected,.p-error{background:rgba(239,68,68,.15);color:var(--down)}
  .p-unswept{background:rgba(245,158,11,.15);color:var(--warn)}
  .btn{padding:5px 12px;border-radius:6px;border:1px solid;font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s}
  .btn:disabled{opacity:.4;cursor:not-allowed}
  .btn-approve{background:rgba(34,197,94,.1);border-color:rgba(34,197,94,.4);color:var(--up)}
  .btn-reject{background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.4);color:var(--down)}
  .btn-primary{background:rgba(99,102,241,.15);border-color:rgba(99,102,241,.4);color:var(--brand)}
  /* Pending withdrawal rows get a left-border highlight + faint glow so the
     queue items needing attention are visually separated from the historical
     ones the admin is just reviewing. */
  .row-pending{box-shadow:inset 3px 0 0 var(--warn)}
  .row-pending td{background:rgba(245,158,11,.04)}
  .copy-btn{background:transparent;border:1px solid var(--border);border-radius:4px;padding:0 6px;font-size:11px;color:var(--dim);cursor:pointer;line-height:18px;height:20px;vertical-align:baseline}
  .copy-btn:hover{border-color:var(--brand);color:var(--brand)}
  #login-overlay{position:fixed;inset:0;background:rgba(0,0,0,.8);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;z-index:99}
  #login-box{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:40px;width:340px;display:flex;flex-direction:column;gap:20px}
  #login-box h2{font-size:20px;color:var(--brand);font-weight:700}
  #login-box p{font-size:13px;color:var(--dim)}
  #login-box input{background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:10px 14px;font-size:14px;width:100%;outline:none;font-family:var(--mono)}
  #login-box input:focus{border-color:var(--brand)}
  #login-btn{background:var(--brand);border:none;color:#fff;padding:11px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer}
  #login-err{color:var(--down);font-size:12px;display:none}
  .sh{display:flex;align-items:center;gap:12px;margin-bottom:16px}
  .sh h3{font-size:14px;font-weight:600}
  .refresh-btn{font-size:11px;color:var(--dim);cursor:pointer;padding:4px 10px;border:1px solid var(--border);border-radius:6px;background:none}
  .refresh-btn:hover{color:var(--text)}
  .taddr{font-family:var(--mono);font-size:11px;color:var(--dim);margin-bottom:20px;background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:8px 14px;display:flex;align-items:center;gap:8px;display:none}
  .taddr span{flex:1}
  .cpbtn{font-size:10px;color:var(--brand);cursor:pointer;border:none;background:none}
  .empty{text-align:center;padding:40px;color:var(--dim);font-size:13px}
  #sweep-status{font-size:12px;color:var(--up);display:none;margin-left:8px}
  select.flt{background:var(--panel);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:6px;font-size:12px}
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

  <div class="pane active" id="tab-dashboard">
    <div id="taddr-bar" class="taddr">
      <span id="taddr-txt"></span>
      <button class="cpbtn" onclick="copyTreasury()">copy</button>
      <a id="tronscan-link" href="#" target="_blank" style="font-size:10px;color:var(--brand)">tronscan ↗</a>
    </div>
    <div class="cards" id="stat-cards"></div>
    <div class="sh" style="margin-top:8px">
      <h3>Quick actions</h3>
      <button class="btn btn-primary" id="sweep-btn" style="margin-left:auto">Sweep now</button>
      <span id="sweep-status">Triggered ✓</span>
    </div>
  </div>

  <div class="pane" id="tab-users">
    <div class="sh"><h3>All Users</h3><button class="refresh-btn" onclick="loadUsers()">↻ Refresh</button></div>
    <div class="tw"><table>
      <thead><tr><th>Name / Email</th><th>Real Balance</th><th>Demo Balance</th><th>Deposit Address</th><th>Joined</th></tr></thead>
      <tbody id="users-tb"><tr><td colspan="5" class="empty">Loading…</td></tr></tbody>
    </table></div>
  </div>

  <div class="pane" id="tab-deposits">
    <div class="sh"><h3>Recent Deposits</h3><button class="refresh-btn" onclick="loadDeposits()">↻ Refresh</button></div>
    <div class="tw"><table>
      <thead><tr><th>Amount (USDT)</th><th>Address</th><th>Credited</th><th>Sweep</th><th>Sweep TXID</th><th>When</th></tr></thead>
      <tbody id="deposits-tb"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody>
    </table></div>
  </div>

  <div class="pane" id="tab-withdrawals">
    <div class="sh">
      <h3>Withdrawals</h3>
      <select id="wd-filter" class="flt" onchange="loadWithdrawals()">
        <option value="pending">Pending</option>
        <option value="approved">Approved</option>
        <option value="sent">Sent</option>
        <option value="rejected">Rejected</option>
      </select>
      <button class="refresh-btn" onclick="loadWithdrawals()">↻ Refresh</button>
    </div>
    <div class="tw"><table>
      <thead><tr><th>User</th><th>Amount</th><th>Destination</th><th>Status</th><th>TXID</th><th>Requested</th><th>Action</th></tr></thead>
      <tbody id="withdrawals-tb"><tr><td colspan="7" class="empty">Loading…</td></tr></tbody>
    </table></div>
  </div>
</main>

<script>
var SECRET = sessionStorage.getItem('otuburu_admin_secret') || '';

// ── Auth ──────────────────────────────────────────────────────────────────────
document.getElementById('login-btn').onclick = async function() {
  var s = document.getElementById('secret-input').value.trim();
  var ok = await verifySecret(s);
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
document.getElementById('secret-input').onkeydown = function(e) {
  if (e.key === 'Enter') document.getElementById('login-btn').click();
};

async function verifySecret(s) {
  try { var r = await apiFetch('/admin/dashboard', s); return r.ok; } catch(e) { return false; }
}

// ── API ───────────────────────────────────────────────────────────────────────
function apiFetch(path, sec, opts) {
  opts = opts || {};
  return fetch(path, Object.assign({}, opts, {
    headers: Object.assign({ 'Authorization': 'Bearer ' + (sec || SECRET), 'Content-Type': 'application/json' }, opts.headers || {})
  }));
}
async function apiGet(path)        { return (await apiFetch(path)).json(); }
async function apiPost(path, body) { return (await apiFetch(path, SECRET, { method: 'POST', body: JSON.stringify(body) })).json(); }

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(function(t) {
  t.onclick = function() {
    document.querySelectorAll('.tab').forEach(function(x){ x.classList.remove('active'); });
    document.querySelectorAll('.pane').forEach(function(x){ x.classList.remove('active'); });
    t.classList.add('active');
    document.getElementById('tab-' + t.dataset.tab).classList.add('active');
    if (t.dataset.tab === 'users')       loadUsers();
    if (t.dataset.tab === 'deposits')    loadDeposits();
    if (t.dataset.tab === 'withdrawals') loadWithdrawals();
  };
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function loadDashboard() {
  var d = await apiGet('/admin/dashboard');
  if (d.error) return;

  var bar = document.getElementById('taddr-bar');
  bar.style.display = 'flex';
  document.getElementById('taddr-txt').textContent = d.treasury_address;
  document.getElementById('tronscan-link').href = 'https://tronscan.org/#/address/' + d.treasury_address;

  var pnlSign = d.house_pnl >= 0 ? '+' : '';
  var cards = [
    { l:'Treasury USDT',       v:'$'+fmt(d.treasury_usdt),         c:d.treasury_usdt>0?'g':'',  s:d.treasury_trx.toFixed(1)+' TRX for fees' },
    { l:'User Liability',      v:'$'+fmt(d.total_user_balances),   c:'',                         s:d.user_count+' users' },
    { l:'House P&amp;L',       v:pnlSign+'$'+fmt(d.house_pnl),     c:d.house_pnl>=0?'g':'r',    s:'on-chain minus liability' },
    { l:'Total Deposited',     v:'$'+fmt(d.total_deposited),       c:'',                         s:'all time' },
    { l:'Total Withdrawn',     v:'$'+fmt(d.total_withdrawn),       c:'',                         s:'all time' },
    { l:'Pending Withdrawals', v:String(d.pending_withdrawals),    c:d.pending_withdrawals>0?'a':'', s:'awaiting approval' },
    { l:'Unswept Deposits',    v:String(d.unswept_deposits),       c:d.unswept_deposits>0?'a':'',    s:'pending sweep' },
  ];
  document.getElementById('stat-cards').innerHTML = cards.map(function(c) {
    return '<div class="card"><div class="lbl">'+c.l+'</div><div class="val '+c.c+'">'+c.v+'</div><div class="csub">'+c.s+'</div></div>';
  }).join('');

  document.getElementById('sweep-btn').onclick = triggerSweep;
}

async function triggerSweep() {
  var btn = document.getElementById('sweep-btn');
  btn.disabled = true;
  await apiPost('/admin/sweep', {});
  var st = document.getElementById('sweep-status');
  st.style.display = 'inline';
  setTimeout(function(){ st.style.display='none'; btn.disabled=false; }, 3000);
}
function copyTreasury() {
  navigator.clipboard.writeText(document.getElementById('taddr-txt').textContent);
}

// ── Users ─────────────────────────────────────────────────────────────────────
async function loadUsers() {
  var d = await apiGet('/admin/users');
  var tb = document.getElementById('users-tb');
  if (!d.users || !d.users.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">No users yet</td></tr>'; return; }
  tb.innerHTML = d.users.map(function(u) {
    return '<tr>' +
      '<td><div style="font-weight:600">'+esc(u.name||'')+'</div><div class="mono" style="font-size:11px;color:var(--dim)">'+esc(u.email)+'</div></td>' +
      '<td class="mono" style="color:var(--up)">$'+fmt(u.real_balance)+'</td>' +
      '<td class="mono" style="color:var(--dim)">$'+fmt(u.demo_balance)+'</td>' +
      '<td class="mono" style="font-size:11px;color:var(--dim)">'+(u.deposit_address?shortAddr(u.deposit_address):'—')+'</td>' +
      '<td style="color:var(--dim);font-size:12px">'+timeAgo(u.created_at)+'</td>' +
      '</tr>';
  }).join('');
}

// ── Deposits ──────────────────────────────────────────────────────────────────
async function loadDeposits() {
  var d = await apiGet('/admin/deposits');
  var tb = document.getElementById('deposits-tb');
  if (!d.deposits || !d.deposits.length) { tb.innerHTML = '<tr><td colspan="6" class="empty">No deposits yet</td></tr>'; return; }
  tb.innerHTML = d.deposits.map(function(dep) {
    var pill;
    if (dep.sweep_err)     pill = '<span class="pill p-error">error</span>';
    else if (dep.swept_at) pill = '<span class="pill p-swept">swept</span>';
    else                   pill = '<span class="pill p-unswept">pending</span>';
    var stx = dep.sweep_txid
      ? '<a href="https://tronscan.org/#/transaction/'+dep.sweep_txid+'" target="_blank" style="color:var(--brand);font-size:11px" class="mono">'+dep.sweep_txid.slice(0,12)+'…</a>'
      : '—';
    return '<tr>' +
      '<td class="mono" style="color:var(--up)">$'+fmt(dep.amount)+'</td>' +
      '<td class="mono" style="font-size:11px;color:var(--dim)">'+shortAddr(dep.address)+'</td>' +
      '<td>'+(dep.credited?'✓':'—')+'</td>' +
      '<td>'+pill+'</td>' +
      '<td>'+stx+'</td>' +
      '<td style="color:var(--dim);font-size:12px">'+timeAgo(dep.created_at)+'</td>' +
      '</tr>';
  }).join('');
}

// ── Withdrawals ───────────────────────────────────────────────────────────────
// Keep a copy of the last-rendered batch so action handlers can reach the
// full address + user details without redoing the API call.
var _wdCache = {};

async function loadWithdrawals() {
  var status = document.getElementById('wd-filter').value;
  var d = await apiGet('/admin/withdrawals?status='+status);
  var tb = document.getElementById('withdrawals-tb');
  _wdCache = {};
  if (!d.withdrawals || !d.withdrawals.length) { tb.innerHTML = '<tr><td colspan="7" class="empty">None</td></tr>'; return; }
  tb.innerHTML = d.withdrawals.map(function(w) {
    _wdCache[w.id] = w;
    var txLink = w.txid
      ? '<a href="https://tronscan.org/#/transaction/'+w.txid+'" target="_blank" style="color:var(--brand);font-size:11px">'+w.txid.slice(0,12)+'…</a>'
      : '—';
    var actions = w.status === 'pending'
      ? '<button class="btn btn-approve" onclick="approveWd(\''+w.id+'\',this)">Approve</button> ' +
        '<button class="btn btn-reject"  onclick="rejectWd(\''+w.id+'\',this)">Reject</button>'
      : '';
    // Destination cell — clickable address that opens TRONSCAN, plus a
    // small Copy button so the admin can paste the full address into
    // whatever tool they want to verify it independently before approving.
    var addrCell =
      '<a href="https://tronscan.org/#/address/'+esc(w.address)+'" target="_blank" class="mono" style="font-size:11px;color:var(--dim);text-decoration:none" title="'+esc(w.address)+'">'+shortAddr(w.address)+'</a>' +
      ' <button class="copy-btn" onclick="copyText(\''+esc(w.address)+'\',this)" title="Copy address">📋</button>';
    // Time row: stack "Xh ago" over the absolute timestamp so admins can
    // scan urgency at a glance but still see when something old slipped
    // through.
    var when =
      '<div style="font-size:12px;color:var(--dim)">'+timeAgo(w.created_at)+'</div>' +
      '<div class="mono" style="font-size:10px;color:var(--dim);opacity:.7">'+absTime(w.created_at)+'</div>';
    return '<tr'+(w.status==='pending' ? ' class="row-pending"' : '')+'>' +
      '<td><div style="font-size:12px;font-weight:600">'+esc(w.name||'(no name)')+'</div><div class="mono" style="font-size:11px;color:var(--dim)">'+esc(w.email)+'</div></td>' +
      '<td class="mono" style="font-weight:700;font-size:14px;color:var(--text)">$'+fmt(w.amount)+'</td>' +
      '<td>'+addrCell+'</td>' +
      '<td><span class="pill p-'+w.status+'">'+w.status+'</span></td>' +
      '<td>'+txLink+'</td>' +
      '<td>'+when+'</td>' +
      '<td>'+actions+'</td>' +
      '</tr>';
  }).join('');
}

async function approveWd(id, btn) {
  var w = _wdCache[id];
  if (!w) return;
  // Spell out exactly what's about to happen — fat-finger-proof. The admin
  // sees user identity, amount, full destination address before they
  // authorise an on-chain broadcast that can't be reversed.
  var msg = 'APPROVE WITHDRAWAL\n\n' +
    'User:    ' + (w.name||'(no name)') + ' <' + w.email + '>\n' +
    'Amount:  $' + fmt(w.amount) + ' USDT\n' +
    'To:      ' + w.address + '\n\n' +
    'This broadcasts on-chain immediately. Continue?';
  if (!confirm(msg)) return;
  btn.disabled = true; btn.textContent = 'Sending…';
  var r = await apiPost('/admin/withdrawals/'+id+'/approve', {});
  if (r.error) { alert('Error: '+r.error); btn.disabled=false; btn.textContent='Approve'; return; }
  loadWithdrawals(); loadDashboard();
}

async function rejectWd(id, btn) {
  var w = _wdCache[id];
  if (!w) return;
  var reason = prompt('Reject $' + fmt(w.amount) + ' withdrawal for ' + w.email + '\n\nReason (will be emailed to user):') || '';
  if (reason === '') {
    if (!confirm('Reject with no reason given?')) return;
  }
  btn.disabled = true;
  await apiPost('/admin/withdrawals/'+id+'/reject', { reason: reason });
  loadWithdrawals();
}

// Copy a string to clipboard and flash the button to confirm. Used for the
// TRC20 destination addresses in the withdrawals table — copying the
// truncated text on the page wouldn't work, so we provide the full address
// from JS.
function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(function() {
    var orig = btn.textContent;
    btn.textContent = '✓';
    setTimeout(function(){ btn.textContent = orig; }, 1000);
  });
}

// absTime — short absolute timestamp for the second line under "Xh ago".
function absTime(iso) {
  try {
    var d = new Date(iso);
    var pad = function(n){ return String(n).padStart(2,'0'); };
    return d.getFullYear()+'.'+pad(d.getMonth()+1)+'.'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes());
  } catch(e) { return ''; }
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function fmt(n)       { return Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function esc(s)       { return String(s).replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function shortAddr(a) { return a?a.slice(0,8)+'…'+a.slice(-6):'—'; }
function timeAgo(iso) {
  var s = Math.floor((Date.now()-new Date(iso).getTime())/1000);
  if (s<60)    return s+'s ago';
  if (s<3600)  return Math.floor(s/60)+'m ago';
  if (s<86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async function() {
  if (SECRET) {
    var ok = await verifySecret(SECRET);
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
