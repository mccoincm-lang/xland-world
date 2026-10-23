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
   - posts: the founder may also rewrite any posts document (moderation) */
const PUBLIC = ['citizens','posts','gov','ballots','claims'];
const FOUNDER_READ = ['progress','feedback'];
const SELF_WRITE = ['citizens','posts','gov','ballots','progress','feedback','state'];
const ALL = PUBLIC.concat(FOUNDER_READ, ['state']);
const MAX_DOC = 64 * 1024, MAX_STATE = 1024 * 1024;
const NEW_PER_NETWORK_PER_DAY = 8;
const ID_RE = /^[A-Za-z0-9_\-]{1,64}$/;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS waitlist (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, name TEXT, interest TEXT, lang TEXT, country TEXT, created_at TEXT DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS xl_docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, owner TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (col, id))",
  "CREATE INDEX IF NOT EXISTS xl_docs_updated ON xl_docs (updated_at)",
  "CREATE TABLE IF NOT EXISTS xl_accounts (uid TEXT PRIMARY KEY, created_at INTEGER NOT NULL, netday TEXT NOT NULL, country TEXT)",
  "CREATE INDEX IF NOT EXISTS xl_accounts_netday ON xl_accounts (netday)",
  "CREATE TABLE IF NOT EXISTS xl_leases (key TEXT PRIMARY KEY, holder TEXT NOT NULL, expires INTEGER NOT NULL)"
];
let schemaReady = false;
async function ensureSchema(env){ if(schemaReady) return; for(const s of SCHEMA) await env.DB.prepare(s).run(); schemaReady = true; }

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

