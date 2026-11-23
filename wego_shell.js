/* wego_shell.js — the fixed shell (header + right menu) and the router.
   Screen contract: WeGo.screens[name] = { open(view) }. A screen draws only inside `view` and never computes money.
   Screens that still use the older helper call ui.showScreen(title), which prepares the same area. */
(function () {
  'use strict';
  const W = window.WeGo;
  const ui = W.ui;
  const { $ } = ui;
  W.screens = W.screens || {};

  const MENU = [
    ['الرئيسية', 'home', '#16a34a'], ['فواتير', 'invoices', '#2563eb'], ['شراء', 'purchase', '#d97706'],
    ['ديون الزبناء', 'debts_customer', '#e11d48'], ['مستحقات الموردين', 'debts_supplier', '#0891b2'],
    ['إرجاع من زبون', 'return_customer', '#ea580c'], ['إرجاع للمورد', 'return_supplier', '#c2410c'],
    ['المصاريف', 'expenses', '#7c3aed'], ['المخزون', 'stock', '#0d9488'], ['الصندوق', 'cash', '#ca8a04'],
  ];

  const ROUTES = {
    home: () => W.screens.home.open($('#view')),
    return_customer: () => W.screens.invoices.open('sale'),
    return_supplier: () => W.screens.invoices.open('purchase'),
  };
  for (const [, key] of MENU) if (!ROUTES[key]) ROUTES[key] = () => W.screens[key].open($('#view'));
  ROUTES.admin = () => W.screens.admin.open($('#view'));

  ui.showScreen = (title) => {
    $('#view').innerHTML = '<div id="sh"><b>' + title + '</b><span id="sact"></span></div><div id="sbody"></div>';
    return { body: $('#sbody'), actions: $('#sact') };
  };

  function go(name) {
    document.querySelectorAll('#menu .b').forEach((b) => b.classList.toggle('on', b.dataset.go === name));
    $('#admin').classList.toggle('on', name === 'admin');
    ROUTES[name]();
  }
  ui.go = go;

  (async () => {
    const store = await new W.store.IdbStore(W.schema, 'wego_db').open();
    const cat = await new W.catalog.Catalog(store).init();
    const eng = new W.engine.Engine(store, cat);
    const session = new W.sale.SaleSession({ store, catalog: cat, engine: eng });
    ui.bind({ store, cat, eng, session });
    await ui.reloadCats();
    await ui.loadSettings();
    await session.load();

    $('#menu').innerHTML = MENU.map(([label, key, color]) => '<button class="b" data-go="' + key + '" style="background:' + color + '">' + label + '</button>').join('');
    $('#date').textContent = new Date().toLocaleDateString('en-GB');
    $('#menu').onclick = (e) => { const b = e.target.closest('[data-go]'); if (b) { ui.buzz(); go(b.dataset.go); } };
    $('#admin').onclick = () => { ui.buzz(); go('admin'); };
    go('home');
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  })().catch((e) => { document.body.textContent = 'تعذر تشغيل البرنامج: ' + e.message; });
})();
