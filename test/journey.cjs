// Plays the first-steps journey of a new tester on a phone, the way the guide leads them:
// Hotex → map → FarmX fields (harvest) → FarmXSwap (sell) → Journal (mission) → Passport,
// then mines QuarX in Xalp. Reports what happened at each step and any errors.
// Usage: node test/journey.cjs [port] [outDir]
const { chromium } = require("/opt/npm-tools/node_modules/playwright");
const port = process.argv[2] || 8787;
const out = process.argv[3] || "";
const vp = process.argv[4] === "desk" ? { width: 1440, height: 900 } : { width: 390, height: 844 };

(async () => {
  const b = await chromium.launch({ executablePath: "/opt/google/chrome/chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => { try { localStorage.setItem("xland.introSeen", "1"); } catch (e) {} });
  const p = await ctx.newPage();
  const log = [], errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  let n = 0;
  const step = async (name) => {
    await p.waitForTimeout(500);
    const info = await p.evaluate(() => ({
      toast: (document.querySelector("#toast.show") || {}).textContent || "",
      guide: (document.querySelector("#guide") || {}).innerText || "",
      h: [...document.querySelectorAll("#app h1, #app h2")].slice(0, 3).map((x) => x.innerText).join(" | "),
    }));
    log.push(`${++n}. ${name}\n   heading: ${info.h}\n   toast: ${info.toast}\n   guide: ${info.guide.replace(/\s+/g, " ").slice(0, 140)}`);
    if (out) await p.screenshot({ path: `${out}/j${String(n).padStart(2, "0")}-${name.replace(/\W+/g, "-").slice(0, 30)}.png` });
  };
  const go = async (h) => { await p.evaluate((x) => (location.hash = x), h); await p.waitForTimeout(700); };
  const click = async (sel) => {
    await p.waitForTimeout(250);
    try { await p.locator(sel).first().click({ timeout: 4000 }); }
    catch (e) {
      const why = await p.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return "not on the page"; const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return `at y=${Math.round(r.y)} h=${Math.round(r.height)}; on top: ${top ? (top.className || top.tagName) : "nothing (off screen)"}`; }, sel);
      const forced = await p.evaluate((sel) => { const el = document.querySelector(sel); if (el) { el.click(); return true; } return false; }, sel); await p.waitForTimeout(500);
      log.push(`   !! could not tap ${sel} like a person (${forced ? 'clicked it directly instead' : 'not there'}): ${why}\n      `); return forced; }
    await p.waitForTimeout(400); return true;
  };

  try {
  await p.goto(`http://localhost:${port}/`); await p.waitForTimeout(2500); await step("landing");
  await click('a[href="#/hotex"]'); await step("hotex arrival");
  await click('[data-act="hx-next"]'); await click('[data-act="hx-next"]');
  await p.fill("#hx-handle", "Sara"); await click('[data-act="hx-name"]');
  await click('[data-act="hx-path"][data-path="Merchant"]'); await p.selectOption("#hx-aff", "farmx");
  await click('[data-act="hx-paths"]'); await step("hotex passport");
  await click('[data-act="hx-issue"]'); await step("after passport");
  await go("#/world"); await p.waitForTimeout(1500);
  await click('#rail button[data-id="farmx"], .rlist button[data-id="farmx"]'); await p.waitForTimeout(800); await step("selected FarmX");
  await click('#rail button[data-id="xalp"], .rlist button[data-id="xalp"]'); await p.waitForTimeout(800);
  await go("#/region/farmx"); await click('[data-act="visit"][data-id="farmx"]'); await step("visited FarmX");
  await go("#/place/fields"); await step("fields");
  await click('[data-act="prod-start"][data-id="vegiex"]'); await step("harvest started");
  log.push("   (waiting 46 s for the crops)"); await p.waitForTimeout(46500);
  await go("#/world"); await go("#/place/fields"); await step("fields ready");
  await click('[data-act="prod-claim"]'); await step("harvested");
  await go("#/place/farmxswap"); await step("farmxswap");
  await p.fill("#sw-amt", "12", { timeout: 5000 }); await p.dispatchEvent("#sw-amt", "input"); await p.waitForTimeout(300);
  await click('[data-act="sw-confirm"]'); await click('[data-act="sw-confirm"]'); await step("sold");
  await go("#/quests"); await step("journal");
  await click('[data-act="m-accept"], [data-act="d-accept"]'); await step("mission accepted");
  await go("#/profile"); await step("passport page");
  await go("#/wallet"); await step("wallet");
  await go("#/region/xalp"); await click('[data-act="visit"][data-id="xalp"]'); await go("#/place/quarx"); await step("quarx mine");
  await click('[data-act="mine-start"]'); await step("mining started");
  await go("#/chronicle"); await step("chronicle");
  } catch (e) { log.push("   !! STOPPED: " + e.message.split("\n")[0]); await step("stopped here"); }
  console.log(log.join("\n"));
  console.log("\nErrors:", errors.length ? errors : "none");
  await b.close();
})();
