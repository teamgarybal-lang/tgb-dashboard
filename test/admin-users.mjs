import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function launch(data, port) {
  let logs = '';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: data, PORT: String(port) },
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

test('a second admin can run the office and does not appear as an agent', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-admin-role-'));
  const app = launch(data, 3238);
  await app.ready();
  try {
    const pw = fs.readFileSync(path.join(data, 'ADMIN_PASSWORD.txt'), 'utf8').match(/Temporary password: (.+)/)[1].trim();
    const login = await hit(app.base, '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'gary.bal@harcourts.co.nz', password: pw }),
    });
    assert.equal(login.status, 200);
    const gary = { cookie: login.cookies.find(c => c.startsWith('sid=')).split(';')[0], 'Content-Type': 'application/json' };

    const page = await hit(app.base, '/admin', { headers: { cookie: gary.cookie } });
    assert.equal(page.status, 200);
    assert.match(page.text, /id="nRole"/);
    assert.match(page.text, /<option value="admin">Admin<\/option>/);
    assert.match(page.text, /<th>Role<\/th>/);

    const agent = await hit(app.base, '/api/admin/users', {
      method: 'POST', headers: gary,
      body: JSON.stringify({ name: 'Pat Agent', email: 'pat.role@example.com', password: 'agent-temp-1' }),
    });
    assert.equal(agent.status, 200);
    const office = await hit(app.base, '/api/admin/users', {
      method: 'POST', headers: gary,
      body: JSON.stringify({ name: 'Chenchen', email: 'chenchen.admin@example.com', password: 'admin-temp-1', role: 'admin' }),
    });
    assert.equal(office.status, 200);
    const bad = await hit(app.base, '/api/admin/users', {
      method: 'POST', headers: gary,
      body: JSON.stringify({ name: 'Nope', email: 'nope.role@example.com', password: 'admin-temp-1', role: 'owner' }),
    });
    assert.equal(bad.status, 400);

    const users = await hit(app.base, '/api/admin/users', { headers: { cookie: gary.cookie } });
    const pat = users.json.find(u => u.email === 'pat.role@example.com');
    const chen = users.json.find(u => u.email === 'chenchen.admin@example.com');
    assert.equal(pat.role, 'agent');
    assert.equal(pat.must_change, 1);
    assert.equal(chen.role, 'admin');
    assert.equal(chen.must_change, 1);

    const chenLogin = await hit(app.base, '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'chenchen.admin@example.com', password: 'admin-temp-1' }),
    });
    assert.equal(chenLogin.status, 200);
    assert.equal(chenLogin.json.role, 'admin');
    assert.equal(chenLogin.json.must_change, true);
    const chenHeaders = { cookie: chenLogin.cookies.find(c => c.startsWith('sid=')).split(';')[0], 'Content-Type': 'application/json' };
    for (const url of ['/board', '/board/add', '/board/manage', '/admin']) {
      assert.equal((await hit(app.base, url, { headers: { cookie: chenHeaders.cookie } })).status, 200, url);
    }
    assert.equal((await hit(app.base, '/api/board', { headers: { cookie: chenHeaders.cookie } })).status, 200);
    assert.equal((await hit(app.base, '/api/me/inc', {
      method: 'POST', headers: chenHeaders, body: JSON.stringify({ field: 'appr_done', delta: 3 }),
    })).status, 200);

    const summary = await hit(app.base, '/api/admin/summary?view=week', { headers: { cookie: gary.cookie } });
    assert.equal(summary.json.rows.some(r => r.name === 'Chenchen'), false);
    assert.equal(summary.json.rows.some(r => r.name === 'Pat Agent'), true);
    const tv = await hit(app.base, '/api/tv');
    assert.equal(JSON.stringify(tv.json).includes('Chenchen'), false);
    const names = await hit(app.base, '/api/board/agents', { headers: { cookie: gary.cookie } });
    assert.equal(names.json.agents.some(a => a.name === 'Chenchen'), false);
    assert.equal(names.json.agents.some(a => a.name === 'Pat Agent'), true);
  } finally {
    await app.stop();
  }
});
