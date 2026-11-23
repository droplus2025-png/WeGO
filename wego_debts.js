/* wego_debts.js — customer debts and supplier dues. Registers WeGo.screens.debts_customer / debts_supplier. */
(function () {
  'use strict';
  const W = window.WeGo;
  W.screens = W.screens || {};
  W.screens.debts_customer = { open: () => open('customer') };
  W.screens.debts_supplier = { open: () => open('supplier') };

  function open(type) {
    const ui = W.ui;
    const { ask, toast, esc, money, plain, cents, buzz } = ui;
    const $ = (s) => document.querySelector(s);
    const customer = type === 'customer';
    const sc = ui.showScreen(customer ? 'ديون الزبناء' : 'مستحقات الموردين');
    let selected = null;      // { party_id, name, phone, total_due_cents }
    let settings = {};

    sc.body.innerHTML =
      '<section class="pn"><div class="list" id="dl"></div><div id="dt" class="num" style="font:900 24px system-ui,sans-serif;color:var(--gold)"></div></section>' +
      '<section class="pn"><div id="dh" style="min-height:48px"></div><div class="list" id="di"></div><div id="da" style="display:flex;gap:8px;flex-wrap:wrap"></div></section>';

    const day = (iso) => new Date(iso).toLocaleDateString('en-GB');

    async function renderList() {
      const rows = await ui.eng.debtSummary(type);
      $('#dl').innerHTML = rows.map((r, i) =>
        '<div class="r" data-i="' + i + '"><span class="s num">' + (i + 1) + '</span><span class="nm">' + esc(r.name || '—') + ' <small class="num">' + esc(r.phone || '') + '</small></span>' +
        '<span class="p num" style="color:#fb7185">' + money(r.total_due_cents) + '</span>' +
        (customer && r.phone ? '<button class="b x" data-w="' + i + '" style="background:var(--ok)">💬</button>' : '') + '</div>').join('') ||
        '<div class="r" style="cursor:default;color:var(--mut)">لا ديون</div>';
      $('#dt').textContent = 'الإجمالي: ' + money(rows.reduce((s, r) => s + r.total_due_cents, 0));
      renderList.rows = rows;
      if (selected) {
        const again = rows.find((r) => r.party_id === selected.party_id);
        if (again) await select(again); else { selected = null; $('#dh').textContent = ''; $('#di').innerHTML = ''; $('#da').innerHTML = ''; }
      }
    }

    async function select(row) {
      selected = row;
      const invoices = (await ui.eng.partyInvoices(type, row.party_id)).filter((i) => i.due_cents > 0)
        .sort((a, b) => (a.at < b.at ? -1 : 1));
      $('#dh').innerHTML = '<b style="font-size:20px">' + esc(row.name) + '</b> <small class="num">' + esc(row.phone || '') + '</small>' +
        '<div class="num" style="font:900 28px system-ui,sans-serif;color:#fb7185;text-align:left">' + money(row.total_due_cents) + '</div>';
      $('#di').innerHTML = invoices.map((i) =>
        '<div class="ln"><span class="num" style="min-width:80px">' + esc(i.number) + '</span><span class="nm num">' + day(i.at) + '</span>' +
        '<span class="num" style="color:var(--mut)">' + money(i.total_cents) + '</span><span class="t num" style="color:#fb7185">' + money(i.due_cents) + '</span></div>').join('');
      $('#da').innerHTML = '<button class="b pay" id="dp" style="min-height:52px;min-width:140px">' + (customer ? 'تحصيل دفعة' : 'دفع للمورد') + '</button>' +
        (customer && row.phone ? '<button class="b op" id="dw" style="min-height:52px">تذكير واتساب</button>' : '');
      $('#dp').onclick = () => { buzz(); pay(); };
      if ($('#dw')) $('#dw').onclick = () => { buzz(); remind(row); };
    }

    async function pay() {
      const row = selected;
      const v = await ask((customer ? 'تحصيل من ' : 'دفع إلى ') + esc(row.name), [
        { l: 'المبلغ (الأقدم أولًا) — الحد الأقصى ' + money(row.total_due_cents), n: 'amt', v: plain(row.total_due_cents), m: 'decimal' }], 'تأكيد', false);
      if (!v) return;
      const amt = cents(v.amt);
      if (Number.isNaN(amt) || amt <= 0) { toast('مبلغ غير صحيح', true); return; }
      try {
        const r = await (customer
          ? ui.eng.receivePayment({ customer_id: row.party_id, amount_cents: amt })
          : ui.eng.paySupplier({ supplier_id: row.party_id, amount_cents: amt }));
        toast('✔ ' + money(amt) + ' — المتبقي ' + money(r.remaining_debt_cents));
        renderList();
      } catch (e) {
        toast(e.code === 'OVERPAYMENT' ? 'المبلغ أكبر من الدين (' + money(e.details.debt) + ')' : (e.message || 'خطأ'), true);
      }
    }

    function remind(row) {
      const text = 'السلام عليكم ' + row.name + '،\nتذكير بالمبلغ المتبقي عليكم: ' + money(row.total_due_cents) + ' ' + (settings.currency || 'DH') + '.\n' +
        (settings.shop_name ? settings.shop_name + '\n' : '') + 'شكرًا لكم';
      window.open('https://wa.me/' + W.rules.normalizePhone(row.phone) + '?text=' + encodeURIComponent(text), '_blank');
    }

    $('#dl').onclick = (e) => {
      const w = e.target.closest('[data-w]');
      if (w) { buzz(); remind(renderList.rows[+w.dataset.w]); return; }
      const r = e.target.closest('.r[data-i]');
      if (r) { buzz(); select(renderList.rows[+r.dataset.i]); }
    };

    ui.store.tx(['settings'], 'readonly', (tx) => tx.all('settings')).then((rows) => {
      settings = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    }).then(renderList);
  }
})();
