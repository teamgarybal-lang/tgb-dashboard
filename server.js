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
const DAY_WINDOW = 14; // today plus the previous 13 days can be filled in or corrected
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
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
CREATE TABLE IF NOT EXISTS day_entries(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  door_knocks INTEGER NOT NULL DEFAULT 0,
  cold_calls INTEGER NOT NULL DEFAULT 0,
  appr_booked INTEGER NOT NULL DEFAULT 0,
  appr_done INTEGER NOT NULL DEFAULT 0,
  letter_drops INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY(user_id, day));
CREATE TABLE IF NOT EXISTS weekly_metric_migration(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  PRIMARY KEY(user_id, week_start));
CREATE INDEX IF NOT EXISTS day_entries_day ON day_entries(day);
`);

// Entry order on every screen. Score = appr_done*30 + appr_booked*20 + cold_calls + door_knocks + letter_drops.
const METRICS = ['appr_done', 'appr_booked', 'cold_calls', 'door_knocks', 'letter_drops'];
const LABELS = { appr_done: 'Appraisals done', appr_booked: 'Appraisals booked', cold_calls: 'Cold calls', door_knocks: 'Door knocks', letter_drops: 'Letter / flyer drops' };
const DEFAULT_TARGETS = { appr_done: 30, appr_booked: 40, cold_calls: 1500, door_knocks: 1000, letter_drops: 500 };
const getSetting = k => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);
if (!getSetting('tv_key')) setSetting('tv_key', crypto.randomBytes(12).toString('base64url'));
if (!getSetting('targets')) setSetting('targets', JSON.stringify(DEFAULT_TARGETS));
else {
  const t = JSON.parse(getSetting('targets'));
  let changed = false;
  for (const m of METRICS) if (t[m] === undefined) { t[m] = DEFAULT_TARGETS[m]; changed = true; }
  if (changed) setSetting('targets', JSON.stringify(t));
}
const targetsNow = () => JSON.parse(getSetting('targets'));

// Admin bootstrap
const ADMIN_EMAIL = 'gary.bal@harcourts.co.nz';
if (!db.prepare('SELECT 1 FROM users WHERE email=?').get(ADMIN_EMAIL)) {
  const pw = process.env.ADMIN_INITIAL_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO users(name,email,pass_hash,role,must_change) VALUES(?,?,?,'admin',1)").run('Gary Bal', ADMIN_EMAIL, bcrypt.hashSync(pw, 10));
  fs.writeFileSync(path.join(DATA_DIR, 'ADMIN_PASSWORD.txt'), `Admin login: ${ADMIN_EMAIL}\nTemporary password: ${pw}\n`, { mode: 0o600 });
}

// Copy each old weekly metric row onto that week's Monday once. letter_drops starts at 0.
// appr_done, appr_booked, door_knocks and cold_calls are copied as stored. The entries row is left in place.
function migrateWeeklyMetrics() {
  const pending = db.prepare(`SELECT e.user_id, e.week_start, e.door_knocks, e.cold_calls, e.appr_booked, e.appr_done
    FROM entries e WHERE NOT EXISTS (
      SELECT 1 FROM weekly_metric_migration m WHERE m.user_id=e.user_id AND m.week_start=e.week_start)`).all();
  const hasDay = db.prepare('SELECT 1 AS n FROM day_entries WHERE user_id=? AND day=?');
  const insertDay = db.prepare(`INSERT INTO day_entries(user_id,day,door_knocks,cold_calls,appr_booked,appr_done,letter_drops,updated_at)
    VALUES(?,?,?,?,?,?,0,datetime('now'))`);
  const mark = db.prepare('INSERT INTO weekly_metric_migration(user_id,week_start) VALUES(?,?)');
  db.transaction(rows => {
    for (const e of rows) {
      const any = e.door_knocks || e.cold_calls || e.appr_booked || e.appr_done;
      if (any && !hasDay.get(e.user_id, e.week_start)) insertDay.run(e.user_id, e.week_start, e.door_knocks || 0, e.cold_calls || 0, e.appr_booked || 0, e.appr_done || 0);
      mark.run(e.user_id, e.week_start);
    }
  })(pending);
}
migrateWeeklyMetrics();

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
function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toISOString().slice(0, 10) === day ? day : null;
}
function editableDay(day) {
  const d = validDay(day);
  if (!d) return null;
  const today = nzDay();
  if (d > today || d < addDays(today, -(DAY_WINDOW - 1))) return null;
  return d;
}
function monthOf(day) { return day.slice(0, 7); }
function validMonth(s) {
  if (typeof s !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) return null;
  return s;
}
function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}
function recentDays(today = nzDay()) {
  const out = [];
  for (let i = 0; i < DAY_WINDOW; i++) out.push(addDays(today, -i));
  return out;
}

function ensureEntry(uid, week) {
  let e = db.prepare('SELECT * FROM entries WHERE user_id=? AND week_start=?').get(uid, week);
  if (!e) {
    const prev = db.prepare('SELECT pipeline_count, pipeline_note FROM entries WHERE user_id=? AND week_start<? ORDER BY week_start DESC LIMIT 1').get(uid, week);
    db.prepare('INSERT INTO entries(user_id,week_start,pipeline_count,pipeline_note) VALUES(?,?,?,?)').run(uid, week, prev ? prev.pipeline_count : 0, prev ? prev.pipeline_note : '');
    e = db.prepare('SELECT * FROM entries WHERE user_id=? AND week_start=?').get(uid, week);
  }
  return e;
}
function blankMetrics() { const o = {}; METRICS.forEach(m => o[m] = 0); return o; }
function sumMetrics(uid, from, to) {
  const r = db.prepare(`SELECT ${METRICS.map(m => `COALESCE(SUM(${m}),0) AS ${m}`).join(',')} FROM day_entries WHERE user_id=? AND day>=? AND day<=?`).get(uid, from, to);
  const o = blankMetrics(); METRICS.forEach(m => o[m] = r[m] || 0); return o;
}
function scoreOf(r) { return (r.appr_done || 0) * 30 + (r.appr_booked || 0) * 20 + (r.cold_calls || 0) + (r.door_knocks || 0) + (r.letter_drops || 0); }
function enteredMetrics(r) { return METRICS.some(m => (r[m] || 0) > 0); }

// ---- app ----
const app = express();
app.set('trust proxy', true);
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

function listWeeks() {
  const days = db.prepare('SELECT DISTINCT day FROM day_entries').all().map(r => weekStartOf(r.day));
  const legacy = db.prepare('SELECT DISTINCT week_start FROM entries').all().map(r => r.week_start);
  return [...new Set([...days, ...legacy, thisWeek()])].sort().reverse().slice(0, 104);
}
function listMonths() {
  const months = db.prepare("SELECT DISTINCT substr(day,1,7) AS m FROM day_entries").all().map(r => r.m);
  return [...new Set([...months, monthOf(nzDay())])].sort().reverse().slice(0, 36);
}
function teamData(week) {
  const today = nzDay(); const cur = thisWeek();
  const from = week, to = addDays(week, 6);
  const agents = db.prepare("SELECT id,name FROM users WHERE role='agent' AND active=1 ORDER BY name").all();
  const rows = agents.map(a => {
    const sums = sumMetrics(a.id, from, to);
    const e = db.prepare('SELECT pipeline_count, pipeline_note, status, status_day, last_day, updated_at FROM entries WHERE user_id=? AND week_start=?').get(a.id, week) || {};
    const r = { id: a.id, name: a.name, entered: enteredMetrics(sums) };
    Object.assign(r, sums);
    r.pipeline_count = e.pipeline_count || 0; r.pipeline_note = e.pipeline_note || '';
    r.working_today = week === cur && e.last_day === today;
    r.status = (week === cur && e.status_day === today) ? (e.status || '') : '';
    r.updated_at = e.updated_at || null;
    r.score = scoreOf(r);
    return r;
  });
  const totals = blankMetrics(); METRICS.forEach(m => totals[m] = rows.reduce((s, r) => s + r[m], 0));
  totals.pipeline_count = rows.reduce((s, r) => s + r.pipeline_count, 0);
  return { brand: BRAND, view: 'week', week, week_end: to, today, rows, totals, targets: targetsNow(),
    entered_count: rows.filter(r => r.entered).length, agent_count: rows.length, labels: LABELS };
}
function monthData(month) {
  const today = nzDay();
  const from = month + '-01', to = monthEnd(month);
  const agents = db.prepare("SELECT id,name FROM users WHERE role='agent' AND active=1 ORDER BY name").all();
  const rows = agents.map(a => {
    const sums = sumMetrics(a.id, from, to);
    const r = { id: a.id, name: a.name, entered: enteredMetrics(sums), pipeline_count: 0, pipeline_note: '', status: '', working_today: false, updated_at: null };
    Object.assign(r, sums);
    r.score = scoreOf(r);
    return r;
  });
  const totals = blankMetrics(); METRICS.forEach(m => totals[m] = rows.reduce((s, r) => s + r[m], 0));
  totals.pipeline_count = 0;
  return { brand: BRAND, view: 'month', month, month_start: from, month_end: to, today, rows, totals, targets: targetsNow(),
    entered_count: rows.filter(r => r.entered).length, agent_count: rows.length, labels: LABELS };
}

function dayRow(uid, day) {
  return db.prepare('SELECT * FROM day_entries WHERE user_id=? AND day=?').get(uid, day) || { user_id: uid, day, ...blankMetrics() };
}
function saveDayMetrics(uid, day, patch) {
  const cur = dayRow(uid, day);
  const next = {};
  METRICS.forEach(m => next[m] = patch[m] === undefined ? (cur[m] || 0) : patch[m]);
  db.prepare(`INSERT INTO day_entries(user_id,day,${METRICS.join(',')},updated_at) VALUES(?,?,${METRICS.map(() => '?').join(',')},datetime('now'))
    ON CONFLICT(user_id,day) DO UPDATE SET ${METRICS.map(m => `${m}=excluded.${m}`).join(',')}, updated_at=datetime('now')`)
    .run(uid, day, ...METRICS.map(m => next[m]));
  db.prepare("INSERT INTO activity(user_id,day,ts,field,value) VALUES(?,?,datetime('now'),?,?)").run(uid, day, 'day', JSON.stringify(next).slice(0, 200));
  if (day === nzDay()) {
    const w = thisWeek(); ensureEntry(uid, w);
    db.prepare("UPDATE entries SET last_day=?, updated_at=datetime('now') WHERE user_id=? AND week_start=?").run(day, uid, w);
  }
  return dayRow(uid, day);
}

// --- agent ---
app.get('/api/me', requireUser, (req, res) => {
  const today = nzDay();
  if (req.query.day && !editableDay(req.query.day)) return res.status(400).json({ error: 'Pick today or a day in the last 14 days' });
  const day = req.query.day ? editableDay(req.query.day) : today;
  const w = thisWeek(); const e = ensureEntry(req.user.id, w); const t = teamData(w);
  const month = monthOf(today);
  const entry = dayRow(req.user.id, day);
  res.json({
    user: req.user, today, day, recent_days: recentDays(today),
    entry: { ...entry, status: e.status_day === today ? e.status : '', working_today: e.last_day === today, pipeline_count: e.pipeline_count, pipeline_note: e.pipeline_note || '' },
    week: { week: w, week_end: addDays(w, 6), ...sumMetrics(req.user.id, w, addDays(w, 6)) },
    month: { month, ...sumMetrics(req.user.id, month + '-01', monthEnd(month)) },
    team: { totals: t.totals, targets: t.targets, entered_count: t.entered_count, agent_count: t.agent_count, week: w, week_end: t.week_end },
    labels: LABELS
  });
});
app.post('/api/me/inc', requireUser, (req, res) => {
  const { field } = req.body || {}; const delta = Number((req.body || {}).delta) || 1;
  if (!METRICS.includes(field) || Math.abs(delta) > 100) return res.status(400).json({ error: 'Bad field' });
  const day = (req.body || {}).day ? editableDay((req.body || {}).day) : nzDay();
  if (!day) return res.status(400).json({ error: 'Pick today or a day in the last 14 days' });
  const cur = dayRow(req.user.id, day);
  const patch = {}; patch[field] = Math.max(0, (cur[field] || 0) + delta);
  res.json({ ok: true, entry: saveDayMetrics(req.user.id, day, patch) });
});
app.post('/api/me/entry', requireUser, (req, res) => {
  const b = req.body || {};
  const metricPatch = {};
  for (const m of METRICS) if (b[m] !== undefined) metricPatch[m] = Math.max(0, Math.min(100000, parseInt(b[m], 10) || 0));
  const hasMetrics = Object.keys(metricPatch).length > 0;
  const hasWeek = b.pipeline_count !== undefined || b.pipeline_note !== undefined || b.status !== undefined;
  if (!hasMetrics && !hasWeek) return res.status(400).json({ error: 'Nothing to save' });
  if (hasMetrics) {
    const day = b.day ? editableDay(b.day) : nzDay();
    if (!day) return res.status(400).json({ error: 'Pick today or a day in the last 14 days' });
    saveDayMetrics(req.user.id, day, metricPatch);
  }
  if (hasWeek) {
    const w = thisWeek(); ensureEntry(req.user.id, w);
    const sets = [], vals = [];
    if (b.pipeline_count !== undefined) { sets.push('pipeline_count=?'); vals.push(Math.max(0, Math.min(100000, parseInt(b.pipeline_count, 10) || 0))); }
    if (b.pipeline_note !== undefined) { sets.push('pipeline_note=?'); vals.push(String(b.pipeline_note).slice(0, 300)); }
    if (b.status !== undefined) { sets.push('status=?', 'status_day=?'); vals.push(String(b.status).slice(0, 120), nzDay()); }
    db.prepare(`UPDATE entries SET ${sets.join(',')} WHERE user_id=? AND week_start=?`).run(...vals, req.user.id, w);
    const today = nzDay();
    db.prepare("UPDATE entries SET last_day=?, updated_at=datetime('now') WHERE user_id=? AND week_start=?").run(today, req.user.id, w);
    db.prepare("INSERT INTO activity(user_id,day,ts,field,value) VALUES(?,?,datetime('now'),?,?)").run(req.user.id, today, 'save', JSON.stringify(b).slice(0, 200));
  }
  res.json({ ok: true });
});
app.get('/api/me/history', requireUser, (req, res) => {
  const days = db.prepare('SELECT * FROM day_entries WHERE user_id=? ORDER BY day DESC LIMIT 400').all(req.user.id);
  const byWeek = new Map();
  for (const d of days) {
    const w = weekStartOf(d.day);
    if (!byWeek.has(w)) byWeek.set(w, { week_start: w, ...blankMetrics() });
    const row = byWeek.get(w);
    METRICS.forEach(m => row[m] += d[m] || 0);
  }
  res.json([...byWeek.values()].sort((a, b) => b.week_start.localeCompare(a.week_start)).slice(0, 26));
});

// --- TV (token) ---
app.get('/api/tv', (req, res) => {
  if (!req.query.key || req.query.key !== getSetting('tv_key')) return res.status(403).json({ error: 'Bad key' });
  const t = teamData(thisWeek());
  // TV shows team totals, status board and leaderboard only (no history). "Entered" means any number logged this week.
  t.rows = t.rows.map(r => ({ name: r.name, entered: r.entered, working_today: r.working_today, status: r.status, pipeline_count: r.pipeline_count, appr_done: r.appr_done, appr_booked: r.appr_booked, cold_calls: r.cold_calls, door_knocks: r.door_knocks, letter_drops: r.letter_drops, score: r.score }));
  res.set('Cache-Control', 'no-store'); res.json(t);
});

// --- admin ---
app.get('/api/admin/summary', requireAdmin, (req, res) => {
  const view = req.query.view === 'month' ? 'month' : 'week';
  const weeks = listWeeks();
  const months = listMonths();
  if (view === 'month') {
    const month = validMonth(req.query.month) || monthOf(nzDay());
    const cur = monthData(month); const prev = monthData(addMonths(month, -1));
    const prevBy = Object.fromEntries(prev.rows.map(r => [r.id, r]));
    cur.rows.forEach(r => { const p = prevBy[r.id] || {}; r.last = {}; METRICS.forEach(m => r.last[m] = p[m] || 0); });
    res.json({ ...cur, last_totals: prev.totals, last_month: prev.month, weeks, months, tv_key: getSetting('tv_key'), missing: cur.rows.filter(r => !r.entered).map(r => r.name), targets_apply: false, me: { id: req.user.id, must_change: !!req.user.must_change } });
  } else {
    const w = validWeek(req.query.week); const cur = teamData(w); const prev = teamData(addDays(w, -7));
    const prevBy = Object.fromEntries(prev.rows.map(r => [r.id, r]));
    cur.rows.forEach(r => { const p = prevBy[r.id] || {}; r.last = {}; METRICS.forEach(m => r.last[m] = p[m] || 0); });
    res.json({ ...cur, last_totals: prev.totals, last_week: prev.week, weeks, months, tv_key: getSetting('tv_key'), missing: cur.rows.filter(r => !r.entered).map(r => r.name), targets_apply: true, me: { id: req.user.id, must_change: !!req.user.must_change } });
  }
});
app.get('/api/admin/users', requireAdmin, (req, res) => res.json(db.prepare('SELECT id,name,email,role,active,must_change,created_at FROM users ORDER BY role, name').all()));
app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || ''))) return res.status(400).json({ error: 'Name and a valid email are needed' });
  if (String(password || '').length < 6) return res.status(400).json({ error: 'Temporary password must be at least 6 characters' });
  try { const r = db.prepare("INSERT INTO users(name,email,pass_hash,role) VALUES(?,?,?,'agent')").run(String(name).trim().slice(0, 80), String(email).trim(), bcrypt.hashSync(String(password), 10)); res.json({ ok: true, id: r.lastInsertRowid }); }
  catch (e) { res.status(400).json({ error: 'That email already has an account' }); }
});
app.post('/api/admin/users/:id/reset', requireAdmin, (req, res) => {
  const pw = String((req.body || {}).password || ''); if (pw.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  db.prepare('UPDATE users SET pass_hash=?, must_change=1 WHERE id=?').run(bcrypt.hashSync(pw, 10), req.params.id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.params.id); res.json({ ok: true });
});
app.post('/api/admin/users/:id/active', requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: "You can't deactivate yourself" });
  db.prepare('UPDATE users SET active=? WHERE id=?').run((req.body || {}).active ? 1 : 0, req.params.id);
  if (!(req.body || {}).active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.params.id); res.json({ ok: true });
});
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id); if (id === req.user.id) return res.status(400).json({ error: "You can't delete yourself" });
  const u = db.prepare('SELECT role FROM users WHERE id=?').get(id); if (!u) return res.status(404).json({ error: 'Not found' });
  db.transaction(() => { ['sessions', 'entries', 'activity'].forEach(t => db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(id)); db.prepare('DELETE FROM users WHERE id=?').run(id); })();
  res.json({ ok: true });
});
app.get('/api/admin/agent/:id/history', requireAdmin, (req, res) => res.json(db.prepare('SELECT * FROM day_entries WHERE user_id=? ORDER BY day DESC LIMIT 120').all(req.params.id)));
app.post('/api/admin/targets', requireAdmin, (req, res) => {
  const t = {}; METRICS.forEach(m => t[m] = Math.max(0, parseInt((req.body || {})[m], 10) || 0)); setSetting('targets', JSON.stringify(t)); res.json({ ok: true, targets: t });
});
app.post('/api/admin/tvkey', requireAdmin, (req, res) => { const k = crypto.randomBytes(12).toString('base64url'); setSetting('tv_key', k); res.json({ ok: true, tv_key: k }); });
function csvEsc(v) { v = v == null ? '' : String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
function sendCsv(res, filename, head, rows) {
  const csv = [head.join(','), ...rows.map(r => head.map(h => csvEsc(r[h])).join(','))].join('\n');
  res.set('Content-Type', 'text/csv'); res.set('Content-Disposition', `attachment; filename="${filename}"`); res.send(csv);
}
app.get('/api/admin/export.csv', requireAdmin, (req, res) => {
  const grain = ['day', 'week', 'month'].includes(req.query.grain) ? req.query.grain : 'day';
  const all = req.query.all === '1';
  const agents = db.prepare("SELECT id,name,email FROM users WHERE role='agent' ORDER BY name").all();
  if (grain === 'day') {
    let rows;
    if (all) rows = db.prepare("SELECT d.*, u.name, u.email FROM day_entries d JOIN users u ON u.id=d.user_id WHERE u.role='agent' ORDER BY d.day DESC, u.name").all();
    else if (validMonth(req.query.month)) rows = db.prepare("SELECT d.*, u.name, u.email FROM day_entries d JOIN users u ON u.id=d.user_id WHERE u.role='agent' AND d.day>=? AND d.day<=? ORDER BY d.day DESC, u.name").all(req.query.month + '-01', monthEnd(req.query.month));
    else { const w = validWeek(req.query.week); rows = db.prepare("SELECT d.*, u.name, u.email FROM day_entries d JOIN users u ON u.id=d.user_id WHERE u.role='agent' AND d.day>=? AND d.day<=? ORDER BY d.day DESC, u.name").all(w, addDays(w, 6)); }
    return sendCsv(res, `tgb-daily-${all ? 'all' : (validMonth(req.query.month) || validWeek(req.query.week))}.csv`, ['day', 'name', 'email', ...METRICS, 'updated_at'], rows);
  }
  if (grain === 'month') {
    const months = all ? listMonths() : [validMonth(req.query.month) || monthOf(nzDay())];
    const rows = [];
    for (const month of months) for (const a of agents) {
      const sums = sumMetrics(a.id, month + '-01', monthEnd(month));
      if (!enteredMetrics(sums)) continue;
      rows.push({ month, name: a.name, email: a.email, ...sums });
    }
    return sendCsv(res, `tgb-month-${all ? 'all' : months[0]}.csv`, ['month', 'name', 'email', ...METRICS], rows);
  }
  const weeks = all ? listWeeks() : [validWeek(req.query.week)];
  const rows = [];
  for (const week of weeks) for (const a of agents) {
    const sums = sumMetrics(a.id, week, addDays(week, 6));
    const e = db.prepare('SELECT pipeline_count, pipeline_note FROM entries WHERE user_id=? AND week_start=?').get(a.id, week);
    if (!enteredMetrics(sums) && !e) continue;
    rows.push({ week_start: week, week_end: addDays(week, 6), name: a.name, email: a.email, ...sums, pipeline_count: e ? e.pipeline_count : 0, pipeline_note: e ? e.pipeline_note : '' });
  }
  sendCsv(res, `tgb-week-${all ? 'all' : weeks[0]}.csv`, ['week_start', 'week_end', 'name', 'email', ...METRICS, 'pipeline_count', 'pipeline_note'], rows);
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
