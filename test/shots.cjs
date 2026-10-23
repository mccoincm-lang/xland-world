// Screenshots every screen of the page served by test/dev-server.mjs, on phone and desktop, in both themes.
// Also walks Hotex to issue a passport, selects a territory and a place, and runs the built-in self-tests.
// Usage: node test/shots.cjs <outDir> [port] [filter]
const { chromium } = require("/opt/npm-tools/node_modules/playwright");
const fs = require("fs");
const out = process.argv[2] || "shots";
const port = process.argv[3] || 8787;
const only = process.argv[4] || "";
const base = `http://localhost:${port}/`;
fs.mkdirSync(out, { recursive: true });

const sizes = { desk: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };

(async () => {
  const b = await chromium.launch({
    executablePath: "/opt/google/chrome/chrome",
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const report = [];
  for (const theme of ["dark", "light"]) {
    for (const [sz, vp] of Object.entries(sizes)) {
      const tag = `${sz}-${theme}`;
      if (only && !tag.includes(only)) continue;
      const ctx = await b.newContext({ viewport: vp, deviceScaleFactor: sz === "phone" ? 2 : 1 });
      await ctx.addInitScript((t) => {
        try {
          localStorage.setItem("xland.introSeen", "1");
          localStorage.setItem("xland.theme", t);
        } catch (e) {}
      }, theme);
      const p = await ctx.newPage();
      const errs = [];
      p.on("pageerror", (e) => errs.push("PAGEERR " + e.message));
      p.on("console", (m) => m.type() === "error" && errs.push(m.text()));
      const shot = async (name, full = false) => {
        await p.waitForTimeout(900);
        await p.screenshot({ path: `${out}/${tag}-${name}.png`, fullPage: full });
      };
      const go = async (hash) => {
        await p.evaluate((h) => (location.hash = h), hash);
        await p.waitForTimeout(400);
      };
      const act = async (sel) => {
        const el = await p.$(sel);
        if (!el) throw new Error("missing " + sel);
        await el.click();
        await p.waitForTimeout(250);
      };
      await p.goto(base);
      await p.waitForTimeout(2500);
      await shot("landing");
      await shot("landing-full", true);
      // Hotex: arrival → orientation → name → paths → passport
      await go("#/hotex");
      await shot("hotex-1");
      await act('[data-act="hx-next"]');
      await shot("hotex-2");
      await act('[data-act="hx-next"]');
      await p.fill("#hx-handle", "quarx_walker");
      await act('[data-act="hx-name"]');
      await act('[data-act="hx-path"][data-path="Builder"]');
      await act('[data-act="hx-path"][data-path="Explorer"]');
      await p.selectOption("#hx-aff", "ixeland");
      await shot("hotex-4");
      await act('[data-act="hx-paths"]');
      await shot("hotex-5", true);
      await act('[data-act="hx-issue"]');
      await p.waitForTimeout(800);
      await go("#/world");
      await p.waitForTimeout(2500);
      await shot("world");
      const sel = sz === "phone" ? '#rail button[data-id="xalp"]' : '.rlist button[data-id="xalp"]';
      await act(sel);
      await p.waitForTimeout(1600);
      await shot("world-xalp");
      if (sz === "phone") await shot("world-xalp-full", true);
      await go("#/region/xalp");
      await p.waitForTimeout(1500);
      await shot("region-xalp", true);
      await go("#/place/fields");
      await shot("place-fields", true);
      for (const r of ["wallet", "quests", "chronicle", "profile"]) {
        await go("#/" + r);
        await shot(r, true);
      }
      await go("#/tests");
      await p.waitForTimeout(500);
      const tests = await p.evaluate(() => document.querySelector("#app").innerText.slice(0, 400));
      report.push({ tag, errors: errs, tests: tests.split("\n").slice(0, 4).join(" | ") });
      await ctx.close();
    }
  }
  fs.writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await b.close();
})();
