// r55 living map, checked through the API alone: land bought and paid in one server step, the lot cap, buildings raised on
// lots, wear and storm damage computed by the server, repairs, the real-weather bridge and heat on harvests.
// Usage: node test/dev-server.mjs 8787 &  then  node test/living-map.cjs [port]   (takes about two minutes: it waits for a build)
const port = process.argv[2] || 8787, base = `http://localhost:${port}/api`;
const api = async (key, method, path, body, extra) => { const r = await fetch(base + path, { method, headers: { "x-xland-key": key, "content-type": "application/json", ...(extra || {}) }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, failN = 0;
const check = (name, ok, detail) => { console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  [" + String(detail).slice(0, 160) + "]" : "")); ok ? pass++ : failN++; };
const err = r => r.body.error || r.body.why || (r.body.dup ? "dup" : r.body.ok ? "ok" : JSON.stringify(r.body).slice(0, 80));
const FOUNDER = { "x-xland-admin": "founder-test-key-1234567890" };
const newKey = p => (p + Date.now().toString(36) + Math.random().toString(36).slice(2)).padEnd(40, "k").slice(0, 40);
const world = require("../src/world.json"), LAND = Object.fromEntries(world.land.map(l => [l.id, l]));
(async () => {
  const A = newKey("A"), Bk = newKey("B");
  await api(A, "GET", "/me"); await api(Bk, "GET", "/me");
  const uidA = (await api(A, "GET", "/me")).body.uid;
  const wallet = async k => (await api(k, "GET", "/wallet")).body;
  // pick free lots (the dev server keeps its database between runs)
  const claims = (await api(A, "GET", "/sync?since=0")).body.docs.filter(d => d.c === "claims").map(d => d.id);
  const free = t => world.land.filter(l => l.lot && l.t === t && !claims.includes(l.id)).map(l => l.id);
  const [f1, f2, f3, f4] = free("farmx"), xah = free("xahara")[0], xim = free("ximberland")[0];

  // --- Land ---
  let r = await api(A, "POST", "/land/buy?parcel=NOPE-01"); check("Land that is not for sale is refused", r.status === 404, err(r));
  r = await api(A, "POST", "/land/buy?parcel=AQX-01"); check("The House on the River can never be bought", r.status === 404, err(r));
  r = await api(A, "POST", "/land/buy?parcel=" + f1); check("Buying without BuX is refused", r.status === 409, err(r));
  let sync = (await api(A, "GET", "/sync?since=0")).body.docs.filter(d => d.c === "claims").map(d => d.id);
  check("A refused purchase leaves no claim behind", !sync.includes(f1));
  r = await api(A, "PUT", `/doc?c=claims&id=${f1}`, { data: { owner: uidA } }); check("A claim written without paying is refused", r.status === 403, err(r));
  await api(A, "POST", "/dev/credit?asset=bux&units=50000000&op=prod-dev-lm" + Date.now().toString(36));
  const before = BigInt((await wallet(A)).bal.bux);
  r = await api(A, "POST", `/land/buy?parcel=${f1}&handle=Ava`);
  const paid = before - BigInt((await wallet(A)).bal.bux);
  check("Buying a lot claims it and charges its price in one step", r.status === 200 && paid === BigInt(LAND[f1].price * 10000), err(r) + " paid " + paid);
  r = await api(A, "POST", `/land/buy?parcel=${f1}`); check("Buying it again charges nothing", r.status === 200 && r.body.dup && BigInt((await wallet(A)).bal.bux) === before - paid, err(r));
  r = await api(A, "PUT", `/doc?c=claims&id=${f1}`, { data: { owner: uidA, handle: "Ava B" } }); check("The holder may update a paid claim", r.status === 200, err(r));
  await api(Bk, "POST", "/dev/credit?asset=bux&units=50000000&op=prod-dev-lmb" + Date.now().toString(36));
  r = await api(Bk, "POST", `/land/buy?parcel=${f1}`); check("A held lot cannot be bought by someone else", r.status === 409, err(r));
  await api(A, "POST", "/land/buy?parcel=" + f2); await api(A, "POST", "/land/buy?parcel=" + f3);
  r = await api(A, "POST", "/land/buy?parcel=" + f4); check("A fourth lot in one territory is refused (cap 3)", r.status === 409 && /up to 3 lots/.test(err(r)), err(r));
  r = await api(A, "POST", "/land/buy?parcel=" + xah); check("Lots in another territory are still allowed", r.status === 200, err(r));

  // --- Buildings on lots ---
  r = await api(A, "POST", `/build/start?def=homax&parcel=${f1}&key=proj-${f1}-h1`); check("A building the lot does not allow is refused", r.status === 400, err(r));
  r = await api(A, "POST", `/build/start?def=granary&parcel=${xim}&key=proj-${xim}-g1`); check("Building on land you do not hold is refused", r.status >= 400, err(r));
  r = await api(A, "POST", `/build/start?def=granary&parcel=${f1}&key=proj-${f1}-g1`); check("A granary without QuarX is refused", r.status === 409 && (await wallet(A)).locked.bux === "0", err(r));
  await api(A, "POST", "/dev/credit?asset=quarx&units=200000&op=mine-dev-lm" + Date.now().toString(36));
  r = await api(A, "POST", `/build/start?def=caravanserai&parcel=${xah}&key=proj-${xah}-c1`);
  let w = await wallet(A);
  check("A caravanserai starts on a Xahara lot: 2 QuarX and 100 BuX reserved", r.status === 200 && w.locked.quarx === "20000" && w.locked.bux === "1000000", err(r) + " " + JSON.stringify(w.locked));
  const key = r.body.build.key;
  console.log("  waiting for the caravanserai (" + Math.ceil((r.body.build.end - r.body.now) / 1000) + " s)…"); await sleep(r.body.build.end - r.body.now + 600);
  r = await api(A, "POST", "/build/done?key=" + key); check("It completes on the server's clock", r.status === 200 && r.body.build.status === "complete", err(r));
  let bl = (await api(A, "GET", "/builds")).body.builds.find(b => b.key === key);
  check("A new building stands at full condition", bl && bl.cond >= 99.9 && bl.repair.bux === "0", JSON.stringify(bl && { cond: bl.cond, repair: bl.repair }));

  // --- Hazards ---
  r = await api(A, "POST", "/hazard/raise?type=storm&t=xahara"); check("Only the founder can raise a hazard", r.status === 403, err(r));
  r = await api(A, "POST", "/hazard/raise?type=storm&t=xahara", null, FOUNDER); check("The founder raises a storm in Xahara", r.status === 200 && r.body.hazard && r.body.hazard.type === "storm", err(r));
  r = await api(A, "POST", "/hazard/raise?type=storm&t=xahara", null, FOUNDER); check("A second storm while one rages only extends it", r.status === 200 && r.body.extended, err(r));
  bl = (await api(A, "GET", "/builds")).body.builds.find(b => b.key === key);
  check("The storm damages the caravanserai once: 80%", bl && Math.round(bl.cond) === 80 && bl.hits.length === 1, JSON.stringify(bl && { cond: bl.cond, hits: bl.hits.length }));
  check("Repair is priced by the damage", bl && BigInt(bl.repair.bux) > 0n && bl.repair.quarx === "0", JSON.stringify(bl && bl.repair));
  const bux0 = BigInt((await wallet(A)).bal.bux);
  r = await api(A, "POST", "/build/repair?key=" + key);
  check("Repair restores full condition and charges the price", r.status === 200 && r.body.cond === 100 && bux0 - BigInt((await wallet(A)).bal.bux) === BigInt(bl.repair.bux), err(r));
  r = await api(A, "POST", "/build/repair?key=" + key); check("Repairing a sound building charges nothing", r.status === 200 && r.body.repaired === false, err(r));
  r = await api(Bk, "POST", "/build/repair?key=" + key); check("Nobody can repair another citizen's building", r.status === 404, err(r));

  // --- The real-weather bridge (stand-in weather service in the dev server) ---
  r = await api(A, "POST", "/world/refresh"); check("Only the founder can read the weather by hand", r.status === 403, err(r));
  r = await api(A, "POST", "/world/refresh", null, FOUNDER);
  const types = (r.body.raised || []).map(h => h.type + "@" + h.territory);
  check("Real storm gusts over FarmX's twin raise a storm in FarmX", r.status === 200 && (types.includes("storm@farmx") || (await api(A, "GET", "/world")).body.living.hazards.some(h => h.type === "storm" && h.territory === "farmx")), types.join(","));
  const wr = (await api(A, "GET", "/world")).body.living;
  check("The world report carries hazards and live twin weather", wr && wr.weather.xetropolitan && wr.weather.xetropolitan.temp === 46 && wr.hazards.some(h => h.source === "real"), JSON.stringify(wr && wr.weather.xetropolitan));
  check("Heat in Dubai becomes a heatwave in Xetropolitan", wr.hazards.some(h => h.type === "heat" && h.territory === "xetropolitan"));
  await api(A, "POST", "/hazard/raise?type=heat&t=farmx", null, FOUNDER);
  r = await api(A, "POST", "/farm/start?kind=vegiex");
  check("A heatwave in FarmX lowers a harvest started there (12 → 8)", r.status === 200 && r.body.out === 8, err(r) + " out=" + r.body.out);
  r = await api(A, "POST", "/ledger", { op: "repair-free-" + Date.now(), kind: "post", lines: [["bux", "100000"]] }); check("A page cannot credit itself a repair", r.status === 422, err(r));

  // --- Land between citizens (r56) ---
  const C = newKey("C"); await api(C, "GET", "/me");
  r = await api(A, "POST", "/land/list?parcel=AQX-01&price=900"); check("The House on the River can never be listed", r.status === 404, err(r));
  r = await api(Bk, "POST", `/land/list?parcel=${xah}&price=500`); check("Only the holder can list land", r.status === 403, err(r));
  r = await api(A, "POST", `/land/list?parcel=${xah}&price=12.5`); check("An asking price is in whole BuX", r.status === 400, err(r));
  r = await api(A, "POST", `/land/list?parcel=${xah}&price=500`); check("The holder lists a lot with its caravanserai", r.status === 200 && r.body.listing.feeBps === 2000, err(r) + " fee " + (r.body.listing || {}).feeBps);
  check("Listings are public in the world report", (await api(C, "GET", "/world")).body.living.listings.some(l => l.id === xah && l.price === 500));
  r = await api(A, "POST", `/land/list?parcel=${f1}&price=900`); const r2 = await api(A, "POST", `/build/start?def=farmstead&parcel=${f1}&key=proj-${f1}-f9`);
  check("Nothing is built on land while it is listed", r.status === 200 && r2.status === 409 && /listed/.test(err(r2)), err(r2));
  r = await api(A, "POST", `/land/unlist?parcel=${f1}`); check("The holder withdraws a listing", r.status === 200 && !(await api(C, "GET", "/world")).body.living.listings.some(l => l.id === f1));
  r = await api(Bk, "POST", `/land/buy?parcel=${xah}&price=450`); check("A buyer is protected from a changed price", r.status === 409 && /changed/.test(err(r)), err(r));
  r = await api(C, "POST", `/land/buy?parcel=${xah}&price=500`); check("A buyer without BuX is refused and the listing stays", r.status === 409 && (await api(C, "GET", "/world")).body.living.listings.some(l => l.id === xah), err(r));
  const a0 = BigInt((await wallet(A)).bal.bux), b0 = BigInt((await wallet(Bk)).bal.bux);
  r = await api(Bk, "POST", `/land/buy?parcel=${xah}&price=500&handle=Bea`);
  const a1 = BigInt((await wallet(A)).bal.bux), b1 = BigInt((await wallet(Bk)).bal.bux);
  check("The buyer pays the asking price in one step", r.status === 200 && b0 - b1 === 5000000n && r.body.resale && r.body.resale.price === 500, err(r) + " " + (b0 - b1));
  check("The seller is paid less the 20% anti-flip fee", a1 - a0 === 4000000n, String(a1 - a0));
  check("The caravanserai changes hands with the land", r.body.builds.some(x => x.key === key) && (await api(Bk, "GET", "/builds")).body.builds.some(x => x.key === key && x.cond != null) && !(await api(A, "GET", "/builds")).body.builds.some(x => x.key === key));
  const holder = (await api(C, "GET", "/sync?since=0")).body.docs.find(d => d.c === "claims" && d.id === xah);
  check("The shared registry shows the new holder", holder && holder.d && holder.d.handle === "Bea", JSON.stringify(holder && holder.d));
  r = await api(C, "POST", `/land/buy?parcel=${xah}&price=500`); check("Sold land cannot be sold twice", r.status === 409, err(r));
  r = await api(A, "PUT", `/doc?c=claims&id=${xah}`, { data: { owner: uidA } }); check("The seller cannot take the land back with a claim", r.status >= 400, err(r));
  r = await api(A, "POST", `/build/repair?key=${key}`); check("The seller can no longer repair what was sold", r.status === 404, err(r));
  await api(A, "POST", "/land/buy?parcel=" + xim); const ximPrice = LAND[xim].price;
  r = await api(A, "POST", `/land/list?parcel=${xim}&price=${ximPrice}`); check("Ximberland's resale floor: never below acquisition + 1 BuX", r.status === 409 && /never resold/.test(err(r)), err(r));
  r = await api(A, "POST", `/land/list?parcel=${xim}&price=${ximPrice + 1}`); check("At the floor the listing is accepted", r.status === 200, err(r));
  r = await api(A, "POST", "/ledger", { op: "land-sale-fake-" + Date.now(), kind: "post", lines: [["bux", "100000"]] }); check("A page cannot pay itself for a land sale", r.status === 422, err(r));

  console.log(`\n${pass} passed, ${failN} failed`);
  process.exit(failN ? 1 : 0);
})();
