// Territory shops and population check against the local server: citizen A opens a farm stand in FarmX (2 QuarX) and a
// trading post is refused for vegetables; citizen B buys at FarmXSwap only while standing in FarmX; the eternal
// House on the River cannot be claimed; region and economy pages show the 21,000,000 population stages.
// Usage: node test/territories.cjs [port] [outDir]
const { chromium } = require("/opt/npm-tools/node_modules/playwright");
const port = process.argv[2] || 8787, out = process.argv[3] || ".";
const base = `http://localhost:${port}/`;
const api = async (key, method, path, body) => { const r = await fetch(base + "api" + path, { method, headers: { "x-xland-key": key, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
const hash = async (p, h, ms = 900) => { await p.evaluate((x) => (location.hash = x), h); await p.waitForTimeout(ms); };
const tap = async (p, sel) => p.evaluate((s) => { const el = document.querySelector(s); if (el) el.click(); return !!el; }, sel);
const visit = async (p, t) => { await hash(p, "#/region/" + t); await tap(p, `[data-act="visit"][data-id="${t}"]`); await p.waitForTimeout(500); };
const toastOf = (p) => p.evaluate(() => (document.querySelector("#toast") || {}).textContent);
const lawOut = (p) => p.evaluate(() => ((document.querySelector("#law-out") || {}).innerText || "").replace(/\s+/g, " "));
const wallet = (p) => p.evaluate(() => { const x = window.__xl, s = x.state; return { bux: x.fmtAmt(s.bal.bux), vegiex: x.fmtAmt(s.bal.vegiex), quarx: x.fmtAmt(s.bal.quarx), ok: x.reconcile(s) }; });
async function citizen(b, name, vp) {
  const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { localStorage.setItem("xland.introSeen", "1"); } catch (e) {} });
  const p = await ctx.newPage(); p.setDefaultTimeout(120000); p.on("pageerror", (e) => console.log(name, "PAGE ERROR", e.message));
  await p.goto(base + "#/hotex"); await p.waitForTimeout(1500);
  for (const s of ['[data-act="hx-next"]', '[data-act="hx-next"]']) { await tap(p, s); await p.waitForTimeout(300); }
  await p.fill("#hx-handle", name); await tap(p, '[data-act="hx-name"]'); await p.waitForTimeout(300);
  await tap(p, '[data-act="hx-paths"]'); await p.waitForTimeout(300);
  await p.evaluate(() => document.querySelector('[data-act="hx-issue"]').click()); await p.waitForTimeout(1200);
  return p;
}
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/google/chrome/chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const a = await citizen(b, "Mahan", { width: 1440, height: 900 });
  await a.evaluate(() => { const x = window.__xl; x.postLedger(x.state, "mine-t2", [["quarx", 4n * x.UNIT]], "test seam"); x.postLedger(x.state, "prod-t2", [["vegiex", 10n * x.UNIT]], "test harvest"); x.save(); });
  await visit(a, "farmx"); await hash(a, "#/place/farmxswap", 2500);
  await a.screenshot({ path: `${out}/tr-a-farm-build.png`, fullPage: true });
  await a.fill("#shop-name", "Mahan's Field"); await tap(a, '[data-act="shop-build"][data-id="farmx"]'); await a.waitForTimeout(1500);
  console.log("A built farm stand:", await toastOf(a), await wallet(a));
  await a.selectOption("#ml-asset", "vegiex"); await a.fill("#ml-qty", "6"); await a.fill("#ml-price", "1.2"); await tap(a, '[data-act="mkt-list"]'); await a.waitForTimeout(1000);
  console.log("A listed:", await toastOf(a), await wallet(a));
  console.log("A cannot list QuarX at a farm stand:", await a.evaluate(() => [...document.querySelectorAll("#ml-asset option")].map((o) => o.value).join(",")));
  await a.waitForTimeout(3000); await a.screenshot({ path: `${out}/tr-a-farm-shop.png`, fullPage: true });
  const aKey = await a.evaluate(() => localStorage.getItem("xland.key"));
  console.log("Claim the House on the River:", (await api(aKey, "PUT", "/doc?c=claims&id=AQX-01", { data: { owner: await a.evaluate(() => window.__xl.social.me) } })).status);
  const w = (await api(aKey, "GET", "/world")).body.market; console.log("World shops:", Object.keys(w.shops).join(","), "shopfronts", w.shopfronts, "QuarX consumed", w.quarxConsumed);

  const bb = await citizen(b, "Nika", { width: 390, height: 844 });
  await visit(bb, "xetropolitan"); await hash(bb, "#/place/plaxa", 4000);
  console.log("B in Plaxa sees farm stand?", await bb.evaluate(() => document.querySelector("#activity").innerText.includes("Mahan's Field")));
  await bb.screenshot({ path: `${out}/tr-b-plaxa.png`, fullPage: true });
  await visit(bb, "farmx"); await hash(bb, "#/place/farmxswap", 4000);
  const ref = await a.evaluate(() => window.__xl.state.listings[0].ref);
  await bb.fill(`#mq-${ref}`, "2"); await tap(bb, `[data-act="mkt-buy"][data-id="${ref}"]`); await bb.waitForTimeout(2000);
  console.log("B ordered at FarmXSwap:", await toastOf(bb));
  await bb.screenshot({ path: `${out}/tr-b-farm.png`, fullPage: true });
  for (let i = 0; i < 8; i++) { await a.waitForTimeout(3000); if (await a.evaluate(() => window.__xl.state.ledger.some((e) => e.op.startsWith("mkt-sale-")))) break; }
  console.log("A after sale (fee 1% to the FarmX treasury):", await wallet(a), await a.evaluate(() => window.__xl.state.ledger.filter((e) => e.op.startsWith("mkt-fee-")).map((e) => e.to + " " + e.qty)));
  for (let i = 0; i < 8; i++) { await bb.waitForTimeout(3000); if (await bb.evaluate(() => window.__xl.state.ledger.some((e) => e.op.startsWith("mkt-recv-")))) break; }
  console.log("B after delivery:", await wallet(bb));
  await hash(bb, "#/region/xetropolitan", 2500); await bb.screenshot({ path: `${out}/tr-b-region.png`, fullPage: true });
  await hash(a, "#/region/xasteland", 2500); console.log("Xasteland:", await a.evaluate(() => (document.querySelector(".pop-card") || {}).innerText));
  await hash(a, "#/region/aquax", 2500); console.log("Aquax:", await a.evaluate(() => (document.querySelector(".pop-card") || {}).innerText));
  await hash(a, "#/economy", 3000); await a.evaluate(() => { const h = [...document.querySelectorAll("h2")].find((x) => /21,000,000/.test(x.textContent)); h && h.scrollIntoView(); }); await a.waitForTimeout(800); await a.screenshot({ path: `${out}/tr-a-economy.png` });
  await hash(a, "#/profile", 1500); await a.screenshot({ path: `${out}/tr-a-passport.png` });
  await b.close();
})();
