/* =========================================================
   FileTrack frontend
   ========================================================= */
'use strict';

const state = {
  user: null,
  departments: [],
  positions: [],
  qrMode: localStorage.getItem('ft_qrmode') || 'url'
};

/* ---------------- API ---------------- */
async function api(path, opts = {}) {
  const o = { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, ...opts };
  if (o.body && typeof o.body !== 'string') o.body = JSON.stringify(o.body);
  const res = await fetch(path, o);
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) data = await res.json().catch(() => null);
  if (res.status === 401 && !path.startsWith('/api/login')) {
    state.user = null; showLogin('Your session has expired — please sign in again.');
    throw new Error('Session expired — please sign in');
  }
  if (!res.ok) {
    const e = new Error((data && data.error) || res.statusText);
    e.status = res.status;
    e.data = data;          // <-- so callers can read `attempts`/`remaining`/`retryAfter`
    throw e;
  }
  return data;
}

/* ---------------- helpers ---------------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const initials = n => (n || '?').trim().split(/\s+/).map(w => w[0]).slice(0,2).join('').toUpperCase();
const prioClass = p => p === 'Immediate' ? 'immediate' : p === 'Urgent' ? 'urgent' : 'normal';
const isSuper = () => state.user && state.user.is_super_admin;

function fmt(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}
function relTime(ts) {
  if (!ts) return '—';
  const d = (Date.now() - new Date(ts)) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d/60) + 'm ago';
  if (d < 86400) return Math.floor(d/3600) + 'h ago';
  if (d < 604800) return Math.floor(d/86400) + 'd ago';
  return fmt(ts);
}
function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B','KB','MB','GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function attachIcon(mime) {
  if (!mime) return '📎';
  if (mime.startsWith('image/')) return '🖼';
  if (mime === 'application/pdf') return '📕';
  if (mime.includes('word')) return '📘';
  if (mime.includes('sheet') || mime.includes('excel')) return '📗';
  if (mime === 'text/csv' || mime === 'text/plain') return '📄';
  return '📎';
}

/* ---------------- toasts ---------------- */
function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2800);
}

/* ---------------- modal ---------------- */
let modalOkHandler = null;
function showModal(opts) {
  document.getElementById('mTitle').textContent = opts.title || '';
  document.getElementById('mBody').innerHTML = opts.body || '';
  const ok = document.getElementById('mOk');
  ok.textContent = opts.okLabel || 'Confirm';
  ok.className = 'btn ' + (opts.okClass || 'primary');
  ok.style.display = opts.hideOk ? 'none' : '';
  document.getElementById('mCancel').textContent = opts.cancelLabel || 'Cancel';
  modalOkHandler = opts.onOk || null;
  document.getElementById('modal').classList.add('open');
  setTimeout(() => {
    const i = document.querySelector('#mBody input:not([type=radio]):not([type=checkbox]), #mBody textarea, #mBody select');
    if (i) i.focus();
  }, 60);
}
function hideModal() {
  document.getElementById('modal').classList.remove('open');
  modalOkHandler = null;
}
document.getElementById('mOk').addEventListener('click', () => {
  if (!modalOkHandler) return hideModal();
  if (modalOkHandler() !== false) hideModal();
});
document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal') hideModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideModal(); });

/* ---------------- auth ---------------- */
function showLogin() {
  document.getElementById('loginOverlay').style.display = 'flex';
  document.querySelector('.app').style.display = 'none';
  document.getElementById('bottomnav').style.display = 'none';
}
function showApp() {
  document.getElementById('loginOverlay').style.display = 'none';
  document.querySelector('.app').style.display = 'flex';
  document.getElementById('bottomnav').style.display = '';
  paintUser();
  document.getElementById('navAdmin').style.display = isSuper() ? '' : 'none';
}
function paintUser() {
  if (!state.user) return;
  const u = state.user;
  const sub = u.department_code ? `${u.position_name} · ${u.department_code}` : u.position_name;
  const html =
    `<span class="avatar">${esc(initials(u.full_name))}</span>
     <span class="uinfo"><b>${esc(u.full_name)}</b><small>${esc(sub)}</small></span>`;
  document.getElementById('userChip').innerHTML = html;
  document.getElementById('userChipSide').innerHTML = html;
}

function clearLoginForm() {
  const u = document.getElementById('loginUser');
  const p = document.getElementById('loginPass');
  if (u) u.value = '';
  if (p) p.value = '';
  try {
    const f = document.getElementById('loginForm');
    if (f && f.reset) f.reset();
  } catch (e) {}
}

document.getElementById('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  const btn  = form.querySelector('button[type="submit"]') || document.getElementById('loginBtn');
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;

  if (btn) {
    btn.disabled = true;
    btn.dataset.label = btn.textContent;
    btn.textContent = 'Signing in…';
  }

  try {
    const r = await api('/api/login', { method: 'POST', body: { username, password } });
    state.user = r.user;
    await loadMeta();
    showApp();
    if (!location.hash) location.hash = '#/dashboard';
    router();
    toast('Welcome, ' + r.user.full_name, 'ok');
    if (r.user.must_change_password) setTimeout(() => openChangePassword(true), 500);
  } catch (err) {
    if (err.status === 429) {
      toast(err.message || 'Too many attempts. Please wait.', 'error');
    } else if (err.status === 401) {
      // Show how many tries are left — feels much less "frozen"
      toast(err.message || 'Invalid username or password', 'error');
    } else {
      toast(err.message, 'error');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.label || 'Sign In';
    }
  }
});

async function loadMeta() {
  try {
    const m = await api('/api/meta');
    state.departments = m.departments || [];
    state.positions   = m.positions   || [];
  } catch (e) {}
}

/* ---------------- Account menu ---------------- */
function showUserMenu() {
  showModal({
    title: 'Account',
    body: `
      <dl class="kv">
        <dt>Name</dt><dd>${esc(state.user.full_name)}</dd>
        <dt>Username</dt><dd>${esc(state.user.username)}</dd>
        <dt>Level</dt><dd>${esc(state.user.position_name)}</dd>
        ${state.user.department_code ? `<dt>Department</dt><dd>${esc(state.user.department_name)} (${esc(state.user.department_code)})</dd>` : ''}
        ${isSuper() ? '<dt>Role</dt><dd><span class="pill ok">Super Admin</span></dd>' : ''}
      </dl>`,
    okLabel: 'Sign Out',
    okClass: 'danger',
    cancelLabel: 'Close',
    onOk: async () => {
      try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
      state.user = null;
      clearLoginForm();
      if (location.hash && location.hash !== '#/dashboard') {
        try { history.replaceState(null, '', '#/dashboard'); } catch (e) { location.hash = '#/dashboard'; }
      }
      showLogin();
      toast('Signed out', 'ok');
      return true;
    }
  });
}

function openChangePassword(force) {
  showModal({
    title: force ? 'Change Password (Required)' : 'Change Password',
    body: `
      <p class="muted" style="margin-top:10px">${force ? 'Your password must be changed before you continue.' : ''}</p>
      <label class="lbl">Current Password</label>
      <input id="cpOld" type="password" autocomplete="current-password">
      <label class="lbl">New Password</label>
      <input id="cpNew" type="password" autocomplete="new-password">
      <label class="lbl">Confirm New Password</label>
      <input id="cpNew2" type="password" autocomplete="new-password">
      <p class="hint">Min 8 characters, must contain letters and numbers.</p>`,
    okLabel: 'Update Password',
    onOk: async () => {
      const oldP = document.getElementById('cpOld').value;
      const newP = document.getElementById('cpNew').value;
      const cnf  = document.getElementById('cpNew2').value;
      if (newP !== cnf) { toast('Passwords do not match', 'error'); return false; }
      try {
        await api('/api/me/password', { method: 'POST', body: { currentPassword: oldP, newPassword: newP } });
        state.user.must_change_password = false;
        toast('Password updated', 'ok');
        return true;
      } catch (e) { toast(e.message, 'error'); return false; }
    },
    cancelLabel: force ? '' : 'Cancel'
  });
}

/* ---------------- bootstrap ---------------- */
(async function bootstrap() {
  try {
    const me = await api('/api/me');
    state.user = me.user;
    await loadMeta();
    showApp();
    if (!location.hash) location.hash = '#/dashboard';
    router();
    if (state.user.must_change_password) setTimeout(() => openChangePassword(true), 400);
  } catch (e) { showLogin(); }
})();

/* =========================================================
   VIEWS
   ========================================================= */
const view = document.getElementById('view');

/* ---------------- Dashboard ---------------- */
async function renderDashboard() {
  view.innerHTML = `<div class="card empty">Loading dashboard…</div>`;
  let d;
  try { d = await api('/api/dashboard'); }
  catch (e) { view.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }

  const s = d.stats;
  const maxC = Math.max(1, ...d.byLevel.map(x => x.c));

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1><p class="sub">Files you can see · held by you or sent to you</p></div>
      <div class="head-actions"><a class="btn primary" href="#/new">➕ New File</a></div>
    </div>

    <div class="stats">
      <div class="stat b"><div class="n">${s.total}</div><div class="l">My Files</div></div>
      <div class="stat g"><div class="n">${s.open}</div><div class="l">Open</div></div>
      <div class="stat"><div class="n">${s.closed}</div><div class="l">Closed</div></div>
      <div class="stat o"><div class="n">${s.urgent}</div><div class="l">High Priority</div></div>
      <div class="stat r"><div class="n">${s.mine}</div><div class="l">Pending With Me</div></div>
    </div>

    <div class="cols">
      <div class="card pad">
        <h2>Open Files by Position</h2>
        ${d.byLevel.length ? `<div class="levels">
          ${d.byLevel.map(x => `
            <div class="level-row">
              <div class="lv-name">${esc(x.position_name)}<div class="lv-dept">${esc(x.department_code || '—')}</div></div>
              <div class="lv-bar"><i style="width:${Math.round((x.c/maxC)*100)}%"></i></div>
              <div class="lv-count">${x.c}</div>
            </div>`).join('')}
        </div>` : `<p class="muted">No open files.</p>`}
      </div>

      <div class="card pad">
        <h2>Recent Activity</h2>
        ${d.recent.length ? `<div class="tl">${d.recent.map(h => `
          <div class="tl-item">
            <div class="tl-top">
              <b>${esc(h.action)}</b>
              <a class="tl-route" href="#/file/${encodeURIComponent(h.ref_no)}">${esc(h.ref_no)}</a>
            </div>
            <div class="tl-meta">${esc(h.actor || 'System')} · ${relTime(h.created_at)}</div>
          </div>`).join('')}</div>`
        : `<p class="muted">No activity yet. <a href="#/new">Register the first file</a>.</p>`}
      </div>
    </div>

    ${d.myFiles.length ? `
      <div class="card pad" style="margin-top:16px">
        <h2>Pending With You — ${esc(state.user.position_name)}</h2>
        <div class="file-list">${d.myFiles.map(fileRow).join('')}</div>
      </div>` : ''}
  `;
}

function fileRow(f) {
  return `<a class="file-row" href="#/file/${encodeURIComponent(f.ref_no)}">
    <div class="fr-main">
      <div class="fr-ref">${esc(f.ref_no)}
        <span class="pill ${prioClass(f.priority)}">${esc(f.priority)}</span>
      </div>
      <div class="fr-sub">${esc(f.subject)}</div>
      <div class="fr-meta">Updated ${relTime(f.updated_at || f.created_at)} · Holder: ${esc(f.holder_name || '—')}</div>
    </div>
    <div class="fr-side">
      <span class="pill ${f.status === 'Open' ? 'ok' : 'muted'}">${esc(f.status)}</span>
      <span class="holder">${esc(f.holder_position || '—')}</span>
    </div>
  </a>`;
}

/* ---------------- Files list ---------------- */
const filters = { q: '', status: 'all', scope: 'all' };
function renderFiles() {
  view.innerHTML = `
    <div class="page-head">
      <div><h1>My Files</h1><p class="sub" id="fileCount">Files you created or received</p></div>
      <div class="head-actions"><a class="btn primary" href="#/new">➕ New File</a></div>
    </div>
    <div class="card pad filters">
      <input id="fq" placeholder="🔍 Search ref. no. or subject…" value="${esc(filters.q)}">
      <select id="fstatus">
        <option value="all">All statuses</option>
        <option value="Open" ${filters.status === 'Open' ? 'selected' : ''}>Open</option>
        <option value="Closed" ${filters.status === 'Closed' ? 'selected' : ''}>Closed</option>
      </select>
      <select id="fscope">
        <option value="all" ${filters.scope === 'all' ? 'selected' : ''}>All my files</option>
        <option value="holding" ${filters.scope === 'holding' ? 'selected' : ''}>Held by me</option>
      </select>
    </div>
    <div id="fileList"><div class="card empty">Loading…</div></div>`;

  const fq = document.getElementById('fq');
  let t;
  fq.addEventListener('input', () => { filters.q = fq.value; clearTimeout(t); t = setTimeout(paintFiles, 250); });
  document.getElementById('fstatus').addEventListener('change', e => { filters.status = e.target.value; paintFiles(); });
  document.getElementById('fscope').addEventListener('change', e => { filters.scope = e.target.value; paintFiles(); });
  paintFiles();
}
async function paintFiles() {
  const el = document.getElementById('fileList');
  if (!el) return;
  try {
    const d = await api('/api/files?' + new URLSearchParams(filters));
    document.getElementById('fileCount').textContent = `${d.files.length} file(s)`;
    el.innerHTML = d.files.length
      ? `<div class="file-list">${d.files.map(fileRow).join('')}</div>`
      : `<div class="card empty">No files match.</div>`;
  } catch (e) { el.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
}

/* ---------------- New file ---------------- */
async function renderNew() {
  let nextRef = 'FTS-' + new Date().getFullYear() + '-0001';
  try { nextRef = (await api('/api/next-ref')).ref; } catch (e) {}

  const deptLabel = state.user.department_code
    ? `${esc(state.user.department_name)} (${esc(state.user.department_code)})`
    : 'Global (no department)';

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Register New File</h1><p class="sub">You will be the initial holder — forward it from the file page.</p></div>
    </div>
    <div class="card pad">
      <p class="hint" style="margin-bottom:12px">Department: <b>${deptLabel}</b> · Your position: <b>${esc(state.user.position_name)}</b></p>

      <div class="grid2">
        <div>
          <label class="lbl">File Reference No. *</label>
          <input id="nRef" value="${esc(nextRef)}">
          <p class="hint">Auto-generated — you may edit.</p>
        </div>
        <div>
          <label class="lbl">Priority</label>
          <select id="nPrio"><option>Normal</option><option>Urgent</option><option>Immediate</option></select>
        </div>
      </div>

      <label class="lbl">Subject *</label>
      <input id="nSubject" placeholder="e.g. Purchase approval for office equipment">

      <label class="lbl">Description / Notes</label>
      <textarea id="nDesc" rows="3" placeholder="Brief details…"></textarea>

      <label class="lbl">Target Date</label>
      <input id="nDue" type="date">

      <div class="row" style="justify-content:flex-end;margin-top:20px">
        <a class="btn ghost" href="#/files">Cancel</a>
        <button class="btn primary" id="btnCreate">Create File</button>
      </div>
    </div>`;

  document.getElementById('btnCreate').addEventListener('click', async () => {
    const body = {
      refNo:       document.getElementById('nRef').value.trim(),
      subject:     document.getElementById('nSubject').value.trim(),
      description: document.getElementById('nDesc').value.trim(),
      priority:    document.getElementById('nPrio').value,
      dueDate:     document.getElementById('nDue').value || ''
    };
    if (!body.refNo)   return toast('Reference number is required', 'error');
    if (!body.subject) return toast('Subject is required', 'error');
    try {
      await api('/api/files', { method: 'POST', body });
      toast('File created', 'ok');
      location.hash = '#/file/' + encodeURIComponent(body.refNo);
    } catch (e) { toast(e.message, 'error'); }
  });
}

/* ---------------- File detail ---------------- */
async function renderFileDetail(ref) {
  view.innerHTML = `<div class="card empty">Loading…</div>`;
  let data;
  try { data = await api('/api/files/' + encodeURIComponent(ref)); }
  catch (e) {
    view.innerHTML = `<div class="card empty">
      ${esc(e.message)}<br><br><a class="btn" href="#/files">← Back to my files</a></div>`;
    return;
  }
  const { file: f, movements, chain, can_move } = data;
  const qrUrl = `/api/files/${encodeURIComponent(f.ref_no)}/qr.png?size=400&mode=${state.qrMode}&t=${Date.now()}`;

  view.innerHTML = `
    <div class="page-head">
      <div>
        <a class="back" href="#/files">← My files</a>
        <h1>${esc(f.ref_no)}</h1>
        <p class="sub">${esc(f.subject)}</p>
      </div>
      <div class="head-actions">
        <button class="btn ghost small" id="btnPrint">🖨 Print Label</button>
      </div>
    </div>

    <div class="detail-grid">
      <div class="col">
        <div class="card pad">
          <h2>Hierarchy Chain ${f.department_code ? `— ${esc(f.department_code)}` : ''}</h2>
          <div class="chain">
            ${chain.map((c, i) => {
              const isCur = c.name === f.holder_position;
              return `<span class="chip ${isCur ? 'current' : ''}">${esc(c.name)}${isCur ? ` · ${esc(f.holder_name)}` : ''}</span>${i < chain.length - 1 ? '<span class="arrow">→</span>' : ''}`;
            }).join('')}
          </div>
          <p class="hint">Files travel one step down (Forward) or back up (Return). Forward can also cross into other departments.</p>

          <dl class="kv">
            <dt>Status</dt><dd><span class="pill ${f.status === 'Open' ? 'ok' : 'muted'}">${esc(f.status)}</span></dd>
            <dt>Priority</dt><dd><span class="pill ${prioClass(f.priority)}">${esc(f.priority)}</span></dd>
            <dt>Creator</dt><dd>${esc(f.creator_name)}</dd>
            <dt>Current Holder</dt><dd><b>${esc(f.holder_name)}</b> — ${esc(f.holder_position)}${f.department_code ? ` (${esc(f.department_code)})` : ''}</dd>
            <dt>Created</dt><dd>${fmt(f.created_at)}</dd>
            <dt>Last Movement</dt><dd>${fmt(f.updated_at)}</dd>
            ${f.due_date ? `<dt>Target Date</dt><dd>${esc(f.due_date)}</dd>` : ''}
            ${f.description ? `<dt>Description</dt><dd>${esc(f.description)}</dd>` : ''}
          </dl>
        </div>

        <div class="card pad">
          <h2>Movement History (${movements.length})</h2>
          <div class="tl">
            ${movements.map(h => `
              <div class="tl-item">
                <div class="tl-top">
                  <b>${esc(h.action)}</b>
                  <span class="tl-route">${h.from_name ? esc(h.from_name) + ' → ' + esc(h.to_name) : 'by ' + esc(h.to_name)}</span>
                </div>
                ${h.remarks ? `<div class="tl-remarks">“${esc(h.remarks)}”</div>` : ''}
                <div class="tl-meta">${fmt(h.created_at)}</div>
              </div>`).join('')}
          </div>
        </div>
      </div>

      <div class="col">
        <div class="card pad">
          <h2>QR Code</h2>
          <div class="qr-box"><img alt="QR code for ${esc(f.ref_no)}" src="${qrUrl}"></div>
          <div class="qr-ref">${esc(f.ref_no)}</div>
          <p class="hint" style="text-align:center">
            ${state.qrMode === 'url' ? 'Scanning opens this file directly.' : 'Encodes only the reference number.'}
          </p>
          <div class="qr-actions">
            <button class="btn small" id="btnQrMode">Use ${state.qrMode === 'url' ? 'Ref No.' : 'Link'}</button>
            <button class="btn small" id="btnQrDown">⬇ PNG</button>
            <button class="btn small" id="btnQrCopy">🔗 Copy</button>
          </div>
        </div>

        <div class="card pad" id="attachCard">
          <h2>Attachments <span id="attachCount" class="muted" style="font-weight:500"></span></h2>
          <div id="attachList" class="attach-list"><p class="muted">Loading…</p></div>
          ${(f.status === 'Open' && (can_move || isSuper())) ? `
            <div class="attach-upload">
              <label class="lbl">Add Attachment</label>
              <input type="file" id="attachInput"
                     accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx,.txt,.csv">
              <p class="hint">Max 15 MB — PDF, images, Office docs, CSV, TXT.</p>
              <div class="row" style="justify-content:flex-end;margin-top:8px">
                <button class="btn primary small" id="attachBtn" disabled>⬆ Upload</button>
              </div>
            </div>` : ''}
        </div>

        <div class="card pad">
          <h2>Actions</h2>
          ${!can_move ? `<p class="hint" style="margin-top:0;color:var(--warn)">
            ${f.status === 'Closed' ? 'File is closed.' : `Only <b>${esc(f.holder_name)}</b>${isSuper() ? ' or a super admin' : ''} can move this file.`}
          </p>` : ''}
          <div class="actions-stack">
            <button class="btn primary block" id="btnFwd" ${!can_move ? 'disabled' : ''}>➡ Forward to User</button>
            <button class="btn block" id="btnRet" ${!can_move ? 'disabled' : ''}>⬅ Return to Previous Holder</button>
            <button class="btn block" id="btnRemark" ${!can_move && !isSuper() ? 'disabled' : ''}>💬 Add Remark</button>
            ${f.status === 'Open'
              ? `<button class="btn block" id="btnClose" ${!can_move ? 'disabled' : ''}>🔒 Close File</button>`
              : `<button class="btn block" id="btnReopen" ${!can_move ? 'disabled' : ''}>🔓 Reopen File</button>`}
            ${isSuper() ? `<button class="btn block danger" id="btnDelete">🗑 Delete File (Super Admin)</button>` : ''}
          </div>
        </div>
      </div>
    </div>`;

  /* ---- QR actions ---- */
  document.getElementById('btnQrDown').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = qrUrl.replace('size=400', 'size=800');
    a.download = f.ref_no.replace(/[^\w.-]/g, '_') + '_QR.png';
    document.body.appendChild(a); a.click(); a.remove();
    toast('Downloading QR image…', 'ok');
  });
  document.getElementById('btnQrCopy').addEventListener('click', () => {
    const text = state.qrMode === 'url'
      ? location.origin + location.pathname + '#/file/' + encodeURIComponent(f.ref_no)
      : f.ref_no;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(
        () => toast('Copied to clipboard', 'ok'),
        () => toast('Copy failed', 'error'));
    } else {
      const t = document.createElement('textarea');
      t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); toast('Copied', 'ok'); }
      catch (e) { toast('Copy not supported', 'error'); }
      t.remove();
    }
  });
  document.getElementById('btnQrMode').addEventListener('click', () => {
    state.qrMode = state.qrMode === 'url' ? 'ref' : 'url';
    localStorage.setItem('ft_qrmode', state.qrMode);
    renderFileDetail(f.ref_no);
  });

  /* ---- other actions ---- */
  document.getElementById('btnPrint').addEventListener('click', () => printLabel(f, qrUrl));
  bind('btnFwd',   () => openMoveModal(f.ref_no, 'Forwarded'));
  bind('btnRet',   () => openMoveModal(f.ref_no, 'Returned'));
  bind('btnRemark',() => addRemark(f.ref_no));
  bind('btnClose', () => setStatus(f.ref_no, 'Closed'));
  bind('btnReopen',() => setStatus(f.ref_no, 'Open'));
  bind('btnDelete',() => deleteFile(f.ref_no));

  /* ---- attachments ---- */
  initAttachments(f.ref_no);

  function bind(id, fn) {
    const el = document.getElementById(id);
    if (el && !el.disabled) el.addEventListener('click', fn);
  }
}

/* ---------------- attachments ---------------- */
async function initAttachments(ref) {
  const listEl  = document.getElementById('attachList');
  const countEl = document.getElementById('attachCount');
  const inputEl = document.getElementById('attachInput');
  const btnEl   = document.getElementById('attachBtn');
  if (!listEl) return;

  async function paint() {
    try {
      const d = await api('/api/files/' + encodeURIComponent(ref) + '/attachments');
      const rows = d.attachments || [];
      if (countEl) countEl.textContent = rows.length ? `(${rows.length})` : '';
      listEl.innerHTML = rows.length ? rows.map(a => `
        <div class="attach-row">
          <div class="attach-ico">${attachIcon(a.mime_type)}</div>
          <div class="attach-main">
            <a class="attach-name" href="/api/files/${encodeURIComponent(ref)}/attachments/${a.id}"
               target="_blank" rel="noopener">${esc(a.orig_name)}</a>
            <div class="attach-meta">${fmtBytes(a.size_bytes)} · ${esc(a.uploader_name)} · ${relTime(a.created_at)}</div>
          </div>
          <div class="attach-actions">
            <a class="btn small" href="/api/files/${encodeURIComponent(ref)}/attachments/${a.id}"
               download="${esc(a.orig_name)}" title="Download">⬇</a>
            ${a.can_delete ? `<button class="btn small danger" data-adel="${a.id}" title="Delete">🗑</button>` : ''}
          </div>
        </div>`).join('') : `<p class="muted">No attachments yet.</p>`;

      listEl.querySelectorAll('[data-adel]').forEach(b =>
        b.addEventListener('click', () => deleteAttachment(ref, +b.dataset.adel, paint)));
    } catch (e) {
      listEl.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    }
  }

  if (inputEl && btnEl) {
    inputEl.addEventListener('change', () => { btnEl.disabled = !inputEl.files.length; });
    btnEl.addEventListener('click', async () => {
      const file = inputEl.files[0];
      if (!file) return;
      btnEl.disabled = true;
      const oldLabel = btnEl.textContent;
      btnEl.textContent = 'Uploading…';
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch(
          '/api/files/' + encodeURIComponent(ref) + '/attachments',
          { method: 'POST', body: fd, credentials: 'same-origin' }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        toast('Attachment uploaded', 'ok');
        inputEl.value = '';
        btnEl.textContent = oldLabel;
        btnEl.disabled = true;
        paint();
      } catch (e) {
        toast(e.message, 'error');
        btnEl.textContent = oldLabel;
        btnEl.disabled = false;
      }
    });
  }

  paint();
}

function deleteAttachment(ref, id, refresh) {
  showModal({
    title: 'Delete Attachment',
    body: `<p style="margin-top:10px">Delete this attachment permanently?</p>`,
    okLabel: 'Delete', okClass: 'danger',
    onOk: async () => {
      try {
        await api(`/api/files/${encodeURIComponent(ref)}/attachments/${id}`, { method: 'DELETE' });
        toast('Attachment deleted', 'ok');
        refresh();
        return true;
      } catch (e) { toast(e.message, 'error'); return false; }
    }
  });
}

/* ---------------- Move (forward / return) ---------------- */
async function openMoveModal(ref, action) {
  let data;
  try { data = await api(`/api/files/${encodeURIComponent(ref)}/targets`); }
  catch (e) { return toast(e.message, 'error'); }

  const list = action === 'Forwarded' ? data.forward : data.return;
  const label = action === 'Forwarded' ? 'Forward to' : 'Return to';

  if (!list.length) {
    return toast(`No eligible recipients for ${label.toLowerCase()}`, 'error');
  }

  const groups = new Map();
  list.forEach(u => {
    const key = u.department_id == null ? '__global__' : `d${u.department_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        label: u.department_id == null
          ? 'Global (no department)'
          : (u.department_name ? `${u.department_name}${u.department_code ? ' (' + u.department_code + ')' : ''}` : 'Department #' + u.department_id),
        rows: []
      });
    }
    groups.get(key).rows.push(u);
  });

  const pickerHtml = Array.from(groups.values()).map(g => `
    <div class="pick-group">
      <div class="pick-group-head">${esc(g.label)}</div>
      ${g.rows.map(u => `
        <label class="pick-row">
          <input type="radio" name="target" value="${u.id}">
          <span class="who">
            <b>${esc(u.full_name)}</b>
            <small>${esc(u.position_name)}${u.department_code ? ' · ' + esc(u.department_code) : ''} · @${esc(u.username)}</small>
          </span>
        </label>`).join('')}
    </div>`).join('');

  showModal({
    title: label,
    body: `
      <p class="muted" style="margin-top:10px">Pick a recipient for <b>${esc(ref)}</b>. Recipients may belong to <b>any</b> department.</p>
      <label class="lbl">Recipient</label>
      <div class="picker">${pickerHtml}</div>
      <label class="lbl">Remarks</label>
      <textarea id="mvRemarks" rows="2" placeholder="Optional"></textarea>`,
    okLabel: label,
    onOk: async () => {
      const pick = document.querySelector('input[name="target"]:checked');
      if (!pick) { toast('Pick a recipient', 'error'); return false; }
      const remarks = (document.getElementById('mvRemarks').value || '').trim();
      try {
        await api(`/api/files/${encodeURIComponent(ref)}/move`, {
          method: 'POST',
          body: { toUserId: +pick.value, action, remarks }
        });
        toast('File ' + (action === 'Forwarded' ? 'forwarded' : 'returned'), 'ok');
        router();
        return true;
      } catch (e) { toast(e.message, 'error'); return false; }
    }
  });
}

function addRemark(ref) {
  showModal({
    title: 'Add Remark',
    body: `<label class="lbl">Remark</label>
           <textarea id="rmk" rows="3" placeholder="Write a note…"></textarea>`,
    okLabel: 'Save Remark',
    onOk: async () => {
      const remarks = (document.getElementById('rmk').value || '').trim();
      if (!remarks) { toast('Remark cannot be empty', 'error'); return false; }
      try {
        await api(`/api/files/${encodeURIComponent(ref)}/remark`, { method: 'POST', body: { remarks } });
        toast('Remark added', 'ok');
        router();
        return true;
      } catch (e) { toast(e.message, 'error'); return false; }
    }
  });
}

/* ---------------- Status ---------------- */
function setStatus(ref, status) {
  if (status === 'Closed') {
    showModal({
      title: 'Close File',
      body: `
        <p class="muted" style="margin-top:10px">You are about to close <b>${esc(ref)}</b>.</p>
        <label class="lbl">Closing Remarks <span class="muted" style="text-transform:none;font-weight:500">(optional)</span></label>
        <textarea id="closeRemarks" rows="3" placeholder="e.g. Approved & filed under Finance/2026/05"></textarea>
        <p class="hint">A closed file is read‑only until it is reopened.</p>`,
      okLabel: 'Close File',
      okClass: 'primary',
      onOk: async () => {
        const remarks = (document.getElementById('closeRemarks').value || '').trim();
        try {
          await api(`/api/files/${encodeURIComponent(ref)}/status`, {
            method: 'POST',
            body: { status: 'Closed', remarks }
          });
          toast('File closed', 'ok');
          router();
          return true;
        } catch (e) { toast(e.message, 'error'); return false; }
      }
    });
    return;
  }

  (async () => {
    try {
      await api(`/api/files/${encodeURIComponent(ref)}/status`, {
        method: 'POST',
        body: { status: 'Open', remarks: '' }
      });
      toast('File reopened', 'ok');
      router();
    } catch (e) { toast(e.message, 'error'); }
  })();
}

function deleteFile(ref) {
  showModal({
    title: 'Delete File',
    body: `<p style="margin-top:10px">Permanently delete <b>${esc(ref)}</b>, its attachments, and its entire history?</p>`,
    okLabel: 'Delete', okClass: 'danger',
    onOk: async () => {
      try {
        await api('/api/files/' + encodeURIComponent(ref), { method: 'DELETE' });
        toast('File deleted', 'ok');
        location.hash = '#/files';
        return true;
      } catch (e) { toast(e.message, 'error'); return false; }
    }
  });
}

/* ---------------- Print label ---------------- */
function printLabel(f, qrUrl) {
  const pa = document.getElementById('printArea');
  pa.innerHTML = `
    <div class="label">
      <div class="label-head">FILE TRACKING SLIP</div>
      <div class="label-body">
        <div class="label-qr"><img id="printQR" src="${qrUrl}" alt="QR"></div>
        <div class="label-info">
          <div><span>Ref. No.</span><b>${esc(f.ref_no)}</b></div>
          <div><span>Subject</span><b>${esc(f.subject)}</b></div>
          <div><span>Priority</span><b>${esc(f.priority)}</b></div>
          <div><span>Holder</span><b>${esc(f.holder_name)} — ${esc(f.holder_position)}</b></div>
          <div><span>Department</span><b>${esc(f.department_code || '—')}</b></div>
          <div><span>Status</span><b>${esc(f.status)}</b></div>
          <div><span>Registered</span><b>${fmt(f.created_at)}</b></div>
        </div>
      </div>
      <div class="label-foot">Scan the QR code to open this file in the tracking system.</div>
    </div>`;
  const img = document.getElementById('printQR');
  const go = () => setTimeout(() => window.print(), 120);
  if (img.complete) go(); else { img.onload = go; img.onerror = go; }
}

/* ---------------- Scan / Lookup ---------------- */
let scanStream = null, scanTimer = null;
function renderScan() {
  stopScan();
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Scan / Lookup</h1><p class="sub">Scan a QR code or enter a reference number</p></div>
    </div>
    <div class="card pad" style="margin-bottom:16px">
      <label class="lbl">File Reference Number</label>
      <div class="row">
        <input id="sRef" placeholder="e.g. FTS-2026-0001" autocomplete="off">
        <button class="btn primary" id="btnLookup">Open</button>
      </div>
      <p class="hint">You can only open files you created or received.</p>
    </div>
    <div class="card pad">
      <h2>Camera Scan</h2>
      <div id="scanWrap">
        <video id="scanVideo" playsinline muted autoplay></video>
        <div id="scanHint">Camera is off. Tap “Start Camera”.</div>
      </div>
      <div class="row">
        <button class="btn primary" id="btnScanStart">📷 Start Camera</button>
        <button class="btn ghost" id="btnScanStop" style="display:none">Stop</button>
      </div>
    </div>`;
  const input = document.getElementById('sRef');
  const lookup = () => {
    const v = input.value.trim();
    if (!v) return toast('Enter a reference number', 'error');
    location.hash = '#/file/' + encodeURIComponent(extractRef(v));
  };
  document.getElementById('btnLookup').addEventListener('click', lookup);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') lookup(); });
  document.getElementById('btnScanStart').addEventListener('click', startScan);
  document.getElementById('btnScanStop').addEventListener('click', stopScan);
  setTimeout(() => input.focus(), 100);
}
function extractRef(text) {
  const t = String(text || '').trim();
  const m = /[#/]file\/([^?#\s]+)/i.exec(t);
  if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
  const m2 = /(FTS-\d{4}-\d+)/i.exec(t);
  return m2 ? m2[1] : t;
}
async function startScan() {
  const v = document.getElementById('scanVideo');
  const hint = document.getElementById('scanHint');
  if (!('BarcodeDetector' in window)) {
    hint.textContent = 'Browser does not support live QR scanning. Enter reference manually.';
    return toast('Live QR scan not supported here', 'error');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    hint.textContent = 'Camera unavailable (requires HTTPS or localhost).';
    return toast('Camera not available', 'error');
  }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    v.srcObject = scanStream; await v.play();
    document.getElementById('btnScanStart').style.display = 'none';
    document.getElementById('btnScanStop').style.display = '';
    const det = new BarcodeDetector({ formats: ['qr_code'] });
    const tick = async () => {
      if (!scanStream) return;
      try {
        const codes = await det.detect(v);
        if (codes && codes.length) {
          const value = codes[0].rawValue;
          stopScan();
          toast('QR scanned', 'ok');
          location.hash = '#/file/' + encodeURIComponent(extractRef(value));
          return;
        }
      } catch (e) {}
      scanTimer = setTimeout(tick, 350);
    };
    tick();
  } catch (e) {
    hint.textContent = 'Camera error: ' + e.message;
    toast('Could not start camera', 'error');
  }
}
function stopScan() {
  if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
  if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
  const v = document.getElementById('scanVideo'); if (v) v.srcObject = null;
  const s = document.getElementById('btnScanStart'); if (s) s.style.display = '';
  const t = document.getElementById('btnScanStop'); if (t) t.style.display = 'none';
}

/* ---------------- Admin ---------------- */
let adminTab = 'departments';
function renderAdmin() {
  if (!isSuper()) { view.innerHTML = `<div class="card empty">Super admin access required.</div>`; return; }
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Administration</h1><p class="sub">Departments · Hierarchy · Users</p></div>
    </div>
    <div class="tabs">
      <button class="tab ${adminTab === 'departments' ? 'active' : ''}" data-tab="departments">Departments</button>
      <button class="tab ${adminTab === 'positions' ? 'active' : ''}" data-tab="positions">Hierarchy / Positions</button>
      <button class="tab ${adminTab === 'users' ? 'active' : ''}" data-tab="users">Users</button>
    </div>
    <div id="adminBody"></div>`;
  view.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
    adminTab = b.dataset.tab; renderAdmin();
  }));
  if (adminTab === 'departments') renderAdminDepartments();
  else if (adminTab === 'positions') renderAdminPositions();
  else renderAdminUsers();
}

async function renderAdminDepartments() {
  const el = document.getElementById('adminBody');
  el.innerHTML = `<div class="card empty">Loading…</div>`;
  let d;
  try { d = await api('/api/departments'); } catch (e) { el.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }
  el.innerHTML = `
    <div class="card pad" style="margin-bottom:14px;display:flex;justify-content:flex-end">
      <button class="btn primary" id="btnAddDept">➕ Add Department</button>
    </div>
    <div class="card" style="overflow:auto">
      <table class="tbl">
        <thead><tr><th>Code</th><th>Name</th><th>Users</th><th>Files</th><th>Status</th><th class="acts"></th></tr></thead>
        <tbody>
          ${d.departments.map(dd => `
            <tr>
              <td><b>${esc(dd.code)}</b></td>
              <td>${esc(dd.name)}</td>
              <td>${dd.user_count}</td>
              <td>${dd.file_count}</td>
              <td><span class="pill ${dd.active ? 'ok' : 'muted'}">${dd.active ? 'Active' : 'Disabled'}</span></td>
              <td class="acts">
                <button class="btn small" data-edit="${dd.id}">Edit</button>
                <button class="btn small danger" data-del="${dd.id}">Delete</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  document.getElementById('btnAddDept').addEventListener('click', () => deptModal(null));
  el.querySelectorAll('[data-edit]').forEach(b =>
    b.addEventListener('click', () => deptModal(d.departments.find(x => x.id === +b.dataset.edit))));
  el.querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', () => deleteDept(+b.dataset.del)));
}
function deptModal(d) {
  const isNew = !d;
  showModal({
    title: isNew ? 'Add Department' : 'Edit Department',
    body: `
      <label class="lbl">Code (2-12 letters/digits)</label>
      <input id="dCode" value="${esc(d?.code || '')}" placeholder="GSPMD" ${!isNew ? 'disabled' : ''}>
      <label class="lbl">Name</label>
      <input id="dName" value="${esc(d?.name || '')}" placeholder="General Services…">
      ${!isNew ? `
        <label class="lbl">Status</label>
        <select id="dActive">
          <option value="1" ${d.active ? 'selected' : ''}>Active</option>
          <option value="0" ${!d.active ? 'selected' : ''}>Disabled</option>
        </select>` : ''}`,
    okLabel: isNew ? 'Create' : 'Save',
    onOk: async () => {
      const body = { name: document.getElementById('dName').value.trim() };
      if (isNew) body.code = document.getElementById('dCode').value.trim();
      if (isNew && !body.code) { toast('Code required', 'error'); return false; }
      if (!body.name) { toast('Name required', 'error'); return false; }
      try {
        if (isNew) await api('/api/departments', { method: 'POST', body });
        else {
          body.active = document.getElementById('dActive').value === '1';
          await api('/api/departments/' + d.id, { method: 'PATCH', body });
        }
        toast(isNew ? 'Department created' : 'Updated', 'ok');
        await loadMeta();
        renderAdminDepartments();
        return true;
      } catch (e) { toast(e.message, 'error'); return false; }
    }
  });
}
function deleteDept(id) {
  showModal({
    title: 'Delete Department',
    body: `<p style="margin-top:10px">Delete this department permanently?</p>`,
    okLabel: 'Delete', okClass: 'danger',
    onOk: async () => {
      try { await api('/api/departments/' + id, { method: 'DELETE' }); toast('Deleted', 'ok'); renderAdminDepartments(); return true; }
      catch (e) { toast(e.message, 'error'); return false; }
    }
  });
}

async function renderAdminPositions() {
  const el = document.getElementById('adminBody');
  el.innerHTML = `<div class="card empty">Loading…</div>`;
  let d, depts;
  try {
    d = await api('/api/positions');
    depts = (await api('/api/departments')).departments;
  } catch (e) { el.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }

  const global = d.positions.filter(p => p.department_id === null);
  const groups = {};
  d.positions.filter(p => p.department_id !== null).forEach(p => {
    if (!groups[p.department_code]) groups[p.department_code] = { name: p.department_name, rows: [] };
    groups[p.department_code].rows.push(p);
  });

  el.innerHTML = `
    <div class="card pad" style="margin-bottom:14px;display:flex;justify-content:flex-end">
      <button class="btn primary" id="btnAddPos">➕ Add Position</button>
    </div>
    <div class="card pad" style="margin-bottom:14px">
      <h2>Global (all departments)</h2>
      ${global.length ? `<table class="tbl"><thead><tr><th>Rank</th><th>Name</th><th>Users</th><th class="acts"></th></tr></thead><tbody>
        ${global.map(p => `<tr>
          <td>${p.rank}</td>
          <td><b>${esc(p.name)}</b></td>
          <td>${p.user_count}</td>
          <td class="acts">
            <button class="btn small" data-edit="${p.id}">Edit</button>
            <button class="btn small danger" data-del="${p.id}">Delete</button>
          </td></tr>`).join('')}
      </tbody></table>` : `<p class="muted">No global positions.</p>`}
    </div>
    ${Object.entries(groups).map(([code, g]) => `
      <div class="card pad" style="margin-bottom:14px">
        <h2>${esc(code)} — ${esc(g.name)}</h2>
        <table class="tbl"><thead><tr><th>Rank</th><th>Name</th><th>Users</th><th class="acts"></th></tr></thead><tbody>
          ${g.rows.map(p => `<tr>
            <td>${p.rank}</td>
            <td><b>${esc(p.name)}</b></td>
            <td>${p.user_count}</td>
            <td class="acts">
              <button class="btn small" data-edit="${p.id}">Edit</button>
              <button class="btn small danger" data-del="${p.id}">Delete</button>
            </td></tr>`).join('')}
        </tbody></table>
      </div>`).join('')}`;

  document.getElementById('btnAddPos').addEventListener('click', () => posModal(null, depts));
  el.querySelectorAll('[data-edit]').forEach(b =>
    b.addEventListener('click', () => posModal(d.positions.find(x => x.id === +b.dataset.edit), depts)));
  el.querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', () => deletePos(+b.dataset.del)));
}
function posModal(p, depts) {
  const isNew = !p;
  showModal({
    title: isNew ? 'Add Position' : 'Edit Position',
    body: `
      <label class="lbl">Department</label>
      <select id="pDept" ${!isNew ? 'disabled' : ''}>
        <option value="">— Global (all departments) —</option>
        ${depts.map(d => `<option value="${d.id}" ${p?.department_id === d.id ? 'selected' : ''}>${esc(d.name)} (${esc(d.code)})</option>`).join('')}
      </select>
      <label class="lbl">Position Name</label>
      <input id="pName" value="${esc(p?.name || '')}" placeholder="e.g. Manager">
      <label class="lbl">Rank (1 = highest)</label>
      <input id="pRank" type="number" min="1" max="99" value="${p?.rank || ''}">
      <p class="hint">Rank must be unique within the chosen scope.</p>
      ${!isNew ? `
        <label class="lbl">Status</label>
        <select id="pActive">
          <option value="1" ${p.active ? 'selected' : ''}>Active</option>
          <option value="0" ${!p.active ? 'selected' : ''}>Disabled</option>
        </select>` : ''}`,
    okLabel: isNew ? 'Create' : 'Save',
    onOk: async () => {
      const body = {
        name: document.getElementById('pName').value.trim(),
        rank: parseInt(document.getElementById('pRank').value, 10)
      };
      if (!body.name) { toast('Name required', 'error'); return false; }
      if (!body.rank || body.rank < 1) { toast('Rank must be ≥ 1', 'error'); return false; }
      if (isNew) {
        const sel = document.getElementById('pDept').value;
        body.department_id = sel === '' ? null : +sel;
      }
      try {
        if (isNew) await api('/api/positions', { method: 'POST', body });
        else {
          body.active = document.getElementById('pActive').value === '1';
          await api('/api/positions/' + p.id, { method: 'PATCH', body });
        }
        toast(isNew ? 'Position created' : 'Updated', 'ok');
        await loadMeta();
        renderAdminPositions();
        return true;
      } catch (e) { toast(e.message, 'error'); return false; }
    }
  });
}
function deletePos(id) {
  showModal({
    title: 'Delete Position',
    body: `<p style="margin-top:10px">Delete this position permanently?</p>`,
    okLabel: 'Delete', okClass: 'danger',
    onOk: async () => {
      try { await api('/api/positions/' + id, { method: 'DELETE' }); toast('Deleted', 'ok'); renderAdminPositions(); return true; }
      catch (e) { toast(e.message, 'error'); return false; }
    }
  });
}

async function renderAdminUsers() {
  const el = document.getElementById('adminBody');
  el.innerHTML = `<div class="card empty">Loading…</div>`;
  let d, positions;
  try {
    [d, positions] = await Promise.all([
      api('/api/users'),
      api('/api/positions').then(x => x.positions)
    ]);
  } catch (e) { el.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; return; }

  el.innerHTML = `
    <div class="card pad" style="margin-bottom:14px;display:flex;justify-content:flex-end">
      <button class="btn primary" id="btnAddUser">➕ Add User</button>
    </div>
    <div class="card" style="overflow:auto">
      <table class="tbl">
        <thead><tr><th>Name</th><th>Username</th><th>Position</th><th>Department</th><th>Role</th><th>Status</th><th class="acts"></th></tr></thead>
        <tbody>
          ${d.users.map(u => `
            <tr>
              <td><b>${esc(u.full_name)}</b></td>
              <td>${esc(u.username)}</td>
              <td>${esc(u.position_name)}</td>
              <td>${esc(u.department_code || '—')}</td>
              <td>${u.is_super_admin ? '<span class="pill brand">Super Admin</span>' : ''}</td>
              <td><span class="pill ${u.active ? 'ok' : 'muted'}">${u.active ? 'Active' : 'Disabled'}</span>
                  ${u.must_change_password ? '<span class="pill urgent">Pwd reset</span>' : ''}</td>
              <td class="acts">
                <button class="btn small" data-edit="${u.id}">Edit</button>
                ${u.id !== state.user.id ? `<button class="btn small danger" data-del="${u.id}">Delete</button>` : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  document.getElementById('btnAddUser').addEventListener('click', () => userModal(null, positions));
  el.querySelectorAll('[data-edit]').forEach(b =>
    b.addEventListener('click', () => userModal(d.users.find(x => x.id === +b.dataset.edit), positions)));
  el.querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', () => deleteUser(+b.dataset.del)));
}
function userModal(u, positions) {
  const isNew = !u;
  const globalPos  = positions.filter(p => p.department_id === null);
  const byDept = {};
  positions.filter(p => p.department_id !== null).forEach(p => {
    byDept[p.department_id] = byDept[p.department_id] || [];
    byDept[p.department_id].push(p);
  });

  const posOptions = `
    <option value="">— Select position —</option>
    ${globalPos.length ? `<optgroup label="Global">${globalPos.map(p => `<option value="${p.id}" ${u?.position_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>` : ''}
    ${Object.entries(byDept).map(([deptId, list]) => {
      const dept = state.departments.find(x => x.id === +deptId);
      const label = dept ? `${dept.name} (${dept.code})` : 'Dept #' + deptId;
      return `<optgroup label="${esc(label)}">${list.map(p => `<option value="${p.id}" ${u?.position_id === p.id ? 'selected' : ''}>${esc(p.name)} · rank ${p.rank}</option>`).join('')}</optgroup>`;
    }).join('')}
  `;

  showModal({
    title: isNew ? 'Add User' : 'Edit User',
    body: `
      <label class="lbl">Full Name</label>
      <input id="uFull" value="${esc(u?.full_name || '')}" placeholder="e.g. R. Sharma">
      <label class="lbl">Username</label>
      <input id="uUser" value="${esc(u?.username || '')}" placeholder="login name" ${!isNew ? 'disabled' : ''}>
      <label class="lbl">Position</label>
      <select id="uPos">${posOptions}</select>
      <label class="lbl">${isNew ? 'Temporary Password' : 'Reset Password (leave blank to keep)'}</label>
      <input id="uPass" type="password" placeholder="••••••••">
      <label class="row" style="gap:9px;margin-top:14px;cursor:pointer">
        <input type="checkbox" id="uSuper" style="width:auto" ${u?.is_super_admin ? 'checked' : ''}>
        <span><b>Super Admin</b><br><small class="muted">Full control: manage departments, positions, users, delete files, move any file.</small></span>
      </label>
      ${!isNew ? `
        <label class="lbl">Status</label>
        <select id="uActive">
          <option value="1" ${u.active ? 'selected' : ''}>Active</option>
          <option value="0" ${!u.active ? 'selected' : ''}>Disabled</option>
        </select>` : ''}
      <p class="hint">Password must be at least 8 characters, with letters and numbers.</p>`,
    okLabel: isNew ? 'Create User' : 'Save',
    onOk: async () => {
      const full = document.getElementById('uFull').value.trim();
      const posId = document.getElementById('uPos').value;
      const pass = document.getElementById('uPass').value;
      const superA = document.getElementById('uSuper').checked;
      if (!full) { toast('Full name required', 'error'); return false; }
      if (!posId) { toast('Pick a position', 'error'); return false; }
      const body = { full_name: full, position_id: +posId, is_super_admin: superA };
      try {
        if (isNew) {
          const username = document.getElementById('uUser').value.trim();
          if (!username) { toast('Username required', 'error'); return false; }
          if (!pass) { toast('Password required', 'error'); return false; }
          body.username = username;
          body.password = pass;
          await api('/api/users', { method: 'POST', body });
        } else {
          if (pass) body.password = pass;
          body.active = document.getElementById('uActive').value === '1';
          await api('/api/users/' + u.id, { method: 'PATCH', body });
        }
        toast(isNew ? 'User created' : 'Updated', 'ok');
        renderAdminUsers();
        return true;
      } catch (e) { toast(e.message, 'error'); return false; }
    }
  });
}
function deleteUser(id) {
  showModal({
    title: 'Delete User',
    body: `<p style="margin-top:10px">Delete this user permanently?</p>`,
    okLabel: 'Delete', okClass: 'danger',
    onOk: async () => {
      try { await api('/api/users/' + id, { method: 'DELETE' }); toast('Deleted', 'ok'); renderAdminUsers(); return true; }
      catch (e) { toast(e.message, 'error'); return false; }
    }
  });
}

/* ---------------- Account / settings ---------------- */
function renderSettings() {
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Account</h1><p class="sub">Your profile, password and QR preference</p></div>
    </div>
    <div class="cols">
      <div class="col">
        <div class="card pad">
          <h2>Profile</h2>
          <dl class="kv">
            <dt>Name</dt><dd>${esc(state.user.full_name)}</dd>
            <dt>Username</dt><dd>${esc(state.user.username)}</dd>
            <dt>Position</dt><dd>${esc(state.user.position_name)}</dd>
            <dt>Department</dt><dd>${state.user.department_name ? esc(state.user.department_name) + ' (' + esc(state.user.department_code) + ')' : 'Global'}</dd>
            <dt>Role</dt><dd>${isSuper() ? '<span class="pill brand">Super Admin</span>' : 'Regular User'}</dd>
          </dl>
        </div>
        <div class="card pad">
          <h2>Password</h2>
          <p class="muted">Keep your account secure — passwords are stored as bcrypt hashes.</p>
          <button class="btn primary" style="margin-top:12px" onclick="openChangePassword(false)">Change Password</button>
        </div>
      </div>
      <div class="col">
        <div class="card pad">
          <h2>QR Code Content</h2>
          <p class="muted">Choose what gets encoded into each file's QR code.</p>
          <div style="margin-top:12px">
            <label class="row" style="gap:9px;margin-bottom:9px;cursor:pointer">
              <input type="radio" name="qrmode" value="url" ${state.qrMode === 'url' ? 'checked' : ''} style="width:auto">
              <span><b>Direct link</b><br><small class="muted">Scanning opens the file on a phone.</small></span>
            </label>
            <label class="row" style="gap:9px;cursor:pointer">
              <input type="radio" name="qrmode" value="ref" ${state.qrMode === 'ref' ? 'checked' : ''} style="width:auto">
              <span><b>Reference number only</b><br><small class="muted">Short code, looked up in Scan / Lookup.</small></span>
            </label>
          </div>
        </div>
        <div class="card pad">
          <h2>Session</h2>
          <p class="muted">Signed in as <b>${esc(state.user.full_name)}</b>.</p>
          <button class="btn danger" style="margin-top:12px" onclick="showUserMenu()">Sign Out</button>
        </div>
      </div>
    </div>`;
  document.querySelectorAll('input[name="qrmode"]').forEach(r =>
    r.addEventListener('change', e => {
      state.qrMode = e.target.value;
      localStorage.setItem('ft_qrmode', state.qrMode);
      toast('QR mode updated', 'ok');
    }));
}

/* =========================================================
   Router
   ========================================================= */
function router() {
  if (!state.user) return showLogin();
  stopScan();
  const hash = (location.hash || '#/dashboard').slice(1);

  if (hash.startsWith('/file/')) {
    renderFileDetail(decodeURIComponent(hash.slice(6)));
    setActiveNav('#/files');
  } else {
    switch (hash) {
      case '/files':    renderFiles();    break;
      case '/new':      renderNew();      break;
      case '/scan':     renderScan();     break;
      case '/admin':    renderAdmin();    break;
      case '/settings': renderSettings(); break;
      default:          renderDashboard();break;
    }
    setActiveNav(['/dashboard','/files','/new','/scan','/admin','/settings'].includes(hash) ? hash : '#/dashboard');
  }
  window.scrollTo(0, 0);
}
function setActiveNav(hash) {
  document.querySelectorAll('[data-nav]').forEach(a =>
    a.classList.toggle('active', a.getAttribute('href') === hash));
}
window.addEventListener('hashchange', router);