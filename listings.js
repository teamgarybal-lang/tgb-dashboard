'use strict';

// Listings on the office TV are typed in by an admin. Nothing is read from a website.
const BOARD_STATUSES = ['new', 'conditional', 'sold'];
const BOARD_METHODS = ['auction', 'negotiation', 'deadline', 'price'];
const METHOD_LABELS = {
  auction: 'Auction',
  negotiation: 'Price by Negotiation',
  deadline: 'Deadline Sale',
  price: 'Price',
};

function listedOnValue(value) {
  if (value == null || String(value).trim() === '') return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return false;
  return s;
}

// The TV shows the first name only. Full names stay in the database.
function firstName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return parts[0] || '';
}
function formatAgents(agent, agent2) {
  const a = firstName(agent);
  const b = firstName(agent2);
  if (a && b) return a + ' & ' + b;
  return a || b;
}

function cleanText(value, max) {
  const s = String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, max);
}

function readBoardInput(body) {
  const b = body || {};
  const status = String(b.status || '').trim();
  if (!BOARD_STATUSES.includes(status)) return { error: 'Choose New, Conditional or Sold' };
  const method = String(b.method || '').trim();
  if (method && !BOARD_METHODS.includes(method)) return { error: 'Method of sale is not valid' };
  const address = cleanText(b.address, 200);
  if (!address) return { error: 'Address is required' };
  const listedOn = listedOnValue(b.listed_on);
  if (listedOn === false) return { error: 'Date must be a real calendar day' };
  return {
    value: {
      status,
      name: cleanText(b.name, 140),
      address,
      suburb: cleanText(b.suburb, 80),
      agent: cleanText(b.agent, 80),
      agent2: cleanText(b.agent2, 80) || null,
      cv: cleanText(b.cv, 80),
      method,
      asking_price: cleanText(b.asking_price, 80),
      sale_price: cleanText(b.sale_price, 80),
      condition_text: cleanText(b.condition_text, 240),
      cond_price: cleanText(b.cond_price, 80),
      listed_on: listedOn,
      hidden: b.hidden ? 1 : 0,
    },
  };
}

// Website rows are removed unless an admin has edited them by hand.
function shouldDropFeedRow(row) {
  return !!(row && row.origin === 'feed' && !Number(row.admin_edited));
}

module.exports = {
  BOARD_STATUSES,
  BOARD_METHODS,
  METHOD_LABELS,
  cleanText,
  listedOnValue,
  firstName,
  formatAgents,
  readBoardInput,
  shouldDropFeedRow,
};
