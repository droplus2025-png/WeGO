/* wego_invoices.js — invoices list, preview/WhatsApp, quick-sale details and returns.
   Registers WeGo.screens.invoices. */
(function () {
  'use strict';
  const W = window.WeGo;
  W.screens = W.screens || {};
  W.screens.invoices = { open };

  const LABEL = {
    sale: 'بيع', quick_sale: 'بيع سريع', purchase: 'شراء', return_customer: 'إرجاع زبون',
    return_supplier: 'إرجاع مورد', expense: 'مصروف', deposit: 'إيداع', withdrawal: 'سحب',
  };
  const COLOR = {
    sale: '#4ade80', quick_sale: '#fbbf24', purchase: '#38bdf8', return_customer: '#fb7185',
    return_supplier: '#fb7185', expense: '#c084fc', deposit: '#94a3b8', withdrawal: '#94a3b8',
  };
  const FILTERS = [
    ['all', 'الكل', () => true],
    ['sale', 'بيع', (i) => i.type === 'sale' || i.type === 'quick_sale'],
    ['purchase', 'شراء', (i) => i.type === 'purchase'],
    ['ret', 'إرجاع', (i) => i.type.startsWith('return')],
    ['other', 'أخرى', (i) => ['expense', 'deposit', 'withdrawal'].includes(i.type)],
  ];
  const FIELD = { sku: 'الرمز', name: 'الاسم', sell_cents: 'سعر البيع', buy_cents: 'سعر الشراء' };

  function open(preset) {
    const ui = W.ui;
    const { ask, toast, fail, esc, money, plain, cents, buzz } = ui;
    const $ = (s) => document.querySelector(s);
    const sc = ui.showScreen(preset ? (preset === 'sale' ? 'إرجاع من زبون — اختر الفاتورة' : 'إرجاع للمورد — اختر الفاتورة') : 'الفواتير');
    let filter = FILTERS.find((f) => f[0] === preset) || FILTERS[0];
    let current = null;       // { invoice, lines }
    let settings = {};

    sc.body.innerHTML =
      '<section class="pn"><div class="mini" id="fc"></div>' +
      '<input id="fq" placeholder="بحث: رقم الفاتورة أو الاسم أو الهاتف" autocomplete="off" style="background:#071026;border:2px solid var(--line);border-radius:12px;color:var(--text);font:16px system-ui,sans-serif;padding:10px 12px">' +
      '<div class="list" id="fl"></div></section>' +
      '<section class="pn"><div class="list" id="fv" style="white-space:pre-wrap;unicode-bidi:plaintext;line-height:1.7;user-select:text"></div>' +
      '<div id="fa" style="display:flex;gap:8px;flex-wrap:wrap"></div></section>';

    const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    /* ---------- list ---------- */
    async function renderList() {
      const all = await ui.store.tx(['invoices'], 'readonly', (tx) => tx.all('invoices'));
      const q = W.rules.normalizeText($('#fq').value);
      const digits = W.rules.normalizePhone($('#fq').value);
      const list = all.filter(filter[2]).filter((i) => !q ||
        i.number.includes(q) || W.rules.normalizeText(i.party_name).includes(q) || (digits.length >= 4 && i.party_phone && W.rules.normalizePhone(i.party_phone).includes(digits)))
        .sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 150);
      $('#fl').innerHTML = list.map((i) =>
        '<div class="r" data-id="' + i.id + '"><span class="num" style="min-width:48px;color:var(--mut)">' + hhmm(i.at) + '</span>' +
        '<span style="min-width:74px;font-weight:700;color:' + COLOR[i.type] + '">' + LABEL[i.type] + (i.type === 'quick_sale' && !i.has_detail ? ' ⚠' : '') + '</span>' +
        '<span class="nm">' + esc(i.party_name || '—') + ' <small class="num">' + esc(i.number) + '</small></span>' +
        '<span class="p num">' + money(i.total_cents) + '</span></div>').join('') || '<div class="r" style="cursor:default;color:var(--mut)">لا فواتير</div>';
      $('#fc').innerHTML = FILTERS.map((f, n) => '<button class="b" data-n="' + n + '" style="background:' + (f === filter ? '#fff;color:#111' : 'var(--key)') + '">' + f[1] + '</button>').join('');
    }

    /* ---------- the invoice as it is sent ---------- */
    function invoiceText({ invoice: inv, lines }) {
      const row = (l, n) => n + '. ' + l.name + '  ' + W.sale.format.qty(l.qty) + '×' + money(l.unit_price_cents) + ' = ' + money(l.line_total_cents);
      const out = [];
      if (settings.shop_name) out.push(settings.shop_name);
      if (settings.shop_address) out.push(settings.shop_address);
      if (settings.shop_phone) out.push(settings.shop_phone);
      out.push('────────────', LABEL[inv.type] + ' رقم ' + inv.number, new Date(inv.at).toLocaleDateString('en-GB') + ' ' + hhmm(inv.at));
      if (inv.party_name) out.push((inv.type === 'purchase' || inv.type === 'return_supplier' ? 'المورد: ' : 'الزبون: ') + inv.party_name);
      out.push('────────────');
      lines.forEach((l, i) => out.push(row(l, i + 1)));
      out.push('────────────', 'المجموع: ' + money(inv.total_cents) + ' ' + (settings.currency || 'DH'));
      if (inv.type === 'sale' || inv.type === 'quick_sale' || inv.type === 'purchase') {
        out.push('المدفوع: ' + money(inv.paid_cents), 'المتبقي: ' + money(inv.due_cents));
      }
      out.push('شكرًا لثقتكم');
      return out.join('\n');
    }

    async function select(id) {
      current = await ui.eng.getInvoice(id);
      if (!current) return;
      const inv = current.invoice;
      $('#fv').textContent = invoiceText(current);
      const act = [];
      act.push('<button class="b pay" id="fw" style="min-height:52px">واتساب</button><button class="b op" id="fcp">نسخ</button>');
      if (['sale', 'quick_sale', 'purchase'].includes(inv.type)) act.push('<button class="b go" id="fr" style="color:#111;min-height:52px">إرجاع</button>');
      if (inv.type === 'quick_sale' && !inv.has_detail) act.push('<button class="b at" id="fd" style="min-height:52px">إضافة التفاصيل</button>');
      $('#fa').innerHTML = act.join('');
      $('#fw').onclick = () => { buzz(); whatsapp(); };
      $('#fcp').onclick = () => { buzz(); navigator.clipboard.writeText(invoiceText(current)).then(() => toast('تم النسخ'), () => toast('تعذر النسخ', true)); };
      if ($('#fr')) $('#fr').onclick = () => { buzz(); doReturn(); };
      if ($('#fd')) $('#fd').onclick = () => { buzz(); doDetail(); };
    }

    function whatsapp() {
      const phone = W.rules.normalizePhone(current.invoice.party_phone || '');
      window.open('https://wa.me/' + phone + '?text=' + encodeURIComponent(invoiceText(current)), '_blank');
    }

    async function refresh() { await renderList(); if (current) await select(current.invoice.id); }

    /* ---------- quick-sale details ---------- */
    async function detailLine(inv, line, spec) {
      try {
        await ui.eng.detailQuickLine(inv.id, line.id, spec);
      } catch (e) {
        if (e.code === 'LOSS_NEEDS_CONFIRMATION' && confirm('هذا السطر يُباع بأقل من سعر الشراء. هل تتابع؟')) {
          await ui.eng.detailQuickLine(inv.id, line.id, spec, { allow_loss: true });
        } else throw e;
      }
    }

    async function doDetail() {
      const { invoice: inv, lines } = current;
      for (const l of lines.filter((x) => x.is_generic)) {
        const v = await ask('السطر ' + l.line_no + ' — ' + W.sale.format.qty(l.qty) + '×' + money(l.unit_price_cents), [
          { l: 'رمز المنتج (مثال E4) — أو اتركه فارغًا لمنتج خارجي', n: 'sku' },
          { l: 'اسم المنتج الخارجي', n: 'name' }, { l: 'سعر شراء الخارجي', n: 'buy', m: 'decimal' }], 'حفظ', true, 'تخطي');
        if (!v) break;
        if (v._extra) continue;
        try {
          if (v.sku) {
            const p = await ui.cat.findBySku(v.sku);
            if (!p) { toast('المنتج ' + v.sku + ' غير موجود', true); break; }
            await detailLine(inv, l, { product_id: p.id });
          } else {
            const buy = cents(v.buy || 0);
            if (!v.name || Number.isNaN(buy)) { toast('اكتب اسم المنتج الخارجي وسعر شرائه', true); break; }
            await detailLine(inv, l, { external: { name: v.name, buy_cents: buy } });
          }
        } catch (e) { fail(e); break; }
      }
      refresh();
    }

    /* ---------- returns ---------- */
    const val = (f, x) => (f.endsWith('_cents') ? plain(x) : x);

    async function doReturn() {
      const { invoice: inv, lines } = current;
      const left = lines.filter((l) => l.qty - l.returned_qty > 0);
      if (!left.length) { toast('تم إرجاع كل شيء من هذه الفاتورة', true); return; }
      const v = await ask('إرجاع من الفاتورة ' + inv.number, left.map((l, i) => (
        { l: esc(l.name) + ' (المتبقي ' + W.sale.format.qty(l.qty - l.returned_qty) + ')', n: 'q' + i, m: 'decimal', v: '0' })), 'متابعة', false);
      if (!v) return;
      const items = left.map((l, i) => ({ line_id: l.id, qty: W.sale.toUnits(String(v['q' + i] || '0').replace(',', '.')), name: l.name })).filter((x) => x.qty !== 0);
      if (!items.length) return;
      if (items.some((x) => Number.isNaN(x.qty) || x.qty < 0)) { toast('كمية غير صحيحة', true); return; }
      await submitReturn(inv, items, crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    }

    async function submitReturn(inv, items, ref) {
      const supplier = inv.type === 'purchase';
      try {
        const r = await ui.eng[supplier ? 'returnToSupplier' : 'returnFromCustomer']({
          original_invoice_id: inv.id, client_ref: ref, items: items.map(({ line_id, qty, resolution }) => ({ line_id, qty, resolution })),
        });
        toast('✔ ' + r.invoice.number + ' — المبلغ ' + money(r.refund_cents) + (r.debt_reduced_cents ? ' (خُصم من الدين ' + money(r.debt_reduced_cents) + ')' : ''));
        refresh();
      } catch (e) {
        if (e.code !== 'RETURN_NEEDS_RESOLUTION') { fail(e); return; }
        for (const u of e.details.items) {
          const it = items.find((x) => x.line_id === u.line_id);
          const state = u.status === 'deleted' ? 'محذوف' : u.status === 'missing' ? 'غير موجود' : 'معدَّل';
          const diffs = u.diffs.map((d) => FIELD[d.field] + ': ' + val(d.field, d.was) + ' ← ' + val(d.field, d.now)).join(' • ');
          const cands = u.candidates.length ? ' • مقترحات: ' + u.candidates.slice(0, 4).map((c) => c.sku + ' ' + c.name).join('، ') : '';
          const r = await ask(esc(it.name) + ' — ' + state, [{
            l: esc(diffs) + esc(cands) + '<br>1 = إعادة إدخاله' + (u.reinsert_sku ? ' (' + u.reinsert_sku + ')' : '') + ' • 0 = بدون مخزون • أو رمز منتج موجود',
            n: 'c', v: supplier ? '0' : '1',
          }], 'متابعة', false);
          if (!r) return;
          if (r.c === '1') it.resolution = { action: 'reinsert' };
          else if (r.c === '0') it.resolution = { action: 'no_stock' };
          else {
            let p = null;
            try { p = await ui.cat.findBySku(r.c); } catch (_) { /* invalid sku */ }
            if (!p) { toast('المنتج ' + r.c + ' غير موجود', true); return; }
            it.resolution = { action: 'adapt', product_id: p.id };
          }
        }
        return submitReturn(inv, items, ref);
      }
    }

    $('#fc').onclick = (e) => { const b = e.target.closest('[data-n]'); if (b) { buzz(); filter = FILTERS[+b.dataset.n]; renderList(); } };
    $('#fq').oninput = renderList;
    $('#fl').onclick = (e) => { const r = e.target.closest('.r[data-id]'); if (r) { buzz(); select(r.dataset.id); } };

    ui.store.tx(['settings'], 'readonly', (tx) => tx.all('settings')).then((rows) => {
      settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    }).then(renderList);
  }
})();
