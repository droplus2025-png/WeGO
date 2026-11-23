/* wego_admin.js — administration: shop info, settings, categories, backup / restore, install.
   Registers WeGo.screens.admin. (Owner-only once the PIN codes exist.) */
(function () {
  'use strict';
  const W = window.WeGo;
  W.screens = W.screens || {};
  W.screens.admin = { open };

  let installEvent = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });

  const STORES = Object.keys(W.schema.stores);

  /* FNV-1a: detects a file that was edited or damaged. */
  function fnv(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16);
  }

  function open() {
    const ui = W.ui;
    const { ask, toast, fail, esc, buzz } = ui;
    const $ = (s) => document.querySelector(s);
    const sc = ui.showScreen('الإدارة');
    let s = {};

    sc.body.innerHTML = '<section class="pn"><div class="list" id="ad" style="display:flex;flex-direction:column;gap:10px"></div></section>';

    const card = (title, inner) => '<div style="background:#071026;border-radius:12px;padding:10px"><div style="color:var(--gold);font-weight:700;margin-bottom:8px">' + title + '</div>' + inner + '</div>';
    const btn = (id, label, cls, extra) => '<button class="b ' + (cls || '') + '" id="' + id + '" style="min-height:50px;margin:3px;' + (extra || '') + '">' + label + '</button>';
    const onOff = (v) => (v ? 'مفعّل' : 'متوقف');

    async function save(key, value) {
      await ui.store.tx(['settings'], 'readwrite', (tx) => tx.put('settings', { key, value, updated_at: new Date().toISOString() }));
    }

    async function render() {
      s = await ui.loadSettings();
      const cats = ui.cats();
      $('#ad').innerHTML =
        card('بيانات المحل (تظهر في الفاتورة)', '<div style="line-height:1.8">' + esc(s.shop_name || '— بلا اسم —') + '<br>' + esc(s.shop_address || '') + ' <span class="num">' + esc(s.shop_phone || '') + '</span></div>' + btn('a-shop', 'تعديل', 'op')) +
        card('الحساب', btn('a-pct', 'نسبة ربح البيع السريع: ' + s.quick_sale_profit_pct + '%', 'at') +
          btn('a-cost', 'التكلفة: ' + (s.cost_method === 'wac' ? 'المتوسط المرجّح' : 'آخر سعر شراء'), 'at') +
          btn('a-match', 'سعر الشراء يمنع الإرجاع المباشر: ' + onOff(s.return_match_buy_price === 1), 'at') +
          btn('a-beep', 'صوت الأزرار: ' + onOff(s.beep === 1), 'at')) +
        card('الأصناف', '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">' + cats.map((c) =>
          '<span style="background:var(--key);border-radius:10px;padding:6px 10px"><b class="num" style="color:var(--gold)">' + (c.prefix || '#') + '</b> ' + esc(c.name_ar) + '</span>').join('') + '</div>' + btn('a-cat', '＋ صنف جديد', 'go', 'color:#111')) +
        card('النسخ الاحتياطي', btn('a-exp', 'حفظ نسخة احتياطية', 'pay') + btn('a-imp', 'استعادة من ملف', 'del') +
          '<input type="file" id="a-file" accept=".json,application/json" hidden>') +
        (installEvent ? card('التطبيق', btn('a-inst', 'تثبيت على هذا الجهاز', 'pay')) : '');

      $('#a-shop').onclick = () => { buzz(); editShop(); };
      $('#a-pct').onclick = () => { buzz(); editPct(); };
      $('#a-cost').onclick = () => { buzz(); toggle('cost_method', s.cost_method === 'wac' ? 'last' : 'wac'); };
      $('#a-match').onclick = () => { buzz(); toggle('return_match_buy_price', s.return_match_buy_price === 1 ? 0 : 1); };
      $('#a-beep').onclick = () => { buzz(); toggle('beep', s.beep === 1 ? 0 : 1); };
      $('#a-cat').onclick = () => { buzz(); addCategory(); };
      $('#a-exp').onclick = () => { buzz(); exportAll(); };
      $('#a-imp').onclick = () => { buzz(); $('#a-file').click(); };
      $('#a-file').onchange = (e) => restore(e.target.files[0]);
      if ($('#a-inst')) $('#a-inst').onclick = async () => { installEvent.prompt(); installEvent = null; render(); };
    }

    async function toggle(key, value) { await save(key, value); render(); }

    async function editShop() {
      const v = await ask('بيانات المحل', [
        { l: 'اسم المحل', n: 'name', v: s.shop_name }, { l: 'العنوان', n: 'addr', v: s.shop_address }, { l: 'الهاتف', n: 'phone', v: s.shop_phone, m: 'tel' }], 'حفظ', true);
      if (!v) return;
      await save('shop_name', v.name); await save('shop_address', v.addr); await save('shop_phone', v.phone);
      toast('تم الحفظ'); render();
    }

    async function editPct() {
      const v = await ask('نسبة ربح البيع السريع (%)', [{ l: 'تُحتسب على الأسطر التي بلا تفصيل — من 0 إلى 100', n: 'p', v: String(s.quick_sale_profit_pct), m: 'decimal' }], 'حفظ', true);
      if (!v) return;
      const p = Number(v.p.replace(',', '.'));
      if (v.p === '' || Number.isNaN(p) || p < 0 || p > 100) { toast('نسبة غير صحيحة', true); return; }
      await save('quick_sale_profit_pct', p); render();
    }

    async function addCategory() {
      const v = await ask('صنف جديد', [
        { l: 'الحرف (1 إلى 3 أحرف لاتينية)', n: 'prefix' }, { l: 'الاسم بالعربية', n: 'ar' }, { l: 'الاسم بالفرنسية (اختياري)', n: 'fr' }], 'إضافة', true);
      if (!v) return;
      try {
        await ui.cat.addCategory({ prefix: v.prefix, name_ar: v.ar, name_fr: v.fr });
        await ui.reloadCats();
        toast('تمت إضافة الصنف'); render();
      } catch (e) { toast(e.code === 'CATEGORY_EXISTS' ? 'هذا الحرف مستعمل' : e.code === 'INVALID_PREFIX' ? 'الحرف غير صحيح' : (e.message || 'خطأ'), true); }
    }

    /* ---------- backup ---------- */
    async function exportAll() {
      const data = await ui.store.tx(STORES, 'readonly', async (tx) => {
        const out = {};
        for (const name of STORES) out[name] = await tx.all(name);
        return out;
      });
      const file = { app: 'wego', version: W.schema.version, at: new Date().toISOString(), hash: fnv(JSON.stringify(data)), data };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: 'application/json' }));
      a.download = 'wego_backup_' + file.at.slice(0, 10) + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      toast('تم حفظ النسخة الاحتياطية');
    }

    function check(file) {
      if (!file || file.app !== 'wego' || !file.data) return 'هذا ليس ملف نسخة احتياطية لبرنامج WeGo';
      if (file.version !== W.schema.version) return 'نسخة من إصدار مختلف (' + file.version + ')';
      if (fnv(JSON.stringify(file.data)) !== file.hash) return 'الملف معدَّل أو تالف';
      for (const name of STORES) {
        const rows = file.data[name];
        if (!Array.isArray(rows)) return 'جدول ناقص: ' + name;
        const kp = W.schema.stores[name].keyPath;
        if (rows.some((r) => r[kp] === undefined || r[kp] === null)) return 'سجلات تالفة في: ' + name;
      }
      return null;
    }

    async function restore(f) {
      if (!f) return;
      let file;
      try { file = JSON.parse(await f.text()); } catch (_) { toast('الملف غير قابل للقراءة', true); return; }
      const problem = check(file);
      if (problem) { toast(problem, true); return; }
      const rows = STORES.reduce((n, name) => n + file.data[name].length, 0);
      if (!confirm('ستُستبدل كل بيانات هذا الجهاز بنسخة ' + file.at.slice(0, 10) + ' (' + rows + ' سجل). هل تتابع؟')) return;
      try {
        await ui.store.tx(STORES, 'readwrite', async (tx) => {
          for (const name of STORES) {
            const kp = W.schema.stores[name].keyPath;
            for (const r of await tx.all(name)) await tx.del(name, r[kp]);
            for (const r of file.data[name]) await tx.put(name, r);
          }
        });
        toast('✔ تمت الاستعادة');
        setTimeout(() => location.reload(), 800);
      } catch (e) { fail(e); }
    }

    render();
  }
})();
