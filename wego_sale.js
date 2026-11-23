/* wego_sale.js — the sale session engine. NO user interface in here.
   The screens (PC and phone) only send keys/intents and display state(); they never compute money.
   Units: money in cents, quantities in hundredths (QTY_SCALE = 100): both use the same scale, so
   "price x quantity" is Math.round(qty * price / 100).
   Modes: 'calc' (plain calculator), 'quick' (a quick invoice typed on the keypad), 'detailed' (products picked from the stock). */
(function (root) {
  'use strict';

  const rules = typeof require !== 'undefined' ? require('./wego_rules.js') : root.WeGo.rules;
  const schema = typeof require !== 'undefined' ? require('./wego_schema.js') : root.WeGo.schema;
  const { WeGoError } = rules;

  const SCALE = schema.qtyScale;
  const MAX_PARKED = 5;
  const OPS = { '+': '+', '−': '−', '-': '−', '×': '×', x: '×', X: '×', '*': '×', '÷': '÷', '/': '÷', '%': '%' };
  const isOp = (c) => c === '+' || c === '−' || c === '×' || c === '÷' || c === '%';

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const lineTotal = (l) => Math.round((l.qty * l.price) / SCALE);

  /* ---------- formatting (shared with the screens) ---------- */
  function trimmed(hundredths) { return (hundredths / 100).toFixed(2).replace(/\.?0+$/, ''); }
  function money(cents) {
    const neg = cents < 0;
    const [i, d] = (Math.abs(cents) / 100).toFixed(2).split('.');
    return (neg ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + '.' + d;
  }

  /* "45.5" -> 4550 ; at most two decimals ; NaN when not a plain number */
  function toUnits(text) {
    const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(text);
    if (!m || (m[1] === '' && !m[2])) return NaN;
    return parseInt(m[1] || '0', 10) * 100 + parseInt((m[2] || '').padEnd(2, '0') || '0', 10);
  }

  /* ---------- calculator: precedence, commercial % ---------- */
  function evaluate(expr) {
    const toks = [];
    for (let i = 0; i < expr.length;) {
      if (/[0-9.]/.test(expr[i])) {
        let j = i;
        while (j < expr.length && /[0-9.]/.test(expr[j])) j += 1;
        toks.push({ n: expr.slice(i, j) });
        i = j;
      } else { toks.push({ o: expr[i] }); i += 1; }
    }
    while (toks.length && toks[toks.length - 1].o && toks[toks.length - 1].o !== '%') toks.pop();
    if (!toks.length) return 0;
    let pos = 0;
    const syntax = () => new WeGoError('SYNTAX', 'Invalid expression');
    const factor = () => {
      const t = toks[pos];
      if (!t || t.n === undefined) throw syntax();
      const v = parseFloat(t.n);
      if (Number.isNaN(v)) throw syntax();
      pos += 1;
      if (toks[pos] && toks[pos].o === '%') { pos += 1; return { v: v / 100, pct: true }; }
      return { v, pct: false };
    };
    const term = () => {
      const first = factor();
      let v = first.v;
      let single = first.pct;
      while (toks[pos] && (toks[pos].o === '×' || toks[pos].o === '÷')) {
        const op = toks[pos].o;
        pos += 1;
        const b = factor();
        if (op === '×') v *= b.v;
        else if (b.v === 0) throw new WeGoError('DIV0', 'Division by zero');
        else v /= b.v;
        single = false;
      }
      return { v, single };
    };
    let acc = term().v;
    while (toks[pos] && (toks[pos].o === '+' || toks[pos].o === '−')) {
      const op = toks[pos].o;
      pos += 1;
      const t = term();
      const x = t.single ? acc * t.v : t.v;          // "200 + 10%" = 200 + 20
      acc = op === '+' ? acc + x : acc - x;
    }
    if (pos < toks.length) throw syntax();
    return Math.round((acc + Number.EPSILON) * 100) / 100;
  }

  /* One '+'-separated term of a quick invoice -> { price, qty }.  "a×b" = price × quantity ; "a" = price × 1 ;
     any term using − ÷ % or several × is calculated first and becomes one line of quantity 1. */
  function termToLine(term) {
    let price;
    let qty = SCALE;
    if (/[−÷%]/.test(term) || (term.match(/×/g) || []).length > 1) {
      price = Math.round(evaluate(term) * 100);
    } else if (term.includes('×')) {
      const [a, b] = term.split('×');
      price = toUnits(a);
      qty = toUnits(b);
    } else {
      price = toUnits(term);
    }
    if (Number.isNaN(price) || Number.isNaN(qty) || price <= 0 || qty <= 0) throw new WeGoError('INVALID_EXPRESSION', 'Invalid term', { term });
    return { price, qty };
  }

  const fresh = (ref) => ({ mode: null, expr: '', result: null, lines: [], ref, query: { letter: '', digits: '', picked: false } });
  const isEmpty = (c) => c.lines.length === 0 && c.expr === '';

  /* What the employee is most likely to do next. The screen highlights the matching button.
     action: choose_mode | type | equals | confirm | pay | search | pick_result | no_match */
  function nextStep(s, lastMode) {
    if (!s.mode) return { action: 'choose_mode', suggest: lastMode || null };
    if (s.mode === 'calc') return { action: s.expr ? 'equals' : 'type' };
    if (s.mode === 'quick') {
      if (s.expr) return { action: 'equals' };
      if (!s.lines.length) return { action: 'type' };
      return { action: s.needs_confirm ? 'confirm' : 'pay' };
    }
    if (s.results.length) return { action: 'pick_result', single: s.results.length === 1 ? s.results[0].id : null };
    if (s.query.digits) return { action: 'no_match' };
    return { action: s.lines.length ? 'pay' : 'search' };
  }

  class SaleSession {
    constructor({ store, catalog, engine }) {
      this.store = store;
      this.cat = catalog;
      this.eng = engine;
      this.cur = fresh(catalog.uuid());
      this.parked = {};
      this.undoStack = [];
      this.results = [];
      this.hint = null;
      this.lastMode = null;
      this._q = Promise.resolve();
    }

    /* ---------- state seen by the screens ---------- */
    state() {
      const lines = this.cur.lines.map((l) => {
        const real = !l.generic && l.cost !== undefined;
        const margin = real ? l.price - l.cost : null;
        return {
          ...l,
          total: lineTotal(l),
          zero_price: l.price <= 0,
          below_cost: real && l.price < l.cost,
          margin_cents: margin,
          margin_pct: real && l.price > 0 ? Math.round((margin / l.price) * 1000) / 10 : null,
        };
      });
      const state = {
        mode: this.cur.mode,
        expr: this.cur.expr,
        result: this.cur.result,
        lines,
        total: lines.reduce((sum, l) => sum + l.total, 0),
        needs_confirm: this.cur.mode === 'quick' && lines.some((l) => !l.confirmed),
        query: { ...this.cur.query },
        results: this.results,
        parked: Object.keys(this.parked).map(Number).sort((x, y) => x - y).map((slot) => {
          const p = this.parked[slot];
          return { slot, mode: p.mode, count: p.lines.length, total: p.lines.reduce((sum, l) => sum + lineTotal(l), 0) };
        }),
        can_undo: this.undoStack.length > 0,
        hint: this.hint,
      };
      state.next = nextStep(state, this.lastMode);
      return state;
    }

    /* What paying would do, before the employee confirms: used by the payment window. */
    preview({ paid_cents } = {}) {
      const st = this.state();
      let blocked = null;
      if (st.mode !== 'quick' && st.mode !== 'detailed') blocked = 'NO_INVOICE';
      else if (!st.lines.length) blocked = 'EMPTY_CART';
      else if (st.needs_confirm) blocked = 'NEEDS_CONFIRM';
      else if (st.lines.some((l) => l.zero_price)) blocked = 'ZERO_PRICE';
      const paid = paid_cents === undefined ? st.total : paid_cents;
      const effective = Math.min(paid, st.total);
      return {
        total: st.total, paid, effective, change_cents: Math.max(0, paid - st.total), due_cents: st.total - effective,
        needs_party: effective < st.total,
        loss_lines: st.lines.map((l, i) => (l.below_cost ? i + 1 : 0)).filter(Boolean),
        blocked,
      };
    }

    /* Quick invoices still waiting for their details (a reminder badge for the employee). */
    async pendingDetails() {
      const rows = await this.store.tx(['invoices'], 'readonly', (tx) => tx.byIndex('invoices', 'detailed', 0));
      const open = rows.filter((i) => i.type === 'quick_sale');
      return { count: open.length, total_cents: open.reduce((sum, i) => sum + i.total_cents, 0) };
    }

    _run(fn) {
      const p = this._q.then(async () => {
        this.hint = null;
        const out = await fn();
        await this._save();
        return out === undefined ? this.state() : out;
      });
      this._q = p.catch(() => {});
      return p;
    }

    _snapshot() {
      this.undoStack.push(clone({ mode: this.cur.mode, expr: this.cur.expr, result: this.cur.result, lines: this.cur.lines }));
      if (this.undoStack.length > 50) this.undoStack.shift();
    }

    _renumber() {
      let n = 0;
      for (const l of this.cur.lines) if (l.generic) { n += 1; l.name = 'produit ' + n; }
    }

    async _audit(action, details) {
      await this.store.tx(['audit_log'], 'readwrite', (tx) => this.cat._audit(tx, action, 'sale_session', this.cur.ref, details));
    }

    /* ---------- autosave ---------- */
    async _save() {
      const empty = isEmpty(this.cur) && Object.keys(this.parked).length === 0 && !this.cur.mode;
      await this.store.tx(['meta'], 'readwrite', async (tx) => {
        if (empty) await tx.del('meta', 'sale_draft');
        else await tx.put('meta', { key: 'sale_draft', value: { cur: this.cur, parked: this.parked } });
      });
    }

    load() {
      return this._run(async () => {
        const [row, last] = await this.store.tx(['meta'], 'readonly', async (tx) => [await tx.get('meta', 'sale_draft'), await tx.get('meta', 'last_sale_mode')]);
        if (row) { this.cur = row.value.cur; this.parked = row.value.parked; }
        this.lastMode = last ? last.value : null;
        this.undoStack = [];
        await this._refreshResults();
      });
    }

    /* ---------- modes and keys ---------- */
    selectMode(mode) {
      return this._run(async () => {
        if (!['calc', 'quick', 'detailed'].includes(mode)) throw new WeGoError('INVALID_MODE', 'Unknown mode');
        if (mode === this.cur.mode) return;
        if (this.cur.lines.length || this.cur.expr) throw new WeGoError('MODE_LOCKED', 'Park or clear the invoice before changing the mode');
        this.cur.mode = mode; this.cur.result = null; this.cur.query = { letter: '', digits: '', picked: false };
        await this._refreshResults();
      });
    }

    press(key) {
      return this._run(async () => {
        const c = this.cur;
        if (!c.mode) { this.hint = 'CHOOSE_MODE'; return; }
        const k = OPS[key] || key;
        if (c.mode === 'detailed') { await this._pressDetailed(k); return; }
        if (/^[0-9]$/.test(k)) this._digit(k);
        else if (k === '.') this._dot();
        else if (isOp(k)) this._operator(k);
        else if (k === '⌫') { c.expr = c.expr.slice(0, -1); }
        else if (k === 'C') { c.expr = ''; c.result = null; }
        else if (k === '=') this._equals();
      });
    }

    _lastNumber() { const m = /[0-9.]+$/.exec(this.cur.expr); return m ? m[0] : null; }

    _digit(d) {
      const c = this.cur;
      if (c.result !== null) { c.expr = ''; c.result = null; }
      if (c.expr.endsWith('%')) return;
      const n = this._lastNumber();
      if (n === '0') c.expr = c.expr.slice(0, -1) + d;
      else if (n !== null && n.includes('.') && n.split('.')[1].length >= 2) return;
      else c.expr += d;
    }

    _dot() {
      const c = this.cur;
      if (c.result !== null) { c.expr = ''; c.result = null; }
      const n = this._lastNumber();
      if (n === null) { if (!c.expr.endsWith('%')) c.expr += '0.'; } else if (!n.includes('.')) c.expr += '.';
    }

    _operator(op) {
      const c = this.cur;
      if (c.result !== null) { c.expr = String(Number(c.result)); c.result = null; }
      if (c.expr === '') return;
      const last = c.expr[c.expr.length - 1];
      if (op === '%') { if (/[0-9]/.test(last)) c.expr += '%'; return; }
      if (last === '%') { c.expr += op; return; }
      if (isOp(last)) c.expr = c.expr.slice(0, -1) + op; else c.expr += op;
    }

    _equals() {
      const c = this.cur;
      if (c.expr === '') return;
      try {
        if (c.mode === 'calc') {
          c.result = evaluate(c.expr).toFixed(2);
          c.expr = '';
          return;
        }
        const terms = c.expr.replace(/[+−×÷]+$/, '').split('+').filter((t) => t !== '');
        const added = terms.map((t) => termToLine(t));
        this._snapshot();
        for (const t of added) c.lines.push({ name: '', qty: t.qty, price: t.price, generic: true, confirmed: false });
        c.expr = '';
        this._renumber();
      } catch (e) {
        if (!(e instanceof WeGoError)) throw e;
        this.hint = e.code === 'DIV0' ? 'DIV0' : 'INVALID_EXPRESSION';
      }
    }

    /* ---------- detailed mode: search by number ---------- */
    async _pressDetailed(k) {
      const q = this.cur.query;
      if (/^[0-9]$/.test(k)) { if (q.digits.length < 6) q.digits += k; } else if (k === '⌫') {
        if (q.digits) q.digits = q.digits.slice(0, -1); else { q.letter = ''; q.picked = false; }
      } else if (k === 'C') { q.digits = ''; q.letter = ''; q.picked = false; } else return;
      await this._refreshResults();
    }

    pickCategory(letter) {
      return this._run(async () => {
        if (this.cur.mode !== 'detailed') { this.hint = 'NOT_AVAILABLE'; return; }
        this.cur.query.letter = letter === '#' ? '' : String(letter).toUpperCase();
        this.cur.query.picked = true;
        await this._refreshResults();
      });
    }

    async _refreshResults() {
      const { mode, query } = this.cur;
      this.results = [];
      if (mode !== 'detailed' || (query.letter === '' && query.digits === '' && !query.picked)) return;
      const cats = await this.cat.listCategories();
      const category = cats.find((x) => x.prefix === query.letter);
      if (!category) return;
      const list = await this.cat.listByCategory(category.id);
      const wanted = query.digits;
      this.results = list
        .filter((p) => wanted === '' || String(p.sku_num).startsWith(wanted))
        .sort((a, b) => (String(a.sku_num) === wanted ? -1 : 0) - (String(b.sku_num) === wanted ? -1 : 0) || a.sku_num - b.sku_num)
        .slice(0, 50)
        .map((p) => ({
          id: p.id, sku: p.sku, name: p.name, price: p.sell_cents, qty: p.qty, buy: p.buy_cents,
          margin_cents: p.sell_cents - p.buy_cents,
          margin_pct: p.sell_cents > 0 ? Math.round(((p.sell_cents - p.buy_cents) / p.sell_cents) * 1000) / 10 : null,
        }));
    }

    addProduct(id) {
      return this._run(async () => {
        if (this.cur.mode !== 'detailed') { this.hint = 'NOT_AVAILABLE'; return; }
        const p = await this.cat.getProduct(id);
        if (!p || p.is_deleted) throw new WeGoError('PRODUCT_UNAVAILABLE', 'Product not available', { id });
        this._snapshot();
        const same = this.cur.lines.find((l) => l.product_id === p.id && l.price === p.sell_cents);
        if (same) same.qty += SCALE;
        else this.cur.lines.push({ product_id: p.id, sku: p.sku, name: p.name, qty: SCALE, price: p.sell_cents, list: p.sell_cents, cost: p.buy_cents, generic: false, confirmed: true });
        this.cur.query = { letter: '', digits: '', picked: false };
        await this._refreshResults();
      });
    }

    /* ---------- editing lines ---------- */
    _line(i) {
      const l = this.cur.lines[i];
      if (!l) throw new WeGoError('NOT_FOUND', 'No such line', { index: i });
      return l;
    }

    setLine(i, { qty, price }) {
      return this._run(async () => {
        const l = this._line(i);
        const nq = qty === undefined ? l.qty : qty;
        const np = price === undefined ? l.price : price;
        if (!Number.isInteger(nq) || nq <= 0 || !Number.isInteger(np) || np <= 0) throw new WeGoError('INVALID_NUMBER', 'Invalid quantity or price');
        this._snapshot();
        l.qty = nq; l.price = np;
      });
    }

    stepQty(i, delta) {
      return this._run(async () => {
        const l = this._line(i);
        const nq = l.qty + delta * SCALE;
        if (nq <= 0) { this.hint = 'MIN_QTY'; return; }
        this._snapshot();
        l.qty = nq;
      });
    }

    removeLine(i) {
      return this._run(async () => {
        this._line(i);
        this._snapshot();
        this.cur.lines.splice(i, 1);
        this._renumber();
      });
    }

    /* Quick invoice: exchange which number is the price and which is the quantity (both use the same scale). */
    swapLine(i) {
      return this._run(async () => {
        const l = this._line(i);
        if (this.cur.mode !== 'quick') { this.hint = 'NOT_AVAILABLE'; return; }
        this._snapshot();
        [l.price, l.qty] = [l.qty, l.price];
        l.confirmed = true;
      });
    }

    confirmQuantities() {
      return this._run(async () => { for (const l of this.cur.lines) l.confirmed = true; });
    }

    /* Quick invoice: take a line back into the keypad to edit it. */
    recallLine(i) {
      return this._run(async () => {
        const l = this._line(i);
        if (this.cur.mode !== 'quick') { this.hint = 'NOT_AVAILABLE'; return; }
        this._snapshot();
        this.cur.lines.splice(i, 1);
        this._renumber();
        const text = l.qty === SCALE ? trimmed(l.price) : trimmed(l.price) + '×' + trimmed(l.qty);
        this.cur.expr = this.cur.expr ? this.cur.expr + '+' + text : text;
      });
    }

    undo() {
      return this._run(async () => {
        const snap = this.undoStack.pop();
        if (!snap) { this.hint = 'NOTHING_TO_UNDO'; return; }
        Object.assign(this.cur, snap);
        await this._refreshResults();
      });
    }

    /* ---------- clearing and parking ---------- */
    clearAll({ confirmed } = {}) {
      return this._run(async () => {
        if (this.cur.lines.length) {
          if (!confirmed) throw new WeGoError('NEEDS_CONFIRM', 'Confirmation required');
          await this._audit('sale_cart_cleared', { lines: this.cur.lines.length, total: this.state().total });
        }
        this.cur = fresh(this.cat.uuid());
        this.undoStack = [];
        this.results = [];
      });
    }

    park() {
      return this._run(async () => {
        if (isEmpty(this.cur)) throw new WeGoError('NOTHING_TO_PARK', 'Nothing to park');
        let slot = 1;
        while (this.parked[slot]) slot += 1;
        if (slot > MAX_PARKED) throw new WeGoError('PARK_FULL', 'Too many parked invoices', { max: MAX_PARKED });
        this.parked[slot] = this.cur;
        this.cur = fresh(this.cat.uuid());
        this.undoStack = [];
        this.results = [];
        return slot;
      });
    }

    /* Brings a parked invoice back. A non-empty current invoice takes its place (swap). */
    restore(slot) {
      return this._run(async () => {
        const p = this.parked[slot];
        if (!p) throw new WeGoError('NOT_FOUND', 'No parked invoice with this number', { slot });
        if (isEmpty(this.cur)) delete this.parked[slot]; else this.parked[slot] = this.cur;
        this.cur = p;
        this.undoStack = [];
        await this._refreshResults();
      });
    }

    discardParked(slot, { confirmed } = {}) {
      return this._run(async () => {
        const p = this.parked[slot];
        if (!p) throw new WeGoError('NOT_FOUND', 'No parked invoice with this number', { slot });
        if (p.lines.length) {
          if (!confirmed) throw new WeGoError('NEEDS_CONFIRM', 'Confirmation required');
          await this.store.tx(['audit_log'], 'readwrite', (tx) => this.cat._audit(tx, 'parked_sale_discarded', 'sale_session', p.ref,
            { slot, lines: p.lines.length, total: p.lines.reduce((s, l) => s + lineTotal(l), 0) }));
        }
        delete this.parked[slot];
      });
    }

    /* ---------- payment ---------- */
    /* paid_cents may exceed the total: only the total goes into the till and the change is returned. */
    checkout({ paid_cents, customer, allow_loss } = {}) {
      return this._run(async () => {
        const c = this.cur;
        if (c.mode !== 'quick' && c.mode !== 'detailed') throw new WeGoError('NO_INVOICE', 'Choose quick or detailed invoice first');
        if (!c.lines.length) throw new WeGoError('EMPTY_CART', 'No lines');
        if (c.mode === 'quick' && c.lines.some((l) => !l.confirmed)) throw new WeGoError('NEEDS_CONFIRM', 'Confirm the quantities first');
        const zero = c.lines.map((l, i) => (l.price <= 0 ? i + 1 : 0)).filter(Boolean);
        if (zero.length) throw new WeGoError('ZERO_PRICE', 'A line has no price', { line_nos: zero });
        const total = c.lines.reduce((s, l) => s + lineTotal(l), 0);
        const paid = paid_cents === undefined ? total : paid_cents;
        if (!Number.isInteger(paid) || paid < 0) throw new WeGoError('INVALID_NUMBER', 'Invalid paid amount');
        const effective = Math.min(paid, total);
        if (effective < total && !(customer && String(customer.name || '').trim() && String(customer.phone || '').trim())) {
          throw new WeGoError('PARTY_REQUIRED', 'Name and phone are required when the invoice is not fully paid');
        }
        const lines = c.lines.map((l) => (l.product_id
          ? { product_id: l.product_id, qty: l.qty, unit_price_cents: l.price }
          : { name: l.name, qty: l.qty, unit_price_cents: l.price }));
        const result = await (c.mode === 'quick' ? this.eng.quickSale : this.eng.sale).call(this.eng, {
          lines, paid_cents: effective, customer, allow_loss: !!allow_loss, client_ref: c.ref,
        });
        this.lastMode = c.mode;
        await this.store.tx(['meta'], 'readwrite', (tx) => tx.put('meta', { key: 'last_sale_mode', value: c.mode }));
        this.cur = fresh(this.cat.uuid());
        this.undoStack = [];
        this.results = [];
        return { invoice: result.invoice, lines: result.lines, change_cents: paid - effective, state: this.state() };
      });
    }
  }

  const api = { SaleSession, evaluate, toUnits, format: { money, qty: trimmed }, lineTotal, MAX_PARKED };
  root.WeGo = root.WeGo || {};
  root.WeGo.sale = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
