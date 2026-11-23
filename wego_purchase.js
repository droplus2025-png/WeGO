/* wego_purchase.js — purchase / stock-in screen. Registers WeGo.screens.purchase. */
(function () {
  'use strict';
  const W = window.WeGo;
  W.screens = W.screens || {};
  W.screens.purchase = { open };

  function open() {
    const ui = W.ui;
    const { ask, toast, fail, esc, money, plain, cents, buzz } = ui;
    const $ = (s, r) => (r || document).querySelector(s);
    const sc = ui.showScreen('شراء — إدخال مخزون');
    let lines = [];
    let activeCat = null;
    let ref = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());

    sc.body.innerHTML =
      '<section class="pn"><div class="list" id="pl"></div>' +
      '<div style="display:flex;align-items:center;gap:10px"><button class="b pay" id="psave" style="min-width:150px;min-height:56px;font-size:20px" disabled>حفظ الشراء</button>' +
      '<div id="ptot" class="num" style="flex:1;text-align:left;font:900 30px system-ui,sans-serif;color:var(--gold)">0.00</div></div></section>' +
      '<section class="pn"><div class="mini" id="pc"></div>' +
      '<input id="pq" placeholder="بحث: اسم المنتج أو رقمه" autocomplete="off" style="background:#071026;border:2px solid var(--line);border-radius:12px;color:var(--text);font:16px system-ui,sans-serif;padding:10px 12px">' +
      '<div class="list" id="pr"></div></section>';

    const fmtQty = W.sale.format.qty;
    const rowTotal = (l) => Math.round((l.qty * l.cost) / 100);
    const total = () => lines.reduce((s, l) => s + rowTotal(l), 0);

    function renderLines() {
      $('#pl').innerHTML = lines.map((l, i) =>
        '<div class="ln' + (l.isNew ? ' gen' : '') + '" data-i="' + i + '"><span class="n">' + (i + 1) + '</span><span class="nm">' + esc(l.sku + ' · ' + l.name) + '</span>' +
        '<span class="num">' + fmtQty(l.qty) + '×' + money(l.cost) + '</span><span class="t num">' + money(rowTotal(l)) + '</span><button class="b x" data-x="' + i + '">✕</button></div>').join('');
      $('#ptot').textContent = money(total());
      $('#psave').disabled = lines.length === 0;
    }

    function renderCats() {
      $('#pc').innerHTML = ui.cats().map((c, i) =>
        '<button class="b" data-i="' + i + '" style="background:' + (activeCat && activeCat.id === c.id ? '#fff;color:#111' : 'var(--key)') + '">' + (c.prefix || '#') + ' ' + esc(c.name_ar) + '</button>').join('');
    }

    function rows(list, withNew) {
      $('#pr').innerHTML = (withNew ? '<div class="r new" data-new="1">＋ منتج جديد في هذا الصنف</div>' : '') +
        list.map((p) => '<div class="r' + (p.qty <= 0 ? ' zero' : '') + '" data-id="' + p.id + '"><span class="s num">' + esc(p.sku) + '</span><span class="nm">' + esc(p.name) +
          '</span><small class="num">A' + plain(p.buy_cents) + '</small><small class="q num">Q' + fmtQty(p.qty) + '</small></div>').join('');
    }

    async function refreshResults() {
      const n = W.rules.normalizeText($('#pq').value);
      if (n) {
        const all = await ui.store.tx(['products'], 'readonly', (tx) => tx.all('products'));
        rows(all.filter((p) => !p.is_deleted && (p.name_norm.includes(n) || p.sku.toLowerCase() === n)).slice(0, 40), false);
      } else if (activeCat) {
        rows(await ui.cat.listByCategory(activeCat.id), true);
      } else {
        $('#pr').innerHTML = '';
      }
    }

    function addLine(l) {
      const same = !l.isNew && lines.find((x) => x.product_id === l.product_id && x.cost === l.cost);
      if (same) same.qty += l.qty; else lines.push(l);
      renderLines();
    }

    const readQtyCost = (v) => {
      const qty = W.sale.toUnits(String(v.qty).replace(',', '.'));
      const cost = cents(v.cost || 0);
      if (Number.isNaN(qty) || qty < 1 || Number.isNaN(cost) || cost < 0) { toast('الكمية أو السعر غير صحيح', true); return null; }
      return { qty, cost };
    };

    async function pick(id) {
      const p = await ui.cat.getProduct(id);
      if (!p || p.is_deleted) return;
      const v = await ask(esc(p.sku + ' · ' + p.name), [{ l: 'الكمية', n: 'qty', m: 'decimal', v: '1' }, { l: 'سعر الشراء', n: 'cost', m: 'decimal', v: plain(p.buy_cents) }], 'إضافة', true);
      const r = v && readQtyCost(v);
      if (r) addLine({ product_id: p.id, sku: p.sku, name: p.name, qty: r.qty, cost: r.cost });
    }

    async function createNew() {
      if (!activeCat) { toast('اختر صنفًا أولًا', true); return; }
      const v = await ask('منتج جديد — ' + esc(activeCat.name_ar), [
        { l: 'اسم المنتج', n: 'name' }, { l: 'الكمية', n: 'qty', m: 'decimal', v: '1' },
        { l: 'سعر الشراء', n: 'cost', m: 'decimal' }, { l: 'سعر البيع', n: 'sell', m: 'decimal' }], 'إضافة', true);
      if (!v) return;
      const r = readQtyCost(v);
      const sell = cents(v.sell || 0);
      if (!r || !v.name || Number.isNaN(sell)) { toast('تحقق من الاسم والأسعار', true); return; }
      addLine({ isNew: true, category_id: activeCat.id, sell, sku: (activeCat.prefix || '#') + '؟', name: v.name, qty: r.qty, cost: r.cost });
    }

    async function save() {
      const sum = total();
      const v = await ask('حفظ الشراء — المجموع ' + money(sum), [
        { l: 'المبلغ المدفوع', n: 'paid', v: plain(sum), m: 'decimal' },
        { l: 'اسم المورد (إلزامي عند الدين)', n: 'name' }, { l: 'الهاتف', n: 'phone', m: 'tel' }], 'تأكيد', false);
      if (!v) return;
      const paid = v.paid === '' ? sum : cents(v.paid);
      if (Number.isNaN(paid)) { toast('مبلغ غير صحيح', true); return; }
      const payload = lines.map((l) => (l.isNew
        ? { new: { category_id: l.category_id, name: l.name, sell_cents: l.sell }, qty: l.qty, unit_cost_cents: l.cost }
        : { product_id: l.product_id, qty: l.qty, unit_cost_cents: l.cost }));
      try {
        const r = await ui.eng.purchase({ lines: payload, paid_cents: paid, supplier: { name: v.name, phone: v.phone }, client_ref: ref });
        lines = []; ref = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
        renderLines(); refreshResults();
        toast('✔ شراء ' + r.invoice.number + (r.invoice.due_cents ? ' — مستحق للمورد ' + money(r.invoice.due_cents) : ''));
      } catch (e) { fail(e); }
    }

    $('#pc').onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) { buzz(); activeCat = ui.cats()[+b.dataset.i]; $('#pq').value = ''; renderCats(); refreshResults(); } };
    $('#pq').oninput = refreshResults;
    $('#pr').onclick = (e) => { const r = e.target.closest('.r'); if (!r) return; buzz(); if (r.dataset.new) createNew(); else if (r.dataset.id) pick(r.dataset.id); };
    $('#pl').onclick = (e) => {
      const x = e.target.closest('[data-x]');
      if (x) { buzz(); lines.splice(+x.dataset.x, 1); renderLines(); }
    };
    $('#psave').onclick = () => { buzz(); save(); };
    renderCats(); renderLines();
  }
})();
