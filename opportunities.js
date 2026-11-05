'use strict';

// South Auckland long-on-market list. Reads public OneRoof suburb search pages
// (HTML with an embedded Next.js flight payload) and REINZ CSV uploads.
// Tables are additive. Nothing here writes the KPI or listings-board tables.

const fs = require('fs');
const path = require('path');

const BASE = 'https://www.oneroof.co.nz';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PAGE_SIZE = 40;
const MAX_PAGES = 30;
const TZ = 'Pacific/Auckland';

const SUFFIX = {
  rd: 'road', st: 'street', ave: 'avenue', av: 'avenue', pl: 'place',
  cres: 'crescent', cr: 'crescent', tce: 'terrace', ter: 'terrace',
  dr: 'drive', pde: 'parade', ln: 'lane', hwy: 'highway', cct: 'circuit',
  cl: 'close', gr: 'grove', bvd: 'boulevard', blvd: 'boulevard',
  ct: 'court', crt: 'court', esp: 'esplanade', gdns: 'gardens',
  sq: 'square', gln: 'glen', qy: 'quay',
};

function loadSuburbs() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'south-auckland-suburbs.json'), 'utf8'));
  return raw.map(row => {
    const m = String(row.title || '').match(/^Houses for sale in (.+), (.+)$/);
    return {
      slug: row.slug,
      suburb: m ? m[1] : row.slug,
      district: m ? m[2] : '',
      group: row.group || '',
      expectedTotals: row.totals,
    };
  });
}

function aucklandParts(date) {
  const fmt = new Intl.DateTimeFormat('en-NZ', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

function aucklandDate(date) {
  const p = aucklandParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function aucklandIso(date) {
  const p = aucklandParts(date);
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const offsetMin = Math.round((wall - date.getTime()) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`;
}

// Next 5:00am (or any hour) in Pacific/Auckland, as a UTC epoch ms.
function nextAucklandHour(hour, minute, now = new Date()) {
  const p = aucklandParts(now);
  const y = +p.year;
  const m = +p.month;
  const d = +p.day;
  let target = aucklandToUtc(y, m, d, hour, minute);
  if (target == null || target <= now.getTime()) {
    const noon = aucklandToUtc(y, m, d, 12, 0);
    if (noon == null) return null;
    const n = aucklandParts(new Date(noon + 24 * 3600 * 1000));
    target = aucklandToUtc(+n.year, +n.month, +n.day, hour, minute);
  }
  return target;
}

function aucklandToUtc(y, m, d, hh, mm) {
  for (const offset of [13, 12]) {
    const guess = Date.UTC(y, m - 1, d, hh - offset, mm, 0);
    const g = aucklandParts(new Date(guess));
    if (+g.year === y && +g.month === m && +g.day === d && +g.hour === hh && +g.minute === mm) return guess;
  }
  return null;
}

function daysOnMarket(marketTime, now = new Date()) {
  const t = Number(marketTime);
  if (!Number.isFinite(t) || t <= 0) return null;
  const listed = aucklandDate(new Date(t * 1000));
  const today = aucklandDate(now);
  const days = Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(listed + 'T00:00:00Z')) / 86400000);
  return Math.max(days, 0);
}

function parseMoney(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value >= 1000 ? Math.round(value) : null;
  const text = String(value).replace(/&nbsp;/g, ' ').replace(/[$£,]/g, '').trim();
  if (!text || /^(null|none|poa|n\/a|undefined)$/i.test(text)) return null;
  if (/negotiation|application|auction|tender|deadline/i.test(text) && !/\d{4,}/.test(text)) return null;
  const m = text.match(/(\d{4,9})/);
  return m ? Number(m[1]) : null;
}

function fold(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '');
}

function normaliseSuburb(s) {
  return fold(s).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normaliseAddress(s) {
  let t = fold(s);
  t = t.replace(/\b(unit|flat|apartment|apt|suite)\b/g, ' ');
  t = t.replace(/(\d+)\s*[/\\-]\s*(?=\d)/g, '$1 ');
  t = t.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.split(' ').map(w => SUFFIX[w] || w).join(' ');
}

function addressKey(street, suburb) {
  let a = normaliseAddress(street);
  const sub = normaliseSuburb(suburb);
  if (sub && (a === sub || a.endsWith(' ' + sub))) a = a.slice(0, a.length - sub.length).trim();
  return a;
}

function addressMatchesUrl(street, url) {
  try {
    const slug = decodeURIComponent(String(url || '')).toLowerCase().replace(/[^a-z0-9]+/g, '');
    const folded = fold(street).replace(/[^a-z0-9]+/g, '');
    return folded.length > 2 && slug.includes(folded);
  } catch {
    return false;
  }
}

function unescapeDollars(value) {
  return String(value ?? '').replace(/\$\$/g, '$');
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&sup2;/g, '²')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

function intOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function migrate(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS oneroof_listings (
  url TEXT PRIMARY KEY,
  listing_code TEXT,
  uid TEXT,
  slug TEXT,
  street TEXT,
  suburb TEXT,
  district TEXT,
  region TEXT,
  search_slug TEXT,
  category TEXT,
  listing_type TEXT,
  bedrooms INTEGER,
  bathrooms INTEGER,
  carspaces INTEGER,
  land_area TEXT,
  floor_area TEXT,
  price_bold TEXT,
  price_light TEXT,
  asking_price INTEGER,
  market_time INTEGER,
  first_seen TEXT,
  last_seen TEXT,
  disappeared_at TEXT,
  outcome TEXT NOT NULL DEFAULT 'listed',
  address_key TEXT,
  suburb_key TEXT,
  avm INTEGER,
  avm_low INTEGER,
  avm_high INTEGER,
  rv INTEGER,
  avm_confidence TEXT,
  agent_names TEXT,
  agent_phones TEXT,
  office_name TEXT,
  price_cut INTEGER NOT NULL DEFAULT 0,
  price_cut_from INTEGER,
  price_cut_to INTEGER,
  sale_id INTEGER,
  sale_price INTEGER,
  sale_date TEXT,
  lat TEXT,
  lng TEXT
);
CREATE TABLE IF NOT EXISTS oneroof_snapshots (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  suburb TEXT,
  price_bold TEXT,
  price_light TEXT,
  asking_price INTEGER,
  avm INTEGER,
  rv INTEGER,
  market_time INTEGER,
  days_on_market INTEGER,
  agent_names TEXT,
  agent_phones TEXT,
  office_name TEXT,
  present INTEGER NOT NULL DEFAULT 1,
  UNIQUE (url, snapshot_date)
);
CREATE TABLE IF NOT EXISTS oneroof_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  suburbs_done INTEGER NOT NULL DEFAULT 0,
  suburbs_total INTEGER NOT NULL DEFAULT 0,
  listings_seen INTEGER NOT NULL DEFAULT 0,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  disappeared INTEGER NOT NULL DEFAULT 0,
  message TEXT
);
CREATE TABLE IF NOT EXISTS reinz_sales (
  id INTEGER PRIMARY KEY,
  address TEXT,
  suburb TEXT,
  address_key TEXT,
  suburb_key TEXT,
  sale_price INTEGER,
  sale_date TEXT,
  list_price INTEGER,
  settlement_date TEXT,
  agreement_date TEXT,
  days_to_sell INTEGER,
  sale_category TEXT,
  sale_method TEXT,
  valuation INTEGER,
  organisation TEXT,
  bedrooms TEXT,
  floor_area TEXT,
  land_area TEXT,
  new_dwelling TEXT,
  sale_tenure TEXT,
  uploaded_at TEXT,
  UNIQUE (address_key, suburb_key, sale_date, sale_price)
);
CREATE INDEX IF NOT EXISTS oneroof_listings_suburb ON oneroof_listings(suburb);
CREATE INDEX IF NOT EXISTS oneroof_listings_search ON oneroof_listings(search_slug);
CREATE INDEX IF NOT EXISTS oneroof_listings_outcome ON oneroof_listings(outcome);
CREATE INDEX IF NOT EXISTS oneroof_listings_addr ON oneroof_listings(address_key, suburb_key);
CREATE INDEX IF NOT EXISTS oneroof_snapshots_url ON oneroof_snapshots(url, snapshot_date);
CREATE INDEX IF NOT EXISTS reinz_sales_addr ON reinz_sales(address_key, suburb_key);
`);
  const now = aucklandIso(new Date());
  db.prepare(`UPDATE oneroof_runs SET status='interrupted', finished_at=?, message=? WHERE status='running'`)
    .run(now, 'Server restarted before the collection finished');
}

function tryParse(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function parseFlight(html) {
  const raws = [...String(html || '').matchAll(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g)].map(m => m[1]);
  let blob = '';
  for (const raw of raws) {
    const decoded = tryParse('"' + raw + '"');
    blob += decoded == null ? raw : decoded;
  }
  const refs = new Map();
  const lines = blob.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([0-9a-f]+):(.*)$/i);
    if (!m) continue;
    let rest = m[2];
    if (!rest.startsWith('{') && !rest.startsWith('[')) continue;
    let parsed = tryParse(rest);
    while (parsed === undefined && i + 1 < lines.length && !/^[0-9a-f]+:/i.test(lines[i + 1])) {
      i++;
      rest += '\n' + lines[i];
      parsed = tryParse(rest);
    }
    if (parsed !== undefined) refs.set(m[1].toLowerCase(), parsed);
  }
  const totals = blob.match(/"totals":(\d+)/);
  const pageIndex = blob.match(/"pageIndex":(\d+)/);
  return {
    refs,
    totals: totals ? Number(totals[1]) : null,
    pageIndex: pageIndex ? Number(pageIndex[1]) : null,
  };
}

function resolveValue(refs, value, depth = 0, seen = new Set()) {
  if (depth > 8 || value == null) return value;
  if (typeof value === 'string' && /^\$[0-9a-f]+$/i.test(value)) {
    if (seen.has(value)) return null;
    const next = refs.get(value.slice(1).toLowerCase());
    if (next === undefined) return null;
    seen.add(value);
    return resolveValue(refs, next, depth + 1, seen);
  }
  if (Array.isArray(value)) return value.map(item => resolveValue(refs, item, depth + 1, seen));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(refs, v, depth + 1, seen);
    return out;
  }
  return value;
}

function agentFields(value) {
  const list = Array.isArray(value) ? value : [];
  const names = [];
  const phones = [];
  const seen = new Set();
  for (const agent of list) {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) continue;
    const name = String(agent.name || '').trim();
    const phone = String(agent.phoneNumber || agent.phone || '').trim();
    if (!name && !phone) continue;
    const key = name + '|' + phone;
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    phones.push(phone);
  }
  return {
    agent_names: names.filter(Boolean).join('; ') || null,
    agent_phones: phones.filter(Boolean).join('; ') || null,
  };
}

function avmFields(value, rvFallback) {
  if (value == null) return { avm: null, avm_low: null, avm_high: null, rv: parseMoney(rvFallback), avm_confidence: null };
  if (typeof value === 'string' || typeof value === 'number') {
    return { avm: parseMoney(value), avm_low: null, avm_high: null, rv: parseMoney(rvFallback), avm_confidence: null };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { avm: null, avm_low: null, avm_high: null, rv: parseMoney(rvFallback), avm_confidence: null };
  }
  return {
    avm: parseMoney(value.avm),
    avm_low: parseMoney(value.low),
    avm_high: parseMoney(value.high),
    rv: parseMoney(value.rv) || parseMoney(rvFallback),
    avm_confidence: value.confidenceScore ? String(value.confidenceScore) : null,
  };
}

function recordFrom(raw, refs) {
  const agents = agentFields(resolveValue(refs, raw.agents));
  const office = resolveValue(refs, raw.office);
  const avm = avmFields(resolveValue(refs, raw.avm), raw.rv);
  let url = String(raw.shareLink || '');
  if (url.startsWith('/')) url = BASE + url;
  const street = decodeEntities(raw.street).replace(/\s+/g, ' ').trim();
  return {
    url,
    listing_code: raw.code ? String(raw.code) : null,
    uid: raw.uid ? String(raw.uid) : (url ? url.replace(/\/+$/, '').split('/').pop() : null),
    slug: raw.slug ? String(raw.slug) : null,
    street,
    suburb: raw.suburb ? decodeEntities(raw.suburb).trim() : null,
    district: raw.district ? decodeEntities(raw.district).trim() : null,
    region: raw.region ? String(raw.region) : null,
    category: raw.category ? String(raw.category) : null,
    listing_type: raw.type ? String(raw.type) : null,
    bedrooms: intOrNull(raw.bedrooms),
    bathrooms: intOrNull(raw.bathrooms),
    carspaces: intOrNull(raw.carspaces),
    land_area: raw.landAreaString ? decodeEntities(raw.landAreaString) : (raw.landarea != null ? String(raw.landarea) : null),
    floor_area: raw.floorAreaString ? decodeEntities(raw.floorAreaString) : (raw.floorarea != null ? String(raw.floorarea) : null),
    price_bold: raw.priceBold ? unescapeDollars(decodeEntities(raw.priceBold)).trim() : null,
    price_light: raw.priceLight ? unescapeDollars(decodeEntities(raw.priceLight)).trim() : null,
    asking_price: parseMoney(raw.priceBold) || parseMoney(raw.priceLight),
    market_time: intOrNull(raw.marketTime),
    avm: avm.avm,
    avm_low: avm.avm_low,
    avm_high: avm.avm_high,
    rv: avm.rv,
    avm_confidence: avm.avm_confidence,
    agent_names: agents.agent_names,
    agent_phones: agents.agent_phones,
    office_name: office && typeof office === 'object' && office.name ? String(office.name) : null,
    lat: raw.lat == null ? null : String(raw.lat),
    lng: raw.lng == null ? null : String(raw.lng),
  };
}

function collectObjects(refs) {
  const found = [];
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value) && typeof value.shareLink === 'string' && typeof value.street === 'string' && value.street.trim()) {
      found.push(value);
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') walk(child);
    }
  }
  for (const value of refs.values()) walk(value);
  return found;
}

// Each listing is one JSON object, so the street and the shareLink cannot swap
// the way a wide text window can (the prototype attached "36 Ramwall Place" to a Sykes Road URL).
function parseOneRoofHtml(html) {
  const flight = parseFlight(html);
  const byUrl = new Map();
  for (const raw of collectObjects(flight.refs)) {
    const rec = recordFrom(raw, flight.refs);
    if (!rec.url || !rec.street || !rec.url.includes('/property/')) continue;
    const prev = byUrl.get(rec.url);
    if (!prev || scoreRecord(rec) > scoreRecord(prev)) byUrl.set(rec.url, rec);
  }
  return {
    listings: [...byUrl.values()],
    totals: flight.totals,
    pageIndex: flight.pageIndex,
  };
}

function scoreRecord(rec) {
  let score = 0;
  if (rec.agent_phones) score += 4;
  if (rec.agent_names) score += 2;
  if (rec.avm) score += 1;
  if (rec.asking_price) score += 1;
  if (rec.office_name) score += 1;
  return score;
}

function saveSuburb(db, listings, opts) {
  const nowIso = opts.nowIso;
  const snapDate = opts.snapDate;
  const searchSlug = opts.searchSlug;
  const now = opts.now || new Date();
  const selectFirst = db.prepare('SELECT first_seen FROM oneroof_listings WHERE url=?');
  const priorPeak = db.prepare('SELECT MAX(asking_price) AS m FROM oneroof_snapshots WHERE url=? AND snapshot_date<? AND asking_price IS NOT NULL');
  const todaySnap = db.prepare('SELECT asking_price FROM oneroof_snapshots WHERE url=? AND snapshot_date=?');
  const upsert = db.prepare(`INSERT INTO oneroof_listings (
    url, listing_code, uid, slug, street, suburb, district, region, search_slug,
    category, listing_type, bedrooms, bathrooms, carspaces, land_area, floor_area,
    price_bold, price_light, asking_price, market_time, first_seen, last_seen, disappeared_at, outcome,
    address_key, suburb_key, avm, avm_low, avm_high, rv, avm_confidence,
    agent_names, agent_phones, office_name, price_cut, price_cut_from, price_cut_to,
    sale_id, sale_price, sale_date, lat, lng
  ) VALUES (
    @url, @listing_code, @uid, @slug, @street, @suburb, @district, @region, @search_slug,
    @category, @listing_type, @bedrooms, @bathrooms, @carspaces, @land_area, @floor_area,
    @price_bold, @price_light, @asking_price, @market_time, @first_seen, @last_seen, NULL, 'listed',
    @address_key, @suburb_key, @avm, @avm_low, @avm_high, @rv, @avm_confidence,
    @agent_names, @agent_phones, @office_name, @price_cut, @price_cut_from, @price_cut_to,
    NULL, NULL, NULL, @lat, @lng
  ) ON CONFLICT(url) DO UPDATE SET
    listing_code=excluded.listing_code, uid=excluded.uid, slug=excluded.slug,
    street=excluded.street, suburb=excluded.suburb, district=excluded.district, region=excluded.region,
    search_slug=excluded.search_slug, category=excluded.category, listing_type=excluded.listing_type,
    bedrooms=excluded.bedrooms, bathrooms=excluded.bathrooms, carspaces=excluded.carspaces,
    land_area=excluded.land_area, floor_area=excluded.floor_area,
    price_bold=excluded.price_bold, price_light=excluded.price_light, asking_price=excluded.asking_price,
    market_time=excluded.market_time, last_seen=excluded.last_seen, disappeared_at=NULL, outcome='listed',
    address_key=excluded.address_key, suburb_key=excluded.suburb_key,
    avm=excluded.avm, avm_low=excluded.avm_low, avm_high=excluded.avm_high, rv=excluded.rv,
    avm_confidence=excluded.avm_confidence, agent_names=excluded.agent_names, agent_phones=excluded.agent_phones,
    office_name=excluded.office_name, price_cut=excluded.price_cut, price_cut_from=excluded.price_cut_from,
    price_cut_to=excluded.price_cut_to, sale_id=NULL, sale_price=NULL, sale_date=NULL, lat=excluded.lat, lng=excluded.lng`);
  const snap = db.prepare(`INSERT INTO oneroof_snapshots (
    url, snapshot_date, suburb, price_bold, price_light, asking_price, avm, rv, market_time, days_on_market,
    agent_names, agent_phones, office_name, present
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT(url, snapshot_date) DO UPDATE SET
    suburb=excluded.suburb, price_bold=excluded.price_bold, price_light=excluded.price_light,
    asking_price=excluded.asking_price, avm=excluded.avm, rv=excluded.rv, market_time=excluded.market_time,
    days_on_market=excluded.days_on_market, agent_names=excluded.agent_names, agent_phones=excluded.agent_phones,
    office_name=excluded.office_name, present=1`);
  const absent = db.prepare(`INSERT INTO oneroof_snapshots (url, snapshot_date, suburb, present)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(url, snapshot_date) DO UPDATE SET present=0`);

  const tx = db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS opp_seen');
    db.exec('CREATE TEMP TABLE opp_seen (url TEXT PRIMARY KEY)');
    const markSeen = db.prepare('INSERT OR IGNORE INTO opp_seen(url) VALUES (?)');
    const seen = new Set();
    for (const rec of listings) {
      if (!rec || !rec.url || !rec.street || seen.has(rec.url)) continue;
      seen.add(rec.url);
      const asking = rec.asking_price == null ? null : rec.asking_price;
      const prior = priorPeak.get(rec.url, snapDate);
      const today = todaySnap.get(rec.url, snapDate);
      let peak = prior && prior.m ? prior.m : null;
      if (today && today.asking_price && (peak == null || today.asking_price > peak)) peak = today.asking_price;
      const cut = asking && peak && asking < peak
        ? { price_cut: 1, price_cut_from: peak, price_cut_to: asking }
        : { price_cut: 0, price_cut_from: null, price_cut_to: null };
      const existing = selectFirst.get(rec.url);
      upsert.run({
        ...rec,
        search_slug: searchSlug,
        first_seen: existing ? existing.first_seen : nowIso,
        last_seen: nowIso,
        address_key: addressKey(rec.street, rec.suburb),
        suburb_key: normaliseSuburb(rec.suburb),
        ...cut,
      });
      snap.run(
        rec.url, snapDate, rec.suburb, rec.price_bold, rec.price_light, asking, rec.avm, rec.rv,
        rec.market_time, daysOnMarket(rec.market_time, now), rec.agent_names, rec.agent_phones, rec.office_name
      );
      markSeen.run(rec.url);
    }
    const disappeared = db.prepare(`UPDATE oneroof_listings
      SET disappeared_at=@now, outcome=CASE WHEN outcome='sold' THEN outcome ELSE 'withdrawn' END
      WHERE search_slug=@slug AND disappeared_at IS NULL AND url NOT IN (SELECT url FROM opp_seen)`).run({ now: nowIso, slug: searchSlug });
    const missing = db.prepare('SELECT url, suburb FROM oneroof_listings WHERE search_slug=? AND disappeared_at=?').all(searchSlug, nowIso);
    for (const row of missing) absent.run(row.url, snapDate, row.suburb);
    return { saved: seen.size, disappeared: disappeared.changes };
  });
  const saved = tx();
  matchSales(db);
  return saved;
}

function formatMoney(n) {
  if (n == null || !Number.isFinite(Number(n))) return '';
  return new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD', maximumFractionDigits: 0 }).format(Number(n));
}

function formatDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso);
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return dt.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function reasonFor(row) {
  const bits = [];
  if (row.outcome === 'sold') {
    const price = row.sale_price ? formatMoney(row.sale_price) : 'a recorded price';
    const when = row.sale_date ? ` on ${formatDate(row.sale_date)}` : '';
    bits.push(`Sold for ${price}${when} - matched from the REINZ export`);
  } else if (row.outcome === 'withdrawn') {
    bits.push('Withdrawn / likely unsold - follow up while it is off the market');
  } else {
    if (row.days >= 300) bits.push('Still listed after 300+ days - approach with a fresh plan');
    else if (row.days >= 90) bits.push('Still listed after 90+ days - approach with a fresh plan');
    else if (row.days >= 60) bits.push('Still listed after 60 days - worth a conversation');
    if (row.price_cut && row.price_cut_from && row.price_cut_to) {
      bits.push(`Asking dropped from ${formatMoney(row.price_cut_from)} to ${formatMoney(row.price_cut_to)}`);
    } else if (row.price_cut) bits.push('The asking price has been cut');
    if (row.asking && row.avm && row.asking < row.avm) bits.push('Asking is under the OneRoof estimate');
  }
  return bits.join('. ') || 'On the market';
}

function shape(row, now) {
  const days = daysOnMarket(row.market_time, now);
  const asking = row.asking_price == null ? null : row.asking_price;
  const avm = row.avm == null ? null : row.avm;
  const gap = asking && avm ? Math.round((asking - avm) / avm * 1000) / 10 : null;
  const shaped = {
    url: row.url,
    street: row.street || '',
    suburb: row.suburb || '',
    district: row.district || '',
    category: row.category || '',
    agent_names: row.agent_names || '',
    agent_phones: row.agent_phones || '',
    office_name: row.office_name || '',
    days,
    price_display: [row.price_bold, row.price_light].filter(Boolean).join(' · '),
    asking,
    avm,
    gap_pct: gap,
    outcome: row.outcome || 'listed',
    status: row.outcome === 'sold' ? 'Sold' : row.outcome === 'withdrawn' ? 'Withdrawn / likely unsold' : 'Listed',
    price_cut: !!row.price_cut,
    price_cut_from: row.price_cut_from,
    price_cut_to: row.price_cut_to,
    sale_price: row.sale_price,
    sale_date: row.sale_date,
  };
  shaped.reason = reasonFor(shaped);
  return shaped;
}

function matchesType(row, type) {
  if (!type) return true;
  if (type === '60-89') return row.outcome === 'listed' && row.days != null && row.days >= 60 && row.days < 90;
  if (type === '90+') return row.outcome === 'listed' && row.days != null && row.days >= 90;
  if (type === '300+') return row.outcome === 'listed' && row.days != null && row.days >= 300;
  if (type === 'withdrawn') return row.outcome === 'withdrawn';
  if (type === 'under') return row.outcome === 'listed' && row.asking && row.avm && row.asking < row.avm;
  if (type === 'cut') return row.outcome === 'listed' && row.price_cut;
  if (type === 'sold') return row.outcome === 'sold';
  return true;
}

function cardsOf(rows) {
  return {
    d60: rows.filter(r => matchesType(r, '60-89')).length,
    d90: rows.filter(r => matchesType(r, '90+')).length,
    d300: rows.filter(r => matchesType(r, '300+')).length,
    withdrawn: rows.filter(r => matchesType(r, 'withdrawn')).length,
    under: rows.filter(r => matchesType(r, 'under')).length,
    cut: rows.filter(r => matchesType(r, 'cut')).length,
    sold: rows.filter(r => matchesType(r, 'sold')).length,
  };
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function compareRows(a, b, key, dir) {
  const va = a[key];
  const vb = b[key];
  if (va == null && vb == null) return 0;
  if (va == null) return 1;
  if (vb == null) return -1;
  let c;
  if (typeof va === 'number' && typeof vb === 'number') c = va - vb;
  else c = String(va).localeCompare(String(vb), 'en-NZ', { numeric: true, sensitivity: 'base' });
  return dir === 'asc' ? c : -c;
}

const SORT_KEYS = {
  address: 'street', suburb: 'suburb', agent: 'agent_names', agency: 'office_name',
  days: 'days', price: 'asking', asking: 'asking', estimate: 'avm', gap: 'gap_pct',
  status: 'status', reason: 'reason',
};

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en-NZ'));
}

function queryOpportunities(db, filters = {}, now = new Date()) {
  const all = db.prepare('SELECT * FROM oneroof_listings').all().map(row => shape(row, now));
  const sortKey = SORT_KEYS[filters.sort] || 'days';
  const dir = filters.dir === 'asc' ? 'asc' : 'desc';
  let rows = all;
  if (filters.suburb) rows = rows.filter(r => r.suburb === filters.suburb);
  if (filters.district) rows = rows.filter(r => r.district === filters.district);
  if (filters.category) rows = rows.filter(r => r.category === filters.category);
  if (filters.type) rows = rows.filter(r => matchesType(r, filters.type));
  const minDays = numOrNull(filters.min_days);
  const maxDays = numOrNull(filters.max_days);
  if (minDays != null) rows = rows.filter(r => r.days != null && r.days >= minDays);
  if (maxDays != null) rows = rows.filter(r => r.days != null && r.days <= maxDays);
  rows = rows.slice().sort((a, b) => compareRows(a, b, sortKey, dir) || a.street.localeCompare(b.street, 'en-NZ'));
  const run = db.prepare('SELECT * FROM oneroof_runs ORDER BY id DESC LIMIT 1').get() || null;
  return {
    cards: cardsOf(all),
    total: all.length,
    shown: rows.length,
    rows,
    suburbs: uniqueSorted(all.map(r => r.suburb)),
    districts: uniqueSorted(all.map(r => r.district)),
    categories: uniqueSorted(all.map(r => r.category)),
    run,
  };
}

function csvEsc(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const CSV_COLUMNS = [
  ['address', 'street'],
  ['suburb', 'suburb'],
  ['district', 'district'],
  ['category', 'category'],
  ['agent', 'agent_names'],
  ['phone', 'agent_phones'],
  ['agency', 'office_name'],
  ['days_listed', 'days'],
  ['price_display', 'price_display'],
  ['asking', 'asking'],
  ['estimate', 'avm'],
  ['gap_pct', 'gap_pct'],
  ['status', 'status'],
  ['reason', 'reason'],
  ['sale_price', 'sale_price'],
  ['sale_date', 'sale_date'],
  ['url', 'url'],
];

function toCsv(rows) {
  const head = CSV_COLUMNS.map(([name]) => name).join(',');
  const body = rows.map(row => CSV_COLUMNS.map(([, key]) => csvEsc(row[key])).join(','));
  return [head, ...body].join('\n') + '\n';
}

function rowsForExport(db, body, now = new Date()) {
  const urls = body && Array.isArray(body.urls) ? body.urls.map(u => String(u)) : null;
  if (urls && urls.length) {
    const want = new Set(urls);
    const all = queryOpportunities(db, {}, now).rows;
    return urls.map(url => all.find(row => row.url === url)).filter(row => row && want.has(row.url));
  }
  return queryOpportunities(db, (body && body.filters) || {}, now).rows;
}

function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!src.trim()) return [];
  const firstLine = src.split('\n')[0];
  const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(cell => String(cell).trim() !== ''));
}

function canonHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const HEADER_ALIASES = [
  ['address', ['address', 'property address', 'street address', 'listing address', 'full address']],
  ['suburb', ['suburb', 'suburb name', 'suburbs']],
  ['sale_price', ['sale price', 'sold price', 'saleprice', 'price sold', 'sale']],
  ['sale_date', ['sale date', 'sold date', 'saledate', 'date sold', 'date of sale']],
  ['list_price', ['list price', 'listing price', 'listprice', 'asking price']],
  ['settlement_date', ['settlement date', 'settlement']],
  ['agreement_date', ['agreement date', 'unconditional date']],
  ['days_to_sell', ['days to sell', 'days to sell days']],
  ['sale_category', ['sale category', 'category']],
  ['sale_method', ['sale method', 'method of sale', 'method']],
  ['valuation', ['valuation', 'capital value', 'cv', 'rv']],
  ['organisation', ['organisation', 'organization', 'agency', 'company', 'office']],
  ['bedrooms', ['bedrooms', 'beds']],
  ['floor_area', ['floor area', 'floorarea']],
  ['land_area', ['land area', 'landarea']],
  ['new_dwelling', ['new dwelling', 'new build']],
  ['sale_tenure', ['sale tenure', 'tenure']],
];

function mapHeaders(headers) {
  const index = {};
  const used = new Set();
  headers.forEach((header, i) => {
    const name = canonHeader(header);
    for (const [field, aliases] of HEADER_ALIASES) {
      if (used.has(field)) continue;
      if (aliases.includes(name)) { index[field] = i; used.add(field); break; }
    }
  });
  if (!used.has('sale_price')) {
    headers.forEach((header, i) => {
      if (used.has('sale_price')) return;
      if (canonHeader(header) === 'price' && !Object.values(index).includes(i)) {
        index.sale_price = i;
        used.add('sale_price');
      }
    });
  }
  return index;
}

function cell(row, index, field) {
  if (index[field] == null) return '';
  return row[index[field]] == null ? '' : String(row[index[field]]).trim();
}

function parseNzDate(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (!m) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return validDate(year, +m[2], +m[1]);
}

function validDate(y, m, d) {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function importReinzCsv(db, text) {
  const table = parseCsv(text);
  if (!table.length) return { error: 'The CSV is empty' };
  const index = mapHeaders(table[0]);
  if (index.address == null || index.suburb == null) {
    return { error: 'The CSV needs Address and Suburb columns. Export it from the REINZ Statistics Portal.' };
  }
  const uploadedAt = aucklandIso(new Date());
  const insert = db.prepare(`INSERT INTO reinz_sales (
    address, suburb, address_key, suburb_key, sale_price, sale_date, list_price, settlement_date, agreement_date,
    days_to_sell, sale_category, sale_method, valuation, organisation, bedrooms, floor_area, land_area,
    new_dwelling, sale_tenure, uploaded_at
  ) VALUES (
    @address, @suburb, @address_key, @suburb_key, @sale_price, @sale_date, @list_price, @settlement_date, @agreement_date,
    @days_to_sell, @sale_category, @sale_method, @valuation, @organisation, @bedrooms, @floor_area, @land_area,
    @new_dwelling, @sale_tenure, @uploaded_at
  ) ON CONFLICT(address_key, suburb_key, sale_date, sale_price) DO UPDATE SET
    address=excluded.address, suburb=excluded.suburb, list_price=excluded.list_price,
    settlement_date=excluded.settlement_date, agreement_date=excluded.agreement_date,
    days_to_sell=excluded.days_to_sell, sale_category=excluded.sale_category, sale_method=excluded.sale_method,
    valuation=excluded.valuation, organisation=excluded.organisation, bedrooms=excluded.bedrooms,
    floor_area=excluded.floor_area, land_area=excluded.land_area, new_dwelling=excluded.new_dwelling,
    sale_tenure=excluded.sale_tenure, uploaded_at=excluded.uploaded_at`);
  let inserted = 0;
  let skipped = 0;
  const tx = db.transaction(() => {
    for (const row of table.slice(1)) {
      if (inserted + skipped > 20000) break;
      const suburb = cell(row, index, 'suburb');
      const addressText = cell(row, index, 'address');
      if (!addressText || !suburb) { skipped++; continue; }
      const info = insert.run({
        address: addressText,
        suburb,
        address_key: addressKey(addressText, suburb),
        suburb_key: normaliseSuburb(suburb),
        sale_price: parseMoney(cell(row, index, 'sale_price')),
        sale_date: parseNzDate(cell(row, index, 'sale_date')),
        list_price: parseMoney(cell(row, index, 'list_price')),
        settlement_date: parseNzDate(cell(row, index, 'settlement_date')),
        agreement_date: parseNzDate(cell(row, index, 'agreement_date')),
        days_to_sell: intOrNull(cell(row, index, 'days_to_sell')),
        sale_category: cell(row, index, 'sale_category') || null,
        sale_method: cell(row, index, 'sale_method') || null,
        valuation: parseMoney(cell(row, index, 'valuation')),
        organisation: cell(row, index, 'organisation') || null,
        bedrooms: cell(row, index, 'bedrooms') || null,
        floor_area: cell(row, index, 'floor_area') || null,
        land_area: cell(row, index, 'land_area') || null,
        new_dwelling: cell(row, index, 'new_dwelling') || null,
        sale_tenure: cell(row, index, 'sale_tenure') || null,
        uploaded_at: uploadedAt,
      });
      if (info.changes) inserted++;
    }
  });
  tx();
  const matched = matchSales(db);
  return { ok: true, inserted, skipped, sold: matched.sold, sales: db.prepare('SELECT COUNT(*) AS n FROM reinz_sales').get().n };
}

function matchSales(db) {
  const sales = db.prepare(`SELECT id, address_key, suburb_key, sale_price, sale_date
    FROM reinz_sales WHERE address_key != '' AND suburb_key != ''
    ORDER BY sale_date DESC, id DESC`).all();
  const best = new Map();
  for (const sale of sales) {
    const key = sale.address_key + '|' + sale.suburb_key;
    if (!best.has(key)) best.set(key, sale);
  }
  const listings = db.prepare('SELECT url, address_key, suburb_key, disappeared_at FROM oneroof_listings').all();
  const markSold = db.prepare(`UPDATE oneroof_listings SET outcome='sold', sale_id=?, sale_price=?, sale_date=? WHERE url=?`);
  const markWithdrawn = db.prepare(`UPDATE oneroof_listings SET outcome='withdrawn', sale_id=NULL, sale_price=NULL, sale_date=NULL WHERE url=?`);
  let sold = 0;
  const tx = db.transaction(() => {
    for (const row of listings) {
      if (!row.disappeared_at) continue;
      const sale = best.get((row.address_key || '') + '|' + (row.suburb_key || ''));
      if (sale) {
        markSold.run(sale.id, sale.sale_price, sale.sale_date, row.url);
        sold++;
      } else markWithdrawn.run(row.url);
    }
  });
  tx();
  return { sold };
}

function looksBlocked(status, html) {
  if (status === 401 || status === 403 || status === 451) return true;
  const head = String(html || '').slice(0, 12000);
  return head.includes('Just a moment')
    || head.includes('cf-challenge')
    || head.includes('cf-browser-verification')
    || head.includes('challenge-platform')
    || head.includes('Attention Required');
}

async function fetchHtml(url, ctx) {
  const waits = [0, 4000, 12000, 30000];
  let last = 'no response';
  for (let attempt = 0; attempt < waits.length; attempt++) {
    if (waits[attempt]) await ctx.sleep(waits[attempt]);
    try {
      const res = await ctx.fetchImpl(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-NZ,en;q=0.9',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(45000),
      });
      const html = await res.text();
      if (looksBlocked(res.status, html)) {
        return { blocked: true, message: `Stopped on a block or challenge (HTTP ${res.status}) for ${url}` };
      }
      if (res.status === 429 || res.status >= 500) {
        last = `HTTP ${res.status}`;
        ctx.log(`[opportunities] retry ${attempt + 1} ${url} ${last}`);
        continue;
      }
      if (res.status !== 200) {
        return { blocked: true, message: `Stopped on HTTP ${res.status} for ${url}` };
      }
      return { blocked: false, html };
    } catch (err) {
      last = err && err.name === 'TimeoutError' ? 'timeout' : (err && err.message ? err.message : 'network error');
      ctx.log(`[opportunities] retry ${attempt + 1} ${url} ${last}`);
    }
  }
  return { blocked: true, message: `Gave up after retries for ${url} (${last})` };
}

async function collectSuburb(db, suburb, ctx) {
  const seen = [];
  const seenUrls = new Set();
  let totals = null;
  let pages = 0;
  const want = normaliseSuburb(suburb.suburb);
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (ctx.polite) await ctx.polite();
    const url = `${BASE}/search/houses-for-sale/${suburb.slug}_page_${page}`;
    ctx.log(`[opportunities] GET ${url}`);
    const fetched = await fetchHtml(url, ctx);
    if (fetched.blocked) {
      return { stopped: true, message: fetched.message, pages, listings: seen.length, disappeared: 0 };
    }
    pages++;
    const parsed = parseOneRoofHtml(fetched.html);
    if (totals == null) totals = parsed.totals;
    if (!parsed.listings.length) {
      if (page === 1 && totals === 0) break;
      if (page === 1) {
        return {
          stopped: true,
          message: `No listings found in the page for ${suburb.suburb}. Stopped before marking anything withdrawn. ${url}`,
          pages,
          listings: 0,
          disappeared: 0,
        };
      }
      break;
    }
    const matched = parsed.listings.filter(rec => normaliseSuburb(rec.suburb) === want);
    if (!matched.length) {
      return {
        stopped: true,
        message: `Parsed listings for ${suburb.suburb} but the suburb name on the page was "${parsed.listings[0].suburb}". Stopped before marking withdrawals.`,
        pages,
        listings: 0,
        disappeared: 0,
      };
    }
    let added = 0;
    for (const rec of matched) {
      if (seenUrls.has(rec.url)) continue;
      if (!addressMatchesUrl(rec.street, rec.url)) {
        ctx.log(`[opportunities] address does not match URL, kept the page object: ${rec.street} ${rec.url}`);
      }
      seenUrls.add(rec.url);
      seen.push(rec);
      added++;
    }
    if (ctx.onPage) ctx.onPage({ suburb, page, pages, listings: seen.length, totals });
    if (added === 0) break;
    if (totals != null && seen.length >= totals) break;
    if (parsed.listings.length < PAGE_SIZE) break;
  }
  const saved = saveSuburb(db, seen, {
    searchSlug: suburb.slug,
    nowIso: ctx.nowIso,
    snapDate: ctx.snapDate,
    now: ctx.now,
  });
  return { stopped: false, pages, listings: saved.saved, disappeared: saved.disappeared, totals };
}

function createRunner(opts) {
  const db = opts.db;
  const log = opts.log || (() => {});
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const sleep = opts.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const delayMs = opts.delayMs == null ? 2000 : opts.delayMs;
  const suburbList = opts.suburbs || loadSuburbs();
  let inflight = null;

  function status() {
    const row = db.prepare('SELECT * FROM oneroof_runs ORDER BY id DESC LIMIT 1').get() || null;
    const running = inflight !== null;
    if (!row) {
      return {
        status: running ? 'running' : 'never',
        running,
        suburbs_done: 0,
        suburbs_total: suburbList.length,
        listings_seen: 0,
        pages_fetched: 0,
        disappeared: 0,
        message: null,
        started_at: null,
        finished_at: null,
        trigger: null,
      };
    }
    return { ...row, running: running && row.status === 'running' };
  }

  async function run(trigger) {
    const now = opts.now ? opts.now() : new Date();
    const nowIso = aucklandIso(now);
    const snapDate = aucklandDate(now);
    const info = db.prepare(`INSERT INTO oneroof_runs
      (started_at, status, trigger, suburbs_total, message)
      VALUES (?, 'running', ?, ?, ?)`).run(nowIso, trigger, suburbList.length, 'Starting');
    const id = Number(info.lastInsertRowid);
    const progress = { done: 0, pages: 0, seen: 0, disappeared: 0 };
    const update = (message) => {
      db.prepare(`UPDATE oneroof_runs SET suburbs_done=?, pages_fetched=?, listings_seen=?, disappeared=?, message=? WHERE id=?`)
        .run(progress.done, progress.pages, progress.seen, progress.disappeared, message, id);
    };
    const finish = (statusName, message) => {
      db.prepare(`UPDATE oneroof_runs SET status=?, finished_at=?, suburbs_done=?, pages_fetched=?, listings_seen=?, disappeared=?, message=? WHERE id=?`)
        .run(statusName, aucklandIso(new Date()), progress.done, progress.pages, progress.seen, progress.disappeared, message, id);
      log(`[opportunities] ${statusName}: ${message}`);
      return {
        status: statusName,
        message,
        suburbs_done: progress.done,
        suburbs_total: suburbList.length,
        listings_seen: progress.seen,
        pages_fetched: progress.pages,
        disappeared: progress.disappeared,
      };
    };
    let firstRequest = true;
    const ctx = {
      fetchImpl,
      sleep,
      log,
      now,
      nowIso,
      snapDate,
      polite: async () => {
        if (firstRequest) { firstRequest = false; return; }
        await sleep(delayMs);
      },
      onPage: (infoPage) => {
        const pageNote = infoPage.totals != null ? ` of about ${Math.ceil(infoPage.totals / PAGE_SIZE)}` : '';
        db.prepare(`UPDATE oneroof_runs SET pages_fetched=?, listings_seen=?, message=? WHERE id=?`).run(
          progress.pages + infoPage.pages,
          progress.seen + infoPage.listings,
          `${infoPage.suburb.suburb}: page ${infoPage.page}${pageNote}`,
          id
        );
      },
    };
    try {
      for (const suburb of suburbList) {
        update(`Collecting ${suburb.suburb} (${progress.done + 1}/${suburbList.length})`);
        const result = await collectSuburb(db, suburb, ctx);
        progress.pages += result.pages;
        progress.seen += result.listings;
        progress.disappeared += result.disappeared || 0;
        if (result.stopped) return finish('blocked', result.message);
        progress.done++;
        update(`${suburb.suburb} saved (${progress.done}/${suburbList.length})`);
      }
      const suburbWord = progress.done === 1 ? 'suburb' : 'suburbs';
      return finish('ok', `Saved ${progress.seen} listings across ${progress.done} ${suburbWord}. ${progress.disappeared} disappeared.`);
    } catch (err) {
      const message = err && err.message ? err.message : 'Collection failed';
      log(`[opportunities] error ${message}`);
      return finish('error', message);
    }
  }

  function start(trigger) {
    if (inflight) return { started: false, done: inflight, status: status() };
    let release;
    const done = new Promise(resolve => { release = resolve; });
    inflight = done;
    run(trigger || 'manual').then(result => {
      if (inflight === done) inflight = null;
      release(result);
    }, err => {
      if (inflight === done) inflight = null;
      release({ status: 'error', message: err && err.message ? err.message : 'Collection failed' });
    });
    return { started: true, done, status: status() };
  }

  function schedule() {
    const target = nextAucklandHour(5, 0);
    const delay = Math.max(1000, (target || (Date.now() + 12 * 3600 * 1000)) - Date.now());
    log(`[opportunities] next collection at 5:00am Pacific/Auckland (in ${Math.round(delay / 60000)} min)`);
    const timer = setTimeout(() => {
      const job = start('schedule');
      Promise.resolve(job.done).finally(() => schedule());
    }, delay);
    if (timer.unref) timer.unref();
    return timer;
  }

  return { start, schedule, status, suburbs: suburbList };
}

if (require.main === module) {
  const Database = require('better-sqlite3');
  const dir = process.env.DATA_DIR || __dirname;
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'data.db'));
  db.pragma('journal_mode = WAL');
  migrate(db);
  let suburbs = loadSuburbs();
  const only = process.argv[2];
  if (only) {
    const needle = only.toLowerCase();
    suburbs = suburbs.filter(s => s.slug === only || normaliseSuburb(s.suburb) === normaliseSuburb(only));
    if (!suburbs.length) {
      console.error('Unknown suburb. Pass a slug such as suburb_favona-manukau-city-2360');
      process.exit(1);
    }
  }
  const runner = createRunner({ db, suburbs, log: (...args) => console.log(...args) });
  const job = runner.start('cli');
  job.done.then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result && result.status === 'ok' ? 0 : 1);
  });
}

module.exports = {
  loadSuburbs,
  migrate,
  parseOneRoofHtml,
  parseMoney,
  daysOnMarket,
  addressKey,
  normaliseSuburb,
  normaliseAddress,
  addressMatchesUrl,
  saveSuburb,
  importReinzCsv,
  matchSales,
  queryOpportunities,
  toCsv,
  rowsForExport,
  reasonFor,
  createRunner,
  nextAucklandHour,
  aucklandIso,
  aucklandDate,
  looksBlocked,
};
