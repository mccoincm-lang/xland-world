// Ixeland cooperative check against the local server: Ava founds a cooperative and lists VegieX; it stays closed with two
// members; Bo and Cy join, it opens at three; Dara buys from it in Ixeland; a sixth member is refused.
// Usage: node test/coop.cjs [port] [outDir]
const { chromium } = require("/opt/npm-tools/node_modules/playwright");
const port = process.argv[2] || 8787, out = process.argv[3] || ".";
const base = `http://localhost:${port}/`;
const api = async (key, method, path) => { const r = await fetch(base + "api" + path, { method, headers: { "x-xland-key": key } }); return { status: r.status, body: await r.json() }; };
const hash = async (p, h, ms = 900) => { await p.evaluate((x) => (location.hash = x), h); await p.waitForTimeout(ms); };
const tap = async (p, sel) => p.evaluate((s) => { const el = document.querySelector(s); if (el) el.click(); return !!el; }, sel);
const toastOf = (p) => p.evaluate(() => (document.querySelector("#toast") || {}).textContent);
const wallet = (p) => p.evaluate(() => { const x = window.__xl, s = x.state; return { bux: x.fmtAmt(s.bal.bux), vegiex: x.fmtAmt(s.bal.vegiex), quarx: x.fmtAmt(s.bal.quarx), ok: x.reconcile(s) }; });
async function citizen(b, name, vp, quarx) {
  const ctx = await b.newContext({ viewport: vp || { width: 1280, height: 860 } });
  await ctx.addInitScript(() => { try { localStorage.setItem("xland.introSeen", "1"); } catch (e) {} });
  const p = await ctx.newPage(); p.setDefaultTimeout(120000); p.on("pageerror", (e) => console.log(name, "PAGE ERROR", e.message));
  await p.goto(base + "#/hotex"); await p.waitForTimeout(1500);
  for (const s of ['[data-act="hx-next"]', '[data-act="hx-next"]']) { await tap(p, s); await p.waitForTimeout(300); }
  await p.fill("#hx-handle", name); await tap(p, '[data-act="hx-name"]'); await p.waitForTimeout(300);
  await tap(p, '[data-act="hx-paths"]'); await p.waitForTimeout(300);
  await tap(p, '[data-act="hx-issue"]'); await p.waitForTimeout(1200);
  if (quarx) await p.evaluate((q) => { const x = window.__xl; x.postLedger(x.state, "mine-c" + q, [["quarx", BigInt(q) * x.UNIT]], "test seam"); x.postLedger(x.state, "prod-c" + q, [["vegiex", 10n * x.UNIT]], "test harvest"); x.save(); }, quarx);
  await hash(p, "#/region/ixeland"); await tap(p, '[data-act="visit"][data-id="ixeland"]'); await p.waitForTimeout(500);
  await hash(p, "#/place/commons", 3000);
  return p;
}
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/google/chrome/chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const ava = await citizen(b, "Ava", null, 2);
  await ava.screenshot({ path: `${out}/co-ava-found.png`, fullPage: true });
  await ava.fill("#coop-name", "Aurora Cooperative"); await tap(ava, '[data-act="coop-found"]'); await ava.waitForTimeout(2500);
  console.log("Ava founded:", await toastOf(ava), await wallet(ava));
  await ava.selectOption("#ml-asset", "vegiex"); await ava.fill("#ml-qty", "5"); await ava.fill("#ml-price", "2.5"); await tap(ava, '[data-act="mkt-list"]'); await ava.waitForTimeout(1500);
  console.log("Ava listed:", await toastOf(ava));
  const avaUid = await ava.evaluate(() => window.__xl.social.me), ref = await ava.evaluate(() => window.__xl.state.listings[0].ref), coopId = await ava.evaluate(() => window.__xl.state.shop.coop);
  const bo = await citizen(b, "Bo", null, 1);
  await tap(bo, `[data-act="coop-join"][data-id="${coopId}"]`); await bo.waitForTimeout(2500); console.log("Bo joined:", await toastOf(bo), await wallet(bo));
  await bo.context().close();
  const dara = await citizen(b, "Dara", { width: 390, height: 844 }, 0);
  const daraKey = await dara.evaluate(() => localStorage.getItem("xland.key"));
  console.log("Order while two members:", (await api(daraKey, "POST", `/market/order?oid=o-early1&seller=${avaUid}&ref=${ref}&qty=1&price=25000`)).body.error);
  const cyKey = "c".repeat(40); await api(cyKey, "GET", "/me");   // the third member joins through the API to keep the test light
  console.log("Cy joined:", (await api(cyKey, "POST", `/coop/join?id=${coopId}`)).body.members, "members");
  const coops = (await api(daraKey, "GET", "/coops")).body.coops; console.log("Cooperative:", coops[coopId].name, coops[coopId].members.length, "members");
  await hash(dara, "#/world", 500); await hash(dara, "#/place/commons", 5000);
  await dara.screenshot({ path: `${out}/co-dara-market.png`, fullPage: true });
  await dara.fill(`#mq-${ref}`, "2"); await tap(dara, `[data-act="mkt-buy"][data-id="${ref}"]`); await dara.waitForTimeout(2500);
  console.log("Dara ordered:", await toastOf(dara));
  for (let i = 0; i < 10; i++) { await ava.waitForTimeout(3000); if (await ava.evaluate(() => window.__xl.state.ledger.some((e) => e.op.startsWith("mkt-sale-")))) break; }
  console.log("Ava after sale:", await wallet(ava), await ava.evaluate(() => window.__xl.state.ledger.filter((e) => e.op.startsWith("mkt-fee-")).map((e) => e.to + " " + e.qty)));
  for (let i = 0; i < 10; i++) { await dara.waitForTimeout(3000); if (await dara.evaluate(() => window.__xl.state.ledger.some((e) => e.op.startsWith("mkt-recv-")))) break; }
  console.log("Dara after delivery:", await wallet(dara));
  // Fill the cooperative to five and try a sixth through the API
  const keys = []; for (const n of ["e", "f", "g"]) { const k = n.repeat(40); await api(k, "GET", "/me"); keys.push(k); }
  for (const k of keys) console.log("Join by API:", (await api(k, "POST", `/coop/join?id=${coopId}`)).status);
  await hash(ava, "#/profile", 1500); await ava.screenshot({ path: `${out}/co-ava-passport.png` });
  await b.close();
})();
