// Living map check: citizen A buys a Homax parcel in Ximberland; citizen B then sees A's land and the
// parcels still for sale on the shared map, opens one from the map, and the territory label shows who is there.
// Usage: node test/map.cjs [port] [outDir]
const { chromium } = require("/opt/npm-tools/node_modules/playwright");
const port = process.argv[2] || 8787, out = process.argv[3] || ".";
const base = `http://localhost:${port}/`;

async function citizen(b, name, vp) {
  const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: vp.width < 500 ? 2 : 1 });
  await ctx.addInitScript(() => { try { localStorage.setItem("xland.introSeen", "1"); } catch (e) {} });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log(name, "PAGE ERROR", e.message));
  await p.goto(base + "#/hotex"); await p.waitForTimeout(1500);
  for (const s of ['[data-act="hx-next"]', '[data-act="hx-next"]']) { await p.locator(s).click(); await p.waitForTimeout(200); }
  await p.fill("#hx-handle", name); await p.locator('[data-act="hx-name"]').click(); await p.waitForTimeout(200);
  await p.locator('[data-act="hx-paths"]').click(); await p.waitForTimeout(200);
  await p.evaluate(() => document.querySelector("[data-act=\"hx-issue\"]").click()); await p.waitForTimeout(800);
  return p;
}
const hash = async (p, h, ms = 900) => { await p.evaluate((x) => (location.hash = x), h); await p.waitForTimeout(ms); };
const tap = async (p, sel) => p.evaluate((s) => { const el = document.querySelector(s); if (el) el.click(); return !!el; }, sel);

(async () => {
  const b = await chromium.launch({ executablePath: "/opt/google/chrome/chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  // A buys XIM-R-03
  const a = await citizen(b, "Arash", { width: 1440, height: 900 });
  await hash(a, "#/region/ximberland"); await tap(a, '[data-act="visit"][data-id="ximberland"]'); await a.waitForTimeout(600);
  await hash(a, "#/parcel/XIM-R-03"); await a.screenshot({ path: `${out}/map-a-deed.png`, fullPage: true });
  const bought = await tap(a, '[data-act="parcel-buy"][data-id="XIM-R-03"]'); await a.waitForTimeout(2500);
  console.log("A bought:", bought, await a.evaluate(() => (document.querySelector("#toast") || {}).textContent));
  await hash(a, "#/world", 3000); await a.context().close();
  // B looks at the shared map
  const bb = await citizen(b, "Bahar", { width: 1440, height: 900 });
  await hash(bb, "#/world", 3500); await bb.screenshot({ path: `${out}/map-b-world.png` });
  await tap(bb, '.rlist button[data-id="ximberland"]'); await bb.waitForTimeout(3500);
  await bb.screenshot({ path: `${out}/map-b-ximberland.png` });
  const labels = await bb.evaluate(() => [...document.querySelectorAll(".pl.plot:not(.hide)")].map((e) => e.className + " | " + e.textContent));
  console.log("Visible plot labels for B:", labels.length, labels.slice(0, 8));
  const tl = await bb.evaluate(() => [...document.querySelectorAll(".tl span")].map((s) => s.textContent).filter((t) => /here now/.test(t)));
  console.log("Territory notes:", tl);
  // B opens a parcel for sale from the map
  const opened = await bb.evaluate(() => { const el = document.querySelector(".pl.plot.sale:not(.hide)") || document.querySelector(".pl.plot.sale"); if (el) el.click(); return el && el.dataset.parcel; });
  await bb.waitForTimeout(2500); await bb.screenshot({ path: `${out}/map-b-parcel.png` });
  console.log("B opened:", opened, "| panel:", (await bb.evaluate(() => document.querySelector("#world-panel").innerText)).replace(/\s+/g, " ").slice(0, 220));
  const held = await bb.evaluate(() => { const el = document.querySelector(".pl.plot.held"); if (el) el.click(); return el && el.textContent; });
  await bb.waitForTimeout(2000); await bb.screenshot({ path: `${out}/map-b-held.png` });
  console.log("B sees held:", held, "| panel:", (await bb.evaluate(() => document.querySelector("#world-panel").innerText)).replace(/\s+/g, " ").slice(0, 160));
  // Phone view of the same
  const c = await citizen(b, "Cyrus", { width: 390, height: 844 });
  await hash(c, "#/world", 3000); await tap(c, '#rail button[data-id="ximberland"]'); await c.waitForTimeout(3500);
  await c.evaluate(() => { const el = [...document.querySelectorAll(".pl.plot.sale")].find((e) => e.dataset.parcel.startsWith("XIM")); el && el.click(); }); await c.waitForTimeout(2500); await c.screenshot({ path: `${out}/map-c-phone.png` });
  await b.close();
})();
