const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto'), bot = require('./bot'), storage = require('./storage');
// everything lives in ./data (see storage.js); an old data.json is converted automatically on first start
const loaded = storage.load();
let db = { users: {}, sessions: {}, ...loaded.db };
const OLD = '🍯Dashboard by azurion🍯', PREV = '🐈‍⬛Made with OpenCordBot🐈‍⬛', NEWT = '🐈‍⬛Made with OpenBot🐈‍⬛';
const conv = c => {
  if (!c.nodes) {
    const bl = c.blocks || [];
    c.nodes = bl.map((b, i) => ({ id: b.id, type: b.type === 'reply' ? 'message' : b.type,
      data: b.type === 'reply' ? { msg: { mode: 'embed', content: b.data?.content || '', ephemeral: !!b.data?.ephemeral, embeds: [], rows: [], items: [] } } : (b.data || {}),
      x: 80, y: 260 + i * 180, next: bl[i + 1]?.id || null }));
    c.start = { x: 80, y: 60, next: bl[0]?.id || null }; delete c.blocks;
  }
  c.start = c.start || { x: 80, y: 60, next: null };
  return c;
};
// ---------- events + built-in modules ----------
const EVENTS = ['member_join', 'member_leave', 'member_ban', 'member_unban', 'member_role_add', 'member_role_remove', 'member_nickname', 'member_boost', 'presence_update',
  'message_create', 'message_edit', 'message_delete', 'reaction_add', 'reaction_remove', 'voice_join', 'voice_leave', 'voice_move',
  'channel_create', 'channel_delete', 'channel_update', 'role_create', 'role_delete', 'role_update', 'thread_create', 'thread_delete',
  'invite_create', 'invite_delete', 'bot_join',
  'member_kick', 'member_timeout', 'member_untimeout', 'voice_mute', 'voice_deafen', 'message_bulk_delete', 'emoji_create', 'emoji_delete'];
// command access rules (permissions / roles) and cooldown, kept well-formed
const acc = c => ({ ...c,
  reqPerms: String(c.reqPerms || '').split(/[\s,]+/).filter(p => /^[A-Za-z]{3,40}$/.test(p)).join(',').slice(0, 800),
  permMode: c.permMode === 'any' ? 'any' : 'all',
  reqRoles: String(c.reqRoles || '').slice(0, 600), denyRoles: String(c.denyRoles || '').slice(0, 600),
  bypassAdmin: c.bypassAdmin !== false, denyMsg: String(c.denyMsg || '').slice(0, 300),
  cooldown: Math.min(Math.max(Number(c.cooldown) || 0, 0), 604800),
  cooldownScope: ['user', 'server', 'global'].includes(c.cooldownScope) ? c.cooldownScope : 'user',
  cdAdmin: !!c.cdAdmin, cdMsg: String(c.cdMsg || '').slice(0, 300),
  database: dbn(c.database) });
const rule = (extra = {}) => ({ enabled: false, action: 'delete', minutes: 10, ...extra });
const MOD_DEF = () => ({
  welcome: { enabled: false, channel: '', dm: false, content: 'Welcome {user}!', embed: true, title: 'Welcome to {server}!', description: 'Hey {user}, you are member #{server.members}. Enjoy your stay!', color: '#5865f2', image: '', avatar: true, footer: '' },
  goodbye: { enabled: false, channel: '', content: '', embed: true, title: 'Goodbye', description: '**{user.name}** left the server. We are now {server.members} members.', color: '#f87171', image: '', avatar: true, footer: '' },
  autorole: { enabled: false, roles: '', botRoles: '' },
  automod: { enabled: false, ignoreAdmins: true, ignoreRoles: '', ignoreChannels: '', notify: true,
    rules: { spam: rule({ max: 5, seconds: 6 }), invites: rule(), links: rule({ allow: '' }), badwords: rule({ words: '' }), caps: rule({ percent: 70, minLength: 12 }), mentions: rule({ max: 5 }) } },
  moderation: { enabled: false, dm: true, warnLimit: 3, warnAction: 'timeout', warnMinutes: 60,
    commands: { ban: true, kick: true, timeout: true, untimeout: true, unban: true, warn: true, warnings: true, clearwarnings: true, purge: true, slowmode: true, lock: true, unlock: true } },
  logs: { modChannel: '', automodChannel: '', messageChannel: '', memberChannel: '' }
});
// keeps only known keys and coerces to the default's type (so saved data is always well-formed)
const deep = (d, v) => {
  if (d && typeof d === 'object' && !Array.isArray(d)) { const o = {}; for (const k in d) o[k] = deep(d[k], v?.[k]); return o; }
  if (v === undefined || typeof v !== typeof d) return d;
  return typeof v === 'string' ? v.slice(0, 4000) : v;
};
// ---------- bot databases ----------
// never let a name like "__proto__" or "constructor" reach an object key (prototype pollution)
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const dbn = s => { s = String(s || '').trim().toLowerCase(); return /^[a-z0-9_-]{1,32}$/.test(s) && !RESERVED.has(s) ? s : ''; };
const fixDbs = d => {
  const o = {};
  for (const [n, t] of Object.entries(d || {})) { const k = dbn(n); if (k) o[k] = { name: k, entries: t?.entries && typeof t.entries === 'object' ? t.entries : {} }; }
  o.default ||= { name: 'default', entries: {} };
  return o;
};
for (const u of Object.values(db.users)) for (const b of u.bots || []) {
  if ([OLD, PREV].includes(b.settings?.activityText)) b.settings.activityText = NEWT;
  if (b.settings) b.settings.guildId = String(b.settings.guildId || '').replace(/\D/g, '');
  b.commands = (b.commands || []).map(conv);
  b.events = (b.events || []).map(conv);
  b.modules = deep(MOD_DEF(), b.modules);
  b.warnings = b.warnings || {};
  b.reacts = b.reacts || {};
  b.dbs = fixDbs(b.dbs); delete b.store;
}
const save = () => { try { storage.save(db); } catch (e) { console.error('Could not save data:', e.message); } };
// sessions are stored as sha256(sid) -> { u, exp }. Old-format / expired sessions are dropped (those users just sign in again)
for (const [k, v] of Object.entries(db.sessions)) if (!v || typeof v !== 'object' || !(v.exp > Date.now())) delete db.sessions[k];
if (loaded.migrated) { save(); storage.finishMigration(); }
const uid = () => crypto.randomBytes(6).toString('hex');
// command / event ids become file names, so keep them safe and unique
const fixIds = list => { const used = new Set(); return list.map(c => { let id = String(c.id || '').replace(/[^\w-]/g, '').slice(0, 40); if (!id || used.has(id)) id = uid(); used.add(id); return { ...c, id }; }); };
// async (a login can no longer freeze the whole server) - same parameters as before, so existing hashes keep working
const hash = (p, s) => new Promise((res, rej) => crypto.scrypt(String(p), String(s), 64, (e, k) => e ? rej(e) : res(k.toString('hex'))));
const newSalt = () => crypto.randomBytes(16).toString('hex');
const eq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const DUMMY = { salt: newSalt(), hash: '0'.repeat(128) };      // used so "unknown user" takes as long as "wrong password"
// tiny in-memory rate limiter
const hits = new Map();
const limit = (k, max, ms) => {
  const now = Date.now(); let h = hits.get(k);
  if (!h || h.t < now) { h = { n: 0, t: now + ms }; hits.set(k, h); }
  if (++h.n > max) { const e = new Error('Too many attempts. Wait a few minutes and try again.'); e.status = 429; throw e; }
};
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.t < n) hits.delete(k); }, 60000).unref();
const TOKEN_RE = /^[\w.-]{20,200}$/;

const app = express();
app.disable('x-powered-by');
// behind a reverse proxy set TRUST_PROXY=1 (or true / a subnet) so the real client IP and https are used
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);
app.use((q, r, n) => {
  r.setHeader('X-Content-Type-Options', 'nosniff');
  r.setHeader('X-Frame-Options', 'DENY');
  r.setHeader('Referrer-Policy', 'same-origin');
  r.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
  if (q.secure) r.setHeader('Strict-Transport-Security', 'max-age=15552000');
  if (q.path.startsWith('/api/')) r.setHeader('Cache-Control', 'no-store');
  n();
});
// requests that change something must come from this very site (CSRF defence on top of SameSite cookies)
app.use('/api', (q, r, n) => {
  if (q.method === 'GET' || q.method === 'HEAD') return n();
  const o = q.get('origin');
  if (o) {
    let h = ''; try { h = new URL(o).host; } catch {}
    if (h !== ((app.get('trust proxy') && q.get('x-forwarded-host')) || q.get('host'))) return r.status(403).json({ error: 'Blocked: request from another site' });
  }
  n();
});
// public endpoints only accept tiny bodies; the big (8 MB) parser is only reached after the user is logged in (see below)
for (const p of ['/api/login', '/api/register', '/api/logout']) app.use(p, express.json({ limit: '4kb' }));
const idx = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find(fs.existsSync);
// ---------- assets (./assets next to ./public: logo.png, logo.ico) ----------
const ASSETS = path.join(__dirname, 'assets');
fs.mkdirSync(ASSETS, { recursive: true });
app.use('/assets', express.static(ASSETS, { maxAge: '1h' }));
const asset = f => (q, r) => r.sendFile(path.join(ASSETS, f), e => { if (e && !r.headersSent) r.status(404).end(); });
app.get('/favicon.ico', asset('logo.ico'));
app.get('/logo.png', asset('logo.png'));

const cookie = q => {
  const o = Object.create(null);
  for (const c of String(q.headers.cookie || '').split(';')) { const i = c.indexOf('='); if (i > 0) o[c.slice(0, i).trim()] = c.slice(i + 1).trim(); }
  return o;
};
const sh = x => crypto.createHash('sha256').update(String(x)).digest('hex');
const SESSION_MS = 30 * 24 * 3600 * 1000;
// session id -> { k: stored key (hash of the id), u: username } or null; expired sessions are removed
const sessOf = q => {
  const sid = cookie(q).sid;
  if (!sid || !/^[a-f0-9]{48}$/.test(sid)) return null;
  const k = sh(sid), v = own(db.sessions, k) ? db.sessions[k] : null;
  if (!v) return null;
  if (!(v.exp > Date.now())) { delete db.sessions[k]; return null; }
  return { k, u: v.u };
};
const cookieStr = (q, v, age) => `sid=${v}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${age}` + (q.secure || process.env.COOKIE_SECURE === '1' ? '; Secure' : '');
const auth = (q, r, next) => {
  if (q.user) return next();
  const s = sessOf(q);
  if (!s || !own(db.users, s.u)) return r.status(401).json({ error: 'login' });
  try { limit('api:' + s.u, 1200, 60000); } catch (e) { return r.status(429).json({ error: e.message }); }
  q.user = db.users[s.u]; q.uname = s.u; next();
};
const PUBLIC_API = new Set(['/login', '/register', '/logout']);
app.use('/api', (q, r, n) => PUBLIC_API.has(q.path) ? n() : auth(q, r, n));     // not logged in = rejected BEFORE any big body is read
app.use('/api', express.json({ limit: '8mb' }));
const session = (r, q, u) => {
  const sid = crypto.randomBytes(24).toString('hex'), now = Date.now();
  for (const [k, v] of Object.entries(db.sessions)) if (!v || typeof v !== 'object' || !(v.exp > now)) delete db.sessions[k];
  const mine = Object.entries(db.sessions).filter(([, v]) => v.u === u).sort((x, y) => x[1].exp - y[1].exp);
  while (mine.length >= 10) delete db.sessions[mine.shift()[0]];                // at most 10 devices per account
  db.sessions[sh(sid)] = { u, exp: now + SESSION_MS }; save();
  r.setHeader('Set-Cookie', cookieStr(q, sid, SESSION_MS / 1000));
};
const cred = q => {
  const b = q.body || {}, u = String(b.username || '').trim().toLowerCase(), p = String(b.password || '');
  if (!/^[a-z0-9_]{3,20}$/.test(u) || RESERVED.has(u)) throw new Error('Username: 3-20 letters, numbers or _');
  if (p.length > 128) throw new Error('Password: at most 128 characters');
  return [u, p];
};
const strong = (p, u) => {
  if (p.length < 8) throw new Error('Password: at least 8 characters');
  if (p.toLowerCase() === u) throw new Error('Password cannot be the same as the username');
};
// every API call has a time limit, so a slow Discord can never leave the dashboard hanging
const wrap = fn => async (q, r) => {
  let t;
  try {
    const out = await Promise.race([Promise.resolve().then(() => fn(q, r)), new Promise((_, rej) => { t = setTimeout(() => rej(new Error('The server took too long to answer. Try again.')), 60000); })]);
    if (!r.headersSent) r.json(out);
  } catch (e) { if (!r.headersSent) r.status(e.status || 400).json({ error: e.message }); }
  finally { clearTimeout(t); }
};

// ---------- pages: every section has its own URL (the page itself reads location.pathname) ----------
const logged = q => { const s = sessOf(q); return !!(s && own(db.users, s.u)); };
const sendIdx = (q, r) => idx ? r.sendFile(idx) : r.status(404).send('index.html not found');
app.get('/', (q, r) => r.redirect(logged(q) ? '/dashboard' : '/login'));
app.get(['/login', '/register'], (q, r) => logged(q) ? r.redirect('/dashboard') : sendIdx(q, r));
app.get(['/add-bot', '/account', '/dashboard', '/command-builder', '/command-builder/:id', '/events', '/events/:id', '/variables', '/databases', '/settings'],
  (q, r) => logged(q) ? sendIdx(q, r) : r.redirect('/login?next=' + encodeURIComponent(q.originalUrl)));
// old URLs
app.get('/commands', (q, r) => r.redirect('/command-builder'));
app.get('/commands/:id', (q, r) => r.redirect('/command-builder/' + encodeURIComponent(q.params.id)));
app.get(['/modules', '/modules/:name'], (q, r) => r.redirect('/dashboard'));

app.post('/api/register', wrap(async (q, r) => {
  limit('reg:' + q.ip, 5, 3600000);
  if (process.env.ALLOW_REGISTER === '0' && Object.keys(db.users).length) throw new Error('Registration is closed on this server');
  const [u, p] = cred(q); strong(p, u);
  if (own(db.users, u)) throw new Error('That username already exists');
  const salt = newSalt(), h = await hash(p, salt);
  if (own(db.users, u)) throw new Error('That username already exists');
  db.users[u] = { salt, hash: h, bots: [] };
  session(r, q, u); return { ok: 1 };
}));
app.post('/api/login', wrap(async (q, r) => {
  limit('li:' + q.ip, 30, 600000);
  const [u, p] = cred(q);
  limit('lu:' + q.ip + '|' + u, 8, 600000); limit('lu:' + u, 40, 600000);
  const real = own(db.users, u) ? db.users[u] : null, x = real || DUMMY;
  const good = eq(await hash(p, x.salt), x.hash) && !!real;
  if (!good) throw new Error('Invalid username or password');
  hits.delete('lu:' + q.ip + '|' + u);
  session(r, q, u); return { ok: 1 };
}));
app.post('/api/logout', (q, r) => {
  const s = sessOf(q); if (s) { delete db.sessions[s.k]; save(); }
  r.setHeader('Set-Cookie', cookieStr(q, '', 0)); r.json({ ok: 1 });
});

// ---------- shared workspaces: the same bot (same token) added by several accounts = ONE bot object used by all of them ----------
const allBots = () => Object.values(db.users).flatMap(u => u.bots || []);
const findBot = botId => allBots().find(b => b.botId === botId);
const accounts = b => Object.entries(db.users).filter(([, u]) => (u.bots || []).includes(b)).map(([n]) => n);
const sum = b => ({ id: b.id, botId: b.botId, name: b.name, avatar: b.avatar, banner: b.banner || '', accounts: accounts(b).length, ...bot.status(b.id) });
// revision counters: if two accounts edit at the same time, the second save is refused instead of silently overwriting the first
const revOf = (b, k) => b['rev' + k] || 0;
const checkRev = (q, b, k) => {
  if (q.body.rev === undefined || q.body.rev === null) return;
  if (Number(q.body.rev) !== revOf(b, k)) throw new Error('Another account changed this ' + (k === 'E' ? 'events list' : 'commands list') + ' while you were editing. Your changes were NOT saved. Export what you changed (⬇ Export), reload the page and apply it again.');
};
const full = b => ({ ...sum(b), revC: revOf(b, 'C'), revE: revOf(b, 'E'), settings: { ...b.settings, token: '' }, commands: b.commands, events: b.events || [], modules: b.modules, databases: Object.keys(b.dbs || {}) });
const get = q => { const b = q.user.bots.find(x => x.id === q.params.id); if (!b) throw new Error('Bot not found'); return b; };

// ---------- account: profile picture, display name, bio, theme and custom CSS (stored in user.json -> profile) ----------
// custom CSS: escapes are decoded first (so \75rl( cannot hide a url(), then no tags, no @import, no external url() (tracking / data leaks), no script hooks
const cssClean = c => String(c)
  .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (m, h) => { const n = parseInt(h, 16); return n > 31 && n < 0x110000 ? String.fromCodePoint(n) : ''; })
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/[<\u0000]/g, '')
  .replace(/@(import|charset|namespace)[^;]*;?/gi, '')
  .replace(/url\(\s*(?!['"]?data:image\/(?:png|jpeg|gif|webp);base64,)[^)]*\)?/gi, 'none')
  .replace(/expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:/gi, '');
const PROFILE_DEF = { displayName: '', bio: '', avatar: '', theme: 'system', customCss: '', cssOn: true };
const prof = u => ({ ...PROFILE_DEF, ...(u.profile || {}) });
app.get('/api/me', auth, (q, r) => r.json({ user: q.uname, profile: prof(q.user), bots: q.user.bots.map(sum) }));
app.post('/api/account/profile', auth, wrap(q => {
  const b = q.body || {}, p = prof(q.user);
  if (b.displayName !== undefined) p.displayName = String(b.displayName).trim().slice(0, 32);
  if (b.bio !== undefined) p.bio = String(b.bio).slice(0, 200);
  if (b.theme !== undefined) { if (!['system', 'dark', 'light'].includes(b.theme)) throw new Error('Invalid theme'); p.theme = b.theme; }
  if (b.customCss !== undefined) {
    const c = String(b.customCss);
    if (c.length > 30000) throw new Error('Custom CSS is too long (max 30000 characters)');
    p.customCss = cssClean(c);
  }
  if (b.cssOn !== undefined) p.cssOn = !!b.cssOn;
  if (b.removeAvatar) p.avatar = '';
  if (b.avatar) {
    const a = String(b.avatar);
    if (a.length > 700000 || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+\/=]+$/.test(a)) throw new Error('Invalid or too large image (max ~500 KB)');
    p.avatar = a;
  }
  q.user.profile = p; save(); return p;
}));
app.post('/api/account/password', auth, wrap(async q => {
  limit('pw:' + q.uname, 10, 600000);
  const cur = String(q.body.current || '').slice(0, 128), nw = String(q.body.password || '');
  if (!eq(await hash(cur, q.user.salt), q.user.hash)) throw new Error('Current password is wrong');
  if (nw.length > 128) throw new Error('Password: at most 128 characters');
  strong(nw, q.uname);
  q.user.salt = newSalt(); q.user.hash = await hash(nw, q.user.salt);
  const mine = sessOf(q)?.k;
  for (const [k, v] of Object.entries(db.sessions)) if (v.u === q.uname && k !== mine) delete db.sessions[k];   // other devices are signed out
  save(); return { ok: 1 };
}));
app.post('/api/bots', auth, wrap(async q => {
  const token = String(q.body.token || '').trim();
  if (!TOKEN_RE.test(token)) throw new Error('Invalid token');
  limit('tok:' + q.uname, 20, 600000);
  if (q.user.bots.length >= 25) throw new Error('Limit of 25 bots per account');
  const i = await bot.info(token);
  if (q.user.bots.some(b => b.botId === i.id)) throw new Error('That bot was already added');
  const shared = findBot(i.id);
  if (shared) {                                   // someone already added this bot: join its workspace (commands, events, databases...)
    if (token !== shared.settings.token) shared.settings.token = token;   // the token was just verified with Discord, so it is the valid one
    Object.assign(shared, { name: i.name, avatar: i.avatar, banner: i.banner });
    q.user.bots.push(shared); save();
    return { ...sum(shared), joined: true };
  }
  const b = { id: uid(), botId: i.id, name: i.name, avatar: i.avatar, banner: i.banner, commands: [], events: [], modules: MOD_DEF(), warnings: {}, reacts: {}, dbs: fixDbs(),
    settings: { token, status: 'online', activityType: 4, activityText: NEWT, guildId: '', autoStart: false, intents: { members: false, presence: false, message: false } } };
  q.user.bots.push(b); save(); return sum(b);
}));
app.get('/api/bots/:id', auth, wrap(q => full(get(q))));
app.post('/api/bots/:id/settings', auth, wrap(async q => {
  const b = get(q), s = q.body && typeof q.body === 'object' ? q.body : {}, old = b.settings, before = JSON.stringify(old.intents || {});
  if (s.token !== undefined && s.token !== '') {
    const tk = String(s.token).trim();
    if (!TOKEN_RE.test(tk)) throw new Error('Invalid token');
    if (tk !== old.token) {
      limit('tok:' + q.uname, 20, 600000);
      const i = await bot.info(tk);
      // a shared workspace must never be turned into a different bot by one of its members
      if (b.botId && i.id !== b.botId) throw new Error('That token belongs to a different bot. Add that bot as a new bot instead.');
      Object.assign(b, { name: i.name, avatar: i.avatar }); await bot.stop(b.id); old.token = tk;
    }
  }
  const I = s.intents && typeof s.intents === 'object' ? s.intents : old.intents || {};
  b.settings = { ...old,                       // only these fields can be changed from the dashboard (token / lastGuild stay as they are)
    status: ['online', 'idle', 'dnd', 'invisible'].includes(s.status) ? s.status : old.status || 'online',
    activityType: s.activityType !== undefined && [0, 1, 2, 3, 4, 5].includes(Number(s.activityType)) ? Number(s.activityType) : old.activityType ?? 4,
    activityText: s.activityText === undefined ? old.activityText || '' : String(s.activityText).slice(0, 128),
    guildId: String(s.guildId ?? old.guildId ?? '').replace(/\D/g, '').slice(0, 25),     // only the digits of the server ID (no spaces, #, <>)
    autoStart: s.autoStart === undefined ? !!old.autoStart : !!s.autoStart,
    intents: { members: !!I.members, presence: !!I.presence, message: !!I.message } };
  save();
  if (before !== JSON.stringify(b.settings.intents) && bot.status(b.id).running) await bot.start(b); else await bot.refresh(b);
  return full(b);
}));
app.get('/api/bots/:id/about', auth, wrap(async q => {
  const b = get(q), t = b.settings.token, i = await bot.info(t);
  Object.assign(b, { name: i.name, avatar: i.avatar, banner: i.banner }); save();
  return { description: await bot.about(t), banner: i.banner, avatar: i.avatar };
}));
app.post('/api/bots/:id/profile', auth, wrap(async q => {
  const b = get(q), p = q.body;
  const img = (v, rm) => { if (rm) return null; if (!v) return undefined; if (!/^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/.test(v)) throw new Error('Invalid image'); return v; };
  await bot.profile(b.settings.token, {
    name: String(p.name || '').trim().slice(0, 32),
    avatar: img(p.avatar, p.removeAvatar), banner: img(p.banner, p.removeBanner),
    description: p.description == null ? undefined : String(p.description).slice(0, 400)
  });
  const i = await bot.info(b.settings.token); Object.assign(b, { botId: i.id, name: i.name, avatar: i.avatar, banner: i.banner });
  save(); return full(b);
}));
app.post('/api/bots/:id/commands', auth, wrap(async q => {
  const b = get(q); checkRev(q, b, 'C');
  b.commands = fixIds((q.body.commands || []).map(conv).map(c => acc({ ...c, name: String(c.name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) })).filter(c => c.name));
  b.revC = revOf(b, 'C') + 1;
  save(); await bot.refresh(b); return full(b);
}));
app.post('/api/bots/:id/events', auth, wrap(async q => {
  const b = get(q), s = v => String(v || '').slice(0, 200); checkRev(q, b, 'E');
  b.events = fixIds((q.body.events || []).map(conv).filter(e => EVENTS.includes(e.event)).map(e => ({ ...e,
    name: s(e.name).slice(0, 60) || 'Event', enabled: e.enabled !== false, ignoreBots: e.ignoreBots !== false,
    channel: s(e.channel), onlyChannel: s(e.onlyChannel), onlyRole: s(e.onlyRole), emoji: s(e.emoji), contains: String(e.contains || '').slice(0, 1000), database: dbn(e.database) })));
  b.revE = revOf(b, 'E') + 1;
  save(); return full(b);
}));
app.post('/api/bots/:id/modules', auth, wrap(async q => {
  const b = get(q);
  b.modules = deep(MOD_DEF(), q.body.modules);
  save(); await bot.refresh(b); return full(b);
}));
// force a new registration of the slash commands (even if nothing changed)
app.post('/api/bots/:id/resync', auth, wrap(async q => {
  const b = get(q);
  if (!bot.status(b.id).running) throw new Error('Inicie o bot primeiro.');
  await bot.refresh(b, true);
  return full(b);
}));
// ---------- databases (each bot can have several; values are string / number / boolean / list / json) ----------
const SCOPE = /^(g|s:\d{15,25}|u:\d{15,25}|m:\d{15,25}:\d{15,25})$/;
const dbList = b => Object.values(b.dbs).map(t => ({ name: t.name, count: Object.keys(t.entries).length })).sort((a, c) => a.name === 'default' ? -1 : c.name === 'default' ? 1 : a.name.localeCompare(c.name));
const tbl = q => { const d = get(q).dbs, n = dbn(q.params.name); if (!n || !own(d, n)) throw new Error('Database not found'); return d[n]; };
app.get('/api/bots/:id/databases', auth, wrap(q => dbList(get(q))));
app.post('/api/bots/:id/databases', auth, wrap(q => {
  const b = get(q), n = dbn(q.body.name);
  if (!n) throw new Error('Database name: 1-32 characters, a-z, 0-9, _ or -');
  if (own(b.dbs, n)) throw new Error('That database already exists');
  if (Object.keys(b.dbs).length >= 20) throw new Error('Limit of 20 databases reached');
  b.dbs[n] = { name: n, entries: {} }; save(); return dbList(b);
}));
app.delete('/api/bots/:id/databases/:name', auth, wrap(q => {
  const b = get(q), t = tbl(q);
  if (t.name === 'default') throw new Error('The default database cannot be deleted (use Clear instead)');
  delete b.dbs[t.name]; save(); return dbList(b);
}));
app.get('/api/bots/:id/databases/:name', auth, wrap(q => {
  const t = tbl(q);
  return { name: t.name, entries: Object.entries(t.entries).map(([key, e]) => ({ key, ...e })) };
}));
app.post('/api/bots/:id/databases/:name/entries', auth, wrap(q => {
  const t = tbl(q), name = String(q.body.name || '').trim().slice(0, 64), scope = String(q.body.scope || 'g').trim();
  if (!name) throw new Error('Set a key name');
  if (!SCOPE.test(scope)) throw new Error('Invalid scope (server and user IDs must be Discord IDs)');
  const { type, value } = storage.coerce(q.body.type, q.body.value), k = `${scope}|${name}`;
  if (!(k in t.entries) && Object.keys(t.entries).length >= 5000) throw new Error('Saved data limit reached (5000 values)');
  t.entries[k] = { name, scope, type, value, at: Date.now() };
  save(); return { ok: 1 };
}));
app.post('/api/bots/:id/databases/:name/entries/delete', auth, wrap(q => { const t = tbl(q); delete t.entries[String(q.body.key)]; save(); return { ok: 1 }; }));
app.post('/api/bots/:id/databases/:name/clear', auth, wrap(q => { tbl(q).entries = {}; save(); return { ok: 1 }; }));
app.post('/api/bots/:id/start', auth, wrap(async q => { const b = get(q); await bot.start(b); return full(b); }));
app.post('/api/bots/:id/stop', auth, wrap(async q => { const b = get(q); await bot.stop(b.id); return full(b); }));
app.delete('/api/bots/:id', auth, wrap(async q => {
  const b = get(q), others = accounts(b).filter(n => n !== q.uname);
  q.user.bots = q.user.bots.filter(x => x !== b);
  if (others.length) { if (b.owner === q.uname) b.owner = others[0]; }   // the workspace stays with the other accounts, the bot keeps running
  else await bot.stop(b.id);
  save(); return { ok: 1, shared: others.length > 0 };
}));

// anything else: API -> JSON 404, pages -> back to the start
app.use((q, r) => q.path.startsWith('/api/') ? r.status(404).json({ error: 'Not found' }) : r.redirect('/'));
// body-parser errors (too big, broken JSON) must not leak details
app.use((e, q, r, n) => {
  if (r.headersSent) return n(e);
  const big = e && e.type === 'entity.too.large';
  r.status(big ? 413 : 400).json({ error: big ? 'Request too large' : 'Bad request' });
});

bot.setSaver(save);
// a stray error inside a Discord event must never take the whole dashboard down
process.on('unhandledRejection', e => console.error('[unhandled rejection]', e?.message || e));
process.on('uncaughtException', e => console.error('[uncaught exception]', e?.stack || e));
const port = process.env.PORT || 17751, host = process.env.HOST || '0.0.0.0';      // only this computer; set HOST=0.0.0.0 (behind HTTPS!) to open it to the network
const srv = app.listen(port, host, () => {
  console.log(`OpenBot is running at → http://${host}:${port}`);
  const started = new Set();
  for (const b of allBots()) if (b.settings.token && b.settings.autoStart && !started.has(b.id) && started.add(b.id)) bot.start(b).catch(e => console.log(b.name, 'failed to start:', e.message));
  const seenBot = new Map();                      // old separate copies of the same bot (before sharing existed): warn, never merge automatically
  for (const [n, u] of Object.entries(db.users)) for (const b of u.bots || []) {
    if (seenBot.has(b.botId) && seenBot.get(b.botId) !== b) console.warn(`⚠️ "${b.name}" exists as a separate copy in the account "${n}". Export its commands, remove it and add the token again to join the shared workspace.`);
    else seenBot.set(b.botId, b);
  }
});
srv.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use (is another copy still running?)` : e.message); process.exit(1); });
srv.requestTimeout = 90000; srv.headersTimeout = 20000;
// save everything when the program is closed (Ctrl+C / stop), so the last changes are never lost
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(); process.exit(0); });