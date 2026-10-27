import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const Database = require('better-sqlite3');

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
  return { status: res.status, loc: res.headers.get('location'), cache: res.headers.get('cache-control'), text, json, cookies: res.headers.getSetCookie() };
}

test('the office TV opens at /tv with no code', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-public-tv-'));
  const app = launch(data, 3225);
  await app.ready();
  try {
    const pw = fs.readFileSync(path.join(data, 'ADMIN_PASSWORD.txt'), 'utf8').match(/Temporary password: (.+)/)[1].trim();
    const login = await hit(app.base, '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'gary.bal@harcourts.co.nz', password: pw }),
    });
    assert.equal(login.status, 200);
    const gary = { cookie: login.cookies.find(c => c.startsWith('sid=')).split(';')[0], 'Content-Type': 'application/json' };
    const created = await hit(app.base, '/api/admin/users', {
      method: 'POST', headers: gary,
      body: JSON.stringify({ name: 'Pat Agent', email: 'pat.tvpub@example.com', password: 'agent-temp-1', role: 'agent' }),
    });
    assert.equal(created.status, 200);
    const patLogin = await hit(app.base, '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pat.tvpub@example.com', password: 'agent-temp-1' }),
    });
    const pat = { cookie: patLogin.cookies.find(c => c.startsWith('sid=')).split(';')[0], 'Content-Type': 'application/json' };
    const secret = 'SECRET-FERN-8841 Hidden Grove';
    const added = await hit(app.base, '/api/me/pipeline', {
      method: 'POST', headers: pat,
      body: JSON.stringify({ address: secret, notes: 'private-note', stage: 'Warm' }),
    });
    assert.equal(added.status, 200);
    await hit(app.base, '/api/me/inc', { method: 'POST', headers: pat, body: JSON.stringify({ field: 'appr_done', delta: 1 }) });

    const summary = await hit(app.base, '/api/admin/summary?view=week', { headers: { cookie: gary.cookie } });
    const code = summary.json.tv_key;
    assert.match(code, /^[abcdefghjkmnpqrstuvwxyz23456789]{6}$/);

    const board = await hit(app.base, '/tv');
    assert.equal(board.status, 200);
    assert.match(board.text, /Team this week/);
    assert.match(board.text, /Leaderboard/);
    assert.doesNotMatch(board.text, /Type the 6-character TV code/);
    assert.equal(board.cache, 'no-store');
    const slash = await hit(app.base, '/tv/');
    assert.equal(slash.status, 200);
    assert.match(slash.text, /Team this week/);
    assert.equal(slash.text.includes(secret), false);

    const api = await hit(app.base, '/api/tv');
    assert.equal(api.status, 200);
    assert.equal(api.json.totals.pipeline_count, 1);
    assert.equal(api.json.totals.appr_done, 1);
    const blob = JSON.stringify(api.json);
    assert.equal(/SECRET-FERN|private-note|pat\.tvpub|pass_hash|tv_key|"email"|"address"/.test(blob), false);

    const byCode = await hit(app.base, '/tv/' + code);
    assert.equal(byCode.status, 302);
    assert.equal(byCode.loc, '/tv');
    assert.ok(byCode.cookies.some(c => c.startsWith('tv=' + code)));
    const byKey = await hit(app.base, '/tv?key=' + code);
    assert.equal(byKey.status, 302);
    assert.equal(byKey.loc, '/tv');
    const byApiKey = await hit(app.base, '/api/tv?key=' + code.toUpperCase());
    assert.equal(byApiKey.status, 200);
    assert.equal(byApiKey.json.brand, 'Harcourts TGB Group');

    const wrong = await hit(app.base, '/tv/zzzzzz');
    assert.equal(wrong.status, 403);
    assert.match(wrong.text, /That code is not right/);
    const stillOpen = await hit(app.base, '/api/tv');
    assert.equal(stillOpen.status, 200);

    const locked = await hit(app.base, '/api/admin/summary', {});
    assert.equal(locked.status, 401);
    const write = await hit(app.base, '/api/me/inc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ field: 'appr_done', delta: 1 }) });
    assert.equal(write.status, 401);
    const users = await hit(app.base, '/api/admin/users');
    assert.equal(users.status, 401);
    const pipe = await hit(app.base, '/api/me/pipeline');
    assert.equal(pipe.status, 401);

    const adminHtml = await hit(app.base, '/admin', { headers: { cookie: gary.cookie } });
    assert.equal(adminHtml.status, 200);
    assert.match(adminHtml.text, /id="tvlink"/);
    assert.match(adminHtml.text, /location\.origin\}\/tv`/);
    assert.doesNotMatch(adminHtml.text, /origin\}\/tv\/\$\{D\.tv_key\}/);

    const db = new Database(path.join(data, 'data.db'), { readonly: true });
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='tv_key'").get().value, code);
    db.close();
  } finally {
    await app.stop();
  }
});
