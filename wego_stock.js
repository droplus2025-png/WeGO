/* wego_stock.js — stock screen. Registers WeGo.screens.stock. */
(function () {
  'use strict';
  const W = window.WeGo;
  W.screens = W.screens || {};
  W.screens.stock = { open };

  function open() {
    const ui = W.ui;
    const { ask, toast, fail, esc, money, plain, cents, buzz } = ui;
    const $ = (s) => document.querySelector(s);
    const sc = ui.showScreen('المخزون');
    let filter = null;           // null = all categories

    sc.actions.innerHTML = '<button class="b go" id="sx" style="color:#111">لصق من Excel</button><button class="b op" id="sc">تصدير CSV</button>';
    sc.body.innerHTML =
      '<section class="pn"><div class="mini" id="sk"></div>' +
      '<input id="sq" placeholder="بحث: اسم المنتج أو رقمه" autocomplete="off" style="background:#071026;border:2px solid var(--line);border-radius:12px;color:var(--text);font:16px system-ui,sans-serif;padding:10px 12px">' +
      '<div class="tb h"><span>#</span><span>الرمز</span><span>المنتج</span><span>شراء</span><span>بيع</span><span>الكمية</span></div>' +
      '<div class="list" id="st"></div><div id="sn" style="color:var(--mut);font-size:13px"></div></section>';

    async function load() {
      const all = await ui.store.tx(['products'], 'readonly', (tx) => tx.all('products'));
      const order = new Map(ui.cats().map((c) => [c.id, c.sort]));
      const n = W.rules.normalizeText($('#sq').value);
      return all
        .filter((p) => !p.is_deleted && (!filter || p.category_id === filter.id) && (!n || p.name_norm.includes(n) || p.sku.toLowerCase() === n))
        .sort((a, b) => (order.get(a.category_id) - order.get(b.category_id)) || (a.sku_num - b.sku_num));
    }

    const cell = (f, v, text) => '<span class="num' + (v === 0 ? ' red' : '') + '" data-f="' + f + '">' + text + '</span>';

    async function render() {
      const list = await load();
      $('#st').innerHTML = list.map((p, i) =>
        '<div class="tb" data-id="' + p.id + '"><span class="num">' + (i + 1) + '</span>' +
        '<span class="s num" data-f="sku">' + esc(p.sku) + '</span>' +
        '<span class="nm" data-f="name">' + esc(p.name) + '</span>' +
        cell('buy', p.buy_cents, plain(p.buy_cents)) + cell('sell', p.sell_cents, plain(p.sell_cents)) + cell('qty', p.qty, W.sale.format.qty(p.qty))).join('');
      $('#sn').textContent = list.length + ' منتج';
      $('#sk').innerHTML = '<button class="b" data-i="-1" style="background:' + (filter ? 'var(--key)' : '#fff;color:#111') + '">الكل</button>' +
        ui.cats().map((c, i) => '<button class="b" data-i="' + i + '" style="background:' + (filter && filter.id === c.id ? '#fff;color:#111' : 'var(--key)') + '">' + (c.prefix || '#') + ' ' + esc(c.name_ar) + '</button>').join('');
    }

    async function edit(id, field) {
      const p = await ui.cat.getProduct(id);
      if (!p) return;
      try {
        if (field === 'sku') {
          const v = await ask('رقم المنتج — ' + esc(p.name), [{ l: 'الرمز (مثال: E7 أو 12)', n: 'sku', v: p.sku }], 'حفظ', true);
          if (v && v.sku.toUpperCase() !== p.sku) await ui.cat.setSku(id, v.sku);
        } else if (field === 'qty') {
          const v = await ask(esc(p.sku + ' · ' + p.name), [{ l: 'الكمية الفعلية (جرد)', n: 'qty', m: 'decimal', v: W.sale.format.qty(p.qty) }], 'حفظ', true);
          if (v) {
            const q = W.sale.toUnits(v.qty.replace(',', '.'));
            if (Number.isNaN(q)) { toast('كمية غير صحيحة', true); return; }
            if (q !== p.qty) await ui.eng.applyCount({ category_id: p.category_id, counts: [{ product_id: id, counted_qty: q }] });
          }
        } else {
          const v = await ask(esc(p.sku), [
            { l: 'اسم المنتج', n: 'name', v: p.name }, { l: 'سعر البيع', n: 'sell', m: 'decimal', v: plain(p.sell_cents) },
            { l: 'سعر الشراء', n: 'buy', m: 'decimal', v: plain(p.buy_cents) }], 'حفظ', true, 'حذف');
          if (!v) return;
          if (v._extra) {
            if (confirm('حذف ' + p.name + '؟ يبقى في الفواتير القديمة.')) await ui.cat.softDelete(id);
          } else {
            const sell = cents(v.sell || 0);
            const buy = cents(v.buy || 0);
            if (Number.isNaN(sell) || Number.isNaN(buy)) { toast('سعر غير صحيح', true); return; }
            await ui.cat.updateProduct(id, { name: v.name, sell_cents: sell, buy_cents: buy });
          }
        }
      } catch (e) { fail(e); }
      render();
    }

    /* Rows pasted from Excel: name ⇥ sell price ⇥ buy price ⇥ quantity (last two optional). */
    function parsePaste(text) {
      const out = [];
      const errors = [];
      text.split(/\r?\n/).forEach((raw, i) => {
        if (!raw.trim()) return;
        const c = (raw.includes('\t') ? raw.split('\t') : raw.split(';')).map((x) => x.trim());
        const sell = c[1] ? cents(c[1]) : 0;
        const buy = c[2] ? cents(c[2]) : 0;
        const qty = c[3] ? W.sale.toUnits(c[3].replace(',', '.')) : 0;
        if (!c[0] || Number.isNaN(sell) || Number.isNaN(buy) || Number.isNaN(qty) || qty < 0 || sell < 0 || buy < 0) errors.push(i + 1);
        else out.push({ name: c[0], sell_cents: sell, buy_cents: buy, qty });
      });
      return { out, errors };
    }

    async function paste() {
      if (!filter) { toast('اختر صنفًا أولًا — اللصق يتم صنفًا صنفًا', true); return; }
      const v = await ask('لصق في صنف: ' + esc(filter.name_ar), [{ l: 'الاسم ⇥ سعر البيع ⇥ سعر الشراء ⇥ الكمية', n: 'text', t: 'area' }], 'استيراد', true);
      if (!v || !v.text) return;
      const { out, errors } = parsePaste(v.text);
      if (errors.length) { toast('أسطر غير صحيحة: ' + errors.slice(0, 8).join('، ') + ' — لم يُستورد شيء', true); return; }
      let done = 0;
      try {
        for (const p of out) { await ui.cat.createProduct({ category_id: filter.id, ...p }); done += 1; }
        toast('✔ تمت إضافة ' + done + ' منتج');
      } catch (e) { toast('توقف بعد ' + done + ' منتج: ' + (e.message || e.code), true); }
      render();
    }

    async function exportCsv() {
      const list = await load();
      const names = new Map(ui.cats().map((c) => [c.id, c.name_fr || c.name_ar]));
      const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
      const csv = '\ufeff' + ['sku,name,category,buy,sell,qty'].concat(list.map((p) =>
        [p.sku, q(p.name), q(names.get(p.category_id) || ''), plain(p.buy_cents), plain(p.sell_cents), plain(p.qty)].join(','))).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = 'wego_stock_' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
      toast('تم تصدير ' + list.length + ' منتج');
    }

    $('#sk').onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) { buzz(); filter = +b.dataset.i < 0 ? null : ui.cats()[+b.dataset.i]; render(); } };
    $('#sq').oninput = render;
    $('#st').onclick = (e) => {
      const c = e.target.closest('[data-f]');
      const row = e.target.closest('.tb');
      if (c && row) { buzz(); edit(row.dataset.id, c.dataset.f); }
    };
    $('#sx').onclick = () => { buzz(); paste(); };
    $('#sc').onclick = () => { buzz(); exportCsv(); };
    render();
  }
})();
