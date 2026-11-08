'use strict';

// Who opened the dashboard, from the moment this table started.
// Nothing is backfilled. Day totals are not sign-ins.
// A visit is a signed-in page open or a deliberate save. Timed API polls are not visits.

const TZ = 'Pacific/Auckland';
const TRACKING_KEY = 'access_tracking_started_at';
const VISIT_GAP_MS = 60 * 1000;

const PAGE_VISITS = new Set([
  '/me',
  '/admin',
  '/board',
  '/board/add',
  '/board/manage',
  '/opportunities',
  '/access',
]);

function migrate(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS access_events(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS access_events_user_time ON access_events(user_id, occurred_at);
CREATE INDEX IF NOT EXISTS access_events_type_time ON access_events(event_type, occurred_at);
`);
  const existing = db.prepare('SELECT value FROM settings WHERE key=?').get(TRACKING_KEY);
  if (!existing) {
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(TRACKING_KEY, new Date().toISOString());
  }
}

function collectionStart(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(TRACKING_KEY);
  return row ? row.value : null;
}

function aucklandDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function weekStartOf(day) {
  const [y, m, dd] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, dd));
  const dow = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}

function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function record(db, userId, eventType, source, at = new Date()) {
  const id = Number(userId);
  if (!id || (eventType !== 'sign_in' && eventType !== 'visit')) return;
  if (source !== 'login' && source !== 'page' && source !== 'action') return;
  const when = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(when.getTime())) return;
  if (eventType === 'visit') {
    const recent = db.prepare(`SELECT occurred_at FROM access_events
      WHERE user_id=? AND event_type='visit' AND source=? ORDER BY occurred_at DESC LIMIT 1`).get(id, source);
    if (recent && when.getTime() - Date.parse(recent.occurred_at) < VISIT_GAP_MS) return;
  }
  db.prepare('INSERT INTO access_events(user_id, event_type, source, occurred_at) VALUES(?,?,?,?)')
    .run(id, eventType, source, when.toISOString());
}

function normalPath(path) {
  const value = String(path || '');
  if (value.length > 1 && value.endsWith('/')) return value.slice(0, -1);
  return value;
}

function observeRequest(db, req, res, auth) {
  const method = req.method;
  const path = normalPath(req.path);
  if (method === 'GET' && PAGE_VISITS.has(path)) {
    res.on('finish', () => {
      if (res.statusCode !== 200) return;
      try {
        const user = auth(req);
        if (user) record(db, user.id, 'visit', 'page');
      } catch (err) { /* ignore */ }
    });
    return;
  }
  if (method !== 'POST' && method !== 'PUT' && method !== 'DELETE') return;
  if (path === '/api/login' || path === '/api/logout') return;
  const humanAction = path === '/api/password'
    || path.startsWith('/api/me/')
    || path.startsWith('/api/board')
    || path.startsWith('/api/admin/');
  if (!humanAction) return;
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    try {
      const user = auth(req);
      if (user) record(db, user.id, 'visit', 'action');
    } catch (err) { /* ignore */ }
  });
}

function weekWindow(spec, now, collectionStartIso) {
  const today = aucklandDate(now);
  let weekStart;
  if (!spec || spec === 'current') weekStart = weekStartOf(today);
  else if (spec === 'previous') weekStart = addDays(weekStartOf(today), -7);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) weekStart = weekStartOf(spec);
  else return { error: 'Week must be current, previous, or a YYYY-MM-DD date' };
  if (weekStart > today) return { error: 'That week has not started' };
  const weekEnd = addDays(weekStart, 6);
  const startDay = aucklandDate(new Date(collectionStartIso));
  const cutoff = weekEnd < today ? weekEnd : today;
  const observedFrom = startDay > weekStart ? startDay : weekStart;
  const observedTo = cutoff < weekEnd ? cutoff : weekEnd;
  let coverage = 'complete';
  if (startDay > weekEnd) coverage = 'unknown';
  else if (observedFrom > weekStart || observedTo < weekEnd) coverage = 'partial';
  return {
    week_start: weekStart,
    week_end: weekEnd,
    cutoff,
    observed_from: coverage === 'unknown' ? null : observedFrom,
    observed_to: coverage === 'unknown' ? null : observedTo,
    coverage,
    collection_start_auckland: startDay,
  };
}

function inRange(iso, fromDay, toDay) {
  if (!fromDay || !toDay) return false;
  const day = aucklandDate(new Date(iso));
  return day >= fromDay && day <= toDay;
}

function blankPerson(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    active: !!user.active,
    status: 'not_observed_since_start',
    status_label: 'Not observed since tracking began',
    last_sign_in: null,
    last_visit: null,
    sign_ins: 0,
    visits: 0,
    last_event_at: null,
    last_event_type: null,
    last_event_source: null,
  };
}

function statusLabel(status) {
  if (status === 'accessed_this_week') return 'Accessed this week';
  if (status === 'unknown_history') return 'Unknown — before tracking began';
  return 'Not observed since tracking began';
}

function report(db, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const started = collectionStart(db);
  if (!started) return { error: 'Access tracking has not started' };
  const window = weekWindow(options.week || 'current', now, started);
  if (window.error) return { error: window.error };
  const users = db.prepare('SELECT id, name, email, role, active FROM users ORDER BY name').all();
  const events = db.prepare('SELECT user_id, event_type, source, occurred_at FROM access_events WHERE occurred_at>=?')
    .all(started);
  const byUser = new Map();
  for (const event of events) {
    if (!byUser.has(event.user_id)) byUser.set(event.user_id, []);
    byUser.get(event.user_id).push(event);
  }
  const agents = [];
  const admins = [];
  const anomalies = [];
  for (const user of users) {
    const mine = byUser.get(user.id) || [];
    const person = blankPerson(user);
    for (const event of mine) {
      if (event.event_type === 'sign_in' && (!person.last_sign_in || event.occurred_at > person.last_sign_in)) {
        person.last_sign_in = event.occurred_at;
      }
      if (event.event_type === 'visit' && (!person.last_visit || event.occurred_at > person.last_visit)) {
        person.last_visit = event.occurred_at;
      }
      if (inRange(event.occurred_at, window.observed_from, window.observed_to)) {
        if (event.event_type === 'sign_in') person.sign_ins++;
        if (event.event_type === 'visit') person.visits++;
        if (!person.last_event_at || event.occurred_at > person.last_event_at) {
          person.last_event_at = event.occurred_at;
          person.last_event_type = event.event_type;
          person.last_event_source = event.source;
        }
      }
    }
    if (window.coverage === 'unknown') person.status = 'unknown_history';
    else if (person.sign_ins || person.visits) person.status = 'accessed_this_week';
    else person.status = 'not_observed_since_start';
    person.status_label = statusLabel(person.status);
    if (user.role === 'agent' && user.active) agents.push(person);
    else if (user.role === 'admin') admins.push(person);
    else anomalies.push({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      active: !!user.active,
      reason: user.role === 'agent' && !user.active ? 'inactive' : 'not_an_enabled_agent',
    });
  }
  const counts = {
    enabled_agents: agents.length,
    accessed_this_week: agents.filter(person => person.status === 'accessed_this_week').length,
    not_observed_since_start: agents.filter(person => person.status === 'not_observed_since_start').length,
    unknown_history: agents.filter(person => person.status === 'unknown_history').length,
  };
  return {
    collection_start: started,
    collection_start_auckland: window.collection_start_auckland,
    timezone: TZ,
    week: options.week || 'current',
    week_start: window.week_start,
    week_end: window.week_end,
    cutoff: window.cutoff,
    observed_from: window.observed_from,
    observed_to: window.observed_to,
    coverage: window.coverage,
    partial: window.coverage === 'partial',
    note: window.coverage === 'unknown'
      ? 'This week ended before access tracking began. There is no sign-in or visit record for it. The gap is unknown history, not a finding that nobody opened the dashboard.'
      : `Tracking began ${window.collection_start_auckland} (Auckland). Earlier days were not recorded. Not observed means no sign-in or visit since tracking began. It is not a judgement about the time before tracking. Number entries are not sign-ins.`,
    counts,
    agents,
    admins,
    anomalies,
  };
}

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function reportCsv(data) {
  const cols = ['group', 'name', 'email', 'status', 'status_label', 'last_sign_in', 'last_visit', 'sign_ins', 'visits', 'last_event_type', 'last_event_source'];
  const lines = [cols.join(',')];
  const push = (group, person) => lines.push(cols.map(col => csvCell(col === 'group' ? group : person[col])).join(','));
  for (const person of data.agents) push('agent', person);
  for (const person of data.admins) push('admin', person);
  return lines.join('\n') + '\n';
}

module.exports = {
  TZ,
  TRACKING_KEY,
  PAGE_VISITS,
  migrate,
  collectionStart,
  aucklandDate,
  weekStartOf,
  addDays,
  record,
  observeRequest,
  weekWindow,
  report,
  reportCsv,
};
