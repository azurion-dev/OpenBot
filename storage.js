// Storage layer: everything lives in ./data (or $DATA_DIR), one folder per user and per bot.
//
// data/
//   sessions.json
//   .migrated                          (marker: the old data.json was already converted)
//   users/<user>/
//     user.json                        (password hash + bot order + botLinks)
//     bots/<botId>/
//       bot.json                       (name, avatar, settings, ...)
//       modules.json   warnings.json   reacts.json
//       commands/<commandId>.json
//       events/<eventId>.json
//       databases/<name>.json          (the bot's databases)
//
// Shared bots: when several accounts add the same bot (same token), they all use ONE workspace. The bot's files live in the folder of
// its owner (b.owner); the other accounts only keep a link in user.json -> botLinks: [{ owner, id }].
//
// An old single-file data.json is converted automatically on first start (and kept as data.json.migrated).
//
// IMPORTANT (cloud hosts): saveAsync() NEVER blocks the event loop. It serializes in memory, then writes ONE file at a time with
// fs.promises and yields between files, so Discord heartbeats / DNS lookups keep working while saving. save() (sync) is only for shutdown.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const fsp = fs.promises;

const ROOT = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const USERS = path.join(ROOT, 'users'), SESS = path.join(ROOT, 'sessions.json'), MARK = path.join(ROOT, '.migrated');
const LEGACY = path.join(__dirname, 'data.json');

// names that become file/folder names or object keys: no path tricks and no prototype keys
const ok = s => /^[A-Za-z0-9_-]{1,64}$/.test(String(s)) && !['__proto__', 'constructor', 'prototype'].includes(String(s));
// ---------- bot tokens are encrypted on disk (AES-256-GCM) ----------
// Key: $OPENBOT_SECRET, or a random one generated in data/.secret (mode 600). Lose the key = the tokens must be entered again.
const KEYF = path.join(ROOT, '.secret'), PRE = 'enc1:';
let KEY;
function key() {
  if (KEY) return KEY;
  let s = process.env.OPENBOT_SECRET;
  if (!s) { try { s = fs.readFileSync(KEYF, 'utf8').trim(); } catch {} }
  if (!s) { s = crypto.randomBytes(32).toString('hex'); fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 }); fs.writeFileSync(KEYF, s, { mode: 0o600 }); }
  return KEY = crypto.createHash('sha256').update(s).digest();
}
// the IV is derived from the token itself (synthetic IV), so the same token always gives the same text and files are not rewritten for nothing
const seal = t => {
  if (typeof t !== 'string' || !t || t.startsWith(PRE)) return t;
  const k = key(), iv = crypto.createHmac('sha256', k).update(t).digest().subarray(0, 12), c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(t, 'utf8'), c.final()]);
  return PRE + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
};
const unseal = t => {
  if (typeof t !== 'string' || !t.startsWith(PRE)) return t;
  try {
    const b = Buffer.from(t.slice(PRE.length), 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { console.error('Could not decrypt a bot token (wrong OPENBOT_SECRET / missing data/.secret?). It was kept untouched on disk.'); return t; }
};
const sealSettings = st => st && typeof st === 'object' ? { ...st, token: seal(st.token) } : st;

const seen = new Map();                      // file -> last content written/read (so only changed files are rewritten)

// reads a JSON file. If it is corrupt we try the .bak copy; the broken file is renamed (never silently treated as empty and then overwritten)
const rd = (f, d) => {
  for (const g of [f, f + '.bak']) {
    try { const t = fs.readFileSync(g, 'utf8'), j = JSON.parse(t); seen.set(f, g === f ? t : ''); return j; }
    catch (e) {
      if (e.code === 'ENOENT') continue;
      if (g === f) { console.error('⚠️ Corrupt file, trying the backup:', f, e.message); try { fs.renameSync(f, f + '.corrupt-' + Date.now()); } catch {} }
    }
  }
  return d;
};
const dirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; } };
const jsons = d => { try { return fs.readdirSync(d).filter(f => f.endsWith('.json')); } catch { return []; } };
const byOrder = (list, order, key) => {
  const o = order || [], pos = x => { const p = o.indexOf(key(x)); return p < 0 ? 1e9 : p; };
  return [...list].sort((a, b) => pos(a) - pos(b));
};

// ---------- database values ----------
const TYPES = ['string', 'number', 'boolean', 'list', 'json'];
function infer(raw) {
  if (Array.isArray(raw)) return 'list';
  if (raw && typeof raw === 'object') return 'json';
  if (typeof raw === 'boolean') return 'boolean';
  if (typeof raw === 'number') return 'number';
  const s = String(raw ?? '').trim();
  if (/^(true|false)$/i.test(s)) return 'boolean';
  if (/^-?\d+([.,]\d+)?$/.test(s)) return 'number';
  return 'string';
}
// returns { type, value } with the value converted to the type (throws a readable error if it does not fit)
function coerce(type, raw) {
  type = TYPES.includes(type) ? type : infer(raw);
  let v;
  if (type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim().replace(',', '.'));
    if (!Number.isFinite(n)) throw new Error(`"${raw}" is not a valid number`);
    v = n;
  } else if (type === 'boolean') {
    if (typeof raw === 'boolean') v = raw;
    else {
      const s = String(raw ?? '').trim().toLowerCase();
      if (['true', '1', 'yes', 'sim', 'on'].includes(s)) v = true;
      else if (['false', '0', 'no', 'nao', 'não', 'off', ''].includes(s)) v = false;
      else throw new Error(`"${raw}" is not true or false`);
    }
  } else if (type === 'list') {
    if (Array.isArray(raw)) v = raw;
    else {
      const s = String(raw ?? '').trim();
      if (s.startsWith('[')) { try { v = JSON.parse(s); } catch { throw new Error('Invalid list (JSON)'); } if (!Array.isArray(v)) throw new Error('Invalid list (JSON)'); }
      else v = s ? s.split(/\r?\n/).map(x => x.trim()).filter(Boolean) : [];
    }
  } else if (type === 'json') {
    if (raw && typeof raw === 'object') v = raw;
    else { try { v = JSON.parse(String(raw ?? '')); } catch { throw new Error('Invalid JSON'); } }
  } else v = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? JSON.stringify(raw) : String(raw ?? '');
  if (JSON.stringify(v).length > 4000) throw new Error('Value too large (max 4000 characters)');
  return { type, value: v };
}

// ---------- load ----------
function loadTree() {
  const db = { users: {}, sessions: rd(SESS, {}) }, raw = {};
  for (const u of dirs(USERS)) {
    if (!ok(u)) continue;
    const uf = rd(path.join(USERS, u, 'user.json'), null); if (!uf) continue;
    const { botOrder, botLinks, ...user } = uf, bdir = path.join(USERS, u, 'bots'), list = [];
    for (const id of dirs(bdir)) {
      const base = path.join(bdir, id), meta = rd(path.join(base, 'bot.json'), null); if (!meta) continue;
      const { commandOrder, eventOrder, ...b } = meta;
      b.owner = u;
      if (b.settings) b.settings = { ...b.settings, token: unseal(b.settings.token) };
      b.modules = rd(path.join(base, 'modules.json'), undefined);
      b.warnings = rd(path.join(base, 'warnings.json'), {});
      b.reacts = rd(path.join(base, 'reacts.json'), {});
      const many = sub => jsons(path.join(base, sub)).map(f => rd(path.join(base, sub, f), null)).filter(Boolean);
      b.commands = byOrder(many('commands'), commandOrder, x => x.id);
      b.events = byOrder(many('events'), eventOrder, x => x.id);
      b.dbs = {};
      for (const t of many('databases')) if (ok(t.name)) b.dbs[t.name] = { name: t.name, entries: t.entries || {} };
      list.push(b);
    }
    raw[u] = { user, list, order: botOrder, links: Array.isArray(botLinks) ? botLinks : [] };
  }
  // second pass: accounts that share a bot point to the very same object (one workspace, edited by everyone)
  for (const [u, r] of Object.entries(raw)) {
    for (const l of r.links) {
      const b = raw[l && l.owner]?.list.find(x => x.id === l.id);
      if (b && !r.list.includes(b)) r.list.push(b);
    }
    r.user.bots = byOrder(r.list, r.order, b => b.id);
    db.users[u] = r.user;
  }
  return db;
}

// old data.json -> same in-memory shape (the bot's old `store` becomes the "default" database)
function migrate() {
  const old = JSON.parse(fs.readFileSync(LEGACY, 'utf8'));
  const db = { users: old.users || {}, sessions: old.sessions || {} };
  for (const user of Object.values(db.users)) for (const b of user.bots || []) {
    b.dbs = b.dbs || {};
    const entries = {};
    for (const [k, v] of Object.entries(b.store || {})) {
      const body = k.replace(/^k:/, ''), p = body.indexOf('|'); if (p < 0) continue;
      const scope = body.slice(0, p), name = body.slice(p + 1), type = infer(v);
      let value = v; try { value = coerce(type, v).value; } catch {}
      entries[`${scope}|${name}`] = { name, scope, type, value, at: Date.now() };
    }
    if (Object.keys(entries).length) b.dbs.default = { name: 'default', entries: { ...(b.dbs.default?.entries || {}), ...entries } };
    delete b.store;
  }
  return db;
}

function load() {
  fs.mkdirSync(USERS, { recursive: true, mode: 0o700 });
  for (const d of [ROOT, USERS]) { try { fs.chmodSync(d, 0o700); } catch {} }   // other accounts on this machine cannot even list the data folder
  if (fs.existsSync(LEGACY) && !fs.existsSync(MARK)) {
    try { return { db: migrate(), migrated: true }; } catch (e) { console.error('Could not read the old data.json:', e.message); }
  }
  return { db: loadTree(), migrated: false };
}

// ---------- save ----------
const RETRY = ['EPERM', 'EBUSY', 'EACCES', 'EMFILE', 'ENFILE'];
const sleepSync = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const yieldLoop = () => new Promise(r => setImmediate(r));   // lets Discord / HTTP / DNS work between two files

// ----- SYNC writer (only used when the program is closing) -----
function write(f, t) {
  let last;
  try { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); } catch (e) { last = e; }
  const tmp = f + '.' + process.pid + '.tmp';
  for (let n = 0; n < 5; n++) {
    try {
      fs.writeFileSync(tmp, t, { mode: 0o600 });
      try { if (seen.get(f)) fs.copyFileSync(f, f + '.bak'); } catch {}
      fs.renameSync(tmp, f); seen.set(f, t); return true;
    } catch (e) {
      last = e;
      if (!RETRY.includes(e.code)) break;
      sleepSync(30 * (n + 1));
    }
  }
  try { fs.unlinkSync(tmp); } catch {}
  try { fs.writeFileSync(f, t, { mode: 0o600 }); seen.set(f, t); return true; } catch (e) { last = e; }
  console.error('Could not write', f, last && last.message);
  return false;
}
function remove(f) {
  try { fs.unlinkSync(f); } catch {}
  seen.delete(f);
  for (let d = path.dirname(f); d.startsWith(USERS) && d !== USERS; d = path.dirname(d)) { try { fs.rmdirSync(d); } catch { break; } }
}

// ----- ASYNC writer (normal operation: never blocks the event loop) -----
async function writeAsync(f, t) {
  let last;
  const tmp = f + '.' + process.pid + '.tmp';
  for (let n = 0; n < 5; n++) {
    try {
      await fsp.mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
      await fsp.writeFile(tmp, t, { mode: 0o600 });
      if (seen.get(f)) { try { await fsp.copyFile(f, f + '.bak'); } catch {} }   // previous good version
      await fsp.rename(tmp, f); seen.set(f, t); return true;
    } catch (e) {
      last = e;
      if (!RETRY.includes(e.code)) break;
      await sleep(30 * (n + 1));                                       // file briefly locked: wait (without blocking) and retry
    }
  }
  try { await fsp.unlink(tmp); } catch {}
  try { await fsp.writeFile(f, t, { mode: 0o600 }); seen.set(f, t); return true; } catch (e) { last = e; }   // last resort: write in place
  console.error('Could not write', f, last && last.message);
  return false;
}
async function removeAsync(f) {
  try { await fsp.unlink(f); } catch {}
  seen.delete(f);
  for (let d = path.dirname(f); d.startsWith(USERS) && d !== USERS; d = path.dirname(d)) { try { await fsp.rmdir(d); } catch { break; } }
}

// turns the in-memory database into a Map(file -> text). Fully synchronous = a consistent snapshot, nothing can change in the middle.
function build(db) {
  const out = new Map();
  let errs = 0;
  const put = (f, v) => { try { out.set(f, JSON.stringify(v, null, 2)); } catch (e) { errs++; console.error('Could not serialize', f, e.message); } };
  put(SESS, db.sessions || {});
  // every bot must have exactly one owner that really has it in its list (otherwise the first account that has it takes it)
  for (const [u, user] of Object.entries(db.users || {})) for (const b of user.bots || []) {
    const o = db.users[b.owner];
    if (!o || !(o.bots || []).includes(b) || !ok(b.owner)) b.owner = u;
  }
  for (const [u, user] of Object.entries(db.users || {})) {
    if (!ok(u)) { console.warn('Skipped user with an invalid name:', u); continue; }
    const { bots = [], ...rest } = user, ub = path.join(USERS, u);
    const links = bots.filter(b => b.owner !== u).map(b => ({ owner: b.owner, id: b.id }));
    put(path.join(ub, 'user.json'), { ...rest, botOrder: bots.map(b => b.id), botLinks: links });
    for (const b of bots) {
      if (!ok(b.id) || b.owner !== u) continue;                 // shared bots are written once, in the owner's folder
      try {                                                      // one broken bot can never stop the others from being saved
        const base = path.join(ub, 'bots', b.id), { commands = [], events = [], modules, warnings, reacts, dbs = {}, owner, ...meta } = b;
        put(path.join(base, 'bot.json'), { ...meta, settings: sealSettings(meta.settings), commandOrder: commands.map(c => c.id), eventOrder: events.map(c => c.id) });
        put(path.join(base, 'modules.json'), modules || {});
        put(path.join(base, 'warnings.json'), warnings || {});
        put(path.join(base, 'reacts.json'), reacts || {});
        for (const c of commands) if (ok(c.id)) put(path.join(base, 'commands', c.id + '.json'), c);
        for (const c of events) if (ok(c.id)) put(path.join(base, 'events', c.id + '.json'), c);
        for (const [n, t] of Object.entries(dbs)) if (ok(n)) put(path.join(base, 'databases', n + '.json'), { name: n, entries: t.entries || {} });
      } catch (e) { errs++; console.error('Could not prepare bot', b && b.id, e.message); }
    }
  }
  return { out, errs };
}

// deleting files: only when everything went fine, and never "wipe everything" because the memory looks empty
function planDelete(out, failed) {
  const known = [...seen.keys()].filter(f => f.startsWith(USERS)), gone = known.filter(f => !out.has(f));
  if (failed === 0 && !(known.length > 3 && gone.length === known.length)) return gone;
  if (gone.length) console.warn('Skipped deleting', gone.length, 'file(s) for safety (save had errors or everything looked empty).');
  return [];
}

// SYNC save: only for shutdown / first migration
function save(db) {
  const { out, errs } = build(db);
  let failed = errs;
  for (const [f, t] of out) if (seen.get(f) !== t && !write(f, t)) failed++;
  for (const f of planDelete(out, failed)) remove(f);
  return { ok: failed === 0, failed };
}

// ASYNC save: normal operation. Only changed files are written, one at a time, yielding to the event loop between files.
async function saveAsync(db) {
  const { out, errs } = build(db);
  let failed = errs;
  for (const [f, t] of out) {
    if (seen.get(f) === t) continue;
    if (!(await writeAsync(f, t))) failed++;
    await yieldLoop();
  }
  for (const f of planDelete(out, failed)) { await removeAsync(f); await yieldLoop(); }
  return { ok: failed === 0, failed };
}

// call after the first save of migrated data: leaves a marker and keeps the old file as a backup
function finishMigration() {
  try {
    fs.writeFileSync(MARK, new Date().toISOString());
    if (fs.existsSync(LEGACY)) {
      let t = LEGACY + '.migrated'; if (fs.existsSync(t)) t += '-' + Date.now();
      fs.renameSync(LEGACY, t);
      console.log('📦 data.json was converted to the ./data folder (backup: ' + path.basename(t) + ')');
    }
  } catch (e) { console.error('Migration cleanup failed:', e.message); }
}

module.exports = { load, save, saveAsync, finishMigration, coerce, infer, TYPES, ROOT, ok };