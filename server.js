'use strict';
// StarChat — сервер без внешних зависимостей (нужен только Node.js 22.13+)
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'data.db'));

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE COLLATE NOCASE NOT NULL,
  name TEXT NOT NULL,
  pass TEXT NOT NULL,
  salt TEXT NOT NULL,
  stars INTEGER NOT NULL DEFAULT 100,
  banned INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY,
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  stars INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(from_id, to_id);
CREATE INDEX IF NOT EXISTS idx_msg_to ON messages(to_id);
`);

// ---------- helpers ----------
const now = () => Date.now();
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };

function createUser({ username, name, password, is_admin = 0, is_system = 0, stars = 100 }) {
  const salt = crypto.randomBytes(16).toString('hex');
  const r = db.prepare(
    'INSERT INTO users(username,name,pass,salt,stars,is_admin,is_system,created) VALUES(?,?,?,?,?,?,?,?)'
  ).run(username, name, hash(password, salt), salt, stars, is_admin, is_system, now());
  return Number(r.lastInsertRowid);
}
const getUser = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);

let SYSTEM_ID = db.prepare('SELECT id FROM users WHERE is_system=1').get()?.id;
if (!SYSTEM_ID) SYSTEM_ID = createUser({ username: 'starchat', name: 'StarChat', password: crypto.randomBytes(24).toString('hex'), is_system: 1, stars: 0 });

if (!db.prepare('SELECT id FROM users WHERE is_admin=1').get()) {
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  createUser({ username: 'admin', name: 'Администратор', password: pw, is_admin: 1, stars: 1000000 });
  console.log('==========================================');
  console.log(' Создан админ:  логин  admin');
  console.log(`                пароль ${pw}`);
  console.log(' (свой пароль: переменная ADMIN_PASSWORD)');
  console.log('==========================================');
}

const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, is_admin: !!u.is_admin, is_system: !!u.is_system });
const selfUser = (u) => ({ ...publicUser(u), stars: u.stars });

// ---------- rate limit ----------
const hits = new Map();
function limited(key, max, windowMs) {
  const t = now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  arr.push(t);
  hits.set(key, arr);
  return arr.length > max;
}
setInterval(() => hits.clear(), 10 * 60 * 1000).unref();

// ---------- realtime (SSE) ----------
const streams = new Map(); // userId -> Set<res>
function push(userId, payload) {
  const set = streams.get(userId);
  if (!set) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) res.write(data);
}
setInterval(() => { for (const set of streams.values()) for (const res of set) res.write(': ping\n\n'); }, 25000).unref();

// ---------- request plumbing ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 20000) { reject(new HttpError(413, 'Слишком большой запрос')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(new HttpError(400, 'Некорректный JSON')); } });
    req.on('error', reject);
  });
}
function authUser(token) {
  const row = token && db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(token);
  if (!row) fail(401, 'Нужно войти');
  if (row.banned) fail(403, 'Аккаунт заблокирован');
  db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(now(), row.id);
  return row;
}
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');
const ip = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// ---------- API handlers ----------
const routes = {};
const regexRoutes = [];
const route = (method, p, { admin = false, anon = false } = {}, fn) => {
  const r = { admin, anon, fn };
  if (p instanceof RegExp) regexRoutes.push({ method, re: p, r });
  else routes[method + ' ' + p] = r;
};

route('POST', '/api/register', { anon: true }, ({ req, body }) => {
  if (limited('reg:' + ip(req), 10, 3600000)) fail(429, 'Слишком много попыток');
  const username = clean(body.username, 32);
  const name = clean(body.name, 40) || username;
  const password = String(body.password ?? '');
  if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) fail(400, 'Логин: 3–32 символа, латиница, цифры, _');
  if (password.length < 6) fail(400, 'Пароль минимум 6 символов');
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) fail(409, 'Логин занят');
  const id = createUser({ username, name, password });
  const token = newToken();
  db.prepare('INSERT INTO sessions VALUES(?,?)').run(token, id);
  return { token, user: selfUser(getUser(id)) };
});

route('POST', '/api/login', { anon: true }, ({ req, body }) => {
  if (limited('login:' + ip(req), 20, 600000)) fail(429, 'Слишком много попыток, подожди');
  const u = db.prepare('SELECT * FROM users WHERE username=? AND is_system=0').get(clean(body.username, 32));
  const pw = String(body.password ?? '');
  const ok = u && crypto.timingSafeEqual(Buffer.from(hash(pw, u.salt), 'hex'), Buffer.from(u.pass, 'hex'));
  if (!ok) fail(401, 'Неверный логин или пароль');
  if (u.banned) fail(403, 'Аккаунт заблокирован');
  const token = newToken();
  db.prepare('INSERT INTO sessions VALUES(?,?)').run(token, u.id);
  return { token, user: selfUser(u) };
});

route('POST', '/api/logout', {}, ({ req }) => { db.prepare('DELETE FROM sessions WHERE token=?').run(bearer(req)); return { ok: true }; });
route('GET', '/api/me', {}, ({ user }) => selfUser(user));

route('GET', '/api/users', {}, ({ user, query }) => {
  const q = clean(query.get('q'), 32).replace(/[%_]/g, '');
  if (!q) return [];
  return db.prepare('SELECT * FROM users WHERE is_system=0 AND banned=0 AND id!=? AND (username LIKE ? OR name LIKE ?) LIMIT 20')
    .all(user.id, q + '%', '%' + q + '%').map(publicUser);
});

route('GET', '/api/chats', {}, ({ user }) => {
  const me = user.id;
  const rows = db.prepare(`
    SELECT m.*, CASE WHEN m.from_id=@me THEN m.to_id ELSE m.from_id END AS peer_id
    FROM messages m
    WHERE m.id IN (
      SELECT MAX(id) FROM messages WHERE from_id=@me OR to_id=@me
      GROUP BY CASE WHEN from_id=@me THEN to_id ELSE from_id END
    ) ORDER BY m.id DESC`).all({ me });
  return rows.map((m) => ({ peer: publicUser(getUser(m.peer_id)), last: { id: m.id, text: m.text, stars: m.stars, ts: m.ts, mine: m.from_id === me } }));
});

route('GET', /^\/api\/messages\/(\d+)$/, {}, ({ user, query, params }) => {
  const peer = getUser(Number(params[0]));
  if (!peer) fail(404, 'Нет такого пользователя');
  const after = Number(query.get('after')) || 0;
  const rows = db.prepare('SELECT * FROM messages WHERE id>? AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?)) ORDER BY id DESC LIMIT 200')
    .all(after, user.id, peer.id, peer.id, user.id).reverse();
  return { peer: publicUser(peer), messages: rows.map((m) => ({ id: m.id, text: m.text, stars: m.stars, ts: m.ts, mine: m.from_id === user.id })) };
});

route('POST', '/api/messages', {}, ({ user, body }) => {
  if (limited('msg:' + user.id, 40, 60000)) fail(429, 'Не так быстро');
  const text = clean(body.text, 4000);
  const stars = Math.max(0, Math.floor(Number(body.stars) || 0));
  const peer = getUser(Number(body.to));
  if (!peer || peer.banned) fail(404, 'Получатель недоступен');
  if (peer.is_system) fail(400, 'Системному аккаунту писать нельзя');
  if (peer.id === user.id) fail(400, 'Нельзя писать самому себе');
  if (!text && !stars) fail(400, 'Пустое сообщение');

  let msg;
  db.exec('BEGIN IMMEDIATE');
  try {
    const me = getUser(user.id);
    if (stars) {
      if (!me.is_admin) { // у админа звёзды бесконечные: дарит, не списывая
        if (me.stars < stars) fail(400, 'Не хватает звёзд');
        db.prepare('UPDATE users SET stars=stars-? WHERE id=?').run(stars, me.id);
      }
      db.prepare('UPDATE users SET stars=stars+? WHERE id=?').run(stars, peer.id);
    }
    const ts = now();
    const r = db.prepare('INSERT INTO messages(from_id,to_id,text,stars,ts) VALUES(?,?,?,?,?)').run(me.id, peer.id, text, stars, ts);
    msg = { id: Number(r.lastInsertRowid), text, stars, ts };
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  push(peer.id, { type: 'message', from: publicUser(user), msg: { ...msg, mine: false }, stars: getUser(peer.id).stars });
  const myStars = getUser(user.id).stars;
  push(user.id, { type: 'balance', stars: myStars });
  return { msg: { ...msg, mine: true }, stars: myStars };
});

// ----- admin -----
route('GET', '/api/admin/stats', { admin: true }, () => {
  const c = (sql, ...a) => db.prepare(sql).get(...a).n;
  return {
    users: c('SELECT COUNT(*) n FROM users WHERE is_system=0'),
    banned: c('SELECT COUNT(*) n FROM users WHERE banned=1'),
    messages: c('SELECT COUNT(*) n FROM messages WHERE from_id!=?', SYSTEM_ID),
    stars_total: c('SELECT COALESCE(SUM(stars),0) n FROM users WHERE is_system=0 AND is_admin=0'),
    online: [...streams.values()].filter((s) => s.size).length,
    active_24h: c('SELECT COUNT(*) n FROM users WHERE last_seen>?', now() - 86400000),
  };
});

route('GET', '/api/admin/users', { admin: true }, ({ query }) => {
  const q = clean(query.get('q'), 32).replace(/[%_]/g, '');
  return db.prepare('SELECT * FROM users WHERE is_system=0 AND (username LIKE ? OR name LIKE ?) ORDER BY id DESC LIMIT 200')
    .all('%' + q + '%', '%' + q + '%')
    .map((u) => ({ ...selfUser(u), banned: !!u.banned, created: u.created, last_seen: u.last_seen, online: !!streams.get(u.id)?.size }));
});

route('POST', '/api/admin/ban', { admin: true }, ({ body }) => {
  const u = getUser(Number(body.id));
  if (!u || u.is_system) fail(404, 'Нет такого пользователя');
  if (u.is_admin) fail(400, 'Админа банить нельзя');
  const banned = body.banned ? 1 : 0;
  db.prepare('UPDATE users SET banned=? WHERE id=?').run(banned, u.id);
  if (banned) {
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    push(u.id, { type: 'banned' });
    for (const res of streams.get(u.id) || []) res.end();
  }
  return { ok: true };
});

route('POST', '/api/admin/stars', { admin: true }, ({ body }) => {
  const u = getUser(Number(body.id));
  if (!u || u.is_system) fail(404, 'Нет такого пользователя');
  const amount = Math.trunc(Number(body.amount));
  if (!Number.isFinite(amount)) fail(400, 'Некорректная сумма');
  const stars = body.set ? Math.max(0, amount) : Math.max(0, u.stars + amount);
  db.prepare('UPDATE users SET stars=? WHERE id=?').run(stars, u.id);
  push(u.id, { type: 'balance', stars });
  return { ok: true, stars };
});

route('POST', '/api/admin/broadcast', { admin: true }, ({ body }) => {
  const text = clean(body.text, 4000);
  if (!text) fail(400, 'Пустой текст');
  const users = db.prepare('SELECT * FROM users WHERE is_system=0 AND banned=0').all();
  const ins = db.prepare('INSERT INTO messages(from_id,to_id,text,stars,ts) VALUES(?,?,?,?,?)');
  const ts = now(); const sent = [];
  db.exec('BEGIN');
  try { for (const u of users) sent.push([u, Number(ins.run(SYSTEM_ID, u.id, text, 0, ts).lastInsertRowid)]); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  const sys = publicUser(getUser(SYSTEM_ID));
  for (const [u, id] of sent) push(u.id, { type: 'message', from: sys, msg: { id, text, stars: 0, ts, mine: false }, stars: u.stars });
  return { ok: true, sent: users.length };
});

// ---------- static (всё лежит в одной папке с server.js) ----------
const ASSETS = {
  '/manifest.json': { type: 'application/json', body: '{\n  "name": "StarChat",\n  "short_name": "StarChat",\n  "description": "Мессенджер со звёздами",\n  "start_url": "/",\n  "scope": "/",\n  "display": "standalone",\n  "background_color": "#0e1621",\n  "theme_color": "#17212b",\n  "icons": [\n    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },\n    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },\n    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }\n  ]\n}' },
  '/sw.js': { type: 'text/javascript', body: "// Минимальный service worker: нужен, чтобы браузер предложил «Установить приложение».\n// Кэшируем только оболочку; API и события всегда идут в сеть.\nconst CACHE = 'starchat-shell-v1';\nconst SHELL = ['/', '/index.html', '/manifest.json', '/icon-192.png'];\nself.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });\nself.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });\nself.addEventListener('fetch', (e) => {\n  const u = new URL(e.request.url);\n  if (e.request.method !== 'GET' || u.pathname.startsWith('/api/')) return;\n  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));\n});\n" },
  '/icon-192.png': { type: 'image/png', body: Buffer.from('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', 'base64') },
  '/icon-512.png': { type: 'image/png', body: Buffer.from('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', 'base64') },
};
const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/admin.html': 'admin.html' };
function serveStatic(req, res, pathname) {
  const a = ASSETS[pathname];
  if (a) { res.writeHead(200, { 'Content-Type': a.type, 'Cache-Control': 'no-cache' }); return res.end(a.body); }
  const f = PAGES[pathname];
  if (!f) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  fs.createReadStream(path.join(__dirname, f)).pipe(res);
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  try {
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

    if (pathname === '/api/events' && req.method === 'GET') { // SSE
      const user = authUser(url.searchParams.get('token'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      if (!streams.has(user.id)) streams.set(user.id, new Set());
      streams.get(user.id).add(res);
      req.on('close', () => streams.get(user.id)?.delete(res));
      return;
    }

    let r = routes[req.method + ' ' + pathname], params = [];
    if (!r) for (const rt of regexRoutes) { const m = req.method === rt.method && pathname.match(rt.re); if (m) { r = rt.r; params = m.slice(1); break; } }
    if (!r) fail(404, 'Не найдено');

    const body = req.method === 'POST' ? await readBody(req) : {};
    let user = null;
    if (!r.anon) { user = authUser(bearer(req)); if (r.admin && !user.is_admin) fail(403, 'Только для админа'); }
    send(res, 200, await r.fn({ req, user, body, query: url.searchParams, params }));
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Ошибка сервера' });
  }
});

server.listen(PORT, () => console.log(`StarChat запущен: http://localhost:${PORT}   админка: http://localhost:${PORT}/admin.html`));
