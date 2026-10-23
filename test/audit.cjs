// Visits every screen as a fresh tester (after Hotex) and reports page errors, horizontal overflow,
// tiny text and broken artwork references. Usage: node test/audit.cjs [port] [outDir]
const { chromium } = require("/opt/npm-tools/node_modules/playwright");
const fs = require("fs");
const port = process.argv[2] || 8787;
const out = process.argv[3] || "";
const base = `http://localhost:${port}/`;
const PLACES = "xky forgex vaults banx payx worx complex audix confrex muxum artex librariux exes cinex conxert plaxa shoppex storex xarage xtadium parx disxees xcool hoxpital hotex synx hotexx homax satax farmxswap fields civicsite quarx xlab bazaar resort greenx tundraxhomes oracles commons house".split(" ");
const REGIONS = "xetropolitan farmx xalp ximberland aquax xetland xasteland tundrax ixeland xahara".split(" ");
const PARCELS = ["XIM-R-01", "XIM-R-02", "FX-A-01", "FX-A-02", "XET-C-01", "XET-U-01"];
const ROUTES = ["", "hotex", "world", "wallet", "quests", "chronicle", "profile", "economy", "tests", "founder"]
  .map((r) => "#/" + r)
  .concat(REGIONS.map((r) => "#/region/" + r), PLACES.map((p) => "#/place/" + p), PARCELS.map((p) => "#/parcel/" + p));

(async () => {
  const b = await chromium.launch({ executablePath: "/opt/google/chrome/chrome", args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const issues = [];
  for (const [sz, vp] of [["phone", { width: 390, height: 844 }], ["desk", { width: 1440, height: 900 }]]) {
    for (const theme of ["dark", "light"]) {
      const ctx = await b.newContext({ viewport: vp });
      await ctx.addInitScript((t) => { try { localStorage.setItem("xland.introSeen", "1"); localStorage.setItem("xland.theme", t); } catch (e) {} }, theme);
      const p = await ctx.newPage();
      let where = "";
      p.on("pageerror", (e) => issues.push({ sz, theme, where, kind: "error", msg: e.message }));
      p.on("console", (m) => { if (m.type() === "error" && !/ERR_TUNNEL|fonts\.g/.test(m.text())) issues.push({ sz, theme, where, kind: "console", msg: m.text() }); });
      await p.goto(base); await p.waitForTimeout(1500);
      // Become a Hotex guest
      await p.evaluate(() => (location.hash = "#/hotex")); await p.waitForTimeout(300);
      for (const s of ['[data-act="hx-next"]', '[data-act="hx-next"]']) { await p.click(s); await p.waitForTimeout(150); }
      await p.fill("#hx-handle", "audit_" + sz + theme); await p.click('[data-act="hx-name"]'); await p.waitForTimeout(150);
      await p.click('[data-act="hx-paths"]'); await p.waitForTimeout(150);
      await p.click('[data-act="hx-issue"]'); await p.waitForTimeout(500);
      for (const r of ROUTES) {
        where = r;
        await p.evaluate((h) => (location.hash = h), r);
        await p.waitForTimeout(r.startsWith("#/world") || r.startsWith("#/region") ? 900 : 250);
        const res = await p.evaluate(() => {
          const W = window.innerWidth, over = document.scrollingElement.scrollWidth - W;
          const tiny = new Set();
          for (const el of document.querySelectorAll("#app *, .topbar *, .dock *")) {
            if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
            const cs = getComputedStyle(el); if (cs.display === "none" || cs.visibility === "hidden" || el.closest(".scene,.xl-mrz,.map")) continue;
            const fs = parseFloat(cs.fontSize); if (fs < 14) tiny.add((el.className && el.className.baseVal === undefined ? el.className : el.tagName) + ":" + fs.toFixed(1));
          }
          const wide = [...document.querySelectorAll("#app *")].filter((el) => { const r = el.getBoundingClientRect(); return r.right > W + 1 && r.width > 0 && !el.closest(".scene,.rail,.atlas,.tbl,.xl-mrz,.territory-row") ; }).slice(0, 4).map((el) => (el.className && el.className.baseVal === undefined ? el.className : el.tagName) + "@" + Math.round(el.getBoundingClientRect().right));
          const broken = [...document.querySelectorAll("use")].filter((u) => !document.querySelector(u.getAttribute("href"))).length;
          const text = document.querySelector("#app").innerText.trim().length;
          return { over, tiny: [...tiny].slice(0, 6), wide, broken, text };
        });
        if (res.over > 1) issues.push({ sz, theme, where: r, kind: "overflow", msg: res.over + "px " + res.wide.join(" ") });
        if (res.tiny.length) issues.push({ sz, theme, where: r, kind: "tiny", msg: res.tiny.join(" ") });
        if (res.broken) issues.push({ sz, theme, where: r, kind: "artwork", msg: res.broken + " missing sprite refs" });
        if (res.text < 20) issues.push({ sz, theme, where: r, kind: "empty", msg: "almost no content" });
        if (out && /^#\/(place|parcel)\//.test(r) && sz === "phone" && theme === "dark") await p.screenshot({ path: `${out}/${r.slice(2).replace("/", "-")}.png`, fullPage: true });
      }
      await ctx.close();
    }
  }
  const byKind = {};
  for (const i of issues) (byKind[i.kind] ||= []).push(i);
  for (const [k, list] of Object.entries(byKind)) {
    console.log(`\n## ${k} (${list.length})`);
    const seen = new Set();
    for (const i of list) { const key = i.where + i.msg; if (seen.has(key)) continue; seen.add(key); console.log(`${i.sz}/${i.theme} ${i.where}  ${i.msg}`.slice(0, 260)); }
  }
  if (!issues.length) console.log("No issues found.");
  await b.close();
})();
