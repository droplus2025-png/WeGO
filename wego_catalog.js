/* wego_catalog.js — categories and products on top of a store adapter.
   Every method is one atomic transaction and writes an audit_log entry. */
(function (root) {
  'use strict';

  const rules = typeof require !== 'undefined' ? require('./wego_rules.js') : root.WeGo.rules;
  const schema = typeof require !== 'undefined' ? require('./wego_schema.js') : root.WeGo.schema;
  const { WeGoError, normalizeText, validatePrefix, parseSku, formatSku, nextFreeNumber, compareReturnLine } = rules;

  const PRODUCT_TX = ['products', 'categories', 'stock_movements', 'audit_log'];

  function defaultUuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function checkName(name) {
    const n = String(name == null ? '' : name).trim();
    if (!n) throw new WeGoError('INVALID_NAME', 'Product name is required');
    return n;
  }
  function checkMoney(v, field) {
    if (!Number.isInteger(v) || v < 0) throw new WeGoError('INVALID_PRICE', field + ' must be an integer number of cents >= 0', { field, value: v });
    return v;
  }
  function checkQty(v) {
    if (!Number.isInteger(v)) throw new WeGoError('INVALID_QTY', 'qty must be an integer', { value: v });
    return v;
  }

  class Catalog {
    constructor(store, opts) {
      const o = opts || {};
      this.store = store;
      this.now = o.now || (() => new Date().toISOString());
      this.uuid = o.uuid || defaultUuid;
      this.deviceId = o.deviceId || null;
    }

    /* Creates device id, schema version, default settings and the seed categories (idempotent). */
    async init() {
      const at = this.now();
      await this.store.tx(['meta', 'settings', 'categories'], 'readwrite', async (tx) => {
        let dev = await tx.get('meta', 'device_id');
        if (!dev) {
          dev = { key: 'device_id', value: this.deviceId || this.uuid() };
          await tx.put('meta', dev);
        }
        this.deviceId = dev.value;
        if (!(await tx.get('meta', 'schema_version'))) await tx.put('meta', { key: 'schema_version', value: schema.version });
        for (const [key, value] of Object.entries(schema.defaultSettings)) {
          if (!(await tx.get('settings', key))) await tx.put('settings', { key, value, updated_at: at });
        }
        if ((await tx.all('categories')).length === 0) {
          for (const c of schema.seedCategories) {
            await tx.put('categories', { ...c, active: 1, created_at: at, updated_at: at, device_id: this.deviceId, rev: 1 });
          }
        }
      });
      return this;
    }

    /* ---------- helpers (always called inside a transaction) ---------- */

    _stamp(rec) {
      rec.updated_at = this.now();
      rec.device_id = this.deviceId;
      rec.rev = (rec.rev || 0) + 1;
      return rec;
    }

    async _audit(tx, action, entity, entityId, details) {
      await tx.put('audit_log', {
        id: this.uuid(), at: this.now(), device_id: this.deviceId, user_id: null,
        action, entity, entity_id: entityId, details: details || null,
      });
    }

    async _usedNumbers(tx, categoryId, exceptId) {
      const rows = await tx.byIndex('products', 'category', categoryId);
      const used = new Set();
      for (const p of rows) if (!p.is_deleted && p.id !== exceptId) used.add(p.sku_num);
      return used;
    }

    async _categoryByPrefix(tx, prefix) {
      const cat = (await tx.all('categories')).find((c) => c.prefix === prefix && c.active === 1);
      if (!cat) throw new WeGoError('UNKNOWN_CATEGORY', 'No category uses this letter', { prefix });
      return cat;
    }

    async _requireProduct(tx, id) {
      const p = await tx.get('products', id);
      if (!p) throw new WeGoError('NOT_FOUND', 'Product not found', { id });
      return p;
    }

    /* ---------- categories ---------- */

    async listCategories() {
      const rows = await this.store.tx(['categories'], 'readonly', (tx) => tx.all('categories'));
      return rows.filter((c) => c.active === 1).sort((a, b) => a.sort - b.sort);
    }

    /* Owner only (enforced by the screens/permissions later). */
    async addCategory({ prefix, name_ar, name_fr }) {
      const p = validatePrefix(prefix);
      if (!String(name_ar || name_fr || '').trim()) throw new WeGoError('INVALID_NAME', 'Category name is required');
      return this.store.tx(['categories', 'audit_log'], 'readwrite', async (tx) => {
        const all = await tx.all('categories');
        if (all.some((c) => c.prefix === p)) throw new WeGoError('CATEGORY_EXISTS', 'This letter is already used', { prefix: p });
        const at = this.now();
        const cat = {
          id: p === '' ? 'DG' : p, prefix: p,
          name_ar: String(name_ar || '').trim(), name_fr: String(name_fr || '').trim(),
          sort: Math.max(0, ...all.map((c) => c.sort)) + 1, active: 1,
          created_at: at, updated_at: at, device_id: this.deviceId, rev: 1,
        };
        if (all.some((c) => c.id === cat.id)) cat.id = this.uuid();
        await tx.put('categories', cat);
        await this._audit(tx, 'category_added', 'category', cat.id, { prefix: p });
        return cat;
      });
    }

    /* ---------- products ---------- */

    /* Either { sku:'m4' } (honoured if free) or { category_id } (smallest free number). */
    async createProduct(input) {
      return this.store.tx(PRODUCT_TX, 'readwrite', (tx) => this._createProductIn(tx, input));
    }

    /* Same, inside a transaction opened by the caller (used by the engine). */
    async _createProductIn(tx, { sku, category_id, name, sell_cents, buy_cents = 0, qty = 0 }) {
      const cleanName = checkName(name);
      checkMoney(sell_cents, 'sell_cents');
      checkMoney(buy_cents, 'buy_cents');
      checkQty(qty);
      let cat;
      let num;
      if (sku != null) {
        const parsed = parseSku(sku);
        cat = await this._categoryByPrefix(tx, parsed.prefix);
        num = parsed.num;
        if ((await this._usedNumbers(tx, cat.id)).has(num)) throw new WeGoError('SKU_TAKEN', 'SKU already used', { sku: formatSku(cat.prefix, num) });
      } else {
        cat = (await tx.all('categories')).find((c) => c.id === category_id && c.active === 1);
        if (!cat) throw new WeGoError('UNKNOWN_CATEGORY', 'Unknown category', { category_id });
        num = nextFreeNumber(await this._usedNumbers(tx, cat.id));
      }
      const at = this.now();
      const rec = {
        id: this.uuid(), sku: formatSku(cat.prefix, num), sku_num: num, category_id: cat.id,
        name: cleanName, name_norm: normalizeText(cleanName),
        buy_cents, sell_cents, qty,
        is_deleted: 0, deleted_at: null, category_changed_at: null,
        created_at: at, updated_at: at, device_id: this.deviceId, rev: 1,
      };
      await tx.put('products', rec);
      if (qty !== 0) await this._movement(tx, rec, qty, 'initial', null);
      await this._audit(tx, 'product_created', 'product', rec.id, { sku: rec.sku });
      return rec;
    }

    /* Journal line for a quantity change ALREADY applied to `p` (p.qty is the new quantity). */
    async _movement(tx, p, delta, reason, refId) {
      const at = this.now();
      await tx.put('stock_movements', {
        id: this.uuid(), product_id: p.id, category_id: p.category_id,
        qty_delta: delta, qty_after: p.qty, reason, ref_id: refId || null, at, user_id: null,
        created_at: at, updated_at: at, device_id: this.deviceId, rev: 1,
      });
    }

    /* Name and prices only. Quantity changes belong to the stock engine (next phase). */
    async updateProduct(id, patch) {
      return this.store.tx(PRODUCT_TX, 'readwrite', async (tx) => {
        const p = await this._requireProduct(tx, id);
        const changes = {};
        if (patch.name !== undefined) {
          const n = checkName(patch.name);
          if (n !== p.name) { changes.name = [p.name, n]; p.name = n; p.name_norm = normalizeText(n); }
        }
        for (const f of ['sell_cents', 'buy_cents']) {
          if (patch[f] !== undefined) {
            checkMoney(patch[f], f);
            if (patch[f] !== p[f]) { changes[f] = [p[f], patch[f]]; p[f] = patch[f]; }
          }
        }
        if (!Object.keys(changes).length) return p;
        this._stamp(p);
        await tx.put('products', p);
        await this._audit(tx, 'product_updated', 'product', id, changes);
        return p;
      });
    }

    /* Editing the SKU: the category always follows the letter ("e3" can only be electricity). */
    async setSku(id, skuInput) {
      return this.store.tx(PRODUCT_TX, 'readwrite', async (tx) => {
        const p = await this._requireProduct(tx, id);
        if (p.is_deleted) throw new WeGoError('PRODUCT_DELETED', 'Product is deleted', { id });
        const parsed = parseSku(skuInput);
        const cat = await this._categoryByPrefix(tx, parsed.prefix);
        const sku = formatSku(cat.prefix, parsed.num);
        if (sku === p.sku) return p;
        if ((await this._usedNumbers(tx, cat.id, id)).has(parsed.num)) throw new WeGoError('SKU_TAKEN', 'SKU already used', { sku });
        const from = p.sku;
        if (cat.id !== p.category_id) p.category_changed_at = this.now();
        p.sku = sku; p.sku_num = parsed.num; p.category_id = cat.id;
        this._stamp(p);
        await tx.put('products', p);
        await this._audit(tx, 'sku_changed', 'product', id, { from, to: sku });
        return p;
      });
    }

    /* Migration to another category: takes the smallest free number there. */
    async moveCategory(id, categoryId) {
      return this.store.tx(PRODUCT_TX, 'readwrite', async (tx) => {
        const p = await this._requireProduct(tx, id);
        if (p.is_deleted) throw new WeGoError('PRODUCT_DELETED', 'Product is deleted', { id });
        if (p.category_id === categoryId) return p;
        const cat = (await tx.all('categories')).find((c) => c.id === categoryId && c.active === 1);
        if (!cat) throw new WeGoError('UNKNOWN_CATEGORY', 'Unknown category', { category_id: categoryId });
        const from = p.sku;
        const num = nextFreeNumber(await this._usedNumbers(tx, cat.id));
        p.category_id = cat.id; p.sku_num = num; p.sku = formatSku(cat.prefix, num);
        p.category_changed_at = this.now();
        this._stamp(p);
        await tx.put('products', p);
        await this._audit(tx, 'category_moved', 'product', id, { from, to: p.sku });
        return p;
      });
    }

    /* Soft delete: hidden from search, kept for old invoices and returns. The number is freed. */
    async softDelete(id) {
      return this.store.tx(PRODUCT_TX, 'readwrite', async (tx) => {
        const p = await this._requireProduct(tx, id);
        if (p.is_deleted) return p;
        p.is_deleted = 1; p.deleted_at = this.now();
        this._stamp(p);
        await tx.put('products', p);
        await this._audit(tx, 'product_deleted', 'product', id, { sku: p.sku });
        return p;
      });
    }

    /* Restores a deleted product; if its number was reused meanwhile it gets the smallest free one. */
    async restore(id) {
      return this.store.tx(PRODUCT_TX, 'readwrite', async (tx) => {
        const p = await this._requireProduct(tx, id);
        if (!p.is_deleted) return p;
        const used = await this._usedNumbers(tx, p.category_id, id);
        const from = p.sku;
        if (used.has(p.sku_num)) {
          const cat = (await tx.all('categories')).find((c) => c.id === p.category_id);
          p.sku_num = nextFreeNumber(used);
          p.sku = formatSku(cat.prefix, p.sku_num);
        }
        p.is_deleted = 0; p.deleted_at = null;
        this._stamp(p);
        await tx.put('products', p);
        await this._audit(tx, 'product_restored', 'product', id, { from, to: p.sku });
        return p;
      });
    }

    async findBySku(skuInput) {
      const parsed = parseSku(skuInput);
      const sku = formatSku(parsed.prefix, parsed.num);
      return this.store.tx(['products'], 'readonly', async (tx) => {
        const rows = await tx.byIndex('products', 'sku', sku);
        return rows.find((p) => !p.is_deleted) || null;
      });
    }

    async getProduct(id) {
      return this.store.tx(['products'], 'readonly', (tx) => tx.get('products', id));
    }

    async listByCategory(categoryId, opts) {
      const includeDeleted = !!(opts && opts.includeDeleted);
      const rows = await this.store.tx(['products'], 'readonly', (tx) => tx.byIndex('products', 'category', categoryId));
      return rows.filter((p) => includeDeleted || !p.is_deleted).sort((a, b) => a.sku_num - b.sku_num);
    }

    /* After a future synchronisation: if two active products share a SKU, the older one keeps it
       and the newer one takes the smallest free number of its category. Returns the changes made. */
    async resolveSkuConflicts() {
      return this.store.tx(PRODUCT_TX, 'readwrite', async (tx) => {
        const cats = await tx.all('categories');
        const active = (await tx.all('products')).filter((p) => !p.is_deleted);
        const groups = new Map();
        for (const p of active) {
          if (!groups.has(p.sku)) groups.set(p.sku, []);
          groups.get(p.sku).push(p);
        }
        const changes = [];
        for (const group of groups.values()) {
          if (group.length < 2) continue;
          group.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
          for (const p of group.slice(1)) {
            const cat = cats.find((c) => c.id === p.category_id);
            const used = await this._usedNumbers(tx, p.category_id, p.id);
            const from = p.sku;
            p.sku_num = nextFreeNumber(used);
            p.sku = formatSku(cat.prefix, p.sku_num);
            this._stamp(p);
            await tx.put('products', p);
            await this._audit(tx, 'sku_conflict_resolved', 'product', p.id, { from, to: p.sku });
            changes.push({ id: p.id, from, to: p.sku });
          }
        }
        return changes;
      });
    }

    /* Return rule: the returned line is compared with the stock (sku, name, list sell price, buy price).
       match    -> the return can be executed directly
       changed / deleted / missing -> the screen shows the differences and offers
                  (a) re-enter the product (suggested sku in `reinsert_sku`)
                  (b) adapt the return to one of `candidates` already in stock
       external -> product that was never in stock; the engine decides what to do. */
    async checkReturnLine(line) {
      return this.store.tx(['products', 'categories', 'settings'], 'readonly', (tx) => this._checkReturnLineIn(tx, line));
    }

    async _checkReturnLineIn(tx, line) {
      const product = line.product_id ? await tx.get('products', line.product_id) : undefined;
      const setting = await tx.get('settings', 'return_match_buy_price');
      const result = compareReturnLine(line, product, { matchBuy: !!(setting && setting.value === 1) });
      if (result.status === 'match' || result.status === 'external') return result;

      const out = { ...result, candidates: [], reinsert_sku: null };
      const parsed = parseSku(line.sku);
      const sameSku = await tx.byIndex('products', 'sku', formatSku(parsed.prefix, parsed.num));
      const sameName = await tx.byIndex('products', 'name_norm', normalizeText(line.name));
      const seen = new Set();
      for (const p of [...sameSku, ...sameName]) {
        if (!p.is_deleted && p.id !== line.product_id && !seen.has(p.id)) { seen.add(p.id); out.candidates.push(p); }
      }
      const cat = (await tx.all('categories')).find((c) => c.prefix === parsed.prefix && c.active === 1);
      if (cat) {
        const used = new Set((await tx.byIndex('products', 'category', cat.id)).filter((p) => !p.is_deleted).map((p) => p.sku_num));
        out.reinsert_sku = used.has(parsed.num) ? formatSku(cat.prefix, nextFreeNumber(used)) : formatSku(cat.prefix, parsed.num);
      }
      return out;
    }
  }

  const api = { Catalog };
  root.WeGo = root.WeGo || {};
  root.WeGo.catalog = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
