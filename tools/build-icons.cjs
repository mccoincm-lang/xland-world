// Renders the app icons (r58) from Xland's own wordmark diamond into src/icons.json (base64 PNG), which the Worker serves
// at /icon-192.png, /icon-512.png and /icon-maskable-512.png for the web app manifest. Needs Playwright with Chromium.
// Usage: node tools/build-icons.cjs
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
const fs = require("fs"), path = require("path");
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><radialGradient id="g" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="#1B2A52"/><stop offset="1" stop-color="#0A1022"/></radialGradient><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F0D9A4"/><stop offset="1" stop-color="#B8944F"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><g transform="translate(256 256) scale(${pad}) translate(-256 -256)" fill="none" stroke="url(#b)" stroke-width="22" stroke-linejoin="miter"><path d="M256 56 456 256 256 456 56 256Z"/><path d="M166 166l180 180M346 166 166 346"/></g></svg>`;
(async () => {
  const b = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const out = { svg: svg(0.86) };
  for (const [name, size, pad] of [["192", 192, 0.86], ["512", 512, 0.86], ["maskable512", 512, 0.62]]) {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    await p.setContent(`<body style="margin:0">${svg(pad).replace("<svg ", `<svg width="${size}" height="${size}" `)}</body>`);
    out[name] = (await p.screenshot({ type: "png" })).toString("base64"); await p.close();
  }
  await b.close();
  fs.writeFileSync(path.join(__dirname, "../src/icons.json"), JSON.stringify(out));
  console.log("src/icons.json", Object.entries(out).map(([k, v]) => k + " " + v.length).join(", "));
})();
