/* wego_ui.js — the interface kit shared by every screen. No business logic here. */
(function (root) {
  'use strict';

  const W = root.WeGo = root.WeGo || {};
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = W.sale.format.money;
  const plain = (c) => String(c / 100);
  const cents = (v) => Math.round(parseFloat(String(v).replace(',', '.')) * 100);

  const ERRORS = {
    PARTY_REQUIRED: 'الاسم والهاتف إلزاميان عند وجود دين', INVALID_PHONE: 'رقم الهاتف غير صحيح', INVALID_SKU: 'رقم المنتج غير صحيح',
    OVERPAID: 'المبلغ المدفوع أكبر من المجموع', INVALID_NUMBER: 'رقم غير صحيح', INVALID_NAME: 'الاسم مطلوب',
    UNKNOWN_CATEGORY: 'حرف الصنف غير معروف', INSUFFICIENT_STOCK: 'المخزون غير كاف', MODE_LOCKED: 'علّق الفاتورة أو امسحها لتغيير الوضع',
    NEEDS_CONFIRM: 'أكّد الكميات أولًا', ZERO_PRICE: 'يوجد سطر بلا سعر', PARK_FULL: '5 فواتير معلّقة كحد أقصى',
    NOTHING_TO_PARK: 'لا شيء لتعليقه', NO_INVOICE: 'اختر فاتورة سريعة أو مفصّلة', EMPTY_CART: 'لا توجد أسطر',
    PRODUCT_UNAVAILABLE: 'المنتج غير متاح', SKU_TAKEN: 'هذا الرقم مستعمل', CATEGORY_EXISTS: 'هذا الحرف مستعمل',
  };
  const HINTS = {
    CHOOSE_MODE: 'اختر نوع العملية أولًا', DIV0: 'لا يمكن القسمة على صفر', INVALID_EXPRESSION: 'صيغة غير صالحة',
    MIN_QTY: 'الكمية لا تقل عن 1 — استعمل ✕ للحذف', NOT_AVAILABLE: 'غير متاح في هذا الوضع', NOTHING_TO_UNDO: 'لا شيء للتراجع',
  };

  /* ---------- feedback ---------- */
  let beepOn = false;
  let actx = null;
  let toastTimer;

  function buzz() {
    if (navigator.vibrate) navigator.vibrate(8);
    if (!beepOn) return;
    try {
      actx = actx || new (root.AudioContext || root.webkitAudioContext)();
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.frequency.value = 880; g.gain.value = 0.05;
      o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + 0.04);
    } catch (_) { /* no audio available */ }
  }

  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show' + (bad ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, 2600);
  }

  const fail = (e) => toast(ERRORS[e.code] || e.message || 'خطأ', true);

  /* ---------- dialogs ---------- */
  /* build(dialogElement, done): fill the dialog, call done(value) to close it. */
  function modal(build) {
    return new Promise((resolve) => {
      const d = $('#dlg');
      let out = null;
      d.onclick = null;
      d.innerHTML = '';
      build(d, (v) => { out = v; d.close(); });
      d.onclose = () => resolve(out);
      d.showModal();
    });
  }

  /* fields: [{ l, n, v, m, t:'area' }] -> { name: value } or null. `extra` adds a red button -> { _extra: true }. */
  function ask(title, fields, ok, focus, extra) {
    return modal((d, done) => {
      d.innerHTML = '<h3>' + title + '</h3>' + fields.map((f) => '<label>' + f.l + (f.t === 'area'
        ? '<textarea name="' + f.n + '" rows="8"></textarea>'
        : '<input name="' + f.n + '" value="' + esc(f.v == null ? '' : f.v) + '" inputmode="' + (f.m || 'text') + '" autocomplete="off">') + '</label>').join('') +
        '<div class="row"><button class="b pay" data-ok>' + ok + '</button>' + (extra ? '<button class="b del" data-xt>' + extra + '</button>' : '') + '<button class="b ghost" data-no>إلغاء</button></div>';
      d.onclick = (e) => {
        if (e.target.closest('[data-ok]')) done(Object.fromEntries([...d.querySelectorAll('input,textarea')].map((i) => [i.name, i.value.trim()])));
        else if (e.target.closest('[data-xt]')) done({ _extra: true });
        else if (e.target.closest('[data-no]')) done(null);
      };
      if (focus) d.querySelector('input,textarea').focus();
    });
  }

  function confirmBox(text, okLabel) {
    return modal((d, done) => {
      d.innerHTML = '<h3>' + text + '</h3><div class="row"><button class="b pay" data-ok>' + (okLabel || 'متابعة') + '</button><button class="b ghost" data-no>إلغاء</button></div>';
      d.onclick = (e) => { if (e.target.closest('[data-ok]')) done(true); else if (e.target.closest('[data-no]')) done(false); };
    }).then((v) => v === true);
  }

  /* ---------- in-page number pad: no system keyboard for numbers ---------- */
  function padKey(cur, k) {
    if (k === '⌫') return cur.slice(0, -1);
    if (k === 'C') return '';
    if (k === '.') return cur.includes('.') ? cur : (cur === '' ? '0.' : cur + '.');
    if (!/^[0-9]$/.test(k)) return cur;
    if (cur === '0') return k;
    const i = cur.indexOf('.');
    if (i >= 0 && cur.length - i > 2) return cur;
    return cur.length >= 9 ? cur : cur + k;
  }

  function padHTML() {
    const keys = ['7', '8', '9', '⌫', '4', '5', '6', 'C', '1', '2', '3', '.'];
    return '<div class="pad4">' + keys.map((k) => '<button class="b' + (k === '⌫' || k === 'C' ? ' del' : '') + '" data-k="' + k + '">' + k + '</button>').join('') +
      '<button class="b" data-k="0" style="grid-column:span 2">0</button><button class="b pay" data-ok style="grid-column:span 2">تأكيد</button></div>';
  }

  /* -> the typed number as a string, or null when cancelled */
  function numpad({ title, value }) {
    return modal((d, done) => {
      let cur = value || '';
      let fresh = true;     // the first key replaces the shown value instead of appending to it
      d.innerHTML = '<h3>' + esc(title) + '</h3><div class="shown num" id="np">' + (esc(cur) || '0') + '</div>' + padHTML() + '<div class="row"><button class="b ghost" data-no>إلغاء</button></div>';
      d.onclick = (e) => {
        const k = e.target.closest('[data-k]');
        if (k) { buzz(); if (fresh && k.dataset.k !== '⌫') cur = ''; fresh = false; cur = padKey(cur, k.dataset.k); $('#np', d).textContent = cur || '0'; } else if (e.target.closest('[data-ok]')) done(cur === '' ? null : cur);
        else if (e.target.closest('[data-no]')) done(null);
      };
    });
  }

  /* ---------- shared state, set once by the shell ---------- */
  const ui = {
    $, esc, money, plain, cents, ERRORS, HINTS, buzz, toast, fail, modal, ask, confirmBox, numpad, padHTML, padKey,
    store: null, cat: null, eng: null, session: null, _cats: [],
    cats() { return ui._cats; },
    async reloadCats() { ui._cats = await ui.cat.listCategories(); return ui._cats; },
    bind(parts) { Object.assign(ui, parts); },
    async loadSettings() {
      const rows = await ui.store.tx(['settings'], 'readonly', (tx) => tx.all('settings'));
      const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      beepOn = s.beep === 1;
      $('#shop').textContent = s.shop_name || 'WeGo';
      return s;
    },
  };

  W.ui = ui;
})(typeof globalThis !== 'undefined' ? globalThis : this);
