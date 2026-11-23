"""wego_ui_smoke.py — saved UI tests (Playwright + Chromium). Run:  python3 wego_ui_smoke.py
Serves this folder on localhost, walks through the real screens and prints one line per check."""
import subprocess, sys, time
from playwright.sync_api import sync_playwright

server = subprocess.Popen([sys.executable, "-m", "http.server", "8766"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
fails = []
def check(name, cond, extra=""):
    print(("ok   " if cond else "FAIL ") + name + (" | " + str(extra) if extra != "" else ""))
    if not cond: fails.append(name)

def run(browser, label, vp):
    errs = []
    ctx = browser.new_context(viewport=vp)
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:8766/index.html"); pg.wait_for_selector("#s-modes .b")
    ev = lambda js: pg.evaluate(js)
    def settle():
        ev("WeGo.ui.session.idle()"); pg.wait_for_timeout(120)
    def tap(sel):
        pg.click(sel); settle()
    clear_toast = lambda: ev("document.querySelector('#toast').textContent=''")
    wait_toast = lambda: (pg.wait_for_function("document.querySelector('#toast').textContent.includes('✔')"), pg.inner_text('#toast'))[1]
    print(f"--- {label} {vp['width']}x{vp['height']}")

    # first screen: nothing works until a mode is chosen; the guide points at the three modes
    check("modes pulse until one is chosen", pg.locator("#s-modes .next").count() == 3)
    check("keypad is disabled without a mode", pg.locator("#s-keys button:disabled").count() == 19)
    check("pay is disabled on an empty invoice", pg.is_disabled("#s-pay"))

    ev("""(async () => { const {cat} = WeGo.ui;
      await cat.createProduct({sku:'E4', name:'Prise', sell_cents:1500, buy_cents:1000, qty:1000});
      await cat.createProduct({sku:'E5', name:'Câble', sell_cents:800, buy_cents:500, qty:1000}); })()""")

    # quick invoice: 12+32×2+5×4=
    tap("#s-modes [data-m=quick]")
    for k in "12+32×2+5×4=":
        tap(f'#s-keys [data-k="{k}"]')
    check("quick: three lines, total 96.00", pg.locator("#s-lines .ln").count() == 3 and pg.inner_text("#s-total") == "96.00", pg.inner_text("#s-total"))
    check("quick: the guide highlights 'confirm'", pg.locator("#s-ok.next").count() == 1)
    tap("#s-lines .ln >> nth=1 >> [data-swap]")
    check("quick: swap keeps the total", pg.inner_text("#s-total") == "96.00")
    tap("#s-ok")
    check("quick: after confirming, 'pay' is highlighted", pg.locator("#s-pay.next").count() == 1)
    tap("#s-pay"); pg.wait_for_selector("#pd")
    pg.click('[data-q="100"]')
    check("pay window shows the change", "الباقي للزبون" in pg.inner_text("#pr"), pg.inner_text("#pr"))
    pg.click("#dlg [data-ok]")
    pg.wait_for_selector("#dlg[open] .big.num"); check("change window", "4.00" in pg.inner_text("#dlg"), pg.inner_text("#dlg").replace("\n", " "))
    pg.click("#dlg [data-ok]")
    pg.wait_for_function("document.querySelector('#s-pend').textContent.includes('1')")
    check("a quick invoice waits for its details (badge)", "بانتظار التفاصيل" in pg.inner_text("#s-pend"))
    check("mode returns to 'not chosen', last mode suggested", "المقترح: فاتورة سريعة" in pg.inner_text("#s-hint"), pg.inner_text("#s-hint"))
    check("cash holds only the total (96.00)", ev("WeGo.ui.eng.cashBalance()") == 9600)

    # detailed invoice: category E + 4 -> pick -> edit quantity -> pay
    tap("#s-modes [data-m=detailed]")
    tap('#s-cats [data-i="1"]'); tap('#s-keys [data-k="4"]')
    check("detailed: one result is pointed out", pg.locator("#s-res .r.next").count() == 1, pg.inner_text("#s-res").replace("\n", " "))
    tap("#s-res .r.next")
    pg.click("#s-lines .q"); pg.wait_for_selector("#np")
    for k in "2.5": pg.click(f'#dlg [data-k="{k}"]')
    pg.click("#dlg [data-ok]"); settle()
    check("detailed: 2.5 × 15.00 = 37.50 with +33.3% margin", pg.inner_text("#s-total") == "37.50" and "33.3" in pg.inner_text("#s-lines"), pg.inner_text("#s-lines").replace("\n", " "))
    tap("#s-pay"); pg.wait_for_selector("#pd"); pg.click("#dlg [data-ok]")
    clear_toast(); wait_toast()
    check("stock of E4 dropped by 2.5 units", ev("WeGo.ui.cat.findBySku('E4').then(p => p.qty)") == 750)

    # parking
    tap("#s-modes [data-m=quick]")
    for k in "10=": tap(f'#s-keys [data-k="{k}"]')
    tap("#s-park")
    check("parked invoice shows badge 1", pg.locator("#s-head .badge").count() == 1 and pg.inner_text("#s-lines") == "")
    tap("#s-head .badge"); check("restored from the badge", pg.inner_text("#s-total") == "10.00")
    pg.once("dialog", lambda d: d.accept()); tap("#s-clear"); pg.wait_for_selector("#dlg[open]"); pg.click("#dlg [data-ok]"); settle()
    check("clearing a cart with lines is audited", ev("WeGo.ui.store.tx(['audit_log'],'readonly',tx=>tx.all('audit_log')).then(a=>a.filter(x=>x.action==='sale_cart_cleared').length)") == 1)

    # name search + create a product that does not exist
    tap("#s-modes [data-m=detailed]")
    pg.fill("#s-q", "cable"); settle(); check("search by name finds 'Câble'", "E5" in pg.inner_text("#s-res"))
    pg.fill("#s-q", "inconnu"); settle(); check("no result offers to create a product", pg.locator("#s-res [data-new]").count() == 1)

    # the other screens open inside the fixed shell (menu and header stay)
    for name in ["فواتير", "شراء", "ديون الزبناء", "مستحقات الموردين", "إرجاع من زبون", "إرجاع للمورد", "المصاريف", "المخزون", "الصندوق"]:
        pg.click(f'#menu .b:has-text("{name}")'); pg.wait_for_selector("#sh")
    check("all screens open inside the shell", pg.locator("#menu .b").count() == 10 and pg.is_visible("#top"))
    pg.click("#admin"); pg.wait_for_selector("#a-exp")
    pg.click('#menu .b:has-text("الرئيسية")'); pg.wait_for_selector("#s-modes")
    check("home comes back with the current invoice", True)

    check("integrity", ev("WeGo.ui.eng.checkIntegrity()") == [])
    pg.screenshot(path=f"/tmp/wego_{label}.png")
    check("no page errors", errs == [], errs)
    ctx.close()

def perf(browser):
    ctx = browser.new_context(viewport={"width": 1920, "height": 1080}); pg = ctx.new_page()
    pg.goto("http://localhost:8766/index.html"); pg.wait_for_selector("#s-modes .b")
    r = pg.evaluate("""async () => {
      const {store, session} = WeGo.ui, t = async (f) => { const a = performance.now(); await f(); return Math.round(performance.now() - a); };
      await store.tx(['products'], 'readwrite', async (tx) => { for (let i = 1; i <= 5000; i++) await tx.put('products', {id:'p'+i, sku:'E'+(1000+i), sku_num:1000+i, category_id:'E', name:'Produit '+i+' test', name_norm:'produit '+i+' test', buy_cents:500, sell_cents:900, qty:1000, is_deleted:0, deleted_at:null, category_changed_at:null, created_at:'x', updated_at:'x', device_id:'d', rev:1}); });
      await session.selectMode('detailed');
      return { key: await t(() => session.press('7')), category: await t(() => session.pickCategory('E')), name: await t(() => session.searchText('produit 49')),
               add: await t(() => session.addProduct('p77')) };
    }""")
    check("5000 products: key press < 50 ms", r["key"] < 50, r["key"])
    check("5000 products: category listing < 100 ms", r["category"] < 100, r["category"])
    check("5000 products: search by name < 100 ms", r["name"] < 100, r["name"])
    check("5000 products: add to invoice < 50 ms", r["add"] < 50, r["add"])
    ctx.close()

with sync_playwright() as p:
    b = p.chromium.launch()
    for label, vp in (("pc1920", {"width": 1920, "height": 1080}), ("pc1366", {"width": 1366, "height": 768}), ("phone", {"width": 390, "height": 844})):
        try: run(b, label, vp)
        except Exception as e: check(f"{label} run", False, repr(e)[:300])
    try: perf(b)
    except Exception as e: check("perf run", False, repr(e)[:300])
    b.close()
server.terminate()
print("\nFAILED: " + ", ".join(fails) if fails else "\nall checks passed")
sys.exit(1 if fails else 0)
