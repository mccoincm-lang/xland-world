// Builds dist/index.html: the page with the Atlas UI stylesheet, the artwork sprite and the world data inlined.
// No dependencies. Run: node tools/build.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const root = new URL("..", import.meta.url).pathname;
const read = (f) => readFileSync(root + f, "utf8");
let html = read("src/index.html");
// src/world.json (land, twins on Earth, hazards) is shared with worker.js; the page gets it inlined in place of `/*@WORLD*/null`.
const world = JSON.parse(read("src/world.json")); delete world.about;
const parts = { "/*@ATLAS_UI*/": read("src/atlas-ui.css"), "<!--@SPRITE-->": read("src/sprite.svg"), "/*@WORLD*/null": JSON.stringify(world) };
for (const [marker, content] of Object.entries(parts)) {
  if (html.split(marker).length !== 2) throw new Error("marker missing or repeated: " + marker);
  html = html.replace(marker, () => content);
}
mkdirSync(root + "dist", { recursive: true });
writeFileSync(root + "dist/index.html", html);
console.log("dist/index.html", (html.length / 1024).toFixed(0) + " KB");
