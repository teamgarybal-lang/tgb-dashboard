import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const Database = require('better-sqlite3');
const opportunities = require(path.join(process.cwd(), 'opportunities.js'));

const fixture = fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'oneroof-hingaia-page1.html'), 'utf8');

function memoryDb() {
  const db = new Database(':memory:');
  opportunities.migrate(db);
  return db;
}

function flightHtml(rows) {
  const payload = rows.map(([id, value]) => id + ':' + JSON.stringify(value)).join('\n');
  const embedded = JSON.stringify(payload).slice(1, -1);
  return `<!doctype html><script>self.__next_f.push([1,"${embedded}"])</script>`;
}

function listing(over) {
  return {
    url: 'https://www.oneroof.co.nz/property/auckland/manurewa/36-ramwall-place/AAA',
    listing_code: 'L1',
    uid: 'AAA',
    slug: 'auckland/manurewa/36-ramwall-place/AAA',
    street: '36 Ramwall Place',
    suburb: 'Manurewa',
    district: 'Manukau City',
    region: 'Auckland',
    category: 'House',
    listing_type: 'Residential for sale',
    bedrooms: 3,
    bathrooms: 2,
    carspaces: 1,
    land_area: '500',
    floor_area: '120',
    price_bold: 'Asking price $900,000',
    price_light: null,
    asking_price: 900000,
    market_time: Math.floor(Date.parse('2026-07-28T00:00:00+12:00') / 1000),
    avm: 950000,
    avm_low: 900000,
    avm_high: 1000000,
    rv: 880000,
    avm_confidence: 'High',
    agent_names: 'Don Ha',
    agent_phones: '021968309',
    office_name: 'Harcourts TGB',
    lat: '-37.0',
    lng: '174.8',
    ...over,
  };
}

test('a saved OneRoof page keeps each street with its own URL', () => {
  const parsed = opportunities.parseOneRoofHtml(fixture);
  assert.equal(parsed.totals, 2);
  assert.equal(parsed.listings.length, 2);
  for (const row of parsed.listings) {
    assert.equal(opportunities.addressMatchesUrl(row.street, row.url), true, row.street + ' ' + row.url);
  }
  const gazala = parsed.listings.find(row => row.street === '54 Gazala Road');
  const evergreen = parsed.listings.find(row => row.street === '33 Evergreen Parade');
  assert.ok(gazala.url.endsWith('/54-gazala-road/1R43j'));
  assert.equal(gazala.agent_names, 'Kimberly Kim; Madu Kari');
  assert.match(gazala.agent_phones, /021941101/);
  assert.match(gazala.office_name, /LJ Hooker/);
  assert.equal(gazala.asking_price, null);
  assert.equal(gazala.rv, 610000);
  assert.equal(evergreen.avm, 1775000);
  assert.equal(evergreen.avm_low, 1595000);
  assert.equal(evergreen.bedrooms, 5);
  assert.equal(evergreen.category, 'House');
});

test('neighbouring listings do not swap street and URL', () => {
  const html = flightHtml([
    ['41', {
      street: '36 Ramwall Place', suburb: 'Manurewa', district: 'Manukau City', region: 'Auckland',
      shareLink: 'https://www.oneroof.co.nz/property/auckland/manurewa/36-ramwall-place/AAA',
      code: 'L1', uid: 'AAA', marketTime: 1688076000, priceBold: 'Price by Negotiation',
      bedrooms: 3, category: 'House', agents: '$5b', office: '$5e', avm: null, rv: '$$630,000',
    }],
    ['5c', { name: 'Don Ha', phoneNumber: '021968309' }],
    ['5d', { name: 'Ketan Patel', phoneNumber: '0212628041' }],
    ['5b', ['$5c', '$5d']],
    ['5e', { name: 'Harcourts TGB' }],
    ['42', {
      street: '1/143 Sykes Road', suburb: 'Manurewa', district: 'Manukau City', region: 'Auckland',
      shareLink: 'https://www.oneroof.co.nz/property/auckland/manurewa/1-143-sykes-road/BBB',
      code: 'L2', uid: 'BBB', marketTime: 1688076000, priceBold: 'Asking price $700,000',
      bedrooms: 3, category: 'House', agents: '$5b', office: '$5e', avm: '$5f',
    }],
    ['5f', { avm: '$$710,000', low: '$$680,000', high: '$$740,000', rv: '$$690,000', confidenceScore: 'High' }],
    ['43', {
      street: '14 Timata Lane', suburb: 'Favona', district: 'Manukau City',
      shareLink: 'https://www.oneroof.co.nz/property/auckland/favona/14-timata-lane/ZZZ',
      priceBold: '$$575,000', category: 'House', marketTime: 1688076000,
    }],
    ['7', { totals: 2, pageIndex: 1 }],
  ]);
  const parsed = opportunities.parseOneRoofHtml(html);
  assert.equal(parsed.listings.length, 3);
  const timata = parsed.listings.find(row => row.street === '14 Timata Lane');
  assert.equal(timata.price_bold, '$575,000');
  assert.equal(timata.asking_price, 575000);
  const ramwall = parsed.listings.find(row => row.url.endsWith('/36-ramwall-place/AAA'));
  const sykes = parsed.listings.find(row => row.url.endsWith('/1-143-sykes-road/BBB'));
  assert.equal(ramwall.street, '36 Ramwall Place');
  assert.equal(sykes.street, '1/143 Sykes Road');
  assert.equal(sykes.asking_price, 700000);
  assert.equal(sykes.avm, 710000);
  assert.equal(ramwall.agent_names, 'Don Ha; Ketan Patel');
  assert.equal(ramwall.office_name, 'Harcourts TGB');
  assert.equal(opportunities.addressKey('Unit 1, 143 Sykes Road', 'Manurewa'), opportunities.addressKey(sykes.street, sykes.suburb));
  assert.equal(opportunities.addressMatchesUrl('5 & 5A Yearsley Place', 'https://www.oneroof.co.nz/property/auckland/manurewa/5-5a-yearsley-place/n7xU7'), true);
});

test('snapshots record price cuts, withdrawals and REINZ sales', () => {
  const db = memoryDb();
  const now = new Date('2026-11-05T05:00:00+13:00');
  const ramwall = listing({});
  const sykes = listing({
    url: 'https://www.oneroof.co.nz/property/auckland/manurewa/1-143-sykes-road/BBB',
    street: '1/143 Sykes Road',
    asking_price: 700000,
    price_bold: 'Asking price $700,000',
    avm: 710000,
    agent_names: 'Aroha Lee',
    agent_phones: '021000111',
  });
  const active = listing({
    url: 'https://www.oneroof.co.nz/property/auckland/manurewa/5-browns-road/CCC',
    street: '5 Browns Road',
    asking_price: 800000,
    price_bold: 'Asking price $800,000',
  });
  opportunities.saveSuburb(db, [ramwall, sykes, active], {
    searchSlug: 'suburb_manurewa-manukau-city-679',
    nowIso: '2026-11-01T05:00:00+13:00',
    snapDate: '2026-11-01',
    now: new Date('2026-11-01T05:00:00+13:00'),
  });
  opportunities.saveSuburb(db, [{ ...ramwall, asking_price: 850000, price_bold: 'Asking price $850,000' }, active], {
    searchSlug: 'suburb_manurewa-manukau-city-679',
    nowIso: '2026-11-05T05:00:00+13:00',
    snapDate: '2026-11-05',
    now,
  });
  const cut = db.prepare('SELECT price_cut, price_cut_from, price_cut_to, outcome FROM oneroof_listings WHERE street=?').get('36 Ramwall Place');
  assert.equal(cut.price_cut, 1);
  assert.equal(cut.price_cut_from, 900000);
  assert.equal(cut.price_cut_to, 850000);
  assert.equal(cut.outcome, 'listed');
  const gone = db.prepare('SELECT outcome, disappeared_at FROM oneroof_listings WHERE street=?').get('1/143 Sykes Road');
  assert.equal(gone.outcome, 'withdrawn');
  assert.ok(gone.disappeared_at);

  const csv = [
    'Property Address,Suburb,Sold Price,Sale Date,List Price,Settlement Date,Agreement Date,Days To Sell,Sale Category,Sale Method,Valuation,Organisation,Bedrooms,Floor Area,Land Area,New Dwelling,Sale Tenure,Notes',
    '"Unit 1, 143 Sykes Road",Manurewa,"$820,000",01/10/2026,799000,15/10/2026,28/09/2026,40,House,Auction,"$760,000",Barfoot,3,120,400,No,Freehold,ignore me',
    '5 Browns Road,Manurewa,810000,02/10/2026,,,,,,,,,,,,,',
  ].join('\n');
  const imported = opportunities.importReinzCsv(db, csv);
  assert.equal(imported.inserted, 2);
  assert.equal(imported.sold, 1);
  const sold = db.prepare('SELECT outcome, sale_price, sale_date FROM oneroof_listings WHERE street=?').get('1/143 Sykes Road');
  assert.equal(sold.outcome, 'sold');
  assert.equal(sold.sale_price, 820000);
  assert.equal(sold.sale_date, '2026-10-01');
  const still = db.prepare('SELECT outcome FROM oneroof_listings WHERE street=?').get('5 Browns Road');
  assert.equal(still.outcome, 'listed');

  const view = opportunities.queryOpportunities(db, { type: 'sold' }, now);
  assert.equal(view.rows.length, 1);
  assert.match(view.rows[0].reason, /Sold for/);
  assert.match(view.rows[0].reason, /REINZ/);
  const long = opportunities.queryOpportunities(db, {}, now).rows.find(row => row.street === '36 Ramwall Place');
  assert.ok(long.days >= 90);
  assert.equal(long.reason.includes('Still listed after 90+ days - approach with a fresh plan'), true);
  assert.match(long.reason, /Asking dropped from/);
  const csvOut = opportunities.toCsv(opportunities.rowsForExport(db, { urls: [sykes.url] }, now));
  assert.match(csvOut, /1\/143 Sykes Road/);
  assert.doesNotMatch(csvOut, /Ramwall/);
  assert.match(csvOut, /^address,suburb,/);

  const tricky = listing({
    url: 'https://www.oneroof.co.nz/property/auckland/manurewa/1-example-road/DDD',
    street: '=HYPERLINK("http://example.test")',
    asking_price: null,
    price_bold: 'Price by Negotiation',
  });
  opportunities.saveSuburb(db, [tricky], {
    searchSlug: 'suburb_other',
    nowIso: '2026-11-05T05:00:00+13:00',
    snapDate: '2026-11-05',
    now,
  });
  const exported = opportunities.toCsv(opportunities.queryOpportunities(db, { suburb: 'Manurewa' }, now).rows.filter(row => row.street.startsWith('=')));
  assert.match(exported, /'=HYPERLINK/);
});

test('a blocked page does not mark the suburb withdrawn, and a run cannot overlap itself', async () => {
  const db = memoryDb();
  const suburb = opportunities.loadSuburbs().find(s => s.slug === 'suburb_hingaia-papakura-4325');
  assert.equal(opportunities.loadSuburbs().length, 52);
  opportunities.saveSuburb(db, [listing({
    url: 'https://www.oneroof.co.nz/property/auckland/hingaia/54-gazala-road/1R43j',
    street: '54 Gazala Road',
    suburb: 'Hingaia',
    district: 'Papakura',
  })], {
    searchSlug: suburb.slug,
    nowIso: '2026-11-01T05:00:00+13:00',
    snapDate: '2026-11-01',
    now: new Date('2026-11-01T05:00:00+13:00'),
  });
  const blocked = opportunities.createRunner({
    db,
    suburbs: [suburb],
    delayMs: 0,
    sleep: async () => {},
    log: () => {},
    fetchImpl: async () => ({ status: 200, text: async () => '<html>Just a moment</html>' }),
  });
  const blockedResult = await blocked.start('manual').done;
  assert.equal(blockedResult.status, 'blocked');
  assert.equal(db.prepare('SELECT disappeared_at FROM oneroof_listings').get().disappeared_at, null);

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const runner = opportunities.createRunner({
    db,
    suburbs: [suburb],
    delayMs: 0,
    sleep: async () => {},
    log: () => {},
    fetchImpl: async () => {
      calls++;
      if (calls === 1) await gate;
      return { status: 200, text: async () => fixture };
    },
  });
  const first = runner.start('manual');
  await new Promise(resolve => setTimeout(resolve, 20));
  const second = runner.start('manual');
  assert.equal(second.started, false);
  assert.equal(runner.status().running, true);
  const during = opportunities.queryOpportunities(db, {});
  assert.equal(during.total, 1);
  release();
  const finished = await first.done;
  assert.equal(finished.status, 'ok');
  assert.equal(finished.listings_seen, 2);
  await second.done;
  const again = runner.start('manual');
  assert.equal(again.started, true);
  await again.done;
  const rows = db.prepare('SELECT street FROM oneroof_listings WHERE search_slug=? ORDER BY street').all(suburb.slug);
  assert.deepEqual(rows.map(row => row.street), ['33 Evergreen Parade', '54 Gazala Road']);
});

test('the next collection is 5:00am Auckland, including daylight saving', () => {
  const early = opportunities.nextAucklandHour(5, 0, new Date('2026-11-04T15:30:00Z'));
  assert.equal(new Date(early).toISOString(), '2026-11-04T16:00:00.000Z');
  const exact = opportunities.nextAucklandHour(5, 0, new Date('2026-11-04T16:00:00Z'));
  assert.equal(new Date(exact).toISOString(), '2026-11-05T16:00:00.000Z');
  const winter = opportunities.nextAucklandHour(5, 0, new Date('2026-06-30T16:00:00Z'));
  assert.equal(new Date(winter).toISOString(), '2026-06-30T17:00:00.000Z');
  assert.equal(opportunities.daysOnMarket(Math.floor(Date.parse('2026-01-01T00:00:00+13:00') / 1000), new Date('2026-04-11T12:00:00+12:00')), 100);
});

test('auction dates are not asking prices, and search price drives the estimate gap', () => {
  assert.equal(opportunities.parseMoney('17 Nov 2026 11:00'), null);
  assert.equal(opportunities.parseMoney('2026'), null);
  assert.equal(opportunities.parseMoney(2026), null);
  assert.equal(opportunities.parseMoney('Auction'), null);
  assert.equal(opportunities.parseMoney('By negotiation'), null);
  assert.equal(opportunities.parseMoney('Deadline Sale 11th Nov'), null);
  assert.equal(opportunities.parseMoney('750000'), 750000);
  assert.equal(opportunities.parseMoney('$$575,000'), 575000);
  assert.equal(opportunities.parseMoney('Enquiries Over $460,000'), 460000);
  assert.equal(opportunities.parseMoney('Asking price $1,125,000'), 1125000);

  const html = flightHtml([
    ['41', {
      street: '124 Coxhead Road', suburb: 'Manurewa', district: 'Manukau City',
      shareLink: 'https://www.oneroof.co.nz/property/auckland/manurewa/124-coxhead-road/ZnfZG',
      priceBold: 'By negotiation', priceSearch: '750000', priceLight: null, marketTime: 1700000000,
      avm: { avm: '$$800,000', low: '$$720,000', high: '$$880,000', confidenceScore: 'High' },
    }],
    ['42', {
      street: '16 Marr Road', suburb: 'Manurewa',
      shareLink: 'https://www.oneroof.co.nz/property/auckland/manurewa/16-marr-road/lxAKt',
      priceBold: 'Auction', priceLight: '17 Nov 2026 11:00', priceSearch: '925000', marketTime: 1700000000,
    }],
  ]);
  const parsed = opportunities.parseOneRoofHtml(html);
  const cox = parsed.listings.find(row => row.street === '124 Coxhead Road');
  const marr = parsed.listings.find(row => row.street === '16 Marr Road');
  assert.equal(cox.asking_price, null);
  assert.equal(cox.price_search, 750000);
  assert.equal(cox.avm, 800000);
  assert.equal(marr.asking_price, null);
  assert.equal(marr.price_search, 925000);
  assert.equal(opportunities.parseDetailPage(html, cox.url).price_search, 750000);

  const db = memoryDb();
  const when = { nowIso: '2026-11-05T05:00:00+13:00', snapDate: '2026-11-05', now: new Date('2026-11-05T05:00:00+13:00') };
  opportunities.saveSuburb(db, [cox], { ...when, searchSlug: 'suburb_manurewa-manukau-city-679' });
  const view = opportunities.queryOpportunities(db, { type: 'under' }, when.now);
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0].price_search, 750000);
  assert.ok(view.rows[0].gap_pct < 0);
  assert.match(view.rows[0].reason, /Search price is under the OneRoof estimate/);
  assert.match(opportunities.toCsv(view.rows), /search_price/);
  assert.match(opportunities.toCsv(view.rows), /750000/);
});

test('price history records drops and rises, and detail fetches are incremental', async () => {
  const db = memoryDb();
  const url = 'https://www.oneroof.co.nz/property/auckland/manurewa/36-ramwall-place/AAA';
  const base = listing({ url, asking_price: 900000, price_bold: 'Asking price $900,000', market_time: Math.floor(Date.parse('2026-01-01T00:00:00+13:00') / 1000) });
  opportunities.saveSuburb(db, [base], {
    searchSlug: 'suburb_manurewa-manukau-city-679',
    nowIso: '2026-11-01T05:00:00+13:00', snapDate: '2026-11-01', now: new Date('2026-11-01T05:00:00+13:00'),
  });
  opportunities.saveSuburb(db, [{ ...base, asking_price: 850000, price_bold: 'Asking price $850,000' }], {
    searchSlug: 'suburb_manurewa-manukau-city-679',
    nowIso: '2026-11-05T05:00:00+13:00', snapDate: '2026-11-05', now: new Date('2026-11-05T05:00:00+13:00'),
  });
  const down = opportunities.queryOpportunities(db, { type: 'drop' }, new Date('2026-11-05T05:00:00+13:00'));
  assert.equal(down.rows.length, 1);
  assert.equal(down.rows[0].direction, 'down');
  assert.equal(down.rows[0].first_price, 900000);
  assert.equal(down.rows[0].current_price, 850000);
  assert.equal(down.rows[0].change_amount, -50000);
  assert.equal(down.cards.drop, 1);
  assert.equal(down.cards.rise, 0);
  const history = opportunities.priceHistory(db, url, new Date('2026-11-05T05:00:00+13:00'));
  assert.equal(history.events.length, 1);
  assert.equal(history.events[0].field, 'asking');
  assert.equal(history.events[0].old_value, 900000);
  assert.equal(history.events[0].new_value, 850000);

  opportunities.saveDetail(db, { ...base, asking_price: 880000, price_bold: 'Asking price $880,000', price_search: 880000 }, {
    nowIso: '2026-11-06T05:00:00+13:00', snapDate: '2026-11-06', now: new Date('2026-11-06T05:00:00+13:00'),
  });
  const up = opportunities.queryOpportunities(db, { type: 'rise' }, new Date('2026-11-06T05:00:00+13:00'));
  assert.equal(up.rows[0].direction, 'up');
  assert.equal(up.rows[0].change_amount, 30000);

  const fresh = db.prepare('SELECT * FROM oneroof_listings WHERE url=?').get(url);
  assert.equal(opportunities.needsDetail({ ...fresh, price_search_fetched_at: null }, new Date('2026-11-06T05:00:00+13:00')), true);
  assert.equal(opportunities.needsDetail(fresh, new Date('2026-11-06T05:00:00+13:00')), false);
  const weekLater = new Date('2026-11-14T05:00:00+13:00');
  assert.equal(opportunities.needsDetail(fresh, weekLater), true);
  assert.equal(opportunities.needsDetail({ ...fresh, price_bold: 'Auction', price_light: '20 Nov 2026 11:00', asking_price: 880000 }, new Date('2026-11-07T05:00:00+13:00')), true);

  const serp = flightHtml([
    ['41', { street: '14 Timata Lane', suburb: 'Favona', district: 'Manukau City', shareLink: url, priceBold: 'By negotiation', priceLight: null, marketTime: 1700000000, category: 'House' }],
    ['9', { totals: 1, pageIndex: 1 }],
  ]);
  const detail = flightHtml([
    ['41', { street: '14 Timata Lane', suburb: 'Favona', shareLink: url, priceBold: 'By negotiation', priceSearch: '575000', marketTime: 1700000000, category: 'House' }],
  ]);
  const calls = [];
  const runner = opportunities.createRunner({
    db: memoryDb(),
    suburbs: [{ slug: 'suburb_favona-manukau-city-2360', suburb: 'Favona', district: 'Manukau City' }],
    delayMs: 0,
    sleep: async () => {},
    log: () => {},
    fetchImpl: async (pageUrl) => {
      calls.push(pageUrl);
      const html = String(pageUrl).includes('/property/') ? detail : serp;
      return { status: 200, text: async () => html };
    },
  });
  const first = await runner.start('manual').done;
  assert.equal(first.status, 'ok');
  assert.match(first.message, /Search prices updated for 1/);
  assert.equal(calls.filter(pageUrl => pageUrl.includes('/property/')).length, 1);
  const second = await runner.start('manual').done;
  assert.match(second.message, /already up to date/);
  assert.equal(calls.filter(pageUrl => pageUrl.includes('/property/')).length, 1);
  const stored = runner.status();
  assert.equal(stored.status, 'ok');
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
  return { status: res.status, loc: res.headers.get('location'), text, json, cookies: res.headers.getSetCookie() };
}

test('admins can open opportunities, export a row, and mark a match sold', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-opp-'));
  const app = launch(data, 3252);
  await app.ready();
  try {
    assert.equal((await hit(app.base, '/healthz')).status, 200);
    assert.equal((await hit(app.base, '/tv')).status, 200);
    assert.equal((await hit(app.base, '/opportunities')).status, 302);
    const pw = fs.readFileSync(path.join(data, 'ADMIN_PASSWORD.txt'), 'utf8').match(/Temporary password: (.+)/)[1].trim();
    const login = await hit(app.base, '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'gary.bal@harcourts.co.nz', password: pw }),
    });
    assert.equal(login.status, 200);
    const admin = { cookie: login.cookies.find(c => c.startsWith('sid=')).split(';')[0], 'Content-Type': 'application/json' };
    const page = await hit(app.base, '/opportunities', { headers: { cookie: admin.cookie } });
    assert.equal(page.status, 200);
    assert.match(page.text, /Export CSV/);
    assert.match(page.text, /90\+ days/);
    assert.match(page.text, /Run now/);
    const adminHome = await hit(app.base, '/admin', { headers: { cookie: admin.cookie } });
    assert.match(adminHome.text, /href="\/opportunities"/);
    const summary = await hit(app.base, '/api/admin/summary?view=week', { headers: { cookie: admin.cookie } });
    assert.equal(summary.status, 200);
    assert.ok(summary.json.rows);

    const added = await hit(app.base, '/api/admin/users', {
      method: 'POST', headers: admin,
      body: JSON.stringify({ name: 'Pat Agent', email: 'pat.opp@example.com', password: 'agent-temp-1' }),
    });
    assert.equal(added.status, 200);
    const agentLogin = await hit(app.base, '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pat.opp@example.com', password: 'agent-temp-1' }),
    });
    const agent = { cookie: agentLogin.cookies.find(c => c.startsWith('sid=')).split(';')[0], 'Content-Type': 'application/json' };
    assert.equal((await hit(app.base, '/opportunities', { headers: { cookie: agent.cookie } })).status, 403);
    assert.equal((await hit(app.base, '/api/admin/opportunities', { headers: { cookie: agent.cookie } })).status, 403);

    const db = new Database(path.join(data, 'data.db'));
    db.pragma('busy_timeout = 5000');
    opportunities.saveSuburb(db, [
      listing({}),
      listing({
        url: 'https://www.oneroof.co.nz/property/auckland/manurewa/1-143-sykes-road/BBB',
        street: '1/143 Sykes Road',
        asking_price: 700000,
        price_bold: 'Asking price $700,000',
      }),
    ], {
      searchSlug: 'suburb_manurewa-manukau-city-679',
      nowIso: '2026-11-01T05:00:00+13:00',
      snapDate: '2026-11-01',
      now: new Date('2026-11-01T05:00:00+13:00'),
    });
    opportunities.saveSuburb(db, [listing({})], {
      searchSlug: 'suburb_manurewa-manukau-city-679',
      nowIso: '2026-11-05T05:00:00+13:00',
      snapDate: '2026-11-05',
      now: new Date('2026-11-05T05:00:00+13:00'),
    });
    db.close();

    const list = await hit(app.base, '/api/admin/opportunities?type=withdrawn', { headers: { cookie: admin.cookie } });
    assert.equal(list.status, 200);
    assert.equal(list.json.rows.length, 1);
    assert.equal(list.json.rows[0].street, '1/143 Sykes Road');
    const upload = await hit(app.base, '/api/admin/opportunities/sales', {
      method: 'POST', headers: admin,
      body: JSON.stringify({
        csv: 'Address,Suburb,Sale Price,Sale Date\n"1/143 Sykes Road",Manurewa,"$820,000",1/10/2026\n',
      }),
    });
    assert.equal(upload.status, 200, upload.text);
    assert.equal(upload.json.sold, 1);
    const sold = await hit(app.base, '/api/admin/opportunities?type=sold', { headers: { cookie: admin.cookie } });
    assert.equal(sold.json.rows[0].status, 'Sold');
    assert.match(sold.json.rows[0].reason, /820,000|\$820,000/);
    const exported = await hit(app.base, '/api/admin/opportunities/export.csv', {
      method: 'POST', headers: admin,
      body: JSON.stringify({ urls: [sold.json.rows[0].url] }),
    });
    assert.equal(exported.status, 200);
    assert.match(exported.text, /1\/143 Sykes Road/);
    assert.match(exported.text, /Sold/);
    assert.doesNotMatch(exported.text, /Ramwall/);

    const cleared = await hit(app.base, '/api/admin/clear-activity', {
      method: 'POST', headers: admin, body: JSON.stringify({}),
    });
    assert.equal(cleared.status, 200);
    const still = await hit(app.base, '/api/admin/opportunities?type=sold', { headers: { cookie: admin.cookie } });
    assert.equal(still.json.rows.length, 1);
    assert.equal(app.logs().includes(pw), false);
  } finally {
    await app.stop();
  }
});
