/* wego_sale_tests.js — run with:  node wego_sale_tests.js
   Each test is an example from the approved behaviour sheet: keys -> expected result. */
'use strict';
const assert = require('node:assert/strict');
const schema = require('./wego_schema.js');
const { MemoryStore } = require('./wego_store.js');
const { Catalog } = require('./wego_catalog.js');
const { Engine } = require('./wego_engine.js');
const { SaleSession, evaluate, toUnits, format } = require('./wego_sale.js');

let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
const U = (n) => n * schema.qtyScale;

async function fresh() {
  let n = 0;
  const t0 = Date.parse('2026-11-20T08:00:00Z');
  const store = new MemoryStore(schema);
  const cat = new Catalog(store, { deviceId: 'dev-1', now: () => new Date(t0 + (n += 1000)).toISOString(), uuid: () => 'id-' + (++n) });
  await cat.init();
  const eng = new Engine(store, cat, { dayOf: () => '2026-11-20' });
  const sale = new SaleSession({ store, catalog: cat, engine: eng });
  return { store, cat, eng, sale };
}
const keys = async (s, text) => { let st; for (const ch of text) st = await s.press(ch); return st; };
async function rejectsWith(promise, code, check) {
  await assert.rejects(promise, (e) => { assert.equal(e.code, code); if (check) check(e); return true; });
}
const quick = async () => { const f = await fresh(); await f.sale.selectMode('quick'); return f; };
const audit = (store, action) => store.tx(['audit_log'], 'readonly', async (tx) => (await tx.all('audit_log')).filter((a) => a.action === action));
const ALI = { name: 'Ali', phone: '0612345678' };

/* ---------- 0. modes ---------- */
test('keys do nothing until a mode is chosen', async () => {
  const { sale } = await fresh();
  const st = await sale.press('7');
  assert.equal(st.hint, 'CHOOSE_MODE'); assert.equal(st.expr, ''); assert.equal(st.mode, null);
});
test('the mode is locked while the invoice has lines; unlocked after payment', async () => {
  const { sale } = await quick();
  await keys(sale, '10=');
  await rejectsWith(sale.selectMode('detailed'), 'MODE_LOCKED');
  await rejectsWith(sale.selectMode('bogus'), 'INVALID_MODE');
  await sale.confirmQuantities();
  const r = await sale.checkout();
  assert.equal(r.state.mode, null); assert.equal(r.state.lines.length, 0); assert.equal(r.state.expr, '');
  await sale.selectMode('detailed');
});

/* ---------- 1. calculator ---------- */
test('calculator: precedence and commercial percent', async () => {
  const { sale } = await fresh();
  await sale.selectMode('calc');
  const run = async (text) => { await sale.press('C'); return (await keys(sale, text)).result; };
  assert.equal(await run('2+3×4='), '14.00');
  assert.equal(await run('100−10%='), '90.00');
  assert.equal(await run('200+10%='), '220.00');
  assert.equal(await run('50×10%='), '5.00');
  assert.equal(await run('10÷4='), '2.50');
  assert.equal(await run('.5+.25='), '0.75');
  assert.equal(await run('2*3='), '6.00');
  assert.equal(await run('9-4='), '5.00');
  assert.equal(await run('9/2='), '4.50');
});
test('calculator: division by zero is reported, not fatal', async () => {
  const { sale } = await fresh();
  await sale.selectMode('calc');
  const st = await keys(sale, '10÷0=');
  assert.equal(st.hint, 'DIV0'); assert.equal(st.result, null);
  assert.equal((await sale.press('C')).expr, '');
});
test('calculator: two decimals max, no leading zeros, backspace and clear', async () => {
  const { sale } = await fresh();
  await sale.selectMode('calc');
  assert.equal((await keys(sale, '1.234')).expr, '1.23');
  await sale.press('C');
  assert.equal((await keys(sale, '007')).expr, '7');
  assert.equal((await sale.press('⌫')).expr, '');
  await keys(sale, '12');
  assert.equal((await sale.press('⌫')).expr, '1');
  assert.equal((await sale.press('C')).expr, '');
});
test('calculator: a digit after "=" starts over, an operator continues; no invoice lines', async () => {
  const { sale } = await fresh();
  await sale.selectMode('calc');
  await keys(sale, '2+3=');
  assert.equal((await keys(sale, '×2=')).result, '10.00');
  await keys(sale, '2+3=');
  const st = await sale.press('7');
  assert.equal(st.expr, '7'); assert.equal(st.result, null); assert.equal(st.lines.length, 0);
});
test('evaluate(): same engine, direct calls', () => {
  assert.equal(evaluate('2+3×4'), 14);
  assert.equal(evaluate('1+'), 1);
  assert.throws(() => evaluate('×3'), (e) => e.code === 'SYNTAX');
});

/* ---------- 2. quick invoice ---------- */
test('quick: 12+32×2+5×4= -> (12×1)(32×2)(5×4), total 96.00', async () => {
  const { sale } = await quick();
  const st = await keys(sale, '12+32×2+5×4=');
  assert.deepEqual(st.lines.map((l) => [l.price, l.qty]), [[1200, 100], [3200, 200], [500, 400]]);
  assert.equal(st.total, 9600);
  assert.deepEqual(st.lines.map((l) => l.name), ['produit 1', 'produit 2', 'produit 3']);
  assert.equal(st.needs_confirm, true);
});
test('quick: decimal prices and quantities, rounding at each line', async () => {
  const { sale } = await quick();
  assert.equal((await keys(sale, '45.5×2.5=')).total, 11375);
  await sale.clearAll({ confirmed: true }); await sale.selectMode('quick');
  assert.equal((await keys(sale, '3.33×0.5=')).total, 167);
});
test('quick: typing continues after "=" and adds lines', async () => {
  const { sale } = await quick();
  await keys(sale, '12+32×2=');
  const st = await keys(sale, '+10=');
  assert.equal(st.lines.length, 3); assert.equal(st.total, 1200 + 6400 + 1000);
});
test('quick: a term with − ÷ % or several × is calculated first, quantity 1', async () => {
  const { sale } = await quick();
  const st = await keys(sale, '100−10%+3×4−1=');
  assert.deepEqual(st.lines.map((l) => [l.price, l.qty]), [[9000, 100], [1100, 100]]);
});
test('quick: invalid terms and trailing operators', async () => {
  const { sale } = await quick();
  const bad = await keys(sale, '5×0=');
  assert.equal(bad.hint, 'INVALID_EXPRESSION'); assert.equal(bad.lines.length, 0);
  await sale.press('C');
  const ok = await keys(sale, '5+=');
  assert.equal(ok.lines.length, 1); assert.equal(ok.total, 500);
});
test('quick: swap price and quantity keeps the total; recall puts the line back on the keypad', async () => {
  const { sale } = await quick();
  await keys(sale, '32×2=');
  const sw = await sale.swapLine(0);
  assert.deepEqual([sw.lines[0].price, sw.lines[0].qty, sw.total, sw.lines[0].confirmed], [200, 3200, 6400, true]);
  await sale.swapLine(0);
  const rc = await sale.recallLine(0);
  assert.equal(rc.expr, '32×2'); assert.equal(rc.lines.length, 0);
  await sale.press('C');
  await keys(sale, '12=');
  assert.equal((await sale.recallLine(0)).expr, '12');
});
test('quick: removing a line renumbers the generic names', async () => {
  const { sale } = await quick();
  await keys(sale, '1+2+3=');
  const st = await sale.removeLine(0);
  assert.deepEqual(st.lines.map((l) => l.name), ['produit 1', 'produit 2']);
  assert.deepEqual(st.lines.map((l) => l.price), [200, 300]);
});
test('quick: undo goes back one line operation at a time', async () => {
  const { sale } = await quick();
  await keys(sale, '10='); await keys(sale, '20=');
  assert.equal((await sale.undo()).lines.length, 1);
  assert.equal((await sale.undo()).lines.length, 0);
  assert.equal((await sale.undo()).hint, 'NOTHING_TO_UNDO');
});
test('quick: quantities must be confirmed before payment', async () => {
  const { sale } = await quick();
  await keys(sale, '10+20=');
  await rejectsWith(sale.checkout(), 'NEEDS_CONFIRM');
  await sale.confirmQuantities();
  assert.equal((await sale.checkout()).invoice.total_cents, 3000);
});
test('quick: paid less than the total needs name and phone, and records the debt', async () => {
  const { sale, eng } = await quick();
  await keys(sale, '10+20='); await sale.confirmQuantities();
  await rejectsWith(sale.checkout({ paid_cents: 2000 }), 'PARTY_REQUIRED');
  await rejectsWith(sale.checkout({ paid_cents: 2000, customer: { name: 'Ali' } }), 'PARTY_REQUIRED');
  assert.equal(sale.state().lines.length, 2);           // nothing was lost by the refusals
  const r = await sale.checkout({ paid_cents: 2000, customer: ALI });
  assert.equal(r.invoice.due_cents, 1000); assert.equal(r.change_cents, 0);
  assert.equal(r.invoice.type, 'quick_sale'); assert.equal(r.invoice.has_detail, 0); assert.equal(r.invoice.profit_mode, 'estimated');
  assert.equal(r.invoice.profit_cents, 600);
  assert.equal(await eng.cashBalance(), 2000);
});
test('quick: paid more than the total -> only the total enters the till, the change is shown', async () => {
  const { sale, eng } = await quick();
  await keys(sale, '10+20='); await sale.confirmQuantities();
  const r = await sale.checkout({ paid_cents: 5000 });
  assert.equal(r.change_cents, 2000); assert.equal(r.invoice.paid_cents, 3000); assert.equal(r.invoice.due_cents, 0);
  assert.equal(await eng.cashBalance(), 3000);
});
test('two taps on "pay" give one invoice', async () => {
  const { sale, eng } = await quick();
  await keys(sale, '10='); await sale.confirmQuantities();
  const res = await Promise.allSettled([sale.checkout(), sale.checkout()]);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await eng.dailyReport('2026-11-20')).sales_count, 1);
});

/* ---------- 3. detailed invoice ---------- */
async function detailed() {
  const f = await fresh();
  const mk = (sku, name, sell, buy, units) => f.cat.createProduct({ sku, name, sell_cents: sell, buy_cents: buy, qty: U(units) });
  f.e4 = await mk('E4', 'Prise', 1500, 1000, 10);
  f.e40 = await mk('E40', 'Fiche', 300, 100, 10);
  f.e5 = await mk('E5', 'Câble', 800, 500, 10);
  f.d4 = await mk('4', 'Clou', 50, 20, 100);
  f.d40 = await mk('40', 'Vis', 70, 30, 100);
  await f.sale.selectMode('detailed');
  return f;
}
test('detailed: letter + digits search by SKU, exact match first', async () => {
  const { sale } = await detailed();
  await sale.pickCategory('E');
  const st = await sale.press('4');
  assert.deepEqual(st.results.map((r) => r.sku), ['E4', 'E40']);
  assert.deepEqual([st.results[0].name, st.results[0].price, st.results[0].qty, st.results[0].buy], ['Prise', 1500, U(10), 1000]);
});
test('detailed: digits alone search the general droguerie; browsing a category; backspace removes the letter', async () => {
  const { sale } = await detailed();
  assert.deepEqual((await keys(sale, '4')).results.map((r) => r.sku), ['4', '40']);
  await sale.press('C');
  assert.deepEqual((await sale.pickCategory('E')).results.map((r) => r.sku), ['E4', 'E5', 'E40']);
  const st = await sale.press('⌫');
  assert.equal(st.query.letter, ''); assert.deepEqual(st.results, []);
  assert.deepEqual((await sale.pickCategory('#')).results.map((r) => r.sku), ['4', '40']);
});
test('detailed: operators are ignored, products only work in detailed mode', async () => {
  const { sale, e4 } = await detailed();
  const st = await sale.press('+');
  assert.equal(st.expr, ''); assert.equal(st.lines.length, 0);
  const f = await quick();
  assert.equal((await f.sale.addProduct('x')).hint, 'NOT_AVAILABLE');
  assert.ok(e4);
});
test('detailed: add, merge, step, edit price and quantity', async () => {
  const { sale, e4 } = await detailed();
  await sale.addProduct(e4.id);
  assert.deepEqual(sale.state().lines.map((l) => [l.qty, l.price]), [[100, 1500]]);
  assert.equal((await sale.addProduct(e4.id)).lines[0].qty, 200);
  assert.equal((await sale.stepQty(0, 1)).lines[0].qty, 300);
  const min = await sale.stepQty(0, -5);
  assert.equal(min.hint, 'MIN_QTY'); assert.equal(min.lines[0].qty, 300);
  const st = await sale.setLine(0, { qty: 250, price: 1400 });
  assert.equal(st.total, 3500);
  await rejectsWith(sale.setLine(0, { qty: 0 }), 'INVALID_NUMBER');
  await rejectsWith(sale.setLine(0, { price: 1.5 }), 'INVALID_NUMBER');
  assert.equal((await sale.undo()).lines[0].qty, 300);
});
test('detailed: payment takes decimal quantities out of the stock, profit uses the real cost', async () => {
  const { sale, cat, eng, e4 } = await detailed();
  await sale.addProduct(e4.id);
  await sale.setLine(0, { qty: 250, price: 1400 });
  const r = await sale.checkout();
  assert.equal(r.invoice.type, 'sale'); assert.equal(r.invoice.total_cents, 3500);
  assert.equal(r.invoice.profit_cents, 3500 - 2500);
  assert.equal((await cat.getProduct(e4.id)).qty, U(10) - 250);
  assert.deepEqual(await eng.checkIntegrity(), []);
  assert.equal(r.state.mode, null);
});
test('detailed: selling below cost asks for confirmation and loses nothing meanwhile', async () => {
  const { sale, e4 } = await detailed();
  await sale.addProduct(e4.id);
  await sale.setLine(0, { price: 900 });
  await rejectsWith(sale.checkout(), 'LOSS_NEEDS_CONFIRMATION', (e) => assert.deepEqual(e.details.line_nos, [1]));
  assert.equal(sale.state().lines.length, 1);
  assert.equal((await sale.checkout({ allow_loss: true })).invoice.profit_cents, -100);
});
test('detailed: stock may go negative and the unpaid part becomes a debt', async () => {
  const { sale, cat, e5 } = await detailed();
  await sale.addProduct(e5.id);
  await sale.setLine(0, { qty: U(12) });
  const r = await sale.checkout({ paid_cents: 5000, customer: ALI });
  assert.equal(r.invoice.total_cents, 9600); assert.equal(r.invoice.due_cents, 4600);
  assert.equal((await cat.getProduct(e5.id)).qty, U(-2));
});

/* ---------- 4. parking ---------- */
test('parking: badges 1 and 2, no invoice exists until payment', async () => {
  const { sale, eng } = await quick();
  await keys(sale, '10=');
  assert.equal(await sale.park(), 1);
  assert.equal(sale.state().mode, null); assert.equal(sale.state().lines.length, 0);
  await sale.selectMode('quick'); await keys(sale, '20=');
  assert.equal(await sale.park(), 2);
  assert.deepEqual(sale.state().parked, [{ slot: 1, mode: 'quick', count: 1, total: 1000 }, { slot: 2, mode: 'quick', count: 1, total: 2000 }]);
  assert.equal((await eng.dailyReport('2026-11-20')).sales_count, 0);
  assert.equal(await eng.cashBalance(), 0);
});
test('parking: restoring swaps with a non-empty current invoice, nothing is lost', async () => {
  const { sale } = await quick();
  await keys(sale, '10='); await sale.park();
  await sale.selectMode('quick'); await keys(sale, '20='); await sale.park();
  let st = await sale.restore(1);
  assert.equal(st.total, 1000); assert.deepEqual(st.parked.map((p) => p.slot), [2]);
  await keys(sale, '5=');
  st = await sale.restore(2);
  assert.equal(st.total, 2000);
  assert.deepEqual(st.parked, [{ slot: 2, mode: 'quick', count: 2, total: 1500 }]);
  await rejectsWith(sale.restore(4), 'NOT_FOUND');
});
test('parking: at most 5, and nothing to park when empty', async () => {
  const { sale } = await fresh();
  await rejectsWith(sale.park(), 'NOTHING_TO_PARK');
  for (let i = 1; i <= 5; i += 1) { await sale.selectMode('quick'); await keys(sale, i + '0='); await sale.park(); }
  assert.equal(sale.state().parked.length, 5);
  await sale.selectMode('quick'); await keys(sale, '1=');
  await rejectsWith(sale.park(), 'PARK_FULL');
});
test('security: discarding a parked invoice or clearing a cart with lines needs confirmation and leaves a trace', async () => {
  const { sale, store } = await quick();
  await keys(sale, '10='); await sale.park();
  await rejectsWith(sale.discardParked(1), 'NEEDS_CONFIRM');
  assert.equal(sale.state().parked.length, 1);
  await sale.discardParked(1, { confirmed: true });
  assert.equal(sale.state().parked.length, 0);
  assert.equal((await audit(store, 'parked_sale_discarded')).length, 1);
  assert.equal((await audit(store, 'parked_sale_discarded'))[0].details.total, 1000);

  await sale.selectMode('quick'); await keys(sale, '30=');
  await rejectsWith(sale.clearAll(), 'NEEDS_CONFIRM');
  assert.equal(sale.state().lines.length, 1);
  await sale.clearAll({ confirmed: true });
  assert.equal((await audit(store, 'sale_cart_cleared')).length, 1);
  assert.equal(sale.state().mode, null);

  await sale.clearAll();                                  // empty: no confirmation, no trace
  assert.equal((await audit(store, 'sale_cart_cleared')).length, 1);
});

/* ---------- 5. autosave ---------- */
test('autosave: a new session restores the current invoice, the mode and the parked ones', async () => {
  const { store, cat, eng, sale } = await quick();
  await keys(sale, '10='); await sale.park();
  await sale.selectMode('quick'); await keys(sale, '5+2×3=');
  const again = new SaleSession({ store, catalog: cat, engine: eng });
  const st = await again.load();
  assert.equal(st.mode, 'quick'); assert.equal(st.total, 1100); assert.equal(st.lines.length, 2);
  assert.deepEqual(st.parked, [{ slot: 1, mode: 'quick', count: 1, total: 1000 }]);
  assert.equal(st.can_undo, false);
});
test('autosave: the saved draft disappears once everything is paid, parked or cleared', async () => {
  const { store, cat, eng, sale } = await quick();
  await keys(sale, '10='); await sale.confirmQuantities(); await sale.checkout();
  const row = () => store.tx(['meta'], 'readonly', (tx) => tx.get('meta', 'sale_draft'));
  assert.equal(await row(), undefined);
  const again = new SaleSession({ store, catalog: cat, engine: eng });
  const st = await again.load();
  assert.equal(st.mode, null); assert.equal(st.lines.length, 0); assert.deepEqual(st.parked, []);
});
test('autosave: a detailed invoice comes back with its search state reset', async () => {
  const { store, cat, eng, sale, e4 } = await detailed();
  await sale.addProduct(e4.id);
  const again = new SaleSession({ store, catalog: cat, engine: eng });
  const st = await again.load();
  assert.equal(st.mode, 'detailed'); assert.equal(st.lines.length, 1); assert.equal(st.lines[0].sku, 'E4');
});

/* ---------- 6. display helpers ---------- */
test('format helpers', () => {
  assert.equal(format.money(123450), '1 234.50');
  assert.equal(format.money(-5), '-0.05');
  assert.deepEqual([250, 200, 25, 1050].map(format.qty), ['2.5', '2', '0.25', '10.5']);
  assert.equal(toUnits('45.5'), 4550); assert.equal(toUnits('.5'), 50); assert.equal(toUnits('7'), 700);
  assert.ok(Number.isNaN(toUnits('1.234'))); assert.ok(Number.isNaN(toUnits(''))); assert.ok(Number.isNaN(toUnits('.')));
});

/* ---------- 7. the guide: what the employee does next ---------- */
test('next step: the guide follows a quick invoice from the first key to the payment', async () => {
  const { sale } = await fresh();
  assert.deepEqual(sale.state().next, { action: 'choose_mode', suggest: null });
  await sale.selectMode('quick');
  assert.equal(sale.state().next.action, 'type');
  await keys(sale, '12+32×2');
  assert.equal(sale.state().next.action, 'equals');
  await sale.press('=');
  assert.equal(sale.state().next.action, 'confirm');
  await sale.confirmQuantities();
  assert.equal(sale.state().next.action, 'pay');
  await sale.checkout();
  assert.deepEqual(sale.state().next, { action: 'choose_mode', suggest: 'quick' });
});
test('next step: calculator and detailed modes', async () => {
  const f = await detailed();
  const { sale, e5, e4 } = f;
  assert.equal(sale.state().next.action, 'search');
  assert.equal((await sale.pickCategory('E')).next.action, 'pick_result');
  assert.equal(sale.state().next.single, null);
  assert.deepEqual((await sale.press('5')).next, { action: 'pick_result', single: e5.id });
  assert.equal((await sale.press('9')).next.action, 'no_match');
  await sale.press('C');
  await sale.pickCategory('E'); await sale.press('4'); await sale.addProduct(e4.id);
  assert.equal(sale.state().next.action, 'pay');
  const c = await fresh();
  await c.sale.selectMode('calc');
  assert.equal(c.sale.state().next.action, 'type');
  assert.equal((await keys(c.sale, '2+')).next.action, 'equals');
});
test('the last mode used is suggested again, even after a restart', async () => {
  const { store, cat, eng, sale } = await quick();
  await keys(sale, '10='); await sale.confirmQuantities(); await sale.checkout();
  const again = new SaleSession({ store, catalog: cat, engine: eng });
  assert.deepEqual((await again.load()).next, { action: 'choose_mode', suggest: 'quick' });
});

/* ---------- 8. negotiation: margin and protection against mistakes ---------- */
test('margin: shown per line and in the search results; below-cost lines are flagged', async () => {
  const { sale, e4 } = await detailed();
  await sale.pickCategory('E');
  const res = (await sale.press('4')).results[0];
  assert.deepEqual([res.margin_cents, res.margin_pct], [500, 33.3]);
  const st = await sale.addProduct(e4.id);
  assert.deepEqual([st.lines[0].margin_cents, st.lines[0].margin_pct, st.lines[0].below_cost], [500, 33.3, false]);
  const low = await sale.setLine(0, { price: 900 });
  assert.deepEqual([low.lines[0].margin_cents, low.lines[0].margin_pct, low.lines[0].below_cost], [-100, -11.1, true]);
});
test('margin: quick lines have no margin until they are detailed', async () => {
  const { sale } = await quick();
  const st = await keys(sale, '10=');
  assert.deepEqual([st.lines[0].margin_cents, st.lines[0].margin_pct, st.lines[0].below_cost], [null, null, false]);
});
test('preview: tells the payment window what paying would do', async () => {
  const { sale } = await quick();
  await keys(sale, '10+20=');
  assert.equal(sale.preview().blocked, 'NEEDS_CONFIRM');
  await sale.confirmQuantities();
  assert.deepEqual(sale.preview(), { total: 3000, paid: 3000, effective: 3000, change_cents: 0, due_cents: 0, needs_party: false, loss_lines: [], blocked: null });
  const part = sale.preview({ paid_cents: 2000 });
  assert.deepEqual([part.due_cents, part.needs_party, part.change_cents], [1000, true, 0]);
  const over = sale.preview({ paid_cents: 5000 });
  assert.deepEqual([over.change_cents, over.effective, over.needs_party], [2000, 3000, false]);
  assert.equal((await fresh()).sale.preview().blocked, 'NO_INVOICE');
});
test('preview: below-cost lines are listed before paying', async () => {
  const { sale, e4 } = await detailed();
  await sale.addProduct(e4.id); await sale.setLine(0, { price: 900 });
  assert.deepEqual(sale.preview().loss_lines, [1]);
});
test('a line without a price can never be sold', async () => {
  const { sale, cat } = await detailed();
  const free = await cat.createProduct({ sku: 'E77', name: 'Sans prix', sell_cents: 0, buy_cents: 0, qty: 0 });
  await sale.addProduct(free.id);
  assert.equal(sale.state().lines[0].zero_price, true);
  assert.equal(sale.preview().blocked, 'ZERO_PRICE');
  await rejectsWith(sale.checkout(), 'ZERO_PRICE', (e) => assert.deepEqual(e.details.line_nos, [1]));
  await rejectsWith(sale.setLine(0, { price: 0 }), 'INVALID_NUMBER');
  await sale.setLine(0, { price: 500 });
  assert.equal(sale.preview().blocked, null);
  const f = await quick();
  assert.equal((await keys(f.sale, '0=')).hint, 'INVALID_EXPRESSION');
});
test('pending details: quick invoices waiting for their details are counted', async () => {
  const { sale, eng, cat } = await quick();
  assert.deepEqual(await sale.pendingDetails(), { count: 0, total_cents: 0 });
  await keys(sale, '10+20='); await sale.confirmQuantities();
  const r = await sale.checkout();
  assert.deepEqual(await sale.pendingDetails(), { count: 1, total_cents: 3000 });
  const p = await cat.createProduct({ sku: 'O1', name: 'Marteau', sell_cents: 1000, buy_cents: 500, qty: U(5) });
  await eng.detailQuickLine(r.invoice.id, r.lines[0].id, { product_id: p.id });
  assert.equal((await sale.pendingDetails()).count, 1);
  await eng.detailQuickLine(r.invoice.id, r.lines[1].id, { external: { name: 'Vis', buy_cents: 100 } });
  assert.equal((await sale.pendingDetails()).count, 0);
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed += 1; console.log('  ok   ' + name); } catch (e) {
      failed += 1;
      console.log('  FAIL ' + name + '\n       ' + String((e && (e.stack || e.message)) || e).split('\n').slice(0, 5).join('\n       '));
    }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
