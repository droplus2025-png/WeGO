/* wego_tests.js — run with:  node wego_tests.js */
'use strict';
const assert = require('node:assert/strict');
const rules = require('./wego_rules.js');
const schema = require('./wego_schema.js');
const { MemoryStore } = require('./wego_store.js');
const { Catalog } = require('./wego_catalog.js');

let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

async function fresh() {
  let n = 0;
  const t0 = Date.parse('2026-11-20T08:00:00Z');
  const store = new MemoryStore(schema);
  const cat = new Catalog(store, {
    deviceId: 'dev-1',
    now: () => new Date(t0 + (n += 1000)).toISOString(), // strictly increasing clock
    uuid: () => 'id-' + (++n),
  });
  await cat.init();
  return { store, cat };
}
async function rejectsWith(promise, code) {
  await assert.rejects(promise, (e) => { assert.equal(e.code, code); return true; });
}
const P = (cat, category_id, name = 'x', sell_cents = 1000, buy_cents = 500) =>
  cat.createProduct({ category_id, name, sell_cents, buy_cents });

/* ---------- rules ---------- */
test('parseSku: letters are case-insensitive, digits alone = general droguerie', () => {
  assert.deepEqual(rules.parseSku('m4'), { prefix: 'M', num: 4 });
  assert.deepEqual(rules.parseSku('S98'), { prefix: 'S', num: 98 });
  assert.deepEqual(rules.parseSku('em12'), { prefix: 'EM', num: 12 });
  assert.deepEqual(rules.parseSku('5'), { prefix: '', num: 5 });
  assert.deepEqual(rules.parseSku(' e 3 '), { prefix: 'E', num: 3 });
  assert.deepEqual(rules.parseSku('\u0663'), { prefix: '', num: 3 });
});
test('parseSku: rejects invalid input', () => {
  for (const bad of ['', 'm', 'abcd1', 'm0', '4m', '0', 'm-1', null]) {
    assert.throws(() => rules.parseSku(bad), (e) => e.code === 'INVALID_SKU', String(bad));
  }
});
test('nextFreeNumber: smallest free positive integer', () => {
  assert.equal(rules.nextFreeNumber([]), 1);
  assert.equal(rules.nextFreeNumber([1, 2, 3]), 4);
  assert.equal(rules.nextFreeNumber([1, 3]), 2);
  assert.equal(rules.nextFreeNumber(new Set([2, 3])), 1);
});
test('normalizePhone: 06 = +212 = 00212', () => {
  const a = rules.normalizePhone('06 12 34 56 78');
  assert.equal(a, '212612345678');
  assert.equal(rules.normalizePhone('+212612345678'), a);
  assert.equal(rules.normalizePhone('00212612345678'), a);
});
test('normalizeText: Arabic and Latin variants compare equal', () => {
  assert.equal(rules.normalizeText('أَحمد'), rules.normalizeText('احمد'));
  assert.equal(rules.normalizeText('  Écrou  M8 '), 'ecrou m8');
  assert.equal(rules.normalizeText('مسمار ٥'), 'مسمار 5');
});

/* ---------- init ---------- */
test('init: seeds 7 categories, settings, device id; idempotent', async () => {
  const { store, cat } = await fresh();
  await cat.init();
  const cats = await cat.listCategories();
  assert.deepEqual(cats.map((c) => c.id), ['DG', 'E', 'P', 'S', 'M', 'O', 'EM']);
  assert.equal(cats[0].prefix, '');
  const dev = await store.tx(['meta'], 'readonly', (tx) => tx.get('meta', 'device_id'));
  assert.equal(dev.value, 'dev-1');
  const s = await store.tx(['settings'], 'readonly', (tx) => tx.get('settings', 'quick_sale_profit_pct'));
  assert.equal(s.value, 20);
});

/* ---------- SKU numbering ---------- */
test('numbering starts at 1 in every category, independently', async () => {
  const { cat } = await fresh();
  assert.equal((await P(cat, 'DG')).sku, '1');
  assert.equal((await P(cat, 'DG')).sku, '2');
  assert.equal((await P(cat, 'E')).sku, 'E1');
  assert.equal((await P(cat, 'E')).sku, 'E2');
  assert.equal((await P(cat, 'M')).sku, 'M1');
  assert.equal((await P(cat, 'EM')).sku, 'EM1');
  assert.equal((await P(cat, 'S')).sku, 'S1');
});
test('smallest free number is reused after a delete', async () => {
  const { cat } = await fresh();
  const a = await P(cat, 'E'); const b = await P(cat, 'E'); await P(cat, 'E');
  await cat.softDelete(b.id);
  assert.equal((await P(cat, 'E')).sku, 'E2');
  await cat.softDelete(a.id);
  assert.equal((await P(cat, 'E')).sku, 'E1');
});
test('explicit SKU is honoured; taken and unknown letters are refused', async () => {
  const { cat } = await fresh();
  const p = await cat.createProduct({ sku: 'e7', name: 'Prise', sell_cents: 2500 });
  assert.equal(p.sku, 'E7'); assert.equal(p.category_id, 'E'); assert.equal(p.sku_num, 7);
  await rejectsWith(cat.createProduct({ sku: 'E7', name: 'Autre', sell_cents: 1 }), 'SKU_TAKEN');
  await rejectsWith(cat.createProduct({ sku: 'z1', name: 'Autre', sell_cents: 1 }), 'UNKNOWN_CATEGORY');
  assert.equal((await P(cat, 'E')).sku, 'E1');
});
test('EM and E are different categories', async () => {
  const { cat } = await fresh();
  const p = await cat.createProduct({ sku: 'em1', name: 'Frigo', sell_cents: 300000 });
  assert.equal(p.category_id, 'EM');
  assert.equal((await cat.findBySku('E1')), null);
});
test('findBySku is case-insensitive and ignores deleted products', async () => {
  const { cat } = await fresh();
  const p = await P(cat, 'E', 'Fil 2.5');
  assert.equal((await cat.findBySku('e1')).id, p.id);
  await cat.softDelete(p.id);
  assert.equal(await cat.findBySku('e1'), null);
});

/* ---------- edit / migrate / delete ---------- */
test('setSku: category follows the letter, taken number refused, same sku = no-op', async () => {
  const { cat } = await fresh();
  const e1 = await P(cat, 'E'); await P(cat, 'M');
  const moved = await cat.setSku(e1.id, 'm9');
  assert.equal(moved.sku, 'M9'); assert.equal(moved.category_id, 'M');
  assert.ok(moved.category_changed_at);
  await rejectsWith(cat.setSku(e1.id, 'M1'), 'SKU_TAKEN');
  const again = await cat.setSku(e1.id, 'M9');
  assert.equal(again.rev, moved.rev);
});
test('moveCategory: smallest free number in the new category, old number freed', async () => {
  const { cat } = await fresh();
  const e1 = await P(cat, 'E'); await P(cat, 'S'); await P(cat, 'S');
  const m = await cat.moveCategory(e1.id, 'S');
  assert.equal(m.sku, 'S3'); assert.equal(m.category_id, 'S');
  assert.equal((await P(cat, 'E')).sku, 'E1');
  await cat.softDelete((await cat.findBySku('S1')).id);
  const e2 = await P(cat, 'E');
  assert.equal((await cat.moveCategory(e2.id, 'S')).sku, 'S1');
});
test('softDelete hides products; includeDeleted shows them; restore handles a reused number', async () => {
  const { cat } = await fresh();
  const a = await P(cat, 'P', 'Robinet');
  await cat.softDelete(a.id);
  assert.equal((await cat.listByCategory('P')).length, 0);
  assert.equal((await cat.listByCategory('P', { includeDeleted: true })).length, 1);
  const b = await P(cat, 'P', 'Siphon');
  assert.equal(b.sku, 'P1');
  const r = await cat.restore(a.id);
  assert.equal(r.is_deleted, 0); assert.equal(r.sku, 'P2');
});
test('updateProduct changes name and prices; invalid values refused; no change = no revision', async () => {
  const { cat } = await fresh();
  const p = await P(cat, 'O', 'Marteau', 5000, 3000);
  const u = await cat.updateProduct(p.id, { name: 'Marteau 500g', sell_cents: 5500 });
  assert.equal(u.name, 'Marteau 500g'); assert.equal(u.sell_cents, 5500); assert.equal(u.rev, 2);
  assert.equal((await cat.updateProduct(p.id, { sell_cents: 5500 })).rev, 2);
  await rejectsWith(cat.updateProduct(p.id, { sell_cents: 10.5 }), 'INVALID_PRICE');
  await rejectsWith(cat.updateProduct(p.id, { name: '  ' }), 'INVALID_NAME');
  await rejectsWith(cat.updateProduct('nope', { name: 'x' }), 'NOT_FOUND');
});

/* ---------- categories ---------- */
test('addCategory: owner adds a letter; duplicates and invalid letters refused', async () => {
  const { cat } = await fresh();
  const x = await cat.addCategory({ prefix: 'x', name_ar: 'زجاج', name_fr: 'Vitrerie' });
  assert.equal(x.prefix, 'X');
  assert.equal((await P(cat, x.id)).sku, 'X1');
  await rejectsWith(cat.addCategory({ prefix: 'e', name_ar: 'a' }), 'CATEGORY_EXISTS');
  await rejectsWith(cat.addCategory({ prefix: '', name_ar: 'a' }), 'CATEGORY_EXISTS');
  await rejectsWith(cat.addCategory({ prefix: '1', name_ar: 'a' }), 'INVALID_PREFIX');
  await rejectsWith(cat.addCategory({ prefix: 'abcd', name_ar: 'a' }), 'INVALID_PREFIX');
  assert.equal((await cat.createProduct({ sku: 'x5', name: 'Verre', sell_cents: 100 })).category_id, x.id);
});

/* ---------- sync conflicts ---------- */
test('resolveSkuConflicts: the older product keeps the SKU, the newer takes the smallest free number', async () => {
  const { store, cat } = await fresh();
  const a = await P(cat, 'M', 'A'); await P(cat, 'M', 'B');
  const dup = { ...(await cat.getProduct(a.id)), id: 'remote-1', name: 'C', name_norm: 'c', created_at: '2027-01-01T00:00:00.000Z' };
  await store.tx(['products'], 'readwrite', (tx) => tx.put('products', dup));
  const changes = await cat.resolveSkuConflicts();
  assert.deepEqual(changes, [{ id: 'remote-1', from: 'M1', to: 'M3' }]);
  assert.equal((await cat.getProduct(a.id)).sku, 'M1');
  assert.deepEqual(await cat.resolveSkuConflicts(), []);
});

/* ---------- returns ---------- */
function lineOf(p, extra) {
  return { product_id: p.id, sku: p.sku, name: p.name, list_price_cents: p.sell_cents, unit_cost_cents: p.buy_cents, is_external: 0, ...extra };
}
test('return: identical product -> match, even if the sale price was negotiated', async () => {
  const { cat } = await fresh();
  const p = await P(cat, 'E', 'Prise double', 2500, 1500);
  const r = await cat.checkReturnLine(lineOf(p, { unit_price_cents: 2000 }));
  assert.equal(r.status, 'match');
});
test('return: modified product -> changed, with the differences', async () => {
  const { cat } = await fresh();
  const p = await P(cat, 'E', 'Prise double', 2500, 1500);
  const line = lineOf(p);
  await cat.updateProduct(p.id, { sell_cents: 2800, name: 'Prise double 16A' });
  const r = await cat.checkReturnLine(line);
  assert.equal(r.status, 'changed');
  assert.deepEqual(r.diffs.map((d) => d.field).sort(), ['name', 'sell_cents']);
  assert.equal(r.diffs.find((d) => d.field === 'sell_cents').was, 2500);
  assert.equal(r.diffs.find((d) => d.field === 'sell_cents').now, 2800);
});
test('return: buy price change alone is a difference only when the setting asks for it', async () => {
  const { store, cat } = await fresh();
  const p = await P(cat, 'O', 'Pince', 4000, 2500);
  const line = lineOf(p);
  await cat.updateProduct(p.id, { buy_cents: 2600 });
  assert.equal((await cat.checkReturnLine(line)).status, 'match');
  await store.tx(['settings'], 'readwrite', (tx) => tx.put('settings', { key: 'return_match_buy_price', value: 1, updated_at: 'x' }));
  assert.equal((await cat.checkReturnLine(line)).status, 'changed');
});
test('return: deleted product -> deleted, suggests the same SKU when free', async () => {
  const { cat } = await fresh();
  const p = await P(cat, 'P', 'Vanne', 9000, 6000);
  const line = lineOf(p);
  await cat.softDelete(p.id);
  const r = await cat.checkReturnLine(line);
  assert.equal(r.status, 'deleted');
  assert.equal(r.reinsert_sku, 'P1');
});
test('return: deleted product whose number was reused -> candidates and a new suggested SKU', async () => {
  const { cat } = await fresh();
  const p = await P(cat, 'P', 'Vanne', 9000, 6000);
  const line = lineOf(p);
  await cat.softDelete(p.id);
  const other = await P(cat, 'P', 'Siphon', 1500, 900);
  const same = await P(cat, 'P', 'Vanne', 9500, 6000);
  const r = await cat.checkReturnLine(line);
  assert.equal(r.status, 'deleted');
  assert.equal(r.reinsert_sku, 'P3');
  assert.deepEqual(r.candidates.map((c) => c.id).sort(), [other.id, same.id].sort());
});
test('return: external and unknown products', async () => {
  const { cat } = await fresh();
  assert.equal((await cat.checkReturnLine({ is_external: 1, name: 'Vis', sku: '', product_id: null })).status, 'external');
  const r = await cat.checkReturnLine({ product_id: 'ghost', sku: 'E9', name: 'x', list_price_cents: 1, unit_cost_cents: 1 });
  assert.equal(r.status, 'missing');
  assert.equal(r.reinsert_sku, 'E9');
});

/* ---------- atomicity / journal / structure ---------- */
test('a failing transaction writes nothing (rollback)', async () => {
  const { store } = await fresh();
  await assert.rejects(store.tx(['products', 'audit_log'], 'readwrite', async (tx) => {
    await tx.put('products', { id: 'tmp', sku: 'E1' });
    throw new Error('boom');
  }));
  assert.equal(await store.tx(['products'], 'readonly', (tx) => tx.get('products', 'tmp')), undefined);
});
test('read-only transactions cannot write', async () => {
  const { store } = await fresh();
  await assert.rejects(store.tx(['products'], 'readonly', (tx) => tx.put('products', { id: 'z' })));
});
test('parallel creations never share a number', async () => {
  const { cat } = await fresh();
  const made = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => P(cat, 'S', 'p' + i)));
  assert.deepEqual(made.map((p) => p.sku_num).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
});
test('every product carries all documented columns; every change is journaled', async () => {
  const { store, cat } = await fresh();
  const p = await P(cat, 'E');
  for (const f of schema.stores.products.fields) assert.ok(f in p, 'missing column ' + f);
  await cat.updateProduct(p.id, { sell_cents: 1200 });
  await cat.moveCategory(p.id, 'S');
  await cat.softDelete(p.id);
  const log = await store.tx(['audit_log'], 'readonly', (tx) => tx.byIndex('audit_log', 'entity', ['product', p.id]));
  assert.deepEqual(log.map((l) => l.action).sort(), ['category_moved', 'product_created', 'product_deleted', 'product_updated']);
});
test('schema: every index points to a documented field', () => {
  for (const [name, def] of Object.entries(schema.stores)) {
    for (const [idx, kp] of Object.entries(def.indexes)) {
      for (const k of [].concat(kp)) assert.ok(def.fields.includes(k), name + '.' + idx + ' -> ' + k);
    }
    assert.ok(def.fields.includes(def.keyPath), name + ' keyPath');
  }
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed += 1; console.log('  ok   ' + name); }
    catch (e) { failed += 1; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
