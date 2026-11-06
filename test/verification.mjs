import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const Database = require('better-sqlite3');
const opportunities = require(path.join(process.cwd(), 'opportunities.js'));
const verification = require(path.join(process.cwd(), 'verification.js'));

function memoryDb() {
  const db = new Database(':memory:');
  opportunities.migrate(db);
  verification.migrate(db);
  return db;
}

function fullCrawl(db) {
  db.prepare(`INSERT INTO oneroof_runs (started_at, finished_at, status, trigger, suburbs_done, suburbs_total, full_complete, message)
    VALUES ('2026-11-06T05:00:00+13:00', '2026-11-06T06:00:00+13:00', 'ok', 'schedule', 52, 52, 1, 'done')`).run();
}

function listing(over = {}) {
  return {
    url: 'https://www.oneroof.co.nz/property/auckland/manurewa/124-coxhead-road/ZnfZG',
    street: '124 Coxhead Road',
    suburb: 'Manurewa',
    district: 'Manukau City',
    office_name: 'Barfoot & Thompson Ltd - Manurewa',
    region: 'Auckland',
    category: 'House',
    listing_code: 'L1',
    uid: 'ZnfZG',
    slug: 'auckland/manurewa/124-coxhead-road/ZnfZG',
    listing_type: 'Residential for sale',
    bedrooms: 3,
    bathrooms: 1,
    carspaces: 1,
    land_area: null,
    floor_area: null,
    price_bold: 'By negotiation',
    price_light: null,
    asking_price: null,
    avm: 800000,
    avm_low: null,
    avm_high: null,
    rv: null,
    avm_confidence: null,
    agent_names: 'Ada Agent',
    agent_phones: '021000000',
    lat: null,
    lng: null,
    market_time: 1700000000,
    ...over,
  };
}

function page(body) {
  return `<!doctype html><html><head><title>Sold properties</title></head><body>${body}</body>
<footer>Sold properties. Recently sold. Browse sold homes.</footer></html>`;
}

test('agency pages confirm sold, withdrawn, or active only beside the address', () => {
  const home = listing();
  const sold = verification.classifyPage(page('<article>124 Coxhead Road, Manurewa Sold $750,000</article>'), home);
  assert.equal(sold.category, 'confirmed_sold');
  assert.match(sold.evidence_excerpt, /124/);
  assert.match(sold.evidence_excerpt, /Coxhead/i);
  assert.match(sold.evidence_excerpt, /Sold/);

  const withdrawn = verification.classifyPage(page('<article>124 Coxhead Road listing withdrawn</article>'), home);
  assert.equal(withdrawn.category, 'confirmed_withdrawn');

  const active = verification.classifyPage(page('<article>124 Coxhead Road for sale by negotiation</article>'), home);
  assert.equal(active.category, 'still_active');

  const footerOnly = verification.classifyPage(page('<p>Homes for sale in Manurewa</p>'), home);
  assert.equal(footerOnly.category, 'unverified');
  assert.match(footerOnly.note, /does not confirm a withdrawal/);

  const soldInFooter = verification.classifyPage(
    '<html><body><p>Current instructions</p></body><footer>124 Coxhead Road Sold</footer></html>',
    home
  );
  assert.equal(soldInFooter.category, 'unverified');

  const conflict = verification.classifyPage(page('<article>124 Coxhead Road Sold and still for sale</article>'), home);
  assert.equal(conflict.category, 'unverified');
  assert.match(conflict.conflict, /more than one status/);

  assert.equal(verification.classifyPage(page('<p>Sold</p>'), home).category, 'unverified');
});

test('private and redirected targets are rejected before a fetch', async () => {
  await assert.rejects(() => verification.assertPublicHttps('http://www.barfoot.co.nz/x', async () => ['1.1.1.1']));
  await assert.rejects(() => verification.assertPublicHttps('https://127.0.0.1/secret', async () => ['127.0.0.1']));
  await assert.rejects(() => verification.assertPublicHttps('https://169.254.169.254/latest', async () => ['169.254.169.254']));
  await assert.rejects(() => verification.assertPublicHttps('https://example.com/x', async () => ['10.1.1.1'], ['barfoot.co.nz']));
  const calls = [];
  await assert.rejects(() => verification.fetchPublic('https://www.barfoot.co.nz/properties/1', {
    fetchImpl: async (url) => {
      calls.push(url);
      return { status: 302, headers: { get: name => name === 'location' ? 'https://127.0.0.1/admin' : '' }, text: async () => '' };
    },
    lookup: async () => ['1.1.1.1'],
  }, ['barfoot.co.nz']));
  assert.deepEqual(calls, ['https://www.barfoot.co.nz/properties/1']);
  assert.equal(verification.isPrivateAddress('192.168.1.9'), true);
  assert.equal(verification.isPrivateAddress('1.1.1.1'), false);
});

test('an incomplete suburb crawl does not mark the missing homes disappeared', async () => {
  const db = memoryDb();
  const kept = listing({ url: 'https://www.oneroof.co.nz/property/auckland/manurewa/16-marr-road/lxAKt', street: '16 Marr Road' });
  const seen = listing();
  opportunities.saveSuburb(db, [kept, seen], {
    searchSlug: 'suburb_manurewa-manukau-city-679',
    nowIso: '2026-11-01T05:00:00+13:00',
    snapDate: '2026-11-01',
    now: new Date('2026-11-01T05:00:00+13:00'),
  });
  const html = `<script>self.__next_f.push([1,${JSON.stringify('9:{"totals":10,"pageIndex":1}\n41:' + JSON.stringify({
    street: '124 Coxhead Road', suburb: 'Manurewa', district: 'Manukau City',
    shareLink: seen.url, priceBold: 'By negotiation', marketTime: 1700000000,
  }))}])</script>`;
  const runner = opportunities.createRunner({
    db,
    suburbs: [{ slug: 'suburb_manurewa-manukau-city-679', suburb: 'Manurewa', district: 'Manukau City' }],
    delayMs: 0,
    sleep: async () => {},
    log: () => {},
    fetchImpl: async () => ({ status: 200, text: async () => html }),
  });
  const result = await runner.start('manual').done;
  assert.equal(result.status, 'ok');
  assert.match(result.message, /not marked disappeared/);
  const marr = db.prepare('SELECT disappeared_at, outcome FROM oneroof_listings WHERE street=?').get('16 Marr Road');
  assert.equal(marr.disappeared_at, null);
  assert.equal(marr.outcome, 'listed');
  assert.equal(db.prepare('SELECT full_complete FROM oneroof_runs ORDER BY id DESC LIMIT 1').get().full_complete, 0);
});

test('verification confirms only explicit evidence, resumes, and keeps an audit trail', async () => {
  const db = memoryDb();
  fullCrawl(db);
  const cox = listing();
  const other = listing({
    url: 'https://www.oneroof.co.nz/property/auckland/manurewa/16-marr-road/lxAKt',
    street: '16 Marr Road',
    office_name: 'Barfoot & Thompson Ltd - Manurewa',
  });
  opportunities.saveSuburb(db, [cox, other], {
    searchSlug: 'suburb_manurewa-manukau-city-679',
    nowIso: '2026-11-01T05:00:00+13:00', snapDate: '2026-11-01', now: new Date('2026-11-01T05:00:00+13:00'),
  });
  opportunities.saveSuburb(db, [], {
    searchSlug: 'suburb_manurewa-manukau-city-679',
    nowIso: '2026-11-06T05:00:00+13:00', snapDate: '2026-11-06', now: new Date('2026-11-06T05:00:00+13:00'),
  });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const checker = verification.createChecker({
    db,
    delayMs: 0,
    sleep: async () => {},
    log: () => {},
    lookup: async () => ['1.1.1.1'],
    fetchImpl: async (url) => {
      calls++;
      if (calls === 1) await gate;
      const html = String(url).includes('Coxhead')
        ? page('<article>124 Coxhead Road, Manurewa Sold $750,000</article>')
        : page('<p>Nothing about that street</p>');
      return { status: 200, headers: { get: () => '' }, text: async () => html };
    },
  });
  const first = checker.start('routine');
  await new Promise(resolve => setTimeout(resolve, 20));
  const second = checker.start('routine');
  assert.equal(second.started, false);
  assert.equal(second.reason, 'already-running');
  release();
  const done = await first.done;
  assert.equal(done.status, 'ok');
  assert.equal(done.confirmed_sold, 1);
  assert.equal(done.unverified, 1);
  const saved = db.prepare('SELECT category, evidence_excerpt, source_url FROM oneroof_listing_checks WHERE listing_url=?').get(cox.url);
  assert.equal(saved.category, 'confirmed_sold');
  assert.match(saved.evidence_excerpt, /Sold/);
  assert.match(saved.source_url, /^https:\/\/www\.barfoot\.co\.nz\//);
  const unknown = db.prepare('SELECT category FROM oneroof_listing_checks WHERE listing_url=?').get(other.url);
  assert.equal(unknown.category, 'unverified');

  const deferred = verification.createChecker({ db, baselineRunning: () => true, log: () => {} }).start('routine');
  assert.equal(deferred.deferred, true);
  assert.equal(deferred.started, false);

  db.prepare(`UPDATE oneroof_verification_runs SET status='interrupted' WHERE id=?`).run(done.id);
  db.prepare('DELETE FROM oneroof_verification_events WHERE listing_url=?').run(other.url);
  const againCalls = [];
  const resume = verification.createChecker({
    db,
    delayMs: 0,
    sleep: async () => {},
    log: () => {},
    lookup: async () => ['1.1.1.1'],
    fetchImpl: async () => {
      againCalls.push(1);
      return { status: 404, headers: { get: () => '' }, text: async () => 'missing' };
    },
  });
  const resumed = await resume.start('routine').done;
  assert.equal(resumed.status, 'ok');
  assert.equal(againCalls.length, 1);
  const missing = db.prepare('SELECT category, conflict FROM oneroof_listing_checks WHERE listing_url=?').get(other.url);
  assert.equal(missing.category, 'unverified');
  const events = db.prepare('SELECT category, note FROM oneroof_verification_events WHERE listing_url=? ORDER BY id').all(other.url);
  assert.match(events.at(-1).note, /404/);
  assert.match(events.at(-1).note, /does not confirm a withdrawal/);

  const filed = await verification.submitEvidence(db, {
    url: cox.url,
    category: 'confirmed_withdrawn',
    source_url: 'https://www.barfoot.co.nz/property/124-coxhead-road',
    evidence_excerpt: '124 Coxhead Road listing withdrawn',
    matched_listing_id: 'BF-1',
  }, async () => ['1.1.1.1']);
  assert.equal(filed.category, 'unverified');
  assert.match(filed.conflict, /Conflict/);
  const audit = db.prepare('SELECT COUNT(*) AS n FROM oneroof_verification_events WHERE listing_url=?').get(cox.url).n;
  assert.ok(audit >= 2);

  const bad = await verification.submitEvidence(db, {
    url: cox.url,
    category: 'confirmed_sold',
    source_url: 'https://127.0.0.1/sold',
    evidence_excerpt: '124 Coxhead Road Sold',
  }, async () => ['127.0.0.1']);
  assert.match(bad.error, /private|https|public/i);

  const footer = await verification.submitEvidence(db, {
    url: cox.url,
    category: 'confirmed_sold',
    source_url: 'https://www.barfoot.co.nz/sold',
    evidence_excerpt: 'Sold properties across Auckland',
  }, async () => ['1.1.1.1']);
  assert.match(footer.error, /street/);
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

test('admin verification endpoints defer, accept evidence, and export the report', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-verify-'));
  const app = launch(data, 3258);
  await app.ready();
  try {
    assert.equal((await hit(app.base, '/api/admin/opportunities/verification/status')).status, 401);
    const pw = fs.readFileSync(path.join(data, 'ADMIN_PASSWORD.txt'), 'utf8').match(/Temporary password: (.+)/)[1].trim();
    const login = await hit(app.base, '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'gary.bal@harcourts.co.nz', password: pw }),
    });
    const admin = { cookie: login.cookies.find(c => c.startsWith('sid=')).split(';')[0], 'Content-Type': 'application/json' };
    const early = await hit(app.base, '/api/admin/opportunities/verification/run', {
      method: 'POST', headers: admin, body: JSON.stringify({ trigger: 'routine' }),
    });
    assert.equal(early.status, 409);
    assert.equal(early.json.no_baseline, true);

    const db = new Database(path.join(data, 'data.db'));
    db.pragma('busy_timeout = 5000');
    opportunities.saveSuburb(db, [listing()], {
      searchSlug: 'suburb_manurewa-manukau-city-679',
      nowIso: '2026-11-06T05:00:00+13:00', snapDate: '2026-11-06', now: new Date('2026-11-06T05:00:00+13:00'),
      complete: false,
    });
    db.prepare(`INSERT INTO oneroof_runs (started_at, status, trigger, suburbs_done, suburbs_total, full_complete)
      VALUES ('2026-11-06T08:20:00+13:00', 'running', 'manual', 10, 52, 0)`).run();
    const blocked = await hit(app.base, '/api/admin/opportunities/verification/run', {
      method: 'POST', headers: admin, body: '{}',
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.deferred, true);
    db.prepare(`UPDATE oneroof_runs SET status='ok', finished_at='2026-11-06T09:00:00+13:00', suburbs_done=52, suburbs_total=52, full_complete=1`).run();
    db.prepare(`UPDATE oneroof_listings SET disappeared_at='2026-11-06T09:00:00+13:00', outcome='withdrawn'`).run();
    db.close();

    const filed = await hit(app.base, '/api/admin/opportunities/verification/evidence', {
      method: 'POST', headers: admin,
      body: JSON.stringify({
        url: listing().url,
        category: 'confirmed_sold',
        source_url: 'https://www.barfoot.co.nz/property/124-coxhead-road',
        evidence_excerpt: '124 Coxhead Road, Manurewa Sold $750,000',
        matched_listing_id: '944014',
      }),
    });
    assert.equal(filed.status, 200, filed.text);
    assert.equal(filed.json.category, 'confirmed_sold');
    const report = await hit(app.base, '/api/admin/opportunities/verification/report?category=confirmed_sold', { headers: { cookie: admin.cookie } });
    assert.equal(report.status, 200);
    assert.equal(report.json.rows.length, 1);
    assert.match(report.json.rows[0].evidence_excerpt, /Sold/);
    const csv = await hit(app.base, '/api/admin/opportunities/verification/report.csv', { headers: { cookie: admin.cookie } });
    assert.match(csv.text, /124 Coxhead Road/);
    assert.match(csv.text, /confirmed_sold/);
    assert.match(csv.text, /https:\/\/www\.barfoot\.co\.nz\/property\/124-coxhead-road/);
    const page = await hit(app.base, '/opportunities', { headers: { cookie: admin.cookie } });
    assert.match(page.text, /Agency check/);
    assert.match(page.text, /not confirmed withdrawn/);
    assert.match(page.text, /missing page/);
    assert.equal(app.logs().includes(pw), false);
  } finally {
    await app.stop();
  }
});
