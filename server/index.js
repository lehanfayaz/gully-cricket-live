import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Server } from 'socket.io';
import { get, all, run } from './db.js';
import * as G from './engine.js';
import { profile, leaderboard } from './stats.js';
import * as CDB from './cricketdb.js';
import * as SYNC from './sync.js';
import { aiStep } from './ai.js';

CDB.seedIfEmpty();

const app = express();
app.use(express.json({ limit: '32kb' }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CORS_ORIGIN || false } });

// ---------- auth ----------
const newId = () => crypto.randomUUID();
const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashPass = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
const checkPass = (pw, stored) => {
  const [salt, h] = (stored || '').split(':');
  if (!salt || !h) return false;
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const userFromToken = (token) => token
  ? get('SELECT u.id, u.username, u.display_name AS name, u.is_guest AS guest FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?', token)
  : null;
const publicUser = (u) => u && ({ id: u.id, username: u.username, name: u.name ?? u.display_name, guest: !!(u.guest ?? u.is_guest) });
const issue = (userId) => { const t = newToken(); run('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)', t, userId, Date.now()); return t; };
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 24);

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  req.user = userFromToken(token);
  req.token = token;
  next();
}
const needUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Sign in first.' }));
// Admins: registered usernames listed in ADMIN_USERNAMES (comma-separated) on the server.
const adminNames = () => String(process.env.ADMIN_USERNAMES || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const isAdmin = (u) => !!u && !u.guest && !!u.username && adminNames().includes(u.username.toLowerCase());
const needAdmin = (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Only admins can do that.' }));
app.use('/api', auth);

const wrap = (fn) => (req, res) => {
  try { const out = fn(req, res); if (out !== undefined) res.json(out); }
  catch (e) {
    if (e instanceof G.GameError) res.status(400).json({ error: e.message });
    else { console.error(e); res.status(500).json({ error: 'Something went wrong on the server.' }); }
  }
};

app.post('/api/auth/guest', wrap((req) => {
  const name = cleanName(req.body.name);
  if (name.length < 2) throw new G.GameError('Enter a name with at least 2 characters.');
  const id = newId();
  run('INSERT INTO users (id, display_name, is_guest, created_at) VALUES (?,?,1,?)', id, name, Date.now());
  return { token: issue(id), user: publicUser({ id, name, guest: 1 }) };
}));

app.post('/api/auth/register', wrap((req) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const name = cleanName(req.body.name) || username;
  if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new G.GameError('Usernames are 3–20 letters, numbers or underscores.');
  if (password.length < 8) throw new G.GameError('Use a password of at least 8 characters.');
  if (get('SELECT 1 FROM users WHERE username = ?', username)) throw new G.GameError('That username is taken.');
  // A guest who registers keeps their match history and stats.
  if (req.user?.guest) {
    run('UPDATE users SET username = ?, display_name = ?, pass_hash = ?, is_guest = 0 WHERE id = ?', username, name, hashPass(password), req.user.id);
    return { token: req.token, user: publicUser({ id: req.user.id, username, name, guest: 0 }) };
  }
  const id = newId();
  run('INSERT INTO users (id, username, display_name, pass_hash, is_guest, created_at) VALUES (?,?,?,?,0,?)', id, username, name, hashPass(password), Date.now());
  return { token: issue(id), user: publicUser({ id, username, name, guest: 0 }) };
}));

app.post('/api/auth/login', wrap((req) => {
  const u = get('SELECT * FROM users WHERE username = ?', String(req.body.username || '').trim().toLowerCase());
  if (!u || !checkPass(String(req.body.password || ''), u.pass_hash)) throw new G.GameError('Wrong username or password.');
  return { token: issue(u.id), user: publicUser(u) };
}));

app.post('/api/auth/logout', needUser, wrap((req) => { run('DELETE FROM sessions WHERE token = ?', req.token); return { ok: true }; }));
app.get('/api/me', wrap((req) => ({ user: req.user ? { ...publicUser(req.user), admin: isAdmin(req.user) } : null })));

app.patch('/api/me', needUser, wrap((req) => {
  const name = cleanName(req.body.name);
  if (name.length < 2) throw new G.GameError('Enter a name with at least 2 characters.');
  run('UPDATE users SET display_name = ? WHERE id = ?', name, req.user.id);
  return { user: publicUser({ ...req.user, name }) };
}));

// ---------- matches ----------
// Team identity for lists: real teams carry their badge; custom teams get a plain one.
const badges = (m, ma, mb) => [[m.team_a, ma], [m.team_b, mb]].map(([name, meta]) => {
  const x = meta ? JSON.parse(meta) : null;
  return x ? { name: x.name, short: x.short, color: x.color, country: x.country, logo: x.logo } : { name, short: String(name).slice(0, 3).toUpperCase() };
});
app.post('/api/matches', needUser, wrap((req) => {
  const body = req.body || {};
  const quick = body.quick ? { start: ['bat', 'bowl'].includes(body.quick.start) ? body.quick.start : 'toss' } : null;
  return { id: G.createMatch(req.user.id, { ...body, quick }) };
}));

app.get('/api/matches/mine', needUser, wrap((req) => ({
  matches: all(`SELECT m.id, m.name, m.status, m.team_a, m.team_b, m.team_a_meta, m.team_b_meta, m.result, m.created_at, m.umpire_id = ? AS umpire
                FROM members mb JOIN matches m ON m.id = mb.match_id WHERE mb.user_id = ? AND mb.banned = 0
                ORDER BY m.created_at DESC LIMIT 30`, req.user.id, req.user.id)
    .map(({ team_a_meta: ma, team_b_meta: mb, ...m }) => ({ ...m, umpire: !!m.umpire, result: m.result ? JSON.parse(m.result) : null, badges: badges(m, ma, mb) })),
})));

app.get('/api/matches/recent', wrap(() => ({
  matches: all(`SELECT id, name, status, team_a, team_b, result, ended_at FROM matches WHERE status = 'completed' ORDER BY ended_at DESC LIMIT 30`)
    .map((m) => ({ ...m, result: m.result ? JSON.parse(m.result) : null })),
})));

app.get('/api/matches/:id', wrap((req) => {
  const m = get('SELECT id, name, status, team_a, team_b FROM matches WHERE id = ?', req.params.id.toUpperCase());
  if (!m) throw new G.GameError('No match with that code.');
  return m;
}));

app.get('/api/users/:id', wrap((req) => {
  const p = profile(req.params.id);
  if (!p) throw new G.GameError('Player not found.');
  return p;
}));
app.get('/api/leaderboard', wrap((req) => ({ sort: req.query.sort || 'points', rows: leaderboard(String(req.query.sort || 'points')) })));
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------- real cricket teams (read: anyone; edit: admins) ----------
const plain = (fn) => (req, res) => {
  Promise.resolve().then(() => fn(req, res)).then((out) => out !== undefined && res.json(out))
    .catch((e) => res.status(e instanceof G.GameError || e instanceof Error ? 400 : 500).json({ error: e.message || 'Something went wrong.' }));
};
app.get('/api/cricket/teams', plain(() => ({ ...CDB.listTeams(), provider: SYNC.providerName() })));
app.get('/api/cricket/teams/:id', plain((req) => { const t = CDB.getTeam(req.params.id); if (!t) throw new Error('Team not found.'); return t; }));
app.get('/api/admin/sync', needAdmin, plain(() => ({ status: CDB.syncStatus(), runs: CDB.recentSyncRuns(), provider: SYNC.providerName() })));
app.post('/api/admin/sync', needAdmin, plain(async () => ({ result: await SYNC.runSync('manual'), status: CDB.syncStatus() })));
app.get('/api/admin/teams', needAdmin, plain(() => CDB.listTeams({ includeInactive: true })));
app.post('/api/admin/teams', needAdmin, plain((req) => ({ id: CDB.adminSaveTeam(req.body || {}) })));
app.post('/api/admin/teams/:id/players', needAdmin, plain((req) => ({ id: CDB.adminAddPlayer(req.params.id, req.body || {}) })));
app.patch('/api/admin/players/:id', needAdmin, plain((req) => { CDB.adminUpdatePlayer(Number(req.params.id), req.body || {}); return { ok: true }; }));
app.delete('/api/admin/teams/:id/players/:pid', needAdmin, plain((req) => { CDB.adminRemovePlayer(req.params.id, Number(req.params.pid)); return { ok: true }; }));

// ---------- static client ----------
const dist = path.resolve('client/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api|socket\.io).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// ---------- realtime ----------
io.use((socket, next) => {
  const u = userFromToken(socket.handshake.auth?.token);
  if (!u) return next(new Error('unauthorized'));
  socket.data.user = u;
  next();
});

const roomOf = (id) => `m:${id}`;
const personal = (matchId, uid) => `mu:${matchId}:${uid}`;
const lastMsgId = (matchId) => get('SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE match_id = ?', matchId).id;

// The AI takes its turn a moment after anything changes, through the same engine functions as a person.
const aiTimers = new Map();
function scheduleAI(matchId) {
  if (aiTimers.has(matchId)) return;
  aiTimers.set(matchId, setTimeout(async () => {
    aiTimers.delete(matchId);
    let r;
    const since = lastMsgId(matchId);
    try { r = aiStep(matchId); } catch (e) { if (!(e instanceof G.GameError)) console.error('AI error', e); return; }
    if (r) { await broadcast(matchId, since, r.ctx); }
  }, process.env.AI_DELAY_MS ? Number(process.env.AI_DELAY_MS) : 700 + Math.random() * 700));
}

async function broadcast(matchId, sinceMsgId, ctx) {
  const m = G.loadMatch(matchId);
  io.to(roomOf(matchId)).emit('state', G.publicState(matchId));
  if (m.config.participation === 'ai') scheduleAI(matchId);
  const sockets = await io.in(roomOf(matchId)).fetchSockets();
  const seen = new Map();
  for (const s of sockets) {
    const uid = s.data.user.id;
    if (!seen.has(uid)) seen.set(uid, G.privateState(matchId, uid));
    s.emit('private', { matchId, ...seen.get(uid) });
  }
  if (sinceMsgId != null) {
    for (const row of all('SELECT * FROM messages WHERE match_id = ? AND id > ? ORDER BY id', matchId, sinceMsgId)) sendMessage(m, row);
  }
  if (ctx) {
    for (const fx of ctx.fx) io.to(roomOf(matchId)).emit('fx', fx);
    for (const n of ctx.notify) io.to(`u:${G.controllerOf(matchId, n.userId) || n.userId}`).emit('notify', { ...n, matchId });
    for (const uid of ctx.kicked) {
      io.to(personal(matchId, uid)).emit('kicked', { matchId });
      for (const s of await io.in(personal(matchId, uid)).fetchSockets()) { s.leave(roomOf(matchId)); s.leave(personal(matchId, uid)); }
    }
  }
}

function sendMessage(m, row) {
  const msg = G.messageView(row);
  if (row.channel === 'public') io.to(roomOf(m.id)).emit('chat', msg);
  else {
    const owner = row.channel.slice(4);
    io.to(personal(m.id, owner)).to(personal(m.id, m.umpire_id)).emit('chat', msg);
  }
}

async function presence(matchId) {
  const sockets = await io.in(roomOf(matchId)).fetchSockets();
  io.to(roomOf(matchId)).emit('presence', { matchId, online: [...new Set(sockets.map((s) => s.data.user.id))] });
}

io.on('connection', (socket) => {
  const user = socket.data.user;
  socket.join(`u:${user.id}`);
  let lastChat = 0, lastCheer = 0;

  const handle = (fn, light = false) => async (payload, ack = () => {}) => {
    const matchId = String(payload?.matchId || socket.data.matchId || '').toUpperCase();
    try {
      if (!matchId || !socket.rooms.has(roomOf(matchId))) throw new G.GameError('Open the match first.');
      const since = lastMsgId(matchId);
      const ctx = G.newCtx();
      const extra = fn(matchId, payload || {}, ctx);
      if (light) {
        const m = G.loadMatch(matchId);
        for (const row of all('SELECT * FROM messages WHERE match_id = ? AND id > ? ORDER BY id', matchId, since)) sendMessage(m, row);
      } else await broadcast(matchId, since, ctx);
      ack({ ok: true, ...(extra || {}) });
    } catch (e) {
      if (!(e instanceof G.GameError)) console.error(e);
      ack({ ok: false, error: e instanceof G.GameError ? e.message : 'Something went wrong on the server.' });
    }
  };

  socket.on('match:open', async ({ matchId } = {}, ack = () => {}) => {
    try {
      matchId = String(matchId || '').toUpperCase();
      const since = lastMsgId(matchId);
      const isNew = G.joinMatch(user.id, matchId);
      if (socket.data.matchId && socket.data.matchId !== matchId) {
        socket.leave(roomOf(socket.data.matchId)); socket.leave(personal(socket.data.matchId, user.id));
      }
      socket.data.matchId = matchId;
      socket.join(roomOf(matchId)); socket.join(personal(matchId, user.id));
      const m = G.loadMatch(matchId);
      ack({ ok: true, state: G.publicState(matchId), private: { matchId, ...G.privateState(matchId, user.id) }, chat: G.chatHistory(m, user.id) });
      if (m.config.participation === 'ai') scheduleAI(matchId);
      if (isNew) await broadcast(matchId, since, null);
      await presence(matchId);
    } catch (e) {
      ack({ ok: false, error: e instanceof G.GameError ? e.message : 'Could not open the match.' });
      if (!(e instanceof G.GameError)) console.error(e);
    }
  });

  socket.on('match:start', handle((id, p, ctx) => G.startMatch(user.id, id, ctx)));
  socket.on('match:nextInnings', handle((id, p, ctx) => G.nextInnings(user.id, id, ctx)));
  socket.on('over:submit', handle((id, p, ctx) => G.submitOver(user.id, id, p.sequence, ctx)));
  socket.on('captain', handle((id, p, ctx) => G.captainAction(user.id, id, p.action || {}, ctx)));
  socket.on('team:join', handle((id, p, ctx) => G.joinTeam(user.id, id, p.team, ctx)));
  socket.on('lineup:confirm', handle((id, p, ctx) => G.confirmLineup(user.id, id, p.team, ctx)));
  socket.on('toss:call', handle((id, p, ctx) => G.callToss(user.id, id, p.call, ctx)));
  socket.on('test', handle((id, p, ctx) => G.testAction(user.id, id, p.action || {}, ctx)));
  socket.on('toss:decide', handle((id, p, ctx) => G.decideToss(user.id, id, p.decision, ctx)));
  socket.on('umpire', handle((id, p, ctx) => {
    G.umpireAction(user.id, id, p.action || {}, ctx);
    if (p.action?.type === 'delete_message') {
      const row = get('SELECT * FROM messages WHERE id = ? AND match_id = ?', Number(p.action.messageId), id);
      if (row) io.to(roomOf(id)).emit('chat:update', G.messageView(row));
    }
  }));

  socket.on('chat:send', handle((id, p) => {
    if (Date.now() - lastChat < 600) throw new G.GameError('Slow down a little.');
    G.postChat(user.id, id, p.channel === 'public' || !p.channel ? 'public' : String(p.channel), p.text);
    lastChat = Date.now();
  }, true));
  socket.on('chat:react', handle((id, p) => {
    const channel = G.toggleReaction(user.id, id, Number(p.messageId), String(p.emoji || ''));
    const row = get('SELECT * FROM messages WHERE id = ?', Number(p.messageId));
    const msg = G.messageView(row);
    const m = G.loadMatch(id);
    if (channel === 'public') io.to(roomOf(id)).emit('chat:update', msg);
    else io.to(personal(id, channel.slice(4))).to(personal(id, m.umpire_id)).emit('chat:update', msg);
  }, true));
  socket.on('cheer', ({ matchId, emoji } = {}) => {
    matchId = String(matchId || '').toUpperCase();
    if (!socket.rooms.has(roomOf(matchId)) || Date.now() - lastCheer < 400) return;
    const e = String(emoji || '');
    if (!['🔥', '👏', '😱', '🏏', '🎉', '😂'].includes(e)) return;
    const mem = get('SELECT muted FROM members WHERE match_id = ? AND user_id = ?', matchId, user.id);
    if (mem?.muted) return;
    lastCheer = Date.now();
    io.to(roomOf(matchId)).emit('cheer', { emoji: e, name: user.name });
  });

  socket.on('disconnecting', () => {
    const mid = socket.data.matchId;
    if (mid) setTimeout(() => presence(mid), 50);
  });
});

// Daily cricket data sync; failures are shown to admins.
SYNC.setAlertHandler((text) => {
  for (const name of adminNames()) {
    const u = get('SELECT id FROM users WHERE username = ?', name);
    if (u) io.to(`u:${u.id}`).emit('notify', { title: 'Cricket data', body: text, kind: 'info' });
  }
  console.warn(text);
});
if (process.env.NODE_ENV !== 'test') SYNC.startSchedule();

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => console.log(`FOOTY CRICKET LEAGUE on http://localhost:${PORT}`));
export { server };
