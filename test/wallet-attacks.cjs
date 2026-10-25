// Attack and failure scenarios against the server wallet, the order book and the world rules, through the API alone.
// Every line is a rule the server must hold. A FAIL is a gap to fix, not a broken test.
// Usage: node test/dev-server.mjs 8787 &  then  node test/wallet-attacks.cjs [port]
const port = process.argv[2] || 8787, base = `http://localhost:${port}/api`;
const api = async (key, method, path, body, extra) => { const r = await fetch(base + path, { method, headers: { "x-xland-key": key, "content-type": "application/json", ...(extra || {}) }, body: body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, failN = 0; const gaps = [], R = Date.now().toString(36).slice(-5);   // unique ids per run: the dev server keeps its database between runs
const check = (name, ok, detail) => { console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  [" + String(detail).slice(0, 160) + "]" : "")); ok ? pass++ : (failN++, gaps.push(name)); };
const err = r => r.body.error || r.body.why || (r.body.dup ? "dup" : r.body.ok ? "ok" : JSON.stringify(r.body).slice(0, 80));
const newKey = p => (p + Date.now().toString(36) + Math.random().toString(36).slice(2)).padEnd(40, "k").slice(0, 40);
const ledger = (k, body) => api(k, "POST", "/ledger", body);
const wallet = async k => (await api(k, "GET", "/wallet")).body;
const credit = (k, asset, units, op) => api(k, "POST", `/dev/credit?asset=${asset}&units=${units}&op=${op}`);
(async () => {
  const A = newKey("A"), S = newKey("S"), X = newKey("X"), N = newKey("N");
  for (const k of [A, S, X]) await api(k, "GET", "/me");
  const uid = async k => (await api(k, "GET", "/me")).body.uid;
  // --- Identity and basics ---
  let r = await api(N, "GET", "/wallet"); check("Unknown citizen key is refused", r.status === 401, err(r));
  r = await api("short", "GET", "/me"); check("Malformed key is refused", r.status === 401, err(r));
  r = await api(A, "GET", "/admin/wallets"); check("Founder dashboard needs the founder key", r.status === 403, err(r));
  r = await api(A, "GET", "/admin/wallets", null, { "x-xland-admin": "wrong-key" }); check("Wrong founder key is refused", r.status === 403, err(r));
  // --- Forged credits and malformed operations ---
  r = await ledger(A, { op: "gift", kind: "post", lines: [["bux", "10000000"]] }); check("Forged BuX credit refused", r.status === 422, err(r));
  r = await ledger(A, { op: "srv-adjust-x", kind: "post", lines: [["bux", "-1"]] }); check("Server-reserved op prefix refused", r.status === 422, err(r));
  r = await ledger(A, { op: "import-alpha", kind: "post", lines: [["bux", "10000"]] }); check("Import op through the ledger refused", r.status === 422, err(r));
  r = await ledger(A, { op: "x-neg", kind: "lock", lk: "LOCK", asset: "quarx", qty: "-10000" }); check("Negative lock refused", r.status === 422, err(r));
  r = await ledger(A, { op: "x-huge", kind: "post", lines: [["bux", "-99999999999999999999999999"]] }); check("Overspend with a huge number refused", r.status === 422, err(r));
  r = await ledger(A, { op: "x-float", kind: "post", lines: [["bux", "-1.5"]] }); check("Non-integer amount refused", r.status === 422, err(r));
  r = await ledger(A, { op: "x-asset", kind: "post", lines: [["gold", "-1"]] }); check("Unknown asset refused", r.status === 422, err(r));
  r = await ledger(A, { op: "x-mix", kind: "post", lines: [["bux", "-10000"], ["quarx", "10000"]] }); check("Spend-plus-credit outside a venue refused", r.status === 422, err(r));
  r = await ledger(A, { op: "mkt-deliver-fake", kind: "lock", lk: "CONSUME", asset: "vegiex", qty: "10000" }); check("Page cannot settle a delivery itself", r.status === 422, err(r));
  r = await ledger(A, { op: "mkt-sale-fake", kind: "post", lines: [["bux", "10000"]] }); check("Page cannot credit itself a sale", r.status === 422, err(r));
  r = await ledger(A, { op: "mine-fake", kind: "post", lines: [["quarx", "10000"]] }); check("Page cannot credit itself a seam", r.status === 422, err(r));
  r = await ledger(A, { op: "prod-fake", kind: "post", lines: [["vegiex", "10000"]] }); check("Page cannot credit itself a harvest", r.status === 422, err(r));
  r = await ledger(A, { op: "sandbox-grant", kind: "post", lines: [["bux", "10000000"]] }); let w = await wallet(A);
  check("Sandbox grant is fixed at 1,000 BuX whatever the page asks", r.status === 200 && w.bal.bux === "10000000", err(r) + " " + w.bal.bux);
  r = await ledger(A, { op: "sandbox-grant", kind: "post", lines: [["bux", "10000000"]] }); w = await wallet(A);
  check("Sandbox grant cannot be repeated", r.body.dup === true && w.bal.bux === "10000000", err(r));
  r = await ledger(A, { op: "rent-1", kind: "post", lines: [["bux", "-10000"]] }); const r2 = await ledger(A, { op: "rent-1", kind: "post", lines: [["bux", "-9990000"]] }); w = await wallet(A);
  check("Replaying an op id with a different amount applies nothing", r.status === 200 && r2.body.dup === true && w.bal.bux === "9990000", w.bal.bux);
  // --- Swaps and presale ---
  await credit(A, "vegiex", "200000", "prod-dev-a"); await credit(A, "quarx", "100000", "mine-dev-a");
  r = await ledger(A, { op: "swap-forgex-1", kind: "post", lines: [["vegiex", "-10000"], ["bux", "20001"]] }); check("Selling above the posted rate refused", r.status === 422, err(r));
  r = await ledger(A, { op: "swap-forgex-2", kind: "post", lines: [["bux", "-19999"], ["vegiex", "10000"]] }); check("Buying below the posted rate refused", r.status === 422, err(r));
  r = await ledger(A, { op: "swap-farmxswap-q", kind: "post", lines: [["quarx", "-10000"], ["bux", "400000"]] }); check("A venue cannot trade an asset it does not list", r.status === 422, err(r));
  r = await ledger(A, { op: "swap-nowhere-1", kind: "post", lines: [["vegiex", "-10000"], ["bux", "20000"]] }); check("Unknown venue refused", r.status === 422, err(r));
  r = await ledger(A, { op: "swap-forgex-3", kind: "post", lines: [["vegiex", "-10000"], ["bux", "20000"]] }); check("Fair swap accepted", r.status === 200, err(r));
  r = await ledger(A, { op: "presale-1", kind: "post", lines: [["bux", "-290000"], ["quarx", "10000"]] }); check("Presale below the fixed price refused", r.status === 422, err(r));
  r = await ledger(A, { op: "presale-2", kind: "post", lines: [["bux", "-1800000"], ["quarx", "60000"]] }); check("Presale beyond the per-citizen cap refused", r.status === 422, err(r));
  r = await ledger(A, { op: "presale-3", kind: "post", lines: [["bux", "-900000"], ["quarx", "30000"]] }); const r4 = await ledger(A, { op: "presale-4", kind: "post", lines: [["bux", "-900000"], ["quarx", "30000"]] });
  check("Presale cap counts across operations (3 + 3 > 5)", r.status === 200 && r4.status === 422, err(r) + " / " + err(r4));
  // --- QuarX daily sale limit (5 x reward = 5 QuarX in epoch 1) ---
  r = await ledger(A, { op: "swap-forgex-q1", kind: "post", lines: [["quarx", "-60000"], ["bux", "2400000"]] }); check("Selling 6 QuarX in one swap refused", r.status === 422, err(r));
  r = await ledger(A, { op: "swap-forgex-q2", kind: "post", lines: [["quarx", "-30000"], ["bux", "1200000"]] }); check("Selling 3 QuarX accepted", r.status === 200, err(r));
  r = await ledger(A, { op: "mkt-list-q1", kind: "lock", lk: "LOCK", asset: "quarx", qty: "30000" }); check("Listing 3 more QuarX the same day refused (3 + 3 > 5)", r.status === 422, err(r));
  r = await ledger(A, { op: "mkt-list-q2", kind: "lock", lk: "LOCK", asset: "quarx", qty: "20000" }); check("Listing 2 more QuarX accepted (3 + 2 = 5)", r.status === 200, err(r));
  r = await ledger(A, { op: "mkt-unlist-q2", kind: "lock", lk: "UNLOCK", asset: "quarx", qty: "20000" });
  r = await ledger(A, { op: "mkt-list-q3", kind: "lock", lk: "LOCK", asset: "quarx", qty: "10000" }); check("Unlisting does not give the daily allowance back", r.status === 422, err(r));
  // --- Alpha import ---
  const L = newKey("L"); await api(L, "GET", "/me");
  r = await api(L, "POST", "/wallet/import", { legacy: true, bal: { bux: "99999999999", quarx: "-5", lex: "abc" }, locked: { quarx: "999999999" } });
  check("Import clamps to caps, drops negatives and garbage", r.status === 200 && r.body.bal.bux === "500000000" && r.body.bal.quarx === "0" && r.body.bal.lex === "0" && r.body.locked.quarx === "10000000", JSON.stringify(r.body.bal));
  r = await api(L, "POST", "/wallet/import", { legacy: true, bal: { bux: "10000" } }); check("Second import refused", r.status === 409, err(r));
  r = await ledger(L, { op: "sandbox-grant", kind: "post", lines: [["bux", "10000000"]] }); w = await wallet(L); check("No sandbox grant on top of an imported wallet", w.bal.bux === "500000000", w.bal.bux);
  const M = newKey("M"); await api(M, "GET", "/me"); await ledger(M, { op: "sandbox-grant", kind: "post", lines: [["bux", "10000000"]] });
  r = await api(M, "POST", "/wallet/import", { legacy: true, bal: { bux: "500000000" } }); check("Import after the wallet started is refused", r.status === 409, err(r));
  // --- Market: shop, order book, resale, anti-flip ---
  const uidS = await uid(S), uidA = await uid(A), uidX = await uid(X);
  await credit(S, "vegiex", "100000", "prod-dev-s"); await credit(S, "quarx", "50000", "mine-dev-s");
  r = await api(S, "POST", "/shop/open?name=Stand&t=farmx"); check("Farm stand opens", r.status === 200 && r.body.built, err(r));
  r = await api(S, "POST", "/shop/open?name=Other&t=xetropolitan"); check("One shop per citizen (second open changes nothing)", r.status === 200 && !r.body.built, JSON.stringify(r.body));
  r = await api(S, "POST", "/shop/open?name=Iced&t=ixeland"); check("Ixeland needs a cooperative, not a shop", r.status === 400, err(r));
  r = await api(S, "POST", "/coop/create?id=coop1&name=Ice"); check("A shopkeeper cannot also join a cooperative", r.status === 409, err(r));
  await ledger(S, { op: "mkt-list-v1", kind: "lock", lk: "LOCK", asset: "vegiex", qty: "50000" });
  await api(S, "PUT", "/doc?c=shops&id=" + uidS, { data: { name: "Stand", openUntil: Date.now() + 86400000, items: [{ ref: "v1", asset: "vegiex", qty: 5, price: 30000 }, { ref: "q1", asset: "quarx", qty: 1, price: 400000 }, { ref: "ghost", asset: "livestox", qty: 5, price: 10000 }] } });
  await ledger(A, { op: "sandbox-grant", kind: "post", lines: [["bux", "1"]] });
  r = await api(S, "POST", `/market/order?oid=o-self-${R}&seller=${uidS}&ref=v1&qty=1&price=30000`); check("Cannot buy from own shop", r.status === 403, err(r));
  r = await api(A, "POST", `/market/order?oid=o-q-${R}&seller=${uidS}&ref=q1&qty=1&price=400000`); check("A farm stand cannot sell QuarX (territory rule on the server)", r.status === 404, err(r));
  r = await api(A, "POST", `/market/order?oid=o-ghost-${R}&seller=${uidS}&ref=ghost&qty=1&price=10000`); check("Listing without reserved stock cannot be sold", r.status === 409, err(r));
  r = await api(A, "POST", `/market/order?oid=o-price-${R}&seller=${uidS}&ref=v1&qty=1&price=20000`); check("Price must match the listing", r.status === 409, err(r));
  r = await api(A, "POST", `/market/order?oid=o-qty-${R}&seller=${uidS}&ref=v1&qty=6&price=30000`); check("Cannot buy more than listed", r.status === 409, err(r));
  r = await api(A, "POST", `/market/order?oid=o-frac-${R}&seller=${uidS}&ref=v1&qty=1.5&price=30000`); check("Fractional quantity refused", r.status === 400, err(r));
  r = await api(A, "POST", `/market/order?oid=o-1-${R}&seller=${uidS}&ref=v1&qty=2&price=30000`); const wa = await wallet(A), ws = await wallet(S);
  check("Sale settles at once on both sides, fee 1% to the treasury", r.status === 200 && r.body.order.status === "filled" && r.body.order.fee === 600 && wa.bal.vegiex === "210000" && ws.locked.vegiex === "30000" && ws.bal.bux === "59400", err(r) + " " + JSON.stringify({ a: wa.bal.vegiex, s: ws.bal.bux }));
  r = await api(A, "POST", `/market/order?oid=o-1-${R}&seller=${uidS}&ref=v1&qty=2&price=30000`); check("Replaying an order id returns the same order, no second payment", r.status === 200 && (await wallet(A)).bal.vegiex === "210000", err(r));
  const P = newKey("P"); await api(P, "GET", "/me");
  r = await api(P, "POST", `/market/order?oid=o-poor-${R}&seller=${uidS}&ref=v1&qty=1&price=30000`); check("Buyer without BuX refused", r.status === 409, err(r));
  await sleep(10500);   // the rate limit (40 writes per 10 s) is a rule too: let it clear before the next block
  r = await ledger(A, { op: "mkt-refund-o-1-" + R, kind: "post", lines: [["bux", "60000"]] }); check("No refund of a settled order", r.status === 422, err(r));
  r = await ledger(A, { op: "mkt-refund-none", kind: "post", lines: [["bux", "1"]] }); check("No refund without a payment", r.status === 422, err(r));
  // Resale of bought goods: A bought VegieX; the founder's rule says shops sell only what the citizen produced, found or made.
  await credit(A, "quarx", "20000", "mine-dev-a2"); await api(A, "POST", "/shop/open?name=Flip&t=farmx");
  r = await ledger(A, { op: "mkt-list-flip", kind: "lock", lk: "LOCK", asset: "vegiex", qty: "20000" });
  check("GAP? Bought goods cannot be listed for resale (server does not know the origin of stock)", r.status === 422, err(r));
  // Xahara anti-flip: the fee rate comes from the seller's own shop document.
  await credit(X, "quarx", "0", "mine-dev-x").catch(() => {});
  r = await api(X, "POST", "/shop/open?name=Dunes&t=xahara"); check("Xahara stall opens for free", r.status === 200 && r.body.quarx === 0, err(r));
  await api(X, "PUT", "/doc?c=shops&id=" + uidX, { data: { name: "Dunes", openUntil: Date.now() + 86400000, items: [{ ref: "it1", asset: "item", qty: 1, price: 100000, title: "Bought elsewhere", kind: "Collectible", feeBps: 0, link: "javascript:alert(1)" }] } });
  r = await api(A, "POST", `/market/order?oid=o-it1-${R}&seller=${uidX}&ref=it1&qty=1&price=100000`);
  check("Unsafe proof links are dropped from the order record", r.status === 200 && r.body.order.meta && r.body.order.meta.link === null, JSON.stringify(r.body.order && r.body.order.meta));
  check("GAP? Anti-flip fee on a resold item is not self-declared by the seller", r.status === 200 && r.body.order.fee > 0, "fee=" + (r.body.order && r.body.order.fee));
  r = await api(A, "POST", `/market/order?oid=o-it2-${R}&seller=${uidX}&ref=it1&qty=1&price=100000`); check("A unique item sells once", r.status === 409, err(r));
  // --- World rules ---
  await sleep(10500);
  r = await api(A, "PUT", "/doc?c=claims&id=AQX-01", { data: { owner: uidA } }); check("The House on the River can never be claimed", r.status === 403, err(r));
  r = await api(A, "PUT", "/doc?c=claims&id=XTL-01", { data: { owner: uidA } }); check("Locked reserves cannot be claimed", r.status === 403, err(r));
  r = await api(A, "PUT", `/doc?c=claims&id=XIM-T-${R}`, { data: { owner: uidS } }); check("A claim must name its own holder", r.status === 403, err(r));
  r = await api(A, "PUT", `/doc?c=claims&id=XIM-T-${R}`, { data: { owner: uidA } }); const r5 = await api(S, "PUT", `/doc?c=claims&id=XIM-T-${R}`, { data: { owner: uidS } });
  check("A held parcel cannot be taken over", r.status === 200 && r5.status === 409, err(r5));
  r = await api(A, "PUT", "/doc?c=citizens&id=" + uidS, { data: { handle: "pwned" } }); check("Cannot rewrite another citizen's document", r.status === 403, err(r));
  r = await api(A, "PUT", "/doc?c=state&id=" + uidA, { data: { big: "x".repeat(1024 * 1024 + 10) } }); check("Oversized document refused", r.status === 413, err(r));
  r = await api(A, "POST", "/quarx/claim"); check("Claiming a seam that was never started refused", r.status === 404, err(r));
  r = await api(A, "POST", "/quarx/start?mult=0.01"); check("Page cannot speed a seam up (mult below 1 is clamped)", r.status === 200 && r.body.end - r.body.start >= 60000, (r.body.end - r.body.start) + "ms");
  r = await api(A, "POST", "/quarx/claim"); check("Seam cannot be collected early", r.status === 409, err(r));
  r = await api(A, "POST", "/farm/claim"); check("Harvest without a plot refused", r.status === 404, err(r));
  r = await api(A, "POST", "/farm/start?kind=vegiex&mult=5"); check("Page cannot raise a yield (mult above 1 is clamped)", r.status === 200 && r.body.out === 12, "out=" + r.body.out);
  r = await api(A, "POST", "/farm/claim"); check("Harvest cannot be claimed early", r.status === 409, err(r));
  let hits = 0; for (let i = 0; i < 45; i++) { const x = await ledger(A, { op: "spam-" + i, kind: "post", lines: [["bux", "-1"]] }); if (x.status === 429) hits++; }
  check("Rate limit stops a burst of writes", hits > 0, hits + " refused of 45");
  const adm = await fetch(base + "/admin/wallets", { headers: { "x-xland-key": A, "x-xland-admin": "founder-test-key-1234567890" } }).then(x => x.json());
  check("Founder dashboard records refused operations", adm.rejects.length >= 10, adm.rejects.length + " recent rejects");
  console.log(`\n${pass} passed, ${failN} failed`); if (gaps.length) console.log("GAPS:\n - " + gaps.join("\n - ")); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
