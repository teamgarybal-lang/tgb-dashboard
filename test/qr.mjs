import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const Database = require('better-sqlite3');
const qr = require(path.join(process.cwd(), 'qr.js'));

const BODY = 'Hi Jovana, I\'d like a free appraisal of my property.\nName: \nProperty address: \nEmail: ';

test('sms links differ for iPhone and Android, and previews are bots', () => {
  assert.equal(qr.smsUri('+64226393317', 'Hi\nName: ', 'ios'), 'sms:+64226393317&body=Hi%0AName%3A%20');
  assert.equal(qr.smsUri('+64226393317', 'Hi\nName: ', 'android'), 'sms:+64226393317?body=Hi%0AName%3A%20');
  assert.equal(qr.isBot('facebookexternalhit/1.1'), true);
  assert.equal(qr.isBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), false);
  assert.equal(qr.deviceType('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'ios');
  assert.equal(qr.deviceType('Mozilla/5.0 (Linux; Android 14)'), 'android');
  assert.equal(qr.SEED_CODE, 'k7m3qp');
  assert.equal(qr.SEED_BODY, BODY);
  assert.equal(qr.trackingUrl('k7m3qp'), 'https://tgb-dashboard.onrender.com/q/k7m3qp');
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
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, buf, json, type: res.headers.get('content-type'), cookies: res.headers.getSetCookie() };
}

test('a scan is counted and opens the text, bots and dead links are not, and the IP is not stored', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-qr-'));
  const app = launch(data, 3268);
  await app.ready();
  try {
    const ip = '203.0.113.44';
    const iphone = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', 'X-Forwarded-For': ip };
    const scan = await hit(app.base, '/q/k7m3qp', { headers: iphone });
    assert.equal(scan.status, 200);
    assert.match(scan.text, /sms:\+64226393317&amp;body=/);
    assert.match(scan.text, /Text Jovana/);
    assert.match(scan.text, /do not know who you are/i);
    assert.match(scan.text, /Hi%20Jovana/);
    assert.match(scan.text, /free%20appraisal/);
    const android = await hit(app.base, '/q/k7m3qp', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel)', 'X-Forwarded-For': ip },
    });
    assert.match(android.text, /sms:\+64226393317\?body=/);

    const preview = await hit(app.base, '/q/k7m3qp', {
      headers: { 'User-Agent': 'facebookexternalhit/1.1', 'X-Forwarded-For': ip },
    });
    assert.equal(preview.status, 200);

    const db = new Database(path.join(data, 'data.db'), { readonly: true });
    const rows = db.prepare('SELECT device_type, bot, counted, visitor_hash FROM qr_scans ORDER BY id').all();
    assert.deepEqual(rows.map(row => ({ device_type: row.device_type, bot: row.bot, counted: row.counted })), [
      { device_type: 'ios', bot: 0, counted: 1 },
      { device_type: 'android', bot: 0, counted: 1 },
      { device_type: 'other', bot: 1, counted: 0 },
    ]);
    for (const row of rows) {
      assert.equal(row.visitor_hash.length, 64);
      assert.equal(row.visitor_hash.includes(ip), false);
      assert.equal(row.visitor_hash.includes('127.0.0.1'), false);
    }
    const dumped = JSON.stringify(db.prepare('SELECT * FROM qr_scans').all());
    assert.equal(dumped.includes(ip), false);
    assert.equal(dumped.includes('127.0.0.1'), false);
    const seed = db.prepare('SELECT label, agent_name, agent_mobile, sms_body FROM qr_links WHERE code=?').get('k7m3qp');
    assert.equal(seed.label, 'Gary & Jovana appraisal letter');
    assert.equal(seed.agent_name, 'Jovana Giudici');
    assert.equal(seed.agent_mobile, '+64226393317');
    assert.equal(seed.sms_body, BODY);
    db.close();

    const dead = await hit(app.base, '/q/nosuchcode', { headers: iphone });
    assert.equal(dead.status, 200);
    assert.match(dead.text, /not available/);
    assert.match(dead.text, /022 639 3317/);
    assert.doesNotMatch(dead.text, /sms:/);
    assert.doesNotMatch(dead.text, /free appraisal/);

    const pw = fs.readFileSync(path.join(data, 'ADMIN_PASSWORD.txt'), 'utf8').match(/Temporary password: (.+)/)[1].trim();
    assert.equal((await hit(app.base, '/api/admin/qr')).status, 401);
    const login = await hit(app.base, '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'gary.bal@harcourts.co.nz', password: pw }),
    });
    const admin = { cookie: login.cookies.find(c => c.startsWith('sid=')).split(';')[0], 'Content-Type': 'application/json' };
    const list = await hit(app.base, '/api/admin/qr', { headers: { cookie: admin.cookie } });
    assert.equal(list.status, 200);
    assert.equal(list.json.links[0].scans, 2);
    assert.equal(list.json.links[0].unique_scans, 2);
    const png = await hit(app.base, '/api/admin/qr/k7m3qp/code.png', { headers: { cookie: admin.cookie } });
    assert.equal(png.status, 200);
    assert.match(png.type, /image\/png/);
    assert.equal(png.buf[0], 0x89);
    const svg = await hit(app.base, '/api/admin/qr/k7m3qp/code.svg', { headers: { cookie: admin.cookie } });
    assert.match(svg.text, /<svg/);
    const QRCode = require('qrcode');
    const expectedSvg = await QRCode.toString(qr.trackingUrl('k7m3qp'), { type: 'svg', errorCorrectionLevel: 'H', margin: 4 });
    assert.equal(svg.text, expectedSvg);
    const csv = await hit(app.base, '/api/admin/qr/scans.csv', { headers: { cookie: admin.cookie } });
    assert.match(csv.text, /k7m3qp/);
    assert.equal(csv.text.includes(ip), false);

    const paused = await hit(app.base, '/api/admin/qr/k7m3qp', {
      method: 'POST', headers: admin, body: JSON.stringify({ active: false }),
    });
    assert.equal(paused.status, 200);
    const closed = await hit(app.base, '/q/k7m3qp', { headers: iphone });
    assert.match(closed.text, /not available/);
    assert.doesNotMatch(closed.text, /sms:/);
    const after = new Database(path.join(data, 'data.db'), { readonly: true });
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM qr_scans WHERE counted=1').get().n, 2);
    after.close();

    const made = await hit(app.base, '/api/admin/users', {
      method: 'POST', headers: admin,
      body: JSON.stringify({ name: 'Pat Agent', email: 'pat.qr@example.com', password: 'agent-temp-1' }),
    });
    assert.equal(made.status, 200);
    const agentLogin = await hit(app.base, '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pat.qr@example.com', password: 'agent-temp-1' }),
    });
    const agent = { cookie: agentLogin.cookies.find(c => c.startsWith('sid=')).split(';')[0] };
    assert.equal((await hit(app.base, '/api/admin/qr', { headers: agent })).status, 403);
    assert.equal((await hit(app.base, '/qr', { headers: agent })).status, 302);
    const adminPage = await hit(app.base, '/qr', { headers: { cookie: admin.cookie } });
    assert.equal(adminPage.status, 200);
    assert.match(adminPage.text, /Gary &amp; Jovana appraisal letter|Letter QR/);
    assert.equal(app.logs().includes(ip), false);
    assert.equal(app.logs().includes(pw), false);
  } finally {
    await app.stop();
  }
});
