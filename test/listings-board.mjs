import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const Database = require('better-sqlite3');
const listings = require(path.join(process.cwd(), 'listings.js'));

function launch(data, port) {
  let logs = '';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: data, PORT: String(port), LISTINGS_SYNC: '0' },
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

const CARD = `
<div class="property-item card ">
  <a href="/listing/l43429812-80-cambridge-terrace" data-category="buy" data-status="current"><h6 class="property-title">A Home Full of Memories</h6></a>
  <span class="hi-price">Deadline Treaty (unless sold prior)</span>
  <span class="address">80 Cambridge Terrace, Papatoetoe, NZ 2155</span>
  <div class="property-agent"><img alt="Ajit Saini"></div>
</div>
<div class="property-item card ">
  <a href="/listing/l1001-asking" data-status="current"><h6 class="property-title">Sunlit &amp; ready</h6></a>
  <span class="hi-price">Asking Price $785,000</span>
  <span class="address">1 Test Road, Papakura, NZ 2110</span>
  <div class="property-agent"><img alt="Sam Agent"></div>
</div>
<div class="property-item card ">
  <div class="property-badge"><span>sold</span></div>
  <a href="/listing/l200-sold" data-status="sold"><h6 class="property-title">SOLD!</h6></a>
  <span class="hi-price">$740,000</span>
  <span class="address">16 Farmland Road, Papakura, NZ 2110</span>
  <div class="property-agent"><img alt="Mushtaq Sheikh"></div>
</div>
<div class="property-item card ">
  <a href="/listing/l300-blank" data-status="sold"><h6 class="property-title">Quiet sale</h6></a>
  <span class="hi-price"> </span>
  <span class="address">9 Quiet Street, Takanini, NZ 2105</span>
  <div class="property-agent"><img alt="Aman Kaushal"></div>
</div>
<div class="property-item card ">
  <a href="/listing/r9-rent" data-category="rent" data-status="current"><h6 class="property-title">Rental</h6></a>
  <span class="hi-price">$500 per week</span>
  <span class="address">1 Rent Street, Somewhere, NZ 0000</span>
</div>
<div class="property-search-result-found"></div>`;

test('listing pages map sale method, price and address without inventing a CV', () => {
  const cards = listings.parseListingCards(CARD);
  assert.deepEqual(cards.map(c => c.source_key), ['l43429812', 'l1001', 'l200', 'l300']);
  const items = listings.buildFeedItems(cards.filter(c => c.status_attr !== 'sold'), cards.filter(c => c.status_attr === 'sold'));
  const by = Object.fromEntries(items.map(i => [i.source_key, i]));
  assert.equal(by.l43429812.status, 'new');
  assert.equal(by.l43429812.method, 'deadline');
  assert.equal(by.l43429812.asking_price, '');
  assert.equal(by.l43429812.address, '80 Cambridge Terrace');
  assert.equal(by.l43429812.suburb, 'Papatoetoe');
  assert.equal(by.l43429812.agent, 'Ajit Saini');
  assert.equal(by.l1001.method, 'price');
  assert.equal(by.l1001.asking_price, '$785,000');
  assert.equal(by.l1001.name, 'Sunlit & ready');
  assert.equal(by.l200.status, 'sold');
  assert.equal(by.l200.sale_price, '$740,000');
  assert.equal(by.l300.status, 'sold');
  assert.equal(by.l300.sale_price, '');
  assert.equal(listings.mapSaleMethod('Auction (unless sold prior)').method, 'auction');
  assert.equal(listings.mapSaleMethod('Price by Negotiation').method, 'negotiation');
  const under = listings.cardToFeed({
    source_key: 'l9', title: 'Waiting', price: 'Under Offer', address: '4 Lane, Papatoetoe, NZ 2155', agent: 'Jo', badge: '', status_attr: 'current', rank: 0,
  }, 'new');
  assert.equal(under.status, 'conditional');
  assert.equal(under.sale_price, '');
});

test('an admin edit is kept and a manual row is not removed when the website refresh runs', () => {
  const existing = [
    { id: 1, source_key: 'l1', origin: 'feed', admin_edited: 1 },
    { id: 2, source_key: 'l2', origin: 'feed', admin_edited: 0 },
    { id: 3, source_key: 'l3', origin: 'feed', admin_edited: 0 },
    { id: 4, source_key: null, origin: 'manual', admin_edited: 1 },
  ];
  const feed = [
    { source_key: 'l1', status: 'sold', name: 'Overwrite', address: '1 A Street', sale_price: '$1', method: '', asking_price: '', suburb: '', agent: '', source_rank: 0 },
    { source_key: 'l2', status: 'new', name: 'Updated', address: '2 B Street', method: 'auction', asking_price: '', sale_price: '', suburb: '', agent: 'A', source_rank: 0 },
    { source_key: 'l9', status: 'new', name: 'Fresh', address: '9 C Street', method: 'price', asking_price: '$10', sale_price: '', suburb: 'X', agent: 'B', source_rank: 1 },
  ];
  const plan = listings.planFeedSync(existing, feed);
  assert.deepEqual(plan.upserts.map(i => i.source_key), ['l2', 'l9']);
  assert.equal(plan.upserts[0].id, 2);
  assert.equal(plan.upserts[1].id, null);
  assert.deepEqual(plan.retireIds, [3]);
  const bad = listings.readBoardInput({ status: 'sold', address: '  ' });
  assert.equal(bad.error, 'Address is required');
  const ok = listings.readBoardInput({ status: 'conditional', address: '12 Lane', condition_text: 'subject to finance, due 5 Nov', cv: '$900,000', hidden: true });
  assert.equal(ok.value.status, 'conditional');
  assert.equal(ok.value.cv, '$900,000');
  assert.equal(ok.value.hidden, 1);
});

test('only an admin can open the listings board and manage its entries', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-board-'));
  const app = launch(data, 3231);
  await app.ready();
  try {
    const anonBoard = await hit(app.base, '/board');
    assert.equal(anonBoard.status, 302);
    assert.equal(decodeURIComponent(anonBoard.loc), '/login?next=/board');
    const anonSlash = await hit(app.base, '/board/');
    assert.equal(anonSlash.status, 302);
    assert.equal(decodeURIComponent(anonSlash.loc), '/login?next=/board');
    const anonManage = await hit(app.base, '/board/manage');
    assert.equal(anonManage.status, 302);
    assert.equal(decodeURIComponent(anonManage.loc), '/login?next=/board/manage');
    for (const url of ['/api/board', '/api/board/manage']) {
      const res = await hit(app.base, url);
      assert.equal(res.status, 401, url);
    }
    const anonWrite = await hit(app.base, '/api/board/items', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'new', address: '1 Hidden Street' }),
    });
    assert.equal(anonWrite.status, 401);

    const pw = fs.readFileSync(path.join(data, 'ADMIN_PASSWORD.txt'), 'utf8').match(/Temporary password: (.+)/)[1].trim();
    const login = await hit(app.base, '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ email: 'gary.bal@harcourts.co.nz', password: pw }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.cookies.find(c => c.startsWith('sid='));
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /HttpOnly/i);
    const maxAge = Number((setCookie.match(/Max-Age=(\d+)/i) || [])[1]);
    assert.ok(maxAge >= 90 * 86400);
    const gary = { cookie: setCookie.split(';')[0], 'Content-Type': 'application/json' };

    const createdAgent = await hit(app.base, '/api/admin/users', {
      method: 'POST', headers: gary,
      body: JSON.stringify({ name: 'Pat Agent', email: 'pat.board@example.com', password: 'agent-temp-1', role: 'agent' }),
    });
    assert.equal(createdAgent.status, 200);
    const staff = await hit(app.base, '/api/admin/users', {
      method: 'POST', headers: gary,
      body: JSON.stringify({ name: 'Office Admin', email: 'ada.board@example.com', password: 'admin-temp-1', role: 'admin' }),
    });
    assert.equal(staff.status, 200);
    const patLogin = await hit(app.base, '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pat.board@example.com', password: 'agent-temp-1' }),
    });
    const pat = { cookie: patLogin.cookies.find(c => c.startsWith('sid=')).split(';')[0], 'Content-Type': 'application/json' };
    const adaLogin = await hit(app.base, '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ada.board@example.com', password: 'admin-temp-1' }),
    });
    const ada = { cookie: adaLogin.cookies.find(c => c.startsWith('sid=')).split(';')[0], 'Content-Type': 'application/json' };

    const secret = 'SECRET-BOARD-9921 Queen Street';
    for (const url of ['/board', '/board/manage']) {
      const res = await hit(app.base, url, { headers: { cookie: pat.cookie } });
      assert.equal(res.status, 403, url);
      assert.match(res.text, /Harcourts/);
      assert.match(res.text, /TGB Group/);
      assert.equal(/manurewa/i.test(res.text), false);
      assert.equal(res.text.includes(secret), false);
    }
    for (const url of ['/api/board', '/api/board/manage']) {
      assert.equal((await hit(app.base, url, { headers: { cookie: pat.cookie } })).status, 403, url);
    }
    assert.equal((await hit(app.base, '/api/board/items', {
      method: 'POST', headers: pat, body: JSON.stringify({ status: 'new', address: secret }),
    })).status, 403);
    assert.equal((await hit(app.base, '/api/board/sync', { method: 'POST', headers: pat, body: '{}' })).status, 403);

    const board = await hit(app.base, '/board', { headers: { cookie: gary.cookie } });
    assert.equal(board.status, 200);
    assert.equal(board.cache, 'no-store');
    assert.match(board.text, /New listings/);
    assert.match(board.text, /SOLD/);
    assert.match(board.text, /CONDITIONAL/);
    assert.match(board.text, /Harcourts/);
    assert.match(board.text, /TGB Group/);
    assert.equal(/manurewa/i.test(board.text), false);
    const manage = await hit(app.base, '/board/manage', { headers: { cookie: gary.cookie } });
    assert.equal(manage.status, 200);
    assert.match(manage.text, /Council valuation|CV/);
    assert.match(manage.text, /Method of sale/);
    assert.match(manage.text, /Sale price/);
    assert.match(manage.text, /Condition/);
    assert.match(manage.text, /confirm\(/);
    assert.equal(/manurewa/i.test(manage.text), false);

    const adaBoard = await hit(app.base, '/api/board', { headers: { cookie: ada.cookie } });
    assert.equal(adaBoard.status, 200);
    assert.equal(adaBoard.json.brand, 'Harcourts TGB Group');

    const added = await hit(app.base, '/api/board/items', {
      method: 'POST', headers: gary,
      body: JSON.stringify({
        status: 'new', name: 'Family home', address: secret, suburb: 'Papatoetoe', agent: 'Ada Admin',
        cv: '', method: 'auction', asking_price: '', sale_price: '', condition_text: '',
      }),
    });
    assert.equal(added.status, 200);
    const id = added.json.id;
    const listed = await hit(app.base, '/api/board', { headers: { cookie: gary.cookie } });
    assert.equal(listed.json.new.some(row => row.address === secret && row.method === 'auction'), true);
    assert.equal(listed.json.new.find(row => row.address === secret).cv, '');

    const moved = await hit(app.base, '/api/board/items/' + id, {
      method: 'POST', headers: gary,
      body: JSON.stringify({
        status: 'conditional', name: 'Family home', address: secret, suburb: 'Papatoetoe', agent: 'Ada Admin',
        cv: '$880,000', method: 'auction', asking_price: '', sale_price: '', condition_text: 'subject to finance, due 5 Nov',
      }),
    });
    assert.equal(moved.status, 200);
    const after = await hit(app.base, '/api/board', { headers: { cookie: gary.cookie } });
    assert.equal(after.json.new.some(row => row.address === secret), false);
    const cond = after.json.conditional.find(row => row.address === secret);
    assert.ok(cond);
    assert.equal(cond.condition_text, 'subject to finance, due 5 Nov');
    assert.equal(cond.cv, '$880,000');

    assert.equal((await hit(app.base, '/api/board/items/' + id, {
      method: 'POST', headers: pat,
      body: JSON.stringify({ status: 'sold', address: secret, sale_price: '$1' }),
    })).status, 403);

    const hidden = await hit(app.base, '/api/board/items/' + id, {
      method: 'POST', headers: gary,
      body: JSON.stringify({
        status: 'sold', name: 'Family home', address: secret, suburb: 'Papatoetoe', agent: 'Ada Admin',
        cv: '$880,000', method: '', asking_price: '', sale_price: '', condition_text: '', hidden: true,
      }),
    });
    assert.equal(hidden.status, 200);
    const tv = await hit(app.base, '/api/board', { headers: { cookie: gary.cookie } });
    assert.equal(JSON.stringify(tv.json).includes(secret), false);
    const desk = await hit(app.base, '/api/board/manage', { headers: { cookie: gary.cookie } });
    const saved = desk.json.items.find(row => row.address === secret);
    assert.equal(saved.hidden, true);
    assert.equal(saved.status, 'sold');
    assert.equal(saved.sale_price, '');
    assert.equal(saved.admin_edited, true);

    const db = new Database(path.join(data, 'data.db'));
    db.prepare(`INSERT INTO board_listings(source_key, origin, status, name, address, suburb, agent, method, asking_price, sale_price, hidden, admin_edited, source_rank)
      VALUES('l50','feed','new','Website name','50 Feed Road','Papakura','Site Agent','negotiation','','',0,0,0)`).run();
    db.close();
    const touched = await hit(app.base, '/api/board/manage', { headers: { cookie: gary.cookie } });
    const feedRow = touched.json.items.find(row => row.source_key === 'l50');
    assert.ok(feedRow);
    const edited = await hit(app.base, '/api/board/items/' + feedRow.id, {
      method: 'POST', headers: gary,
      body: JSON.stringify({
        status: 'conditional', name: 'Kept by admin', address: '50 Feed Road', suburb: 'Papakura', agent: 'Site Agent',
        cv: '$1,000,000', method: 'negotiation', asking_price: '', sale_price: '', condition_text: 'building report',
      }),
    });
    assert.equal(edited.status, 200);
    const db2 = new Database(path.join(data, 'data.db'), { readonly: true });
    const row = db2.prepare('SELECT admin_edited, name, status, cv, condition_text FROM board_listings WHERE source_key=?').get('l50');
    db2.close();
    assert.equal(row.admin_edited, 1);
    assert.equal(row.name, 'Kept by admin');
    assert.equal(row.status, 'conditional');
    assert.equal(row.cv, '$1,000,000');
    const plan = listings.planFeedSync(
      [{ id: feedRow.id, source_key: 'l50', origin: 'feed', admin_edited: row.admin_edited }],
      [{ source_key: 'l50', status: 'new', name: 'Website name', address: '50 Feed Road', method: 'auction', asking_price: '', sale_price: '', suburb: 'Papakura', agent: 'Other', source_rank: 0 }],
    );
    assert.equal(plan.upserts.length, 0);
    assert.equal(plan.retireIds.length, 0);

    assert.equal((await hit(app.base, '/api/board/items/' + id + '/delete', {
      method: 'POST', headers: pat, body: '{}',
    })).status, 403);
    const removed = await hit(app.base, '/api/board/items/' + id + '/delete', {
      method: 'POST', headers: gary, body: '{}',
    });
    assert.equal(removed.status, 200);
    const gone = await hit(app.base, '/api/board/manage', { headers: { cookie: gary.cookie } });
    assert.equal(gone.json.items.some(row => row.address === secret), false);

    const adminHtml = await hit(app.base, '/admin', { headers: { cookie: gary.cookie } });
    assert.match(adminHtml.text, /href="\/board\/manage"/);
    assert.match(adminHtml.text, /id="tvlink"/);
    const publicTv = await hit(app.base, '/tv');
    assert.equal(publicTv.status, 200);
    assert.match(publicTv.text, /Team this week/);
    const publicApi = await hit(app.base, '/api/tv');
    assert.equal(publicApi.status, 200);
    assert.equal(JSON.stringify(publicApi.json).includes(secret), false);
    assert.equal(JSON.stringify(publicApi.json).includes('50 Feed Road'), false);
  } finally {
    await app.stop();
  }
});
