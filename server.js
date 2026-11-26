'use strict';
const path         = require('path');
const crypto       = require('crypto');
const fs           = require('fs');
const express      = require('express');
const cookieParser = require('cookie-parser');
const bcrypt       = require('bcryptjs');
const QRCode       = require('qrcode');
const multer       = require('multer');
const db           = require('./database');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const COOKIE = 'ft_session';
const SESSION_MS = 7 * 24 * 3600 * 1000;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(ROOT, 'public')));

/* ---------------- upload storage ---------------- */
const UPLOAD_DIR = path.join(ROOT, 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv'
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().slice(0, 10);
      cb(null, crypto.randomUUID() + ext);
    }
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) return cb(new Error('File type not allowed'));
    cb(null, true);
  }
});

/* ---------------- audit ---------------- */
function audit(userId, action, details, req) {
  try {
    db.prepare('INSERT INTO audit_log (user_id,action,details,ip,created_at) VALUES (?,?,?,?,?)')
      .run(userId || null, action, details || '', (req && req.ip) || '', new Date().toISOString());
  } catch (e) {}
}

/* ---------------- rate limit on login ---------------- */
/* =========================================================
   Login throttling — failed-attempt only, per (IP + username)
   ========================================================= */
const loginFailures = new Map();   // key: `${ip}|${username}` → { n, firstAt, nextAt }
const FAIL_WINDOW_MS   = 15 * 60 * 1000;   // 15 min rolling window for counting
const FREE_FAILS       = 5;                // attempts before any delay kicks in
const BACKOFF_MS       = [0, 0, 0, 0, 0, 5000, 15000, 30000, 60000, 120000]; // by fail count
const HARD_LOCK_AT     = 10;               // after this many fails → 5-min lockout
const HARD_LOCK_MS     = 5 * 60 * 1000;

function rateLimitLogin(req, res, next) {
  const ip = req.ip || 'x';
  const username = String((req.body && req.body.username) || '').trim().toLowerCase();
  const key = `${ip}|${username}`;
  const now = Date.now();

  let r = loginFailures.get(key);
  if (!r || now - r.firstAt > FAIL_WINDOW_MS) {
    r = { n: 0, firstAt: now, nextAt: 0 };
    loginFailures.set(key, r);
  }

  if (r.n >= HARD_LOCK_AT) {
    const waitMs = Math.max(0, r.nextAt - now);
    if (waitMs > 0) {
      const waitSec = Math.ceil(waitMs / 1000);
      console.warn(`[login-lock] ${key} hard-locked for ${waitSec}s`);
      res.set('Retry-After', String(waitSec));
      return res.status(429).json({
        error: `Too many failed attempts. Try again in ${waitSec} second${waitSec === 1 ? '' : 's'}.`,
        retryAfter: waitSec
      });
    }
    // lockout expired → reset counter but keep window
    r.n = 0;
    r.firstAt = now;
    r.nextAt = 0;
  }

  if (r.n >= FREE_FAILS) {
    const waitMs = Math.max(0, r.nextAt - now);
    if (waitMs > 0) {
      const waitSec = Math.ceil(waitMs / 1000);
      console.warn(`[login-backoff] ${key} must wait ${waitSec}s (${r.n} fails)`);
      res.set('Retry-After', String(waitSec));
      return res.status(429).json({
        error: `Please wait ${waitSec} second${waitSec === 1 ? '' : 's'} before trying again.`,
        retryAfter: waitSec
      });
    }
  }

  // Passed. Attach a helper that the login handler calls on failure.
  req.registerLoginFailure = () => {
    const r2 = loginFailures.get(key) || { n: 0, firstAt: now, nextAt: 0 };
    r2.n++;
    r2.nextAt = now + (BACKOFF_MS[Math.min(r2.n, BACKOFF_MS.length - 1)] || 0);
    if (r2.n >= HARD_LOCK_AT) r2.nextAt = now + HARD_LOCK_MS;
    loginFailures.set(key, r2);
    const remaining = Math.max(0, HARD_LOCK_AT - r2.n);
    return { attempts: r2.n, remaining };
  };
  req.clearLoginFailures = () => loginFailures.delete(key);

  next();
}

/* background sweep so the Map doesn't grow forever */
setInterval(() => {
  const cut = Date.now() - FAIL_WINDOW_MS * 4;
  for (const [k, v] of loginFailures) {
    if (v.firstAt < cut) loginFailures.delete(k);
  }
}, 5 * 60 * 1000);

/* ---------------- auth helpers ---------------- */
function userWithMeta(id) {
  return db.prepare(`
    SELECT u.id, u.username, u.full_name, u.position_id, u.department_id,
           u.is_super_admin, u.active, u.must_change_password, u.created_at,
           p.name AS position_name, p.rank AS position_rank,
           d.code AS department_code, d.name AS department_name
    FROM users u
    JOIN positions p ON p.id = u.position_id
    LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.id = ?
  `).get(id);
}
function currentUser(req) {
  const t = req.cookies[COOKIE];
  if (!t) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(t);
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
    return null;
  }
  const u = userWithMeta(s.user_id);
  if (!u || !u.active) return null;
  return u;
}
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Not authenticated' });
  req.user = u; next();
}
function requireSuper(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!req.user.is_super_admin) return res.status(403).json({ error: 'Super admin access required' });
  next();
}
const publicUser = u => ({
  id: u.id, username: u.username, full_name: u.full_name,
  position_id: u.position_id, position_name: u.position_name, position_rank: u.position_rank,
  department_id: u.department_id, department_name: u.department_name, department_code: u.department_code,
  is_super_admin: !!u.is_super_admin, must_change_password: !!u.must_change_password
});

/* ---------------- auth routes ---------------- */
app.post('/api/login', rateLimitLogin, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password required' });

  const u = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!u || !u.active) {
    const { attempts, remaining } = req.registerLoginFailure();
    audit(u ? u.id : null, 'LOGIN_FAILED', 'Unknown/inactive user', req);
    return res.status(401).json({
      error: 'Invalid username or password',
      attempts,
      remaining
    });
  }
  if (!bcrypt.compareSync(password, u.password_hash)) {
    const { attempts, remaining } = req.registerLoginFailure();
    audit(u.id, 'LOGIN_FAILED', 'Wrong password', req);
    return res.status(401).json({
      error: 'Invalid username or password',
      attempts,
      remaining
    });
  }

  // success → wipe the throttle counter for this (IP + username)
  req.clearLoginFailures();

  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  db.prepare('INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)')
    .run(token, u.id, now.toISOString(), new Date(now.getTime() + SESSION_MS).toISOString());
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', maxAge: SESSION_MS, secure: req.secure
  });
  audit(u.id, 'LOGIN', 'ok', req);
  res.json({ user: publicUser(userWithMeta(u.id)) });
});

app.post('/api/logout', (req, res) => {
  const t = req.cookies[COOKIE];
  if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/me/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword))
    return res.status(400).json({ error: 'Password must be 8+ characters with letters and numbers' });
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(currentPassword, row.password_hash))
    return res.status(401).json({ error: 'Current password is incorrect' });
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(bcrypt.hashSync(newPassword, 10), req.user.id);
  const t = req.cookies[COOKIE];
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, t || '');
  audit(req.user.id, 'PASSWORD_CHANGED', '', req);
  res.json({ ok: true });
});

/* ---------------- meta ---------------- */
app.get('/api/meta', requireAuth, (req, res) => {
  res.json({
    departments: db.prepare('SELECT id,code,name FROM departments WHERE active=1 ORDER BY name').all(),
    positions:   db.prepare('SELECT id,name,rank,department_id FROM positions WHERE active=1 ORDER BY department_id, rank').all()
  });
});

/* ---------------- departments ---------------- */
app.get('/api/departments', requireAuth, requireSuper, (_req, res) => {
  res.json({ departments: db.prepare(`
    SELECT d.*,
      (SELECT COUNT(*) FROM users u WHERE u.department_id=d.id) AS user_count,
      (SELECT COUNT(*) FROM files f WHERE f.department_id=d.id) AS file_count
    FROM departments d ORDER BY d.name
  `).all() });
});
app.post('/api/departments', requireAuth, requireSuper, (req, res) => {
  const { code, name } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'Code and name required' });
  if (!/^[A-Z0-9_-]{2,12}$/i.test(code)) return res.status(400).json({ error: 'Code must be 2-12 letters/digits' });
  if (db.prepare('SELECT id FROM departments WHERE code=? COLLATE NOCASE').get(code))
    return res.status(409).json({ error: 'Code already exists' });
  const id = db.prepare('INSERT INTO departments (code,name,active,created_at) VALUES (?,?,1,?)')
    .run(code.toUpperCase(), name.trim(), new Date().toISOString()).lastInsertRowid;
  audit(req.user.id, 'DEPT_CREATED', code, req);
  res.json({ id });
});
app.patch('/api/departments/:id', requireAuth, requireSuper, (req, res) => {
  const id = +req.params.id;
  if (!db.prepare('SELECT id FROM departments WHERE id=?').get(id)) return res.status(404).json({ error: 'Not found' });
  const { code, name, active } = req.body || {};
  const f = [], p = [];
  if (code)   { f.push('code = ?'); p.push(code.toUpperCase()); }
  if (name)   { f.push('name = ?'); p.push(name.trim()); }
  if (typeof active === 'boolean') { f.push('active = ?'); p.push(active ? 1 : 0); }
  if (!f.length) return res.json({ ok: true });
  p.push(id);
  db.prepare(`UPDATE departments SET ${f.join(', ')} WHERE id = ?`).run(...p);
  audit(req.user.id, 'DEPT_UPDATED', String(id), req);
  res.json({ ok: true });
});
app.delete('/api/departments/:id', requireAuth, requireSuper, (req, res) => {
  const id = +req.params.id;
  if (db.prepare('SELECT COUNT(*) c FROM users WHERE department_id=?').get(id).c > 0)
    return res.status(400).json({ error: 'Department has users' });
  if (db.prepare('SELECT COUNT(*) c FROM files WHERE department_id=?').get(id).c > 0)
    return res.status(400).json({ error: 'Department has files' });
  db.prepare('DELETE FROM departments WHERE id=?').run(id);
  audit(req.user.id, 'DEPT_DELETED', String(id), req);
  res.json({ ok: true });
});

/* ---------------- positions ---------------- */
app.get('/api/positions', requireAuth, requireSuper, (_req, res) => {
  res.json({ positions: db.prepare(`
    SELECT p.*, d.code AS department_code, d.name AS department_name,
      (SELECT COUNT(*) FROM users u WHERE u.position_id=p.id) AS user_count
    FROM positions p LEFT JOIN departments d ON d.id = p.department_id
    ORDER BY (p.department_id IS NULL) DESC, d.name, p.rank
  `).all() });
});
app.post('/api/positions', requireAuth, requireSuper, (req, res) => {
  const { name, rank, department_id } = req.body || {};
  if (!name || !rank) return res.status(400).json({ error: 'Name and rank required' });
  const dept = (department_id === null || department_id === '' || department_id === undefined) ? null : +department_id;
  if (dept !== null && !db.prepare('SELECT id FROM departments WHERE id=?').get(dept))
    return res.status(400).json({ error: 'Invalid department' });
  try {
    const id = db.prepare('INSERT INTO positions (name,rank,department_id,active,created_at) VALUES (?,?,?,1,?)')
      .run(name.trim(), +rank, dept, new Date().toISOString()).lastInsertRowid;
    audit(req.user.id, 'POS_CREATED', name, req);
    res.json({ id });
  } catch (e) { res.status(409).json({ error: 'Rank already used in this department' }); }
});
app.patch('/api/positions/:id', requireAuth, requireSuper, (req, res) => {
  const id = +req.params.id;
  if (!db.prepare('SELECT id FROM positions WHERE id=?').get(id)) return res.status(404).json({ error: 'Not found' });
  const { name, rank, active } = req.body || {};
  const f = [], p = [];
  if (name) f.push('name = ?'), p.push(name.trim());
  if (rank) f.push('rank = ?'), p.push(+rank);
  if (typeof active === 'boolean') f.push('active = ?'), p.push(active ? 1 : 0);
  if (!f.length) return res.json({ ok: true });
  p.push(id);
  try {
    db.prepare(`UPDATE positions SET ${f.join(', ')} WHERE id = ?`).run(...p);
    audit(req.user.id, 'POS_UPDATED', String(id), req);
    res.json({ ok: true });
  } catch (e) { res.status(409).json({ error: 'Rank conflict in this department' }); }
});
app.delete('/api/positions/:id', requireAuth, requireSuper, (req, res) => {
  const id = +req.params.id;
  if (db.prepare('SELECT COUNT(*) c FROM users WHERE position_id=?').get(id).c > 0)
    return res.status(400).json({ error: 'Position has users assigned' });
  db.prepare('DELETE FROM positions WHERE id=?').run(id);
  audit(req.user.id, 'POS_DELETED', String(id), req);
  res.json({ ok: true });
});

/* ---------------- users ---------------- */
app.get('/api/users', requireAuth, requireSuper, (_req, res) => {
  res.json({ users: db.prepare(`
    SELECT u.id, u.username, u.full_name, u.position_id, u.department_id,
           u.is_super_admin, u.active, u.must_change_password, u.created_at,
           p.name AS position_name, p.rank AS position_rank,
           d.code AS department_code, d.name AS department_name
    FROM users u
    JOIN positions p ON p.id = u.position_id
    LEFT JOIN departments d ON d.id = u.department_id
    ORDER BY d.name, p.rank, u.full_name
  `).all() });
});
app.post('/api/users', requireAuth, requireSuper, (req, res) => {
  const { username, password, full_name, position_id, is_super_admin } = req.body || {};
  if (!username || !password || !full_name || !position_id)
    return res.status(400).json({ error: 'All fields required' });
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password))
    return res.status(400).json({ error: 'Password must be 8+ characters with letters and numbers' });
  const pos = db.prepare('SELECT * FROM positions WHERE id=?').get(position_id);
  if (!pos) return res.status(400).json({ error: 'Invalid position' });
  if (db.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(username))
    return res.status(409).json({ error: 'Username already exists' });
  const id = db.prepare(`INSERT INTO users
    (username,password_hash,full_name,position_id,department_id,is_super_admin,active,must_change_password,created_at)
    VALUES (?,?,?,?,?,?,1,1,?)`)
    .run(username.trim(), bcrypt.hashSync(password, 10), full_name.trim(),
         pos.id, pos.department_id, is_super_admin ? 1 : 0, new Date().toISOString()).lastInsertRowid;
  audit(req.user.id, 'USER_CREATED', username, req);
  res.json({ id });
});
app.patch('/api/users/:id', requireAuth, requireSuper, (req, res) => {
  const id = +req.params.id;
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const { full_name, position_id, active, is_super_admin, password } = req.body || {};
  const f = [], p = [];
  if (full_name) { f.push('full_name = ?'); p.push(full_name.trim()); }
  if (position_id) {
    const pos = db.prepare('SELECT * FROM positions WHERE id=?').get(position_id);
    if (!pos) return res.status(400).json({ error: 'Invalid position' });
    f.push('position_id = ?'); p.push(pos.id);
    f.push('department_id = ?'); p.push(pos.department_id);
  }
  if (typeof active === 'boolean') {
    if (id === req.user.id && !active) return res.status(400).json({ error: 'Cannot disable yourself' });
    f.push('active = ?'); p.push(active ? 1 : 0);
  }
  if (typeof is_super_admin === 'boolean') {
    if (id === req.user.id && !is_super_admin) return res.status(400).json({ error: 'Cannot remove your own super admin' });
    f.push('is_super_admin = ?'); p.push(is_super_admin ? 1 : 0);
  }
  if (password) {
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password))
      return res.status(400).json({ error: 'Password must be 8+ characters with letters and numbers' });
    f.push('password_hash = ?'); p.push(bcrypt.hashSync(password, 10));
    f.push('must_change_password = 1');
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  }
  if (!f.length) return res.json({ ok: true });
  p.push(id);
  db.prepare(`UPDATE users SET ${f.join(', ')} WHERE id = ?`).run(...p);
  audit(req.user.id, 'USER_UPDATED', String(id), req);
  res.json({ ok: true });
});
app.delete('/api/users/:id', requireAuth, requireSuper, (req, res) => {
  const id = +req.params.id;
  if (id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  if (db.prepare('SELECT COUNT(*) c FROM files WHERE current_holder_id=?').get(id).c > 0)
    return res.status(400).json({ error: 'User currently holds files' });
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  audit(req.user.id, 'USER_DELETED', String(id), req);
  res.json({ ok: true });
});

/* ---------------- file helpers ---------------- */
function canView(user, file) {
  if (user.is_super_admin) return true;
  return !!db.prepare('SELECT 1 FROM file_participants WHERE file_id=? AND user_id=?')
    .get(file.id, user.id);
}
function addParticipant(fileId, userId) {
  db.prepare('INSERT OR IGNORE INTO file_participants (file_id,user_id,added_at) VALUES (?,?,?)')
    .run(fileId, userId, new Date().toISOString());
}

/* ---------------- files ---------------- */
app.get('/api/files', requireAuth, (req, res) => {
  const { q = '', status = 'all', scope = 'all' } = req.query;
  let sql = `
    SELECT f.*, u.full_name AS holder_name, p.name AS holder_position,
           d.code AS department_code, c.full_name AS creator_name
    FROM files f
    JOIN users u ON u.id = f.current_holder_id
    LEFT JOIN positions p ON p.id = u.position_id
    LEFT JOIN departments d ON d.id = f.department_id
    LEFT JOIN users c ON c.id = f.creator_id
    WHERE 1=1
  `;
  const p = [];
  if (!req.user.is_super_admin) {
    sql += ` AND f.id IN (SELECT file_id FROM file_participants WHERE user_id=?)`;
    p.push(req.user.id);
  }
  if (scope === 'holding') { sql += ` AND f.current_holder_id = ?`; p.push(req.user.id); }
  if (q) {
    sql += ` AND (f.ref_no LIKE ? OR f.subject LIKE ? OR IFNULL(f.description,'') LIKE ?)`;
    const like = '%' + q + '%'; p.push(like, like, like);
  }
  if (status !== 'all') { sql += ` AND f.status = ?`; p.push(status); }
  sql += ` ORDER BY datetime(f.updated_at) DESC`;
  res.json({ files: db.prepare(sql).all(...p) });
});

app.get('/api/files/:ref', requireAuth, (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE ref_no=? COLLATE NOCASE').get(req.params.ref);
  if (!f) return res.status(404).json({ error: 'File not found' });
  if (!canView(req.user, f)) return res.status(403).json({ error: 'You do not have access to this file' });
  const movements = db.prepare(`
    SELECT m.*, fu.full_name AS from_name, fp.name AS from_position,
                tu.full_name AS to_name, tp.name AS to_position
    FROM movements m
    LEFT JOIN users fu ON fu.id = m.from_user_id
    LEFT JOIN positions fp ON fp.id = fu.position_id
    JOIN users tu ON tu.id = m.to_user_id
    LEFT JOIN positions tp ON tp.id = tu.position_id
    WHERE m.file_id=?
    ORDER BY datetime(m.created_at) DESC, m.id DESC
  `).all(f.id);
  const holder = db.prepare(`
    SELECT u.id, u.full_name, u.username, p.name AS position_name, p.rank,
           d.code AS department_code
    FROM users u JOIN positions p ON p.id=u.position_id
    LEFT JOIN departments d ON d.id=u.department_id
    WHERE u.id=?
  `).get(f.current_holder_id);
  const creator = db.prepare('SELECT full_name FROM users WHERE id=?').get(f.creator_id);
  let chain = [];
  if (f.department_id) {
    chain = db.prepare(`SELECT id,name,rank FROM positions WHERE department_id=? ORDER BY rank`).all(f.department_id);
  } else {
    chain = db.prepare(`SELECT id,name,rank FROM positions WHERE department_id IS NULL ORDER BY rank`).all();
  }
  res.json({
    file: Object.assign({}, f, {
      holder_name: holder ? holder.full_name : '—',
      holder_position: holder ? holder.position_name : '—',
      holder_position_rank: holder ? holder.rank : 0,
      creator_name: creator ? creator.full_name : '—',
      department_code: holder ? holder.department_code : null
    }),
    movements,
    chain,
    can_move: (req.user.is_super_admin || f.current_holder_id === req.user.id) && f.status === 'Open'
  });
});

app.get('/api/next-ref', requireAuth, (_req, res) => {
  const y = new Date().getFullYear();
  const r = db.prepare('SELECT value FROM counters WHERE year=?').get(y);
  res.json({ ref: `FTS-${y}-${String((r ? r.value : 0) + 1).padStart(4, '0')}` });
});

app.post('/api/files', requireAuth, (req, res) => {
  const { refNo, subject, description = '', priority = 'Normal', dueDate = '' } = req.body || {};
  if (!refNo || !subject) return res.status(400).json({ error: 'Reference and subject required' });
  if (db.prepare('SELECT id FROM files WHERE ref_no=? COLLATE NOCASE').get(refNo))
    return res.status(409).json({ error: 'Reference number already exists' });
  const now = new Date().toISOString();
  try {
    const fid = db.prepare(`INSERT INTO files
      (ref_no,subject,description,priority,status,department_id,creator_id,current_holder_id,due_date,created_at,updated_at)
      VALUES (?,?,?,?, 'Open', ?,?,?,?,?,?)`)
      .run(refNo, subject.trim(), description, priority,
           req.user.department_id, req.user.id, req.user.id, dueDate, now, now).lastInsertRowid;
    addParticipant(fid, req.user.id);
    db.prepare(`INSERT INTO movements (file_id,action,from_user_id,to_user_id,remarks,created_at)
      VALUES (?,?,?,?,?,?)`).run(fid, 'Created', null, req.user.id, 'File registered.', now);
    const m = /^FTS-(\d{4})-(\d+)$/i.exec(refNo);
    if (m) {
      const yr = +m[1], num = +m[2];
      const cur = db.prepare('SELECT value FROM counters WHERE year=?').get(yr);
      if (!cur) db.prepare('INSERT INTO counters (year,value) VALUES (?,?)').run(yr, num);
      else if (cur.value < num) db.prepare('UPDATE counters SET value=? WHERE year=?').run(num, yr);
    }
    audit(req.user.id, 'FILE_CREATED', refNo, req);
    res.json({ ok: true, refNo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---------- targets (forward / return) ---------- */
app.get('/api/files/:ref/targets', requireAuth, (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE ref_no=? COLLATE NOCASE').get(req.params.ref);
  if (!f) return res.status(404).json({ error: 'Not found' });
  if (!canView(req.user, f)) return res.status(403).json({ error: 'No access' });
  if (f.current_holder_id !== req.user.id && !req.user.is_super_admin)
    return res.status(403).json({ error: 'You do not hold this file' });

  const me = req.user;

  const forward = db.prepare(`
    SELECT u.id, u.full_name, u.username,
           p.name AS position_name, p.rank,
           d.id   AS department_id,
           d.code AS department_code, d.name AS department_name
    FROM users u
    JOIN positions p ON p.id = u.position_id
    LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.active=1 AND u.id != ?
    ORDER BY (d.id IS NULL) DESC, d.name, p.rank, u.full_name
  `).all(me.id);

  const back = db.prepare(`
    SELECT u.id, u.full_name, u.username,
           p.name AS position_name,
           d.id   AS department_id,
           d.code AS department_code, d.name AS department_name,
           (SELECT MAX(m2.created_at) FROM movements m2
            WHERE m2.file_id = m.file_id AND m2.to_user_id = u.id) AS last_held
    FROM movements m
    JOIN users u ON u.id = m.to_user_id
    LEFT JOIN positions p ON p.id = u.position_id
    LEFT JOIN departments d ON d.id = u.department_id
    WHERE m.file_id=? AND u.id != ? AND u.active=1 AND m.action != 'Remark'
    GROUP BY u.id
    ORDER BY last_held DESC
  `).all(f.id, me.id);

  res.json({ forward, return: back });
});

/* ---------- move ---------- */
app.post('/api/files/:ref/move', requireAuth, (req, res) => {
  const { toUserId, action = 'Forwarded', remarks = '' } = req.body || {};
  if (!toUserId) return res.status(400).json({ error: 'Target user required' });
  if (!['Forwarded', 'Returned'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  const f = db.prepare('SELECT * FROM files WHERE ref_no=? COLLATE NOCASE').get(req.params.ref);
  if (!f) return res.status(404).json({ error: 'Not found' });
  if (f.status !== 'Open') return res.status(400).json({ error: 'File is closed' });
  if (f.current_holder_id !== req.user.id && !req.user.is_super_admin)
    return res.status(403).json({ error: 'You do not hold this file' });

  const target = db.prepare(`
    SELECT u.*, p.rank AS position_rank FROM users u
    JOIN positions p ON p.id = u.position_id
    WHERE u.id=? AND u.active=1
  `).get(toUserId);
  if (!target) return res.status(400).json({ error: 'Target user not found or inactive' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Cannot move to yourself' });

  if (action === 'Returned') {
    const prev = db.prepare('SELECT 1 FROM movements WHERE file_id=? AND to_user_id=? LIMIT 1')
      .get(f.id, target.id);
    if (!prev) return res.status(403).json({ error: 'Can only return to a previous holder' });
  }

  const now = new Date().toISOString();
  db.transaction(() => {
    const newDept = f.department_id || target.department_id || null;
    db.prepare('UPDATE files SET current_holder_id=?, department_id=?, updated_at=? WHERE id=?')
      .run(target.id, newDept, now, f.id);
    db.prepare(`INSERT INTO movements (file_id,action,from_user_id,to_user_id,remarks,created_at)
      VALUES (?,?,?,?,?,?)`).run(f.id, action, req.user.id, target.id, remarks, now);
    addParticipant(f.id, target.id);
  })();
  audit(req.user.id, 'FILE_MOVED', `${f.ref_no} ${action} -> user#${target.id}`, req);
  res.json({ ok: true });
});

app.post('/api/files/:ref/remark', requireAuth, (req, res) => {
  const remarks = (req.body?.remarks || '').trim();
  if (!remarks) return res.status(400).json({ error: 'Remark required' });
  const f = db.prepare('SELECT * FROM files WHERE ref_no=? COLLATE NOCASE').get(req.params.ref);
  if (!f) return res.status(404).json({ error: 'Not found' });
  if (!canView(req.user, f)) return res.status(403).json({ error: 'No access' });
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`INSERT INTO movements (file_id,action,from_user_id,to_user_id,remarks,created_at)
      VALUES (?,?,?,?,?,?)`).run(f.id, 'Remark', req.user.id, req.user.id, remarks, now);
    db.prepare('UPDATE files SET updated_at=? WHERE id=?').run(now, f.id);
  })();
  res.json({ ok: true });
});

/* ---------- status ---------- */
app.post('/api/files/:ref/status', requireAuth, (req, res) => {
  const { status, remarks = '' } = req.body || {};
  if (!['Open', 'Closed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const f = db.prepare('SELECT * FROM files WHERE ref_no=? COLLATE NOCASE').get(req.params.ref);
  if (!f) return res.status(404).json({ error: 'Not found' });
  if (f.current_holder_id !== req.user.id && !req.user.is_super_admin)
    return res.status(403).json({ error: 'Only the holder or super admin can change status' });
  const now = new Date().toISOString();
  const clean = String(remarks || '').slice(0, 2000).trim();
  db.transaction(() => {
    db.prepare('UPDATE files SET status=?, updated_at=? WHERE id=?').run(status, now, f.id);
    db.prepare(`INSERT INTO movements (file_id,action,from_user_id,to_user_id,remarks,created_at)
      VALUES (?,?,?,?,?,?)`).run(f.id, status === 'Closed' ? 'Closed' : 'Reopened',
        req.user.id, req.user.id, clean, now);
  })();
  audit(req.user.id, 'FILE_STATUS', `${f.ref_no} -> ${status}`, req);
  res.json({ ok: true });
});

app.delete('/api/files/:ref', requireAuth, requireSuper, (req, res) => {
  const f = db.prepare('SELECT id FROM files WHERE ref_no=? COLLATE NOCASE').get(req.params.ref);
  if (!f) return res.status(404).json({ error: 'Not found' });
  // Remove attachment files from disk (DB rows cascade)
  const rows = db.prepare('SELECT stored_name FROM attachments WHERE file_id=?').all(f.id);
  db.prepare('DELETE FROM files WHERE id=?').run(f.id);
  for (const r of rows) fs.unlink(path.join(UPLOAD_DIR, r.stored_name), () => {});
  audit(req.user.id, 'FILE_DELETED', req.params.ref, req);
  res.json({ ok: true });
});

/* ---------------- attachments ---------------- */
app.get('/api/files/:ref/attachments', requireAuth, (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE ref_no=? COLLATE NOCASE').get(req.params.ref);
  if (!f) return res.status(404).json({ error: 'File not found' });
  if (!canView(req.user, f)) return res.status(403).json({ error: 'No access' });

  const rows = db.prepare(`
    SELECT a.id, a.orig_name, a.mime_type, a.size_bytes, a.created_at,
           u.full_name AS uploader_name, a.uploaded_by
    FROM attachments a
    JOIN users u ON u.id = a.uploaded_by
    WHERE a.file_id = ?
    ORDER BY datetime(a.created_at) DESC
  `).all(f.id);

  res.json({
    attachments: rows.map(r => ({
      ...r,
      can_delete: req.user.is_super_admin || r.uploaded_by === req.user.id
    }))
  });
});

app.post('/api/files/:ref/attachments', requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 15 MB)' : err.message;
      return res.status(400).json({ error: msg });
    }
    try {
      const f = db.prepare('SELECT * FROM files WHERE ref_no=? COLLATE NOCASE').get(req.params.ref);
      if (!f) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(404).json({ error: 'File not found' }); }
      if (!canView(req.user, f)) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(403).json({ error: 'No access' }); }
      if (f.status !== 'Open') { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'File is closed' }); }
      if (f.current_holder_id !== req.user.id && !req.user.is_super_admin) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(403).json({ error: 'Only the current holder or super admin can upload' });
      }
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const now = new Date().toISOString();
      const id = db.prepare(`
        INSERT INTO attachments (file_id, uploaded_by, orig_name, stored_name, mime_type, size_bytes, created_at)
        VALUES (?,?,?,?,?,?,?)
      `).run(f.id, req.user.id, req.file.originalname, req.file.filename,
             req.file.mimetype, req.file.size, now).lastInsertRowid;

      db.prepare(`
        INSERT INTO movements (file_id, action, from_user_id, to_user_id, remarks, created_at)
        VALUES (?,?,?,?,?,?)
      `).run(f.id, 'Attachment', req.user.id, req.user.id,
             `Uploaded “${req.file.originalname}”`, now);

      db.prepare('UPDATE files SET updated_at=? WHERE id=?').run(now, f.id);
      audit(req.user.id, 'ATTACHMENT_ADDED', `${f.ref_no}: ${req.file.originalname}`, req);
      res.json({ ok: true, id });
    } catch (e) {
      if (req.file) fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: e.message });
    }
  });
});

app.get('/api/files/:ref/attachments/:id', requireAuth, (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE ref_no=? COLLATE NOCASE').get(req.params.ref);
  if (!f) return res.status(404).send('File not found');
  if (!canView(req.user, f)) return res.status(403).send('No access');

  const a = db.prepare('SELECT * FROM attachments WHERE id=? AND file_id=?')
    .get(+req.params.id, f.id);
  if (!a) return res.status(404).send('Attachment not found');

  const full = path.join(UPLOAD_DIR, a.stored_name);
  if (!fs.existsSync(full)) return res.status(404).send('File missing on disk');

  res.setHeader('Content-Type', a.mime_type);
  res.setHeader('Content-Disposition',
    `attachment; filename="${a.orig_name.replace(/["\\]/g, '_')}"`);
  fs.createReadStream(full).pipe(res);
});

app.delete('/api/files/:ref/attachments/:id', requireAuth, (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE ref_no=? COLLATE NOCASE').get(req.params.ref);
  if (!f) return res.status(404).json({ error: 'File not found' });
  if (!canView(req.user, f)) return res.status(403).json({ error: 'No access' });

  const a = db.prepare('SELECT * FROM attachments WHERE id=? AND file_id=?')
    .get(+req.params.id, f.id);
  if (!a) return res.status(404).json({ error: 'Attachment not found' });

  if (!(req.user.is_super_admin || a.uploaded_by === req.user.id))
    return res.status(403).json({ error: 'You cannot delete this attachment' });

  db.prepare('DELETE FROM attachments WHERE id=?').run(a.id);
  fs.unlink(path.join(UPLOAD_DIR, a.stored_name), () => {});
  audit(req.user.id, 'ATTACHMENT_DELETED', `${f.ref_no}: ${a.orig_name}`, req);
  res.json({ ok: true });
});

/* ---------------- QR image ---------------- */
app.get('/api/files/:ref/qr.png', requireAuth, async (req, res) => {
  const f = db.prepare('SELECT id,ref_no FROM files WHERE ref_no=? COLLATE NOCASE').get(req.params.ref);
  if (!f) return res.status(404).send('Not found');
  if (!canView(req.user, f)) return res.status(403).send('No access');
  const mode = req.query.mode === 'ref' ? 'ref' : 'url';
  const size = Math.min(1200, Math.max(100, parseInt(req.query.size, 10) || 400));
  let text;
  if (mode === 'ref') text = f.ref_no;
  else {
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host  = req.headers['x-forwarded-host']  || req.get('host');
    text = `${proto}://${host}/#/file/${encodeURIComponent(f.ref_no)}`;
  }
  try {
    const buf = await QRCode.toBuffer(text, {
      width: size, margin: 2, errorCorrectionLevel: 'M',
      color: { dark: '#0f172a', light: '#ffffff' }
    });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'private, max-age=300');
    res.send(buf);
  } catch (e) { res.status(500).send('QR generation failed'); }
});

/* ---------------- dashboard ---------------- */
app.get('/api/dashboard', requireAuth, (req, res) => {
  const uid = req.user.id;
  const isSuper = req.user.is_super_admin;
  const stats = isSuper
    ? db.prepare(`SELECT
        (SELECT COUNT(*) FROM files) AS total,
        (SELECT COUNT(*) FROM files WHERE status='Open') AS open,
        (SELECT COUNT(*) FROM files WHERE status='Closed') AS closed,
        (SELECT COUNT(*) FROM files WHERE status='Open' AND priority!='Normal') AS urgent,
        (SELECT COUNT(*) FROM files WHERE status='Open' AND current_holder_id=?) AS mine`
      ).get(uid)
    : db.prepare(`SELECT
        (SELECT COUNT(*) FROM files f JOIN file_participants fp ON fp.file_id=f.id WHERE fp.user_id=?) AS total,
        (SELECT COUNT(*) FROM files f JOIN file_participants fp ON fp.file_id=f.id WHERE fp.user_id=? AND f.status='Open') AS open,
        (SELECT COUNT(*) FROM files f JOIN file_participants fp ON fp.file_id=f.id WHERE fp.user_id=? AND f.status='Closed') AS closed,
        (SELECT COUNT(*) FROM files f JOIN file_participants fp ON fp.file_id=f.id WHERE fp.user_id=? AND f.status='Open' AND f.priority!='Normal') AS urgent,
        (SELECT COUNT(*) FROM files WHERE status='Open' AND current_holder_id=?) AS mine`
      ).get(uid, uid, uid, uid, uid);

  const myFiles = db.prepare(`
    SELECT f.*, u.full_name AS holder_name, p.name AS holder_position
    FROM files f JOIN users u ON u.id=f.current_holder_id
    LEFT JOIN positions p ON p.id=u.position_id
    WHERE f.status='Open' AND f.current_holder_id=?
    ORDER BY datetime(f.updated_at) DESC LIMIT 10
  `).all(uid);

  const recent = isSuper
    ? db.prepare(`SELECT m.*, f.ref_no, u.full_name AS actor
        FROM movements m JOIN files f ON f.id=m.file_id
        LEFT JOIN users u ON u.id=m.from_user_id
        ORDER BY datetime(m.created_at) DESC, m.id DESC LIMIT 12`).all()
    : db.prepare(`SELECT m.*, f.ref_no, u.full_name AS actor
        FROM movements m JOIN files f ON f.id=m.file_id
        LEFT JOIN users u ON u.id=m.from_user_id
        WHERE f.id IN (SELECT file_id FROM file_participants WHERE user_id=?)
        ORDER BY datetime(m.created_at) DESC, m.id DESC LIMIT 12`).all(uid);

  const byLevel = isSuper
    ? db.prepare(`SELECT p.name AS position_name, d.code AS department_code, COUNT(f.id) AS c
        FROM positions p
        LEFT JOIN files f ON f.current_holder_id IN (SELECT id FROM users WHERE position_id=p.id) AND f.status='Open'
        LEFT JOIN departments d ON d.id=p.department_id
        GROUP BY p.id HAVING c>0 ORDER BY d.name, p.rank`).all()
    : db.prepare(`SELECT p.name AS position_name, d.code AS department_code, COUNT(f.id) AS c
        FROM positions p
        LEFT JOIN files f ON f.current_holder_id IN (SELECT id FROM users WHERE position_id=p.id) AND f.status='Open'
        LEFT JOIN departments d ON d.id=p.department_id
        WHERE p.department_id = ? OR p.department_id IS NULL
        GROUP BY p.id HAVING c>0 ORDER BY p.rank`).all(req.user.department_id);

  res.json({ stats, myFiles, recent, byLevel });
});

/* ---------------- SPA fallback + errors ---------------- */
app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

/* multer / upload error → JSON */
app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 15 MB)' : err.message;
    return res.status(400).json({ error: msg });
  }
  if (err && /not allowed/i.test(err.message || '')) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

/* ---------------- cleanup + start ---------------- */
db.prepare("DELETE FROM sessions WHERE datetime(expires_at) < datetime('now')").run();

app.listen(PORT, () => {
  console.log(`\n  🗂  FileTrack running at http://localhost:${PORT}`);
  console.log(`  🔑 Default super admin → admin / Admin@123\n`);
});