// World economy check against the local server: a citizen gets the sandbox BuX (minted against the locked reserve),
// mines a seam in Xalp through the server, collects it, and the world ledger moves. Also checks the server refuses
// early collection and double collection. Usage: node test/economy.cjs [port] [outDir]
const { chromium } = require("/opt/npm-tools/node_modules/playwright");
const port = process.argv[2] || 8787, out = process.argv[3] || ".";
const base = `http://localhost:${port}`;
const api = async (key, method, path) => { const r = await fetch(base + "/api" + path, { method, headers: { "x-xland-key": key } }); return { status: r.status, body: await r.json() }; };

(async () => {
  const before = (await api("k".repeat(40), "GET", "/me")) && (await api("k".repeat(40), "GET", "/world")).body;
  console.log("World before:", JSON.stringify({ mined: before.quarx.mined, epoch: before.quarx.epoch, reward: before.quarx.reward, bux: before.bux }));
  const b = await chromium.launch({ executablePath: "/opt/google/chrome/chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(() => { try { localStorage.setItem("xland.introSeen", "1"); } catch (e) {} });
  const p = await ctx.newPage(); p.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
  const tap = (s) => p.evaluate((x) => { const el = document.querySelector(x); if (el) el.click(); return !!el; }, s);
  const go = async (h, ms = 900) => { await p.evaluate((x) => (location.hash = x), h); await p.waitForTimeout(ms); };
  await p.goto(base + "/#/hotex"); await p.waitForTimeout(1500);
  await tap('[data-act="hx-next"]'); await p.waitForTimeout(200); await tap('[data-act="hx-next"]'); await p.waitForTimeout(200);
  await p.fill("#hx-handle", "Miner"); await tap('[data-act="hx-name"]'); await p.waitForTimeout(200); await tap('[data-act="hx-paths"]'); await p.waitForTimeout(200);
  await tap('[data-act="hx-issue"]'); await p.waitForTimeout(1500);
  const key = await p.evaluate(() => localStorage.getItem("xland.key"));
  const w1 = (await api(key, "GET", "/world")).body;
  console.log("After passport, BuX minted/reserve:", w1.bux.minted, w1.bux.reserve, "(+", w1.bux.minted - before.bux.minted, ")");
  console.log("Second sandbox mint refused:", !(await api(key, "POST", "/bux/sandbox")).body.minted);
  await go("#/region/xalp"); await tap('[data-act="visit"][data-id="xalp"]'); await p.waitForTimeout(600);
  await go("#/place/quarx", 2500); await p.screenshot({ path: `${out}/econ-quarx.png`, fullPage: true });
  await tap('[data-act="mine-start"]'); await p.waitForTimeout(1500);
  const early = await api(key, "POST", "/quarx/claim");
  console.log("Early collect refused:", early.status, early.body.error);
  const seam = await p.evaluate(() => document.querySelector("#activity").innerText.replace(/\s+/g, " ").slice(0, 160));
  console.log("Seam on page:", seam);
  // wait for the seam (60-120 s at difficulty 1)
  for (let i = 0; i < 30; i++) { await p.waitForTimeout(5000); await go("#/place/quarx", 600); if (await p.$('[data-act="mine-claim"]')) break; }
  await tap('[data-act="mine-claim"]'); await p.waitForTimeout(2500);
  console.log("Toast:", await p.evaluate(() => document.querySelector("#toast").textContent));
  const again = await api(key, "POST", "/quarx/claim"); console.log("Double collect refused:", again.status, again.body.error);
  const w2 = (await api(key, "GET", "/world")).body;
  console.log("World mined after:", w2.quarx.mined, "(+", w2.quarx.mined - before.quarx.mined, "units), miners24h:", w2.quarx.miners24h);
  await go("#/place/quarx", 2000); await p.screenshot({ path: `${out}/econ-quarx-after.png`, fullPage: true });
  await go("#/region/xetropolitan"); await tap('[data-act="visit"][data-id="xetropolitan"]'); await go("#/place/banx", 2500); await p.screenshot({ path: `${out}/econ-banx.png`, fullPage: true });
  await go("#/economy", 2500); await p.screenshot({ path: `${out}/econ-ledger.png` });
  await b.close();
})();
