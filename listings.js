'use strict';

// Public listing pages on the office website (Cloudhi / Tokyo).
// Current residential stock and recently sold pages are server-rendered HTML.
// The site does not publish council valuations, a listed date, or an under-contract list.
const LISTING_SOURCE = {
  buy: 'https://www.harcourtsmanurewa.co.nz/listings/buy?category=residential',
  sold: 'https://www.harcourtsmanurewa.co.nz/listings/sold?category=residential',
  buyPages: 8,
  soldPages: 3,
  syncMinutes: 8,
  pageRefreshMinutes: 6,
};

const BOARD_STATUSES = ['new', 'conditional', 'sold'];
const BOARD_METHODS = ['auction', 'negotiation', 'deadline', 'price'];

function decodeEntities(value) {
  let out = String(value ?? '');
  out = out.replace(/&amp;/g, '&');
  out = out.replace(/&#(\d+);/g, (_, n) => {
    const code = Number(n);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : _;
  });
  out = out.replace(/&#x([0-9a-f]+);/gi, (_, n) => {
    const code = parseInt(n, 16);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : _;
  });
  return out
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function cleanText(value, max) {
  const s = decodeEntities(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, max);
}

function parseAddress(full) {
  const text = cleanText(full, 240);
  const parts = text.split(',').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return { address: '', suburb: '' };
  const last = parts[parts.length - 1];
  if (parts.length >= 3 && /^NZ\b/i.test(last)) {
    return { address: parts.slice(0, -2).join(', '), suburb: parts[parts.length - 2] };
  }
  if (parts.length >= 2) return { address: parts.slice(0, -1).join(', '), suburb: last };
  return { address: text, suburb: '' };
}

function mapSaleMethod(priceText) {
  const t = cleanText(priceText, 160);
  if (!t) return { method: '', asking_price: '' };
  if (/auction/i.test(t)) return { method: 'auction', asking_price: '' };
  if (/deadline/i.test(t)) return { method: 'deadline', asking_price: '' };
  if (/negotiat/i.test(t)) return { method: 'negotiation', asking_price: '' };
  const money = t.match(/\$[\d,]+(?:\.\d{2})?/);
  if (money || /asking price/i.test(t)) return { method: 'price', asking_price: money ? money[0] : '' };
  return { method: '', asking_price: t };
}

function moneyIn(priceText) {
  const t = cleanText(priceText, 160);
  const money = t.match(/\$[\d,]+(?:\.\d{2})?/);
  return money ? money[0] : '';
}

function parseListingCards(html) {
  const parts = String(html || '').split('property-item card').slice(1);
  const out = [];
  for (const card of parts) {
    const href = (card.match(/href="(\/listing\/[^"]+)"/) || [])[1] || '';
    const keyMatch = href.match(/\/listing\/([a-z]\d+)/i);
    if (!keyMatch) continue;
    const category = ((card.match(/data-category="([^"]+)"/) || [])[1] || '').toLowerCase();
    if (category === 'rent') continue;
    const title = cleanText((card.match(/property-title">([\s\S]*?)<\/h6>/) || [])[1] || '', 140);
    const price = cleanText((card.match(/hi-price">([\s\S]*?)<\/span>/) || [])[1] || '', 160);
    const address = cleanText((card.match(/class="address">([\s\S]*?)<\/span>/) || [])[1] || '', 240);
    const agent = cleanText((card.match(/class="property-agent"[\s\S]*?alt="([^"]*)"/) || [])[1] || '', 80);
    const badge = cleanText((card.match(/property-badge[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '', 40).toLowerCase();
    const statusAttr = ((card.match(/data-status="([^"]+)"/) || [])[1] || '').toLowerCase();
    out.push({
      source_key: keyMatch[1].toLowerCase(),
      title,
      price,
      address,
      agent,
      badge,
      status_attr: statusAttr,
    });
  }
  return out;
}

function classifyCard(card, fallbackStatus) {
  const blob = `${card.badge || ''} ${card.price || ''} ${card.status_attr || ''}`.toLowerCase();
  if (/under\s*offer|under\s*contract|conditional/.test(blob)) return 'conditional';
  if (card.status_attr === 'sold' || card.badge === 'sold' || fallbackStatus === 'sold') return 'sold';
  return 'new';
}

function cardToFeed(card, fallbackStatus) {
  if (!card || !card.source_key) return null;
  const status = classifyCard(card, fallbackStatus);
  const place = parseAddress(card.address);
  const sale = mapSaleMethod(card.price);
  const base = {
    source_key: card.source_key,
    name: cleanText(card.title, 140),
    address: place.address,
    suburb: cleanText(place.suburb, 80),
    agent: cleanText(card.agent, 80),
    source_rank: Number.isInteger(card.rank) ? card.rank : 0,
  };
  if (!base.address) return null;
  if (status === 'sold') {
    return { ...base, status: 'sold', method: '', asking_price: '', sale_price: moneyIn(card.price) };
  }
  if (status === 'conditional') {
    return { ...base, status: 'conditional', method: sale.method, asking_price: sale.asking_price, sale_price: '' };
  }
  return { ...base, status: 'new', method: sale.method, asking_price: sale.asking_price, sale_price: '' };
}

function buildFeedItems(buyCards, soldCards) {
  const out = [];
  const seen = new Set();
  const sold = (soldCards || []).map((card, i) => cardToFeed({ ...card, rank: card.rank ?? i }, 'sold'));
  const buy = (buyCards || []).map((card, i) => cardToFeed({ ...card, rank: card.rank ?? i }, 'new'));
  for (const item of [...sold, ...buy]) {
    if (!item || seen.has(item.source_key)) continue;
    seen.add(item.source_key);
    out.push(item);
  }
  return out;
}

function listingPageOk(html) {
  const text = String(html || '');
  if (/403 ERROR|Request blocked|The request could not be satisfied/i.test(text)) return false;
  return text.includes('property-item') || text.includes('property-search-result-found');
}

function nextListingPage(html, currentUrl) {
  let current;
  try { current = new URL(currentUrl); } catch { return null; }
  const curPage = Number(current.searchParams.get('page') || '1');
  const want = curPage + 1;
  const hrefs = [...String(html || '').matchAll(/href="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
  for (const href of hrefs) {
    try {
      const url = new URL(href, current.origin);
      if (url.pathname !== current.pathname) continue;
      if (Number(url.searchParams.get('page')) === want) return url.toString();
    } catch { /* ignore bad hrefs */ }
  }
  return null;
}

async function collectPages(firstUrl, maxPages, fetchText) {
  const cards = [];
  const seenUrl = new Set();
  let url = firstUrl;
  for (let i = 0; i < maxPages && url; i++) {
    if (seenUrl.has(url)) break;
    seenUrl.add(url);
    const html = await fetchText(url);
    if (!listingPageOk(html)) {
      const err = new Error('Listing page could not be read');
      err.causeUrl = url;
      throw err;
    }
    const pageCards = parseListingCards(html);
    if (!pageCards.length) break;
    for (const card of pageCards) cards.push({ ...card, rank: cards.length });
    url = nextListingPage(html, url);
  }
  return cards;
}

// Feed rows an admin has edited or hidden stay as saved.
// Rows that left the latest snapshot are retired only when nobody has edited them.
function planFeedSync(existingRows, feedItems) {
  const byKey = new Map();
  for (const row of existingRows || []) {
    if (row && row.source_key) byKey.set(row.source_key, row);
  }
  const seen = new Set();
  const upserts = [];
  for (const item of feedItems || []) {
    if (!item || !item.source_key || seen.has(item.source_key)) continue;
    seen.add(item.source_key);
    const prev = byKey.get(item.source_key);
    if (prev && Number(prev.admin_edited)) continue;
    upserts.push({ ...item, id: prev ? prev.id : null });
  }
  const retireIds = [];
  for (const row of existingRows || []) {
    if (!row || row.origin !== 'feed' || !row.source_key) continue;
    if (Number(row.admin_edited)) continue;
    if (!seen.has(row.source_key)) retireIds.push(row.id);
  }
  return { upserts, retireIds };
}

function readBoardInput(body) {
  const b = body || {};
  const status = String(b.status || '').trim();
  if (!BOARD_STATUSES.includes(status)) return { error: 'Choose New, Conditional or Sold' };
  const method = String(b.method || '').trim();
  if (method && !BOARD_METHODS.includes(method)) return { error: 'Method of sale is not valid' };
  const address = cleanText(b.address, 200);
  if (!address) return { error: 'Address is required' };
  return {
    value: {
      status,
      name: cleanText(b.name, 140),
      address,
      suburb: cleanText(b.suburb, 80),
      agent: cleanText(b.agent, 80),
      cv: cleanText(b.cv, 80),
      method,
      asking_price: cleanText(b.asking_price, 80),
      sale_price: cleanText(b.sale_price, 80),
      condition_text: cleanText(b.condition_text, 240),
      hidden: b.hidden ? 1 : 0,
    },
  };
}

module.exports = {
  LISTING_SOURCE,
  BOARD_STATUSES,
  BOARD_METHODS,
  cleanText,
  parseAddress,
  mapSaleMethod,
  parseListingCards,
  classifyCard,
  cardToFeed,
  buildFeedItems,
  listingPageOk,
  nextListingPage,
  collectPages,
  planFeedSync,
  readBoardInput,
};
