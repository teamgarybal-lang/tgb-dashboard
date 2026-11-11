'use strict';

// Printed appraisal letters. A QR opens /q/<code>, we count the scan, then
// the phone offers a text to the agent. The scan does not identify a person.

const crypto = require('crypto');
const QRCode = require('qrcode');

const PUBLIC_ORIGIN = (process.env.PUBLIC_BASE_URL || 'https://tgb-dashboard.onrender.com').replace(/\/$/, '');
const OFFICE_PHONE = '+64226393317';
const SEED_CODE = 'k7m3qp';
const SEED_BODY = 'Hi Jovana, I\'d like a free appraisal of my property.\nName: \nProperty address: \nEmail: ';
// Same text layout as SEED_BODY: one greeting line, then Name, Property address, and Email, each with a trailing space.
const LETTER_SEEDS = [
  {
    code: 'i5s8hq',
    label: 'Gary & Isaiah appraisal letter',
    campaign: 'appraisal-letters',
    suburb: '',
    agent_name: 'Isaiah',
    agent_mobile: '+64211633662',
    sms_body: 'Hi Isaiah, I\'d like a free appraisal of my property.\nName: \nProperty address: \nEmail: ',
  },
  {
    code: 'a2m6nx',
    label: 'Aman appraisal letter',
    campaign: 'appraisal-letters',
    suburb: '',
    agent_name: 'Aman',
    agent_mobile: '+64211271154',
    sms_body: 'Hi Aman, I\'d like a free appraisal of my property.\nName: \nProperty address: \nEmail: ',
  },
];
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function migrate(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS qr_links(
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  campaign TEXT NOT NULL DEFAULT '',
  suburb TEXT NOT NULL DEFAULT '',
  agent_name TEXT NOT NULL,
  agent_mobile TEXT NOT NULL,
  sms_body TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS qr_scans(
  id INTEGER PRIMARY KEY,
  link_id INTEGER NOT NULL,
  scanned_at TEXT NOT NULL,
  device_type TEXT NOT NULL,
  visitor_hash TEXT NOT NULL DEFAULT '',
  bot INTEGER NOT NULL DEFAULT 0,
  counted INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS qr_scans_link_time ON qr_scans(link_id, scanned_at);
`);
  const salt = db.prepare("SELECT value FROM settings WHERE key='qr_visitor_salt'").get();
  if (!salt) {
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('qr_visitor_salt', crypto.randomBytes(32).toString('hex'));
  }
  const existing = db.prepare('SELECT 1 AS n FROM qr_links WHERE code=?').get(SEED_CODE);
  if (!existing) {
    db.prepare(`INSERT INTO qr_links(code,label,campaign,suburb,agent_name,agent_mobile,sms_body,active,created_at)
      VALUES(?,?,?,?,?,?,?,1,?)`).run(
      SEED_CODE,
      'Gary & Jovana appraisal letter',
      'appraisal-letters',
      '',
      'Jovana Giudici',
      '+64226393317',
      SEED_BODY,
      new Date().toISOString()
    );
  }
  // Printed codes already on letters. Insert only when that code is missing.
  const hasCode = db.prepare('SELECT 1 AS n FROM qr_links WHERE code=?');
  const insertLetter = db.prepare(`INSERT INTO qr_links(code,label,campaign,suburb,agent_name,agent_mobile,sms_body,active,created_at)
      VALUES(?,?,?,?,?,?,?,1,?)`);
  for (const seed of LETTER_SEEDS) {
    if (hasCode.get(seed.code)) continue;
    insertLetter.run(
      seed.code,
      seed.label,
      seed.campaign,
      seed.suburb,
      seed.agent_name,
      seed.agent_mobile,
      seed.sms_body,
      new Date().toISOString()
    );
  }
}

function aucklandDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function trackingUrl(code) {
  return `${PUBLIC_ORIGIN}/q/${code}`;
}

function newCode() {
  let out = '';
  const bytes = crypto.randomBytes(6);
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function validMobile(value) {
  return /^\+[1-9]\d{7,14}$/.test(String(value || '').replace(/\s/g, ''));
}

function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

function displayPhone(e164) {
  const compact = String(e164 || '').replace(/\s/g, '');
  if (/^\+64\d{8,10}$/.test(compact)) {
    const local = '0' + compact.slice(3);
    if (local.length === 9 || local.length === 10) {
      return `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`.trim();
    }
  }
  return compact;
}

function firstName(name) {
  const part = String(name || '').trim().split(/\s+/).filter(Boolean)[0];
  return part || 'us';
}

function deviceType(userAgent) {
  const ua = String(userAgent || '');
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

function isBot(userAgent) {
  const ua = String(userAgent || '').trim();
  if (!ua) return true;
  return /bot\b|spider|crawler|slurp|facebookexternalhit|facebot|twitterbot|slackbot|whatsapp|telegrambot|linkedinbot|discordbot|embedly|pinterest|skypeuripreview|applebot|googlebot|bingbot|duckduckbot|baiduspider|yandex|semrush|ahrefs|petalbot|ia_archiver|lighthouse|pagespeed|preview/i.test(ua);
}

function visitorHash(db, ip, userAgent) {
  const salt = db.prepare("SELECT value FROM settings WHERE key='qr_visitor_salt'").get().value;
  return crypto.createHash('sha256').update(`${salt}\n${ip || ''}\n${userAgent || ''}`).digest('hex');
}

function smsUri(mobile, body, kind) {
  const phone = String(mobile || '').replace(/\s/g, '');
  const encoded = encodeURIComponent(body || '');
  if (kind === 'android') return `sms:${phone}?body=${encoded}`;
  return `sms:${phone}&body=${encoded}`;
}

function recordScan(db, link, req) {
  const ua = String(req.get ? req.get('user-agent') : (req.headers && (req.headers['user-agent'] || req.headers['User-Agent'])) || '');
  const bot = isBot(ua);
  const ip = req.ip || '';
  db.prepare(`INSERT INTO qr_scans(link_id, scanned_at, device_type, visitor_hash, bot, counted)
    VALUES(?,?,?,?,?,?)`).run(
    link.id,
    new Date().toISOString(),
    deviceType(ua),
    visitorHash(db, ip, ua),
    bot ? 1 : 0,
    bot ? 0 : 1
  );
}

function linkStats(db, linkId) {
  const row = db.prepare(`SELECT
      SUM(CASE WHEN counted=1 THEN 1 ELSE 0 END) AS scans,
      COUNT(DISTINCT CASE WHEN counted=1 AND visitor_hash<>'' THEN visitor_hash END) AS unique_scans,
      MAX(CASE WHEN counted=1 THEN scanned_at END) AS last_scan
    FROM qr_scans WHERE link_id=?`).get(linkId);
  const days = db.prepare(`SELECT scanned_at FROM qr_scans WHERE link_id=? AND counted=1 ORDER BY scanned_at`).all(linkId);
  const byDay = new Map();
  for (const scan of days) {
    const day = aucklandDate(new Date(scan.scanned_at));
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }
  return {
    scans: row.scans || 0,
    unique_scans: row.unique_scans || 0,
    last_scan: row.last_scan || null,
    days: [...byDay.entries()].map(([day, scans]) => ({ day, scans })),
  };
}

function listLinks(db) {
  return db.prepare('SELECT * FROM qr_links ORDER BY id').all().map(row => {
    const stats = linkStats(db, row.id);
    return {
      id: row.id,
      code: row.code,
      label: row.label,
      campaign: row.campaign,
      suburb: row.suburb,
      agent_name: row.agent_name,
      agent_mobile: row.agent_mobile,
      sms_body: row.sms_body,
      active: !!row.active,
      created_at: row.created_at,
      url: trackingUrl(row.code),
      ...stats,
    };
  });
}

function createLink(db, input) {
  const label = cleanText(input.label, 120);
  const agentName = cleanText(input.agent_name, 80);
  const mobile = String(input.agent_mobile || '').replace(/\s/g, '');
  const smsBody = cleanText(input.sms_body, 500);
  if (!label) return { error: 'Label is required' };
  if (!agentName) return { error: 'Agent name is required' };
  if (!validMobile(mobile)) return { error: 'Mobile must be in international form, like +64226393317' };
  if (!smsBody) return { error: 'Text message is required' };
  let code = '';
  for (let i = 0; i < 8; i++) {
    const candidate = newCode();
    if (!db.prepare('SELECT 1 AS n FROM qr_links WHERE code=?').get(candidate)) { code = candidate; break; }
  }
  if (!code) return { error: 'Could not make a code. Try again.' };
  const info = db.prepare(`INSERT INTO qr_links(code,label,campaign,suburb,agent_name,agent_mobile,sms_body,active,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(
    code,
    label,
    cleanText(input.campaign, 80),
    cleanText(input.suburb, 80),
    agentName,
    mobile,
    smsBody,
    input.active === false || input.active === 0 ? 0 : 1,
    new Date().toISOString()
  );
  return { ok: true, link: listLinks(db).find(link => link.id === Number(info.lastInsertRowid)) };
}

function updateLink(db, code, input) {
  const row = db.prepare('SELECT * FROM qr_links WHERE code=?').get(String(code || '').toLowerCase());
  if (!row) return { error: 'Link not found' };
  const label = input.label === undefined ? row.label : cleanText(input.label, 120);
  const agentName = input.agent_name === undefined ? row.agent_name : cleanText(input.agent_name, 80);
  const mobile = input.agent_mobile === undefined ? row.agent_mobile : String(input.agent_mobile).replace(/\s/g, '');
  const smsBody = input.sms_body === undefined ? row.sms_body : cleanText(input.sms_body, 500);
  if (!label || !agentName || !smsBody) return { error: 'Label, agent name, and text message are required' };
  if (!validMobile(mobile)) return { error: 'Mobile must be in international form, like +64226393317' };
  const active = input.active === undefined ? row.active : (input.active === false || input.active === 0 ? 0 : 1);
  db.prepare(`UPDATE qr_links SET label=?, campaign=?, suburb=?, agent_name=?, agent_mobile=?, sms_body=?, active=? WHERE id=?`).run(
    label,
    input.campaign === undefined ? row.campaign : cleanText(input.campaign, 80),
    input.suburb === undefined ? row.suburb : cleanText(input.suburb, 80),
    agentName,
    mobile,
    smsBody,
    active,
    row.id
  );
  return { ok: true, link: listLinks(db).find(link => link.id === row.id) };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function inactivePage() {
  const phone = displayPhone(OFFICE_PHONE);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Harcourts TGB Group</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<style>
body{margin:0;min-height:100vh;background:#0B1F3A;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center}
main{max-width:420px;padding:32px}h1{font-weight:800;font-size:28px;margin:0 0 12px}p{font-size:18px;line-height:1.4}
a{color:#8FD9F8}
</style></head><body><main>
<h1>Harcourts TGB Group</h1>
<p>This letter link is not available.</p>
<p>Call the office on <a href="tel:${escapeHtml(OFFICE_PHONE)}">${escapeHtml(phone)}</a>.</p>
</main></body></html>`;
}

function scanPage(link, userAgent) {
  const kind = deviceType(userAgent);
  const primary = kind === 'android' ? 'android' : 'ios';
  const secondary = primary === 'android' ? 'ios' : 'android';
  const primaryUri = smsUri(link.agent_mobile, link.sms_body, primary);
  const secondaryUri = smsUri(link.agent_mobile, link.sms_body, secondary);
  const name = firstName(link.agent_name);
  const phone = displayPhone(link.agent_mobile);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Text ${escapeHtml(name)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<style>
body{margin:0;min-height:100vh;background:#0B1F3A;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:440px;margin:0 auto;padding:32px 20px}h1{font-size:32px;margin:0 0 8px}
p{font-size:17px;line-height:1.45;color:#D6E4F0}
a.btn{display:block;margin:22px 0 12px;background:#00ADEF;color:#fff;text-decoration:none;font-weight:800;font-size:22px;text-align:center;padding:16px;border-radius:14px}
a.alt{color:#8FD9F8}
</style></head><body><main>
<p>Harcourts TGB Group</p>
<h1>Text ${escapeHtml(name)}</h1>
<p>Your text opens next. This scan is counted. We do not know who you are unless you send the text.</p>
<a class="btn" id="sms" href="${escapeHtml(primaryUri)}">Text ${escapeHtml(name)}</a>
<p>Or text <a class="alt" href="tel:${escapeHtml(link.agent_mobile)}">${escapeHtml(phone)}</a></p>
<p><a class="alt" id="other" href="${escapeHtml(secondaryUri)}">Open the text a different way</a></p>
</main>
<script>setTimeout(function(){var link=document.getElementById('sms');if(link)location.href=link.href;},400);</script>
</body></html>`;
}

async function qrPng(code) {
  return QRCode.toBuffer(trackingUrl(code), {
    type: 'png',
    errorCorrectionLevel: 'H',
    margin: 4,
    width: 1024,
  });
}

async function qrSvg(code) {
  return QRCode.toString(trackingUrl(code), {
    type: 'svg',
    errorCorrectionLevel: 'H',
    margin: 4,
  });
}

function scanRows(db) {
  return db.prepare(`SELECT s.scanned_at, l.code, l.label, l.campaign, l.suburb, s.device_type, s.bot, s.counted, s.visitor_hash
    FROM qr_scans s JOIN qr_links l ON l.id=s.link_id ORDER BY s.id DESC`).all();
}

function scansCsv(rows) {
  const cols = ['scanned_at', 'code', 'label', 'campaign', 'suburb', 'device_type', 'bot', 'counted', 'visitor_hash'];
  const cell = value => {
    let text = value == null ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };
  return [cols.join(','), ...rows.map(row => cols.map(col => cell(row[col])).join(','))].join('\n') + '\n';
}

module.exports = {
  PUBLIC_ORIGIN,
  OFFICE_PHONE,
  SEED_CODE,
  SEED_BODY,
  LETTER_SEEDS,
  migrate,
  trackingUrl,
  validMobile,
  deviceType,
  isBot,
  smsUri,
  visitorHash,
  recordScan,
  listLinks,
  createLink,
  updateLink,
  inactivePage,
  scanPage,
  qrPng,
  qrSvg,
  scanRows,
  scansCsv,
  displayPhone,
};
