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
  return { status: res.status, text, json, cookies: res.headers.getSetCookie() };
}

function snapshot(data) {
  const db = new Database(path.join(data, 'data.db'));
  const n = sql => db.prepare(sql).get().n;
  const out = {
    users: n('SELECT COUNT(*) AS n FROM users'),
    sessions: n('SELECT COUNT(*) AS n FROM sessions'),
    settings: n('SELECT COUNT(*) AS n FROM settings'),
    day_entries: n('SELECT COUNT(*) AS n FROM day_entries'),
    entries: n('SELECT COUNT(*) AS n FROM entries'),
    activity: n('SELECT COUNT(*) AS n FROM activity'),
    weekly_metric_migration: n('SELECT COUNT(*) AS n FROM weekly_metric_migration'),
    pipeline_entries: n('SELECT COUNT(*) AS n FROM pipeline_entries'),
    pipeline_legacy_migration: n('SELECT COUNT(*) AS n FROM pipeline_legacy_migration'),
    board_listings: n('SELECT COUNT(*) AS n FROM board_listings'),
    legacy_day: n("SELECT COUNT(*) AS n FROM day_entries WHERE day='2020-01-06'"),
    legacy_note_as_address: n("SELECT COUNT(*) AS n FROM pipeline_entries WHERE address LIKE 'old weekly note%'"),
    tv_key: db.prepare("SELECT value FROM settings WHERE key='tv_key'").get().value,
    targets: db.prepare("SELECT value FROM settings WHERE key='targets'").get().value,
    emails: db.prepare('SELECT email FROM users ORDER BY email').all().map(r => r.email),
    pipeline: db.prepare('SELECT address, notes, stage FROM pipeline_entries ORDER BY id').all(),
    board: db.prepare('SELECT address, status FROM board_listings ORDER BY id').all(),
  };
  db.close();
  return out;
}

test('admin clear-activity wipes KPI history and leaves people, pipeline, and listings', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-clear-activity-'));
  const port = 3246;
  let app = launch(data, port);
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
      body: JSON.stringify({ name: 'Pat Agent', email: 'pat.clear@example.com', password: 'agent-temp-1', role: 'agent' }),
    });
    assert.equal(created.status, 200);
    const patLogin = await hit(app.base, '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pat.clear@example.com', password: 'agent-temp-1' }),
    });
    const pat = { cookie: patLogin.cookies.find(c => c.startsWith('sid=')).split(';')[0], 'Content-Type': 'application/json' };
    assert.equal((await hit(app.base, '/api/me', { headers: { cookie: pat.cookie } })).status, 200);
    assert.equal((await hit(app.base, '/api/me/inc', {
      method: 'POST', headers: pat, body: JSON.stringify({ field: 'appr_done', delta: 2 }),
    })).status, 200);
    assert.equal((await hit(app.base, '/api/me/inc', {
      method: 'POST', headers: pat, body: JSON.stringify({ field: 'door_knocks', delta: 4 }),
    })).status, 200);
    const address = '14 Clear Keep Street';
    assert.equal((await hit(app.base, '/api/me/pipeline', {
      method: 'POST', headers: pat,
      body: JSON.stringify({ address, notes: 'keep this address', stage: 'Hot' }),
    })).status, 200);
    const today = (await hit(app.base, '/api/tv')).json.today;
    const listing = '9 Board Keep Road';
    assert.equal((await hit(app.base, '/api/board/items', {
      method: 'POST', headers: gary,
      body: JSON.stringify({ status: 'new', address: listing, listed_on: today }),
    })).status, 200);

    await app.stop();
    const db = new Database(path.join(data, 'data.db'));
    const patId = db.prepare('SELECT id FROM users WHERE email=?').get('pat.clear@example.com').id;
    db.prepare(`INSERT INTO entries(user_id, week_start, door_knocks, cold_calls, appr_booked, appr_done, pipeline_count, pipeline_note)
      VALUES(?, '2020-01-06', 9, 8, 7, 6, 4, 'old weekly note that must not become a new address')`).run(patId);
    db.prepare("INSERT INTO activity(user_id, day, ts, field, value) VALUES(?, '2020-01-06', datetime('now'), 'day', 'legacy')").run(patId);
    db.close();

    app = launch(data, port);
    await app.ready();
    const before = await hit(app.base, '/api/tv');
    assert.equal(before.json.totals.appr_done, 2);
    assert.equal(before.json.totals.appr_booked, 0);
    assert.equal(before.json.totals.door_knocks, 4);
    assert.equal(before.json.totals.pipeline_count, 1);
    assert.equal(before.json.rows.some(r => r.name === 'Pat Agent' && r.score === 10), true);
    const oldWeek = await hit(app.base, '/api/admin/summary?view=week&week=2020-01-06', { headers: { cookie: gary.cookie } });
    assert.equal(oldWeek.status, 200);
    const patOld = oldWeek.json.rows.find(r => r.name === 'Pat Agent');
    assert.equal(patOld.appr_done, 6);
    assert.equal(patOld.appr_booked, 7);
    assert.equal(patOld.cold_calls, 8);
    assert.equal(patOld.door_knocks, 9);
    assert.equal(patOld.score, 51);

    const get = await hit(app.base, '/api/admin/clear-activity', { method: 'GET', headers: { cookie: gary.cookie } });
    assert.equal(get.status, 404);
    const anon = await hit(app.base, '/api/admin/clear-activity', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(anon.status, 401);
    const notJson = await hit(app.base, '/api/admin/clear-activity', {
      method: 'POST', headers: { cookie: gary.cookie }, body: '{}',
    });
    assert.equal(notJson.status, 415);
    const agent = await hit(app.base, '/api/admin/clear-activity', {
      method: 'POST', headers: pat, body: '{}',
    });
    assert.equal(agent.status, 403);
    const still = await hit(app.base, '/api/tv');
    assert.equal(still.json.totals.appr_done, 2);
    assert.equal(still.json.totals.pipeline_count, 1);
    const stillOld = await hit(app.base, '/api/admin/summary?view=week&week=2020-01-06', { headers: { cookie: gary.cookie } });
    assert.equal(stillOld.json.rows.find(r => r.name === 'Pat Agent').appr_done, 6);

    const cleared = await hit(app.base, '/api/admin/clear-activity', {
      method: 'POST', headers: gary, body: '{}',
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.json, {
      ok: true,
      deleted: { day_entries: 2, entries: 2, activity: 3, weekly_metric_migration: 2 },
    });
    assert.match(app.logs(), /cleared KPI activity/);
    const after = await hit(app.base, '/api/tv');
    assert.equal(after.json.totals.appr_done, 0);
    assert.equal(after.json.totals.appr_booked, 0);
    assert.equal(after.json.totals.cold_calls, 0);
    assert.equal(after.json.totals.door_knocks, 0);
    assert.equal(after.json.totals.letter_drops, 0);
    assert.equal(after.json.totals.pipeline_count, 1);
    assert.equal(after.json.rows.some(r => r.name === 'Pat Agent' && r.score === 0 && r.pipeline_count === 1), true);
    const summary = await hit(app.base, '/api/admin/summary?view=week', { headers: { cookie: gary.cookie } });
    assert.equal(summary.status, 200);
    assert.equal(summary.json.totals.appr_done, 0);
    const history = await hit(app.base, '/api/admin/agent/' + created.json.id + '/history', { headers: { cookie: gary.cookie } });
    assert.deepEqual(history.json, []);
    const csv = await hit(app.base, '/api/admin/export.csv?grain=day&all=1', { headers: { cookie: gary.cookie } });
    assert.equal(csv.text.trim(), 'day,name,email,appr_done,appr_booked,cold_calls,door_knocks,letter_drops,updated_at');
    const board = await hit(app.base, '/api/board', { headers: { cookie: gary.cookie } });
    assert.equal(board.json.new.some(r => r.address === listing), true);
    const users = await hit(app.base, '/api/admin/users', { headers: { cookie: gary.cookie } });
    assert.deepEqual(users.json.map(u => u.email).sort(), ['gary.bal@harcourts.co.nz', 'pat.clear@example.com']);
    const again = await hit(app.base, '/api/admin/clear-activity', {
      method: 'POST', headers: gary, body: '{}',
    });
    assert.deepEqual(again.json.deleted, { day_entries: 0, entries: 0, activity: 0, weekly_metric_migration: 0 });

    await app.stop();
    const wiped = snapshot(data);
    assert.equal(wiped.day_entries, 0);
    assert.equal(wiped.entries, 0);
    assert.equal(wiped.activity, 0);
    assert.equal(wiped.weekly_metric_migration, 0);
    assert.equal(wiped.legacy_day, 0);
    assert.equal(wiped.users, 2);
    assert.equal(wiped.sessions, 2);
    assert.equal(wiped.pipeline_entries, 1);
    assert.equal(wiped.pipeline[0].address, address);
    assert.equal(wiped.pipeline[0].stage, 'Hot');
    assert.equal(wiped.legacy_note_as_address, 0);
    assert.equal(wiped.board_listings, 1);
    assert.equal(wiped.board[0].address, listing);
    assert.equal(wiped.pipeline_legacy_migration, 2);
    const tvKey = wiped.tv_key;
    const targets = wiped.targets;
    assert.ok(tvKey);
    assert.match(targets, /appr_done/);

    app = launch(data, port);
    await app.ready();
    const restarted = await hit(app.base, '/api/tv');
    assert.equal(restarted.json.totals.appr_done, 0);
    assert.equal(restarted.json.totals.pipeline_count, 1);
    const oldAfterBoot = await hit(app.base, '/api/admin/summary?view=week&week=2020-01-06', { headers: { cookie: gary.cookie } });
    assert.equal(oldAfterBoot.json.rows.find(r => r.name === 'Pat Agent').appr_done, 0);
    assert.equal(oldAfterBoot.json.totals.door_knocks, 0);
    assert.equal((await hit(app.base, '/api/me', { headers: { cookie: pat.cookie } })).status, 200);
    await app.stop();
    app = launch(data, port);
    await app.ready();
    const stillClear = await hit(app.base, '/api/tv');
    assert.equal(stillClear.json.totals.appr_done, 0);
    assert.equal(stillClear.json.totals.door_knocks, 0);
    assert.equal(stillClear.json.totals.pipeline_count, 1);
    const oldStill = await hit(app.base, '/api/admin/summary?view=week&week=2020-01-06', { headers: { cookie: gary.cookie } });
    assert.equal(oldStill.json.rows.find(r => r.name === 'Pat Agent').appr_done, 0);
    const kept = await hit(app.base, '/api/admin/summary?view=week', { headers: { cookie: gary.cookie } });
    assert.equal(kept.json.tv_key, tvKey);
    assert.equal(JSON.stringify(kept.json.targets), targets);
    await app.stop();
    const finalDb = snapshot(data);
    assert.equal(finalDb.day_entries, 0);
    assert.equal(finalDb.legacy_day, 0);
    assert.equal(finalDb.activity, 0);
    assert.equal(finalDb.entries, 1);
    assert.equal(finalDb.weekly_metric_migration, 1);
    assert.equal(finalDb.pipeline_entries, 1);
    assert.equal(finalDb.board_listings, 1);
    assert.equal(finalDb.users, 2);
    assert.equal(finalDb.sessions, 2);
    assert.deepEqual(finalDb.emails, ['gary.bal@harcourts.co.nz', 'pat.clear@example.com']);
    app = null;
  } finally {
    if (app) await app.stop();
  }
});
