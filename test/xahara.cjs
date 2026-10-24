// Xahara stall check against the local server: Sami opens a free stall, registers a digital work and sells it to Lea,
// who stands in Xahara; the work moves from one wallet to the other once. Lea then puts it back on sale: as a resale it
// carries the anti-flip fee, which the server applies to the order. Usage: node test/xahara.cjs [port] [outDir]
const { chromium } = require("/opt/npm-tools/node_modules/playwright");
const port = process.argv[2] || 8787, out = process.argv[3] || ".";
const base = `http://localhost:${port}/`;
const api = async (key, method, path) => { const r = await fetch(base + "api" + path, { method, headers: { "x-xland-key": key } }); return { status: r.status, body: await r.json() }; };
const hash = async (p, h, ms = 900) => { await p.evaluate((x) => (location.hash = x), h); await p.waitForTimeout(ms); };
const tap = async (p, sel) => p.evaluate((s) => { const el = document.querySelector(s); if (el) el.click(); return !!el; }, sel);
const toastOf = (p) => p.evaluate(() => (document.querySelector("#toast") || {}).textContent);
const items = (p) => p.evaluate(() => window.__xl.state.items.map((i) => `${i.name} (${i.from})`));
async function citizen(b, name, vp) {
  const ctx = await b.newContext({ viewport: vp || { width: 1280, height: 860 } });
  await ctx.addInitScript(() => { try { localStorage.setItem("xland.introSeen", "1"); } catch (e) {} });
  const p = await ctx.newPage(); p.setDefaultTimeout(120000); p.on("pageerror", (e) => console.log(name, "PAGE ERROR", e.message));
  await p.goto(base + "#/hotex"); await p.waitForTimeout(1500);
  for (const s of ['[data-act="hx-next"]', '[data-act="hx-next"]']) { await tap(p, s); await p.waitForTimeout(300); }
  await p.fill("#hx-handle", name); await tap(p, '[data-act="hx-name"]'); await p.waitForTimeout(300);
  await tap(p, '[data-act="hx-paths"]'); await p.waitForTimeout(300);
  await tap(p, '[data-act="hx-issue"]'); await p.waitForTimeout(1200);
  await hash(p, "#/region/xahara"); await tap(p, '[data-act="visit"][data-id="xahara"]'); await p.waitForTimeout(500);
  await hash(p, "#/place/bazaar", 3000);
  return p;
}
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/google/chrome/chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const sami = await citizen(b, "Sami");
  await sami.fill("#shop-name", "Dune Gallery"); await tap(sami, '[data-act="shop-build"][data-id="xahara"]'); await sami.waitForTimeout(2000);
  console.log("Sami opened:", await toastOf(sami), "QuarX:", await sami.evaluate(() => window.__xl.fmtAmt(window.__xl.state.bal.quarx)));
  await sami.fill("#w-title", "Night over the dunes"); await sami.selectOption("#w-kind", "Digital art"); await sami.fill("#w-link", "https://example.org/night-dunes"); await tap(sami, '[data-act="work-add"]'); await sami.waitForTimeout(1000);
  console.log("Sami registered:", await toastOf(sami), await items(sami));
  await sami.fill("#w-title", "Bad"); await sami.fill("#w-link", "javascript:alert(1)"); await tap(sami, '[data-act="work-add"]'); await sami.waitForTimeout(500);
  console.log("Bad link refused:", await sami.evaluate(() => (document.querySelector("#law-out") || {}).innerText.replace(/\s+/g, " ")));
  const itemId = await sami.evaluate(() => window.__xl.state.items[0].id);
  await sami.fill(`#ip-${itemId}`, "15"); await tap(sami, `[data-act="item-list"][data-id="${itemId}"]`); await sami.waitForTimeout(3000);
  console.log("Sami listed:", await toastOf(sami));
  await sami.screenshot({ path: `${out}/xa-sami-stall.png`, fullPage: true });
  const lea = await citizen(b, "Lea", { width: 390, height: 844 });
  await lea.screenshot({ path: `${out}/xa-lea-bazaar.png`, fullPage: true });
  const ref = await sami.evaluate(() => window.__xl.state.listings[0].ref);
  await tap(lea, `[data-act="mkt-buy"][data-id="${ref}"]`); await lea.waitForTimeout(2500); console.log("Lea ordered:", await toastOf(lea));
  for (let i = 0; i < 10; i++) { await sami.waitForTimeout(3000); if (await sami.evaluate(() => window.__xl.state.ledger.some((e) => e.op.startsWith("mkt-sale-")))) break; }
  console.log("Sami after sale:", await sami.evaluate(() => window.__xl.fmtAmt(window.__xl.state.bal.bux)), await items(sami), "reconciles:", await sami.evaluate(() => window.__xl.reconcile(window.__xl.state)));
  for (let i = 0; i < 10; i++) { await lea.waitForTimeout(3000); if (await lea.evaluate(() => window.__xl.state.ledger.some((e) => e.op.startsWith("mkt-recv-")))) break; }
  console.log("Lea after delivery:", await lea.evaluate(() => window.__xl.fmtAmt(window.__xl.state.bal.bux)), await items(lea), "reconciles:", await lea.evaluate(() => window.__xl.reconcile(window.__xl.state)));
  await sami.context().close();
  // Lea resells: the anti-flip fee applies
  await hash(lea, "#/world", 500); await hash(lea, "#/place/bazaar", 3000);
  await lea.fill("#shop-name", "Lea's corner"); await tap(lea, '[data-act="shop-build"][data-id="xahara"]'); await lea.waitForTimeout(2000);
  const leaItem = await lea.evaluate(() => window.__xl.state.items[0].id);
  await lea.fill(`#ip-${leaItem}`, "30"); await tap(lea, `[data-act="item-list"][data-id="${leaItem}"]`); await lea.waitForTimeout(3500);
  await lea.screenshot({ path: `${out}/xa-lea-resale.png`, fullPage: true });
  const leaUid = await lea.evaluate(() => window.__xl.social.me), leaRef = await lea.evaluate(() => window.__xl.state.listings[0].ref);
  const k = ("z" + Date.now().toString(36)).padEnd(40, "z"); await api(k, "GET", "/me");
  await fetch(base + "api/ledger", { method: "POST", headers: { "x-xland-key": k, "content-type": "application/json" }, body: JSON.stringify({ op: "sandbox-grant", kind: "post", lines: [["bux", "10000000"]] }) });   // the buyer's sandbox BuX
  const o = (await api(k, "POST", `/market/order?oid=o-flip${Date.now()}&seller=${leaUid}&ref=${leaRef}&qty=1&price=300000`)).body.order;
  console.log("Resale order fee:", o && `${o.fee} of ${o.total} (${o.fee / o.total * 100}%)`, o && o.meta);
  console.log("Two at once refused:", (await api(k, "POST", `/market/order?oid=o-flip2${Date.now()}&seller=${leaUid}&ref=${leaRef}&qty=1&price=300000`)).body.error);
  await b.close();
})();
