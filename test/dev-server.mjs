// Local stand-in for Cloudflare: runs src/worker.js with an in-memory SQLite database as D1.
// Usage: node test/dev-server.mjs [port]
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.argv[2] || 8787);

function loadWorker() {
  const html = readFileSync(root + "dist/index.html", "utf8");
  const src = readFileSync(root + "src/worker.js", "utf8").replace(
    'import HTML from "../dist/index.html";',
    "const HTML = " + JSON.stringify(html) + ";",
  );
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
const env = { DB, ADMIN_KEY: "founder-test-key-1234567890" };

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
