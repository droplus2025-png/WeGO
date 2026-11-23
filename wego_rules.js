/* wego_rules.js — pure functions, no storage, no DOM.
   Works in the browser (global WeGo.rules) and in Node (module.exports). */
(function (root) {
  'use strict';

  class WeGoError extends Error {
    constructor(code, message, details) {
      super(message || code);
      this.name = 'WeGoError';
      this.code = code;
      this.details = details || null;
    }
  }

  function toLatinDigits(s) {
    return String(s)
      .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  }

  /* Search/compare form of a text: no accents, no Arabic diacritics or tatweel,
     alef and ya unified, Latin digits, lower case, single spaces. */
  function normalizeText(s) {
    return toLatinDigits(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f\u064b-\u065f\u0670\u0640]/g, '')
      .replace(/[\u0623\u0625\u0622]/g, '\u0627')
      .replace(/\u0649/g, '\u064a')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* 0612345678 = +212612345678 = 00212612345678  ->  212612345678 */
  function normalizePhone(s) {
    const d = toLatinDigits(s == null ? '' : s).replace(/\D/g, '');
    if (d.startsWith('00212')) return d.slice(2);
    if (d.startsWith('212')) return d;
    if (d.startsWith('0') && d.length === 10) return '212' + d.slice(1);
    return d;
  }

  /* ---------- SKU ---------- */

  function validatePrefix(prefix) {
    const p = String(prefix == null ? '' : prefix).trim().toUpperCase();
    if (!/^[A-Z]{0,3}$/.test(p)) {
      throw new WeGoError('INVALID_PREFIX', 'Prefix must be 0 to 3 Latin letters', { prefix });
    }
    return p;
  }

  /* "m4" -> {prefix:'M', num:4} ; "5" -> {prefix:'', num:5} ; "EM12" -> {prefix:'EM', num:12} */
  function parseSku(input) {
    const raw = toLatinDigits(input == null ? '' : input).replace(/\s+/g, '');
    const m = /^([a-z]{0,3})(\d{1,6})$/i.exec(raw);
    const num = m ? parseInt(m[2], 10) : 0;
    if (!m || num < 1) throw new WeGoError('INVALID_SKU', 'Invalid SKU', { input });
    return { prefix: m[1].toUpperCase(), num };
  }

  function formatSku(prefix, num) {
    return String(prefix || '').toUpperCase() + String(num);
  }

  /* Smallest positive integer not present in `used`. */
  function nextFreeNumber(used) {
    const set = used instanceof Set ? used : new Set(used);
    let n = 1;
    while (set.has(n)) n += 1;
    return n;
  }

  /* ---------- Returns ---------- */

  /* Compares the product as it was when sold (snapshot kept on the invoice line)
     with the product as it is now in stock.
     snap    : { product_id, is_external, sku, name, list_price_cents, unit_cost_cents }
               list_price_cents = catalogue sell price at sale time (NOT the negotiated price)
     product : current product record, or undefined if it does not exist
     opts    : { matchBuy: false } ignores the buy price (it moves with every purchase under weighted-average cost)
     returns : { status: 'match' | 'changed' | 'deleted' | 'missing' | 'external', diffs: [{field, was, now}] } */
  function compareReturnLine(snap, product, opts) {
    const matchBuy = !opts || opts.matchBuy !== false;
    if (!snap || snap.is_external || !snap.product_id) return { status: 'external', diffs: [] };
    if (!product) return { status: 'missing', diffs: [] };

    const diffs = [];
    const was = formatSku(parseSku(snap.sku).prefix, parseSku(snap.sku).num);
    if (was !== String(product.sku).toUpperCase()) diffs.push({ field: 'sku', was, now: product.sku });
    if (normalizeText(snap.name) !== normalizeText(product.name)) {
      diffs.push({ field: 'name', was: snap.name, now: product.name });
    }
    if (snap.list_price_cents !== product.sell_cents) {
      diffs.push({ field: 'sell_cents', was: snap.list_price_cents, now: product.sell_cents });
    }
    if (matchBuy && snap.unit_cost_cents !== product.buy_cents) {
      diffs.push({ field: 'buy_cents', was: snap.unit_cost_cents, now: product.buy_cents });
    }
    if (product.is_deleted) return { status: 'deleted', diffs };
    return { status: diffs.length ? 'changed' : 'match', diffs };
  }

  const rules = {
    WeGoError, toLatinDigits, normalizeText, normalizePhone,
    validatePrefix, parseSku, formatSku, nextFreeNumber, compareReturnLine,
  };

  root.WeGo = root.WeGo || {};
  root.WeGo.rules = rules;
  if (typeof module !== 'undefined' && module.exports) module.exports = rules;
})(typeof globalThis !== 'undefined' ? globalThis : this);
