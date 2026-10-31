'use strict';
// StarChat 2 — сервер без внешних зависимостей (нужен только Node.js 22.13+)
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const APP_NAME = process.env.APP_NAME || 'StarChat';
const ACCENT = /^#[0-9a-fA-F]{6}$/.test(process.env.ACCENT || '') ? process.env.ACCENT : '#7c5cff';

// восстановление из бэкапа: файл .restore подменяет базу при старте
if (fs.existsSync(DB_PATH + '.restore')) {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB_PATH + ext); } catch {} }
  fs.renameSync(DB_PATH + '.restore', DB_PATH);
  console.log('База восстановлена из бэкапа');
}
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
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
  last_seen INTEGER,
  avatar INTEGER,
  bio TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS media(id INTEGER PRIMARY KEY, owner INTEGER NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chats(
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  handle TEXT UNIQUE COLLATE NOCASE,
  about TEXT NOT NULL DEFAULT '',
  avatar INTEGER,
  owner INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  direct_key TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS members(
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  last_read INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);
CREATE TABLE IF NOT EXISTS msgs(
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  from_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  stars INTEGER NOT NULL DEFAULT 0,
  media_id INTEGER,
  dur INTEGER NOT NULL DEFAULT 0,
  gift TEXT,
  reply_to INTEGER,
  ts INTEGER NOT NULL,
  edited INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msgs_chat ON msgs(chat_id, id);
CREATE TABLE IF NOT EXISTS user_gifts(
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  msg_id INTEGER,
  note TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  converted INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_gifts_to ON user_gifts(to_id);
`);

// ---------- helpers ----------
const now = () => Date.now();
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');
const clean = (s, max) => String(s ?? '').trim().slice(0, max);
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };
const getUser = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const getChat = (id) => db.prepare('SELECT * FROM chats WHERE id=?').get(id);

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

function createUser({ username, name, password, is_admin = 0, is_system = 0, stars = 100 }) {
  const salt = crypto.randomBytes(16).toString('hex');
  const r = db.prepare(
    'INSERT INTO users(username,name,pass,salt,stars,is_admin,is_system,created) VALUES(?,?,?,?,?,?,?,?)'
  ).run(username, name, hash(password, salt), salt, stars, is_admin, is_system, now());
  return Number(r.lastInsertRowid);
}

function directChat(a, b) {
  const key = [a, b].sort((x, y) => x - y).join('-');
  const c = db.prepare('SELECT * FROM chats WHERE direct_key=?').get(key);
  if (c) return c;
  const id = Number(db.prepare("INSERT INTO chats(type,created,direct_key) VALUES('direct',?,?)").run(now(), key).lastInsertRowid);
  const ins = db.prepare("INSERT INTO members(chat_id,user_id,role) VALUES(?,?,'member')");
  ins.run(id, a); if (b !== a) ins.run(id, b);
  return getChat(id);
}

// ---------- миграция со старой версии (таблица messages) ----------
(function migrate() {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('avatar')) db.exec('ALTER TABLE users ADD COLUMN avatar INTEGER');
  if (!cols.includes('bio')) db.exec("ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''");
  const done = db.prepare("SELECT v FROM meta WHERE k='migrated_v1'").get();
  const hasOld = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get();
  if (!done && hasOld) {
    tx(() => {
      const pairs = db.prepare('SELECT DISTINCT MIN(from_id,to_id) a, MAX(from_id,to_id) b FROM messages').all();
      for (const p of pairs) {
        const chat = directChat(p.a, p.b);
        const rows = db.prepare('SELECT * FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY id').all(p.a, p.b, p.b, p.a);
        let last = 0;
        for (const m of rows) {
          last = Number(db.prepare('INSERT INTO msgs(chat_id,from_id,kind,text,stars,ts) VALUES(?,?,?,?,?,?)')
            .run(chat.id, m.from_id, m.stars > 0 ? 'stars' : 'text', m.text, m.stars, m.ts).lastInsertRowid);
        }
        db.prepare('UPDATE members SET last_read=? WHERE chat_id=?').run(last, chat.id);
      }
      console.log('Перенесены переписки из старой версии:', pairs.length);
    });
  }
  db.prepare("INSERT OR REPLACE INTO meta VALUES('migrated_v1','1')").run();
})();

let SYSTEM_ID = db.prepare('SELECT id FROM users WHERE is_system=1').get()?.id;
if (!SYSTEM_ID) SYSTEM_ID = createUser({ username: 'starchat', name: APP_NAME, password: crypto.randomBytes(24).toString('hex'), is_system: 1, stars: 0 });

if (!db.prepare('SELECT id FROM users WHERE is_admin=1').get()) {
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  createUser({ username: 'admin', name: 'Администратор', password: pw, is_admin: 1, stars: 1000000 });
  console.log('==========================================');
  console.log(' Создан админ:  логин  admin');
  console.log(`                пароль ${pw}`);
  console.log(' (свой пароль: переменная ADMIN_PASSWORD)');
  console.log('==========================================');
}

// ---------- подарки ----------
const GIFTS = {
  teddy: { emoji: '🧸', name: 'Мишка', price: 15 },
  rose: { emoji: '🌹', name: 'Роза', price: 25 },
  cake: { emoji: '🎂', name: 'Торт', price: 50 },
  gem: { emoji: '💎', name: 'Алмаз', price: 100 },
  trophy: { emoji: '🏆', name: 'Кубок', price: 250 },
  rocket: { emoji: '🚀', name: 'Ракета', price: 500 },
  crown: { emoji: '👑', name: 'Корона', price: 1000 },
  comet: { emoji: '☄️', name: 'Комета', price: 2500, supply: 100 },
  galaxy: { emoji: '🌌', name: 'Галактика', price: 10000, supply: 25 },
};
const CONVERT_RATE = 0.8;
const soldCount = (code) => db.prepare('SELECT COUNT(*) n FROM user_gifts WHERE code=?').get(code).n;

// ---------- сериализация ----------
const online = (id) => !!streams.get(id)?.size;
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, avatar: u.avatar || null, is_admin: !!u.is_admin, is_system: !!u.is_system });
const selfUser = (u) => ({ ...publicUser(u), stars: u.stars, bio: u.bio });

function previewText(m) {
  if (m.deleted) return 'Сообщение удалено';
  if (m.kind === 'image') return '🖼 ' + (m.text || 'Фото');
  if (m.kind === 'voice') return '🎤 Голосовое';
  if (m.kind === 'gift') return '🎁 ' + (GIFTS[m.gift]?.name || 'Подарок');
  if (m.kind === 'stars') return '⭐ ' + m.stars + (m.text ? ' · ' + m.text : '');
  return m.text.slice(0, 120);
}

function ser(m, meId) {
  const u = getUser(m.from_id);
  let reply = null;
  if (m.reply_to) {
    const r = db.prepare('SELECT m.*, u.name AS uname FROM msgs m JOIN users u ON u.id=m.from_id WHERE m.id=?').get(m.reply_to);
    if (r) reply = { id: r.id, name: r.uname, text: previewText(r) };
  }
  const g = m.gift ? GIFTS[m.gift] : null;
  return {
    id: m.id, chat_id: m.chat_id, from: { id: u.id, name: u.name, avatar: u.avatar || null },
    kind: m.deleted ? 'deleted' : m.kind, text: m.deleted ? '' : m.text, stars: m.deleted ? 0 : m.stars,
    media: m.deleted ? null : m.media_id, dur: m.dur, gift: g && !m.deleted ? { code: m.gift, emoji: g.emoji, name: g.name } : null,
    reply, ts: m.ts, edited: !!m.edited, mine: m.from_id === meId,
  };
}

const memberRow = (chatId, userId) => db.prepare('SELECT * FROM members WHERE chat_id=? AND user_id=?').get(chatId, userId);
function peerOf(chat, meId) {
  const row = db.prepare('SELECT user_id FROM members WHERE chat_id=? AND user_id!=?').get(chat.id, meId);
  return row ? getUser(row.user_id) : getUser(meId);
}
function canPost(chat, mem, meId) {
  if (!mem) return false;
  if (chat.type === 'channel') return mem.role === 'owner' || mem.role === 'admin';
  if (chat.type === 'direct') { const p = peerOf(chat, meId); return !p.is_system && !p.banned; }
  return true;
}

function summary(chat, me) {
  const mem = memberRow(chat.id, me.id);
  const last = db.prepare('SELECT * FROM msgs WHERE chat_id=? ORDER BY id DESC LIMIT 1').get(chat.id);
  const unread = db.prepare('SELECT COUNT(*) n FROM msgs WHERE chat_id=? AND id>? AND from_id!=? AND deleted=0').get(chat.id, mem?.last_read || 0, me.id).n;
  const out = {
    id: chat.id, type: chat.type, title: chat.title, handle: chat.handle, about: chat.about, avatar: chat.avatar || null,
    role: mem?.role || null, unread, can_post: canPost(chat, mem, me.id), created: chat.created,
    members: db.prepare('SELECT COUNT(*) n FROM members WHERE chat_id=?').get(chat.id).n,
    last: last ? { id: last.id, text: previewText(last), ts: last.ts, mine: last.from_id === me.id, from_name: getUser(last.from_id).name } : null,
  };
  if (chat.type === 'direct') {
    const p = peerOf(chat, me.id);
    out.title = p.name; out.avatar = p.avatar || null;
    out.peer = { ...publicUser(p), bio: p.bio, online: online(p.id), last_seen: p.last_seen };
    out.peer_read = memberRow(chat.id, p.id)?.last_read || 0;
    out.my_read = mem?.last_read || 0;
  }
  return out;
}

// ---------- rate limit ----------
const hits = new Map();
function limited(key, max, windowMs) {
  const t = now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  arr.push(t); hits.set(key, arr);
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
const memberIds = (chatId) => db.prepare('SELECT user_id FROM members WHERE chat_id=?').all(chatId).map((r) => r.user_id);
function fanoutMessage(chat, m) {
  for (const uid of memberIds(chat.id)) push(uid, { type: 'message', chat_id: chat.id, msg: ser(m, uid) });
}
const pushAll = (chatId, payload, exceptId) => { for (const uid of memberIds(chatId)) if (uid !== exceptId) push(uid, payload); };

// ---------- request plumbing ----------
function send(res, code, obj) {
  if (obj && obj.__raw) {
    res.writeHead(code, { 'Content-Type': obj.__raw.type, 'Cache-Control': obj.__raw.cache || 'no-store', ...(obj.__raw.disposition ? { 'Content-Disposition': obj.__raw.disposition } : {}) });
    return res.end(obj.__raw.body);
  }
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, max, raw) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new HttpError(413, 'Слишком большой запрос')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (raw) return resolve(buf);
      try { resolve(buf.length ? JSON.parse(buf.toString()) : {}); } catch { reject(new HttpError(400, 'Некорректный JSON')); }
    });
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

const routes = {};
const regexRoutes = [];
const route = (method, p, opts, fn) => {
  const r = { admin: !!opts.admin, anon: !!opts.anon, raw: opts.raw || 0, fn };
  if (p instanceof RegExp) regexRoutes.push({ method, re: p, r }); else routes[method + ' ' + p] = r;
};

function needMember(chatId, user) {
  const chat = getChat(Number(chatId));
  if (!chat) fail(404, 'Чат не найден');
  const mem = memberRow(chat.id, user.id);
  if (!mem) fail(403, 'Вы не участник чата');
  return { chat, mem };
}
const isStaff = (mem) => mem && (mem.role === 'owner' || mem.role === 'admin');

// ---------- API: аккаунт ----------
route('GET', '/api/config', { anon: true }, () => ({ name: APP_NAME, accent: ACCENT }));

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

route('POST', '/api/profile', {}, ({ user, body }) => {
  const name = clean(body.name, 40) || user.name;
  const bio = clean(body.bio, 200);
  let avatar = user.avatar;
  if ('avatar' in body) {
    if (body.avatar === null) avatar = null;
    else {
      const m = db.prepare('SELECT id, mime FROM media WHERE id=? AND owner=?').get(Number(body.avatar), user.id);
      if (!m || !m.mime.startsWith('image/')) fail(400, 'Картинка не найдена');
      avatar = m.id;
    }
  }
  db.prepare('UPDATE users SET name=?, bio=?, avatar=? WHERE id=?').run(name, bio, avatar, user.id);
  return selfUser(getUser(user.id));
});

route('GET', /^\/api\/users\/(\d+)$/, {}, ({ user, params }) => {
  const u = getUser(Number(params[0]));
  if (!u || u.banned) fail(404, 'Пользователь не найден');
  const gifts = db.prepare('SELECT g.*, u.name AS from_name FROM user_gifts g JOIN users u ON u.id=g.from_id WHERE g.to_id=? AND g.converted=0 AND g.hidden=0 ORDER BY g.id DESC LIMIT 60').all(u.id)
    .map((g) => ({ id: g.id, code: g.code, emoji: GIFTS[g.code].emoji, name: GIFTS[g.code].name, from_name: g.from_name, ts: g.ts }));
  return { user: { ...publicUser(u), bio: u.bio, online: online(u.id), last_seen: u.last_seen, created: u.created }, gifts };
});

// ---------- API: медиа ----------
route('POST', '/api/media', { raw: 8 * 1024 * 1024 }, ({ req, user, body }) => {
  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!/^(image\/(jpeg|png|webp|gif)|audio\/(webm|ogg|mp4|mpeg|aac|x-m4a|wav))$/.test(mime)) fail(400, 'Неподдерживаемый тип файла');
  if (!body.length) fail(400, 'Пустой файл');
  if (limited('media:' + user.id, 60, 60000)) fail(429, 'Не так быстро');
  const id = Number(db.prepare('INSERT INTO media(owner,mime,data,ts) VALUES(?,?,?,?)').run(user.id, mime, body, now()).lastInsertRowid);
  return { id };
});

route('GET', /^\/api\/media\/(\d+)$/, {}, ({ user, params }) => {
  const id = Number(params[0]);
  const m = db.prepare('SELECT * FROM media WHERE id=?').get(id);
  if (!m) fail(404, 'Файл не найден');
  const allowed = m.owner === user.id ||
    db.prepare('SELECT 1 FROM users WHERE avatar=?').get(id) || db.prepare('SELECT 1 FROM chats WHERE avatar=?').get(id) ||
    db.prepare('SELECT 1 FROM msgs g JOIN chats c ON c.id=g.chat_id WHERE g.media_id=? AND g.deleted=0 AND (c.handle IS NOT NULL OR EXISTS(SELECT 1 FROM members mb WHERE mb.chat_id=g.chat_id AND mb.user_id=?))').get(id, user.id);
  if (!allowed) fail(403, 'Нет доступа');
  return { __raw: { type: m.mime, body: Buffer.from(m.data), cache: 'private, max-age=31536000, immutable' } };
});

// ---------- API: поиск и чаты ----------
route('GET', '/api/search', {}, ({ user, query }) => {
  const q = clean(query.get('q'), 32).replace(/[%_]/g, '');
  if (!q) return { users: [], chats: [] };
  const users = db.prepare("SELECT * FROM users WHERE is_system=0 AND banned=0 AND id!=? AND (username LIKE ? OR name LIKE ?) LIMIT 20")
    .all(user.id, q + '%', '%' + q + '%').map(publicUser);
  const chats = db.prepare("SELECT * FROM chats WHERE handle IS NOT NULL AND type!='direct' AND (handle LIKE ? OR title LIKE ?) LIMIT 20")
    .all(q.replace(/^@/, '') + '%', '%' + q + '%').map((c) => ({ ...summary(c, user), joined: !!memberRow(c.id, user.id) }));
  return { users, chats };
});

route('GET', '/api/chats', {}, ({ user }) => {
  const chats = db.prepare('SELECT c.* FROM chats c JOIN members m ON m.chat_id=c.id WHERE m.user_id=?').all(user.id)
    .map((c) => summary(c, user))
    .filter((s) => s.type !== 'direct' || s.last);
  const key = (s) => s.last ? s.last.ts : s.created;
  return chats.sort((a, b) => key(b) - key(a));
});

route('POST', '/api/chats/direct', {}, ({ user, body }) => {
  const peer = getUser(Number(body.user));
  if (!peer || peer.banned) fail(404, 'Пользователь недоступен');
  return summary(directChat(user.id, peer.id), user);
});

route('POST', '/api/chats/create', {}, ({ user, body }) => {
  const type = body.type === 'channel' ? 'channel' : 'group';
  const title = clean(body.title, 64);
  if (!title) fail(400, 'Введи название');
  let handle = clean(body.handle, 32).replace(/^@/, '') || null;
  if (handle) {
    if (!/^[A-Za-z0-9_]{4,32}$/.test(handle)) fail(400, 'Публичное имя: 4–32 символа, латиница, цифры, _');
    if (db.prepare('SELECT 1 FROM chats WHERE handle=?').get(handle)) fail(409, 'Это публичное имя занято');
  }
  if (limited('mk:' + user.id, 10, 3600000)) fail(429, 'Слишком много чатов подряд');
  const id = tx(() => {
    const cid = Number(db.prepare('INSERT INTO chats(type,title,handle,about,owner,created) VALUES(?,?,?,?,?,?)')
      .run(type, title, handle, clean(body.about, 200), user.id, now()).lastInsertRowid);
    db.prepare("INSERT INTO members(chat_id,user_id,role) VALUES(?,?,'owner')").run(cid, user.id);
    const names = Array.isArray(body.members) ? body.members.slice(0, 100) : [];
    for (const n of names) {
      const u = db.prepare('SELECT id FROM users WHERE username=? AND is_system=0 AND banned=0').get(clean(n, 32).replace(/^@/, ''));
      if (u && u.id !== user.id) db.prepare("INSERT OR IGNORE INTO members(chat_id,user_id,role) VALUES(?,?,'member')").run(cid, u.id);
    }
    return cid;
  });
  const chat = getChat(id);
  for (const uid of memberIds(id)) if (uid !== user.id) push(uid, { type: 'chats' });
  return summary(chat, user);
});

route('GET', /^\/api\/chats\/(\d+)$/, {}, ({ user, params }) => {
  const chat = getChat(Number(params[0]));
  if (!chat) fail(404, 'Чат не найден');
  const mem = memberRow(chat.id, user.id);
  if (!mem && !chat.handle) fail(403, 'Нет доступа');
  const out = summary(chat, user);
  out.joined = !!mem;
  if (mem && (chat.type === 'group' || isStaff(mem))) {
    out.member_list = db.prepare("SELECT m.role, u.* FROM members m JOIN users u ON u.id=m.user_id WHERE m.chat_id=? ORDER BY m.role='owner' DESC, m.role='admin' DESC, u.name LIMIT 300")
      .all(chat.id).map((u) => ({ ...publicUser(u), role: u.role, online: online(u.id) }));
  }
  return out;
});

route('POST', /^\/api\/chats\/(\d+)\/edit$/, {}, ({ user, params, body }) => {
  const { chat, mem } = needMember(params[0], user);
  if (chat.type === 'direct' || !isStaff(mem)) fail(403, 'Нет прав');
  const title = clean(body.title, 64) || chat.title;
  const about = clean(body.about ?? chat.about, 200);
  let avatar = chat.avatar;
  if ('avatar' in body) {
    if (body.avatar === null) avatar = null;
    else { const m = db.prepare('SELECT id, mime FROM media WHERE id=? AND owner=?').get(Number(body.avatar), user.id); if (!m || !m.mime.startsWith('image/')) fail(400, 'Картинка не найдена'); avatar = m.id; }
  }
  db.prepare('UPDATE chats SET title=?, about=?, avatar=? WHERE id=?').run(title, about, avatar, chat.id);
  pushAll(chat.id, { type: 'chats' });
  return summary(getChat(chat.id), user);
});

route('POST', /^\/api\/chats\/(\d+)\/join$/, {}, ({ user, params }) => {
  const chat = getChat(Number(params[0]));
  if (!chat || chat.type === 'direct' || !chat.handle) fail(403, 'Вступить можно только в публичную группу или канал');
  db.prepare("INSERT OR IGNORE INTO members(chat_id,user_id,role,last_read) VALUES(?,?,'member',COALESCE((SELECT MAX(id) FROM msgs WHERE chat_id=?),0))").run(chat.id, user.id, chat.id);
  return summary(chat, user);
});

route('POST', /^\/api\/chats\/(\d+)\/leave$/, {}, ({ user, params }) => {
  const { chat, mem } = needMember(params[0], user);
  if (chat.type === 'direct') fail(400, 'Из личного чата выйти нельзя');
  db.prepare('DELETE FROM members WHERE chat_id=? AND user_id=?').run(chat.id, user.id);
  if (mem.role === 'owner') {
    const next = db.prepare("SELECT user_id FROM members WHERE chat_id=? ORDER BY role='admin' DESC, rowid LIMIT 1").get(chat.id);
    if (next) { db.prepare("UPDATE members SET role='owner' WHERE chat_id=? AND user_id=?").run(chat.id, next.user_id); db.prepare('UPDATE chats SET owner=? WHERE id=?').run(next.user_id, chat.id); }
  }
  pushAll(chat.id, { type: 'chats' });
  return { ok: true };
});

route('POST', /^\/api\/chats\/(\d+)\/add$/, {}, ({ user, params, body }) => {
  const { chat, mem } = needMember(params[0], user);
  if (chat.type === 'direct' || !isStaff(mem)) fail(403, 'Нет прав');
  const u = db.prepare('SELECT id FROM users WHERE username=? AND is_system=0 AND banned=0').get(clean(body.username, 32).replace(/^@/, ''));
  if (!u) fail(404, 'Пользователь не найден');
  db.prepare("INSERT OR IGNORE INTO members(chat_id,user_id,role,last_read) VALUES(?,?,'member',COALESCE((SELECT MAX(id) FROM msgs WHERE chat_id=?),0))").run(chat.id, u.id, chat.id);
  push(u.id, { type: 'chats' });
  pushAll(chat.id, { type: 'chats' }, u.id);
  return { ok: true };
});

route('POST', /^\/api\/chats\/(\d+)\/kick$/, {}, ({ user, params, body }) => {
  const { chat, mem } = needMember(params[0], user);
  if (chat.type === 'direct' || !isStaff(mem)) fail(403, 'Нет прав');
  const target = memberRow(chat.id, Number(body.user));
  if (!target) fail(404, 'Не участник');
  if (target.role === 'owner' || (target.role === 'admin' && mem.role !== 'owner')) fail(403, 'Нельзя удалить этого участника');
  db.prepare('DELETE FROM members WHERE chat_id=? AND user_id=?').run(chat.id, target.user_id);
  push(target.user_id, { type: 'chats' });
  pushAll(chat.id, { type: 'chats' });
  return { ok: true };
});

route('POST', /^\/api\/chats\/(\d+)\/admin$/, {}, ({ user, params, body }) => {
  const { chat, mem } = needMember(params[0], user);
  if (chat.type === 'direct' || mem.role !== 'owner') fail(403, 'Только владелец');
  const target = memberRow(chat.id, Number(body.user));
  if (!target || target.role === 'owner') fail(400, 'Нельзя');
  db.prepare('UPDATE members SET role=? WHERE chat_id=? AND user_id=?').run(body.on ? 'admin' : 'member', chat.id, target.user_id);
  pushAll(chat.id, { type: 'chats' });
  return { ok: true };
});

route('POST', /^\/api\/chats\/(\d+)\/read$/, {}, ({ user, params, body }) => {
  const { chat } = needMember(params[0], user);
  const upto = Math.floor(Number(body.upto)) || 0;
  const real = db.prepare('SELECT COALESCE(MAX(id),0) n FROM msgs WHERE chat_id=? AND id<=?').get(chat.id, upto).n;
  db.prepare('UPDATE members SET last_read=MAX(last_read,?) WHERE chat_id=? AND user_id=?').run(real, chat.id, user.id);
  if (chat.type === 'direct') pushAll(chat.id, { type: 'read', chat_id: chat.id, user_id: user.id, upto: real }, user.id);
  return { ok: true };
});

route('POST', /^\/api\/chats\/(\d+)\/typing$/, {}, ({ user, params }) => {
  const { chat } = needMember(params[0], user);
  if (chat.type !== 'channel' && !limited('typ:' + user.id, 20, 10000)) pushAll(chat.id, { type: 'typing', chat_id: chat.id, user: { id: user.id, name: user.name } }, user.id);
  return { ok: true };
});

// ---------- API: сообщения ----------
route('GET', /^\/api\/chats\/(\d+)\/messages$/, {}, ({ user, params, query }) => {
  const chat = getChat(Number(params[0]));
  if (!chat) fail(404, 'Чат не найден');
  const mem = memberRow(chat.id, user.id);
  if (!mem && !chat.handle) fail(403, 'Нет доступа');
  const after = Number(query.get('after')) || 0;
  const before = Number(query.get('before')) || 0;
  let rows;
  if (after) rows = db.prepare('SELECT * FROM msgs WHERE chat_id=? AND id>? ORDER BY id LIMIT 200').all(chat.id, after);
  else if (before) rows = db.prepare('SELECT * FROM msgs WHERE chat_id=? AND id<? ORDER BY id DESC LIMIT 50').all(chat.id, before).reverse();
  else rows = db.prepare('SELECT * FROM msgs WHERE chat_id=? ORDER BY id DESC LIMIT 50').all(chat.id).reverse();
  return { chat: summary(chat, user), messages: rows.map((m) => ser(m, user.id)), more: rows.length === (after ? 200 : 50) };
});

function checkReply(chat, id) {
  if (!id) return null;
  const r = db.prepare('SELECT id FROM msgs WHERE id=? AND chat_id=?').get(Number(id), chat.id);
  return r ? r.id : null;
}

route('POST', /^\/api\/chats\/(\d+)\/send$/, {}, ({ user, params, body }) => {
  if (limited('msg:' + user.id, 60, 60000)) fail(429, 'Не так быстро');
  const { chat, mem } = needMember(params[0], user);
  if (!canPost(chat, mem, user.id)) fail(403, chat.type === 'channel' ? 'В канале пишут только админы' : 'Писать в этот чат нельзя');
  const kind = ['text', 'image', 'voice', 'stars'].includes(body.kind) ? body.kind : 'text';
  const text = clean(body.text, 4000);
  const reply = checkReply(chat, body.reply_to);
  let media = null, dur = 0, stars = 0;
  if (kind === 'image' || kind === 'voice') {
    const mrow = db.prepare('SELECT id, mime FROM media WHERE id=? AND owner=?').get(Number(body.media), user.id);
    if (!mrow) fail(400, 'Файл не найден');
    if (kind === 'image' && !mrow.mime.startsWith('image/')) fail(400, 'Нужна картинка');
    if (kind === 'voice' && !mrow.mime.startsWith('audio/')) fail(400, 'Нужно аудио');
    media = mrow.id;
    dur = kind === 'voice' ? Math.min(600, Math.max(1, Math.floor(Number(body.dur)) || 1)) : 0;
  } else if (kind === 'stars') {
    if (chat.type !== 'direct') fail(400, 'Звёзды можно дарить только в личном чате');
    stars = Math.floor(Number(body.stars));
    if (!(stars > 0)) fail(400, 'Укажи количество звёзд');
  } else if (!text) fail(400, 'Пустое сообщение');

  const m = tx(() => {
    if (kind === 'stars') {
      const me = getUser(user.id), peer = peerOf(chat, user.id);
      if (peer.id === me.id) fail(400, 'Нельзя дарить самому себе');
      if (!me.is_admin) { // у админа звёзды бесконечные
        if (me.stars < stars) fail(400, 'Не хватает звёзд');
        db.prepare('UPDATE users SET stars=stars-? WHERE id=?').run(stars, me.id);
      }
      db.prepare('UPDATE users SET stars=stars+? WHERE id=?').run(stars, peer.id);
    }
    const id = Number(db.prepare('INSERT INTO msgs(chat_id,from_id,kind,text,stars,media_id,dur,reply_to,ts) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(chat.id, user.id, kind, text, stars, media, dur, reply, now()).lastInsertRowid);
    db.prepare('UPDATE members SET last_read=MAX(last_read,?) WHERE chat_id=? AND user_id=?').run(id, chat.id, user.id);
    return db.prepare('SELECT * FROM msgs WHERE id=?').get(id);
  });
  fanoutMessage(chat, m);
  if (kind === 'stars') {
    const peer = peerOf(chat, user.id);
    push(peer.id, { type: 'balance', stars: getUser(peer.id).stars });
    push(user.id, { type: 'balance', stars: getUser(user.id).stars });
  }
  return { msg: ser(m, user.id), stars: getUser(user.id).stars };
});

route('POST', /^\/api\/msgs\/(\d+)\/edit$/, {}, ({ user, params, body }) => {
  const m = db.prepare('SELECT * FROM msgs WHERE id=?').get(Number(params[0]));
  if (!m || m.deleted) fail(404, 'Сообщение не найдено');
  needMember(m.chat_id, user);
  if (m.from_id !== user.id) fail(403, 'Можно править только свои сообщения');
  if (!['text', 'image'].includes(m.kind)) fail(400, 'Это сообщение править нельзя');
  const text = clean(body.text, 4000);
  if (!text && m.kind === 'text') fail(400, 'Пустое сообщение');
  db.prepare('UPDATE msgs SET text=?, edited=1 WHERE id=?').run(text, m.id);
  const nm = db.prepare('SELECT * FROM msgs WHERE id=?').get(m.id);
  for (const uid of memberIds(m.chat_id)) push(uid, { type: 'edit', chat_id: m.chat_id, msg: ser(nm, uid) });
  return { ok: true };
});

route('POST', /^\/api\/msgs\/(\d+)\/delete$/, {}, ({ user, params }) => {
  const m = db.prepare('SELECT * FROM msgs WHERE id=?').get(Number(params[0]));
  if (!m || m.deleted) fail(404, 'Сообщение не найдено');
  const { chat, mem } = needMember(m.chat_id, user);
  if (m.from_id !== user.id && !(chat.type !== 'direct' && isStaff(mem))) fail(403, 'Нельзя удалить чужое сообщение');
  db.prepare('UPDATE msgs SET deleted=1, text=\'\' WHERE id=?').run(m.id);
  pushAll(m.chat_id, { type: 'delete', chat_id: m.chat_id, id: m.id });
  return { ok: true };
});

// ---------- API: подарки ----------
route('GET', '/api/gifts', {}, () => Object.entries(GIFTS).map(([code, g]) => ({
  code, emoji: g.emoji, name: g.name, price: g.price, supply: g.supply || null, left: g.supply ? Math.max(0, g.supply - soldCount(code)) : null,
})));

route('POST', /^\/api\/chats\/(\d+)\/gift$/, {}, ({ user, params, body }) => {
  if (limited('gift:' + user.id, 30, 60000)) fail(429, 'Не так быстро');
  const { chat } = needMember(params[0], user);
  if (chat.type !== 'direct') fail(400, 'Подарки дарят в личных чатах');
  const g = GIFTS[body.code];
  if (!g) fail(400, 'Нет такого подарка');
  const note = clean(body.note, 200);
  const peer = peerOf(chat, user.id);
  if (peer.id === user.id || peer.is_system || peer.banned) fail(400, 'Этому пользователю подарок отправить нельзя');
  const m = tx(() => {
    const me = getUser(user.id);
    if (g.supply && soldCount(body.code) >= g.supply) fail(400, 'Этот подарок закончился');
    if (!me.is_admin) {
      if (me.stars < g.price) fail(400, 'Не хватает звёзд');
      db.prepare('UPDATE users SET stars=stars-? WHERE id=?').run(g.price, me.id);
    }
    const id = Number(db.prepare('INSERT INTO msgs(chat_id,from_id,kind,text,stars,gift,ts) VALUES(?,?,?,?,?,?,?)')
      .run(chat.id, me.id, 'gift', note, g.price, body.code, now()).lastInsertRowid);
    db.prepare('INSERT INTO user_gifts(code,from_id,to_id,msg_id,note,ts) VALUES(?,?,?,?,?,?)').run(body.code, me.id, peer.id, id, note, now());
    db.prepare('UPDATE members SET last_read=MAX(last_read,?) WHERE chat_id=? AND user_id=?').run(id, chat.id, me.id);
    return db.prepare('SELECT * FROM msgs WHERE id=?').get(id);
  });
  fanoutMessage(chat, m);
  push(user.id, { type: 'balance', stars: getUser(user.id).stars });
  return { msg: ser(m, user.id), stars: getUser(user.id).stars };
});

route('GET', '/api/my-gifts', {}, ({ user }) => db.prepare('SELECT g.*, u.name AS from_name FROM user_gifts g JOIN users u ON u.id=g.from_id WHERE g.to_id=? AND g.converted=0 ORDER BY g.id DESC LIMIT 200').all(user.id)
  .map((g) => ({ id: g.id, code: g.code, emoji: GIFTS[g.code].emoji, name: GIFTS[g.code].name, price: GIFTS[g.code].price, from_name: g.from_name, ts: g.ts, hidden: !!g.hidden, convert_value: Math.floor(GIFTS[g.code].price * CONVERT_RATE) })));

route('POST', /^\/api\/my-gifts\/(\d+)\/convert$/, {}, ({ user, params }) => {
  const g = db.prepare('SELECT * FROM user_gifts WHERE id=? AND to_id=? AND converted=0').get(Number(params[0]), user.id);
  if (!g) fail(404, 'Подарок не найден');
  const value = Math.floor(GIFTS[g.code].price * CONVERT_RATE);
  tx(() => { db.prepare('UPDATE user_gifts SET converted=1 WHERE id=?').run(g.id); db.prepare('UPDATE users SET stars=stars+? WHERE id=?').run(value, user.id); });
  const stars = getUser(user.id).stars;
  push(user.id, { type: 'balance', stars });
  return { ok: true, stars, value };
});

route('POST', /^\/api\/my-gifts\/(\d+)\/hide$/, {}, ({ user, params, body }) => {
  const g = db.prepare('SELECT * FROM user_gifts WHERE id=? AND to_id=? AND converted=0').get(Number(params[0]), user.id);
  if (!g) fail(404, 'Подарок не найден');
  db.prepare('UPDATE user_gifts SET hidden=? WHERE id=?').run(body.hidden ? 1 : 0, g.id);
  return { ok: true };
});

// ---------- API: админ ----------
route('GET', '/api/admin/stats', { admin: true }, () => {
  const c = (sql, ...a) => db.prepare(sql).get(...a).n;
  return {
    users: c('SELECT COUNT(*) n FROM users WHERE is_system=0'),
    banned: c('SELECT COUNT(*) n FROM users WHERE banned=1'),
    messages: c('SELECT COUNT(*) n FROM msgs WHERE from_id!=? AND deleted=0', SYSTEM_ID),
    groups: c("SELECT COUNT(*) n FROM chats WHERE type='group'"),
    channels: c("SELECT COUNT(*) n FROM chats WHERE type='channel'"),
    gifts: c('SELECT COUNT(*) n FROM user_gifts'),
    stars_total: c('SELECT COALESCE(SUM(stars),0) n FROM users WHERE is_system=0 AND is_admin=0'),
    online: [...streams.values()].filter((s) => s.size).length,
    active_24h: c('SELECT COUNT(*) n FROM users WHERE last_seen>?', now() - 86400000),
    db_mb: Math.round((fs.statSync(DB_PATH).size / 1048576) * 10) / 10,
  };
});

route('GET', '/api/admin/users', { admin: true }, ({ query }) => {
  const q = clean(query.get('q'), 32).replace(/[%_]/g, '');
  return db.prepare('SELECT * FROM users WHERE is_system=0 AND (username LIKE ? OR name LIKE ?) ORDER BY id DESC LIMIT 200')
    .all('%' + q + '%', '%' + q + '%')
    .map((u) => ({ ...selfUser(u), banned: !!u.banned, created: u.created, last_seen: u.last_seen, online: online(u.id) }));
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
  const sent = [];
  tx(() => {
    for (const u of users) {
      const chat = directChat(SYSTEM_ID, u.id);
      const id = Number(db.prepare("INSERT INTO msgs(chat_id,from_id,kind,text,ts) VALUES(?,?,'text',?,?)").run(chat.id, SYSTEM_ID, text, now()).lastInsertRowid);
      sent.push([u, chat, id]);
    }
  });
  for (const [u, chat, id] of sent) push(u.id, { type: 'message', chat_id: chat.id, msg: ser(db.prepare('SELECT * FROM msgs WHERE id=?').get(id), u.id) });
  return { ok: true, sent: users.length };
});

route('GET', '/api/admin/backup', { admin: true }, () => {
  const tmp = DB_PATH + '.backup.tmp';
  try { fs.unlinkSync(tmp); } catch {}
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const body = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return { __raw: { type: 'application/octet-stream', body, disposition: `attachment; filename="starchat-backup-${stamp}.db"` } };
});

route('POST', '/api/admin/restore', { admin: true, raw: 150 * 1024 * 1024 }, ({ body }) => {
  if (body.length < 100 || body.subarray(0, 15).toString() !== 'SQLite format 3') fail(400, 'Это не файл бэкапа StarChat');
  fs.writeFileSync(DB_PATH + '.restore', body);
  setTimeout(() => process.exit(0), 800); // хостинг перезапустит сервис, при старте база подменится
  return { ok: true, restart: true };
});

// ---------- static ----------
const ICON_192 = Buffer.from('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', 'base64');
const ICON_512 = Buffer.from('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', 'base64');
const SW = `const CACHE='sc-shell-v2';
self.addEventListener('install',e=>{self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.pathname.startsWith('/api/'))return;
e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(CACHE).then(x=>x.put(e.request,c));return r}).catch(()=>caches.match(e.request)))});`;
const manifest = () => JSON.stringify({
  name: APP_NAME, short_name: APP_NAME, start_url: '/', scope: '/', display: 'standalone',
  background_color: '#14111f', theme_color: '#1b1730',
  icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
});
const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/admin.html': 'admin.html' };
function serveStatic(req, res, pathname) {
  const hdr = (type) => ({ 'Content-Type': type, 'Cache-Control': 'no-cache' });
  if (pathname === '/manifest.json') { res.writeHead(200, hdr('application/json')); return res.end(manifest()); }
  if (pathname === '/sw.js') { res.writeHead(200, hdr('text/javascript')); return res.end(SW); }
  if (pathname === '/icon-192.png') { res.writeHead(200, hdr('image/png')); return res.end(ICON_192); }
  if (pathname === '/icon-512.png') { res.writeHead(200, hdr('image/png')); return res.end(ICON_512); }
  const f = PAGES[pathname];
  if (!f) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(__dirname, f), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, hdr('text/html; charset=utf-8'));
    res.end(data);
  });
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

    let user = null;
    if (!r.anon) { user = authUser(bearer(req) || url.searchParams.get('t')); if (r.admin && !user.is_admin) fail(403, 'Только для админа'); }
    const body = req.method === 'POST' ? await readBody(req, r.raw || 40000, !!r.raw) : {};
    send(res, 200, await r.fn({ req, user, body, query: url.searchParams, params }));
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Ошибка сервера' });
  }
});

server.listen(PORT, () => console.log(`${APP_NAME} запущен: http://localhost:${PORT}   админка: http://localhost:${PORT}/admin.html`));
