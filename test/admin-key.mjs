import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const KEY = 'test-admin-key-9f3c';

function launch(data, port, extra = {}) {
  let logs = '';
  const env = {
    ...process.env,
    DATA_DIR: data,
    PORT: String(port),
    OPPORTUNITIES_SCHEDULER: '0',
    ADMIN_INITIAL_PASSWORD: 'temp-admin-pass',
    ...extra,
  };
  if (!Object.prototype.hasOwnProperty.call(extra, 'ADMIN_API_KEY')) delete env.ADMIN_API_KEY;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env,
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
  return { status: res.status, text, json, headers: res.headers, cookies: res.headers.getSetCookie() };
}

function aucklandToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

test('a blank or missing admin key does not authenticate', async () => {
  const unsetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-admin-key-off-'));
  const unset = launch(unsetDir, 3276);
  const blankDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-admin-key-blank-'));
  const blank = launch(blankDir, 3277, { ADMIN_API_KEY: '' });
  const spacesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-admin-key-spaces-'));
  const spaces = launch(spacesDir, 3279, { ADMIN_API_KEY: '   ' });
  await Promise.all([unset.ready(), blank.ready(), spaces.ready()]);
  try {
    for (const app of [unset, blank, spaces]) {
      const bearer = await hit(app.base, '/api/admin/users', { headers: { Authorization: `Bearer ${KEY}` } });
      assert.equal(bearer.status, 401);
      assert.equal(bearer.json.error, 'Not signed in');
      const header = await hit(app.base, '/api/admin/export.csv', { headers: { 'X-Admin-Key': KEY } });
      assert.equal(header.status, 401);
      const empty = await hit(app.base, '/api/admin/summary?view=week', { headers: { Authorization: 'Bearer    ' } });
      assert.equal(empty.status, 401);
      assert.equal(app.logs().includes(KEY), false);
    }
  } finally {
    await Promise.all([unset.stop(), blank.stop(), spaces.stop()]);
  }
});

test('the admin key opens admin API routes and the login report, and cookies still work', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-admin-key-on-'));
  const app = launch(data, 3278, { ADMIN_API_KEY: KEY });
  await app.ready();
  try {
    const wrong = await hit(app.base, '/api/admin/opportunities/verification/status', {
      headers: { Authorization: 'Bearer test-admin-key-9f3c-extra' },
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error, 'Not signed in');
    const shorter = await hit(app.base, '/api/admin/summary?view=week', {
      headers: { 'X-Admin-Key': 'test-admin-key-9f3' },
    });
    assert.equal(shorter.status, 401);
    const emptyBearer = await hit(app.base, '/api/admin/users', { headers: { Authorization: 'Bearer' } });
    assert.equal(emptyBearer.status, 401);
    const agentArea = await hit(app.base, '/api/me', { headers: { Authorization: `Bearer ${KEY}` } });
    assert.equal(agentArea.status, 401);
    const html = await hit(app.base, '/admin', { headers: { 'X-Admin-Key': KEY } });
    assert.equal(html.status, 302);

    const bearer = { Authorization: `bearer ${KEY}`, 'Content-Type': 'application/json' };
    const status = await hit(app.base, '/api/admin/opportunities/verification/status', { headers: bearer });
    assert.equal(status.status, 200);
    const report = await hit(app.base, '/api/admin/opportunities/verification/report', {
      headers: { 'X-Admin-Key': KEY },
    });
    assert.equal(report.status, 200);
    assert.ok(Array.isArray(report.json.rows));
    const run = await hit(app.base, '/api/admin/opportunities/verification/run', {
      method: 'POST', headers: bearer, body: JSON.stringify({ trigger: 'routine' }),
    });
    assert.equal(run.status, 409);
    assert.equal(run.json.no_baseline, true);
    const evidence = await hit(app.base, '/api/admin/opportunities/verification/evidence', {
      method: 'POST', headers: { 'X-Admin-Key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(evidence.status, 400);
    const exported = await hit(app.base, '/api/admin/export.csv', { headers: bearer });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-type'), /text\/csv/);
    const board = await hit(app.base, '/api/board', { headers: { 'X-Admin-Key': KEY } });
    assert.equal(board.status, 200);
    const summary = await hit(app.base, '/api/admin/summary?view=week', { headers: bearer });
    assert.equal(summary.status, 200);
    assert.equal(summary.json.me.id, 0);

    const pw = fs.readFileSync(path.join(data, 'ADMIN_PASSWORD.txt'), 'utf8').match(/Temporary password: (.+)/)[1].trim();
    const login = await hit(app.base, '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'gary.bal@harcourts.co.nz', password: pw }),
    });
    assert.equal(login.status, 200);
    const cookie = login.cookies.find(c => c.startsWith('sid=')).split(';')[0];
    const withWrongKey = await hit(app.base, '/api/admin/summary?view=week', {
      headers: { cookie, 'X-Admin-Key': 'not-the-key' },
    });
    assert.equal(withWrongKey.status, 200);
    assert.notEqual(withWrongKey.json.me.id, 0);

    const created = await hit(app.base, '/api/admin/users', {
      method: 'POST', headers: bearer,
      body: JSON.stringify({ name: 'Pat Agent', email: 'pat.key@example.com', password: 'agent-temp-1' }),
    });
    assert.equal(created.status, 200);
    const quiet = await hit(app.base, '/api/admin/users', {
      method: 'POST', headers: bearer,
      body: JSON.stringify({ name: 'Quiet Agent', email: 'quiet.key@example.com', password: 'agent-temp-1' }),
    });
    assert.equal(quiet.status, 200);
    const patLogin = await hit(app.base, '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pat.key@example.com', password: 'agent-temp-1' }),
    });
    assert.equal(patLogin.status, 200);
    const patCookie = patLogin.cookies.find(c => c.startsWith('sid=')).split(';')[0];
    const blocked = await hit(app.base, '/api/admin/access/logins?from=2026-11-09&to=2026-11-15', {
      headers: { cookie: patCookie },
    });
    assert.equal(blocked.status, 403);
    const keyedAgent = await hit(app.base, '/api/admin/users', {
      headers: { cookie: patCookie, Authorization: `Bearer ${KEY}` },
    });
    assert.equal(keyedAgent.status, 200);

    const day = aucklandToday();
    const beforePage = await hit(app.base, `/api/admin/access/logins?from=${day}&to=${day}`, {
      headers: { 'X-Admin-Key': KEY },
    });
    assert.equal(beforePage.status, 200);
    const patBefore = beforePage.json.agents.find(person => person.email === 'pat.key@example.com');
    const quietRow = beforePage.json.agents.find(person => person.email === 'quiet.key@example.com');
    assert.equal(patBefore.logged_in, true);
    assert.equal(patBefore.visited, false);
    assert.equal(patBefore.seen, true);
    assert.ok(patBefore.last_login);
    assert.equal(patBefore.last_visit, null);
    assert.equal(patBefore.last_seen, patBefore.last_login);
    assert.equal(quietRow.seen, false);
    assert.equal(quietRow.last_login, null);
    assert.equal(beforePage.json.agents.some(person => person.email === 'gary.bal@harcourts.co.nz'), false);

    assert.equal((await hit(app.base, '/me', { headers: { cookie: patCookie } })).status, 200);
    assert.equal((await hit(app.base, '/api/me', { headers: { cookie: patCookie } })).status, 200);
    const afterPage = await hit(app.base, `/api/admin/access/logins?from=${day}&to=${day}`, { headers: bearer });
    const patAfter = afterPage.json.agents.find(person => person.email === 'pat.key@example.com');
    assert.equal(patAfter.logged_in, true);
    assert.equal(patAfter.visited, true);
    assert.equal(patAfter.seen, true);
    assert.ok(patAfter.last_visit);
    assert.equal(patAfter.last_seen >= patAfter.last_login, true);

    const unknown = await hit(app.base, '/api/admin/access/logins?from=2026-11-02&to=2026-11-08', { headers: bearer });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.json.coverage, 'unknown');
    assert.equal(unknown.json.agents.every(person => person.seen === false && person.last_seen === null), true);
    const bad = await hit(app.base, '/api/admin/access/logins?from=yesterday&to=2026-11-15', { headers: bearer });
    assert.equal(bad.status, 400);

    const cleared = await hit(app.base, '/api/admin/clear-activity', {
      method: 'POST', headers: bearer, body: JSON.stringify({}),
    });
    assert.equal(cleared.status, 200);
    assert.match(app.logs(), /Admin api-key cleared KPI activity/);
    assert.equal(app.logs().includes(KEY), false);
    assert.equal(app.logs().includes(pw), false);
    assert.equal(app.logs().includes('agent-temp-1'), false);
  } finally {
    await app.stop();
  }
});
