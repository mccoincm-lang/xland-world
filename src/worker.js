// Xland — xland.world (Cloudflare Worker)
// Serves the Xland world and its shared multiplayer API, plus the waitlist.
// Bindings: D1 database as `DB` (xland-waitlist). Secret `ADMIN_KEY`: the founder key (dashboard, moderation, CSV export).
// Tables are created automatically on first use; schema.sql holds the same statements.
import HTML from "../dist/index.html";

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
  "CREATE TABLE IF NOT EXISTS xl_plots (uid TEXT NOT NULL, slot TEXT NOT NULL, kind TEXT NOT NULL, started INTEGER NOT NULL, ends INTEGER NOT NULL, out INTEGER NOT NULL, op TEXT NOT NULL, PRIMARY KEY (uid, slot))"
];

/* ---------------- World economy (server-authoritative) ----------------
   Amounts are in base units: 1 QuarX = 1 BuX = 10,000 units (the page uses the same DEC = 4).
   QuarX: hard cap 1,000,000,000. A quarter is the genesis reserve (Forerunner Vaults); the other 750,000,000 can only
   be mined in Xalp. Mining epochs halve: epoch 1 releases half of the minable supply, epoch 2 a quarter, and so on, and
   the reward per seam halves with each epoch. Difficulty: seams take longer when more citizens mine than the target.
   BuX: 1 BuX = 1 USD, minted only against a stablecoin deposit that stays locked in the BanX reserve for good.
   The page mirrors these rules (ECONOMY in index.html) for display and for its rule tests. */
const UNIT = 10000;
const ECON = { quarxCap: 1e9, genesis: 2.5e8, seamReward: 1, seamSecsMin: 60, seamSecsMax: 120, dailySeams: 5, targetMiners: 8, sandboxBuX: 1000 };
/* Citizen shops (provisional, alpha). Each open territory has its own kind of shop: the QuarX its shopfront consumes for
   good, the goods it may sell, and the market fee to the territory treasury (none in tax-free lands). A buyer may cancel an
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
const dayStart = t => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };
async function worldCounter(env, k){ const r = await env.DB.prepare('SELECT n FROM xl_world WHERE k = ?1').bind(k).first(); return r ? Number(r.n) : 0; }
async function addWorld(env, k, d){ await env.DB.prepare('INSERT INTO xl_world (k, n) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET n = n + excluded.n').bind(k, d).run(); }
async function miners24h(env, now){ const r = await env.DB.prepare('SELECT COUNT(DISTINCT uid) AS n FROM xl_minelog WHERE at > ?1').bind(now - 86400000).first(); return r ? Number(r.n) : 0; }
async function worldReport(env, now){
  const mined = await worldCounter(env, 'quarx_mined'), miners = await miners24h(env, now);
  return {
    unit: UNIT,
    quarx: { cap: ECON.quarxCap * UNIT, genesis: ECON.genesis * UNIT, minable: MINABLE, mined, epoch: quarxEpoch(mined) + 1, reward: seamReward(mined),
      nextHalvingAt: nextHalvingAt(mined), miners24h: miners, difficulty: difficulty(miners), dailySeams: ECON.dailySeams },
    bux: { minted: await worldCounter(env, 'bux_minted'), reserve: await worldCounter(env, 'bux_reserve') },
    market: { shopfronts: await worldCounter(env, 'shopfronts'), quarxConsumed: await worldCounter(env, 'quarx_consumed'), sales: await worldCounter(env, 'market_sales'),
      volume: await worldCounter(env, 'market_volume'), fees: await worldCounter(env, 'market_fees'), shops: SHOPS }
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
  if(!pos.length) return walletApply(env, uid, op, d, null, data);                           // spending only
  if(op === 'sandbox-grant') return sandboxMint(env, uid, now);
  if(op.startsWith('swap-')){
    const venue = op.split('-')[1], goods = Object.keys(d).filter(a => a !== 'bux' && d[a] !== 0n), bux = d.bux || 0n;
    if(!VENUES[venue] || goods.length !== 1 || !VENUES[venue].includes(goods[0])) return { ok: false, why: 'This market does not trade that.' };
    const a = goods[0], q = d[a], value = (q < 0n ? -q : q) * BigInt(RATES[a]);
    if(q < 0n){ if(bux > value) return { ok: false, why: 'The price is above the market rate.' };
      if(a === 'quarx'){ const cap = BigInt(ECON.dailySeams * seamReward(await worldCounter(env, 'quarx_mined'))); if(await quarxSoldToday(env, uid, now) - q > cap) return { ok: false, why: 'Daily QuarX sale limit reached.' }; } }
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
    if(slot === 'own' && !(await env.DB.prepare("SELECT 1 FROM xl_ledger WHERE uid = ?1 AND op LIKE 'proj-%consume%'").bind(me.uid).first())) return fail(403, 'Your own plot needs a finished farmstead.');
    const open = await env.DB.prepare('SELECT * FROM xl_plots WHERE uid = ?1 AND slot = ?2').bind(me.uid, slot).first();
    if(open) return json({ok:true, now, start: Number(open.started), end: Number(open.ends), out: Number(open.out), kind: open.kind, op: open.op});
    const mult = Math.min(1, Math.max(0.5, Number(q.get('mult')) || 1));   // the page may only lower a yield (droughts, events)
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
    const amount = cfg.quarx * UNIT;
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
    const cfg = SHOPS.ixeland, id = q.get('id') || '', share = Math.floor(cfg.quarx * UNIT / cfg.coop.max);
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
      feeBps = Math.max(feeBps, Math.min(2000, Math.max(0, Math.floor(Number(item.feeBps) || 0))));   // anti-flip fee on resale
      const link = typeof item.link === 'string' && /^https:\/\/[^\s"'<>]{4,300}$/.test(item.link) ? item.link : null;
      meta = JSON.stringify({ title: String(item.title || 'A rare asset').slice(0, 60), kind: String(item.kind || 'Collectible').slice(0, 20), link });
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
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\n', {headers:{'content-type':'text/plain'}});
    return Response.redirect(url.origin + '/', 302);
  }
};

