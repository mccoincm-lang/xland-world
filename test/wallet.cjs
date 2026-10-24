// Server wallet check against the local server. A new citizen's wallet lives on the server and the page follows it;
// forged credits, prices above the market rate, presale beyond the cap and overspending are refused; a harvest timed by
// the server and a sale at FarmXSwap move the official wallet; a tampered page is aligned back to the server; an alpha
// citizen's balances are carried over once, within caps. Usage: node test/wallet.cjs [port] [outDir]
const { chromium } = require("/opt/npm-tools/node_modules/playwright");
const port = process.argv[2] || 8787, out = process.argv[3] || ".";
const base = `http://localhost:${port}/`;
const api = async (key, method, path, body) => { const r = await fetch(base + "api" + path, { method, headers: { "x-xland-key": key, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
const tap = async (p, sel) => p.evaluate((s) => { const el = document.querySelector(s); if (el) el.click(); return !!el; }, sel);
const hash = async (p, h, ms = 1200) => { await p.evaluate((x) => (location.hash = x), h); await p.waitForTimeout(ms); };
const local = (p) => p.evaluate(() => { const x = window.__xl, s = x.state; return { bux: s.bal.bux, vegiex: s.bal.vegiex, outbox: (s.outbox || []).length, ok: x.reconcile(s) }; });
const sync = (p) => p.evaluate(async () => { await new Promise((r) => setTimeout(r, 1500)); });
async function citizen(b, name, init) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(init || (() => { try { localStorage.setItem("xland.introSeen", "1"); } catch (e) {} }));
  const p = await ctx.newPage(); p.setDefaultTimeout(120000); p.on("pageerror", (e) => console.log(name, "PAGE ERROR", e.message));
  await p.goto(base + "#/hotex"); await p.waitForTimeout(1500);
  return p;
}
async function passport(p, name) {
  for (const s of ['[data-act="hx-next"]', '[data-act="hx-next"]']) { await tap(p, s); await p.waitForTimeout(300); }
  await p.fill("#hx-handle", name); await tap(p, '[data-act="hx-name"]'); await p.waitForTimeout(300);
  await tap(p, '[data-act="hx-paths"]'); await p.waitForTimeout(300); await tap(p, '[data-act="hx-issue"]'); await p.waitForTimeout(4000);
}
(async () => {
  const b = await chromium.launch({ executablePath: "/opt/google/chrome/chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const p = await citizen(b, "Wally"); await passport(p, "Wally");
  const key = await p.evaluate(() => localStorage.getItem("xland.key"));
  let w = (await api(key, "GET", "/wallet")).body; console.log("New citizen, server BuX:", w.bal.bux, "| page:", await local(p));
  const post = async (body) => { const r = await api(key, "POST", "/ledger", body); return r.status + " " + (r.body.error || r.body.why || (r.body.dup ? "dup" : "ok")); };
  console.log("Forged BuX:", await post({ op: "cheat-1", kind: "post", lines: [["bux", "10000000"]] }));
  console.log("Forged seam:", await post({ op: "mine-fake1", kind: "post", lines: [["quarx", "10000"]] }));
  console.log("Forged sale:", await post({ op: "mkt-sale-fake", kind: "post", lines: [["bux", "10000"]] }));
  console.log("Sell above rate:", await post({ op: "swap-forgex-cheat", kind: "post", lines: [["vegiex", "-10000"], ["bux", "990000"]] }));
  console.log("Buy below rate:", await post({ op: "swap-forgex-cheat2", kind: "post", lines: [["bux", "-10000"], ["quarx", "10000"]] }));
  console.log("Presale beyond cap:", await post({ op: "presale-cheat", kind: "post", lines: [["bux", "-1800000"], ["quarx", "60000"]] }));
  console.log("Overspend:", await post({ op: "rent-cheat", kind: "post", lines: [["bux", "-999999999"]] }));
  console.log("Unlock what is not locked:", await post({ op: "build-unlock-cheat", kind: "lock", lk: "UNLOCK", asset: "quarx", qty: "10000" }));
  console.log("Valid spend:", await post({ op: "rent-test-1", kind: "post", lines: [["bux", "-10000"]] }), "| again:", await post({ op: "rent-test-1", kind: "post", lines: [["bux", "-10000"]] }));
  // A harvest timed by the server, then a sale at FarmXSwap through the page
  await hash(p, "#/region/farmx"); await tap(p, '[data-act="visit"][data-id="farmx"]'); await hash(p, "#/place/fields", 1500);
  await tap(p, '[data-act="prod-start"][data-id="vegiex"]'); await p.waitForTimeout(1500);
  console.log("Early claim:", (await api(key, "POST", "/farm/claim")).body.error);
  await p.waitForTimeout(46000); await hash(p, "#/world", 500); await hash(p, "#/place/fields", 1500);
  await tap(p, '[data-act="prod-claim"]'); await p.waitForTimeout(3000);
  w = (await api(key, "GET", "/wallet")).body; console.log("After harvest, server VegieX:", w.bal.vegiex, "| page:", await local(p));
  await hash(p, "#/place/farmxswap", 1500); await p.fill("#sw-amt", "10"); await p.dispatchEvent("#sw-amt", "input"); await p.waitForTimeout(300);
  await tap(p, '[data-act="sw-confirm"]'); await p.waitForTimeout(400); await tap(p, '[data-act="sw-confirm"]'); await p.waitForTimeout(4000);
  w = (await api(key, "GET", "/wallet")).body; console.log("After selling 10 VegieX, server:", w.bal.bux, w.bal.vegiex, "| page:", await local(p));
  // Tampering on the page is refused by the server and aligned back
  await p.evaluate(() => { const x = window.__xl; x.postLedger(x.state, "gift-to-myself", [["bux", 500n * x.UNIT]], "tamper"); x.save(); });
  await p.waitForTimeout(6000); await p.evaluate(() => window.__xl.state.walletLog);
  console.log("After tampering, page:", await local(p), "| server BuX:", (await api(key, "GET", "/wallet")).body.bal.bux, "| refused:", await p.evaluate(() => (window.__xl.state.walletLog || []).map((l) => l.op + ": " + l.why)));
  await hash(p, "#/wallet", 1500); await p.screenshot({ path: `${out}/wallet-page.png` });
  // An alpha citizen: balances from before the server wallet are carried over once, within caps
  const legacyKey = ("L" + Date.now().toString(36)).padEnd(40, "x"); await api(legacyKey, "GET", "/me");
  console.log("Import beyond caps:", JSON.stringify((await api(legacyKey, "POST", "/wallet/import", { legacy: true, bal: { bux: "99999999999", quarx: "70000" } })).body.bal));
  console.log("Second import:", (await api(legacyKey, "POST", "/wallet/import", { legacy: true, bal: { bux: "10000" } })).status);
  // The same through a page: an alpha state (no walletV) with 1,234 BuX on a new device key
  const tpl = await p.evaluate(() => localStorage.getItem("xland.proto.v1"));
  const st = JSON.parse(tpl); delete st.walletV; st.outbox = []; st.bal.bux = "12340000"; st.ledger.push({ op: "alpha-legacy", event: "GRANT", asset: "bux", delta: String(12340000 - Number(JSON.parse(tpl).bal.bux)), qty: "0", from: "x", to: "player", at: Date.now() });
  const alphaKey = ("A" + Date.now().toString(36)).padEnd(40, "y");
  const a2ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  await a2ctx.addInitScript(([s1, k]) => { try { localStorage.setItem("xland.introSeen", "1"); if (!sessionStorage.getItem("seeded")) { localStorage.setItem("xland.proto.v1", s1); localStorage.setItem("xland.key", k); sessionStorage.setItem("seeded", "1"); } } catch (e) {} }, [JSON.stringify(st), alphaKey]);
  const a2 = await a2ctx.newPage(); a2.on("pageerror", (e) => console.log("Alpha PAGE ERROR", e.message));
  await a2.goto(base + "#/wallet"); await a2.waitForTimeout(6000);
  console.log("Alpha carried over, server BuX:", (await api(alphaKey, "GET", "/wallet")).body.bal.bux, "| page:", await local(a2), "| walletV:", await a2.evaluate(() => window.__xl.state.walletV));
  await b.close();
})();
