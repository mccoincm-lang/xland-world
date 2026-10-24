// Plaxa market check against the local server: citizen A leases a Shoppex unit, builds a shopfront with QuarX and
// lists VegieX they produced; citizen B buys from A in Plaxa; A's shop delivers; both wallets settle once and still
// reconcile with their ledgers. Also checks the server refuses overselling and buying from your own shop.
// To save waiting for seams and harvests, the test gives A some produce directly through the page's own ledger.
// Usage: node test/market.cjs [port] [outDir]
const { chromium } = require("/opt/npm-tools/node_modules/playwright");
const port = process.argv[2] || 8787, out = process.argv[3] || ".";
const base = `http://localhost:${port}/`;
const api = async (key, method, path) => { const r = await fetch(base + "api" + path, { method, headers: { "x-xland-key": key } }); return { status: r.status, body: await r.json() }; };

async function citizen(b, name, vp) {
  const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: vp.width < 500 ? 2 : 1 });
  await ctx.addInitScript(() => { try { localStorage.setItem("xland.introSeen", "1"); } catch (e) {} });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log(name, "PAGE ERROR", e.message));
  await p.goto(base + "#/hotex"); await p.waitForTimeout(1500);
  for (const s of ['[data-act="hx-next"]', '[data-act="hx-next"]']) { await p.locator(s).click(); await p.waitForTimeout(200); }
  await p.fill("#hx-handle", name); await p.locator('[data-act="hx-name"]').click(); await p.waitForTimeout(200);
  await p.locator('[data-act="hx-paths"]').click(); await p.waitForTimeout(200);
  await p.evaluate(() => document.querySelector('[data-act="hx-issue"]').click()); await p.waitForTimeout(1200);
  await hash(p, "#/region/xetropolitan"); await tap(p, '[data-act="visit"][data-id="xetropolitan"]'); await p.waitForTimeout(500);
  return p;
}
const hash = async (p, h, ms = 900) => { await p.evaluate((x) => (location.hash = x), h); await p.waitForTimeout(ms); };
const tap = async (p, sel) => p.evaluate((s) => { const el = document.querySelector(s); if (el) el.click(); return !!el; }, sel);
const wallet = (p) => p.evaluate(() => { const x = window.__xl, s = x.state; return { bux: x.fmtAmt(s.bal.bux), vegiex: x.fmtAmt(s.bal.vegiex), quarx: x.fmtAmt(s.bal.quarx), lockedVeg: x.fmtAmt(s.locked.vegiex), ok: x.reconcile(s) }; });
const toastOf = (p) => p.evaluate(() => (document.querySelector("#toast") || {}).textContent);

(async () => {
  const b = await chromium.launch({ executablePath: "/opt/google/chrome/chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const a = await citizen(b, "Darya", { width: 1440, height: 900 });
  await a.evaluate(async () => { await window.__xl.devCredit("quarx", 6); await window.__xl.devCredit("vegiex", 20); });   // as if mined and harvested
  await hash(a, "#/place/shoppex", 1500); await a.screenshot({ path: `${out}/mk-a-lease.png`, fullPage: true });
  await tap(a, '[data-act="rent"][data-id="shoppex"]'); await a.waitForTimeout(800);
  await a.screenshot({ path: `${out}/mk-a-build.png`, fullPage: true });
  await a.fill("#shop-name", "Darya's Garden"); await tap(a, '[data-act="shop-build"]'); await a.waitForTimeout(1500);
  console.log("A built:", await toastOf(a), await wallet(a));
  await a.selectOption("#ml-asset", "vegiex"); await a.fill("#ml-qty", "8"); await a.fill("#ml-price", "1.5"); await tap(a, '[data-act="mkt-list"]'); await a.waitForTimeout(800);
  console.log("A listed:", await toastOf(a), await wallet(a));
  await a.fill("#ml-qty", "50"); await a.fill("#ml-price", "1.5"); await tap(a, '[data-act="mkt-list"]'); await a.waitForTimeout(400);
  console.log("A over-list refused:", await a.evaluate(() => (document.querySelector("#law-out") || {}).innerText));
  await a.waitForTimeout(3500); await a.screenshot({ path: `${out}/mk-a-shop.png`, fullPage: true });
  const aKey = await a.evaluate(() => localStorage.getItem("xland.key")), aUid = await a.evaluate(() => window.__xl.social.me);
  const ref = await a.evaluate(() => window.__xl.state.listings[0].ref);
  console.log("Own-shop order refused:", (await api(aKey, "POST", `/market/order?oid=o-self1&seller=${aUid}&ref=${ref}&qty=1&price=15000`)).status);

  const bb = await citizen(b, "Kian", { width: 390, height: 844 });
  await hash(bb, "#/place/plaxa", 6000); await bb.screenshot({ path: `${out}/mk-b-plaxa.png`, fullPage: true });
  console.log("B sees shops:", await bb.evaluate(() => [...document.querySelectorAll(".shop-card")].map((e) => e.innerText.replace(/\s+/g, " ").slice(0, 120))));
  const bKey = await bb.evaluate(() => localStorage.getItem("xland.key"));
  console.log("Oversell refused:", (await api(bKey, "POST", `/market/order?oid=o-over1&seller=${aUid}&ref=${ref}&qty=9&price=15000`)).body.error);
  console.log("Wrong price refused:", (await api(bKey, "POST", `/market/order?oid=o-price1&seller=${aUid}&ref=${ref}&qty=1&price=1`)).body.error);
  const before = await wallet(bb);
  await bb.fill(`#mq-${ref}`, "3"); await tap(bb, `[data-act="mkt-buy"][data-id="${ref}"]`); await bb.waitForTimeout(2000);
  console.log("B ordered:", await toastOf(bb), "| before", before, "| after", await wallet(bb));
  await bb.screenshot({ path: `${out}/mk-b-ordered.png`, fullPage: true });
  // A's open page settles the sale on its next market sync (every 15 s)
  for (let i = 0; i < 8; i++) { await a.waitForTimeout(3000); if (await a.evaluate(() => window.__xl.state.ledger.some((e) => e.op.startsWith("mkt-sale-")))) break; }
  console.log("A after sale:", await toastOf(a), await wallet(a));
  await hash(a, "#/place/shoppex", 1500); await a.screenshot({ path: `${out}/mk-a-sold.png`, fullPage: true });
  for (let i = 0; i < 8; i++) { await bb.waitForTimeout(3000); if (await bb.evaluate(() => window.__xl.state.ledger.some((e) => e.op.startsWith("mkt-recv-")))) break; }
  console.log("B after delivery:", await toastOf(bb), await wallet(bb));
  await hash(bb, "#/place/plaxa", 2000); await bb.screenshot({ path: `${out}/mk-b-delivered.png`, fullPage: true });
  const orders = (await api(bKey, "GET", "/market/orders")).body.buying.map((o) => `${o.qty} ${o.asset} ${o.total} ${o.status}`);
  console.log("Server order book for B:", orders);
  console.log("Double fill refused:", (await api(aKey, "POST", `/market/fill?oid=${(await api(bKey, "GET", "/market/orders")).body.buying[0].oid}`)).body.error);
  const w = (await api(bKey, "GET", "/world")).body.market; console.log("World market:", w);
  await hash(a, "#/profile", 1500); await a.screenshot({ path: `${out}/mk-a-passport.png` });
  await hash(bb, "#/place/parx", 2500); await bb.screenshot({ path: `${out}/mk-b-parx.png`, fullPage: true });
  await hash(a, "#/economy", 2500); await a.screenshot({ path: `${out}/mk-a-economy.png`, fullPage: true });
  await b.close();
})();
