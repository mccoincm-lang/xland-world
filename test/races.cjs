// r58: holes found by an adversarial review of the land and building rules, and requests sent at the same moment.
// Needs the slow dev server, where database calls interleave as on the real D1:
//   XLAND_SLOW=1 node test/dev-server.mjs 8790 &   then   node test/races.cjs 8790      (about two minutes)
const port = process.argv[2] || 8790, base = `http://localhost:${port}/api`;
const api = async (key, method, path, body, extra) => { const r = await fetch(base + path, { method, headers: { "x-xland-key": key, "content-type": "application/json", ...(extra || {}) }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, failN = 0;
const check = (name, ok, detail) => { console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  [" + String(detail).slice(0, 170) + "]" : "")); ok ? pass++ : failN++; };
const err = r => r.body.error || r.body.why || (r.body.ok ? "ok" : JSON.stringify(r.body).slice(0, 80));
const FOUNDER = { "x-xland-admin": "founder-test-key-1234567890" };
const newKey = p => (p + Date.now().toString(36) + Math.random().toString(36).slice(2)).padEnd(40, "k").slice(0, 40);
const world = require("../src/world.json");
(async () => {
  const [A, Bk, C, D] = ["A", "B", "C", "D"].map(newKey); for (const k of [A, Bk, C, D]) await api(k, "GET", "/me");
  const uid = async k => (await api(k, "GET", "/me")).body.uid, bux = async k => BigInt((await api(k, "GET", "/wallet")).body.bal.bux);
  const credit = (k, asset, units) => api(k, "POST", `/dev/credit?asset=${asset}&units=${units}&op=${asset === "bux" ? "prod" : "mine"}-dev-${Math.random().toString(36).slice(2)}`);
  const claimsOf = async (k) => { const u = await uid(k); return (await api(k, "GET", "/sync?since=0")).body.docs.filter(d => d.c === "claims" && d.d && d.d.owner === u).map(d => d.id); };
  const taken = (await api(A, "GET", "/sync?since=0")).body.docs.filter(d => d.c === "claims").map(d => d.id);
  const free = t => world.land.filter(l => l.lot && l.t === t && !taken.includes(l.id)).map(l => l.id);

  // --- an operation that only carries the right name is not a payment ---
  await credit(C, "bux", 10000);   // 1 BuX
  const xet = free("xetropolitan")[0];
  let r = await api(C, "POST", "/ledger", { op: "parcel-" + xet, kind: "lock", lk: "LOCK", asset: "bux", qty: "1" }); check("A one-unit reservation named like a land payment is refused", r.status === 422, err(r));
  r = await api(C, "POST", "/land/buy?parcel=" + xet); check("…and the lot cannot be had for free", r.status === 409 && !(await claimsOf(C)).includes(xet), err(r));
  r = await api(C, "POST", "/ledger", { op: "homax-acquire", kind: "lock", lk: "LOCK", asset: "bux", qty: "1" }); check("A reservation named like a Homax purchase is refused", r.status === 422, err(r));
  check("…and gives no residency", (await api(C, "GET", "/gov")).body.me.eligible === false);
  r = await api(C, "POST", "/ledger", { op: "mkt-list-test1", kind: "lock", lk: "LOCK", asset: "bux", qty: "1" }); check("A market reservation still works", r.status === 200, err(r));
  await api(D, "POST", "/wallet/import", { legacy: true, bal: { bux: "500000000" } });
  r = await api(D, "PUT", "/doc?c=claims&id=FX-A-02", { data: { owner: await uid(D) } }); check("The alpha import no longer unlocks free parcels", r.status === 403, err(r));
  await credit(D, "bux", 9000000); await api(D, "POST", "/ledger", { op: "homax-acquire", kind: "post", lines: [["bux", "-4000000"]] });
  const uD = await uid(D); const h1 = await api(D, "PUT", "/doc?c=claims&id=XIM-R-08", { data: { owner: uD } }), h2 = await api(D, "PUT", "/doc?c=claims&id=XIM-R-09", { data: { owner: uD } });
  check("One Homax paid in full is one home, not every home", h1.status === 200 && h2.status === 403, h1.status + " " + h2.status);

  // --- requests sent at the same moment ---
  await credit(A, "bux", 60000000); await credit(A, "quarx", 100000); await credit(Bk, "bux", 60000000); await credit(Bk, "quarx", 100000);
  const xah = free("xahara").slice(0, 8);
  const rs = await Promise.all(xah.map(id => api(A, "POST", "/land/buy?parcel=" + id)));
  const heldX = (await claimsOf(A)).filter(id => id.startsWith("XAH-L-"));
  check("Eight purchases at once still respect the cap of three lots", heldX.length <= 3 && heldX.length >= 1, `${rs.filter(x => x.status === 200).length} said ok, ${heldX.length} held`);
  const b0 = await bux(A); const paidLots = heldX.reduce((n, id) => n + world.land.find(l => l.id === id).price, 0);
  check("…and only held lots were paid for", 60000000n - b0 === BigInt(paidLots * 10000), `${60000000n - b0} for ${paidLots} BuX of land`);

  const [fa, fb] = free("farmx"); await api(A, "POST", "/land/buy?parcel=" + fa); await api(Bk, "POST", "/land/buy?parcel=" + fb);
  const K = "proj-FX-L-same-" + Date.now().toString(36);
  const s1 = await api(A, "POST", `/build/start?def=farmstead&parcel=${fa}&key=${K}`), s2 = await api(Bk, "POST", `/build/start?def=farmstead&parcel=${fb}&key=${K}`);
  check("Two citizens start farmsteads under the same key", s1.status === 200 && s2.status === 200, err(s1) + " / " + err(s2));
  console.log("  waiting for the farmsteads…"); await sleep(Math.max(s1.body.build.end, s2.body.build.end) - s2.body.now + 800);
  await api(A, "POST", "/build/done?key=" + K); await api(Bk, "POST", "/build/done?key=" + K);
  await api(A, "POST", "/hazard/raise?type=storm&t=farmx", null, FOUNDER);
  let a0 = await bux(A); const rep = await Promise.all([1, 2, 3, 4].map(() => api(A, "POST", "/build/repair?key=" + K)));
  let cost = BigInt((rep.find(x => x.body.paid) || { body: { paid: { bux: "0" } } }).body.paid.bux);
  check("Four repairs at once charge once", rep.filter(x => x.body.repaired).length === 1 && a0 - await bux(A) === cost && cost > 0n, `${rep.filter(x => x.body.repaired).length} repaired, charged ${a0 - await bux(A)} for ${cost}`);
  a0 = await bux(A); const br = await Promise.all([1, 2, 3, 4].map(() => api(A, "POST", "/build/brace?key=" + K)));
  check("Four braces at once charge once", br.filter(x => x.body.braced).length === 1 && a0 - await bux(A) === 90000n, `${br.filter(x => x.body.braced).length} braced, charged ${a0 - await bux(A)}`);
  const both = await Promise.all([api(A, "POST", `/land/list?parcel=${heldX[0]}&price=300`), api(A, "POST", `/build/start?def=caravanserai&parcel=${heldX[0]}&key=proj-${heldX[0]}-r1`)]);
  const listed = (await api(C, "GET", "/world")).body.living.listings.some(l => l.id === heldX[0]), site = (await api(A, "GET", "/builds")).body.builds.some(x => x.parcel === heldX[0] && ["active", "committed"].includes(x.status));
  check("Land is never both listed and under construction", !(listed && site), `listed ${listed}, site ${site} (${both.map(x => x.status).join("/")})`);

  // --- resale ---
  r = await api(A, "POST", `/land/list?parcel=${fa}&price=600`); check("The seller lists the lot with its farmstead", r.status === 200, err(r));
  r = await api(Bk, "POST", `/land/buy?parcel=${fa}`); check("A resale needs the price the buyer saw", r.status === 409 && /600 BuX/.test(err(r)), err(r));
  a0 = await bux(A); const bb = await bux(Bk);
  r = await api(Bk, "POST", `/land/buy?parcel=${fa}&price=600`);
  const mine = (await api(Bk, "GET", "/builds")).body.builds.filter(x => x.status === "complete");
  check("A buyer who already has a building of the same key gets the land and the building whole", r.status === 200 && (await claimsOf(Bk)).includes(fa) && mine.length === 2 && mine.some(x => x.parcel === fa) && new Set(mine.map(x => x.key)).size === 2, err(r) + " builds " + mine.map(x => x.parcel + ":" + x.key).join(","));
  check("…charged once, and the seller paid once less the fee", bb - await bux(Bk) === 6000000n && await bux(A) - a0 === 4800000n, `${bb - await bux(Bk)} / ${await bux(A) - a0}`);
  check("The seller keeps nothing of it", !(await api(A, "GET", "/builds")).body.builds.some(x => x.parcel === fa));

  console.log(`\n${pass} passed, ${failN} failed`); process.exit(failN ? 1 : 0);
})();
