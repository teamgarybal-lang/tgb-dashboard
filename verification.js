'use strict';

// Monday/Friday check for homes that have left OneRoof.
// Leaving OneRoof, a 404, or a page that does not mention the address never
// confirms a withdrawal. A sale is recorded only when the same public agency
// page shows that address and an explicit sold marker together.
// There is no timer here. The 9am Auckland routine calls the admin endpoints.

const dns = require('dns').promises;
const net = require('net');

const CATEGORIES = ['unverified', 'confirmed_withdrawn', 'confirmed_sold', 'still_active'];
const CONFIRMED = new Set(['confirmed_withdrawn', 'confirmed_sold', 'still_active']);
const STREET_WORDS = new Set(['road', 'street', 'place', 'avenue', 'drive', 'crescent', 'lane', 'terrace', 'close', 'way', 'court', 'grove', 'rise', 'highway', 'parade', 'esplanade', 'boulevard', 'gardens', 'quay', 'glen']);

// Public company sites we are willing to fetch. Keyword search on these sites
// is often too broad to prove anything; the classifier still requires the
// street address and a status word in the same short passage.
const AGENCIES = [
  { key: 'barfoot', name: 'Barfoot & Thompson', match: /barfoot/i, hosts: ['barfoot.co.nz'],
    search: (street, suburb) => `https://www.barfoot.co.nz/properties/residential?keywords=${encodeURIComponent(`${street} ${suburb}`)}` },
  { key: 'harcourts', name: 'Harcourts', match: /harcourts/i, hosts: ['harcourts.co.nz', 'harcourts.net'],
    search: (street, suburb) => `https://www.harcourts.co.nz/nz/listings?query=${encodeURIComponent(`${street} ${suburb}`)}` },
  { key: 'bayleys', name: 'Bayleys', match: /bayleys/i, hosts: ['bayleys.co.nz'],
    search: (street, suburb) => `https://www.bayleys.co.nz/search?query=${encodeURIComponent(`${street} ${suburb}`)}` },
  { key: 'raywhite', name: 'Ray White', match: /ray\s*white/i, hosts: ['raywhite.co.nz', 'raywhite.com'],
    search: (street, suburb) => `https://www.raywhite.co.nz/search?query=${encodeURIComponent(`${street} ${suburb}`)}` },
  { key: 'ljhooker', name: 'LJ Hooker', match: /l\.?\s*j\.?\s*hooker/i, hosts: ['ljhooker.co.nz'],
    search: (street, suburb) => `https://www.ljhooker.co.nz/search?query=${encodeURIComponent(`${street} ${suburb}`)}` },
  { key: 'professionals', name: 'Professionals', match: /professionals/i, hosts: ['professionals.co.nz'],
    search: (street, suburb) => `https://www.professionals.co.nz/search?query=${encodeURIComponent(`${street} ${suburb}`)}` },
  { key: 'propertybrokers', name: 'Property Brokers', match: /property\s*brokers/i, hosts: ['propertybrokers.co.nz'],
    search: (street, suburb) => `https://www.propertybrokers.co.nz/search?query=${encodeURIComponent(`${street} ${suburb}`)}` },
  { key: 'mikepero', name: 'Mike Pero', match: /mike\s*pero/i, hosts: ['mikepero.com'],
    search: (street, suburb) => `https://www.mikepero.com/residential/search?query=${encodeURIComponent(`${street} ${suburb}`)}` },
];

function migrate(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS oneroof_listing_checks (
  listing_url TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  agency_key TEXT,
  source_url TEXT,
  checked_at TEXT NOT NULL,
  evidence_excerpt TEXT,
  matched_address TEXT,
  matched_listing_id TEXT,
  conflict TEXT,
  run_id INTEGER,
  actor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oneroof_verification_events (
  id INTEGER PRIMARY KEY,
  listing_url TEXT NOT NULL,
  run_id INTEGER,
  category TEXT NOT NULL,
  previous_category TEXT,
  source_url TEXT,
  checked_at TEXT NOT NULL,
  evidence_excerpt TEXT,
  matched_address TEXT,
  matched_listing_id TEXT,
  conflict TEXT,
  note TEXT,
  actor TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS oneroof_verification_events_listing ON oneroof_verification_events(listing_url, id);
CREATE TABLE IF NOT EXISTS oneroof_verification_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  baseline_run_id INTEGER,
  queued INTEGER NOT NULL DEFAULT 0,
  checked INTEGER NOT NULL DEFAULT 0,
  confirmed_sold INTEGER NOT NULL DEFAULT 0,
  confirmed_withdrawn INTEGER NOT NULL DEFAULT 0,
  still_active INTEGER NOT NULL DEFAULT 0,
  unverified INTEGER NOT NULL DEFAULT 0,
  message TEXT
);
`);
  const now = new Date().toISOString();
  db.prepare(`UPDATE oneroof_verification_runs SET status='interrupted', finished_at=?, message=? WHERE status='running'`)
    .run(now, 'Server restarted before the verification check finished');
}

function agencyForOffice(officeName) {
  const text = String(officeName || '');
  return AGENCIES.find(agency => agency.match.test(text)) || null;
}

function fold(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '');
}

function addressTokens(street) {
  const parts = fold(street).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const numbers = parts.filter(part => /^\d+$/.test(part));
  const number = numbers.sort((a, b) => b.length - a.length || b - a)[0];
  const name = parts.find(part => part.length >= 4 && !STREET_WORDS.has(part) && !/^\d+$/.test(part));
  return number && name ? { number, name } : null;
}

function plainText(html) {
  let text = String(html || '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<head[\s\S]*?<\/head>/gi, ' ');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, ' ');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  text = text.replace(/<header[\s\S]*?<\/header>/gi, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
  text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return text.replace(/\s+/g, ' ').trim();
}

function clip(value, max) {
  const text = String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, max);
}

function windowsFor(text, tokens) {
  const hay = text.toLowerCase();
  const windows = [];
  let from = 0;
  while (from < hay.length) {
    const at = hay.indexOf(tokens.name, from);
    if (at < 0) break;
    const start = Math.max(0, at - 140);
    const end = Math.min(text.length, at + tokens.name.length + 180);
    const slice = text.slice(start, end);
    const local = slice.toLowerCase();
    const numberRe = new RegExp(`(^|\\D)${tokens.number}(\\D|$)`);
    if (numberRe.test(local)) windows.push(slice);
    from = at + tokens.name.length;
  }
  return windows;
}

function signals(windowText) {
  const text = windowText.toLowerCase();
  return {
    sold: /\bsold\b/.test(text),
    withdrawn: /\b(withdrawn|removed from (the )?market|listing withdrawn)\b/.test(text),
    active: /\b(for sale|by negotiation|price by negotiation|auction|deadline|enquiries over|asking price)\b/.test(text),
  };
}

function classifyPage(html, listing) {
  const tokens = addressTokens(listing.street);
  if (!tokens) {
    return { category: 'unverified', evidence_excerpt: '', matched_address: '', note: 'The street address is too vague to match on an agency page.' };
  }
  const text = plainText(html);
  const found = windowsFor(text, tokens);
  if (!found.length) {
    return {
      category: 'unverified',
      evidence_excerpt: '',
      matched_address: '',
      note: 'The address was not on the agency page. A missing page does not confirm a withdrawal.',
    };
  }
  const scored = found.map(windowText => ({ windowText, ...signals(windowText) }));
  const sold = scored.filter(row => row.sold && !row.withdrawn);
  const withdrawn = scored.filter(row => row.withdrawn && !row.sold);
  const active = scored.filter(row => row.active && !row.sold && !row.withdrawn);
  const mixed = scored.some(row => (row.sold && row.withdrawn) || (row.sold && row.active) || (row.withdrawn && row.active));
  if (mixed || (sold.length && withdrawn.length) || (sold.length && active.length) || (withdrawn.length && active.length)) {
    const sample = clip(scored[0].windowText, 180);
    return {
      category: 'unverified',
      evidence_excerpt: sample,
      matched_address: listing.street,
      conflict: 'The agency page mentions more than one status next to this address.',
      note: 'Conflicting status words were left unverified.',
    };
  }
  if (sold.length) {
    return { category: 'confirmed_sold', evidence_excerpt: clip(sold[0].windowText, 180), matched_address: listing.street, note: '' };
  }
  if (withdrawn.length) {
    return { category: 'confirmed_withdrawn', evidence_excerpt: clip(withdrawn[0].windowText, 180), matched_address: listing.street, note: '' };
  }
  if (active.length) {
    return { category: 'still_active', evidence_excerpt: clip(active[0].windowText, 180), matched_address: listing.street, note: '' };
  }
  return {
    category: 'unverified',
    evidence_excerpt: clip(found[0], 180),
    matched_address: listing.street,
    note: 'The address is on the agency page without a sold, withdrawn, or for-sale marker.',
  };
}

function isPrivateAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (kind === 6) {
    const text = ip.toLowerCase();
    if (text === '::' || text === '::1') return true;
    if (text.startsWith('fc') || text.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(text)) return true;
    if (text.startsWith('::ffff:')) return isPrivateAddress(text.slice('::ffff:'.length));
    return false;
  }
  return true;
}

function hostAllowed(hostname, hosts) {
  const name = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return hosts.some(host => name === host || name.endsWith('.' + host));
}

async function assertPublicHttps(raw, lookup, hosts) {
  let url;
  try { url = new URL(String(raw || '')); } catch { throw new Error('Link is not a valid URL'); }
  if (url.protocol !== 'https:') throw new Error('Link must use https');
  if (url.username || url.password) throw new Error('Link cannot include a username or password');
  if (url.port && url.port !== '443') throw new Error('Link must use port 443');
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.localhost')) {
    throw new Error('Link host is not a public website');
  }
  if (net.isIP(hostname) && isPrivateAddress(hostname)) throw new Error('Link points at a private address');
  if (hosts && !hostAllowed(hostname, hosts)) throw new Error('Link is not on an allowed agency website');
  const looked = await lookup(hostname);
  const addresses = Array.isArray(looked) ? looked.map(row => typeof row === 'string' ? row : row.address) : [looked];
  if (!addresses.length) throw new Error('Link host did not resolve');
  for (const address of addresses) {
    if (isPrivateAddress(address)) throw new Error('Link resolves to a private address');
  }
  return url;
}

async function defaultLookup(hostname) {
  const rows = await dns.lookup(hostname, { all: true, verbatim: true });
  return rows.map(row => row.address);
}

async function fetchPublic(raw, ctx, hosts, depth = 0) {
  const url = await assertPublicHttps(raw, ctx.lookup || defaultLookup, hosts);
  const res = await ctx.fetchImpl(url.href, {
    redirect: 'manual',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; TGBOpportunities/1.0; +https://www.oneroof.co.nz)',
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-NZ,en;q=0.9',
    },
    signal: AbortSignal.timeout(ctx.timeoutMs || 15000),
  });
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    if (depth >= 3) throw new Error('Too many redirects');
    const location = typeof res.headers.get === 'function' ? res.headers.get('location') : (res.headers.location || '');
    if (!location) throw new Error('Redirect had no destination');
    const next = new URL(location, url).href;
    return fetchPublic(next, ctx, hosts, depth + 1);
  }
  const html = await res.text();
  return { status: res.status, url: url.href, html: html.slice(0, 800000) };
}

function latestFullCrawl(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(oneroof_runs)').all().map(col => col.name));
  if (!cols.has('full_complete')) return null;
  return db.prepare(`SELECT id, started_at, finished_at, status, suburbs_done, suburbs_total, message
    FROM oneroof_runs WHERE status='ok' AND full_complete=1 ORDER BY id DESC LIMIT 1`).get() || null;
}

function crawlActive(db, extra) {
  if (extra && extra()) return true;
  const row = db.prepare("SELECT 1 AS n FROM oneroof_runs WHERE status='running' LIMIT 1").get();
  return !!row;
}

function applyVerdict(db, input) {
  const now = input.checked_at;
  const previous = db.prepare('SELECT category FROM oneroof_listing_checks WHERE listing_url=?').get(input.listing_url);
  const previousCategory = previous ? previous.category : null;
  let category = input.category;
  let conflict = input.conflict || null;
  if (previousCategory && CONFIRMED.has(previousCategory) && CONFIRMED.has(category) && previousCategory !== category) {
    conflict = `Conflict: saved result was ${labelFor(previousCategory)}, new evidence says ${labelFor(category)}. Left unverified.`;
    category = 'unverified';
  }
  db.prepare(`INSERT INTO oneroof_listing_checks (
    listing_url, category, agency_key, source_url, checked_at, evidence_excerpt, matched_address, matched_listing_id, conflict, run_id, actor
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(listing_url) DO UPDATE SET
    category=excluded.category, agency_key=excluded.agency_key, source_url=excluded.source_url, checked_at=excluded.checked_at,
    evidence_excerpt=excluded.evidence_excerpt, matched_address=excluded.matched_address, matched_listing_id=excluded.matched_listing_id,
    conflict=excluded.conflict, run_id=excluded.run_id, actor=excluded.actor`).run(
    input.listing_url, category, input.agency_key || null, input.source_url || null, now,
    clip(input.evidence_excerpt, 180), clip(input.matched_address, 160), clip(input.matched_listing_id, 80),
    conflict, input.run_id || null, input.actor
  );
  db.prepare(`INSERT INTO oneroof_verification_events (
    listing_url, run_id, category, previous_category, source_url, checked_at, evidence_excerpt, matched_address, matched_listing_id, conflict, note, actor
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.listing_url, input.run_id || null, category, previousCategory, input.source_url || null, now,
    clip(input.evidence_excerpt, 180), clip(input.matched_address, 160), clip(input.matched_listing_id, 80),
    conflict, clip(input.note, 240), input.actor
  );
  return { category, conflict, previous_category: previousCategory };
}

function labelFor(category) {
  if (category === 'confirmed_sold') return 'confirmed sold';
  if (category === 'confirmed_withdrawn') return 'confirmed withdrawn';
  if (category === 'still_active') return 'still active';
  if (category === 'unchecked') return 'not checked';
  return 'unverified';
}

function excerptSupports(listing, category, excerpt) {
  const tokens = addressTokens(listing.street);
  if (!tokens) return 'This listing address cannot be matched safely.';
  const text = fold(excerpt);
  const numberRe = new RegExp(`(^|\\D)${tokens.number}(\\D|$)`);
  if (!text.includes(tokens.name) || !numberRe.test(text)) return 'The evidence text must include this listing’s street number and street name.';
  if (category === 'confirmed_sold' && !/\bsold\b/.test(text)) return 'Sold evidence must say sold next to the address.';
  if (category === 'confirmed_withdrawn' && !/\b(withdrawn|removed from (the )?market|listing withdrawn)\b/.test(text)) {
    return 'Withdrawn evidence must say withdrawn or removed from the market next to the address.';
  }
  if (category === 'still_active' && !/\b(for sale|by negotiation|price by negotiation|auction|deadline|enquiries over|asking price)\b/.test(text)) {
    return 'Active evidence must show the address is still for sale.';
  }
  return '';
}

async function submitEvidence(db, body, lookup) {
  const listingUrl = String(body && body.url || '').trim();
  const listing = db.prepare('SELECT url, street, suburb, disappeared_at FROM oneroof_listings WHERE url=?').get(listingUrl);
  if (!listing) return { error: 'Listing not found' };
  const category = String(body.category || '');
  if (!CATEGORIES.includes(category)) return { error: 'Category must be confirmed_sold, confirmed_withdrawn, still_active, or unverified' };
  const excerpt = clip(body.evidence_excerpt, 180);
  if (category !== 'unverified') {
    const problem = excerptSupports(listing, category, excerpt);
    if (problem) return { error: problem };
  }
  let sourceUrl = String(body.source_url || '').trim();
  if (category !== 'unverified') {
    if (!sourceUrl) return { error: 'A public https evidence link is required' };
    try {
      const checked = await assertPublicHttps(sourceUrl, lookup || defaultLookup, null);
      sourceUrl = checked.href;
    } catch (err) {
      return { error: err.message || 'Evidence link was rejected' };
    }
  } else if (sourceUrl) {
    try {
      const checked = await assertPublicHttps(sourceUrl, lookup || defaultLookup, null);
      sourceUrl = checked.href;
    } catch (err) {
      return { error: err.message || 'Evidence link was rejected' };
    }
  }
  const saved = applyVerdict(db, {
    listing_url: listing.url,
    category,
    agency_key: agencyForOffice(body.agency || '') ? agencyForOffice(body.agency).key : null,
    source_url: sourceUrl || null,
    checked_at: new Date().toISOString(),
    evidence_excerpt: excerpt,
    matched_address: clip(body.matched_address || listing.street, 160),
    matched_listing_id: clip(body.matched_listing_id, 80),
    conflict: null,
    note: clip(body.note, 240),
    actor: 'routine',
    run_id: null,
  });
  return { ok: true, listing_url: listing.url, category: saved.category, conflict: saved.conflict, checked_at: new Date().toISOString() };
}

function decorate(db, rows) {
  const present = db.prepare("SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name='oneroof_listing_checks'").get();
  const map = new Map();
  if (present) {
    for (const row of db.prepare('SELECT * FROM oneroof_listing_checks').all()) map.set(row.listing_url, row);
  }
  for (const row of rows) {
    const check = map.get(row.url);
    row.verification = check ? check.category : 'unchecked';
    row.evidence_excerpt = check ? check.evidence_excerpt || '' : '';
    row.evidence_url = check ? check.source_url || '' : '';
    row.evidence_checked_at = check ? check.checked_at || '' : '';
    row.matched_address = check ? check.matched_address || '' : '';
    row.matched_listing_id = check ? check.matched_listing_id || '' : '';
    row.verification_conflict = check ? check.conflict || '' : '';
    row.verification_label = labelFor(row.verification);
  }
  return rows;
}

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function reportCsv(rows) {
  const cols = ['street', 'suburb', 'district', 'office_name', 'verification', 'evidence_excerpt', 'evidence_url', 'evidence_checked_at', 'matched_address', 'matched_listing_id', 'verification_conflict', 'outcome', 'disappeared_at', 'url'];
  return [cols.join(','), ...rows.map(row => cols.map(col => csvCell(row[col])).join(','))].join('\n') + '\n';
}

function reportRows(db, filters = {}) {
  const listings = db.prepare(`SELECT url, street, suburb, district, office_name, agent_names, agent_phones, disappeared_at, outcome
    FROM oneroof_listings WHERE disappeared_at IS NOT NULL ORDER BY suburb, street`).all();
  decorate(db, listings);
  let rows = listings;
  if (filters.category) rows = rows.filter(row => row.verification === filters.category);
  if (filters.suburb) rows = rows.filter(row => row.suburb === filters.suburb);
  return rows;
}

function statusOf(db, running) {
  const run = db.prepare('SELECT * FROM oneroof_verification_runs ORDER BY id DESC LIMIT 1').get() || null;
  return {
    crawl_active: crawlActive(db, null) || !!running,
    latest_full_crawl: latestFullCrawl(db),
    run: run ? { ...run, running: !!running && run.status === 'running' } : { status: 'never', running: false },
  };
}

function createChecker(opts) {
  const db = opts.db;
  const log = opts.log || (() => {});
  const sleep = opts.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const delayMs = opts.delayMs == null ? 2000 : opts.delayMs;
  let inflight = null;

  function status() {
    return statusOf(db, inflight !== null);
  }

  async function checkOne(listing, runId, ctx) {
    const agency = agencyForOffice(listing.office_name);
    const checkedAt = new Date().toISOString();
    if (!agency) {
      return applyVerdict(db, {
        listing_url: listing.url, category: 'unverified', agency_key: null, source_url: null, checked_at: checkedAt,
        evidence_excerpt: '', matched_address: '', matched_listing_id: '', run_id: runId, actor: 'job',
        note: `No supported public website for ${listing.office_name || 'this office'}. Left unverified.`,
      });
    }
    const source = agency.search(listing.street || '', listing.suburb || '');
    let fetched;
    try {
      if (ctx.polite) await ctx.polite();
      fetched = await fetchPublic(source, ctx, agency.hosts);
    } catch (err) {
      return applyVerdict(db, {
        listing_url: listing.url, category: 'unverified', agency_key: agency.key, source_url: source, checked_at: checkedAt,
        evidence_excerpt: '', matched_address: '', matched_listing_id: '', run_id: runId, actor: 'job',
        note: `Could not read ${agency.name}: ${err.message || 'request failed'}. Left unverified.`,
      });
    }
    if (fetched.status === 404) {
      return applyVerdict(db, {
        listing_url: listing.url, category: 'unverified', agency_key: agency.key, source_url: fetched.url, checked_at: checkedAt,
        evidence_excerpt: '', matched_address: '', matched_listing_id: '', run_id: runId, actor: 'job',
        note: `${agency.name} returned 404. A missing page does not confirm a withdrawal.`,
      });
    }
    if (fetched.status !== 200) {
      return applyVerdict(db, {
        listing_url: listing.url, category: 'unverified', agency_key: agency.key, source_url: fetched.url, checked_at: checkedAt,
        evidence_excerpt: '', matched_address: '', matched_listing_id: '', run_id: runId, actor: 'job',
        note: `${agency.name} returned HTTP ${fetched.status}. Left unverified.`,
      });
    }
    const found = classifyPage(fetched.html, listing);
    return applyVerdict(db, {
      listing_url: listing.url,
      category: found.category,
      agency_key: agency.key,
      source_url: fetched.url,
      checked_at: checkedAt,
      evidence_excerpt: found.evidence_excerpt,
      matched_address: found.matched_address,
      matched_listing_id: '',
      conflict: found.conflict || null,
      note: found.note || '',
      run_id: runId,
      actor: 'job',
    });
  }

  async function run(trigger) {
    const baseline = latestFullCrawl(db);
    const started = new Date().toISOString();
    if (!baseline) {
      const info = db.prepare(`INSERT INTO oneroof_verification_runs (started_at, finished_at, status, trigger, message)
        VALUES (?, ?, 'skipped', ?, ?)`).run(started, started, trigger, 'No completed full South Auckland crawl yet.');
      return { status: 'skipped', id: Number(info.lastInsertRowid), message: 'No completed full South Auckland crawl yet.' };
    }
    if (crawlActive(db, opts.baselineRunning)) {
      const info = db.prepare(`INSERT INTO oneroof_verification_runs (started_at, finished_at, status, trigger, baseline_run_id, message)
        VALUES (?, ?, 'deferred', ?, ?, ?)`).run(started, started, trigger, baseline.id, 'The OneRoof crawl is still running.');
      return { status: 'deferred', id: Number(info.lastInsertRowid), message: 'The OneRoof crawl is still running.' };
    }
    const interrupted = db.prepare(`SELECT id FROM oneroof_verification_runs
      WHERE status='interrupted' AND baseline_run_id=? ORDER BY id DESC LIMIT 1`).get(baseline.id);
    let id;
    if (interrupted) {
      id = interrupted.id;
      db.prepare(`UPDATE oneroof_verification_runs SET status='running', trigger=?, message='Resuming' WHERE id=?`).run(trigger, id);
    } else {
      const info = db.prepare(`INSERT INTO oneroof_verification_runs (started_at, status, trigger, baseline_run_id, message)
        VALUES (?, 'running', ?, ?, 'Starting')`).run(started, trigger, baseline.id);
      id = Number(info.lastInsertRowid);
    }
    const counts = { checked: 0, confirmed_sold: 0, confirmed_withdrawn: 0, still_active: 0, unverified: 0 };
    const queue = db.prepare(`SELECT url, street, suburb, office_name FROM oneroof_listings
      WHERE disappeared_at IS NOT NULL
        AND url NOT IN (SELECT listing_url FROM oneroof_verification_events WHERE run_id=?)
      ORDER BY suburb, street`).all(id);
    db.prepare('UPDATE oneroof_verification_runs SET queued=? WHERE id=?').run(queue.length, id);
    let first = true;
    const ctx = {
      fetchImpl: opts.fetchImpl || globalThis.fetch,
      lookup: opts.lookup || defaultLookup,
      timeoutMs: opts.timeoutMs || 15000,
      polite: async () => {
        if (first) { first = false; return; }
        await sleep(delayMs);
      },
    };
    const tally = (category) => {
      counts.checked++;
      if (category === 'confirmed_sold') counts.confirmed_sold++;
      else if (category === 'confirmed_withdrawn') counts.confirmed_withdrawn++;
      else if (category === 'still_active') counts.still_active++;
      else counts.unverified++;
      db.prepare(`UPDATE oneroof_verification_runs SET checked=?, confirmed_sold=?, confirmed_withdrawn=?, still_active=?, unverified=?, message=? WHERE id=?`)
        .run(counts.checked, counts.confirmed_sold, counts.confirmed_withdrawn, counts.still_active, counts.unverified,
          `Checked ${counts.checked} of ${queue.length}`, id);
    };
    try {
      for (const listing of queue) {
        log(`[verification] ${listing.street || listing.url}`);
        const saved = await checkOne(listing, id, ctx);
        tally(saved.category);
      }
      const message = `Checked ${counts.checked} listings that have left OneRoof. ${counts.confirmed_sold} confirmed sold, ${counts.confirmed_withdrawn} confirmed withdrawn, ${counts.still_active} still active, ${counts.unverified} unverified.`;
      db.prepare(`UPDATE oneroof_verification_runs SET status='ok', finished_at=?, message=? WHERE id=?`).run(new Date().toISOString(), message, id);
      log(`[verification] ${message}`);
      return { status: 'ok', id, message, ...counts, queued: queue.length };
    } catch (err) {
      const message = err && err.message ? err.message : 'Verification failed';
      db.prepare(`UPDATE oneroof_verification_runs SET status='error', finished_at=?, message=? WHERE id=?`).run(new Date().toISOString(), message, id);
      log(`[verification] error ${message}`);
      return { status: 'error', id, message, ...counts };
    }
  }

  function start(trigger) {
    if (inflight) return { started: false, reason: 'already-running', done: inflight, status: status() };
    if (crawlActive(db, opts.baselineRunning)) {
      return { started: false, deferred: true, reason: 'crawl-active', status: status() };
    }
    if (!latestFullCrawl(db)) {
      return { started: false, noBaseline: true, reason: 'no-baseline', status: status() };
    }
    let release;
    const done = new Promise(resolve => { release = resolve; });
    inflight = done;
    run(trigger || 'manual').then(result => {
      if (inflight === done) inflight = null;
      release(result);
    }, err => {
      if (inflight === done) inflight = null;
      release({ status: 'error', message: err && err.message ? err.message : 'Verification failed' });
    });
    return { started: true, done, status: status() };
  }

  return { start, status, run };
}

module.exports = {
  CATEGORIES,
  AGENCIES,
  migrate,
  agencyForOffice,
  addressTokens,
  plainText,
  classifyPage,
  isPrivateAddress,
  assertPublicHttps,
  fetchPublic,
  applyVerdict,
  submitEvidence,
  decorate,
  reportRows,
  reportCsv,
  latestFullCrawl,
  crawlActive,
  statusOf,
  createChecker,
  labelFor,
};
