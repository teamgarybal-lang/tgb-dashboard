import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const Database = require('better-sqlite3');
const access = require(path.join(process.cwd(), 'access.js'));

function memoryDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users(
    id INTEGER PRIMARY KEY, name TEXT, email TEXT, role TEXT, active INTEGER
  )`);
  access.migrate(db);
  return db;
}

function addUser(db, name, role, active = 1) {
  const info = db.prepare('INSERT INTO users(name,email,role,active) VALUES(?,?,?,?)')
    .run(name, name.toLowerCase().replace(/ /g, '.') + '@example.com', role, active);
  return Number(info.lastInsertRowid);
}

test('Auckland week boundaries and unknown history before tracking', () => {
  assert.equal(access.weekStartOf('2026-11-08'), '2026-11-02');
  assert.equal(access.weekStartOf('2026-11-09'), '2026-11-09');
  const db = memoryDb();
  db.prepare('UPDATE settings SET value=? WHERE key=?').run('2026-11-11T00:00:00.000Z', access.TRACKING_KEY);
  const pat = addUser(db, 'Pat Agent', 'agent');
  const ada = addUser(db, 'Ada Admin', 'admin');
  const gone = addUser(db, 'Gone Agent', 'agent', 0);
  addUser(db, 'Odd Role', 'owner', 1);
  const now = new Date('2026-11-13T00:00:00.000Z'); // Friday 13 Nov 2026, 13:00 Auckland (UTC+13)
  // Sunday 8 Nov 23:30 Auckland is still the previous week. Monday 9 Nov 00:30 is the new week.
  access.record(db, pat, 'sign_in', 'login', new Date('2026-11-08T10:30:00.000Z'));
  access.record(db, pat, 'visit', 'page', new Date('2026-11-08T11:30:00.000Z'));
  const current = access.report(db, { week: 'current', now });
  assert.equal(current.week_start, '2026-11-09');
  assert.equal(current.week_end, '2026-11-15');
  assert.equal(current.cutoff, '2026-11-13');
  assert.equal(current.observed_from, '2026-11-11');
  assert.equal(current.observed_to, '2026-11-13');
  assert.equal(current.coverage, 'partial');
  assert.equal(current.partial, true);
  const patRow = current.agents.find(person => person.name === 'Pat Agent');
  assert.equal(patRow.status, 'not_observed_since_start');
  assert.equal(patRow.status_label, 'Not observed since tracking began');
  assert.equal(patRow.sign_ins, 0);
  assert.equal(patRow.visits, 0);
  assert.equal(patRow.last_sign_in, null);
  assert.equal(patRow.last_visit, null);
  assert.doesNotMatch(JSON.stringify(current), /never used/i);
  assert.equal(current.agents.some(person => person.name === 'Ada Admin'), false);
  assert.equal(current.admins.some(person => person.name === 'Ada Admin'), true);
  assert.equal(current.anomalies.some(person => person.name === 'Gone Agent' && person.reason === 'inactive'), true);
  assert.equal(current.anomalies.some(person => person.name === 'Odd Role'), true);

  access.record(db, pat, 'visit', 'page', new Date('2026-11-11T01:00:00.000Z')); // Wed 11 Nov 14:00 Auckland
  const after = access.report(db, { week: 'current', now });
  const seen = after.agents.find(person => person.id === pat);
  assert.equal(seen.status, 'accessed_this_week');
  assert.equal(seen.visits, 1);
  assert.equal(seen.sign_ins, 0);

  const previous = access.report(db, { week: 'previous', now });
  assert.equal(previous.week_start, '2026-11-02');
  assert.equal(previous.coverage, 'unknown');
  assert.equal(previous.agents.every(person => person.status === 'unknown_history'), true);
  assert.match(previous.note, /unknown history/);
  assert.doesNotMatch(previous.note, /never used/i);
  assert.equal(previous.counts.unknown_history, previous.counts.enabled_agents);
  assert.equal(previous.counts.not_observed_since_start, 0);
});

test('date-range login report counts sign-ins and phone visits inside the range', () => {
  const db = memoryDb();
  db.prepare('UPDATE settings SET value=? WHERE key=?').run('2026-11-11T00:00:00.000Z', access.TRACKING_KEY);
  const pat = addUser(db, 'Pat Agent', 'agent');
  addUser(db, 'Quiet Agent', 'agent');
  const gone = addUser(db, 'Gone Agent', 'agent', 0);
  addUser(db, 'Ada Admin', 'admin');
  // Tue 10 Nov 23:30 Auckland is still before tracking. Wed 11 Nov 14:00 Auckland is inside.
  access.record(db, pat, 'sign_in', 'login', new Date('2026-11-10T10:30:00.000Z'));
  access.record(db, pat, 'sign_in', 'login', new Date('2026-11-11T01:00:00.000Z'));
  access.record(db, pat, 'visit', 'page', new Date('2026-11-11T01:05:00.000Z'));
  access.record(db, pat, 'visit', 'page', new Date('2026-11-12T02:00:00.000Z'));
  access.record(db, gone, 'sign_in', 'login', new Date('2026-11-11T03:00:00.000Z'));

  const missing = access.rangeReport(db, { from: '2026-11-09' });
  assert.equal(missing.error, 'from and to must be YYYY-MM-DD dates');
  assert.equal(access.rangeReport(db, { from: '2026-02-31', to: '2026-03-01' }).error, 'from and to must be YYYY-MM-DD dates');
  assert.equal(access.rangeReport(db, { from: '2026-11-12', to: '2026-11-11' }).error, 'from must be on or before to');

  const week = access.rangeReport(db, { from: '2026-11-09', to: '2026-11-15' });
  assert.equal(week.coverage, 'partial');
  assert.equal(week.observed_from, '2026-11-11');
  assert.equal(week.observed_to, '2026-11-15');
  assert.equal(week.timezone, 'Pacific/Auckland');
  assert.equal(week.agents.some(person => person.name === 'Ada Admin'), false);
  const patRow = week.agents.find(person => person.id === pat);
  assert.equal(patRow.logged_in, true);
  assert.equal(patRow.visited, true);
  assert.equal(patRow.seen, true);
  assert.equal(patRow.active, true);
  assert.equal(patRow.last_login, '2026-11-11T01:00:00.000Z');
  assert.equal(patRow.last_visit, '2026-11-12T02:00:00.000Z');
  assert.equal(patRow.last_seen, '2026-11-12T02:00:00.000Z');
  const quiet = week.agents.find(person => person.name === 'Quiet Agent');
  assert.equal(quiet.logged_in, false);
  assert.equal(quiet.visited, false);
  assert.equal(quiet.seen, false);
  assert.equal(quiet.last_login, null);
  assert.equal(quiet.last_visit, null);
  assert.equal(quiet.last_seen, null);
  const goneRow = week.agents.find(person => person.id === gone);
  assert.equal(goneRow.active, false);
  assert.equal(goneRow.logged_in, true);
  assert.equal(goneRow.visited, false);
  assert.equal(goneRow.last_seen, goneRow.last_login);

  const phoneOnly = access.rangeReport(db, { from: '2026-11-12', to: '2026-11-12' });
  assert.equal(phoneOnly.coverage, 'complete');
  const phone = phoneOnly.agents.find(person => person.id === pat);
  assert.equal(phone.logged_in, false);
  assert.equal(phone.visited, true);
  assert.equal(phone.seen, true);
  assert.equal(phone.last_login, null);
  assert.equal(phone.last_visit, '2026-11-12T02:00:00.000Z');
  assert.equal(phone.last_seen, phone.last_visit);

  const before = access.rangeReport(db, { from: '2026-11-02', to: '2026-11-08' });
  assert.equal(before.coverage, 'unknown');
  assert.equal(before.observed_from, null);
  assert.equal(before.agents.every(person => person.logged_in === false && person.visited === false && person.seen === false), true);
  assert.equal(before.agents.every(person => person.last_login === null && person.last_visit === null && person.last_seen === null), true);
  assert.match(before.note, /before access tracking began/);
});

function launch(data, port) {
  let logs = '';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: data, PORT: String(port), OPPORTUNITIES_SCHEDULER: '0', ADMIN_INITIAL_PASSWORD: 'temp-admin-pass' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => { logs += d; });
  server.stderr.on('data', d => { logs += d; });
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    logs: () => logs,
    async ready() {
      for (let i = 0; i < 50; i++) {
        try { if ((await fetch(base + '/healthz')).ok) return; } catch {}
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('server did not start\n' + logs);
    },
    stop() {
      server.kill('SIGTERM');
      return new Promise(resolve => {
        const t = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 3000);
        server.on('exit', () => { clearTimeout(t); resolve(); });
      });
    },
  };
}

async function hit(base, url, opts = {}) {
  const res = await fetch(base + url, { redirect: 'manual', ...opts });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, cookies: res.headers.getSetCookie() };
}

test('sign-in, page open, and polls are recorded differently, and agents cannot read the report', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-access-'));
  const app = launch(data, 3264);
  await app.ready();
  try {
    const failed = await hit(app.base, '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'gary.bal@harcourts.co.nz', password: 'wrong-password' }),
    });
    assert.equal(failed.status, 401);
    const db = new Database(path.join(data, 'data.db'));
    db.pragma('busy_timeout = 5000');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM access_events').get().n, 0);
    const started = db.prepare("SELECT value FROM settings WHERE key='access_tracking_started_at'").get().value;
    assert.ok(started);
    db.close();

    const pw = fs.readFileSync(path.join(data, 'ADMIN_PASSWORD.txt'), 'utf8').match(/Temporary password: (.+)/)[1].trim();
    const login = await hit(app.base, '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'gary.bal@harcourts.co.nz', password: pw }),
    });
    assert.equal(login.status, 200);
    const admin = { cookie: login.cookies.find(c => c.startsWith('sid=')).split(';')[0], 'Content-Type': 'application/json' };
    assert.equal((await hit(app.base, '/api/admin/access', { headers: { cookie: admin.cookie } })).status, 200);
    const quiet = new Database(path.join(data, 'data.db'), { readonly: true });
    const afterLogin = quiet.prepare("SELECT event_type, source FROM access_events").all();
    quiet.close();
    assert.deepEqual(afterLogin, [{ event_type: 'sign_in', source: 'login' }]);

    assert.equal((await hit(app.base, '/api/admin/summary?view=week', { headers: { cookie: admin.cookie } })).status, 200);
    assert.equal((await hit(app.base, '/api/admin/opportunities/status', { headers: { cookie: admin.cookie } })).status, 200);
    const afterPoll = new Database(path.join(data, 'data.db'), { readonly: true });
    assert.equal(afterPoll.prepare("SELECT COUNT(*) AS n FROM access_events WHERE event_type='visit'").get().n, 0);
    afterPoll.close();

    const page = await hit(app.base, '/access', { headers: { cookie: admin.cookie } });
    assert.equal(page.status, 200);
    assert.match(page.text, /Not observed since tracking began/);
    assert.match(page.text, /Days before tracking began are unknown/);
    assert.doesNotMatch(page.text, /never used the system/i);
    const afterPage = new Database(path.join(data, 'data.db'), { readonly: true });
    assert.equal(afterPage.prepare("SELECT COUNT(*) AS n FROM access_events WHERE event_type='visit' AND source='page'").get().n, 1);
    afterPage.close();
    await hit(app.base, '/access', { headers: { cookie: admin.cookie } });
    const afterRepeat = new Database(path.join(data, 'data.db'), { readonly: true });
    assert.equal(afterRepeat.prepare("SELECT COUNT(*) AS n FROM access_events WHERE event_type='visit' AND source='page'").get().n, 1);
    afterRepeat.close();

    const created = await hit(app.base, '/api/admin/users', {
      method: 'POST', headers: admin,
      body: JSON.stringify({ name: 'Pat Agent', email: 'pat.access@example.com', password: 'agent-temp-1' }),
    });
    assert.equal(created.status, 200);
    const report = await hit(app.base, '/api/admin/access?week=current', { headers: { cookie: admin.cookie } });
    const pat = report.json.agents.find(person => person.email === 'pat.access@example.com');
    assert.equal(pat.status, 'not_observed_since_start');
    assert.equal(pat.last_sign_in, null);
    assert.equal(pat.last_visit, null);
    const numbers = new Database(path.join(data, 'data.db'));
    numbers.pragma('busy_timeout = 5000');
    const patId = numbers.prepare("SELECT id FROM users WHERE email='pat.access@example.com'").get().id;
    numbers.prepare(`INSERT INTO day_entries(user_id, day, door_knocks, cold_calls, appr_booked, appr_done, letter_drops, updated_at)
      VALUES(?, '2026-11-02', 0, 0, 0, 4, 0, '2026-11-02 00:00:00')`).run(patId);
    numbers.close();
    const still = await hit(app.base, '/api/admin/access?week=current', { headers: { cookie: admin.cookie } });
    assert.equal(still.json.agents.find(person => person.id === patId).status, 'not_observed_since_start');

    const agentLogin = await hit(app.base, '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pat.access@example.com', password: 'agent-temp-1' }),
    });
    assert.equal(agentLogin.status, 200);
    const agent = { cookie: agentLogin.cookies.find(c => c.startsWith('sid=')).split(';')[0], 'Content-Type': 'application/json' };
    assert.equal((await hit(app.base, '/api/me', { headers: { cookie: agent.cookie } })).status, 200);
    assert.equal((await hit(app.base, '/api/admin/access', { headers: { cookie: agent.cookie } })).status, 403);
    assert.equal((await hit(app.base, '/access', { headers: { cookie: agent.cookie } })).status, 302);
    const beforePage = new Database(path.join(data, 'data.db'), { readonly: true });
    const agentEvents = beforePage.prepare('SELECT event_type, source FROM access_events WHERE user_id=? ORDER BY id').all(patId);
    beforePage.close();
    assert.deepEqual(agentEvents, [{ event_type: 'sign_in', source: 'login' }]);

    assert.equal((await hit(app.base, '/me', { headers: { cookie: agent.cookie } })).status, 200);
    const bumped = await hit(app.base, '/api/me/inc', {
      method: 'POST', headers: agent, body: JSON.stringify({ field: 'appr_done', delta: 1 }),
    });
    assert.equal(bumped.status, 200);
    const finalDb = new Database(path.join(data, 'data.db'), { readonly: true });
    const kinds = finalDb.prepare('SELECT event_type, source FROM access_events WHERE user_id=? ORDER BY id').all(patId);
    finalDb.close();
    assert.deepEqual(kinds, [
      { event_type: 'sign_in', source: 'login' },
      { event_type: 'visit', source: 'page' },
      { event_type: 'visit', source: 'action' },
    ]);
    const seen = await hit(app.base, '/api/admin/access?week=current', { headers: { cookie: admin.cookie } });
    const patSeen = seen.json.agents.find(person => person.id === patId);
    assert.equal(patSeen.status, 'accessed_this_week');
    assert.equal(patSeen.sign_ins, 1);
    assert.equal(patSeen.visits, 2);
    assert.equal(seen.json.admins.some(person => person.email === 'gary.bal@harcourts.co.nz'), true);
    const csv = await hit(app.base, '/api/admin/access.csv?week=previous', { headers: { cookie: admin.cookie } });
    assert.equal(csv.status, 200);
    assert.match(csv.text, /unknown_history/);
    assert.equal(app.logs().includes(pw), false);
    assert.equal(app.logs().includes('agent-temp-1'), false);
  } finally {
    await app.stop();
  }
});
