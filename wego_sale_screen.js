/* wego_sale_screen.js — the sale screen (home). A THIN VIEW over WeGo.ui.session (the sale session engine):
   it sends keys and intents, then draws session.state(). It never computes money. */
(function () {
  'use strict';
  const W = window.WeGo;
  W.screens = W.screens || {};
  W.screens.home = { open };

  const COLORS = { DG: '#0ea5e9', E: '#f59e0b', P: '#06b6d4', S: '#ec4899', M: '#b45309', O: '#64748b', EM: '#8b5cf6' };
  const EXTRA = ['#14b8a6', '#f97316', '#84cc16', '#ef4444'];
  const MODES = [['calc', 'حاسبة'], ['quick', 'فاتورة سريعة'], ['detailed', 'فاتورة مفصّلة']];
  const KEYS = [['C', 'del'], ['⌫', 'del'], ['%', 'op'], ['÷', 'op'], ['7'], ['8'], ['9'], ['×', 'op'], ['4'], ['5'], ['6'], ['−', 'op'],
    ['1'], ['2'], ['3'], ['+', 'op'], ['0', 'zero'], ['.'], ['=', 'eq']];

  function guide(st) {
    const a = st.next.action;
    if (a === 'choose_mode') {
      const m = MODES.find((x) => x[0] === st.next.suggest);
      return 'اختر نوع العملية' + (m ? ' — المقترح: ' + m[1] : '');
    }
    if (a === 'type') return st.mode === 'calc' ? 'اكتب العملية الحسابية' : 'اكتب السعر أو السعر×الكمية ثم +';
    if (a === 'equals') return st.mode === 'calc' ? 'اضغط = للنتيجة' : 'اضغط = لإضافة الأسطر';
    if (a === 'confirm') return 'أكّد الكميات (⇄ لتبديل السعر والكمية) ثم ادفع';
    if (a === 'pay') return 'اضغط «دفع»';
    if (a === 'search') return 'اكتب رقم المنتج، أو اختر صنفًا، أو ابحث بالاسم';
    if (a === 'pick_result') return 'المس المنتج المطلوب';
    return 'لا نتيجة — جرّب رقمًا آخر أو أنشئ المنتج';
  }

  function open(view) {
    const ui = W.ui;
    const { $, esc, money, plain, cents, buzz, toast, fail } = ui;
    const sale = ui.session;
    const F = W.sale.format;
    let last = sale.state();

    view.innerHTML =
      '<div class="sale"><div class="cats" id="s-cats"></div><div class="sale-main"><div class="work">' +
      '<div class="modes" id="s-modes"></div><div class="work-body">' +
      '<section class="panel"><div class="inv-head" id="s-head"></div><div class="lines" id="s-lines"></div><div class="confirm" id="s-confirm" hidden></div>' +
      '<div class="inv-foot"><button class="b pay" id="s-pay">دفع</button><div id="s-total" class="num"></div></div></section>' +
      '<section class="panel"><div class="disp"><div id="s-expr" class="num"></div></div><div class="hint" id="s-hint"></div><div class="keys" id="s-keys"></div></section>' +
      '</div></div><aside class="panel find"><div class="searchbar"><button class="b ghost" id="s-kb" title="لوحة المفاتيح">⌨</button>' +
      '<input id="s-q" placeholder="بحث بالاسم" inputmode="none" autocomplete="off"></div><div class="results list" id="s-res"></div><div class="pending" id="s-pend"></div></aside></div></div>';

    /* ---------- drawing ---------- */
    function render(st) {
      last = st;
      const nx = st.next.action;
      const detailed = st.mode === 'detailed';

      $('#s-cats').innerHTML = ui.cats().map((c, i) => {
        const prefix = c.prefix === '' ? '#' : c.prefix;
        const picked = detailed && st.query.picked && (st.query.letter || '#') === prefix;
        return '<button class="b' + (picked ? ' sel' : '') + '" data-i="' + i + '" style="background:' + (COLORS[c.id] || EXTRA[i % EXTRA.length]) + '"' + (detailed ? '' : ' disabled') +
          '><i>' + prefix + '</i><small>' + esc(c.name_ar) + '</small></button>';
      }).join('');

      $('#s-modes').innerHTML = MODES.map(([m, label]) => {
        const suggested = nx === 'choose_mode' && st.next.suggest === m;
        return '<button class="b' + (st.mode === m ? ' sel' : '') + (suggested ? ' pay' : '') + (nx === 'choose_mode' ? ' next' : '') + '" data-m="' + m + '">' + label + '</button>';
      }).join('');

      $('#s-keys').innerHTML = KEYS.map(([k, cls]) => {
        const on = st.mode && (!detailed || /^[0-9⌫C]$/.test(k));
        return '<button class="b ' + (cls || '') + (k === '=' && nx === 'equals' ? ' next' : '') + '" data-k="' + k + '"' + (on ? '' : ' disabled') + '>' + k + '</button>';
      }).join('');

      let text = st.expr;
      if (st.mode === 'calc' && st.result !== null) text = st.result;
      if (detailed) text = st.query.text || (st.query.picked ? (st.query.letter || '#') : st.query.letter) + st.query.digits;
      $('#s-expr').textContent = text || '0';
      $('#s-expr').classList.toggle('dim', !text);
      $('#s-hint').textContent = guide(st);

      $('#s-head').innerHTML =
        st.parked.map((p) => '<button class="b badge" data-slot="' + p.slot + '">' + p.slot + ' · ' + money(p.total) + '</button><button class="b del st" data-drop="' + p.slot + '">✕</button>').join('') +
        '<span style="flex:1"></span><button class="b ghost" id="s-undo"' + (st.can_undo ? '' : ' disabled') + '>↶</button>' +
        '<button class="b go" id="s-park">تعليق</button><button class="b del" id="s-clear"' + (st.lines.length ? '' : ' disabled') + '>مسح</button>';

      $('#s-lines').innerHTML = st.mode === 'calc'
        ? '<div class="r" style="cursor:default;color:var(--mut)">الحاسبة للحساب فقط — لا تُنشئ فاتورة</div>'
        : st.lines.map((l, i) => lineHTML(l, i, st.mode)).join('');

      const conf = $('#s-confirm');
      conf.hidden = !st.needs_confirm;
      conf.innerHTML = st.needs_confirm ? '<span style="flex:1">تأكيد الكميات: لكل سطر السعر×الكمية</span><button class="b pay' + (nx === 'confirm' ? ' next' : '') + '" id="s-ok">تأكيد</button>' : '';

      $('#s-total').textContent = money(st.total);
      const pay = $('#s-pay');
      pay.disabled = !(st.mode === 'quick' || detailed) || !st.lines.length;
      pay.classList.toggle('next', nx === 'pay');

      const q = $('#s-q');
      q.disabled = !detailed;
      q.classList.toggle('next', nx === 'search');
      if (document.activeElement !== q) q.value = st.query.text || '';
      $('#s-res').innerHTML = resultsHTML(st);
      if (st.hint && ui.HINTS[st.hint]) toast(ui.HINTS[st.hint], true);
    }

    function lineHTML(l, i, mode) {
      const cls = 'ln' + (l.generic ? ' gen' : '') + (l.below_cost ? ' loss' : '') + (l.zero_price ? ' zero' : '');
      const base = '<div class="' + cls + '" data-i="' + i + '"><span class="n">' + (i + 1) + '</span>';
      const tail = '<span class="t num">' + money(l.total) + '</span><button class="b x" data-x>✕</button></div>';
      if (mode === 'quick') {
        return base + '<span class="nm">' + esc(l.name) + '</span><span class="num">' + plain(l.price) + '×' + F.qty(l.qty) + '</span><button class="b st at" data-swap>⇄</button>' + tail;
      }
      const chip = l.margin_pct === null ? '' : '<span class="chip' + (l.margin_pct < 0 ? ' neg' : '') + ' num">' + (l.margin_pct > 0 ? '+' : '') + l.margin_pct + '%</span>';
      return base + '<span class="nm">' + esc(l.sku + ' · ' + l.name) + '</span><button class="b st" data-step="-1">−</button><span class="q num" data-edit="q">' + F.qty(l.qty) +
        '</span><button class="b st" data-step="1">+</button><span class="p num" data-edit="p">' + plain(l.price) + '</span>' + chip + tail;
    }

    function resultsHTML(st) {
      if (st.mode !== 'detailed') return '<div class="r" style="cursor:default;color:var(--mut)">اختر «فاتورة مفصّلة» لإضافة منتجات من المخزون</div>';
      if (!st.results.length) {
        const typed = st.query.digits || st.query.text;
        return typed ? '<div class="r new" data-new>＋ إنشاء منتج جديد</div>'
          : '<div class="r" style="cursor:default;color:var(--mut)">اختر صنفًا أو اكتب رقمًا أو ابحث بالاسم</div>';
      }
      return st.results.map((r) => '<div class="r' + (st.next.single === r.id ? ' next' : '') + '" data-id="' + r.id + '"><span class="s num">' + esc(r.sku) + '</span><span class="nm">' + esc(r.name) +
        '</span><span class="p num">' + money(r.price) + '</span><small class="num">Q' + F.qty(r.qty) + 'A' + plain(r.buy) + '</small>' +
        (r.margin_pct === null ? '' : '<span class="chip' + (r.margin_pct < 0 ? ' neg' : '') + ' num">' + r.margin_pct + '%</span>') + '</div>').join('');
    }

    /* ---------- actions ---------- */
    async function act(promise) {
      try { await promise; } catch (e) { fail(e); }
      render(sale.state());
    }

    async function editLine(i, what) {
      const l = last.lines[i];
      const v = await ui.numpad({ title: what === 'q' ? 'الكمية' : 'السعر', value: what === 'q' ? F.qty(l.qty) : plain(l.price) });
      if (v === null) return;
      if (what === 'q') {
        const q = W.sale.toUnits(v);
        if (Number.isNaN(q) || q <= 0) { toast('كمية غير صحيحة', true); return; }
        await act(sale.setLine(i, { qty: q }));
      } else {
        const p = cents(v);
        if (Number.isNaN(p) || p <= 0) { toast('سعر غير صحيح', true); return; }
        await act(sale.setLine(i, { price: p }));
      }
    }

    async function newProduct() {
      const q = last.query;
      const cats = ui.cats();
      const c = cats.find((x) => x.prefix === q.letter) || cats.find((x) => x.prefix === '');
      const v = await ui.ask('منتج جديد — ' + esc(c.name_ar) + (q.digits ? ' (' + (q.letter || '#') + q.digits + ')' : ''), [
        { l: 'اسم المنتج', n: 'name', v: q.text || '' }, { l: 'سعر البيع', n: 'sell', m: 'decimal' }, { l: 'سعر الشراء (اختياري)', n: 'buy', m: 'decimal' }], 'حفظ وإضافة', true);
      if (!v) return;
      try {
        const sku = q.digits ? q.letter + q.digits : undefined;
        const p = await ui.cat.createProduct({ ...(sku ? { sku } : { category_id: c.id }), name: v.name, sell_cents: cents(v.sell || 0), buy_cents: cents(v.buy || 0), qty: 0 });
        await act(sale.addProduct(p.id));
      } catch (e) { fail(e); }
    }

    async function recentCustomers() {
      const rows = await ui.store.tx(['customers'], 'readonly', (tx) => tx.all('customers'));
      return rows.filter((c) => c.name && c.phone).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)).slice(0, 6);
    }

    /* The payment window: amount by in-page pad, quick amounts, live change / debt, customer only when needed. */
    async function payWindow() {
      const recent = await recentCustomers();
      const total = sale.preview().total;
      return ui.modal((d, done) => {
        let typed = '';
        d.innerHTML = '<h3>الدفع</h3><div class="big num">' + money(total) + '</div><div class="shown num" id="pd"></div><div class="chips" id="pq"></div>' +
          '<div class="big" id="pr" style="font-size:1.5rem"></div><div id="pc" hidden><label>اسم الزبون<input name="name" autocomplete="off"></label><label>الهاتف<input name="phone" inputmode="tel" autocomplete="off"></label>' +
          '<div class="chips">' + recent.map((c, i) => '<button class="b ghost" data-c="' + i + '">' + esc(c.name) + '</button>').join('') + '</div></div>' + ui.padHTML() +
          '<div class="row"><button class="b ghost" data-no>إلغاء</button></div>';
        $('#pq', d).innerHTML = '<button class="b" data-q="exact">المبلغ كاملًا</button>' + [20, 50, 100, 200, 500].map((n) => '<button class="b" data-q="' + n + '">' + n + '</button>').join('');
        const paid = () => (typed === '' ? undefined : cents(typed));
        const refresh = () => {
          const pv = sale.preview({ paid_cents: paid() });
          $('#pd', d).textContent = typed === '' ? money(pv.total) : typed;
          $('#pr', d).textContent = pv.change_cents > 0 ? 'الباقي للزبون: ' + money(pv.change_cents) : pv.due_cents > 0 ? 'دين: ' + money(pv.due_cents) : '';
          $('#pr', d).style.color = pv.due_cents > 0 ? '#fb7185' : 'var(--lime)';
          $('#pc', d).hidden = !pv.needs_party;
          return pv;
        };
        refresh();
        d.onclick = (e) => {
          const k = e.target.closest('[data-k]');
          const qk = e.target.closest('[data-q]');
          const ck = e.target.closest('[data-c]');
          if (k) { buzz(); typed = ui.padKey(typed, k.dataset.k); refresh(); } else if (qk) { buzz(); typed = qk.dataset.q === 'exact' ? '' : qk.dataset.q; refresh(); } else if (ck) {
            const c = recent[+ck.dataset.c];
            d.querySelector('[name=name]').value = c.name; d.querySelector('[name=phone]').value = c.phone;
          } else if (e.target.closest('[data-ok]')) {
            const pv = refresh();
            const name = d.querySelector('[name=name]').value.trim();
            const phone = d.querySelector('[name=phone]').value.trim();
            if (pv.needs_party && !(name && phone)) { toast(ui.ERRORS.PARTY_REQUIRED, true); return; }
            done({ paid_cents: pv.paid, customer: pv.needs_party ? { name, phone } : undefined });
          } else if (e.target.closest('[data-no]')) done(null);
        };
      });
    }

    async function pay() {
      const pv = sale.preview();
      if (pv.blocked) { toast(ui.ERRORS[pv.blocked] || 'لا يمكن الدفع الآن', true); return; }
      const res = await payWindow();
      if (!res) return;
      const after = sale.preview({ paid_cents: res.paid_cents });
      if (after.loss_lines.length && !(await ui.confirmBox('السطر ' + after.loss_lines.join('، ') + ' يُباع بأقل من سعر الشراء. هل تتابع؟'))) return;
      try {
        const r = await sale.checkout({ paid_cents: res.paid_cents, customer: res.customer, allow_loss: after.loss_lines.length > 0 });
        render(sale.state());
        if (r.change_cents > 0) {
          await ui.modal((d, done) => {
            d.innerHTML = '<h3>✔ فاتورة ' + esc(r.invoice.number) + '</h3><div class="big" style="font-size:1.4rem">الباقي للزبون</div><div class="big num">' + money(r.change_cents) + '</div><div class="row"><button class="b pay" data-ok>فاتورة جديدة</button></div>';
            d.onclick = (e) => { if (e.target.closest('[data-ok]')) done(true); };
          });
        } else toast('✔ فاتورة ' + r.invoice.number + (r.invoice.due_cents ? ' — دين ' + money(r.invoice.due_cents) : ''));
        refreshPending();
      } catch (e) { fail(e); }
    }

    async function refreshPending() {
      const p = await sale.pendingDetails();
      $('#s-pend').textContent = p.count ? '⚠ ' + p.count + ' فاتورة سريعة بانتظار التفاصيل (' + money(p.total_cents) + ')' : '';
    }

    /* ---------- events ---------- */
    $('#s-modes').onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) { buzz(); act(sale.selectMode(b.dataset.m)); } };
    $('#s-keys').onclick = (e) => { const b = e.target.closest('[data-k]'); if (b) { buzz(); act(sale.press(b.dataset.k)); } };
    $('#s-cats').onclick = (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      buzz();
      const c = ui.cats()[+b.dataset.i];
      act(sale.pickCategory(c.prefix === '' ? '#' : c.prefix));
    };
    $('#s-head').onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      buzz();
      if (b.dataset.slot) await act(sale.restore(+b.dataset.slot));
      else if (b.dataset.drop) { if (await ui.confirmBox('حذف الفاتورة المعلّقة ' + b.dataset.drop + '؟ يُسجَّل ذلك في سجل التدقيق.', 'حذف')) await act(sale.discardParked(+b.dataset.drop, { confirmed: true })); }
      else if (b.id === 's-undo') await act(sale.undo());
      else if (b.id === 's-park') await act(sale.park());
      else if (b.id === 's-clear') { if (await ui.confirmBox('مسح الفاتورة؟ يُسجَّل ذلك في سجل التدقيق.', 'مسح')) await act(sale.clearAll({ confirmed: true })); }
    };
    $('#s-confirm').onclick = (e) => { if (e.target.closest('#s-ok')) { buzz(); act(sale.confirmQuantities()); } };
    $('#s-lines').onclick = (e) => {
      const row = e.target.closest('.ln');
      if (!row) return;
      const i = +row.dataset.i;
      buzz();
      if (e.target.closest('[data-x]')) act(sale.removeLine(i));
      else if (e.target.closest('[data-swap]')) act(sale.swapLine(i));
      else if (e.target.closest('[data-step]')) act(sale.stepQty(i, +e.target.closest('[data-step]').dataset.step));
      else if (e.target.closest('[data-edit]')) editLine(i, e.target.closest('[data-edit]').dataset.edit);
      else if (last.mode === 'quick') act(sale.recallLine(i));
    };
    $('#s-res').onclick = (e) => {
      if (e.target.closest('[data-new]')) { buzz(); newProduct(); return; }
      const r = e.target.closest('[data-id]');
      if (r) { buzz(); act(sale.addProduct(r.dataset.id)); }
    };
    $('#s-q').oninput = (e) => act(sale.searchText(e.target.value));
    $('#s-kb').onclick = () => { buzz(); const q = $('#s-q'); q.setAttribute('inputmode', 'text'); if (!q.disabled) q.focus(); };
    $('#s-pay').onclick = () => { buzz(); pay(); };
    $('#s-pend').onclick = () => ui.go('invoices');

    render(sale.state());
    refreshPending();
  }
})();
