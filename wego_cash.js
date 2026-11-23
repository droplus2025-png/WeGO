/* wego_cash.js — expenses and cash. Registers WeGo.screens.expenses and WeGo.screens.cash. */
(function () {
  'use strict';
  const W = window.WeGo;
  W.screens = W.screens || {};
  W.screens.expenses = { open: openExpenses };
  W.screens.cash = { open: openCash };

  const $ = (s) => document.querySelector(s);
  const hhmm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const today = () => W.ui.eng.dayOf(new Date().toISOString());

  /* ---------- expenses ---------- */
  function openExpenses() {
    const ui = W.ui;
    const { ask, toast, fail, esc, money, cents, buzz } = ui;
    const sc = ui.showScreen('المصاريف');
    sc.body.innerHTML =
      '<section class="pn"><div style="display:flex;gap:8px;align-items:center"><button class="b go" id="en" style="color:#111;min-height:56px;font-size:18px">＋ مصروف جديد</button></div>' +
      '<div class="mini" id="ec" style="flex-wrap:wrap"></div><div class="list" id="el"></div>' +
      '<div id="et" class="num" style="font:900 26px system-ui,sans-serif;color:var(--gold)"></div></section>';

    async function render() {
      const all = (await ui.store.tx(['invoices'], 'readonly', (tx) => tx.all('invoices'))).filter((i) => i.type === 'expense');
      const todayRows = all.filter((i) => i.day === today()).sort((a, b) => (a.at < b.at ? 1 : -1));
      const freq = new Map();
      all.forEach((i) => freq.set(i.note, (freq.get(i.note) || 0) + 1));
      const labels = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map((x) => x[0]);
      $('#ec').innerHTML = labels.map((l, i) => '<button class="b" data-l="' + i + '" style="background:#a855f7">' + esc(l) + '</button>').join('');
      render.labels = labels;
      $('#el').innerHTML = todayRows.map((i) =>
        '<div class="ln"><span class="num" style="color:var(--mut)">' + hhmm(i.at) + '</span><span class="nm">' + esc(i.note) + '</span><span class="t num">' + money(i.total_cents) + '</span></div>').join('') ||
        '<div class="r" style="cursor:default;color:var(--mut)">لا مصاريف اليوم</div>';
      $('#et').textContent = 'مجموع اليوم: ' + money(todayRows.reduce((s, i) => s + i.total_cents, 0));
    }

    async function add(label) {
      const fields = (label ? [] : [{ l: 'الوصف', n: 'label' }]).concat([{ l: 'المبلغ', n: 'amt', m: 'decimal' }]);
      const v = await ask(label ? esc(label) : 'مصروف جديد', fields, 'تسجيل', true);
      if (!v) return;
      const amt = cents(v.amt);
      if (Number.isNaN(amt) || amt <= 0) { toast('مبلغ غير صحيح', true); return; }
      try {
        const r = await ui.eng.addExpense({ label: label || v.label, amount_cents: amt });
        toast('✔ ' + r.invoice.number);
        render();
      } catch (e) { fail(e); }
    }

    $('#en').onclick = () => { buzz(); add(null); };
    $('#ec').onclick = (e) => { const b = e.target.closest('[data-l]'); if (b) { buzz(); add(render.labels[+b.dataset.l]); } };
    render();
  }

  /* ---------- cash ---------- */
  function openCash() {
    const ui = W.ui;
    const { ask, toast, fail, esc, money, cents, buzz } = ui;
    const sc = ui.showScreen('الصندوق');
    const card = (t, v, c) => '<div style="background:#071026;border-radius:12px;padding:10px;flex:1;min-width:130px"><small style="color:var(--mut)">' + t +
      '</small><div class="num" style="font:900 22px system-ui,sans-serif;color:' + (c || 'var(--text)') + '">' + v + '</div></div>';

    sc.body.innerHTML =
      '<section class="pn"><div id="cb" class="num" style="font:900 44px system-ui,sans-serif;color:var(--gold)"></div>' +
      '<div id="cs" style="display:flex;gap:8px;flex-wrap:wrap"></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="b pay" id="cc" style="min-height:56px;flex:1">عدّ الإغلاق</button>' +
      '<button class="b op" id="cd" style="min-height:56px">إيداع</button><button class="b go" id="cw" style="color:#111;min-height:56px">سحب</button></div>' +
      '<div style="color:var(--mut);font-size:13px">آخر عمليات العدّ</div><div class="list" id="ch"></div></section>';

    async function render() {
      const balance = await ui.eng.cashBalance();
      const d = await ui.eng.dailyReport(today());
      const counts = (await ui.store.tx(['cash_counts'], 'readonly', (tx) => tx.all('cash_counts'))).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 8);
      $('#cb').textContent = money(balance);
      $('#cs').innerHTML = card('مبيعات اليوم', money(d.sales_cents)) + card('إرجاع', money(d.returns_cents), '#fb7185') + card('مصاريف', money(d.expenses_cents), '#c084fc') +
        card('ربح اليوم (بعد المصاريف)', money(d.profit_cents - d.expenses_cents), '#4ade80') + card('دخل / خرج', money(d.cash_in_cents) + ' / ' + money(d.cash_out_cents));
      $('#ch').innerHTML = counts.map((c) =>
        '<div class="ln"><span class="num" style="color:var(--mut)">' + new Date(c.at).toLocaleDateString('en-GB') + ' ' + hhmm(c.at) + '</span><span class="nm num">' + money(c.counted_cents) +
        '</span><span class="t num" style="color:' + (c.diff_cents ? '#fb7185' : '#4ade80') + '">' + (c.diff_cents > 0 ? '+' : '') + money(c.diff_cents) + '</span></div>').join('') ||
        '<div class="r" style="cursor:default;color:var(--mut)">لا عدّ بعد</div>';
    }

    async function move(kind) {
      const dep = kind === 'deposit';
      const v = await ask(dep ? 'إيداع في الصندوق' : 'سحب من الصندوق', [{ l: 'المبلغ', n: 'amt', m: 'decimal' }, { l: 'ملاحظة', n: 'note' }], 'تأكيد', true);
      if (!v) return;
      const amt = cents(v.amt);
      if (Number.isNaN(amt) || amt <= 0) { toast('مبلغ غير صحيح', true); return; }
      try {
        const r = await (dep ? ui.eng.cashDeposit : ui.eng.cashWithdrawal).call(ui.eng, { amount_cents: amt, note: v.note });
        toast('✔ ' + r.invoice.number);
        render();
      } catch (e) { fail(e); }
    }

    /* The expected amount is not shown before the count (blind count). */
    async function close() {
      const v = await ask('عدّ الصندوق', [{ l: 'المبلغ الموجود فعليًا في الصندوق', n: 'amt', m: 'decimal' }], 'إغلاق', true);
      if (!v) return;
      const amt = cents(v.amt);
      if (Number.isNaN(amt) || amt < 0) { toast('مبلغ غير صحيح', true); return; }
      try {
        const r = await ui.eng.closeCash({ counted_cents: amt });
        toast(r.diff_cents === 0 ? '✔ الصندوق مطابق' : 'الفرق: ' + (r.diff_cents > 0 ? '+' : '') + money(r.diff_cents), r.diff_cents !== 0);
        render();
      } catch (e) { fail(e); }
    }

    $('#cd').onclick = () => { buzz(); move('deposit'); };
    $('#cw').onclick = () => { buzz(); move('withdrawal'); };
    $('#cc').onclick = () => { buzz(); close(); };
    render();
  }
})();
