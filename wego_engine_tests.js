/* wego_engine_tests.js — run with:  node wego_engine_tests.js */
'use strict';
const assert = require('node:assert/strict');
const schema = require('./wego_schema.js');
const { MemoryStore } = require('./wego_store.js');
const { Catalog } = require('./wego_catalog.js');
const { Engine } = require('./wego_engine.js');

let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

async function fresh() {
  let n = 0;
  const t0 = Date.parse('2026-11-20T08:00:00Z');
  const state = { day: '2026-11-20' };
  const store = new MemoryStore(schema);
  const cat = new Catalog(store, { deviceId: 'dev-1', now: () => new Date(t0 + (n += 1000)).toISOString(), uuid: () => 'id-' + (++n) });
  await cat.init();
  const eng = new Engine(store, cat, { dayOf: () => state.day });
  return { store, cat, eng, state };
}
async function rejectsWith(promise, code, check) {
  await assert.rejects(promise, (e) => { assert.equal(e.code, code); if (check) check(e); return true; });
}
const setSetting = (store, key, value) =>
  store.tx(['settings'], 'readwrite', (tx) => tx.put('settings', { key, value, updated_at: 'x' }));
const prod = (cat, category_id, name, sell, buy, qty) =>
  cat.createProduct({ category_id, name, sell_cents: sell, buy_cents: buy, qty });
const U = (n) => n * schema.qtyScale;   // units -> stored quantity
const ALI = { name: 'Ali', phone: '0612345678' };
const sellOne = (eng, p, qty, price, extra) =>
  eng.sale({ lines: [{ product_id: p.id, qty, unit_price_cents: price }], ...extra });

/* ---------- sales ---------- */
test('sale: totals, profit, stock, cash and invoice numbers (ammjjxxx)', async () => {
  const { cat, eng, state } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 1500, 1000, U(10));
  const r = await sellOne(eng, p, U(3), 1500);
  assert.equal(r.invoice.total_cents, 4500);
  assert.equal(r.invoice.cost_cents, 3000);
  assert.equal(r.invoice.profit_cents, 1500);
  assert.equal(r.invoice.paid_cents, 4500);
  assert.equal(r.invoice.due_cents, 0);
  assert.equal(r.invoice.number, '61120001');
  assert.equal((await cat.getProduct(p.id)).qty, U(7));
  assert.equal(await eng.cashBalance(), 4500);
  assert.equal((await sellOne(eng, p, U(1), 1500)).invoice.number, '61120002');
  state.day = '2026-11-21';
  assert.equal((await sellOne(eng, p, U(1), 1500)).invoice.number, '61121001');
});
test('sale: negotiated price keeps the list price in the line snapshot', async () => {
  const { cat, eng } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 1500, 1000, U(10));
  const r = await sellOne(eng, p, U(2), 1400);
  const l = r.lines[0];
  assert.equal(l.unit_price_cents, 1400); assert.equal(l.list_price_cents, 1500);
  assert.equal(l.unit_cost_cents, 1000); assert.equal(l.sku, 'E1'); assert.equal(l.category_id, 'E');
  assert.equal(r.invoice.profit_cents, 800);
});
test('sale below cost needs confirmation and writes nothing until confirmed', async () => {
  const { cat, eng } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 1500, 1000, U(10));
  await rejectsWith(sellOne(eng, p, U(1), 900), 'LOSS_NEEDS_CONFIRMATION', (e) => assert.deepEqual(e.details.line_nos, [1]));
  assert.equal((await cat.getProduct(p.id)).qty, U(10));
  assert.equal((await eng.dailyReport('2026-11-20')).sales_count, 0);
  const ok = await sellOne(eng, p, U(1), 900, { allow_loss: true });
  assert.equal(ok.invoice.profit_cents, -100);
});
test('stock may go negative (default); refused when the setting is off, with full rollback', async () => {
  const { store, cat, eng } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 1500, 1000, U(0));
  await sellOne(eng, p, U(2), 1500);
  assert.equal((await cat.getProduct(p.id)).qty, U(-2));
  await setSetting(store, 'allow_negative_stock', 0);
  const a = await prod(cat, 'E', 'A', 100, 50, U(5));
  const b = await prod(cat, 'E', 'B', 100, 50, U(1));
  await rejectsWith(eng.sale({ lines: [{ product_id: a.id, qty: U(2), unit_price_cents: 100 }, { product_id: b.id, qty: U(3), unit_price_cents: 100 }] }), 'INSUFFICIENT_STOCK');
  assert.equal((await cat.getProduct(a.id)).qty, U(5));
  assert.equal((await cat.getProduct(b.id)).qty, U(1));
});
test('credit sale: name and phone required, customer remembered across phone formats', async () => {
  const { cat, eng } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 1500, 1000, U(20));
  await rejectsWith(sellOne(eng, p, U(3), 1500, { paid_cents: 1000 }), 'PARTY_REQUIRED');
  await rejectsWith(sellOne(eng, p, U(3), 1500, { paid_cents: 1000, customer: { name: 'Ali', phone: '12' } }), 'INVALID_PHONE');
  const a = await sellOne(eng, p, U(3), 1500, { paid_cents: 1000, customer: ALI });
  assert.equal(a.invoice.due_cents, 3500);
  const b = await sellOne(eng, p, U(1), 1500, { paid_cents: 0, customer: { name: 'Ali', phone: '+212 612 345 678' } });
  assert.equal(b.invoice.party_id, a.invoice.party_id);
  const c = await sellOne(eng, p, U(1), 1500, { customer: { phone: '00212612345678' } });
  assert.equal(c.invoice.party_id, a.invoice.party_id);
  const debts = await eng.debtSummary('customer');
  assert.equal(debts.length, 1); assert.equal(debts[0].total_due_cents, 5000); assert.equal(debts[0].invoices, 2);
  await rejectsWith(sellOne(eng, p, U(1), 1500, { paid_cents: 2000 }), 'OVERPAID');
});
test('the same cart can never be saved twice (client_ref)', async () => {
  const { cat, eng } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 1500, 1000, U(10));
  const a = await sellOne(eng, p, U(1), 1500, { client_ref: 'cart-1' });
  const b = await sellOne(eng, p, U(1), 1500, { client_ref: 'cart-1' });
  assert.equal(b.duplicate, true); assert.equal(b.invoice.id, a.invoice.id);
  assert.equal((await cat.getProduct(p.id)).qty, U(9));
  assert.equal(await eng.cashBalance(), 1500);
});
test('external product: cost leaves the till, sale price comes in, no stock', async () => {
  const { eng } = await fresh();
  const r = await eng.sale({ lines: [{ external: { name: 'Vis spéciale', buy_cents: 3000 }, qty: U(1), unit_price_cents: 5000 }] });
  assert.equal(r.invoice.profit_cents, 2000);
  assert.equal(r.lines[0].is_external, 1); assert.equal(r.lines[0].product_id, null);
  assert.equal(await eng.cashBalance(), 2000);
});
test('invalid input is refused', async () => {
  const { cat, eng } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 1500, 1000, U(10));
  await rejectsWith(sellOne(eng, p, U(0), 1500), 'INVALID_NUMBER');
  await rejectsWith(sellOne(eng, p, 1.5, 1500), 'INVALID_NUMBER');
  await rejectsWith(eng.sale({ lines: [] }), 'EMPTY_CART');
  await rejectsWith(eng.sale({ lines: [{ qty: U(1), unit_price_cents: 100 }] }), 'INVALID_LINE');
  await rejectsWith(eng.sale({ lines: [{ product_id: 'ghost', qty: U(1), unit_price_cents: 100 }] }), 'PRODUCT_UNAVAILABLE');
  await rejectsWith(eng.sale({ lines: [{ product_id: p.id, qty: U(1), unit_price_cents: 0 }] }), 'INVALID_TOTAL');
});

/* ---------- quick sale ---------- */
test('quick sale: total only -> one generic line, flat 20% profit, no stock, cash in', async () => {
  const { eng } = await fresh();
  const r = await eng.quickSale({ total_cents: 50000 });
  assert.equal(r.lines[0].name, 'produit 1'); assert.equal(r.lines[0].is_generic, 1);
  assert.equal(r.invoice.profit_cents, 10000);
  assert.equal(r.invoice.has_detail, 0); assert.equal(r.invoice.profit_mode, 'estimated');
  assert.equal(await eng.cashBalance(), 50000);
});
test('quick sale: calculator lines (3x500 + 2x1000)', async () => {
  const { eng } = await fresh();
  const r = await eng.quickSale({ lines: [{ qty: U(3), unit_price_cents: 500 }, { qty: U(2), unit_price_cents: 1000 }] });
  assert.equal(r.invoice.total_cents, 3500);
  assert.deepEqual(r.lines.map((l) => l.name), ['produit 1', 'produit 2']);
  assert.equal(r.invoice.profit_cents, 700);
});
test('quick sale: flat percentage follows the settings', async () => {
  const { store, eng } = await fresh();
  await setSetting(store, 'quick_sale_profit_pct', 10);
  assert.equal((await eng.quickSale({ total_cents: 50000 })).invoice.profit_cents, 5000);
});
test('quick sale detail: total never changes, real cost replaces the percentage, stock goes out', async () => {
  const { cat, eng } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 1500, 1000, U(10));
  const q = await eng.quickSale({ lines: [{ qty: U(1), unit_price_cents: 1500 }, { qty: U(1), unit_price_cents: 2000 }] });
  const [l1, l2] = q.lines;
  const mid = await eng.detailQuickLine(q.invoice.id, l1.id, { product_id: p.id });
  assert.equal(mid.invoice.total_cents, 3500);
  assert.equal(mid.invoice.cost_cents, 1000 + 1600);
  assert.equal(mid.invoice.profit_mode, 'mixed'); assert.equal(mid.invoice.has_detail, 0);
  assert.equal((await cat.getProduct(p.id)).qty, U(9));
  const end = await eng.detailQuickLine(q.invoice.id, l2.id, { external: { name: 'Câble', buy_cents: 1200 } });
  assert.equal(end.invoice.profit_cents, 3500 - 2200);
  assert.equal(end.invoice.has_detail, 1); assert.equal(end.invoice.profit_mode, 'real');
  assert.equal(await eng.cashBalance(), 3500 - 1200);
  await rejectsWith(eng.detailQuickLine(q.invoice.id, l1.id, { product_id: p.id }), 'NOT_GENERIC');
  assert.deepEqual(await eng.checkIntegrity(), []);
});
test('quick sale detail: loss needs confirmation; a returned invoice cannot be detailed', async () => {
  const { cat, eng } = await fresh();
  const dear = await prod(cat, 'E', 'Cher', 3000, 2000, U(5));
  const q = await eng.quickSale({ lines: [{ qty: U(1), unit_price_cents: 1500 }, { qty: U(1), unit_price_cents: 1000 }] });
  await rejectsWith(eng.detailQuickLine(q.invoice.id, q.lines[0].id, { product_id: dear.id }), 'LOSS_NEEDS_CONFIRMATION');
  assert.equal((await cat.getProduct(dear.id)).qty, U(5));
  await eng.detailQuickLine(q.invoice.id, q.lines[0].id, { product_id: dear.id }, { allow_loss: true });
  await eng.returnFromCustomer({ original_invoice_id: q.invoice.id, items: [{ line_id: q.lines[1].id, qty: U(1) }] });
  await rejectsWith(eng.detailQuickLine(q.invoice.id, q.lines[1].id, { external: { name: 'x', buy_cents: 1 } }), 'ALREADY_RETURNED');
});

/* ---------- purchases ---------- */
test('purchase: weighted average cost, stock in, cash out', async () => {
  const { cat, eng } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 3000, 1000, U(10));
  const r = await eng.purchase({ lines: [{ product_id: p.id, qty: U(10), unit_cost_cents: 2000 }] });
  const after = await cat.getProduct(p.id);
  assert.equal(after.qty, U(20)); assert.equal(after.buy_cents, 1500);
  assert.equal(r.invoice.total_cents, 20000);
  assert.equal(await eng.cashBalance(), -20000);
});
test('purchase: "last" cost method and empty/negative stock take the new cost', async () => {
  const { store, cat, eng } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 3000, 1000, U(10));
  await setSetting(store, 'cost_method', 'last');
  await eng.purchase({ lines: [{ product_id: p.id, qty: U(10), unit_cost_cents: 2000 }] });
  assert.equal((await cat.getProduct(p.id)).buy_cents, 2000);
  await setSetting(store, 'cost_method', 'wac');
  const z = await prod(cat, 'S', 'Peinture', 5000, 100, U(-3));
  await eng.purchase({ lines: [{ product_id: z.id, qty: U(5), unit_cost_cents: 3000 }] });
  assert.equal((await cat.getProduct(z.id)).buy_cents, 3000);
});
test('purchase: new product created on the fly, supplier debt when partly paid', async () => {
  const { cat, eng } = await fresh();
  const lines = [{ new: { category_id: 'M', name: 'Rabot', sell_cents: 9000 }, qty: U(2), unit_cost_cents: 6000 }];
  await rejectsWith(eng.purchase({ lines, paid_cents: 5000 }), 'PARTY_REQUIRED');
  assert.equal(await cat.findBySku('m1'), null);
  const r = await eng.purchase({ lines, paid_cents: 5000, supplier: { name: 'Bricolux', phone: '0522334455' } });
  assert.equal(r.invoice.due_cents, 7000);
  const m1 = await cat.findBySku('m1');
  assert.equal(m1.qty, U(2)); assert.equal(m1.buy_cents, 6000);
  assert.equal((await eng.debtSummary('supplier'))[0].total_due_cents, 7000);
});

/* ---------- debts ---------- */
test('payments are applied to the oldest invoices first; overpayment refused', async () => {
  const { cat, eng } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 1000, 500, U(50));
  const a = await sellOne(eng, p, U(1), 1000, { paid_cents: 0, customer: ALI });
  const b = await sellOne(eng, p, U(2), 1000, { paid_cents: 0, customer: ALI });
  const c = await sellOne(eng, p, U(3), 1000, { paid_cents: 0, customer: ALI });
  const customerId = a.invoice.party_id;
  const r = await eng.receivePayment({ customer_id: customerId, amount_cents: 2500 });
  assert.equal(r.remaining_debt_cents, 3500);
  const due = async (inv) => (await eng.getInvoice(inv.invoice.id)).invoice.due_cents;
  assert.deepEqual([await due(a), await due(b), await due(c)], [0, 500, 3000]);
  await rejectsWith(eng.receivePayment({ customer_id: customerId, amount_cents: 4000 }), 'OVERPAYMENT');
  assert.equal(await eng.cashBalance(), 2500);
  assert.equal((await eng.partyInvoices('customer', customerId)).length, 3);
  assert.deepEqual(await eng.checkIntegrity(), []);
});
test('supplier payments reduce what we owe and leave the till', async () => {
  const { cat, eng } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 3000, 1000, U(0));
  const r = await eng.purchase({ lines: [{ product_id: p.id, qty: U(10), unit_cost_cents: 1000 }], paid_cents: 4000, supplier: { name: 'F', phone: '0522334455' } });
  await eng.paySupplier({ supplier_id: r.invoice.party_id, amount_cents: 6000 });
  assert.equal((await eng.debtSummary('supplier')).length, 0);
  assert.equal(await eng.cashBalance(), -10000);
});

/* ---------- returns ---------- */
test('customer return: refund reduces the debt first, then the till; stock comes back', async () => {
  const { cat, eng } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 1500, 1000, U(10));
  const s = await sellOne(eng, p, U(3), 1500, { paid_cents: 1000, customer: ALI });
  const lineId = s.lines[0].id;
  const r1 = await eng.returnFromCustomer({ original_invoice_id: s.invoice.id, items: [{ line_id: lineId, qty: U(2) }] });
  assert.equal(r1.refund_cents, 3000); assert.equal(r1.debt_reduced_cents, 3000); assert.equal(r1.cash_cents, 0);
  assert.equal(r1.invoice.profit_cents, -1000);
  assert.equal((await eng.getInvoice(s.invoice.id)).invoice.due_cents, 500);
  assert.equal((await cat.getProduct(p.id)).qty, U(9));
  const r2 = await eng.returnFromCustomer({ original_invoice_id: s.invoice.id, items: [{ line_id: lineId, qty: U(1) }] });
  assert.equal(r2.debt_reduced_cents, 500); assert.equal(r2.cash_cents, 1000);
  assert.equal(await eng.cashBalance(), 0);
  await rejectsWith(eng.returnFromCustomer({ original_invoice_id: s.invoice.id, items: [{ line_id: lineId, qty: U(1) }] }), 'RETURN_EXCEEDS');
  assert.deepEqual(await eng.checkIntegrity(), []);
});
test('customer return of a paid sale goes out of the till', async () => {
  const { cat, eng } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 1500, 1000, U(10));
  const s = await sellOne(eng, p, U(3), 1500);
  const r = await eng.returnFromCustomer({ original_invoice_id: s.invoice.id, items: [{ line_id: s.lines[0].id, qty: U(1) }] });
  assert.equal(r.cash_cents, 1500);
  assert.equal(await eng.cashBalance(), 3000);
});
test('return of a modified product: blocked until the user chooses (nothing written meanwhile)', async () => {
  const { cat, eng } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 1500, 1000, U(10));
  const other = await prod(cat, 'E', 'Prise 16A', 1800, 1000, U(0));
  const s = await sellOne(eng, p, U(2), 1500);
  await cat.updateProduct(p.id, { sell_cents: 1800 });
  const item = { line_id: s.lines[0].id, qty: U(1) };
  await rejectsWith(eng.returnFromCustomer({ original_invoice_id: s.invoice.id, items: [item] }), 'RETURN_NEEDS_RESOLUTION', (e) => {
    assert.equal(e.details.items[0].status, 'changed');
    assert.equal(e.details.items[0].diffs[0].field, 'sell_cents');
  });
  assert.equal((await cat.getProduct(p.id)).qty, U(8));
  assert.equal((await eng.getInvoice(s.invoice.id)).lines[0].returned_qty, 0);
  const adapted = await eng.returnFromCustomer({ original_invoice_id: s.invoice.id, items: [{ ...item, resolution: { action: 'adapt', product_id: other.id } }] });
  assert.equal((await cat.getProduct(other.id)).qty, U(1));
  assert.equal(adapted.refund_cents, 1500);
  const none = await eng.returnFromCustomer({ original_invoice_id: s.invoice.id, items: [{ ...item, resolution: { action: 'no_stock' } }] });
  assert.equal(none.refund_cents, 1500);
  assert.equal((await cat.getProduct(p.id)).qty, U(8));
  assert.deepEqual(await eng.checkIntegrity(), []);
});
test('return of a deleted product: re-insert gives it back its SKU', async () => {
  const { cat, eng } = await fresh();
  const p = await prod(cat, 'P', 'Vanne', 9000, 6000, U(5));
  const s = await sellOne(eng, p, U(2), 9000);
  await cat.softDelete(p.id);
  const item = { line_id: s.lines[0].id, qty: U(2) };
  await rejectsWith(eng.returnFromCustomer({ original_invoice_id: s.invoice.id, items: [item] }), 'RETURN_NEEDS_RESOLUTION', (e) => {
    assert.equal(e.details.items[0].status, 'deleted'); assert.equal(e.details.items[0].reinsert_sku, 'P1');
  });
  const r = await eng.returnFromCustomer({ original_invoice_id: s.invoice.id, items: [{ ...item, resolution: { action: 'reinsert' } }] });
  const back = await cat.findBySku('p1');
  assert.equal(back.name, 'Vanne'); assert.equal(back.qty, U(2)); assert.equal(back.sell_cents, 9000); assert.equal(back.buy_cents, 6000);
  assert.equal(r.refund_cents, 18000);
  assert.deepEqual(await eng.checkIntegrity(), []);
});
test('return of an external or generic line never touches the stock', async () => {
  const { eng } = await fresh();
  const s = await eng.sale({ lines: [{ external: { name: 'Vis', buy_cents: 100 }, qty: U(2), unit_price_cents: 300 }] });
  const r = await eng.returnFromCustomer({ original_invoice_id: s.invoice.id, items: [{ line_id: s.lines[0].id, qty: U(1) }] });
  assert.equal(r.refund_cents, 300);
  const q = await eng.quickSale({ total_cents: 1000 });
  assert.equal((await eng.returnFromCustomer({ original_invoice_id: q.invoice.id, items: [{ line_id: q.lines[0].id, qty: U(1) }] })).refund_cents, 1000);
});
test('supplier return: stock goes out, refund reduces our debt first then comes into the till', async () => {
  const { cat, eng } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 3000, 1000, U(0));
  const b = await eng.purchase({ lines: [{ product_id: p.id, qty: U(10), unit_cost_cents: 1000 }], paid_cents: 4000, supplier: { name: 'F', phone: '0522334455' } });
  const lineId = b.lines[0].id;
  const r1 = await eng.returnToSupplier({ original_invoice_id: b.invoice.id, items: [{ line_id: lineId, qty: U(4) }] });
  assert.equal(r1.debt_reduced_cents, 4000); assert.equal(r1.cash_cents, 0);
  assert.equal((await cat.getProduct(p.id)).qty, U(6));
  const r2 = await eng.returnToSupplier({ original_invoice_id: b.invoice.id, items: [{ line_id: lineId, qty: U(3) }] });
  assert.equal(r2.debt_reduced_cents, 2000); assert.equal(r2.cash_cents, 1000);
  assert.equal((await eng.getInvoice(b.invoice.id)).invoice.due_cents, 0);
  assert.equal(await eng.cashBalance(), -4000 + 1000);
  assert.deepEqual(await eng.checkIntegrity(), []);
});
test('return: wrong invoice type or foreign line is refused', async () => {
  const { cat, eng } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 1500, 1000, U(10));
  const s = await sellOne(eng, p, U(1), 1500);
  const t = await sellOne(eng, p, U(1), 1500);
  await rejectsWith(eng.returnToSupplier({ original_invoice_id: s.invoice.id, items: [{ line_id: s.lines[0].id, qty: U(1) }] }), 'INVALID_ORIGINAL');
  await rejectsWith(eng.returnFromCustomer({ original_invoice_id: s.invoice.id, items: [{ line_id: t.lines[0].id, qty: U(1) }] }), 'NOT_FOUND');
});

/* ---------- cash, expenses, inventory ---------- */
test('expenses, deposits, withdrawals and the closing count', async () => {
  const { eng } = await fresh();
  const e = await eng.addExpense({ label: 'Loyer', amount_cents: 5000 });
  assert.equal(e.invoice.type, 'expense'); assert.equal(e.invoice.number, '61120001');
  await eng.cashDeposit({ amount_cents: 20000, note: 'fond de caisse' });
  await eng.cashWithdrawal({ amount_cents: 1000, note: 'propriétaire' });
  assert.equal(await eng.cashBalance(), 14000);
  await rejectsWith(eng.addExpense({ label: ' ', amount_cents: 100 }), 'INVALID_NAME');
  await rejectsWith(eng.addExpense({ label: 'x', amount_cents: 0 }), 'INVALID_NUMBER');
  const c = await eng.closeCash({ counted_cents: 13500 });
  assert.equal(c.expected_cents, 14000); assert.equal(c.diff_cents, -500);
  assert.equal(await eng.cashBalance(), 13500);
  assert.equal((await eng.dailyReport('2026-11-20')).expenses_cents, 5000);
});
test('inventory by category: differences recorded, stock set to the count, shortage valued', async () => {
  const { cat, eng, store } = await fresh();
  const a = await prod(cat, 'E', 'A', 1500, 1000, U(10));
  const b = await prod(cat, 'E', 'B', 3000, 2000, U(5));
  const m = await prod(cat, 'M', 'M', 100, 50, U(1));
  const sheet = await eng.countSheet('E');
  assert.deepEqual(sheet.map((r) => [r.sku, r.expected_qty]), [['E1', U(10)], ['E2', U(5)]]);
  const r = await eng.applyCount({ category_id: 'E', counts: [{ product_id: a.id, counted_qty: U(8) }, { product_id: b.id, counted_qty: U(6) }] });
  assert.equal(r.shortage_cost_cents, 2000);
  assert.deepEqual(r.lines.map((l) => l.diff_qty), [U(-2), U(1)]);
  assert.equal((await cat.getProduct(a.id)).qty, U(8)); assert.equal((await cat.getProduct(b.id)).qty, U(6));
  const moves = await store.tx(['stock_movements'], 'readonly', (tx) => tx.byIndex('stock_movements', 'ref', r.count.id));
  assert.equal(moves.length, 2);
  await rejectsWith(eng.applyCount({ category_id: 'E', counts: [{ product_id: m.id, counted_qty: U(1) }] }), 'PRODUCT_UNAVAILABLE');
  await rejectsWith(eng.applyCount({ category_id: 'E', counts: [{ product_id: a.id, counted_qty: U(1) }, { product_id: a.id, counted_qty: U(2) }] }), 'DUPLICATE_ITEM');
  assert.deepEqual(await eng.checkIntegrity(), []);
});

/* ---------- reports ---------- */
test('category report: sales minus returns per category; migration never rewrites the past', async () => {
  const { cat, eng, state } = await fresh();
  const e1 = await prod(cat, 'E', 'Prise', 1500, 1000, U(20));
  const m1 = await prod(cat, 'M', 'Rabot', 9000, 6000, U(5));
  const s1 = await eng.sale({ lines: [{ product_id: e1.id, qty: U(2), unit_price_cents: 1500 }, { product_id: m1.id, qty: U(1), unit_price_cents: 9000 }] });
  await eng.returnFromCustomer({ original_invoice_id: s1.invoice.id, items: [{ line_id: s1.lines[0].id, qty: U(1) }] });
  state.day = '2026-11-21';
  await cat.moveCategory(e1.id, 'S');
  await sellOne(eng, e1, U(1), 1500);
  const rows = await eng.categoryReport({ from: '2026-11-20', to: '2026-11-21' });
  const get = (id) => rows.find((r) => r.category_id === id);
  assert.deepEqual([get('E').revenue_cents, get('E').profit_cents, get('E').qty], [1500, 500, U(1)]);
  assert.deepEqual([get('M').revenue_cents, get('M').profit_cents], [9000, 3000]);
  assert.deepEqual([get('S').revenue_cents, get('S').profit_cents], [1500, 500]);
  const only21 = await eng.categoryReport({ from: '2026-11-21', to: '2026-11-21' });
  assert.deepEqual(only21.map((r) => r.category_id), ['S']);
});
test('daily report: sales, returns, profit, quick sales without detail', async () => {
  const { cat, eng } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 1500, 1000, U(20));
  const s = await sellOne(eng, p, U(4), 1500);
  await eng.returnFromCustomer({ original_invoice_id: s.invoice.id, items: [{ line_id: s.lines[0].id, qty: U(1) }] });
  await eng.quickSale({ total_cents: 10000 });
  await eng.addExpense({ label: 'Transport', amount_cents: 500 });
  const d = await eng.dailyReport('2026-11-20');
  assert.equal(d.sales_cents, 16000); assert.equal(d.sales_count, 2);
  assert.equal(d.returns_cents, 1500); assert.equal(d.net_sales_cents, 14500);
  assert.equal(d.profit_cents, 2000 - 500 + 2000);
  assert.equal(d.undetailed_quick_sales, 1); assert.equal(d.expenses_cents, 500);
});

/* ---------- sync helpers, atomicity, integrity ---------- */
test('duplicate invoice numbers (after a sync) get -1, -2', async () => {
  const { store, cat, eng } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 1500, 1000, U(20));
  const a = await sellOne(eng, p, U(1), 1500);
  for (const id of ['remote-1', 'remote-2']) {
    await store.tx(['invoices'], 'readwrite', async (tx) => tx.put('invoices', { ...(await tx.get('invoices', a.invoice.id)), id, at: '2027-01-01T00:00:00.000Z' }));
  }
  const changes = await eng.dedupeInvoiceNumbers();
  assert.deepEqual(changes.map((c) => c.to).sort(), ['61120001-1', '61120001-2']);
  assert.equal((await eng.getInvoice(a.invoice.id)).invoice.number, '61120001');
  assert.deepEqual(await eng.dedupeInvoiceNumbers(), []);
});
test('a failure in the middle of an operation leaves no trace', async () => {
  const { cat, eng, store } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 1500, 1000, U(10));
  const before = await store.tx(['stock_movements', 'invoices', 'cash_entries'], 'readonly', async (tx) =>
    [(await tx.all('stock_movements')).length, (await tx.all('invoices')).length, (await tx.all('cash_entries')).length]);
  await rejectsWith(eng.sale({ lines: [{ product_id: p.id, qty: U(1), unit_price_cents: 1500 }, { product_id: 'ghost', qty: U(1), unit_price_cents: 100 }] }), 'PRODUCT_UNAVAILABLE');
  await rejectsWith(eng.purchase({ lines: [{ product_id: p.id, qty: U(1), unit_cost_cents: 100 }, { new: { category_id: 'ZZ', name: 'x', sell_cents: 1 }, qty: U(1), unit_cost_cents: 1 }] }), 'UNKNOWN_CATEGORY');
  const after = await store.tx(['stock_movements', 'invoices', 'cash_entries'], 'readonly', async (tx) =>
    [(await tx.all('stock_movements')).length, (await tx.all('invoices')).length, (await tx.all('cash_entries')).length]);
  assert.deepEqual(after, before);
  assert.equal((await cat.getProduct(p.id)).qty, U(10));
});
test('concurrent sales never share a number or lose stock', async () => {
  const { cat, eng } = await fresh();
  const p = await prod(cat, 'E', 'Prise', 1500, 1000, U(10));
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => sellOne(eng, p, U(1), 1500)));
  assert.equal(new Set(rs.map((r) => r.invoice.number)).size, 5);
  assert.equal((await cat.getProduct(p.id)).qty, U(5));
  assert.deepEqual(await eng.checkIntegrity(), []);
});
test('integrity check: healthy after a mixed day, and it catches tampering', async () => {
  const { cat, eng, store } = await fresh();
  const e = await prod(cat, 'E', 'Prise', 1500, 1000, U(10));
  const m = await prod(cat, 'M', 'Rabot', 9000, 6000, U(3));
  await eng.purchase({ lines: [{ product_id: e.id, qty: U(5), unit_cost_cents: 1200 }], paid_cents: 3000, supplier: { name: 'F', phone: '0522334455' } });
  const s = await eng.sale({ lines: [{ product_id: e.id, qty: U(4), unit_price_cents: 1500 }, { product_id: m.id, qty: U(1), unit_price_cents: 9000 }], paid_cents: 5000, customer: ALI });
  await eng.returnFromCustomer({ original_invoice_id: s.invoice.id, items: [{ line_id: s.lines[1].id, qty: U(1) }] });
  await eng.quickSale({ total_cents: 7000 });
  await eng.receivePayment({ customer_id: s.invoice.party_id, amount_cents: 1000 });
  await eng.applyCount({ category_id: 'E', counts: [{ product_id: e.id, counted_qty: U(10) }] });
  assert.deepEqual(await eng.checkIntegrity(), []);
  await store.tx(['products'], 'readwrite', async (tx) => { const p = await tx.get('products', e.id); p.qty += 1; await tx.put('products', p); });
  assert.equal((await eng.checkIntegrity()).length, 1);
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed += 1; console.log('  ok   ' + name); }
    catch (e) { failed += 1; console.log('  FAIL ' + name + '\n       ' + (e && (e.stack || e.message)).split('\n').slice(0, 4).join('\n       ')); }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
