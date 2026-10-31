// Local stand-in for Cloudflare: runs src/worker.js with an in-memory SQLite database as D1.
// Usage: node test/dev-server.mjs [port]
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.argv[2] || 8787);

// Re-import the worker only when its files change (each import is a new module that is never freed).
import { statSync } from "node:fs";
let cached = null, cachedKey = "";
function loadWorker() {
  const key = ["dist/index.html", "dist/forge.html", "src/worker.js", "src/world.json"].map((f) => statSync(root + f).mtimeMs).join("|");
  if (cached && key === cachedKey) return cached;
  cachedKey = key;
  return (cached = loadWorkerFresh());
}
function loadWorkerFresh() {
  const html = readFileSync(root + "dist/index.html", "utf8");
  const src = readFileSync(root + "src/worker.js", "utf8").replace(
    'import HTML from "../dist/index.html";',
    "const HTML = " + JSON.stringify(html) + ";",
  ).replace('import FORGE from "../dist/forge.html";', "const FORGE = " + JSON.stringify(readFileSync(root + "dist/forge.html", "utf8")) + ";",
  ).replace('import WORLD from "./world.json";', "const WORLD = " + readFileSync(root + "src/world.json", "utf8") + ";");
  return import("data:text/javascript;base64," + Buffer.from(src).toString("base64") + "#" + Date.now());
}

const sqlite = new DatabaseSync(":memory:");
const DB = {
  prepare(sql) {
    let args = [];
    const stmt = () => sqlite.prepare(sql);
    const api = {
      bind: (...a) => ((args = a), api),
      first: async () => stmt().get(...args) ?? null,
      all: async () => ({ results: stmt().all(...args) }),
      run: async () => {
        const r = stmt().run(...args);
        return { meta: { changes: Number(r.changes) } };
      },
    };
    return api;
  },
};
// The weather bridge never leaves this machine in tests: a stand-in weather service reports a storm over FarmX's twin
// (gusts of 72 km/h), a heatwave in Dubai (Xetropolitan, 46°C) and calm weather everywhere else.
const TWIN_ORDER = Object.keys(JSON.parse(readFileSync(root + "src/world.json", "utf8")).twins);
const WEATHER_FETCH = async () => ({ ok: true, json: async () => TWIN_ORDER.map((t) => ({ current: { temperature_2m: t === "xetropolitan" ? 46 : 14, precipitation: 0, snowfall: 0, wind_speed_10m: 18, wind_gusts_10m: t === "farmx" ? 72 : 24, weather_code: 2 } })) });
const env = { DB, ADMIN_KEY: "founder-test-key-1234567890", XLAND_DEV: "1", WEATHER_FETCH };   // XLAND_DEV enables /api/dev/credit for the test scripts only

createServer(async (req, res) => {
  try {
    const { default: worker } = await loadWorker();
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : await new Promise((ok) => {
      const c = [];
      req.on("data", (d) => c.push(d));
      req.on("end", () => ok(Buffer.concat(c)));
    });
    const r = await worker.fetch(new Request("http://localhost:" + port + req.url, { method: req.method, headers: req.headers, body }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500);
    res.end(String(e));
  }
}).listen(port, () => console.log("xland dev server on http://localhost:" + port));
