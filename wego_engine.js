/* wego_engine.js — the atomic engine.
   Every public method is ONE transaction: it fully succeeds or writes nothing.
   Money = integer cents. Quantities = integers in units of 1/QTY_SCALE (see wego_schema.js).
   Conventions:
   - sale / quick_sale / purchase invoices: paid_cents + due_cents = total_cents
   - return invoices: total_cents = amount refunded (positive); profit_cents is NEGATIVE for customer returns
   - cash_entries.amount_cents is signed (+ into the till, - out of it) */
(function (root) {
  'use strict';

  const rules = typeof require !== 'undefined' ? require('./wego_rules.js') : root.WeGo.rules;
  const schema = typeof require !== 'undefined' ? require('./wego_schema.js') : root.WeGo.schema;
  const { WeGoError, normalizeText, normalizePhone } = rules;

  const SCALE = schema.qtyScale;
  const ENGINE_TX = [
    'settings', 'products', 'categories', 'customers', 'suppliers', 'invoices', 'invoice_lines',
    'payments', 'cash_entries', 'cash_counts', 'expenses', 'stock_movements',
    'stock_counts', 'stock_count_lines', 'audit_log',
  ];
  const SALE_TYPES = ['sale', 'quick_sale'];

  const lineAmount = (qty, unit) => Math.round((qty * unit) / SCALE);
  const sum = (rows, f) => rows.reduce((s, r) => s + f(r), 0);
  const byAtThenNumber = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.number < b.number ? -1 : a.number > b.number ? 1 : 0);

  function int(v, field, min) {
    if (!Number.isInteger(v) || v < min) throw new WeGoError('INVALID_NUMBER', field + ' must be an integer >= ' + min, { field, value: v });
    return v;
  }

  function localDay(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function detailState(lines) {
    const generic = lines.filter((l) => l.is_generic).length;
    return {
      has_detail: generic === 0 ? 1 : 0,
      profit_mode: generic === 0 ? 'real' : generic === lines.length ? 'estimated' : 'mixed',
    };
  }

  class Engine {
    constructor(store, catalog, opts) {
      const o = opts || {};
      this.store = store;
      this.cat = catalog;
      this.dayOf = o.dayOf || localDay;
    }

    /* ---------- small helpers ---------- */

    now() { return this.cat.now(); }

    _when() {
      const at = this.now();
      return { at, day: this.dayOf(at) };
    }

    _rec(fields) {
      const at = this.now();
      return { id: this.cat.uuid(), created_at: at, updated_at: at, device_id: this.cat.deviceId, rev: 1, ...fields };
    }

    _stamp(rec) { return this.cat._stamp(rec); }

    async _settings(tx) {
      const out = {};
      for (const r of await tx.all('settings')) out[r.key] = r.value;
      return out;
    }

    async _existing(tx, clientRef) {
      if (!clientRef) return null;
      const found = (await tx.byIndex('invoices', 'client_ref', clientRef))[0];
      if (!found) return null;
      return { invoice: found, lines: await tx.byIndex('invoice_lines', 'invoice', found.id), duplicate: true };
    }

    async _makeInvoice(tx, when, fields) {
      const same = await tx.byIndex('invoices', 'day', when.day);
      const seq = same.reduce((m, i) => Math.max(m, i.seq), 0) + 1;
      const number = when.day[3] + when.day.slice(5, 7) + when.day.slice(8, 10) + String(seq).padStart(3, '0');
      const inv = this._rec({
        number, seq, at: when.at, day: when.day,
        party_type: null, party_id: null, party_name: '', party_phone: '',
        total_cents: 0, paid_cents: 0, due_cents: 0, cost_cents: 0, profit_cents: 0,
        profit_mode: 'real', has_detail: 1, original_invoice_id: null, client_ref: null,
        status: 'active', note: '', user_id: null,
        ...fields,
      });
      await tx.put('invoices', inv);
      return inv;
    }

    async _cash(tx, when, kind, amount, refId, note) {
      if (!amount) return;
      await tx.put('cash_entries', this._rec({
        at: when.at, day: when.day, kind, amount_cents: amount, ref_id: refId || null, note: note || '', user_id: null,
      }));
    }

    /* Finds or creates a customer/supplier. Name AND phone are mandatory when `required`. */
    async _party(tx, type, info, required) {
      const store = type === 'customer' ? 'customers' : 'suppliers';
      const name = String((info && info.name) || '').trim();
      const rawPhone = String((info && info.phone) || '').trim();
      if (required && (!name || !rawPhone)) throw new WeGoError('PARTY_REQUIRED', 'Name and phone are required', { type });
      if (!name && !rawPhone) return null;
      let phoneNorm = '';
      if (rawPhone) {
        phoneNorm = normalizePhone(rawPhone);
        if (phoneNorm.length < 9 || phoneNorm.length > 15) throw new WeGoError('INVALID_PHONE', 'Invalid phone number', { phone: rawPhone });
      }
      let rec = null;
      if (phoneNorm) rec = (await tx.byIndex(store, 'phone', phoneNorm)).find((r) => !r.is_deleted) || null;
      if (!rec && name) {
        rec = (await tx.byIndex(store, 'name_norm', normalizeText(name)))
          .find((r) => !r.is_deleted && (!phoneNorm || !r.phone_norm)) || null;
      }
      if (rec) {
        let changed = false;
        if (!rec.phone_norm && phoneNorm) { rec.phone = rawPhone; rec.phone_norm = phoneNorm; changed = true; }
        if (!rec.name && name) { rec.name = name; rec.name_norm = normalizeText(name); changed = true; }
        if (changed) { this._stamp(rec); await tx.put(store, rec); }
        return rec;
      }
      rec = this._rec({ name, name_norm: normalizeText(name), phone: rawPhone, phone_norm: phoneNorm, note: '', is_deleted: 0 });
      await tx.put(store, rec);
      return rec;
    }

    async _stockOut(tx, productId, qty, reason, refId, allowNegative) {
      const p = await tx.get('products', productId);
      const next = p.qty - qty;
      if (next < 0 && !allowNegative) throw new WeGoError('INSUFFICIENT_STOCK', 'Not enough stock', { sku: p.sku, qty: p.qty });
      p.qty = next;
      this._stamp(p);
      await tx.put('products', p);
      await this.cat._movement(tx, p, -qty, reason, refId);
      return p;
    }

    async _stockIn(tx, productId, qty, reason, refId) {
      const p = await tx.get('products', productId);
      p.qty += qty;
      this._stamp(p);
      await tx.put('products', p);
      await this.cat._movement(tx, p, qty, reason, refId);
      return p;
    }

    /* Applies `amount` to the party's open invoices, oldest first (the `preferInvoiceId` first).
       Returns the amount actually applied. */
    async _applyToDebts(tx, when, partyType, partyId, amount, preferInvoiceId, sourceInvoiceId, direction) {
      const debtTypes = partyType === 'customer' ? SALE_TYPES : ['purchase'];
      const open = (await tx.byIndex('invoices', 'party', [partyType, partyId]))
        .filter((i) => debtTypes.includes(i.type) && i.due_cents > 0)
        .sort((a, b) => {
          if (a.id === preferInvoiceId) return -1;
          if (b.id === preferInvoiceId) return 1;
          return byAtThenNumber(a, b);
        });
      let left = amount;
      for (const inv of open) {
        if (left <= 0) break;
        const take = Math.min(inv.due_cents, left);
        inv.due_cents -= take;
        inv.paid_cents += take;
        this._stamp(inv);
        await tx.put('invoices', inv);
        await tx.put('payments', this._rec({
          party_type: partyType, party_id: partyId, invoice_id: inv.id, source_invoice_id: sourceInvoiceId || null,
          direction, amount_cents: take, at: when.at, day: when.day, note: '',
        }));
        left -= take;
      }
      return amount - left;
    }

    /* ---------- sales ---------- */

    async _saleLines(tx, rawLines, allowGeneric, pct) {
      if (!Array.isArray(rawLines) || rawLines.length === 0) throw new WeGoError('EMPTY_CART', 'No lines');
      const lines = [];
      for (const [i, l] of rawLines.entries()) {
        const qty = int(l.qty, 'qty', 1);
        const price = int(l.unit_price_cents, 'unit_price_cents', 0);
        const base = {
          line_no: i + 1, qty, unit_price_cents: price, line_total_cents: lineAmount(qty, price),
          returned_qty: 0, is_external: 0, is_generic: 0, original_line_id: null,
        };
        if (l.product_id) {
          const p = await tx.get('products', l.product_id);
          if (!p || p.is_deleted) throw new WeGoError('PRODUCT_UNAVAILABLE', 'Product not available', { product_id: l.product_id });
          lines.push({
            ...base, product_id: p.id, sku: p.sku, name: p.name, category_id: p.category_id,
            list_price_cents: p.sell_cents, unit_cost_cents: p.buy_cents,
          });
        } else if (l.external) {
          const name = String(l.external.name || '').trim();
          if (!name) throw new WeGoError('INVALID_NAME', 'External product name is required');
          lines.push({
            ...base, product_id: null, sku: '', name, category_id: null, is_external: 1,
            list_price_cents: price, unit_cost_cents: int(l.external.buy_cents, 'buy_cents', 0),
          });
        } else if (allowGeneric) {
          lines.push({
            ...base, product_id: null, sku: '', name: String(l.name || '').trim() || 'produit ' + (i + 1),
            category_id: null, is_generic: 1, list_price_cents: price,
            unit_cost_cents: Math.round((price * (100 - pct)) / 100),
          });
        } else {
          throw new WeGoError('INVALID_LINE', 'A line needs a product or an external product', { line_no: i + 1 });
        }
      }
      return lines;
    }

    _lossLines(lines) {
      return lines.filter((l) => !l.is_generic && l.unit_price_cents < l.unit_cost_cents).map((l) => l.line_no);
    }

    /* input: { lines:[{product_id|external:{name,buy_cents}, qty, unit_price_cents}], paid_cents?,
                customer?:{name,phone}, allow_loss?, client_ref?, note? } */
    sale(input) { return this._sell(input, 'sale'); }

    /* Same as sale, plus: lines may be generic ({qty, unit_price_cents, name?}) and the profit of those
       lines is estimated with the flat percentage from the settings.
       Shortcut: { total_cents } = one generic line. Details can be added later (detailQuickLine). */
    quickSale(input) { return this._sell(input, 'quick_sale'); }

    async _sell(input, type) {
      const when = this._when();
      return this.store.tx(ENGINE_TX, 'readwrite', async (tx) => {
        const prior = await this._existing(tx, input.client_ref);
        if (prior) return prior;
        const st = await this._settings(tx);

        let raw = input.lines;
        if ((!raw || raw.length === 0) && type === 'quick_sale' && input.total_cents !== undefined) {
          raw = [{ qty: SCALE, unit_price_cents: input.total_cents }];   // one unit
        }
        const lines = await this._saleLines(tx, raw, type === 'quick_sale', st.quick_sale_profit_pct);
        const total = sum(lines, (l) => l.line_total_cents);
        if (total <= 0) throw new WeGoError('INVALID_TOTAL', 'Total must be greater than zero');
        const paid = input.paid_cents === undefined ? total : int(input.paid_cents, 'paid_cents', 0);
        if (paid > total) throw new WeGoError('OVERPAID', 'Paid amount exceeds the total', { total, paid });
        const due = total - paid;

        const loss = this._lossLines(lines);
        if (loss.length && !input.allow_loss) throw new WeGoError('LOSS_NEEDS_CONFIRMATION', 'Sale below cost', { line_nos: loss });

        const customer = await this._party(tx, 'customer', input.customer, due > 0 || !!input.require_party);
        const cost = sum(lines, (l) => lineAmount(l.qty, l.unit_cost_cents));
        const invoice = await this._makeInvoice(tx, when, {
          type,
          party_type: customer ? 'customer' : null, party_id: customer ? customer.id : null,
          party_name: customer ? customer.name : '', party_phone: customer ? customer.phone : '',
          total_cents: total, paid_cents: paid, due_cents: due, cost_cents: cost, profit_cents: total - cost,
          ...detailState(lines), client_ref: input.client_ref || null, note: input.note || '',
        });

        const rows = [];
        let externalCost = 0;
        for (const l of lines) {
          const row = this._rec({ ...l, invoice_id: invoice.id });
          await tx.put('invoice_lines', row);
          rows.push(row);
          if (l.product_id) await this._stockOut(tx, l.product_id, l.qty, 'sale', invoice.id, st.allow_negative_stock === 1);
          if (l.is_external) externalCost += lineAmount(l.qty, l.unit_cost_cents);
        }
        await this._cash(tx, when, type, paid, invoice.id);
        await this._cash(tx, when, 'external_cost', -externalCost, invoice.id);
        await this.cat._audit(tx, type + '_created', 'invoice', invoice.id, { number: invoice.number, total });
        return { invoice, lines: rows, duplicate: false };
      });
    }

    /* Turns a generic line of a quick sale into a real one, WITHOUT changing the invoice total.
       spec: { product_id } or { external:{name,buy_cents} }. The real cost replaces the flat percentage. */
    async detailQuickLine(invoiceId, lineId, spec, opts) {
      const when = this._when();
      return this.store.tx(ENGINE_TX, 'readwrite', async (tx) => {
        const st = await this._settings(tx);
        const inv = await tx.get('invoices', invoiceId);
        if (!inv || inv.type !== 'quick_sale') throw new WeGoError('NOT_FOUND', 'Quick sale not found', { invoiceId });
        if ((await tx.byIndex('invoices', 'original', inv.id)).length) throw new WeGoError('ALREADY_RETURNED', 'A returned invoice cannot be edited');
        const line = await tx.get('invoice_lines', lineId);
        if (!line || line.invoice_id !== inv.id || !line.is_generic) throw new WeGoError('NOT_GENERIC', 'This line is already detailed', { lineId });

        let externalCost = 0;
        let stockProduct = null;
        if (spec.product_id) {
          const p = await tx.get('products', spec.product_id);
          if (!p || p.is_deleted) throw new WeGoError('PRODUCT_UNAVAILABLE', 'Product not available', { product_id: spec.product_id });
          Object.assign(line, {
            product_id: p.id, sku: p.sku, name: p.name, category_id: p.category_id,
            list_price_cents: p.sell_cents, unit_cost_cents: p.buy_cents,
          });
          stockProduct = p.id;
        } else if (spec.external) {
          const name = String(spec.external.name || '').trim();
          if (!name) throw new WeGoError('INVALID_NAME', 'External product name is required');
          Object.assign(line, { name, is_external: 1, unit_cost_cents: int(spec.external.buy_cents, 'buy_cents', 0) });
          externalCost = lineAmount(line.qty, line.unit_cost_cents);
        } else {
          throw new WeGoError('INVALID_LINE', 'Provide a product or an external product');
        }
        line.is_generic = 0;
        if (this._lossLines([line]).length && !(opts && opts.allow_loss)) {
          throw new WeGoError('LOSS_NEEDS_CONFIRMATION', 'Sale below cost', { line_nos: [line.line_no] });
        }
        this._stamp(line);
        await tx.put('invoice_lines', line);
        if (stockProduct) await this._stockOut(tx, stockProduct, line.qty, 'sale_detail', inv.id, st.allow_negative_stock === 1);
        await this._cash(tx, when, 'external_cost', -externalCost, inv.id);

        const all = (await tx.byIndex('invoice_lines', 'invoice', inv.id)).sort((a, b) => a.line_no - b.line_no);
        inv.cost_cents = sum(all, (l) => lineAmount(l.qty, l.unit_cost_cents));
        inv.profit_cents = inv.total_cents - inv.cost_cents;
        Object.assign(inv, detailState(all));
        this._stamp(inv);
        await tx.put('invoices', inv);
        await this.cat._audit(tx, 'quick_sale_detailed', 'invoice', inv.id, { line_no: line.line_no });
        return { invoice: inv, line };
      });
    }

    /* ---------- purchases ---------- */

    /* input: { lines:[{product_id|new:{category_id|sku,name,sell_cents}, qty, unit_cost_cents}],
                paid_cents?, supplier?:{name,phone}, client_ref? }
       Stock goes up; cost follows settings.cost_method ('wac' = weighted average, 'last'). */
    async purchase(input) {
      const when = this._when();
      return this.store.tx(ENGINE_TX, 'readwrite', async (tx) => {
        const prior = await this._existing(tx, input.client_ref);
        if (prior) return prior;
        const st = await this._settings(tx);
        if (!Array.isArray(input.lines) || input.lines.length === 0) throw new WeGoError('EMPTY_CART', 'No lines');

        const staged = [];
        for (const [i, l] of input.lines.entries()) {
          const qty = int(l.qty, 'qty', 1);
          const cost = int(l.unit_cost_cents, 'unit_cost_cents', 0);
          let p;
          if (l.product_id) {
            p = await tx.get('products', l.product_id);
            if (!p || p.is_deleted) throw new WeGoError('PRODUCT_UNAVAILABLE', 'Product not available', { product_id: l.product_id });
          } else if (l.new) {
            p = await this.cat._createProductIn(tx, { ...l.new, buy_cents: cost, qty: 0 });
          } else {
            throw new WeGoError('INVALID_LINE', 'A line needs a product or a new product', { line_no: i + 1 });
          }
          staged.push({ p, qty, cost, line_no: i + 1 });
        }
        const total = sum(staged, (s) => lineAmount(s.qty, s.cost));
        if (total <= 0) throw new WeGoError('INVALID_TOTAL', 'Total must be greater than zero');
        const paid = input.paid_cents === undefined ? total : int(input.paid_cents, 'paid_cents', 0);
        if (paid > total) throw new WeGoError('OVERPAID', 'Paid amount exceeds the total', { total, paid });
        const due = total - paid;
        const supplier = await this._party(tx, 'supplier', input.supplier, due > 0);

        const invoice = await this._makeInvoice(tx, when, {
          type: 'purchase',
          party_type: supplier ? 'supplier' : null, party_id: supplier ? supplier.id : null,
          party_name: supplier ? supplier.name : '', party_phone: supplier ? supplier.phone : '',
          total_cents: total, paid_cents: paid, due_cents: due, cost_cents: total, profit_cents: 0,
          client_ref: input.client_ref || null, note: input.note || '',
        });
        const rows = [];
        for (const s of staged) {
          const p = await tx.get('products', s.p.id);
          const row = this._rec({
            invoice_id: invoice.id, line_no: s.line_no, product_id: p.id, sku: p.sku, name: p.name, category_id: p.category_id,
            qty: s.qty, unit_price_cents: s.cost, list_price_cents: p.sell_cents, unit_cost_cents: s.cost,
            line_total_cents: lineAmount(s.qty, s.cost), is_external: 0, is_generic: 0, returned_qty: 0, original_line_id: null,
          });
          await tx.put('invoice_lines', row);
          rows.push(row);
          const oldQty = p.qty;
          p.buy_cents = st.cost_method === 'wac' && oldQty > 0
            ? Math.round((oldQty * p.buy_cents + s.qty * s.cost) / (oldQty + s.qty))
            : s.cost;
          p.qty = oldQty + s.qty;
          this._stamp(p);
          await tx.put('products', p);
          await this.cat._movement(tx, p, s.qty, 'purchase', invoice.id);
        }
        await this._cash(tx, when, 'purchase', -paid, invoice.id);
        await this.cat._audit(tx, 'purchase_created', 'invoice', invoice.id, { number: invoice.number, total });
        return { invoice, lines: rows, duplicate: false };
      });
    }

    /* ---------- returns ---------- */

    /* Customer return. input: { original_invoice_id, items:[{line_id, qty, resolution?}], client_ref? }
       resolution (only needed when the product no longer matches the stock):
         { action:'reinsert' }                   put it back in stock as a new product
         { action:'adapt', product_id }          put it back on an existing product
         { action:'no_stock' }                   refund without touching the stock
       Without a needed resolution the call fails with RETURN_NEEDS_RESOLUTION (and writes nothing).
       The refund first reduces the customer's debt (the original invoice first), the rest goes out of the till. */
    returnFromCustomer(input) { return this._return('customer', input); }

    /* Supplier return: stock goes out, the refund first reduces what we owe, the rest comes into the till. */
    returnToSupplier(input) { return this._return('supplier', input); }

    async _return(side, input) {
      const customerSide = side === 'customer';
      const retType = customerSide ? 'return_customer' : 'return_supplier';
      const when = this._when();
      return this.store.tx(ENGINE_TX, 'readwrite', async (tx) => {
        const prior = await this._existing(tx, input.client_ref);
        if (prior) return prior;
        const st = await this._settings(tx);
        const orig = await tx.get('invoices', input.original_invoice_id);
        const okTypes = customerSide ? SALE_TYPES : ['purchase'];
        if (!orig || !okTypes.includes(orig.type)) throw new WeGoError('INVALID_ORIGINAL', 'Original invoice not found or of the wrong type');
        if (!Array.isArray(input.items) || input.items.length === 0) throw new WeGoError('EMPTY_CART', 'Nothing to return');

        // Pass 1: validate and decide where each returned quantity goes (no writes yet).
        const plan = [];
        const unresolved = [];
        const seen = new Set();
        for (const item of input.items) {
          const line = await tx.get('invoice_lines', item.line_id);
          if (!line || line.invoice_id !== orig.id) throw new WeGoError('NOT_FOUND', 'Line not found on this invoice', { line_id: item.line_id });
          if (seen.has(line.id)) throw new WeGoError('DUPLICATE_ITEM', 'Same line twice', { line_id: line.id });
          seen.add(line.id);
          const qty = int(item.qty, 'qty', 1);
          if (qty > line.qty - line.returned_qty) throw new WeGoError('RETURN_EXCEEDS', 'More than what remains to return', { line_id: line.id, remaining: line.qty - line.returned_qty });
          const res = item.resolution || {};
          let dest = { kind: 'none' };
          if (line.product_id && res.action !== 'no_stock') {
            const check = await this.cat._checkReturnLineIn(tx, line);
            const blocking = customerSide ? check.status !== 'match' : (check.status === 'deleted' || check.status === 'missing');
            if (!blocking) {
              dest = { kind: 'stock', product_id: line.product_id };
            } else if (res.action === 'adapt') {
              const target = await tx.get('products', res.product_id);
              if (!target || target.is_deleted) throw new WeGoError('PRODUCT_UNAVAILABLE', 'Product not available', { product_id: res.product_id });
              dest = { kind: 'stock', product_id: target.id };
            } else if (res.action === 'reinsert' && customerSide) {
              dest = { kind: 'reinsert', check };
            } else {
              unresolved.push({ line_id: line.id, ...check });
            }
          }
          plan.push({ line, qty, dest });
        }
        if (unresolved.length) throw new WeGoError('RETURN_NEEDS_RESOLUTION', 'Some returned products no longer match the stock', { items: unresolved });

        // Pass 2: write.
        const reinserted = new Map();
        const retLines = [];
        let refund = 0;
        let costPart = 0;
        for (const [i, { line, qty, dest }] of plan.entries()) {
          let productId = line.product_id;
          if (dest.kind === 'reinsert') {
            if (!reinserted.has(line.product_id)) {
              const created = await this.cat._createProductIn(tx, {
                ...(dest.check.reinsert_sku ? { sku: dest.check.reinsert_sku } : { category_id: line.category_id }),
                name: line.name, sell_cents: line.list_price_cents, buy_cents: line.unit_cost_cents, qty: 0,
              });
              reinserted.set(line.product_id, created.id);
            }
            productId = reinserted.get(line.product_id);
          } else if (dest.kind === 'stock') {
            productId = dest.product_id;
          }
          if (dest.kind !== 'none') {
            if (customerSide) await this._stockIn(tx, productId, qty, retType, orig.id);
            else await this._stockOut(tx, productId, qty, retType, orig.id, st.allow_negative_stock === 1);
          }
          refund += lineAmount(qty, line.unit_price_cents);
          costPart += lineAmount(qty, line.unit_cost_cents);
          line.returned_qty += qty;
          this._stamp(line);
          await tx.put('invoice_lines', line);
          retLines.push({
            ...line, id: undefined, line_no: i + 1, qty, product_id: dest.kind === 'none' ? line.product_id : productId,
            line_total_cents: lineAmount(qty, line.unit_price_cents), returned_qty: 0, original_line_id: line.id,
          });
        }

        const invoice = await this._makeInvoice(tx, when, {
          type: retType, party_type: orig.party_type, party_id: orig.party_id,
          party_name: orig.party_name, party_phone: orig.party_phone,
          total_cents: refund, cost_cents: costPart, profit_cents: customerSide ? -(refund - costPart) : 0,
          original_invoice_id: orig.id, client_ref: input.client_ref || null, note: input.note || '',
        });
        const rows = [];
        for (const r of retLines) {
          const row = this._rec({ ...r, id: this.cat.uuid(), invoice_id: invoice.id });
          await tx.put('invoice_lines', row);
          rows.push(row);
        }
        const applied = orig.party_id
          ? await this._applyToDebts(tx, when, orig.party_type, orig.party_id, refund, orig.id, invoice.id, 'return_credit')
          : 0;
        const cashPart = refund - applied;
        invoice.paid_cents = cashPart;
        await tx.put('invoices', invoice);
        await this._cash(tx, when, retType, customerSide ? -cashPart : cashPart, invoice.id);
        await this.cat._audit(tx, retType + '_created', 'invoice', invoice.id, { number: invoice.number, refund, applied });
        return { invoice, lines: rows, refund_cents: refund, debt_reduced_cents: applied, cash_cents: cashPart, duplicate: false };
      });
    }

    /* ---------- debts: collections and supplier payments ---------- */

    receivePayment({ customer_id, amount_cents }) { return this._settle('customer', customer_id, amount_cents); }

    paySupplier({ supplier_id, amount_cents }) { return this._settle('supplier', supplier_id, amount_cents); }

    async _settle(partyType, partyId, amount) {
      const when = this._when();
      return this.store.tx(ENGINE_TX, 'readwrite', async (tx) => {
        int(amount, 'amount_cents', 1);
        const party = await tx.get(partyType === 'customer' ? 'customers' : 'suppliers', partyId);
        if (!party) throw new WeGoError('NOT_FOUND', 'Party not found', { partyId });
        const debtTypes = partyType === 'customer' ? SALE_TYPES : ['purchase'];
        const debt = sum((await tx.byIndex('invoices', 'party', [partyType, partyId])).filter((i) => debtTypes.includes(i.type)), (i) => i.due_cents);
        if (amount > debt) throw new WeGoError('OVERPAYMENT', 'Amount exceeds the debt', { debt });
        const direction = partyType === 'customer' ? 'collection' : 'supplier_payment';
        await this._applyToDebts(tx, when, partyType, partyId, amount, null, null, direction);
        await this._cash(tx, when, direction, partyType === 'customer' ? amount : -amount, partyId);
        await this.cat._audit(tx, direction, partyType, partyId, { amount });
        return { applied_cents: amount, remaining_debt_cents: debt - amount };
      });
    }

    /* [{ party_id, name, phone, total_due_cents, invoices }] biggest debt first */
    async debtSummary(partyType) {
      return this.store.tx(['invoices', 'customers', 'suppliers'], 'readonly', async (tx) => {
        const debtTypes = partyType === 'customer' ? SALE_TYPES : ['purchase'];
        const open = (await tx.all('invoices')).filter((i) => debtTypes.includes(i.type) && i.due_cents > 0 && i.party_id);
        const groups = new Map();
        for (const i of open) {
          const g = groups.get(i.party_id) || { party_id: i.party_id, name: i.party_name, phone: i.party_phone, total_due_cents: 0, invoices: 0 };
          g.total_due_cents += i.due_cents;
          g.invoices += 1;
          groups.set(i.party_id, g);
        }
        return [...groups.values()].sort((a, b) => b.total_due_cents - a.total_due_cents);
      });
    }

    /* All invoices of one customer/supplier, newest first (open ones carry due_cents > 0). */
    async partyInvoices(partyType, partyId) {
      const rows = await this.store.tx(['invoices'], 'readonly', (tx) => tx.byIndex('invoices', 'party', [partyType, partyId]));
      return rows.sort((a, b) => byAtThenNumber(b, a));
    }

    async getInvoice(id) {
      return this.store.tx(['invoices', 'invoice_lines'], 'readonly', async (tx) => {
        const invoice = await tx.get('invoices', id);
        if (!invoice) return null;
        const lines = (await tx.byIndex('invoice_lines', 'invoice', id)).sort((a, b) => a.line_no - b.line_no);
        return { invoice, lines };
      });
    }

    /* ---------- cash, expenses ---------- */

    addExpense({ label, amount_cents, client_ref }) {
      return this._cashOperation('expense', 'expense', -1, { label, amount_cents, client_ref });
    }

    cashDeposit({ amount_cents, note, client_ref }) {
      return this._cashOperation('deposit', 'deposit', 1, { label: note, amount_cents, client_ref });
    }

    cashWithdrawal({ amount_cents, note, client_ref }) {
      return this._cashOperation('withdrawal', 'withdrawal', -1, { label: note, amount_cents, client_ref });
    }

    async _cashOperation(type, kind, sign, { label, amount_cents, client_ref }) {
      const when = this._when();
      return this.store.tx(ENGINE_TX, 'readwrite', async (tx) => {
        const prior = await this._existing(tx, client_ref);
        if (prior) return prior;
        const amount = int(amount_cents, 'amount_cents', 1);
        const text = String(label || '').trim();
        if (type === 'expense' && !text) throw new WeGoError('INVALID_NAME', 'Expense label is required');
        const invoice = await this._makeInvoice(tx, when, {
          type, total_cents: amount, paid_cents: amount, client_ref: client_ref || null, note: text,
        });
        if (type === 'expense') await tx.put('expenses', this._rec({ at: when.at, day: when.day, label: text, amount_cents: amount, user_id: null }));
        await this._cash(tx, when, kind, sign * amount, invoice.id, text);
        await this.cat._audit(tx, type + '_created', 'invoice', invoice.id, { number: invoice.number, amount });
        return { invoice, duplicate: false };
      });
    }

    async cashBalance() {
      const rows = await this.store.tx(['cash_entries'], 'readonly', (tx) => tx.all('cash_entries'));
      return sum(rows, (r) => r.amount_cents);
    }

    /* Closing count. The difference is kept in cash_counts (history for the owner) and an adjustment
       entry makes the till balance equal to what was counted. */
    async closeCash({ counted_cents }) {
      const when = this._when();
      return this.store.tx(['cash_entries', 'cash_counts', 'audit_log'], 'readwrite', async (tx) => {
        const counted = int(counted_cents, 'counted_cents', 0);
        const expected = sum(await tx.all('cash_entries'), (r) => r.amount_cents);
        const diff = counted - expected;
        const rec = this._rec({ at: when.at, day: when.day, expected_cents: expected, counted_cents: counted, diff_cents: diff, user_id: null });
        await tx.put('cash_counts', rec);
        await this._cash(tx, when, 'count_adjust', diff, rec.id);
        await this.cat._audit(tx, 'cash_closed', 'cash_count', rec.id, { diff });
        return rec;
      });
    }

    /* ---------- inventory (owner, one category at a time) ---------- */

    async countSheet(categoryId) {
      const rows = await this.cat.listByCategory(categoryId);
      return rows.map((p) => ({ product_id: p.id, sku: p.sku, name: p.name, expected_qty: p.qty }));
    }

    /* counts: [{ product_id, counted_qty }] — products not listed are left untouched.
       Any difference is recorded and the stock is set to the counted quantity. */
    async applyCount({ category_id, counts }) {
      const when = this._when();
      return this.store.tx(ENGINE_TX, 'readwrite', async (tx) => {
        if (!Array.isArray(counts) || counts.length === 0) throw new WeGoError('EMPTY_CART', 'Nothing counted');
        const count = this._rec({ category_id, status: 'done', started_at: when.at, finished_at: when.at, user_id: null, shortage_cost_cents: 0 });
        const seen = new Set();
        const lines = [];
        let shortage = 0;
        for (const c of counts) {
          if (seen.has(c.product_id)) throw new WeGoError('DUPLICATE_ITEM', 'Product counted twice', { product_id: c.product_id });
          seen.add(c.product_id);
          const counted = int(c.counted_qty, 'counted_qty', 0);
          const p = await tx.get('products', c.product_id);
          if (!p || p.is_deleted || p.category_id !== category_id) throw new WeGoError('PRODUCT_UNAVAILABLE', 'Product not in this category', { product_id: c.product_id });
          const diff = counted - p.qty;
          lines.push(this._rec({
            count_id: count.id, product_id: p.id, sku: p.sku, name: p.name, unit_cost_cents: p.buy_cents,
            expected_qty: p.qty, counted_qty: counted, diff_qty: diff,
          }));
          if (diff !== 0) {
            if (diff < 0) shortage += lineAmount(-diff, p.buy_cents);
            p.qty = counted;
            this._stamp(p);
            await tx.put('products', p);
            await this.cat._movement(tx, p, diff, 'count_adjust', count.id);
          }
        }
        count.shortage_cost_cents = shortage;
        await tx.put('stock_counts', count);
        for (const l of lines) await tx.put('stock_count_lines', l);
        await this.cat._audit(tx, 'stock_counted', 'stock_count', count.id, { category_id, shortage_cost_cents: shortage });
        return { count, lines, shortage_cost_cents: shortage };
      });
    }

    /* ---------- reports ---------- */

    async dailyReport(day) {
      return this.store.tx(['invoices', 'cash_entries'], 'readonly', async (tx) => {
        const inv = await tx.byIndex('invoices', 'day', day);
        const of = (types) => inv.filter((i) => types.includes(i.type));
        const sales = of(SALE_TYPES);
        const returns = of(['return_customer']);
        const cash = await tx.byIndex('cash_entries', 'day', day);
        return {
          day,
          sales_cents: sum(sales, (i) => i.total_cents),
          sales_count: sales.length,
          undetailed_quick_sales: sales.filter((i) => i.type === 'quick_sale' && !i.has_detail).length,
          returns_cents: sum(returns, (i) => i.total_cents),
          net_sales_cents: sum(sales, (i) => i.total_cents) - sum(returns, (i) => i.total_cents),
          profit_cents: sum(sales, (i) => i.profit_cents) + sum(returns, (i) => i.profit_cents),
          expenses_cents: sum(of(['expense']), (i) => i.total_cents),
          purchases_cents: sum(of(['purchase']), (i) => i.total_cents),
          cash_in_cents: sum(cash.filter((c) => c.amount_cents > 0), (c) => c.amount_cents),
          cash_out_cents: -sum(cash.filter((c) => c.amount_cents < 0), (c) => c.amount_cents),
        };
      });
    }

    /* Sales minus customer returns per category (snapshot taken at sale time, so migrating a product
       never rewrites the past). Lines without a category (external, generic) go to 'none'. */
    async categoryReport({ from, to }) {
      return this.store.tx(['invoices', 'invoice_lines'], 'readonly', async (tx) => {
        const invoices = (await tx.all('invoices')).filter((i) => i.day >= from && i.day <= to && (SALE_TYPES.includes(i.type) || i.type === 'return_customer'));
        const buckets = new Map();
        for (const inv of invoices) {
          const sign = inv.type === 'return_customer' ? -1 : 1;
          for (const l of await tx.byIndex('invoice_lines', 'invoice', inv.id)) {
            const key = l.category_id || 'none';
            const b = buckets.get(key) || { category_id: key, revenue_cents: 0, cost_cents: 0, profit_cents: 0, qty: 0 };
            const cost = lineAmount(l.qty, l.unit_cost_cents);
            b.revenue_cents += sign * l.line_total_cents;
            b.cost_cents += sign * cost;
            b.profit_cents += sign * (l.line_total_cents - cost);
            b.qty += sign * l.qty;
            buckets.set(key, b);
          }
        }
        return [...buckets.values()].sort((a, b) => b.revenue_cents - a.revenue_cents);
      });
    }

    /* ---------- sync helpers and safety net ---------- */

    /* After a future synchronisation: two invoices with the same number -> the later one gets -1, -2... */
    async dedupeInvoiceNumbers() {
      return this.store.tx(['invoices', 'audit_log'], 'readwrite', async (tx) => {
        const all = await tx.all('invoices');
        const taken = new Set(all.map((i) => i.number));
        const groups = new Map();
        for (const i of all) {
          if (!groups.has(i.number)) groups.set(i.number, []);
          groups.get(i.number).push(i);
        }
        const changes = [];
        for (const g of groups.values()) {
          if (g.length < 2) continue;
          g.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
          for (const inv of g.slice(1)) {
            let n = 1;
            while (taken.has(inv.number + '-' + n)) n += 1;
            const from = inv.number;
            inv.number = from + '-' + n;
            taken.add(inv.number);
            this._stamp(inv);
            await tx.put('invoices', inv);
            await this.cat._audit(tx, 'invoice_number_resolved', 'invoice', inv.id, { from, to: inv.number });
            changes.push({ id: inv.id, from, to: inv.number });
          }
        }
        return changes;
      });
    }

    /* Verifies the invariants that must always hold. Returns a list of problems (empty = healthy). */
    async checkIntegrity() {
      return this.store.tx(['products', 'stock_movements', 'invoices', 'invoice_lines'], 'readonly', async (tx) => {
        const issues = [];
        const products = await tx.all('products');
        const moves = await tx.all('stock_movements');
        for (const p of products) {
          const total = sum(moves.filter((m) => m.product_id === p.id), (m) => m.qty_delta);
          if (total !== p.qty) issues.push('stock journal mismatch for ' + p.sku + ': ' + total + ' vs ' + p.qty);
        }
        const invoices = await tx.all('invoices');
        const lines = await tx.all('invoice_lines');
        for (const inv of invoices) {
          const own = lines.filter((l) => l.invoice_id === inv.id);
          if (SALE_TYPES.includes(inv.type) || inv.type === 'purchase') {
            if (sum(own, (l) => l.line_total_cents) !== inv.total_cents) issues.push(inv.number + ': lines do not add up to the total');
            if (inv.paid_cents + inv.due_cents !== inv.total_cents) issues.push(inv.number + ': paid + due differs from total');
            if (inv.paid_cents < 0 || inv.due_cents < 0) issues.push(inv.number + ': negative paid or due');
            if (SALE_TYPES.includes(inv.type) && sum(own, (l) => lineAmount(l.qty, l.unit_cost_cents)) !== inv.cost_cents) issues.push(inv.number + ': cost mismatch');
          }
        }
        for (const l of lines) {
          if (l.returned_qty > l.qty) issues.push('line ' + l.id + ': returned more than sold');
          const back = sum(lines.filter((r) => r.original_line_id === l.id), (r) => r.qty);
          if (back !== l.returned_qty) issues.push('line ' + l.id + ': returned_qty does not match the return invoices');
        }
        return issues;
      });
    }
  }

  const api = { Engine, lineAmount };
  root.WeGo = root.WeGo || {};
  root.WeGo.engine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
