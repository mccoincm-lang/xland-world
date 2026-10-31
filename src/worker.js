// Xland — xland.world (Cloudflare Worker)
// Serves the Xland world and its shared multiplayer API, plus the waitlist.
// Bindings: D1 database as `DB` (xland-waitlist). Secret `ADMIN_KEY`: the founder key (dashboard, moderation, CSV export).
// Tables are created automatically on first use; schema.sql holds the same statements.
import HTML from "../dist/index.html";
import FORGE from "../dist/forge.html";
import WORLD from "./world.json";

const SEC = {
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000; includeSubDomains', 'permissions-policy': 'camera=(), microphone=(), geolocation=()'
};
const json = (o, s=200) => new Response(JSON.stringify(o), {status:s, headers:{'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', ...SEC}});
const fail = (s, error) => json({ok:false, error}, s);
const INTERESTS = ['explore','build','farm','govern','shop','partner'];

/* ---------------- Shared world: rules ----------------
   Each citizen is identified by a device key the browser generates and keeps. The server never stores the key,
   only uid = hash(key). Collections mirror the prototype's access rules:
   - public, self-write: citizens, posts, gov, ballots  (a citizen writes only the document named by their own uid)
   - claims: anyone may claim a free parcel; only the holder may rewrite it (atomic, no double-claims)
   - private: state (own only), progress and feedback (own write; only the founder reads them all)
   - posts: the founder may also rewrite any posts document (moderation)
   - shops: public, self-write (a citizen's shopfront and the goods they list). Orders are not documents: the server
     keeps the order book itself (xl_orders) so a listing can never be oversold and an order settles only once.
     Listed goods are reserved in the merchant's wallet, so an order settles at once ('filled'); 'paid' orders are
     only left from the alpha's first market and are still filled or declined by the merchant's page. */
const PUBLIC = ['citizens','posts','gov','ballots','claims','shops'];
const FOUNDER_READ = ['progress','feedback'];
const SELF_WRITE = ['citizens','posts','gov','ballots','progress','feedback','state','shops'];
const ALL = PUBLIC.concat(FOUNDER_READ, ['state']);
const MAX_DOC = 64 * 1024, MAX_STATE = 1024 * 1024;
const NEW_PER_NETWORK_PER_DAY = 60;   // testers often share one network (office Wi-Fi, mobile carrier NAT)
const ID_RE = /^[A-Za-z0-9_\-]{1,64}$/;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS waitlist (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, name TEXT, interest TEXT, lang TEXT, country TEXT, created_at TEXT DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS xl_docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, owner TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (col, id))",
  "CREATE INDEX IF NOT EXISTS xl_docs_updated ON xl_docs (updated_at)",
  "CREATE TABLE IF NOT EXISTS xl_accounts (uid TEXT PRIMARY KEY, created_at INTEGER NOT NULL, netday TEXT NOT NULL, country TEXT)",
  "CREATE INDEX IF NOT EXISTS xl_accounts_netday ON xl_accounts (netday)",
  "CREATE TABLE IF NOT EXISTS xl_leases (key TEXT PRIMARY KEY, holder TEXT NOT NULL, expires INTEGER NOT NULL)",
  // World economy, kept by the server so no citizen can change it: global counters, open QuarX seams, mining log, BuX mints
  "CREATE TABLE IF NOT EXISTS xl_world (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS xl_seams (uid TEXT PRIMARY KEY, started INTEGER NOT NULL, ends INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS xl_minelog (uid TEXT NOT NULL, at INTEGER NOT NULL, amount INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS xl_minelog_at ON xl_minelog (at)",
  "CREATE TABLE IF NOT EXISTS xl_mints (uid TEXT PRIMARY KEY, amount INTEGER NOT NULL, at INTEGER NOT NULL)",
  // Citizen shops in Plaxa: shopfronts built (QuarX consumed), and the order book between citizens
  "CREATE TABLE IF NOT EXISTS xl_shopfronts (uid TEXT PRIMARY KEY, name TEXT NOT NULL, quarx INTEGER NOT NULL, at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS xl_orders (oid TEXT PRIMARY KEY, buyer TEXT NOT NULL, seller TEXT NOT NULL, ref TEXT NOT NULL, asset TEXT NOT NULL, qty INTEGER NOT NULL, price INTEGER NOT NULL, total INTEGER NOT NULL, fee INTEGER NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS xl_orders_buyer ON xl_orders (buyer, updated)",
  "CREATE INDEX IF NOT EXISTS xl_orders_seller ON xl_orders (seller, updated)",
  "CREATE INDEX IF NOT EXISTS xl_orders_ref ON xl_orders (seller, ref, status)",
  "CREATE TABLE IF NOT EXISTS xl_coops (id TEXT PRIMARY KEY, name TEXT NOT NULL, founder TEXT NOT NULL, territory TEXT NOT NULL, created INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS xl_coop_members (uid TEXT PRIMARY KEY, coop TEXT NOT NULL, joined INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS xl_coop_members_coop ON xl_coop_members (coop)",
  "ALTER TABLE xl_shopfronts ADD COLUMN territory TEXT NOT NULL DEFAULT 'xetropolitan'",
  "ALTER TABLE xl_orders ADD COLUMN meta TEXT",
  // Wallets held by the server (r52): one official wallet per citizen and its append-only ledger of operations
  "CREATE TABLE IF NOT EXISTS xl_wallets (uid TEXT PRIMARY KEY, data TEXT NOT NULL, ver INTEGER NOT NULL, updated INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS xl_ledger (uid TEXT NOT NULL, op TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (uid, op))",
  "CREATE INDEX IF NOT EXISTS xl_ledger_at ON xl_ledger (uid, at)",
  "CREATE TABLE IF NOT EXISTS xl_rejects (uid TEXT NOT NULL, op TEXT NOT NULL, why TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS xl_rejects_at ON xl_rejects (at)",
  "CREATE TABLE IF NOT EXISTS xl_plots (uid TEXT NOT NULL, slot TEXT NOT NULL, kind TEXT NOT NULL, started INTEGER NOT NULL, ends INTEGER NOT NULL, out INTEGER NOT NULL, op TEXT NOT NULL, PRIMARY KEY (uid, slot))",
  // Construction timed by the server (r53): every build site, its reserved resources, and its commitment and completion times
  "CREATE TABLE IF NOT EXISTS xl_builds (uid TEXT NOT NULL, key TEXT NOT NULL, def TEXT NOT NULL, parcel TEXT, name TEXT, started INTEGER NOT NULL, commit_at INTEGER NOT NULL, ends INTEGER NOT NULL, reserved TEXT NOT NULL, status TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (uid, key))",
  "CREATE INDEX IF NOT EXISTS xl_builds_parcel ON xl_builds (parcel, status)",
  // The Xiberal Assembly held by the server (r53): proposals with server-set times and quorum, one ballot per citizen and proposal
  "CREATE TABLE IF NOT EXISTS xl_proposals (pid TEXT PRIMARY KEY, uid TEXT NOT NULL, type TEXT NOT NULL, law TEXT NOT NULL, content TEXT NOT NULL, published INTEGER NOT NULL, voting_at INTEGER NOT NULL, closes_at INTEGER NOT NULL, execute_at INTEGER NOT NULL, quorum INTEGER NOT NULL, policy TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS xl_proposals_uid ON xl_proposals (uid, published)",
  "CREATE TABLE IF NOT EXISTS xl_ballots (pid TEXT NOT NULL, uid TEXT NOT NULL, choice TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (pid, uid))",
  // The living map (r55): buildings wear and are repaired; hazards raised by real weather at each territory's twin on Earth
  "ALTER TABLE xl_builds ADD COLUMN repaired_at INTEGER",
  "CREATE TABLE IF NOT EXISTS xl_hazards (id TEXT PRIMARY KEY, type TEXT NOT NULL, territory TEXT NOT NULL, start INTEGER NOT NULL, ends INTEGER NOT NULL, source TEXT NOT NULL, place TEXT, reading TEXT)",
  "CREATE INDEX IF NOT EXISTS xl_hazards_t ON xl_hazards (territory, start)",
  "CREATE TABLE IF NOT EXISTS xl_weather (t TEXT PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL)",
  // Land between citizens (r56): one asking price per parcel, and what the current holder paid and when
  "CREATE TABLE IF NOT EXISTS xl_listings (id TEXT PRIMARY KEY, seller TEXT NOT NULL, price INTEGER NOT NULL, at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS xl_landbasis (id TEXT PRIMARY KEY, owner TEXT NOT NULL, basis INTEGER NOT NULL, at INTEGER NOT NULL)"
];

/* ---------------- World economy (server-authoritative) ----------------
   Amounts are in base units: 1 QuarX = 1 BuX = 10,000 units (the page uses the same DEC = 4).
   QuarX: hard cap 1,000,000,000. A quarter is the genesis reserve (Forerunner Vaults); the other 750,000,000 can only
   be mined in Xalp. Mining epochs halve: epoch 1 releases half of the minable supply, epoch 2 a quarter, and so on, and
   the reward per seam halves with each epoch. Difficulty: seams take longer when more citizens mine than the target.
   BuX: 1 BuX = 1 USD, minted only against a stablecoin deposit that stays locked in the BanX reserve for good.
   The page mirrors these rules (ECONOMY in index.html) for display and for its rule tests. */
const UNIT = 10000;
/* r54 (founder decision 25 Oct 2026): difficulty targets a fixed number of seams a day across Xland, not a number of miners.
   Seams take longer only once more than about 267 citizens mine, so total issuance holds near 256,673 seams a day and the
   first epoch lasts about four years, like Bitcoin. The old target of 8 miners capped Xland at 7,680 QuarX a day. */
const ECON = { quarxCap: 1e9, genesis: 2.5e8, seamReward: 1, seamSecsMin: 60, seamSecsMax: 120, seamSecsBase: 90, dailySeams: 5, targetSeamsPerDay: 256673, sandboxBuX: 1000 };
ECON.targetMiners = ECON.targetSeamsPerDay * ECON.seamSecsBase / 86400;   // ≈ 267 miners at full speed
/* Citizen shops. Each open territory has its own kind of shop: the QuarX its shopfront consumes for good, stated since r54
   (founder decision) as a multiple of the current seam reward so it halves with every halving (5 QuarX in epoch 1, 2.5 in
   epoch 2 for Xetropolitan), the goods it may sell, and the market fee to the territory treasury (none in tax-free lands). A buyer may cancel an
   order the merchant has not filled after 24 hours. The page mirrors this table (SHOP_TERR in index.html). */
const SHOPS = {
  xetropolitan: { quarx: 5, feeBps: 100, assets: ['vegiex', 'livestox', 'quarx'] },
  farmx:        { quarx: 2, feeBps: 100, assets: ['vegiex', 'livestox'] },
  ximberland:   { quarx: 3, feeBps: 100, assets: ['vegiex'] },
  xalp:         { quarx: 4, feeBps: 0,   assets: ['quarx'] },
  tundrax:      { quarx: 6, feeBps: 0,   assets: ['vegiex', 'livestox', 'quarx'], max: 50 },
  // Ixeland cooperatives: up to five members, each paying an equal share of 3 QuarX; open for sale from three members
  ixeland:      { quarx: 3, feeBps: 100, assets: ['vegiex', 'livestox', 'quarx'], coop: { max: 5, openAt: 3 } },
  // Xahara bazaar stalls: free; unique rare and digital assets, one at a time; resale of bought assets pays the anti-flip fee
  xahara:       { quarx: 0, feeBps: 0,   assets: ['item'] }
};
const MARKET = { maxQty: 1000, maxOpenPerBuyer: 20, cancelAfterMs: 24 * 3600 * 1000 };
/* Parcels no citizen can ever claim: the eternal House on the River (Aquax) and the locked reserves. */
const UNCLAIMABLE = /^(AQX|XTL|XST)-/;
const MINABLE = (ECON.quarxCap - ECON.genesis) * UNIT;
function quarxEpoch(mined){ if(mined >= MINABLE) return Infinity; return Math.floor(-Math.log2(1 - mined / MINABLE)); }
function seamReward(mined){ const e = quarxEpoch(mined); if(!isFinite(e)) return 0; return Math.max(1, Math.floor(ECON.seamReward * UNIT / 2 ** e)); }
function nextHalvingAt(mined){ const e = quarxEpoch(mined); return isFinite(e) ? Math.ceil(MINABLE * (1 - 2 ** -(e + 1))) : MINABLE; }
function difficulty(miners){ return Math.max(1, miners / ECON.targetMiners); }
/* Costs in QuarX are multiples of the current seam reward (r54): k × reward, in base units. */
const quarxCost = (k, mined) => Math.floor(k * seamReward(mined));
function shopCost(t, mined){ const c = SHOPS[t]; return c.coop ? Math.floor(quarxCost(c.quarx, mined) / c.coop.max) : quarxCost(c.quarx, mined); }
/* Anti-flip fee on a resold item: 20% within 30 days of acquiring it, falling to zero by day 180 (SIM.flip in index.html). */
const FLIP = { maxBps: 2000, fullDays: 30, zeroDays: 180 };
function flipFeeBps(heldMs){ const d = heldMs / 86400000; if(d <= FLIP.fullDays) return FLIP.maxBps; if(d >= FLIP.zeroDays) return 0; return Math.round(FLIP.maxBps * (FLIP.zeroDays - d) / (FLIP.zeroDays - FLIP.fullDays)); }
const dayStart = t => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };
async function worldCounter(env, k){ const r = await env.DB.prepare('SELECT n FROM xl_world WHERE k = ?1').bind(k).first(); return r ? Number(r.n) : 0; }
async function addWorld(env, k, d){ await env.DB.prepare('INSERT INTO xl_world (k, n) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET n = n + excluded.n').bind(k, d).run(); }
async function miners24h(env, now){ const r = await env.DB.prepare('SELECT COUNT(DISTINCT uid) AS n FROM xl_minelog WHERE at > ?1').bind(now - 86400000).first(); return r ? Number(r.n) : 0; }
async function worldReport(env, now){
  const mined = await worldCounter(env, 'quarx_mined'), miners = await miners24h(env, now);
  const hz = await hazardsSince(env, now - 2 * 86400000);
  return {
    unit: UNIT,
    living: { hazards: hz.map(hazardOut), weather: await weatherNow(env), weatherAt: await worldCounter(env, 'weather_at'), landSold: await worldCounter(env, 'land_sold'), landResold: await worldCounter(env, 'land_resold'), landFees: await worldCounter(env, 'land_fees'), listings: await landListings(env) },
    quarx: { cap: ECON.quarxCap * UNIT, genesis: ECON.genesis * UNIT, minable: MINABLE, mined, epoch: quarxEpoch(mined) + 1, reward: seamReward(mined),
      nextHalvingAt: nextHalvingAt(mined), miners24h: miners, difficulty: difficulty(miners), dailySeams: ECON.dailySeams, targetSeamsPerDay: ECON.targetSeamsPerDay, targetMiners: ECON.targetMiners },
    bux: { minted: await worldCounter(env, 'bux_minted'), reserve: await worldCounter(env, 'bux_reserve') },
    market: { shopfronts: await worldCounter(env, 'shopfronts'), quarxConsumed: await worldCounter(env, 'quarx_consumed'), sales: await worldCounter(env, 'market_sales'),
      volume: await worldCounter(env, 'market_volume'), fees: await worldCounter(env, 'market_fees'), shops: SHOPS,
        shopCosts: Object.fromEntries(Object.keys(SHOPS).map(t => [t, shopCost(t, mined)])), buildCosts: Object.fromEntries(Object.entries(BUILDS).map(([k, d]) => [k, quarxCost(d.recipe.quarx, mined)])) }
  };
}
const orderOut = o => ({ meta: o.meta ? JSON.parse(o.meta) : null, oid:o.oid, buyer:o.buyer, seller:o.seller, ref:o.ref, asset:o.asset, qty:Number(o.qty), price:Number(o.price), total:Number(o.total), fee:Number(o.fee), status:o.status, created:Number(o.created), updated:Number(o.updated) });
/* ---------------- Wallets held by the server ----------------
   The server keeps every citizen's official balances. A citizen's page proposes each operation it performs; the server
   applies it only if it is valid:
   - spending (every change negative) is valid when the balance covers it;
   - locks move value between available and locked, and consumption leaves the locked side;
   - value enters a wallet only from sources the server can check: the sandbox mint, a seam or a harvest the server
     timed, a sale or purchase in its own order book, a refund of an order that did not settle, a swap at the posted
     market rates, or the Forerunner presale at its fixed price and per-citizen cap.
   Each operation id is applied once. Amounts are integer base units (1 = 10,000 units). */
const WALLET_ASSETS = ['bux', 'lex', 'vegiex', 'livestox', 'quarx'];
const RATES = { vegiex: 2, livestox: 5, quarx: 40 };                      // BuX per unit at FarmXSwap, the Green exchange and Forgex
const VENUES = { farmxswap: ['vegiex', 'livestox'], greenx: ['vegiex', 'livestox', 'quarx'], forgex: ['vegiex', 'livestox', 'quarx'] };
const PRESALE = { priceBuX: 30, capQuarx: 5 };
const FARM = { vegiex: { out: 12, secs: 45 }, livestox: { out: 6, secs: 75 } };
const IMPORT_CAP = { bux: 50000, lex: 1000, vegiex: 10000, livestox: 10000, quarx: 1000 };   // alpha balances carried over once
const B = v => { try { return BigInt(v); } catch { return null; } };
async function walletGet(env, uid){
  const r = await env.DB.prepare('SELECT data, ver FROM xl_wallets WHERE uid = ?1').bind(uid).first();
  return r ? { w: JSON.parse(r.data), ver: Number(r.ver), exists: true } : { w: { bal: {}, locked: {} }, ver: 0, exists: false };
}
function walletOut(w){ const o = { bal: {}, locked: {} }; WALLET_ASSETS.forEach(a => { o.bal[a] = String(w.bal[a] || '0'); o.locked[a] = String(w.locked[a] || '0'); }); return o; }
const opExists = async (env, uid, op) => !!(await env.DB.prepare('SELECT 1 FROM xl_ledger WHERE uid = ?1 AND op = ?2').bind(uid, op).first());
/* Apply one operation: avail and locked are maps of asset -> BigInt change. Written once per op id; never below zero. */
async function walletApply(env, uid, op, avail, locked, data){
  for(let attempt = 0; attempt < 6; attempt++){
    const ins = await env.DB.prepare('INSERT OR IGNORE INTO xl_ledger (uid, op, data, at) VALUES (?1, ?2, ?3, ?4)').bind(uid, op, JSON.stringify(data || {}), Date.now()).run();
    if(!ins.meta.changes) return { ok: true, dup: true };
    const { w, ver, exists } = await walletGet(env, uid), nw = { bal: { ...w.bal }, locked: { ...w.locked } };
    let bad = null;
    for(const [a, d] of Object.entries(avail || {})){ const v = BigInt(nw.bal[a] || '0') + d; if(v < 0n) bad = `Not enough ${a === 'bux' ? 'BuX' : a} in your wallet.`; nw.bal[a] = v.toString(); }
    for(const [a, d] of Object.entries(locked || {})){ const v = BigInt(nw.locked[a] || '0') + d; if(v < 0n) bad = 'Not enough reserved for this.'; nw.locked[a] = v.toString(); }
    if(bad){ await env.DB.prepare('DELETE FROM xl_ledger WHERE uid = ?1 AND op = ?2').bind(uid, op).run(); return { ok: false, why: bad }; }
    const now = Date.now();
    const r = exists
      ? await env.DB.prepare('UPDATE xl_wallets SET data = ?1, ver = ver + 1, updated = ?2 WHERE uid = ?3 AND ver = ?4').bind(JSON.stringify(nw), now, uid, ver).run()
      : await env.DB.prepare('INSERT OR IGNORE INTO xl_wallets (uid, data, ver, updated) VALUES (?1, ?2, 1, ?3)').bind(uid, JSON.stringify(nw), now).run();
    if(r.meta.changes) return { ok: true, wallet: nw };
    await env.DB.prepare('DELETE FROM xl_ledger WHERE uid = ?1 AND op = ?2').bind(uid, op).run();   // someone else wrote first: try again
  }
  return { ok: false, why: 'The wallet is busy. Try again.' };
}
async function quarxSoldToday(env, uid, now){
  const { results } = await env.DB.prepare("SELECT op, data FROM xl_ledger WHERE uid = ?1 AND at >= ?2 AND (op LIKE 'swap-%' OR op LIKE 'mkt-list-%')").bind(uid, dayStart(now)).all();
  let sold = 0n; results.forEach(r => { const d = JSON.parse(r.data); if(r.op.startsWith('swap-') && d.d && B(d.d.quarx) < 0n) sold -= B(d.d.quarx); if(r.op.startsWith('mkt-list-') && d.asset === 'quarx') sold += B(d.qty) || 0n; });
  return sold;
}
/* r54: a shop sells only what its citizen produced (mined, harvested or carried over from the alpha), less what they already
   sold at the exchanges or listed: bought goods cannot be relisted. Mirrors listableUnits() in index.html. */
async function listableQty(env, uid, a){
  const { results } = await env.DB.prepare("SELECT op, data FROM xl_ledger WHERE uid = ?1 AND (op LIKE 'mine-%' OR op LIKE 'prod-%' OR op LIKE 'swap-%' OR op LIKE 'mkt-list-%' OR op LIKE 'mkt-unlist-%' OR op = 'import-alpha')").bind(uid).all();
  let n = 0n;
  for(const r of results){ const d = JSON.parse(r.data);
    if(r.op === 'import-alpha'){ n += (B((d.bal || {})[a]) || 0n) + (B((d.locked || {})[a]) || 0n); continue; }
    if(r.op.startsWith('mkt-list-') || r.op.startsWith('mkt-unlist-')){ if(d.asset === a) n += (r.op.startsWith('mkt-list-') ? -1n : 1n) * (B(d.qty) || 0n); continue; }
    const v = d.d ? B(d.d[a]) || 0n : 0n;
    if(r.op.startsWith('swap-')){ if(v < 0n) n += v; } else if(v > 0n) n += v; }
  return n;
}
/* r54: presale QuarX may build at once but is tradable only after 12 months (SIM.presale.releaseMonths). Construction and
   shopfronts consume it first, as the page's useVested() does. */
const PRESALE_LOCK_MS = 12 * 30 * 86400000;
async function vestedQuarx(env, uid, now){
  const { results } = await env.DB.prepare("SELECT op, data, at FROM xl_ledger WHERE uid = ?1 AND (op LIKE 'presale-%' OR op LIKE 'shop-build%' OR op LIKE 'build-consume-%' OR op LIKE 'proj-%-consume-quarx')").bind(uid).all();
  let v = 0n, used = 0n;
  for(const r of results){ const d = JSON.parse(r.data);
    if(r.op.startsWith('presale-')){ if(now - Number(r.at) < PRESALE_LOCK_MS) v += B(d.d.quarx) || 0n; }
    else if(d.asset === 'quarx') used += B(d.qty) || 0n; }
  return v > used ? v - used : 0n;
}
async function sandboxMint(env, uid, now){
  if(await opExists(env, uid, 'import-alpha')) return { ok: true, dup: true };   // carried over with the alpha balances
  const amount = ECON.sandboxBuX * UNIT;
  const r = await env.DB.prepare('INSERT OR IGNORE INTO xl_mints (uid, amount, at) VALUES (?1, ?2, ?3)').bind(uid, amount, now).run();
  if(r.meta.changes){ await addWorld(env, 'bux_minted', amount); await addWorld(env, 'bux_reserve', amount); }
  return walletApply(env, uid, 'sandbox-grant', { bux: BigInt(amount) }, null, { d: { bux: String(amount) }, src: 'mint' });
}
/* Validate an operation proposed by a citizen's page and apply it. */
async function walletPropose(env, uid, body, now){
  const op = String(body.op || '');
  if(!/^[A-Za-z0-9_\-:.]{3,96}$/.test(op) || op.startsWith('srv-') || op.startsWith('import-')) return { ok: false, why: 'Invalid operation.' };
  if(await opExists(env, uid, op)) return { ok: true, dup: true };
  if(body.kind === 'lock'){
    const a = body.asset, q = B(body.qty);
    if(!WALLET_ASSETS.includes(a) || q === null || q <= 0n) return { ok: false, why: 'Invalid reservation.' };
    if(BUILD_PREFIXES.some(p => op.startsWith(p))) return { ok: false, why: 'Construction is timed by the server.' };   // r53: build sites reserve, release and consume through /api/build/*
    if(op.startsWith('mkt-list-') && body.lk === 'LOCK'){
      if(await listableQty(env, uid, a) < q) return { ok: false, why: 'A shop sells only what you produced yourself. Bought goods cannot be resold.' };
      if(a === 'quarx'){ const { w } = await walletGet(env, uid); if(BigInt(w.bal.quarx || '0') - await vestedQuarx(env, uid, now) < q) return { ok: false, why: 'Presale QuarX becomes tradable 12 months after the presale.' }; } }
    if(op.startsWith('mkt-list-') && a === 'quarx'){ const cap = BigInt(ECON.dailySeams * seamReward(await worldCounter(env, 'quarx_mined'))); if(await quarxSoldToday(env, uid, now) + q > cap) return { ok: false, why: 'Daily QuarX sale limit reached.' }; }
    const data = { lk: body.lk, asset: a, qty: q.toString() };
    if(body.lk === 'LOCK') return walletApply(env, uid, op, { [a]: -q }, { [a]: q }, data);
    if(body.lk === 'UNLOCK') return walletApply(env, uid, op, { [a]: q }, { [a]: -q }, data);
    if(body.lk === 'CONSUME'){ if(op.startsWith('mkt-deliver-')) return { ok: false, why: 'Sales are settled by the market.' }; return walletApply(env, uid, op, null, { [a]: -q }, data); }
    return { ok: false, why: 'Invalid reservation.' };
  }
  const d = {};
  for(const l of Array.isArray(body.lines) ? body.lines : []){ const a = l && l[0], v = B(l && l[1]); if(!WALLET_ASSETS.includes(a) || v === null) return { ok: false, why: 'Invalid operation.' }; d[a] = (d[a] || 0n) + v; }
  const pos = Object.entries(d).filter(([, v]) => v > 0n), data = { d: Object.fromEntries(Object.entries(d).map(([a, v]) => [a, v.toString()])) };
  // r55: land and repairs are settled by the server (/api/land/buy, /api/build/repair): a page-made `parcel-` op of one unit
  // would otherwise unlock a claim and residency. A Homax counts for residency only at its full price.
  if(op.startsWith('parcel-') || op.startsWith('repair-') || op.startsWith('land-')) return { ok: false, why: 'Land and repairs are settled by the land office.' };
  if(op === 'homax-acquire' && (pos.length || Object.keys(d).some(a => a !== 'bux') || -(d.bux || 0n) < BigInt(HOMAX_PRICE * UNIT))) return { ok: false, why: 'A Homax costs ' + HOMAX_PRICE + ' BuX.' };
  if(!pos.length) return walletApply(env, uid, op, d, null, data);                           // spending only
  if(op === 'sandbox-grant') return sandboxMint(env, uid, now);
  if(op.startsWith('swap-')){
    const venue = op.split('-')[1], goods = Object.keys(d).filter(a => a !== 'bux' && d[a] !== 0n), bux = d.bux || 0n;
    if(!VENUES[venue] || goods.length !== 1 || !VENUES[venue].includes(goods[0])) return { ok: false, why: 'This market does not trade that.' };
    const a = goods[0], q = d[a], value = (q < 0n ? -q : q) * BigInt(RATES[a]);
    if(q < 0n){ if(bux > value) return { ok: false, why: 'The price is above the market rate.' };
      if(a === 'quarx'){ const cap = BigInt(ECON.dailySeams * seamReward(await worldCounter(env, 'quarx_mined'))); if(await quarxSoldToday(env, uid, now) - q > cap) return { ok: false, why: 'Daily QuarX sale limit reached.' };
        const { w } = await walletGet(env, uid); if(BigInt(w.bal.quarx || '0') - await vestedQuarx(env, uid, now) < -q) return { ok: false, why: 'Presale QuarX becomes tradable 12 months after the presale.' }; } }
    else if(-bux < value) return { ok: false, why: 'The price is below the market rate.' };
    return walletApply(env, uid, op, d, null, data);
  }
  if(op.startsWith('presale-')){
    const q = d.quarx || 0n, bux = d.bux || 0n;
    if(Object.keys(d).some(a => a !== 'quarx' && a !== 'bux') || q <= 0n || -bux < q * BigInt(PRESALE.priceBuX)) return { ok: false, why: 'Presale QuarX is sold only at its fixed price.' };
    const { results } = await env.DB.prepare("SELECT data FROM xl_ledger WHERE uid = ?1 AND op LIKE 'presale-%'").bind(uid).all();
    const before = results.reduce((s, r) => s + (B(JSON.parse(r.data).d.quarx) || 0n), 0n);
    if(before + q > BigInt(PRESALE.capQuarx * UNIT)) return { ok: false, why: 'The presale cap per citizen is reached.' };
    return walletApply(env, uid, op, d, null, data);
  }
  if(op.startsWith('mkt-refund-')){
    const oid = op.slice(11), pay = await env.DB.prepare('SELECT data FROM xl_ledger WHERE uid = ?1 AND op = ?2').bind(uid, 'mkt-pay-' + oid).first();
    if(!pay || await opExists(env, uid, 'mkt-recv-' + oid)) return { ok: false, why: 'Nothing to refund.' };
    const o = await env.DB.prepare('SELECT status FROM xl_orders WHERE oid = ?1').bind(oid).first();
    if(o && !['declined', 'cancelled'].includes(o.status)) return { ok: false, why: 'This order settled.' };
    const paid = -(B(JSON.parse(pay.data).d.bux) || 0n);
    if(Object.keys(d).length !== 1 || !(d.bux > 0n) || d.bux > paid) return { ok: false, why: 'A refund returns only what was paid.' };
    return walletApply(env, uid, op, d, null, data);
  }
  return { ok: false, why: 'Only the world can credit this.' };   // seams, harvests and market settlements are credited by the server itself
}


/* ---------------- Land for sale (r55) ----------------
   world.json lists every parcel that can be bought: the original parcels and the lots placed on the terrain. Buying is one
   server step: the claim and the payment happen together, so land can no longer be claimed without paying for it.
   A citizen may hold at most LOT_CAP lots in each territory (anti-hoarding), and a citizen without land in a territory may
   buy there only while that territory has room in the current population stage (POP in index.html). */
const LAND = Object.fromEntries(WORLD.land.map(l => [l.id, l]));
const LOT_CAP = 3;
const HOMAX_PRICE = 400;   // SIM.homaxPrice on the page
const POP = { total: 21000000, gateFill: 0.9, stages: [0.01, 0.05, 0.2, 0.5, 1],
  share: { xetropolitan: .40, farmx: .12, ximberland: .12, xalp: .08, ixeland: .07, xahara: .06, tundrax: .01, xetland: .07, xasteland: .07 }, reserve: ['xetland', 'xasteland'] };
async function landHolders(env){
  const { results } = await env.DB.prepare("SELECT id, owner FROM xl_docs WHERE col = 'claims'").all();
  return results.map(r => ({ id: r.id, owner: r.owner, t: (LAND[r.id] || {}).t })).filter(r => r.t);
}
function popRoom(holders, t, uid){
  if(POP.share[t] == null || POP.reserve.includes(t)) return 0;
  const by = {}; const seen = new Set(); holders.forEach(h => { const k = h.t + ':' + h.owner; if(seen.has(k)) return; seen.add(k); by[h.t] = (by[h.t] || 0) + 1; });
  if(seen.has(t + ':' + uid)) return 1;   // already lives there: buying another plot adds no resident
  const open = Object.keys(POP.share).filter(x => !POP.reserve.includes(x)), openTotal = Math.round(POP.total * open.reduce((a, x) => a + POP.share[x], 0)), n = open.reduce((a, x) => a + (by[x] || 0), 0);
  let k = 0; while(k < POP.stages.length - 1 && n >= POP.gateFill * openTotal * POP.stages[k]) k++;
  return Math.round(POP.total * POP.share[t] * POP.stages[k]) - (by[t] || 0);
}
async function landBuy(env, uid, id, handle, now, expect){
  const l = LAND[id];
  if(!l || UNCLAIMABLE.test(id)) return { s: 404, why: 'This land is not for sale.' };
  const cur = await env.DB.prepare("SELECT owner FROM xl_docs WHERE col = 'claims' AND id = ?1").bind(id).first();
  if(cur){
    if(cur.owner === uid) return { s: 200, dup: true };
    const ls = await env.DB.prepare('SELECT seller, price FROM xl_listings WHERE id = ?1').bind(id).first();
    if(!ls || ls.seller !== cur.owner) return { s: 409, why: 'This parcel is already held by another citizen.' };
    return landResale(env, uid, id, l, ls, expect, handle, now);
  }
  const holders = await landHolders(env);
  if(l.lot && holders.filter(h => h.owner === uid && h.t === l.t && LAND[h.id].lot).length >= LOT_CAP) return { s: 409, why: `One citizen can hold up to ${LOT_CAP} lots in each territory. Build on the land you have first.` };
  if(popRoom(holders, l.t, uid) <= 0) return { s: 409, why: 'Every home open in this territory in the current stage is lived in. The next stage opens when 90% of this one is lived in across Xland.' };
  const data = { owner: uid, handle: String(handle || '').slice(0, 24), parcel: id, at: now, paid: l.price };
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO xl_docs (col, id, data, owner, updated_at) VALUES ('claims', ?1, ?2, ?3, ?4)").bind(id, JSON.stringify(data), uid, now).run();
  if(!ins.meta.changes) return { s: 409, why: 'Another citizen acquired this parcel a moment ago.' };
  const price = BigInt(l.price * UNIT), r = await walletApply(env, uid, 'parcel-' + id, { bux: -price }, null, { d: { bux: (-price).toString() }, src: 'land', t: l.t });
  if(!r.ok){ await env.DB.prepare("DELETE FROM xl_docs WHERE col = 'claims' AND id = ?1 AND owner = ?2").bind(id, uid).run(); return { s: 409, why: r.why }; }
  if(!r.dup){ await addWorld(env, 'land_sold', 1); await setBasis(env, id, uid, l.price, now); }
  return { s: 200, claim: data };
}

/* ---------------- Land between citizens (r56) ----------------
   A holder names an asking price; another citizen buys in one server step: the listing is taken (so it can be sold only
   once), the buyer pays, the claim and every finished building on it change hands, and the seller is paid less the
   anti-flip fee (FLIP, 20% within 30 days of acquiring, falling to zero by day 180), which goes to the territory.
   In territories with a resale floor (TERR.resaleFloor in index.html) land never sells below acquisition + the floor.
   The House on the River is not in LAND and can never be listed. */
const RESALE_FLOOR = { ximberland: 1, tundrax: 1 };
async function setBasis(env, id, owner, basis, at){
  await env.DB.prepare('INSERT INTO xl_landbasis (id, owner, basis, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, basis = excluded.basis, at = excluded.at').bind(id, owner, basis, at).run();
}
/* What the holder paid and when. Older claims fall back to the registry price and the server's own records (the ledger,
   or the claim's last update, which can only make the anti-flip fee larger): never to what the claim document says. */
async function landBasis(env, id, owner){
  const r = await env.DB.prepare('SELECT basis, at FROM xl_landbasis WHERE id = ?1 AND owner = ?2').bind(id, owner).first();
  if(r) return { basis: Number(r.basis), at: Number(r.at) };
  const op = await env.DB.prepare('SELECT at FROM xl_ledger WHERE uid = ?1 AND op = ?2').bind(owner, 'parcel-' + id).first();
  const c = await env.DB.prepare("SELECT updated_at FROM xl_docs WHERE col = 'claims' AND id = ?1").bind(id).first();
  return { basis: LAND[id].price, at: op ? Number(op.at) : c ? Number(c.updated_at) : Date.now() };
}
async function landList(env, uid, id, price, now){
  const l = LAND[id];
  if(!l || UNCLAIMABLE.test(id)) return { s: 404, why: 'This land can never be sold.' };
  const c = await env.DB.prepare("SELECT owner FROM xl_docs WHERE col = 'claims' AND id = ?1").bind(id).first();
  if(!c || c.owner !== uid) return { s: 403, why: 'You do not hold this land.' };
  if(!Number.isInteger(price) || price < 1 || price > 10000000) return { s: 400, why: 'Enter an asking price in whole BuX.' };
  if(await env.DB.prepare("SELECT 1 FROM xl_builds WHERE uid = ?1 AND parcel = ?2 AND status IN ('active', 'committed')").bind(uid, id).first()) return { s: 409, why: 'Finish or cancel the building going up here first.' };
  const b = await landBasis(env, id, uid), floor = RESALE_FLOOR[l.t];
  if(floor != null && price < b.basis + floor) return { s: 409, why: `Local law: land here is never resold below its acquisition price + ${floor} BuX, so at least ${b.basis + floor} BuX.` };
  await env.DB.prepare('INSERT INTO xl_listings (id, seller, price, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET seller = excluded.seller, price = excluded.price, at = excluded.at').bind(id, uid, price, now).run();
  return { s: 200, listing: { id, price, at: now, feeBps: flipFeeBps(now - b.at) } };
}
async function landResale(env, uid, id, l, ls, expect, handle, now){
  if(expect !== null && expect !== undefined && expect !== '' && Number(expect) !== Number(ls.price)) return { s: 409, why: 'The asking price has changed. Look again before you buy.' };
  if(l.lot && (await landHolders(env)).filter(h => h.owner === uid && h.t === l.t && LAND[h.id].lot).length >= LOT_CAP) return { s: 409, why: `One citizen can hold up to ${LOT_CAP} lots in each territory. Build on the land you have first.` };
  const seller = ls.seller, price = BigInt(ls.price) * BigInt(UNIT);
  if(await env.DB.prepare("SELECT 1 FROM xl_builds WHERE uid = ?1 AND parcel = ?2 AND status IN ('active', 'committed')").bind(seller, id).first()) return { s: 409, why: 'A building is going up here. Try again when it is finished.' };
  const take = await env.DB.prepare('DELETE FROM xl_listings WHERE id = ?1 AND seller = ?2 AND price = ?3').bind(id, seller, ls.price).run();
  if(!take.meta.changes) return { s: 409, why: 'Another citizen bought this a moment ago.' };
  const relist = () => env.DB.prepare('INSERT OR IGNORE INTO xl_listings (id, seller, price, at) VALUES (?1, ?2, ?3, ?4)').bind(id, seller, ls.price, now).run();
  const tag = id + '-' + now.toString(36);
  const pay = await walletApply(env, uid, 'land-buy-' + tag, { bux: -price }, null, { d: { bux: (-price).toString() }, src: 'land-resale', parcel: id, seller, t: l.t });
  if(!pay.ok){ await relist(); return { s: 409, why: pay.why }; }
  const b = await landBasis(env, id, seller), feeBps = flipFeeBps(now - b.at), fee = price * BigInt(feeBps) / 10000n;
  const data = { owner: uid, handle: String(handle || '').slice(0, 24), parcel: id, at: now, paid: Number(ls.price) };
  const mv = await env.DB.prepare("UPDATE xl_docs SET owner = ?1, data = ?2, updated_at = ?3 WHERE col = 'claims' AND id = ?4 AND owner = ?5").bind(uid, JSON.stringify(data), now, id, seller).run();
  if(!mv.meta.changes){ await walletApply(env, uid, 'land-refund-' + tag, { bux: price }, null, { d: { bux: price.toString() }, src: 'land-refund', parcel: id }); return { s: 409, why: 'The land changed hands a moment ago. You were not charged.' }; }
  await walletApply(env, seller, 'land-sale-' + tag, { bux: price - fee }, null, { d: { bux: (price - fee).toString() }, src: 'land-resale', parcel: id, buyer: uid, fee: fee.toString(), feeBps, t: l.t });
  if(fee > 0n) await addWorld(env, 'land_fees', Number(fee));
  const { results: moved } = await env.DB.prepare("SELECT * FROM xl_builds WHERE uid = ?1 AND parcel = ?2 AND status = 'complete'").bind(seller, id).all();
  await env.DB.prepare("UPDATE xl_builds SET uid = ?1, updated = ?3 WHERE uid = ?2 AND parcel = ?4 AND status = 'complete'").bind(uid, seller, now, id).run();
  await setBasis(env, id, uid, Number(ls.price), now);
  await addWorld(env, 'land_resold', 1);
  return { s: 200, claim: data, resale: { price: Number(ls.price), seller, feeBps, fee: fee.toString() }, builds: moved.map(buildOut) };
}
async function landListings(env){
  const { results } = await env.DB.prepare("SELECT l.id, l.price, l.at, l.seller, c.data FROM xl_listings l JOIN xl_docs c ON c.col = 'claims' AND c.id = l.id AND c.owner = l.seller ORDER BY l.at DESC LIMIT 300").all();
  return results.map(r => { let d = {}; try { d = JSON.parse(r.data); } catch {} return { id: r.id, price: Number(r.price), at: Number(r.at), seller: r.seller, handle: d.handle || '' }; });
}

/* ---------------- Hazards and the real-world bridge (r55) ----------------
   Each territory has a twin on Earth (world.json). Every hour the Worker reads the current weather at all ten twins in one
   Open-Meteo request and turns severe weather into a shared hazard in that territory. Every building standing there loses
   condition once per hazard; a heatwave lowers harvests. Buildings also wear slowly. Condition is computed, not stored:
   100 − wear since the last repair − the damage of every hazard that began since then. Open-Meteo is free for
   non-commercial use; a commercial launch needs their paid plan or another provider. */
const HAZ = WORLD.hazards, TWINS = WORLD.twins;
const HAZARD_HOURS = 6;
const HAZARD_RULES = [   // first match wins; thresholds for one hour, metric units
  { type: 'storm', test: w => w.gust >= 60 || [95, 96, 99].includes(w.code), read: w => `gusts of ${Math.round(w.gust)} km/h` },
  { type: 'flood', test: w => w.precip >= 6, read: w => `${w.precip.toFixed(1)} mm of rain in the last hour` },
  { type: 'snow',  test: w => w.snow >= 1.5, read: w => `${w.snow.toFixed(1)} cm of snow in the last hour` },
  { type: 'heat',  test: w => w.temp >= 44, read: w => `${Math.round(w.temp)}°C` }
];
const HEAT_LANDS = ['xahara', 'xasteland', 'farmx', 'xetropolitan'];
async function hazardsSince(env, since){ const { results } = await env.DB.prepare('SELECT * FROM xl_hazards WHERE ends > ?1 ORDER BY start').bind(since).all(); return results; }
const hazardOut = h => ({ id: h.id, type: h.type, territory: h.territory, start: Number(h.start), end: Number(h.ends), source: h.source, where: h.place, reading: h.reading });
async function raiseHazard(env, h){
  const live = await env.DB.prepare('SELECT * FROM xl_hazards WHERE territory = ?1 AND type = ?2 AND ends > ?3').bind(h.territory, h.type, h.start).first();
  if(live){ await env.DB.prepare('UPDATE xl_hazards SET ends = MAX(ends, ?2), reading = ?3 WHERE id = ?1').bind(live.id, h.ends, h.reading || live.reading).run(); return null; }
  await env.DB.prepare('INSERT OR IGNORE INTO xl_hazards (id, type, territory, start, ends, source, place, reading) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)').bind(h.id, h.type, h.territory, h.start, h.ends, h.source, h.place || null, h.reading || null).run();
  return h;
}
async function weatherBridge(env, now){
  await ensureSchema(env);
  const ids = Object.keys(TWINS), f = env.WEATHER_FETCH || fetch;
  const q = new URLSearchParams({ latitude: ids.map(i => TWINS[i].lat).join(','), longitude: ids.map(i => TWINS[i].lon).join(','),
    current: 'temperature_2m,precipitation,snowfall,wind_speed_10m,wind_gusts_10m,weather_code', wind_speed_unit: 'kmh', timezone: 'UTC' });
  const r = await f('https://api.open-meteo.com/v1/forecast?' + q.toString(), { headers: { 'user-agent': 'xland.world weather bridge' } });
  if(!r.ok) throw new Error('weather service ' + r.status);
  let data = await r.json(); if(!Array.isArray(data)) data = [data];
  const raised = [];
  for(let i = 0; i < ids.length; i++){ const t = ids[i], c = (data[i] || {}).current; if(!c) continue;
    const w = { temp: +c.temperature_2m || 0, precip: +c.precipitation || 0, snow: +c.snowfall || 0, wind: +c.wind_speed_10m || 0, gust: +c.wind_gusts_10m || 0, code: +c.weather_code || 0, at: now };
    await env.DB.prepare('INSERT INTO xl_weather (t, data, at) VALUES (?1, ?2, ?3) ON CONFLICT(t) DO UPDATE SET data = excluded.data, at = excluded.at').bind(t, JSON.stringify(w), now).run();
    const rule = HAZARD_RULES.find(h => h.test(w)); if(!rule || (rule.type === 'heat' && !HEAT_LANDS.includes(t))) continue;
    const h = await raiseHazard(env, { id: `wx-${t}-${rule.type}-${Math.floor(now / 3600000)}`, type: rule.type, territory: t, start: now, ends: now + HAZARD_HOURS * 3600000, source: 'real', place: TWINS[t].name, reading: rule.read(w) });
    if(h) raised.push(hazardOut(h)); }
  await env.DB.prepare("INSERT INTO xl_world (k, n) VALUES ('weather_at', ?1) ON CONFLICT(k) DO UPDATE SET n = excluded.n").bind(now).run();
  return raised;
}
async function weatherNow(env){ const { results } = await env.DB.prepare('SELECT t, data FROM xl_weather').all(); return Object.fromEntries(results.map(r => [r.t, JSON.parse(r.data)])); }
const buildTerritory = b => (LAND[b.parcel] || {}).t || BUILDS[b.def].territory;
function buildCond(b, hz, now){
  if(b.status !== 'complete') return null;
  const base = Math.max(Number(b.ends), Number(b.repaired_at || 0)), t = buildTerritory(b);
  const hits = hz.filter(h => h.territory === t && Number(h.start) >= base && Number(h.start) <= now && HAZ[h.type] && HAZ[h.type].dmg);
  const cond = Math.max(0, 100 - (now - base) / 86400000 * WORLD.wearPerDay - hits.reduce((a, h) => a + HAZ[h.type].dmg, 0));
  return { cond: Math.round(cond * 10) / 10, hits: hits.map(hazardOut) };
}
const condFactor = c => c == null ? 1 : c >= 60 ? 1 : c >= 30 ? 0.6 : 0.3;
function repairCost(b, cond, mined){
  const D = BUILDS[b.def], missing = Math.max(0, 100 - cond); if(missing < 0.5) return { bux: 0n, quarx: 0n };
  const value = (D.recipe.bux || 0) + (D.recipe.quarx || 0) * RATES.quarx;
  return { bux: BigInt(Math.max(1, Math.ceil(missing / 100 * value * 0.6))) * BigInt(UNIT), quarx: cond < 40 ? BigInt(quarxCost(1, mined)) : 0n };
}
async function heatMult(env, t, now){ const h = await env.DB.prepare("SELECT 1 FROM xl_hazards WHERE territory = ?1 AND type = 'heat' AND start <= ?2 AND ends > ?2").bind(t, now).first(); return h ? HAZ.heat.yieldMult : 1; }

/* ---------------- Construction timed by the server (r53) ----------------
   A build site reserves its resources on the server, commits them (consumes them for good) only once the server clock
   has passed the commitment point, and completes only after the server's end time. The page keeps showing its own
   timers, but every reservation, release, consumption and completion is decided here; a citizen's page can no longer
   propose `proj-` or `build-` wallet operations itself. Recipes mirror BUILDING_DEFS and SIM in index.html. */
const onLand = (territory, recipe, secs) => ({ territory, onLand: true, recipe, secs, commitPct: 0.25, opLock: k => a => `${k}-lock-${a}`, opUnlock: k => a => `${k}-unlock-${a}`, opConsume: k => a => `${k}-consume-${a}`, keyRe: /^proj-[A-Z]{2,3}-[A-Za-z0-9]{1,6}-[A-Za-z0-9]{1,12}-[a-z0-9]{1,12}$/ });
/* r55: buildings anyone can raise on land they hold; which ones a parcel allows is listed in world.json (builds). QuarX amounts
   are multiples of the seam reward, as for every recipe since r54. Mirrors BUILDING_DEFS in index.html. */
const BUILDS = {
  farmstead: onLand('farmx', { quarx: 1, bux: 50 }, 60),
  homax: onLand('ximberland', { quarx: 2, bux: 120 }, 120),
  granary: onLand('farmx', { quarx: 2, bux: 80 }, 90),
  caravanserai: onLand('xahara', { quarx: 2, bux: 100 }, 90),
  special:   { territory: 'xetropolitan', recipe: { quarx: 3 }, secs: 40, commitPct: 1, once: true, law: 'permit-special', opLock: k => () => `build-lock-${k}`, opUnlock: k => () => `build-unlock-${k}`, opConsume: k => () => `build-consume-${k}`, keyRe: /^[a-z0-9]{1,12}$/ }
};
const BUILD_PREFIXES = ['proj-', 'build-'];
const buildOut = b => ({ key: b.key, def: b.def, parcel: b.parcel, name: b.name, start: Number(b.started), commitAt: Number(b.commit_at), end: Number(b.ends), reserved: JSON.parse(b.reserved), status: b.status, committed: ['committed', 'complete'].includes(b.status) });
async function buildGet(env, uid, key){ return env.DB.prepare('SELECT * FROM xl_builds WHERE uid = ?1 AND key = ?2').bind(uid, key).first(); }
async function buildStart(env, uid, def, key, parcel, name, now){
  const D = BUILDS[def];
  if(!D) return { s: 400, why: 'Nothing like that can be built.' };
  if(!D.keyRe.test(key)) return { s: 400, why: 'Invalid build site.' };
  if(await buildGet(env, uid, key)) return { s: 409, why: 'This build site already exists.' };
  if(D.onLand){
    if(!parcel || !ID_RE.test(parcel) || !LAND[parcel] || !(LAND[parcel].builds || []).includes(def)) return { s: 400, why: `A ${def} cannot be built on this parcel.` };
    const claim = await env.DB.prepare("SELECT data FROM xl_docs WHERE col = 'claims' AND id = ?1").bind(parcel).first();
    if(!claim || JSON.parse(claim.data).owner !== uid) return { s: 403, why: 'You do not hold this parcel.' };
    if(await env.DB.prepare("SELECT 1 FROM xl_builds WHERE parcel = ?1 AND status IN ('active', 'committed', 'complete')").bind(parcel).first()) return { s: 409, why: 'This parcel is already built on or under construction.' };
    if(await env.DB.prepare('SELECT 1 FROM xl_listings WHERE id = ?1').bind(parcel).first()) return { s: 409, why: 'This land is listed for sale. Withdraw the listing before you build.' };
  }
  if(D.once && await env.DB.prepare("SELECT 1 FROM xl_builds WHERE uid = ?1 AND def = ?2 AND status IN ('active', 'committed', 'complete')").bind(uid, def).first()) return { s: 409, why: 'You already have one of these.' };
  if(D.law && !(await govLaws(env, now)).laws.some(l => l.id === D.law && l.state === 'ACTIVE')) return { s: 403, why: 'Needs a passed motion at CompleX.' };
  const reserved = {}, lockOp = D.opLock(key), unlockOp = D.opUnlock(key), done = [];
  const mined = await worldCounter(env, 'quarx_mined');
  for(const [a, n] of Object.entries(D.recipe)){
    // r54: QuarX costs are multiples of the seam reward
    const q = BigInt(a === 'quarx' ? quarxCost(n, mined) : n * UNIT), r = await walletApply(env, uid, lockOp(a), { [a]: -q }, { [a]: q }, { lk: 'LOCK', asset: a, qty: q.toString(), src: 'build', key });
    if(!r.ok){ for(const [b, qb] of done) await walletApply(env, uid, unlockOp(b), { [b]: qb }, { [b]: -qb }, { lk: 'UNLOCK', asset: b, qty: qb.toString(), src: 'build', key }); return { s: 409, why: r.why }; }
    done.push([a, q]); reserved[a] = q.toString();
  }
  const secs = D.secs * 1000, row = { started: now, commit_at: now + Math.round(secs * D.commitPct), ends: now + secs };
  await env.DB.prepare('INSERT OR IGNORE INTO xl_builds (uid, key, def, parcel, name, started, commit_at, ends, reserved, status, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?6)')
    .bind(uid, key, def, parcel || null, String(name || '').slice(0, 32) || null, now, row.commit_at, row.ends, JSON.stringify(reserved), 'active').run();
  return { s: 200, build: buildOut(await buildGet(env, uid, key)) };
}
async function buildCommit(env, uid, b, now){
  if(b.status !== 'active') return { s: 409, why: `This build site is ${b.status}.` };
  if(now < Number(b.commit_at)) return { s: 409, why: 'The foundation is not finished yet.' };
  const D = BUILDS[b.def], op = D.opConsume(b.key), reserved = JSON.parse(b.reserved);
  const r = await env.DB.prepare("UPDATE xl_builds SET status = 'committed', updated = ?3 WHERE uid = ?1 AND key = ?2 AND status = 'active'").bind(uid, b.key, now).run();
  if(!r.meta.changes) return { s: 409, why: 'This build site was already committed.' };
  for(const [a, q] of Object.entries(reserved)){
    await walletApply(env, uid, op(a), null, { [a]: -BigInt(q) }, { lk: 'CONSUME', asset: a, qty: q, src: 'build', key: b.key });
    if(a === 'quarx') await addWorld(env, 'quarx_consumed', Number(q));
  }
  return { s: 200, build: buildOut(await buildGet(env, uid, b.key)) };
}
/* ---------------- The Xiberal Assembly held by the server (r53) ----------------
   A proposal's times and quorum are fixed by the server when it is published; a ballot counts only if the server
   recorded it while the voting window was open and the voter was a resident at that moment. Every client reads the
   same tally from the server. Law ids and their rollback policy mirror LAWDEF in index.html. */
const GOVS = { policyVersion: 'gov-srv-1', eligibility: 'resident', discussSecs: 300, votingSecs: 7200, timelockSecs: 120, quorumPct: 25, eligibleWindowDays: 14, maxOpenPerCitizen: 3 };
const LAWS = { 'permit-special': { reversible: false }, 'forgex-logistics': { reversible: true }, 'quarry-capacity': { reversible: true }, 'burn-fees': { reversible: false } };
const CHOICES = ['yes', 'no', 'abstain'];
function proposalLaw(type){ if(LAWS[type]) return { law: type, repeal: false }; if(type.startsWith('repeal-') && LAWS[type.slice(7)]) return { law: type.slice(7), repeal: true }; return null; }
/* A resident holds a home: a Homax or a parcel paid for on the server, or a parcel claimed in the shared world. */
async function isResident(env, uid){
  if(await env.DB.prepare("SELECT 1 FROM xl_ledger WHERE uid = ?1 AND (op = 'homax-acquire' OR op LIKE 'parcel-%') LIMIT 1").bind(uid).first()) return true;
  const { results } = await env.DB.prepare("SELECT data FROM xl_docs WHERE col = 'claims' AND owner = ?1 LIMIT 20").bind(uid).all();
  return results.some(r => { try { return JSON.parse(r.data).owner === uid; } catch { return false; } });
}
async function eligibleCount(env, now){
  const since = now - GOVS.eligibleWindowDays * 86400000;
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM xl_docs c WHERE c.col = 'citizens' AND c.updated_at > ?1 AND (
      EXISTS (SELECT 1 FROM xl_ledger l WHERE l.uid = c.id AND (l.op = 'homax-acquire' OR l.op LIKE 'parcel-%'))
      OR EXISTS (SELECT 1 FROM xl_docs k WHERE k.col = 'claims' AND k.owner = c.id))`).bind(since).first();
  return r ? Number(r.n) : 0;
}
const quorumFor = n => Math.max(1, Math.ceil(n * GOVS.quorumPct / 100));
function govTally(p, votes){
  const v = { yes: 0, no: 0, abstain: 0 };
  votes.forEach(b => { if(b.pid === p.pid && b.at >= p.voting_at && b.at <= p.closes_at && v[b.choice] !== undefined) v[b.choice]++; });
  const irr = !LAWS[p.law].reversible && !proposalLaw(p.type).repeal, cast = v.yes + v.no + v.abstain;
  const quorum = cast >= Number(p.quorum), threshold = irr ? (v.yes + v.no > 0 && v.yes * 3 >= (v.yes + v.no) * 2) : v.yes > v.no;
  return { counts: v, cast, quorum, quorumNeeded: Number(p.quorum), threshold, supermajority: irr, passed: quorum && threshold };
}
function govPhase(p, tally, now){ if(now < p.voting_at) return 'DELIBERATION'; if(now < p.closes_at) return 'VOTING'; if(!tally.passed) return 'REJECTED'; if(now < p.execute_at) return 'EXECUTION_PENDING'; return 'DECIDED'; }
async function govLaws(env, now){
  const { results: ps } = await env.DB.prepare('SELECT * FROM xl_proposals ORDER BY published').all();
  const { results: bs } = await env.DB.prepare('SELECT pid, uid, choice, at FROM xl_ballots').all();
  const votes = bs.map(b => ({ pid: b.pid, uid: b.uid, choice: b.choice, at: Number(b.at) }));
  const rows = ps.map(p => ({ ...p, published: Number(p.published), voting_at: Number(p.voting_at), closes_at: Number(p.closes_at), execute_at: Number(p.execute_at) }));
  rows.forEach(p => { p.tally = govTally(p, votes); p.phase = govPhase(p, p.tally, now); });
  const laws = [], results = {};
  rows.filter(p => p.phase === 'DECIDED').sort((a, b) => a.execute_at - b.execute_at || a.published - b.published).forEach(p => {
    const active = laws.find(l => l.id === p.law && l.state === 'ACTIVE');
    if(proposalLaw(p.type).repeal){ if(!active){ results[p.pid] = { r: 'FAILED_EXECUTION', err: 'That law is not active.' }; return; } active.state = 'REPEALED'; active.repealedAt = p.execute_at; }
    else { if(active){ results[p.pid] = { r: 'FAILED_EXECUTION', err: 'That law is already active.' }; return; }
      laws.push({ id: p.law, version: laws.filter(x => x.id === p.law).length + 1, state: 'ACTIVE', effectiveAt: p.execute_at, proposalId: p.pid }); }
    results[p.pid] = { r: 'EXECUTED' }; });
  return { proposals: rows, votes, laws, results };
}
function proposalOut(p, me, votes, results){
  const content = JSON.parse(p.content), mine = votes.find(b => b.pid === p.pid && b.uid === me);
  return { pid: p.pid, uid: p.uid, type: p.type, law: p.law, ...content, publishedAt: p.published, votingAt: p.voting_at, closesAt: p.closes_at, executeAt: p.execute_at, quorum: Number(p.quorum), policyVersion: p.policy,
    tally: p.tally, phase: p.phase, result: results[p.pid] || null, myVote: mine ? { choice: mine.choice, at: mine.at } : null };
}

let schemaReady = false;
async function ensureSchema(env){ if(schemaReady) return;
  for(const s of SCHEMA){ try { await env.DB.prepare(s).run(); } catch (e) { if(!s.startsWith('ALTER')) throw e; } }   // ALTER fails harmlessly once the column exists
  schemaReady = true; }

const enc = new TextEncoder();
async function sha256hex(s){ const d = await crypto.subtle.digest('SHA-256', enc.encode(s)); return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join(''); }
function safeEq(a, b){ a = String(a||''); b = String(b||''); if(!a || !b || a.length !== b.length) return false; let r = 0; for(let i=0;i<a.length;i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

const known = new Set();                 // uids seen as registered in this isolate
const writes = new Map();                // uid -> recent write timestamps (best-effort rate limit)
function rateOk(uid){ const now = Date.now(), w = (writes.get(uid)||[]).filter(t => now - t < 10000); if(w.length >= 40) return false; w.push(now); writes.set(uid, w); if(writes.size > 5000) writes.clear(); return true; }

async function who(req, env){
  const key = req.headers.get('x-xland-key') || '';
  if(!/^[A-Za-z0-9_\-]{32,128}$/.test(key)) return null;
  const uid = 'c' + (await sha256hex('xland-citizen:' + key)).slice(0, 24);
  return { uid, owner: !!env.ADMIN_KEY && safeEq(req.headers.get('x-xland-admin'), env.ADMIN_KEY) };
}
async function registered(env, uid){
  if(known.has(uid)) return true;
  const r = await env.DB.prepare('SELECT 1 FROM xl_accounts WHERE uid = ?1').bind(uid).first();
  if(r) known.add(uid); return !!r;
}
function canRead(col, id, me){ if(PUBLIC.includes(col)) return true; if(me.owner && FOUNDER_READ.includes(col)) return true; return id === me.uid; }
function readCols(me){ return me.owner ? PUBLIC.concat(FOUNDER_READ) : PUBLIC; }

async function api(req, env, url){
  await ensureSchema(env);
  const me = await who(req, env); if(!me) return fail(401, 'Missing or invalid citizen key.');
  const p = url.pathname, q = url.searchParams, now = Date.now();

  if(p === '/api/me'){
    let isNew = false;
    if(!(await registered(env, me.uid))){
      const ip = req.headers.get('cf-connecting-ip') || 'local', day = new Date().toISOString().slice(0,10);
      const netday = (await sha256hex('xland-net:' + ip + ':' + day)).slice(0, 20);
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM xl_accounts WHERE netday = ?1').bind(netday).first();
      if(n && n.n >= NEW_PER_NETWORK_PER_DAY && !me.owner) return fail(429, 'Too many new citizens from this network today. Try again tomorrow.');
      await env.DB.prepare('INSERT OR IGNORE INTO xl_accounts (uid, created_at, netday, country) VALUES (?1, ?2, ?3, ?4)').bind(me.uid, now, netday, (req.cf && req.cf.country) || '').run();
      known.add(me.uid); isNew = true;
    }
    return json({ok:true, uid:me.uid, owner:me.owner, isNew, now});
  }

  if(!(await registered(env, me.uid))) return fail(401, 'Unknown citizen. Reload the page.');

  if(p === '/api/world' && req.method === 'GET') return json({ok:true, now, ...(await worldReport(env, now))});

  if(p === '/api/quarx/start' && req.method === 'POST'){
    const open = await env.DB.prepare('SELECT started, ends FROM xl_seams WHERE uid = ?1').bind(me.uid).first();
    if(open) return json({ok:true, now, start:Number(open.started), end:Number(open.ends), reward: seamReward(await worldCounter(env, 'quarx_mined'))});
    const today = await env.DB.prepare('SELECT COUNT(*) AS n FROM xl_minelog WHERE uid = ?1 AND at >= ?2').bind(me.uid, dayStart(now)).first();
    if(today && Number(today.n) >= ECON.dailySeams) return fail(429, `Today's extraction capacity is used up (${ECON.dailySeams} seams a day).`);
    const mined = await worldCounter(env, 'quarx_mined'); if(seamReward(mined) <= 0) return fail(409, 'All minable QuarX has been extracted.');
    const mult = Math.min(2, Math.max(1, Number(q.get('mult')) || 1));   // the page may only slow a seam down (cold season, events)
    const secs = (ECON.seamSecsMin + Math.random() * (ECON.seamSecsMax - ECON.seamSecsMin)) * difficulty(await miners24h(env, now)) * mult;
    const end = now + Math.round(secs * 1000);
    await env.DB.prepare('INSERT OR IGNORE INTO xl_seams (uid, started, ends) VALUES (?1, ?2, ?3)').bind(me.uid, now, end).run();
    const s = await env.DB.prepare('SELECT started, ends FROM xl_seams WHERE uid = ?1').bind(me.uid).first();
    return json({ok:true, now, start:Number(s.started), end:Number(s.ends), reward: seamReward(mined)});
  }

  if(p === '/api/quarx/claim' && req.method === 'POST'){
    const s = await env.DB.prepare('SELECT started, ends FROM xl_seams WHERE uid = ?1').bind(me.uid).first();
    if(!s) return fail(404, 'No seam is being worked.');
    if(now < Number(s.ends)) return fail(409, 'The seam is not finished yet.');
    const del = await env.DB.prepare('DELETE FROM xl_seams WHERE uid = ?1 AND ends = ?2').bind(me.uid, s.ends).run();
    if(!del.meta.changes) return fail(409, 'This seam was already collected.');
    const mined = await worldCounter(env, 'quarx_mined'), reward = Math.min(seamReward(mined), MINABLE - mined);
    if(reward <= 0) return fail(409, 'All minable QuarX has been extracted.');
    await addWorld(env, 'quarx_mined', reward);
    await env.DB.prepare('INSERT INTO xl_minelog (uid, at, amount) VALUES (?1, ?2, ?3)').bind(me.uid, now, reward).run();
    const op = /^mine-[A-Za-z0-9_\-]{1,60}$/.test(q.get('op') || '') ? q.get('op') : 'mine-srv-' + now.toString(36);
    await walletApply(env, me.uid, op, { quarx: BigInt(reward) }, null, { d: { quarx: String(reward) }, src: 'seam' });   // the seam pays into the wallet
    return json({ok:true, now, reward, op, mined: mined + reward});
  }

  // Local test server only (never set on xland.world): give a test citizen produce or QuarX as if harvested or mined.
  if(p === '/api/dev/credit' && req.method === 'POST' && env.XLAND_DEV === '1'){
    const asset = q.get('asset'), units = Math.floor(Number(q.get('units')) || 0), op = q.get('op') || '';
    if(!WALLET_ASSETS.includes(asset) || units <= 0 || !/^(mine|prod)-dev-[A-Za-z0-9_-]{1,40}$/.test(op)) return fail(400, 'Invalid test credit.');
    const r = await walletApply(env, me.uid, op, { [asset]: BigInt(units) }, null, { d: { [asset]: String(units) }, src: 'dev' });
    return json({ok: r.ok, why: r.why});
  }

  /* Wallets held by the server */
  if(p === '/api/wallet' && req.method === 'GET'){
    const { w, exists } = await walletGet(env, me.uid);
    const { results } = await env.DB.prepare('SELECT op, at FROM xl_ledger WHERE uid = ?1 ORDER BY at DESC LIMIT 60').bind(me.uid).all();
    return json({ok:true, now, exists, ...walletOut(w), ops: results.map(r => r.op), recent: results.map(r => [r.op, Number(r.at)])});
  }
  if(p === '/api/wallet/import' && req.method === 'POST'){
    // Alpha citizens kept their balances on their device. Each carries them over once, within caps, when the server wallet starts.
    let body; try { body = await req.json(); } catch { return fail(400, 'Invalid request.'); }
    if(!body || !body.legacy) return fail(400, 'Nothing to import.');
    if((await walletGet(env, me.uid)).exists || await env.DB.prepare('SELECT 1 FROM xl_ledger WHERE uid = ?1').bind(me.uid).first()) return fail(409, 'This wallet already started.');
    const avail = {}, locked = {}, data = { bal: {}, locked: {} };
    for(const a of WALLET_ASSETS){
      const cap = BigInt(IMPORT_CAP[a] * UNIT), v = B((body.bal || {})[a]) || 0n, l = B((body.locked || {})[a]) || 0n;
      avail[a] = v < 0n ? 0n : v > cap ? cap : v; locked[a] = l < 0n ? 0n : l > cap ? cap : l;
      data.bal[a] = avail[a].toString(); data.locked[a] = locked[a].toString();
    }
    const r = await walletApply(env, me.uid, 'import-alpha', avail, locked, data);
    return r.ok ? json({ok:true, ...walletOut(r.wallet || (await walletGet(env, me.uid)).w)}) : fail(409, r.why);
  }
  if(p === '/api/ledger' && req.method === 'POST'){
    if(!rateOk(me.uid)) return fail(429, 'Too many changes at once. Slow down a little.');
    let body; try { body = await req.json(); } catch { return fail(400, 'Invalid request.'); }
    const r = await walletPropose(env, me.uid, body || {}, now);
    if(!r.ok){   // kept for the founder: a refused operation is either a forgery or a rule the server does not know yet
      await env.DB.prepare('INSERT INTO xl_rejects (uid, op, why, body, at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(me.uid, String((body || {}).op || '').slice(0, 96), r.why, JSON.stringify(body || {}).slice(0, 2000), now).run();
      return json({ok:false, rejected:true, error: r.why}, 422); }
    return json({ok:true, dup: !!r.dup});
  }

  if(p === '/api/admin/wallets' && req.method === 'GET'){
    if(!me.owner) return fail(403, 'Founder only.');
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM xl_wallets').first();
    const imp = await env.DB.prepare("SELECT COUNT(*) AS n FROM xl_ledger WHERE op = 'import-alpha'").first();
    const { results } = await env.DB.prepare('SELECT uid, op, why, at FROM xl_rejects ORDER BY at DESC LIMIT 30').all();
    return json({ok:true, wallets: Number(n.n), imported: Number(imp.n), rejects: results.map(r => ({ uid: r.uid.slice(0, 6), op: r.op, why: r.why, at: Number(r.at) }))});
  }

  /* FarmX harvests timed by the server: the communal field, and a citizen's own farmstead plot */
  if(p === '/api/farm/start' && req.method === 'POST'){
    const slot = q.get('slot') === 'own' ? 'own' : 'field', kind = q.get('kind'), f = FARM[kind];
    if(!f) return fail(400, 'Choose what to produce.');
    if(slot === 'own' && !(await env.DB.prepare("SELECT 1 FROM xl_builds WHERE uid = ?1 AND def = 'farmstead' AND status = 'complete'").bind(me.uid).first())
      && !(await env.DB.prepare("SELECT 1 FROM xl_ledger WHERE uid = ?1 AND op LIKE 'proj-%consume%'").bind(me.uid).first())) return fail(403, 'Your own plot needs a finished farmstead.');   // r53: finished on the server; farmsteads committed before r53 keep their plot (the page can no longer write such entries)
    const open = await env.DB.prepare('SELECT * FROM xl_plots WHERE uid = ?1 AND slot = ?2').bind(me.uid, slot).first();
    if(open) return json({ok:true, now, start: Number(open.started), end: Number(open.ends), out: Number(open.out), kind: open.kind, op: open.op});
    let mult = Math.min(1, Math.max(0.5, Number(q.get('mult')) || 1));   // the page may only lower a yield (droughts, events)
    mult *= await heatMult(env, 'farmx', now);   // r55: a heatwave in FarmX lowers every harvest started there
    if(slot === 'own'){ const fs = await env.DB.prepare("SELECT * FROM xl_builds WHERE uid = ?1 AND def = 'farmstead' AND status = 'complete' ORDER BY ends LIMIT 1").bind(me.uid).first();
      if(fs){ const c = buildCond(fs, await hazardsSince(env, 0), now); mult *= condFactor(c && c.cond); } }   // a damaged farmstead yields less until repaired
    const out = Math.max(1, Math.floor(f.out * mult)), end = now + f.secs * 1000, op = (slot === 'own' ? 'prod-own-' : 'prod-') + kind + '-' + now.toString(36) + Math.random().toString(36).slice(2, 6);
    await env.DB.prepare('INSERT OR IGNORE INTO xl_plots (uid, slot, kind, started, ends, out, op) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(me.uid, slot, kind, now, end, out, op).run();
    const s2 = await env.DB.prepare('SELECT * FROM xl_plots WHERE uid = ?1 AND slot = ?2').bind(me.uid, slot).first();
    return json({ok:true, now, start: Number(s2.started), end: Number(s2.ends), out: Number(s2.out), kind: s2.kind, op: s2.op});
  }
  if(p === '/api/farm/claim' && req.method === 'POST'){
    const slot = q.get('slot') === 'own' ? 'own' : 'field';
    const pl = await env.DB.prepare('SELECT * FROM xl_plots WHERE uid = ?1 AND slot = ?2').bind(me.uid, slot).first();
    if(!pl) return fail(404, 'Nothing is growing.');
    if(now < Number(pl.ends)) return fail(409, 'The harvest is not ready yet.');
    const del = await env.DB.prepare('DELETE FROM xl_plots WHERE uid = ?1 AND slot = ?2 AND op = ?3').bind(me.uid, slot, pl.op).run();
    if(!del.meta.changes) return fail(409, 'This harvest was already brought in.');
    const amount = BigInt(Number(pl.out) * UNIT);
    await walletApply(env, me.uid, pl.op, { [pl.kind]: amount }, null, { d: { [pl.kind]: amount.toString() }, src: 'harvest' });
    return json({ok:true, now, op: pl.op, kind: pl.kind, out: Number(pl.out)});
  }

  /* Construction timed by the server (r53) */
  if(p === '/api/builds' && req.method === 'GET'){
    const { results } = await env.DB.prepare('SELECT * FROM xl_builds WHERE uid = ?1 ORDER BY started DESC LIMIT 50').bind(me.uid).all();
    const hz = await hazardsSince(env, 0), mined = await worldCounter(env, 'quarx_mined');
    return json({ok:true, now, builds: results.map(b => { const o = buildOut(b), c = buildCond(b, hz, now); if(c){ const rc = repairCost(b, c.cond, mined); Object.assign(o, c, { repair: { bux: rc.bux.toString(), quarx: rc.quarx.toString() } }); } return o; }), recipes: Object.fromEntries(Object.entries(BUILDS).map(([k, d]) => [k, { territory: d.territory, recipe: d.recipe, secs: d.secs, commitPct: d.commitPct, law: d.law || null, once: !!d.once }]))});
  }
  if(p === '/api/build/start' && req.method === 'POST'){
    if(!rateOk(me.uid)) return fail(429, 'Too many changes at once. Slow down a little.');
    const r = await buildStart(env, me.uid, q.get('def') || '', q.get('key') || '', q.get('parcel') || '', q.get('name') || '', now);
    return r.s === 200 ? json({ok:true, now, build: r.build}) : fail(r.s, r.why);
  }
  if(p === '/api/build/repair' && req.method === 'POST'){
    const b = await buildGet(env, me.uid, q.get('key') || '');
    if(!b) return fail(404, 'No such building.');
    const c = buildCond(b, await hazardsSince(env, 0), now); if(!c) return fail(409, 'Only a finished building can be repaired.');
    const cost = repairCost(b, c.cond, await worldCounter(env, 'quarx_mined'));
    if(cost.bux === 0n) return json({ok:true, now, cond: c.cond, repaired: false});
    const lines = { bux: -cost.bux }; if(cost.quarx > 0n) lines.quarx = -cost.quarx;
    const r = await walletApply(env, me.uid, 'repair-' + b.key + '-' + now.toString(36), lines, null, { d: Object.fromEntries(Object.entries(lines).map(([a, v]) => [a, v.toString()])), src: 'repair', key: b.key, t: buildTerritory(b) });
    if(!r.ok) return fail(409, r.why);
    await env.DB.prepare('UPDATE xl_builds SET repaired_at = ?3, updated = ?3 WHERE uid = ?1 AND key = ?2').bind(me.uid, b.key, now).run();
    if(cost.quarx > 0n) await addWorld(env, 'quarx_consumed', Number(cost.quarx));
    return json({ok:true, now, cond: 100, repaired: true, paid: { bux: cost.bux.toString(), quarx: cost.quarx.toString() }});
  }
  if(p === '/api/land/buy' && req.method === 'POST'){
    if(!rateOk(me.uid)) return fail(429, 'Too many changes at once. Slow down a little.');
    const r = await landBuy(env, me.uid, q.get('parcel') || '', q.get('handle') || '', now, q.get('price'));
    return r.s === 200 ? json({ok:true, now, dup: !!r.dup, claim: r.claim || null, resale: r.resale || null, builds: r.builds || []}) : fail(r.s, r.why);
  }
  if(p === '/api/land/list' && req.method === 'POST'){
    if(!rateOk(me.uid)) return fail(429, 'Too many changes at once. Slow down a little.');
    const r = await landList(env, me.uid, q.get('parcel') || '', Number(q.get('price')), now);
    return r.s === 200 ? json({ok:true, now, listing: r.listing}) : fail(r.s, r.why);
  }
  if(p === '/api/land/unlist' && req.method === 'POST'){
    await env.DB.prepare('DELETE FROM xl_listings WHERE id = ?1 AND seller = ?2').bind(q.get('parcel') || '', me.uid).run();
    return json({ok:true, now});
  }
  if(p === '/api/land/listings' && req.method === 'GET') return json({ok:true, now, listings: await landListings(env)});
  if(p === '/api/world/refresh' && req.method === 'POST'){
    if(!me.owner) return fail(403, 'Founder only.');
    try { return json({ok:true, now, raised: await weatherBridge(env, now), weather: await weatherNow(env)}); } catch(e){ return fail(502, 'The weather service did not answer: ' + e.message); }
  }
  if(p === '/api/hazard/raise' && req.method === 'POST'){   // the founder's weather lab: raise a hazard by hand to see what it does
    if(!me.owner) return fail(403, 'Founder only.');
    const type = q.get('type') || '', t = q.get('t') || '', hours = Math.min(24, Math.max(1, Number(q.get('hours')) || 3));
    if(!HAZ[type] || !TWINS[t]) return fail(400, 'Unknown hazard or territory.');
    const h = await raiseHazard(env, { id: `lab-${t}-${type}-${now.toString(36)}`, type, territory: t, start: now, ends: now + hours * 3600000, source: 'lab', place: TWINS[t].name, reading: 'raised by the founder' });
    return json({ok:true, now, hazard: h ? hazardOut(h) : null, extended: !h});
  }
  if(p.startsWith('/api/build/') && req.method === 'POST' && ['cancel', 'commit', 'done'].includes(p.slice(11))){
    const act = p.slice(11), b = await buildGet(env, me.uid, q.get('key') || '');
    if(!b) return fail(404, 'No such build site.');
    if(act === 'cancel'){
      if(b.status !== 'active') return fail(409, `This build site is ${b.status}.`);
      if(now >= Number(b.commit_at)) return fail(409, 'The resources are committed: the foundation is finished.');
      const r = await env.DB.prepare("UPDATE xl_builds SET status = 'released', updated = ?3 WHERE uid = ?1 AND key = ?2 AND status = 'active'").bind(me.uid, b.key, now).run();
      if(!r.meta.changes) return fail(409, 'This build site changed. Look again.');
      const op = BUILDS[b.def].opUnlock(b.key);
      for(const [a, qq] of Object.entries(JSON.parse(b.reserved))) await walletApply(env, me.uid, op(a), { [a]: BigInt(qq) }, { [a]: -BigInt(qq) }, { lk: 'UNLOCK', asset: a, qty: qq, src: 'build', key: b.key });
      return json({ok:true, now, build: buildOut(await buildGet(env, me.uid, b.key))});
    }
    if(act === 'commit'){ const r = await buildCommit(env, me.uid, b, now); return r.s === 200 ? json({ok:true, now, build: r.build}) : fail(r.s, r.why); }
    // done: completes only after the server's end time; commits first if the page never asked
    if(b.status === 'complete') return json({ok:true, now, build: buildOut(b)});
    if(b.status === 'released') return fail(409, 'This build site was cancelled.');
    if(now < Number(b.ends)) return fail(409, 'Construction is not finished yet.');
    if(b.status === 'active'){ const r = await buildCommit(env, me.uid, b, now); if(r.s !== 200) return fail(r.s, r.why); }
    const r = await env.DB.prepare("UPDATE xl_builds SET status = 'complete', updated = ?3 WHERE uid = ?1 AND key = ?2 AND status = 'committed'").bind(me.uid, b.key, now).run();
    if(r.meta.changes) await addWorld(env, 'buildings', 1);
    return json({ok:true, now, build: buildOut(await buildGet(env, me.uid, b.key))});
  }

  /* The Xiberal Assembly held by the server (r53) */
  if(p === '/api/gov' && req.method === 'GET'){
    const g = await govLaws(env, now), eligible = await eligibleCount(env, now);
    return json({ok:true, now, policy: GOVS, eligible, quorumNext: quorumFor(eligible), me: { eligible: await isResident(env, me.uid) },
      proposals: g.proposals.map(x => proposalOut(x, me.uid, g.votes, g.results)), laws: g.laws});
  }
  if(p === '/api/gov/propose' && req.method === 'POST'){
    if(!rateOk(me.uid)) return fail(429, 'Too many changes at once. Slow down a little.');
    let body; try { body = await req.json(); } catch { return fail(400, 'Invalid request.'); }
    const type = String((body || {}).type || ''), pl = proposalLaw(type);
    if(!pl) return fail(400, 'That kind of proposal does not exist.');
    if(!(await isResident(env, me.uid))) return fail(403, 'Needs residency: only a citizen with a home in Xland may propose.');
    const g = await govLaws(env, now), active = g.laws.some(l => l.id === pl.law && l.state === 'ACTIVE');
    if(pl.repeal && !LAWS[pl.law].reversible) return fail(409, 'That law is not reversible under its rollback policy.');
    if(pl.repeal ? !active : active) return fail(409, pl.repeal ? 'That law is not active.' : 'That law is already active.');
    const open = g.proposals.filter(x => ['DELIBERATION', 'VOTING', 'EXECUTION_PENDING'].includes(x.phase));
    if(open.some(x => x.type === type)) return fail(409, 'A proposal of this kind is already before the Assembly.');
    if(open.filter(x => x.uid === me.uid).length >= GOVS.maxOpenPerCitizen) return fail(429, `You already have ${GOVS.maxOpenPerCitizen} proposals before the Assembly.`);
    const c = (body || {}).content || {}, content = { title: String(c.title || type).slice(0, 120), current: String(c.current || '').slice(0, 160), proposed: String(c.proposed || '').slice(0, 160), rationale: String(c.rationale || '').slice(0, 160), authority: String(c.authority || '').slice(0, 200), hash: String((body || {}).hash || '').slice(0, 16), proposerHandle: String(c.proposerHandle || '').slice(0, 40) };
    const pid = 'XA-' + now.toString(36).toUpperCase() + Math.random().toString(36).slice(2, 4).toUpperCase();
    const G = env.XLAND_DEV === '1' ? { discussSecs: 3, votingSecs: 6, timelockSecs: 3 } : GOVS;   // the local test server runs a short Assembly; never set on xland.world
    const t = { voting: now + G.discussSecs * 1000, closes: now + (G.discussSecs + G.votingSecs) * 1000, execute: now + (G.discussSecs + G.votingSecs + G.timelockSecs) * 1000 };
    await env.DB.prepare('INSERT INTO xl_proposals (pid, uid, type, law, content, published, voting_at, closes_at, execute_at, quorum, policy) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)')
      .bind(pid, me.uid, type, pl.law, JSON.stringify(content), now, t.voting, t.closes, t.execute, quorumFor(await eligibleCount(env, now)), GOVS.policyVersion).run();
    const g2 = await govLaws(env, now), row = g2.proposals.find(x => x.pid === pid);
    return json({ok:true, now, proposal: proposalOut(row, me.uid, g2.votes, g2.results)});
  }
  if(p === '/api/gov/vote' && req.method === 'POST'){
    if(!rateOk(me.uid)) return fail(429, 'Too many changes at once. Slow down a little.');
    const pid = q.get('pid') || '', choice = q.get('choice') || '';
    if(!ID_RE.test(pid) || !CHOICES.includes(choice)) return fail(400, 'Invalid ballot.');
    const row = await env.DB.prepare('SELECT * FROM xl_proposals WHERE pid = ?1').bind(pid).first();
    if(!row) return fail(404, 'No such proposal.');
    if(now < Number(row.voting_at)) return fail(409, 'Deliberation is still open; voting has not started.');
    if(now > Number(row.closes_at)) return fail(409, 'The voting window has closed.');
    if(!(await isResident(env, me.uid))) return fail(403, 'Needs residency: only a citizen with a home in Xland may vote.');
    await env.DB.prepare('INSERT INTO xl_ballots (pid, uid, choice, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(pid, uid) DO UPDATE SET choice = excluded.choice, at = excluded.at').bind(pid, me.uid, choice, now).run();
    const g = await govLaws(env, now);
    return json({ok:true, now, proposal: proposalOut(g.proposals.find(x => x.pid === pid), me.uid, g.votes, g.results)});
  }

  if(p === '/api/bux/sandbox' && req.method === 'POST'){
    // The alpha's sandbox allowance, modelled as a test-stablecoin deposit locked in the BanX reserve: once per citizen.
    const amount = ECON.sandboxBuX * UNIT;
    const r = await env.DB.prepare('INSERT OR IGNORE INTO xl_mints (uid, amount, at) VALUES (?1, ?2, ?3)').bind(me.uid, amount, now).run();
    if(r.meta.changes){ await addWorld(env, 'bux_minted', amount); await addWorld(env, 'bux_reserve', amount); }
    return json({ok:true, minted: !!r.meta.changes, amount});
  }

  if(p === '/api/shop/open' && req.method === 'POST'){
    // Recorded once per citizen: the shopfront's QuarX leaves circulation for good.
    const name = String(q.get('name') || '').trim().slice(0, 32), t = q.get('t') || 'xetropolitan', cfg = SHOPS[t];
    if(name.length < 2) return fail(400, 'Give your shop a name.');
    if(!cfg) return fail(400, 'Shops cannot be built in this territory yet.');
    if(cfg.coop) return fail(400, 'In Ixeland, found or join a cooperative.');
    if(cfg.max){ const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM xl_shopfronts WHERE territory = ?1').bind(t).first(); if(n && Number(n.n) >= cfg.max) return fail(409, 'Every shop in this territory is taken.'); }
    const amount = shopCost(t, await worldCounter(env, 'quarx_mined'));   // r54: k × the current seam reward
    const r = await env.DB.prepare('INSERT OR IGNORE INTO xl_shopfronts (uid, name, quarx, at, territory) VALUES (?1, ?2, ?3, ?4, ?5)').bind(me.uid, name, amount, now, t).run();
    if(r.meta.changes){ await addWorld(env, 'shopfronts', 1); await addWorld(env, 'quarx_consumed', amount); }
    return json({ok:true, built: !!r.meta.changes, quarx: amount});
  }

  if(p === '/api/coops' && req.method === 'GET'){
    const { results: cs } = await env.DB.prepare('SELECT id, name, founder, created FROM xl_coops ORDER BY created LIMIT 500').all();
    const { results: ms } = await env.DB.prepare('SELECT uid, coop FROM xl_coop_members ORDER BY joined').all();
    const coops = {}; cs.forEach(c => { coops[c.id] = { name: c.name, founder: c.founder, created: Number(c.created), members: [] }; });
    ms.forEach(m => { if(coops[m.coop]) coops[m.coop].members.push(m.uid); });
    return json({ok:true, coops, max: SHOPS.ixeland.coop.max, openAt: SHOPS.ixeland.coop.openAt});
  }

  if((p === '/api/coop/create' || p === '/api/coop/join') && req.method === 'POST'){
    const cfg = SHOPS.ixeland, id = q.get('id') || '', share = shopCost('ixeland', await worldCounter(env, 'quarx_mined'));
    if(!ID_RE.test(id)) return fail(400, 'Invalid cooperative.');
    if(await env.DB.prepare('SELECT 1 FROM xl_shopfronts WHERE uid = ?1').bind(me.uid).first()) return fail(409, 'You already keep a shop. A citizen keeps one shop.');
    let name;
    if(p === '/api/coop/create'){
      name = String(q.get('name') || '').trim().slice(0, 32);
      if(name.length < 2) return fail(400, 'Give the cooperative a name.');
      const r = await env.DB.prepare('INSERT OR IGNORE INTO xl_coops (id, name, founder, territory, created) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, name, me.uid, 'ixeland', now).run();
      if(!r.meta.changes) return fail(409, 'This cooperative already exists.');
      await addWorld(env, 'shopfronts', 1);
    } else {
      const c = await env.DB.prepare('SELECT name FROM xl_coops WHERE id = ?1').bind(id).first();
      if(!c) return fail(404, 'No such cooperative.');
      name = c.name;
    }
    // One statement: the member is added only while the cooperative has room, so it can never pass five.
    const m = await env.DB.prepare('INSERT OR IGNORE INTO xl_coop_members (uid, coop, joined) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM xl_coop_members WHERE coop = ?2) < ?4')
      .bind(me.uid, id, now, cfg.coop.max).run();
    if(!m.meta.changes){
      if(p === '/api/coop/create') await env.DB.prepare('DELETE FROM xl_coops WHERE id = ?1 AND founder = ?2').bind(id, me.uid).run();
      return fail(409, 'This cooperative is full, or you are already in one.');
    }
    await env.DB.prepare('INSERT OR IGNORE INTO xl_shopfronts (uid, name, quarx, at, territory) VALUES (?1, ?2, ?3, ?4, ?5)').bind(me.uid, name, share, now, 'ixeland').run();
    await addWorld(env, 'quarx_consumed', share);
    const { results } = await env.DB.prepare('SELECT uid FROM xl_coop_members WHERE coop = ?1 ORDER BY joined').bind(id).all();
    return json({ok:true, id, name, members: results.length, memberIds: results.map(r => r.uid), share});
  }

  if(p === '/api/market/prices' && req.method === 'GET'){
    // Price discovery between citizens: volume-weighted price per unit over the last 7 days, from settled orders.
    const since = now - 7 * 86400000;
    const { results } = await env.DB.prepare("SELECT asset, SUM(qty) AS qty, SUM(total) AS total, COUNT(*) AS n, MIN(price) AS lo, MAX(price) AS hi FROM xl_orders WHERE status = 'filled' AND updated >= ?1 AND asset != 'item' GROUP BY asset").bind(since).all();
    const prices = {}; results.forEach(r => { prices[r.asset] = { qty: Number(r.qty), avg: Math.round(Number(r.total) / Math.max(1, Number(r.qty))), lo: Number(r.lo), hi: Number(r.hi), sales: Number(r.n) }; });
    return json({ok:true, now, days: 7, prices});
  }

  if(p === '/api/market/orders' && req.method === 'GET'){
    const rows = async (who) => (await env.DB.prepare(`SELECT * FROM xl_orders WHERE ${who} = ?1 ORDER BY updated DESC LIMIT 100`).bind(me.uid).all()).results.map(orderOut);
    return json({ok:true, now, buying: await rows('buyer'), selling: await rows('seller')});
  }

  if(p === '/api/market/order' && req.method === 'POST'){
    if(!rateOk(me.uid)) return fail(429, 'Too many changes at once. Slow down a little.');
    const oid = q.get('oid') || '', seller = q.get('seller') || '', ref = q.get('ref') || '', qty = Number(q.get('qty')), price = Number(q.get('price'));
    if(!ID_RE.test(oid) || !ID_RE.test(seller) || !ID_RE.test(ref)) return fail(400, 'Invalid order.');
    if(seller === me.uid) return fail(403, 'You cannot buy from your own shop.');
    if(!Number.isInteger(qty) || qty < 1 || qty > MARKET.maxQty) return fail(400, 'Choose a whole quantity.');
    let meta = null;
    const doc = await env.DB.prepare("SELECT data FROM xl_docs WHERE col = 'shops' AND id = ?1").bind(seller).first();
    const shop = doc ? JSON.parse(doc.data) : null;
    if(!shop || !(Number(shop.openUntil) > now)) return fail(409, 'This shop is closed.');
    const front = await env.DB.prepare('SELECT territory FROM xl_shopfronts WHERE uid = ?1').bind(seller).first();   // the server's record decides the territory, not the shop document
    const cfg = front && SHOPS[front.territory];
    if(!cfg) return fail(409, 'This shop has no shopfront.');
    if(cfg.coop){ const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM xl_coop_members WHERE coop = (SELECT coop FROM xl_coop_members WHERE uid = ?1)').bind(seller).first();
      if(!n || Number(n.n) < cfg.coop.openAt) return fail(409, `This cooperative opens for sale at ${cfg.coop.openAt} members.`); }
    const item = (Array.isArray(shop.items) ? shop.items : []).find(x => x && x.ref === ref);
    if(!item || !cfg.assets.includes(item.asset)) return fail(404, 'This item is no longer listed.');
    const unit = Number(item.price);
    if(!Number.isInteger(unit) || unit < 1) return fail(409, 'This item has no valid price.');
    if(unit !== price) return fail(409, 'The price has changed. Look again before buying.');
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM xl_orders WHERE buyer = ?1 AND status = 'paid'").bind(me.uid).first();
    if(open && Number(open.n) >= MARKET.maxOpenPerBuyer) return fail(429, 'You have too many orders waiting. Wait for merchants to fill them.');
    let feeBps = cfg.feeBps;
    if(item.asset === 'item'){
      if(qty !== 1 || Number(item.qty) !== 1) return fail(400, 'A unique asset is sold one at a time.');
      const link = typeof item.link === 'string' && /^https:\/\/[^\s"'<>]{4,300}$/.test(item.link) ? item.link : null, title = String(item.title || 'A rare asset').slice(0, 60);
      /* r54: the anti-flip fee is the server's, from when the merchant acquired the item: an item bought in this order book
         (named by src, or carrying the same title or proof link) or from the bazaar's outside sellers. A merchant can only
         raise it. Works the merchant declares as found or made stay free until Xahara's oracles can check them. */
      const norm = x => String(x || '').trim().toLowerCase().replace(/\s+/g, ' '), src = String(item.src || '');
      const { results: got } = await env.DB.prepare("SELECT oid, meta, updated FROM xl_orders WHERE buyer = ?1 AND asset = 'item' AND status = 'filled' ORDER BY updated DESC LIMIT 200").bind(seller).all();
      let acquiredAt = null, from = null;
      for(const g of got){ const m = g.meta ? JSON.parse(g.meta) : {};
        if(src === 'order:' + g.oid || norm(m.title) === norm(title) || (link && m.link === link)){ acquiredAt = Number(g.updated); from = 'order:' + g.oid; break; } }
      if(acquiredAt === null && src.startsWith('rare')){ const key = src.slice(5), rare = await env.DB.prepare(key ? 'SELECT at FROM xl_ledger WHERE uid = ?1 AND op = ?2' : "SELECT at FROM xl_ledger WHERE uid = ?1 AND op LIKE 'rare-%' ORDER BY at DESC LIMIT 1").bind(...(key ? [seller, 'rare-' + key] : [seller])).first();
        if(rare){ acquiredAt = Number(rare.at); from = 'rare'; } }
      if(from && from.startsWith('order:') && await env.DB.prepare("SELECT 1 FROM xl_orders WHERE seller = ?1 AND asset = 'item' AND status = 'filled' AND meta LIKE ?2").bind(seller, '%"from":"' + from + '"%').first()) return fail(409, 'This asset was already resold.');
      const declared = Math.min(FLIP.maxBps, Math.max(0, Math.floor(Number(item.feeBps) || 0)));
      feeBps = Math.max(feeBps, declared, acquiredAt === null ? 0 : flipFeeBps(now - acquiredAt));
      meta = JSON.stringify({ title, kind: String(item.kind || 'Collectible').slice(0, 20), link, from, declared: acquiredAt === null ? (item.made ? 'made' : 'held') : null });
    }
    const total = qty * unit, fee = Math.floor(total * feeBps / 10000);
    const sold = await env.DB.prepare("SELECT COALESCE(SUM(qty), 0) AS n FROM xl_orders WHERE seller = ?1 AND ref = ?2 AND status IN ('paid', 'filled')").bind(seller, ref).first();
    if(Number(sold.n) + qty > Math.floor(Number(item.qty) || 0)) return fail(409, 'Not enough of this item is left.');
    // Both wallets must cover the trade on the server: the buyer's BuX, the merchant's reserved goods.
    const paid = await opExists(env, me.uid, 'mkt-pay-' + oid);
    if(!paid && BigInt((await walletGet(env, me.uid)).w.bal.bux || '0') < BigInt(total)) return fail(409, 'Not enough BuX in your wallet.');
    if(item.asset !== 'item' && BigInt((await walletGet(env, seller)).w.locked[item.asset] || '0') < BigInt(qty * UNIT)) return fail(409, 'This shop\'s stock is not settled yet. Try again after the merchant visits Xland.');
    // One statement: the order is written only if the listing still has enough stock, so two buyers can never oversell it.
    const r = await env.DB.prepare(`INSERT OR IGNORE INTO xl_orders (oid, buyer, seller, ref, asset, qty, price, total, fee, status, created, updated, meta)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'filled', ?10, ?10, ?12
      WHERE (SELECT COALESCE(SUM(qty), 0) FROM xl_orders WHERE seller = ?3 AND ref = ?4 AND status IN ('paid', 'filled')) + ?6 <= ?11`)
      .bind(oid, me.uid, seller, ref, item.asset, qty, unit, total, fee, now, Math.max(0, Math.floor(Number(item.qty) || 0)), meta).run();
    if(!r.meta.changes){
      const dup = await env.DB.prepare('SELECT * FROM xl_orders WHERE oid = ?1').bind(oid).first();
      if(dup && dup.buyer === me.uid) return json({ok:true, order: orderOut(dup)});
      return fail(409, 'Not enough of this item is left.');
    }
    // Settled at once on the server: the buyer pays and receives, the merchant's reserved goods leave and the BuX arrives.
    const pay = await walletApply(env, me.uid, 'mkt-pay-' + oid, { bux: -BigInt(total) }, null, { d: { bux: String(-total) }, src: 'order' });
    if(!pay.ok){ await env.DB.prepare("UPDATE xl_orders SET status = 'declined', updated = ?2 WHERE oid = ?1").bind(oid, now).run(); return fail(409, pay.why); }
    if(item.asset !== 'item'){
      const del = await walletApply(env, seller, 'mkt-deliver-' + oid, null, { [item.asset]: -BigInt(qty * UNIT) }, { lk: 'CONSUME', asset: item.asset, qty: String(qty * UNIT), src: 'order' });
      if(!del.ok){ await env.DB.prepare("UPDATE xl_orders SET status = 'declined', updated = ?2 WHERE oid = ?1").bind(oid, now).run();
        await walletApply(env, me.uid, 'mkt-refund-' + oid, { bux: BigInt(total) }, null, { d: { bux: String(total) }, src: 'order' });
        return fail(409, 'This shop\'s stock is not settled yet. Your BuX came back.'); }
      await walletApply(env, me.uid, 'mkt-recv-' + oid, { [item.asset]: BigInt(qty * UNIT) }, null, { d: { [item.asset]: String(qty * UNIT) }, src: 'order' });
    } else await env.DB.prepare('INSERT OR IGNORE INTO xl_ledger (uid, op, data, at) VALUES (?1, ?2, ?3, ?4)').bind(me.uid, 'mkt-recv-' + oid, JSON.stringify({ item: true }), now).run();
    await walletApply(env, seller, 'mkt-sale-' + oid, { bux: BigInt(total - fee) }, null, { d: { bux: String(total - fee) }, src: 'order' });
    await addWorld(env, 'market_sales', 1); await addWorld(env, 'market_volume', total); await addWorld(env, 'market_fees', fee);
    return json({ok:true, order: orderOut(await env.DB.prepare('SELECT * FROM xl_orders WHERE oid = ?1').bind(oid).first())});
  }

  if(p.startsWith('/api/market/') && req.method === 'POST' && ['fill', 'decline', 'cancel'].includes(p.slice(12))){
    const act = p.slice(12), oid = q.get('oid') || '';
    if(!ID_RE.test(oid)) return fail(400, 'Invalid order.');
    const sql = act === 'cancel'
      ? "UPDATE xl_orders SET status = 'cancelled', updated = ?2 WHERE oid = ?1 AND buyer = ?3 AND status = 'paid' AND created <= ?4"
      : `UPDATE xl_orders SET status = '${act === 'fill' ? 'filled' : 'declined'}', updated = ?2 WHERE oid = ?1 AND seller = ?3 AND status = 'paid'`;
    const r = await (act === 'cancel' ? env.DB.prepare(sql).bind(oid, now, me.uid, now - MARKET.cancelAfterMs) : env.DB.prepare(sql).bind(oid, now, me.uid)).run();
    const o = await env.DB.prepare('SELECT * FROM xl_orders WHERE oid = ?1').bind(oid).first();
    if(!o || (o.buyer !== me.uid && o.seller !== me.uid)) return fail(404, 'No such order.');
    if(!r.meta.changes) return fail(409, act === 'cancel' && o.status === 'paid' ? 'An order can be cancelled 24 hours after it was placed.' : `This order is already ${o.status}.`);
    if(act === 'fill'){ await addWorld(env, 'market_sales', 1); await addWorld(env, 'market_volume', Number(o.total)); await addWorld(env, 'market_fees', Number(o.fee)); }
    return json({ok:true, order: orderOut(o)});
  }

  if(p === '/api/sync' && req.method === 'GET'){
    const since = Math.max(0, Number(q.get('since')) || 0), cols = readCols(me);
    const { results } = await env.DB.prepare(`SELECT col, id, data, updated_at FROM xl_docs WHERE updated_at > ?1 AND col IN (${cols.map((_,i)=>'?'+(i+2)).join(',')}) ORDER BY updated_at LIMIT 3000`).bind(since, ...cols).all();
    return json({ok:true, now, docs: results.map(r => ({c:r.col, id:r.id, d:JSON.parse(r.data), u:r.updated_at}))});
  }

  const col = q.get('c') || '', id = q.get('id') || '';
  if(!ALL.includes(col) || !ID_RE.test(id)) return fail(400, 'Unknown document.');

  if(p === '/api/doc' && req.method === 'GET'){
    if(!canRead(col, id, me)) return fail(403, 'Not allowed.');
    const r = await env.DB.prepare('SELECT data, updated_at FROM xl_docs WHERE col = ?1 AND id = ?2').bind(col, id).first();
    return json({ok:true, exists:!!r, data: r ? JSON.parse(r.data) : null, u: r ? r.updated_at : 0});
  }

  if(p === '/api/doc' && req.method === 'PUT'){
    if(!rateOk(me.uid)) return fail(429, 'Too many changes at once. Slow down a little.');
    let body; try { body = await req.json(); } catch { return fail(400, 'Invalid request.'); }
    const data = body && body.data;
    if(!data || typeof data !== 'object' || Array.isArray(data)) return fail(400, 'A document must be an object.');
    const text = JSON.stringify(data);
    if(text.length > (col === 'state' ? MAX_STATE : MAX_DOC)) return fail(413, 'This document is too large.');
    if(col === 'claims'){
      if(UNCLAIMABLE.test(id)) return fail(403, 'This land can never be claimed.');
      if(data.owner !== me.uid) return fail(403, 'A claim must name its own holder.');
      // r55: new land is bought through /api/land/buy; a direct claim is accepted only for land this citizen already paid for
      // (or holds), for the original parcels an alpha citizen carried over, or for the Ximberland home of an r52-era Homax
      const held = await env.DB.prepare("SELECT owner FROM xl_docs WHERE col = 'claims' AND id = ?1").bind(id).first();
      if(!(held && held.owner === me.uid) && !(await opExists(env, me.uid, 'parcel-' + id)) && !(LAND[id] && !LAND[id].lot && await opExists(env, me.uid, 'import-alpha')) && !(/^XIM-R-\d\d$/.test(id) && await opExists(env, me.uid, 'homax-acquire')))
        return fail(403, 'Buy this land first.');
      const r = await env.DB.prepare('INSERT INTO xl_docs (col, id, data, owner, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(col, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at WHERE xl_docs.owner = excluded.owner')
        .bind(col, id, text, me.uid, now).run();
      if(!r.meta.changes) return fail(409, 'This parcel is already held by another citizen.');
      return json({ok:true, u:now});
    }
    const self = id === me.uid, moderating = me.owner && col === 'posts';
    if(!SELF_WRITE.includes(col) || !(self || moderating)) return fail(403, 'You can only change your own documents.');
    await env.DB.prepare('INSERT INTO xl_docs (col, id, data, owner, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(col, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .bind(col, id, text, id, now).run();
    return json({ok:true, u:now});
  }

  if(p === '/api/lease' && req.method === 'POST'){
    const ttl = Math.min(30000, Math.max(1000, Number(q.get('ttl')) || 5000)), key = col + '/' + id;
    const r = await env.DB.prepare('INSERT INTO xl_leases (key, holder, expires) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET holder = excluded.holder, expires = excluded.expires WHERE xl_leases.expires < ?4 OR xl_leases.holder = excluded.holder')
      .bind(key, me.uid, now + ttl, now).run();
    return json({ok:true, acquired: !!r.meta.changes});
  }
  return fail(404, 'Not found.');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.hostname.startsWith('www.')) return Response.redirect('https://' + url.hostname.slice(4) + url.pathname + url.search, 301);

    if (url.pathname === '/api/waitlist' && req.method === 'POST') {
      let b; try { b = await req.json(); } catch { return fail(400, 'Invalid request.'); }
      if (b.website) return json({ok:true});                                    // honeypot: silently accept bots
      const email = String(b.email||'').trim().toLowerCase().slice(0,160);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(400, 'Please enter a valid email.');
      const name = String(b.name||'').trim().slice(0,80);
      const interest = INTERESTS.includes(b.interest) ? b.interest : 'explore';
      const lang = String(b.lang||'').slice(0,20), country = (req.cf && req.cf.country) || '';
      try {
        await ensureSchema(env);
        const r = await env.DB.prepare('INSERT OR IGNORE INTO waitlist (email, name, interest, lang, country) VALUES (?1, ?2, ?3, ?4, ?5)').bind(email, name, interest, lang, country).run();
        return json({ok:true, already: r.meta.changes === 0});
      } catch (e) { return fail(500, 'Could not save right now. Please try again.'); }
    }

    if (url.pathname === '/api/waitlist/export' && req.method === 'GET') {
      const key = req.headers.get('x-admin-key') || url.searchParams.get('key');
      if (!env.ADMIN_KEY || !safeEq(key, env.ADMIN_KEY)) return fail(404, 'Not found.');
      await ensureSchema(env);
      const { results } = await env.DB.prepare('SELECT email, name, interest, lang, country, created_at FROM waitlist ORDER BY id').all();
      const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const csv = ['email,name,interest,lang,country,created_at', ...results.map(r => [r.email,r.name,r.interest,r.lang,r.country,r.created_at].map(esc).join(','))].join('\n');
      return new Response(csv, {headers:{'content-type':'text/csv; charset=utf-8', 'content-disposition':'attachment; filename="xland-waitlist.csv"', 'cache-control':'no-store'}});
    }

    if (url.pathname.startsWith('/api/')) {
      try { return await api(req, env, url); }
      catch (e) { return fail(500, 'The shared world could not answer right now.'); }
    }

    if (url.pathname === '/' || url.pathname === '/index.html')
      return new Response(HTML, {headers:{'content-type':'text/html; charset=utf-8', 'cache-control':'public, max-age=300', ...SEC}});
    // The founder's Forge (r57): builds token-creation transactions for the visitor's own wallet to sign. It holds no
    // keys and calls nothing on this server; a wallet extension is the only thing it talks to.
    if (url.pathname === '/forge')
      return new Response(FORGE, {headers:{'content-type':'text/html; charset=utf-8', 'cache-control':'no-store', 'x-robots-tag':'noindex, nofollow', ...SEC,
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"}});
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\nDisallow: /forge\n', {headers:{'content-type':'text/plain'}});
    return Response.redirect(url.origin + '/', 302);
  },
  // Cron trigger (hourly, wrangler.toml): bring real weather into Xland
  async scheduled(event, env, ctx) { ctx.waitUntil(weatherBridge(env, Date.now()).catch(e => console.log('weather bridge failed:', e.message))); }
};

