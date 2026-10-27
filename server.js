'use strict';
const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3100;
const TZ = 'Pacific/Auckland';
const BRAND = 'Harcourts TGB Group';
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'data.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'agent', active INTEGER NOT NULL DEFAULT 1,
  must_change INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS entries(user_id INTEGER NOT NULL, week_start TEXT NOT NULL,
  door_knocks INTEGER NOT NULL DEFAULT 0, cold_calls INTEGER NOT NULL DEFAULT 0,
  appr_booked INTEGER NOT NULL DEFAULT 0, appr_done INTEGER NOT NULL DEFAULT 0,
  status TEXT DEFAULT '', status_day TEXT DEFAULT '', pipeline_count INTEGER NOT NULL DEFAULT 0, pipeline_note TEXT DEFAULT '',
  last_day TEXT DEFAULT '', updated_at TEXT, PRIMARY KEY(user_id, week_start));
CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY, user_id INTEGER, day TEXT, ts TEXT, field TEXT, value TEXT);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
`);

const METRICS = ['door_knocks', 'cold_calls', 'appr_booked', 'appr_done'];
const LABELS = { door_knocks: 'Door knocks', cold_calls: 'Cold calls', appr_booked: 'Appraisals booked', appr_done: 'Appraisals done' };
const getSetting = k => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
if (!getSetting('tv_key')) setSetting('tv_key', crypto.randomBytes(12).toString('base64url'));
if (!getSetting('targets')) setSetting('targets', JSON.stringify({ door_knocks: 1000, cold_calls: 1500, appr_booked: 40, appr_done: 30 }));

// Admin bootstrap
const ADMIN_EMAIL = 'gary.bal@harcourts.co.nz';
if (!db.prepare('SELECT 1 FROM users WHERE email=?').get(ADMIN_EMAIL)) {
  const pw = process.env.ADMIN_INITIAL_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO users(name,email,pass_hash,role,must_change) VALUES(?,?,?,'admin',1)").run('Gary Bal', ADMIN_EMAIL, bcrypt.hashSync(pw, 10));
  fs.writeFileSync(path.join(DATA_DIR, 'ADMIN_PASSWORD.txt'), `Admin login: ${ADMIN_EMAIL}\nTemporary password: ${pw}\n`, { mode: 0o600 });
}

// ---- NZ date helpers ----
function nzDay(d = new Date()) { // YYYY-MM-DD in NZ
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function weekStartOf(day) { // Monday of the week containing day (YYYY-MM-DD)
  const [y, m, dd] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, dd));
  const dow = (dt.getUTCDay() + 6) % 7; // Mon=0
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}
function addDays(day, n) { const [y, m, d] = day.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d + n)); return dt.toISOString().slice(0, 10); }
const thisWeek = () => weekStartOf(nzDay());
const validWeek = w => (typeof w === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(w)) ? weekStartOf(w) : thisWeek();

function ensureEntry(uid, week) {
  let e = db.prepare('SELECT * FROM entries WHERE user_id=? AND week_start=?').get(uid, week);
  if (!e) {
    const prev = db.prepare('SELECT pipeline_count, pipeline_note FROM entries WHERE user_id=? AND week_start<? ORDER BY week_start DESC LIMIT 1').get(uid, week);
    db.prepare('INSERT INTO entries(user_id,week_start,pipeline_count,pipeline_note) VALUES(?,?,?,?)').run(uid, week, prev ? prev.pipeline_count : 0, prev ? prev.pipeline_note : '');
    e = db.prepare('SELECT * FROM entries WHERE user_id=? AND week_start=?').get(uid, week);
  }
  return e;
}
const hasNumbers = e => !!e && (METRICS.some(m => e[m] > 0) || !!e.last_day);

// ---- app ----
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use(cookieParser());
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'no-referrer'); next(); });

const SESSION_DAYS = 180;
function auth(req) {
  const t = req.cookies.sid; if (!t) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token=?').get(t);
  if (!s || s.expires < Date.now()) return null;
  const u = db.prepare('SELECT id,name,email,role,active,must_change FROM users WHERE id=?').get(s.user_id);
  if (!u || !u.active) return null;
  return u;
}
const requireUser = (req, res, next) => { const u = auth(req); if (!u) return res.status(401).json({ error: 'Not signed in' }); req.user = u; next(); };
const requireAdmin = (req, res, next) => { const u = auth(req); if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Admin only' }); req.user = u; next(); };
// Basic CSRF guard: state-changing API calls must be JSON (forms from other sites can't send that cross-origin without CORS)
app.use('/api', (req, res, next) => { if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'JSON required' }); next(); });

const attempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip; const now = Date.now();
  const a = (attempts.get(ip) || []).filter(t => now - t < 15 * 60e3);
  if (a.length >= 20) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').trim());
  if (!u || !u.active || !bcrypt.compareSync(String(password || ''), u.pass_hash)) { a.push(now); attempts.set(ip, a); return res.status(401).json({ error: 'Wrong email or password' }); }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, u.id, now + SESSION_DAYS * 864e5);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 864e5, path: '/' });
  res.json({ ok: true, role: u.role, must_change: !!u.must_change });
});
app.post('/api/logout', (req, res) => { if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token=?').run(req.cookies.sid); res.clearCookie('sid', { path: '/' }); res.json({ ok: true }); });
app.post('/api/password', requireUser, (req, res) => {
  const { current, next: nw } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(String(current || ''), u.pass_hash)) return res.status(400).json({ error: 'Current password is wrong' });
  if (String(nw || '').length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  db.prepare('UPDATE users SET pass_hash=?, must_change=0 WHERE id=?').run(bcrypt.hashSync(String(nw), 10), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(u.id, req.cookies.sid);
  res.json({ ok: true });
});

function teamData(week) {
  const today = nzDay(); const cur = thisWeek();
  const agents = db.prepare("SELECT id,name FROM users WHERE role='agent' AND active=1 ORDER BY name").all();
  const rows = agents.map(a => {
    const e = db.prepare('SELECT * FROM entries WHERE user_id=? AND week_start=?').get(a.id, week) || {};
    const r = { id: a.id, name: a.name, entered: hasNumbers(e) };
    METRICS.forEach(m => r[m] = e[m] || 0);
    r.pipeline_count = e.pipeline_count || 0; r.pipeline_note = e.pipeline_note || '';
    r.working_today = week === cur && e.last_day === today;
    r.status = (week === cur && e.status_day === today) ? (e.status || '') : '';
    r.updated_at = e.updated_at || null;
    r.score = r.door_knocks + r.cold_calls + r.appr_booked * 20 + r.appr_done * 30;
    return r;
  });
  const totals = {}; METRICS.forEach(m => totals[m] = rows.reduce((s, r) => s + r[m], 0));
  totals.pipeline_count = rows.reduce((s, r) => s + r.pipeline_count, 0);
  return { brand: BRAND, week, week_end: addDays(week, 6), today, rows, totals, targets: JSON.parse(getSetting('targets')),
    entered_count: rows.filter(r => r.entered).length, agent_count: rows.length, labels: LABELS };
}

// --- agent ---
app.get('/api/me', requireUser, (req, res) => {
  const w = thisWeek(); const e = ensureEntry(req.user.id, w); const t = teamData(w);
  const today = nzDay();
  res.json({ user: req.user, entry: { ...e, status: e.status_day === today ? e.status : '', working_today: e.last_day === today }, team: { totals: t.totals, targets: t.targets, entered_count: t.entered_count, agent_count: t.agent_count, week: w, week_end: t.week_end }, labels: LABELS });
});
function touch(uid, week, field, value) {
  const today = nzDay();
  db.prepare("UPDATE entries SET last_day=?, updated_at=datetime('now') WHERE user_id=? AND week_start=?").run(today, uid, week);
  db.prepare("INSERT INTO activity(user_id,day,ts,field,value) VALUES(?,?,datetime('now'),?,?)").run(uid, today, field, String(value).slice(0, 200));
}
app.post('/api/me/inc', requireUser, (req, res) => {
  const { field } = req.body || {}; const delta = Number((req.body || {}).delta) || 1;
  if (!METRICS.includes(field) || Math.abs(delta) > 100) return res.status(400).json({ error: 'Bad field' });
  const w = thisWeek(); ensureEntry(req.user.id, w);
  db.prepare(`UPDATE entries SET ${field}=MAX(0, ${field}+?) WHERE user_id=? AND week_start=?`).run(delta, req.user.id, w);
  touch(req.user.id, w, field, delta);
  res.json({ ok: true, entry: db.prepare('SELECT * FROM entries WHERE user_id=? AND week_start=?').get(req.user.id, w) });
});
app.post('/api/me/entry', requireUser, (req, res) => {
  const b = req.body || {}; const w = thisWeek(); ensureEntry(req.user.id, w);
  const sets = [], vals = [];
  for (const m of [...METRICS, 'pipeline_count']) if (b[m] !== undefined) { const n = Math.max(0, Math.min(100000, parseInt(b[m], 10) || 0)); sets.push(`${m}=?`); vals.push(n); }
  if (b.pipeline_note !== undefined) { sets.push('pipeline_note=?'); vals.push(String(b.pipeline_note).slice(0, 300)); }
  if (b.status !== undefined) { sets.push('status=?', 'status_day=?'); vals.push(String(b.status).slice(0, 120), nzDay()); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to save' });
  db.prepare(`UPDATE entries SET ${sets.join(',')} WHERE user_id=? AND week_start=?`).run(...vals, req.user.id, w);
  touch(req.user.id, w, 'save', JSON.stringify(b).slice(0, 200));
  res.json({ ok: true });
});
app.get('/api/me/history', requireUser, (req, res) => {
  res.json(db.prepare('SELECT * FROM entries WHERE user_id=? ORDER BY week_start DESC LIMIT 26').all(req.user.id));
});

// --- TV (token) ---
app.get('/api/tv', (req, res) => {
  if (!req.query.key || req.query.key !== getSetting('tv_key')) return res.status(403).json({ error: 'Bad key' });
  const t = teamData(thisWeek());
  // TV shows team totals, status board and leaderboard only (no history)
  t.rows = t.rows.map(r => ({ name: r.name, entered: r.entered, working_today: r.working_today, status: r.status, pipeline_count: r.pipeline_count, door_knocks: r.door_knocks, cold_calls: r.cold_calls, appr_booked: r.appr_booked, appr_done: r.appr_done, score: r.score }));
  res.set('Cache-Control', 'no-store'); res.json(t);
});

// --- admin ---
app.get('/api/admin/summary', requireAdmin, (req, res) => {
  const w = validWeek(req.query.week); const cur = teamData(w); const prev = teamData(addDays(w, -7));
  const weeks = db.prepare('SELECT DISTINCT week_start FROM entries ORDER BY week_start DESC LIMIT 104').all().map(r => r.week_start);
  if (!weeks.includes(thisWeek())) weeks.unshift(thisWeek());
  const prevBy = Object.fromEntries(prev.rows.map(r => [r.id, r]));
  cur.rows.forEach(r => { const p = prevBy[r.id] || {}; r.last = {}; METRICS.forEach(m => r.last[m] = p[m] || 0); });
  res.json({ ...cur, last_totals: prev.totals, last_week: prev.week, weeks, tv_key: getSetting('tv_key'), missing: cur.rows.filter(r => !r.entered).map(r => r.name), me: { id: req.user.id, must_change: !!req.user.must_change } });
});
app.get('/api/admin/users', requireAdmin, (req, res) => res.json(db.prepare('SELECT id,name,email,role,active,must_change,created_at FROM users ORDER BY role, name').all()));
function httpError(status, error) { const e = new Error(error); e.status = status; return e; }
function assertKeepsActiveAdmin(u) {
  if (!u || u.role !== 'admin' || !u.active) return;
  const others = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1 AND id!=?").get(u.id).n;
  if (others < 1) throw httpError(400, 'There must be at least one active admin');
}
app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { name, email, password, role } = req.body || {};
  const nextRole = role == null ? 'agent' : role;
  if (nextRole !== 'agent' && nextRole !== 'admin') return res.status(400).json({ error: 'Role must be agent or admin' });
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || ''))) return res.status(400).json({ error: 'Name and a valid email are needed' });
  if (String(password || '').length < 6) return res.status(400).json({ error: 'Temporary password must be at least 6 characters' });
  try { const r = db.prepare('INSERT INTO users(name,email,pass_hash,role,must_change) VALUES(?,?,?,?,1)').run(String(name).trim().slice(0, 80), String(email).trim(), bcrypt.hashSync(String(password), 10), nextRole); res.json({ ok: true, id: r.lastInsertRowid }); }
  catch (e) { res.status(400).json({ error: 'That email already has an account' }); }
});
app.post('/api/admin/users/:id/reset', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === Number(req.user.id)) return res.status(400).json({ error: "You can't reset your own password here" });
  const pw = String((req.body || {}).password || ''); if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const u = db.prepare('SELECT id FROM users WHERE id=?').get(id); if (!u) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE users SET pass_hash=?, must_change=1 WHERE id=?').run(bcrypt.hashSync(pw, 10), id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); res.json({ ok: true });
});
app.post('/api/admin/users/:id/active', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const active = (req.body || {}).active ? 1 : 0;
  try {
    db.transaction(() => {
      const u = db.prepare('SELECT id, role, active FROM users WHERE id=?').get(id);
      if (!u) throw httpError(404, 'Not found');
      if (!active) assertKeepsActiveAdmin(u);
      if (id === Number(req.user.id)) throw httpError(400, "You can't deactivate yourself");
      db.prepare('UPDATE users SET active=? WHERE id=?').run(active, id);
      if (!active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    }).immediate();
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); throw e; }
  res.json({ ok: true });
});
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  try {
    db.transaction(() => {
      const u = db.prepare('SELECT id, role, active FROM users WHERE id=?').get(id);
      if (!u) throw httpError(404, 'Not found');
      assertKeepsActiveAdmin(u);
      if (id === Number(req.user.id)) throw httpError(400, "You can't delete yourself");
      ['sessions', 'entries', 'activity'].forEach(t => db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(id));
      db.prepare('DELETE FROM users WHERE id=?').run(id);
    }).immediate();
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); throw e; }
  res.json({ ok: true });
});
app.get('/api/admin/agent/:id/history', requireAdmin, (req, res) => res.json(db.prepare('SELECT * FROM entries WHERE user_id=? ORDER BY week_start DESC LIMIT 52').all(req.params.id)));
app.post('/api/admin/targets', requireAdmin, (req, res) => {
  const t = {}; METRICS.forEach(m => t[m] = Math.max(0, parseInt((req.body || {})[m], 10) || 0)); setSetting('targets', JSON.stringify(t)); res.json({ ok: true, targets: t });
});
app.post('/api/admin/tvkey', requireAdmin, (req, res) => { const k = crypto.randomBytes(12).toString('base64url'); setSetting('tv_key', k); res.json({ ok: true, tv_key: k }); });
app.get('/api/admin/export.csv', requireAdmin, (req, res) => {
  const all = req.query.all === '1';
  const rows = all ? db.prepare("SELECT e.*, u.name, u.email FROM entries e JOIN users u ON u.id=e.user_id WHERE u.role='agent' ORDER BY e.week_start DESC, u.name").all()
    : db.prepare("SELECT e.*, u.name, u.email FROM entries e JOIN users u ON u.id=e.user_id WHERE u.role='agent' AND e.week_start=? ORDER BY u.name").all(validWeek(req.query.week));
  const esc = v => { v = v == null ? '' : String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const head = ['week_start', 'name', 'email', ...METRICS, 'pipeline_count', 'pipeline_note', 'status', 'updated_at'];
  const csv = [head.join(','), ...rows.map(r => head.map(h => esc(r[h])).join(','))].join('\n');
  res.set('Content-Type', 'text/csv'); res.set('Content-Disposition', `attachment; filename="tgb-team-numbers-${all ? 'all' : validWeek(req.query.week)}.csv"`); res.send(csv);
});

// --- pages ---
const page = f => (req, res) => res.sendFile(path.join(__dirname, 'public', f));
app.get('/', (req, res) => { const u = auth(req); if (!u) return res.redirect('/login'); res.redirect(u.role === 'admin' ? '/admin' : '/me'); });
app.get('/login', page('login.html'));
app.get('/me', (req, res) => auth(req) ? page('agent.html')(req, res) : res.redirect('/login'));
app.get('/admin', (req, res) => { const u = auth(req); if (!u) return res.redirect('/login'); if (u.role !== 'admin') return res.redirect('/me'); page('admin.html')(req, res); });
app.get('/tv', page('tv.html'));
app.use('/static', express.static(path.join(__dirname, 'public', 'static'), { maxAge: '1h' }));
app.get('/healthz', (req, res) => res.json({ ok: true }));

setInterval(() => db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now()), 36e5).unref();
app.listen(PORT, () => console.log(`${BRAND} dashboard on :${PORT}`));
