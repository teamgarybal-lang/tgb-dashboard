import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const Database = require('better-sqlite3');

const STAGES = ['Appraised', 'Appraisal Booked', 'Hot', 'Warm', 'Cold'];
// Exact old value -> new stage. This is the mapping the startup applies.
const MAPPING = [
  ['', 'Warm'],
  ['Expected', 'Warm'],
  ['Appraisal booked', 'Appraisal Booked'],
  ['Pre-approved', 'Warm'],
  ['Under offer', 'Warm'],
  ['appraised', 'Appraised'],
  ['appraisal done', 'Appraised'],
  ['appraisals done', 'Appraised'],
  ['appraisal booked', 'Appraisal Booked'],
  ['appraisals booked', 'Appraisal Booked'],
  ['hot', 'Hot'],
  ['WARM', 'Warm'],
  ['cold', 'Cold'],
  ['Maybe later', 'Warm'],
  ['  Appraisal   booked  ', 'Appraisal Booked'],
  ['Appraised', 'Appraised'],
  ['Appraisal Booked', 'Appraisal Booked'],
  ['Hot', 'Hot'],
  ['Warm', 'Warm'],
  ['Cold', 'Cold'],
];

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
    clearLogs() { logs = ''; },
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

test('pipeline stages replace the old list and migrate stored rows', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-stages-'));
  const port = 3224;
  let app = launch(data, port);
  await app.ready();
  const pw = fs.readFileSync(path.join(data, 'ADMIN_PASSWORD.txt'), 'utf8').match(/Temporary password: (.+)/)[1].trim();
  const login = await hit(app.base, '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'gary.bal@harcourts.co.nz', password: pw }),
  });
  assert.equal(login.status, 200);
  const gary = { cookie: login.cookies.find(c => c.startsWith('sid=')).split(';')[0], 'Content-Type': 'application/json' };
  const created = await hit(app.base, '/api/admin/users', {
    method: 'POST', headers: gary,
    body: JSON.stringify({ name: 'Pat Agent', email: 'pat.stages@example.com', password: 'agent-temp-1', role: 'agent' }),
  });
  const sam = await hit(app.base, '/api/admin/users', {
    method: 'POST', headers: gary,
    body: JSON.stringify({ name: 'Sam Agent', email: 'sam.stages@example.com', password: 'agent-temp-1', role: 'agent' }),
  });
  assert.equal(created.status, 200);
  assert.equal(sam.status, 200);
  await app.stop();

  const db = new Database(path.join(data, 'data.db'));
  const insert = db.prepare('INSERT INTO pipeline_entries(user_id,address,notes,stage) VALUES(?,?,?,?)');
  MAPPING.forEach(([oldStage], i) => insert.run(created.json.id, `row-${i}`, 'note', oldStage));
  db.prepare('DELETE FROM pipeline_legacy_migration WHERE user_id=?').run(sam.json.id);
  db.prepare('INSERT INTO entries(user_id,week_start,pipeline_count,pipeline_note) VALUES(?,?,?,?)')
    .run(sam.json.id, '2026-10-19', 2, '14 Queen Street');
  db.close();

  app = launch(data, port);
  await app.ready();
  const log = app.logs();
  assert.match(log, /Updated pipeline stages/);
  assert.match(log, /"Expected" -> Warm/);
  assert.match(log, /"Appraisal booked" -> Appraisal Booked/);
  assert.match(log, /"Pre-approved" -> Warm/);
  assert.match(log, /"Under offer" -> Warm/);
  assert.match(log, /"" -> Warm/);

  const check = new Database(path.join(data, 'data.db'), { readonly: true });
  const stored = check.prepare('SELECT address, stage FROM pipeline_entries WHERE user_id=? ORDER BY id').all(created.json.id);
  assert.equal(stored.length, MAPPING.length);
  stored.forEach((row, i) => assert.equal(row.stage, MAPPING[i][1], `${JSON.stringify(MAPPING[i][0])} -> ${row.stage}`));
  const legacy = check.prepare('SELECT address, stage FROM pipeline_entries WHERE user_id=?').all(sam.json.id);
  check.close();
  assert.deepEqual(legacy, [{ address: '14 Queen Street', stage: 'Warm' }]);

  const patLogin = await hit(app.base, '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'pat.stages@example.com', password: 'agent-temp-1' }),
  });
  const pat = { cookie: patLogin.cookies.find(c => c.startsWith('sid=')).split(';')[0], 'Content-Type': 'application/json' };
  const list = await hit(app.base, '/api/me/pipeline', { headers: pat });
  assert.deepEqual(list.json.stages, STAGES);
  assert.ok(list.json.entries.every(e => STAGES.includes(e.stage)));

  for (const stage of STAGES) {
    const added = await hit(app.base, '/api/me/pipeline', {
      method: 'POST', headers: pat,
      body: JSON.stringify({ address: `New ${stage} Road`, notes: `${stage} note`, stage }),
    });
    assert.equal(added.status, 200, stage);
    assert.equal(added.json.entry.stage, stage);
  }
  for (const stage of ['', 'Expected', 'Appraisal booked', 'Pre-approved', 'Under offer', 'hot']) {
    const rejected = await hit(app.base, '/api/me/pipeline', {
      method: 'POST', headers: pat,
      body: JSON.stringify({ address: 'Rejected Road', stage }),
    });
    assert.equal(rejected.status, 400, 'rejected ' + JSON.stringify(stage));
    assert.equal(rejected.json.error, 'Pick a stage');
  }
  const target = list.json.entries.find(e => e.address === 'row-1');
  assert.equal(target.stage, 'Warm');
  const edited = await hit(app.base, '/api/me/pipeline/' + target.id, {
    method: 'POST', headers: pat,
    body: JSON.stringify({ stage: 'Cold' }),
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.entry.stage, 'Cold');
  const badEdit = await hit(app.base, '/api/me/pipeline/' + target.id, {
    method: 'POST', headers: pat,
    body: JSON.stringify({ stage: 'Under offer' }),
  });
  assert.equal(badEdit.status, 400);

  const grouped = await hit(app.base, '/api/admin/pipeline?user_id=' + created.json.id, { headers: { cookie: gary.cookie } });
  assert.equal(grouped.status, 200);
  assert.equal(grouped.json.agents.length, 1);
  const shown = new Set(grouped.json.agents[0].entries.map(e => e.stage));
  for (const stage of STAGES) assert.ok(shown.has(stage), 'admin view shows ' + stage);
  assert.ok(!shown.has('Expected') && !shown.has('Pre-approved') && !shown.has('Under offer') && !shown.has('Appraisal booked'));

  const csv = await hit(app.base, '/api/admin/pipeline.csv?user_id=' + created.json.id, { headers: { cookie: gary.cookie } });
  assert.equal(csv.status, 200);
  assert.match(csv.text, /^name,email,address,notes,stage,/);
  for (const stage of STAGES) assert.ok(csv.text.includes(stage));
  assert.ok(!csv.text.includes('Pre-approved') && !csv.text.includes('Under offer') && !csv.text.includes(',Expected,'));

  const summary = await hit(app.base, '/api/admin/summary?view=week', { headers: { cookie: gary.cookie } });
  const tv = await hit(app.base, '/api/tv?key=' + summary.json.tv_key);
  assert.equal(tv.status, 200);
  assert.equal(typeof tv.json.totals.pipeline_count, 'number');
  assert.ok(tv.json.totals.pipeline_count >= STAGES.length);
  const tvBlob = JSON.stringify(tv.json);
  assert.ok(!tvBlob.includes('"stage"') && !tvBlob.includes('Queen Street') && !tvBlob.includes('New Appraised Road'));

  const shots = '/opt/cursor/artifacts/screenshots';
  fs.mkdirSync(shots, { recursive: true });
  let puppeteer = null;
  try { puppeteer = createRequire('/tmp/pw/package.json')('puppeteer-core'); } catch {}
  if (puppeteer && fs.existsSync('/usr/bin/google-chrome')) {
    const browser = await puppeteer.launch({
      executablePath: '/usr/bin/google-chrome', headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--force-device-scale-factor=1'],
    });
    try {
      const phone = await browser.newPage();
      await phone.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await phone.setCookie({ name: 'sid', value: pat.cookie.slice(4), url: app.base, httpOnly: true });
      await phone.goto(app.base + '/me', { waitUntil: 'networkidle0' });
      await phone.waitForSelector('#pstage option');
      const options = await phone.$$eval('#pstage option', nodes => nodes.map(n => n.value));
      assert.deepEqual(options, STAGES);
      await phone.$eval('#pipeForm', el => el.scrollIntoView({ block: 'center' }));
      await phone.evaluate(() => { document.querySelector('#pstage').size = 5; });
      const form = await phone.evaluateHandle(() => document.querySelector('#pipeForm').closest('.card'));
      await form.asElement().screenshot({ path: path.join(shots, 'agent_pipeline_stages.png') });

      const admin = await browser.newPage();
      await admin.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 });
      await admin.setCookie({ name: 'sid', value: gary.cookie.slice(4), url: app.base, httpOnly: true });
      await admin.goto(app.base + '/admin', { waitUntil: 'networkidle0' });
      await admin.waitForFunction(() => document.querySelector('#pipeBoard') && document.querySelector('#pipeBoard').textContent.includes('Appraised'));
      await admin.select('#pipeAgent', String(created.json.id));
      await admin.waitForFunction(() => {
        const t = document.querySelector('#pipeBoard').textContent;
        return t.includes('Pat Agent') && t.includes('Appraisal Booked') && t.includes('Hot') && t.includes('Cold') && !t.includes('Sam Agent');
      });
      const board = await admin.evaluateHandle(() => document.querySelector('#pipeBoard').closest('.card'));
      await board.asElement().screenshot({ path: path.join(shots, 'admin_pipeline_stages.png') });
    } finally {
      await browser.close();
    }
  }

  await app.stop();
  app = launch(data, port);
  await app.ready();
  assert.ok(!app.logs().includes('Updated pipeline stages'));
  const again = new Database(path.join(data, 'data.db'), { readonly: true });
  const after = again.prepare('SELECT stage FROM pipeline_entries WHERE user_id=? ORDER BY id').all(created.json.id).map(r => r.stage);
  again.close();
  const expectStages = MAPPING.map(([, next]) => next);
  expectStages[1] = 'Cold';
  assert.deepEqual(after.slice(0, MAPPING.length), expectStages);
  await app.stop();
});
