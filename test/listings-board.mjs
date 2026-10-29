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

test('board input keeps a conditional price and only untouched website rows are dropped', () => {
  const ok = listings.readBoardInput({
    status: 'conditional', address: '14 Example Lane', agent: 'Ada Admin',
    condition_text: 'subject to finance, due 5 Nov', cond_price: '$910,000',
  });
  assert.equal(ok.value.cond_price, '$910,000');
  assert.equal(ok.value.condition_text, 'subject to finance, due 5 Nov');
  assert.equal(ok.value.agent2, null);
  const two = listings.readBoardInput({ status: 'new', address: '1 Lane', agent: 'Ada Admin', agent2: '  Isaiah Stringer  ' });
  assert.equal(two.value.agent, 'Ada Admin');
  assert.equal(two.value.agent2, 'Isaiah Stringer');
  assert.equal(listings.readBoardInput({ status: 'sold', address: '1 Lane', agent2: '   ' }).value.agent2, null);
  assert.equal(listings.readBoardInput({ status: 'sold', address: '  ' }).error, 'Address is required');
  assert.equal(ok.value.listed_on, null);
  assert.equal(listings.readBoardInput({ status: 'new', address: '1 Lane', listed_on: '2020-01-15' }).value.listed_on, '2020-01-15');
  assert.equal(listings.readBoardInput({ status: 'new', address: '1 Lane', listed_on: '2020-13-40' }).error, 'Date must be a real calendar day');
  assert.equal(listings.formatAgents('Aman Kaushal', 'Isaiah Stringer'), 'Aman & Isaiah');
  assert.equal(listings.formatAgents('Claire Ocoma', ''), 'Claire');
  assert.equal(listings.formatAgents('', ''), '');
  assert.equal(listings.shouldDropFeedRow({ origin: 'feed', admin_edited: 0 }), true);
  assert.equal(listings.shouldDropFeedRow({ origin: 'feed', admin_edited: 1 }), false);
  assert.equal(listings.shouldDropFeedRow({ origin: 'manual', admin_edited: 1 }), false);
});

test('startup removes untouched website rows and keeps hand-entered ones', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-board-migrate-'));
  const first = launch(data, 3234);
  await first.ready();
  await first.stop();
  const db = new Database(path.join(data, 'data.db'));
  const insert = db.prepare(`INSERT INTO board_listings(source_key, origin, status, address, agent, admin_edited, cond_price)
    VALUES(?,?,?,?,?,?,?)`);
  insert.run('l1', 'feed', 'new', '1 Website Road', 'Site Agent', 0, '');
  insert.run('l2', 'feed', 'sold', '2 Kept Road', 'Ada Admin', 1, '');
  insert.run(null, 'manual', 'conditional', '3 Hand Road', 'Pat Agent', 1, '$500,000');
  db.close();
  const app = launch(data, 3234);
  await app.ready();
  try {
    assert.equal(/website|sync/i.test(app.logs()), false);
    const pw = fs.readFileSync(path.join(data, 'ADMIN_PASSWORD.txt'), 'utf8').match(/Temporary password: (.+)/)[1].trim();
    const login = await hit(app.base, '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'gary.bal@harcourts.co.nz', password: pw }),
    });
    const gary = { cookie: login.cookies.find(c => c.startsWith('sid=')).split(';')[0] };
    const board = await hit(app.base, '/api/board', { headers: { cookie: gary.cookie } });
    const blob = JSON.stringify(board.json);
    assert.equal(blob.includes('1 Website Road'), false);
    assert.equal(blob.includes('2 Kept Road'), true);
    assert.equal(blob.includes('3 Hand Road'), true);
    assert.equal(board.json.conditional[0].cond_price, '$500,000');
    assert.equal(board.json.conditional[0].agent2, null);
    const db2info = new Database(path.join(data, 'data.db'), { readonly: true });
    const agent2Col = db2info.prepare('PRAGMA table_info(board_listings)').all().find(c => c.name === 'agent2');
    assert.ok(agent2Col);
    assert.equal(agent2Col.notnull, 0);
    assert.equal(db2info.prepare("SELECT agent2 FROM board_listings WHERE address='3 Hand Road'").get().agent2, null);
    db2info.close();
    const db2 = new Database(path.join(data, 'data.db'), { readonly: true });
    assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM board_listings WHERE address='1 Website Road'").get().n, 0);
    assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM board_listings WHERE address='2 Kept Road'").get().n, 1);
    db2.close();
  } finally {
    await app.stop();
  }
});

test('only an admin can open the listings board, the add form, and manage entries', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tgb-board-'));
  const app = launch(data, 3231);
  await app.ready();
  try {
    assert.equal(/harcourtsmanurewa|Listings sync/i.test(app.logs()), false);
    for (const [url, next] of [['/board', '/board'], ['/board/', '/board'], ['/board/manage', '/board/manage'], ['/board/add', '/board/add']]) {
      const res = await hit(app.base, url);
      assert.equal(res.status, 302, url);
      assert.equal(decodeURIComponent(res.loc), '/login?next=' + next);
    }
    for (const url of ['/api/board', '/api/board/manage', '/api/board/agents']) {
      assert.equal((await hit(app.base, url)).status, 401, url);
    }
    assert.equal((await hit(app.base, '/api/board/items', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'new', address: '1 Hidden Street' }),
    })).status, 401);
    assert.equal((await hit(app.base, '/api/board/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })).status, 404);

    const pw = fs.readFileSync(path.join(data, 'ADMIN_PASSWORD.txt'), 'utf8').match(/Temporary password: (.+)/)[1].trim();
    const login = await hit(app.base, '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      body: JSON.stringify({ email: 'gary.bal@harcourts.co.nz', password: pw }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.cookies.find(c => c.startsWith('sid='));
    assert.match(setCookie, /Secure/i);
    const maxAge = Number((setCookie.match(/Max-Age=(\d+)/i) || [])[1]);
    assert.ok(maxAge >= 90 * 86400);
    const gary = { cookie: setCookie.split(';')[0], 'Content-Type': 'application/json' };

    assert.equal((await hit(app.base, '/api/admin/users', {
      method: 'POST', headers: gary,
      body: JSON.stringify({ name: 'Pat Agent', email: 'pat.board@example.com', password: 'agent-temp-1', role: 'agent' }),
    })).status, 200);
    assert.equal((await hit(app.base, '/api/admin/users', {
      method: 'POST', headers: gary,
      body: JSON.stringify({ name: 'Office Admin', email: 'ada.board@example.com', password: 'admin-temp-1', role: 'admin' }),
    })).status, 200);
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
    for (const url of ['/board', '/board/manage', '/board/add']) {
      const res = await hit(app.base, url, { headers: { cookie: pat.cookie } });
      assert.equal(res.status, 403, url);
      assert.equal(res.text.includes(secret), false);
    }
    for (const url of ['/api/board', '/api/board/manage', '/api/board/agents']) {
      assert.equal((await hit(app.base, url, { headers: { cookie: pat.cookie } })).status, 403, url);
    }
    assert.equal((await hit(app.base, '/api/board/items', {
      method: 'POST', headers: pat, body: JSON.stringify({ status: 'new', address: secret }),
    })).status, 403);

    const board = await hit(app.base, '/board', { headers: { cookie: gary.cookie } });
    assert.equal(board.status, 200);
    assert.equal(board.cache, 'no-store');
    assert.match(board.text, /Address/);
    assert.match(board.text, /Agent/);
    assert.match(board.text, /CV/);
    assert.match(board.text, /Method of sale/);
    assert.match(board.text, /agent2/);
    assert.match(board.text, /white-space:nowrap/);
    assert.match(board.text, /SOLD/);
    assert.match(board.text, /Conditions/);
    assert.match(board.text, /No listings yet/);
    assert.match(board.text, /Harcourts/);
    assert.match(board.text, /TGB Group/);
    assert.match(board.text, /NEW LISTINGS/);
    assert.match(board.text, /SOLD LISTINGS/);
    assert.match(board.text, /CONDITIONAL SALES/);
    assert.match(board.text, /LISTING STOCK BOARD/);
    assert.equal(/manurewa/i.test(board.text), false);
    assert.match(board.text, /#00ADEF/);
    assert.doesNotMatch(board.text, /#F5C451/);

    const add = await hit(app.base, '/board/add', { headers: { cookie: gary.cookie } });
    assert.equal(add.status, 200);
    assert.match(add.text, /Add a listing/);
    assert.match(add.text, /New listing/);
    assert.match(add.text, /Sold/);
    assert.match(add.text, /Conditional/);
    assert.match(add.text, /Type a name/);
    assert.match(add.text, /Method of sale/);
    assert.match(add.text, /Sale price/);
    assert.match(add.text, /Conditions/);
    assert.match(add.text, />Save</);
    assert.match(add.text, /Second agent \(optional\)/);
    assert.match(add.text, /id="agent2Pick"/);
    assert.match(add.text, /id="listedOn"/);
    assert.doesNotMatch(add.text, /website/i);

    const manage = await hit(app.base, '/board/manage', { headers: { cookie: gary.cookie } });
    assert.equal(manage.status, 200);
    assert.match(manage.text, /href="\/board\/add"/);
    assert.match(manage.text, /Conditions/);
    assert.match(manage.text, /id="condPrice"/);
    assert.match(manage.text, /Second agent \(optional\)/);
    assert.match(manage.text, /id="agent2Pick"/);
    assert.match(manage.text, /Type a name/);
    assert.match(manage.text, /Month on the TV/);
    assert.match(manage.text, /id="listedOn"/);
    assert.match(manage.text, /id="tvMonth"/);
    assert.match(manage.text, /confirm\(/);
    assert.doesNotMatch(manage.text, /website/i);
    assert.doesNotMatch(manage.text, /Refresh from/);

    const names = await hit(app.base, '/api/board/agents', { headers: { cookie: gary.cookie } });
    assert.equal(names.status, 200);
    assert.equal(names.json.agents.some(a => a.name === 'Pat Agent'), true);
    assert.equal((await hit(app.base, '/api/board', { headers: { cookie: ada.cookie } })).status, 200);
    assert.equal((await hit(app.base, '/api/board/sync', { method: 'POST', headers: gary, body: '{}' })).status, 404);

    const added = await hit(app.base, '/api/board/items', {
      method: 'POST', headers: gary,
      body: JSON.stringify({ status: 'new', address: secret, agent: 'Pat Agent', cv: '$880,000', method: 'auction' }),
    });
    assert.equal(added.status, 200);
    const id = added.json.id;
    const listed = await hit(app.base, '/api/board', { headers: { cookie: gary.cookie } });
    const row = listed.json.new.find(r => r.address === secret);
    assert.equal(row.method, 'auction');
    assert.equal(row.cv, '$880,000');
    assert.equal(row.agent, 'Pat Agent');
    assert.equal(row.agent2, null);

    const paired = await hit(app.base, '/api/board/items/' + id, {
      method: 'POST', headers: gary,
      body: JSON.stringify({ status: 'new', address: secret, agent: 'Pat Agent', agent2: 'Isaiah Stringer', cv: '$880,000', method: 'auction' }),
    });
    assert.equal(paired.status, 200);
    const pairedRow = (await hit(app.base, '/api/board', { headers: { cookie: gary.cookie } })).json.new.find(r => r.address === secret);
    assert.equal(pairedRow.agent, 'Pat Agent');
    assert.equal(pairedRow.agent2, 'Isaiah Stringer');
    const changed = await hit(app.base, '/api/board/items/' + id, {
      method: 'POST', headers: gary,
      body: JSON.stringify({ status: 'sold', address: secret, agent: 'Aman Kaushal', agent2: 'Claire Ocoma', sale_price: '$680,000' }),
    });
    assert.equal(changed.status, 200);
    const changedRow = (await hit(app.base, '/api/board', { headers: { cookie: gary.cookie } })).json.sold.find(r => r.address === secret);
    assert.equal(changedRow.agent2, 'Claire Ocoma');
    const cleared = await hit(app.base, '/api/board/items/' + id, {
      method: 'POST', headers: gary,
      body: JSON.stringify({ status: 'sold', address: secret, agent: 'Aman Kaushal', agent2: '', sale_price: '$680,000' }),
    });
    assert.equal(cleared.status, 200);
    const clearedRow = (await hit(app.base, '/api/board', { headers: { cookie: gary.cookie } })).json.sold.find(r => r.address === secret);
    assert.equal(clearedRow.agent2, null);

    const sold = await hit(app.base, '/api/board/items', {
      method: 'POST', headers: gary,
      body: JSON.stringify({ status: 'sold', address: '9 Sold Street', agent: 'Pat Agent', sale_price: '$740,000' }),
    });
    assert.equal(sold.status, 200);
    const cond = await hit(app.base, '/api/board/items', {
      method: 'POST', headers: gary,
      body: JSON.stringify({
        status: 'conditional', address: '14 Example Lane', agent: 'Ada Admin',
        condition_text: 'subject to finance, due 5 Nov', cond_price: '$910,000', agent2: 'Isaiah Stringer',
      }),
    });
    assert.equal(cond.status, 200);
    const after = await hit(app.base, '/api/board', { headers: { cookie: gary.cookie } });
    assert.equal(after.json.sold.find(r => r.address === '9 Sold Street').sale_price, '$740,000');
    const condRow = after.json.conditional.find(r => r.address === '14 Example Lane');
    assert.equal(condRow.condition_text, 'subject to finance, due 5 Nov');
    assert.equal(condRow.cond_price, '$910,000');
    assert.equal(condRow.agent, 'Ada Admin');
    assert.equal(condRow.agent2, 'Isaiah Stringer');

    const moved = await hit(app.base, '/api/board/items/' + id, {
      method: 'POST', headers: gary,
      body: JSON.stringify({ status: 'sold', address: secret, agent: 'Pat Agent', sale_price: '$1' }),
    });
    assert.equal(moved.status, 200);
    assert.equal((await hit(app.base, '/api/board/items/' + id, {
      method: 'POST', headers: pat, body: JSON.stringify({ status: 'new', address: secret }),
    })).status, 403);
    assert.equal((await hit(app.base, '/api/board/items/' + cond.json.id + '/delete', {
      method: 'POST', headers: pat, body: '{}',
    })).status, 403);
    assert.equal((await hit(app.base, '/api/board/items/' + cond.json.id + '/delete', {
      method: 'POST', headers: gary, body: '{}',
    })).status, 200);
    const gone = await hit(app.base, '/api/board/manage', { headers: { cookie: gary.cookie } });
    assert.equal(gone.json.items.some(r => r.address === '14 Example Lane'), false);

    const adminHtml = await hit(app.base, '/admin', { headers: { cookie: gary.cookie } });
    assert.match(adminHtml.text, /href="\/board\/add"/);
    assert.match(adminHtml.text, /href="\/board\/manage"/);
    assert.match(adminHtml.text, /id="tvlink"/);
    const old = await hit(app.base, '/api/board/items', {
      method: 'POST', headers: gary,
      body: JSON.stringify({ status: 'conditional', address: 'OLD-MONTH-1 Queen Street', agent: 'Pat Agent', condition_text: 'finance', cond_price: '$1', listed_on: '2020-01-15' }),
    });
    assert.equal(old.status, 200);
    const currentBoard = await hit(app.base, '/api/board', { headers: { cookie: gary.cookie } });
    assert.equal(JSON.stringify(currentBoard.json).includes('OLD-MONTH-1'), false);
    assert.match(currentBoard.json.month, /^\d{4}-\d{2}$/);
    assert.match(currentBoard.json.month_label, /\d{4}/);
    assert.equal(JSON.stringify(currentBoard.json).includes(secret), true);
    const pinned = await hit(app.base, '/api/board/month', { method: 'POST', headers: gary, body: JSON.stringify({ month: '2020-01' }) });
    assert.equal(pinned.status, 200);
    assert.equal(pinned.json.month, '2020-01');
    assert.equal(pinned.json.month_label, 'January 2020');
    const january = await hit(app.base, '/api/board', { headers: { cookie: gary.cookie } });
    assert.equal(january.json.conditional.some(r => r.address === 'OLD-MONTH-1 Queen Street'), true);
    assert.equal(JSON.stringify(january.json).includes(secret), false);
    const manageAll = await hit(app.base, '/api/board/manage', { headers: { cookie: gary.cookie } });
    assert.equal(manageAll.json.items.some(r => r.address === secret), true);
    assert.equal(manageAll.json.items.some(r => r.address === 'OLD-MONTH-1 Queen Street'), true);
    assert.equal((await hit(app.base, '/api/board/month', { method: 'POST', headers: pat, body: JSON.stringify({ month: '2020-01' }) })).status, 403);
    const resetMonth = await hit(app.base, '/api/board/month', { method: 'POST', headers: gary, body: JSON.stringify({ month: '' }) });
    assert.equal(resetMonth.status, 200);
    assert.equal(resetMonth.json.tv_month, '');
    const back = await hit(app.base, '/api/board', { headers: { cookie: gary.cookie } });
    assert.equal(JSON.stringify(back.json).includes('OLD-MONTH-1'), false);
    assert.equal(JSON.stringify(back.json).includes(secret), true);

    const publicTv = await hit(app.base, '/tv');
    assert.equal(publicTv.status, 200);
    assert.match(publicTv.text, /Team this week/);
    const publicApi = await hit(app.base, '/api/tv');
    assert.equal(publicApi.status, 200);
    assert.equal(JSON.stringify(publicApi.json).includes(secret), false);
  } finally {
    await app.stop();
  }
});
