import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Server } from 'socket.io';
import { get, all, run } from './db.js';
import * as G from './engine.js';
import { profile, leaderboard } from './stats.js';
import { career, matchAnalysis, replay, highlights } from './analytics.js';
import * as TOUR from './tournament.js';
import * as CAREER from './career.js';
import * as CDB from './cricketdb.js';
import * as SYNC from './sync.js';
import { aiStep } from './ai.js';
import * as SEC from './security.js';
import * as ADMIN from './admin.js';
import * as CONFIG from './config.js';
import * as BACKUP from './backup.js';
import * as INTEGRITY from './integrity.js';
import * as IMPORTER from './importer.js';

CDB.seedIfEmpty();
CAREER.seedDefaults();
// One-time import of the squads workbook shipped with this release (6 Nov 2026). Recorded so it never runs twice,
// and an admin's later imports or syncs aren't overwritten by it.
{
  const KEY = 'import:squads-2026-11-06';
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), 'data', 'squads-2026-11-06.xlsx');
  if (!CDB.getSetting(KEY) && fs.existsSync(file) && process.env.NODE_ENV !== 'test') {
    IMPORTER.parseWorkbook(fs.readFileSync(file)).then((p) => {
      const r = IMPORTER.applyImport(p, { label: 'Spreadsheet: Cricket_Squads_Nov2026.xlsx' });
      CDB.setSetting(KEY, String(Date.now()));
      console.log(`Imported squads workbook: ${r.squads} squads, ${r.newPlayers} new players.`);
    }).catch((e) => console.error('Squads workbook import failed:', e));
  }
}

const app = express();
app.set('trust proxy', 1); // Railway sits in front: use the client's address for rate limits and logs
app.disable('x-powered-by');
app.use(SEC.headers);
// Small JSON bodies everywhere, except a profile picture (resized on the device, up to ~300 KB encoded).
const smallJson = express.json({ limit: '32kb' }), avatarJson = express.json({ limit: '400kb' });
app.use((req, res, next) => (req.path === '/api/me/avatar' ? avatarJson : smallJson)(req, res, next));
// A general ceiling per client, and stricter ones for signing in.
app.use('/api', SEC.rateLimit('api', 600, 60000));
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
const userFromToken = (token) => SEC.userFromToken(token);
const publicUser = (u) => u && ({ id: u.id, username: u.username, name: u.name ?? u.display_name, guest: !!(u.guest ?? u.is_guest) });
const issue = (userId) => { const t = newToken(); run('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)', t, userId, Date.now()); return t; };
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 24);

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  req.user = userFromToken(token);
  req.token = token;
  if (req.user) req.user.guest = !!req.user.guest;
  // A suspended account is signed out everywhere and can't act.
  if (req.user?.status === 'suspended') { req.user = null; return res.status(403).json({ error: 'This account is suspended. Contact the organisers.' }); }
  next();
}
const needUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Sign in first.' }));
// Roles: owners (ADMIN_USERNAMES on the server) are always admins; admins can make others moderators or admins.
const isAdmin = (u) => SEC.can(u, 'admin.view');
const need = SEC.need;
const needAdmin = need('config.manage');
app.use('/api', auth);

const wrap = (fn) => (req, res) => {
  try { const out = fn(req, res); if (out !== undefined) res.json(out); }
  catch (e) {
    if (e instanceof G.GameError) res.status(400).json({ error: e.message });
    else { serverError(e, req); res.status(500).json({ error: 'Something went wrong on the server.' }); }
  }
};
// Server errors are logged; staff get one notification per half hour so a burst doesn't flood them.
let lastErrorNote = 0;
function serverError(e, req) {
  SEC.logError('api', e, { route: req ? `${req.method} ${req.path}` : null, userId: req?.user?.id });
  if (Date.now() - lastErrorNote > 30 * 60000) { lastErrorNote = Date.now(); notifyStaff('error', `Server error: ${String(e?.message || e).slice(0, 200)}. See the error log.`); }
}
// An admin action: run it, write it to the audit log, return the result.
const staff = (perm, action, fn) => [need(perm), wrap((req, res) => {
  const out = fn(req, res);
  if (out !== undefined && action) SEC.audit(req, action, ...(out?._audit || []));
  if (out && out._audit) delete out._audit;
  return out;
})];

app.post('/api/auth/guest', SEC.rateLimit('guest', 20, 3600000), wrap((req) => {
  const name = cleanName(req.body.name);
  if (name.length < 2) throw new G.GameError('Enter a name with at least 2 characters.');
  const id = newId();
  run('INSERT INTO users (id, display_name, is_guest, created_at) VALUES (?,?,1,?)', id, name, Date.now());
  return { token: issue(id), user: publicUser({ id, name, guest: 1 }) };
}));

app.post('/api/auth/register', SEC.rateLimit('register', 10, 3600000), wrap((req) => {
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

app.post('/api/auth/login', SEC.rateLimit('login', 30, 15 * 60000, 'Too many sign-in attempts. Try again in a few minutes.'), wrap((req) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  // Repeated wrong passwords for one account are slowed down too, whatever address they come from.
  if (SEC.limited(`login-user:${username}`, 10, 15 * 60000)) throw new G.GameError('Too many sign-in attempts for this account. Try again in a few minutes.');
  const u = get('SELECT * FROM users WHERE username = ?', username);
  if (!u || !checkPass(String(req.body.password || ''), u.pass_hash)) throw new G.GameError('Wrong username or password.');
  if (u.status === 'suspended') throw new G.GameError('This account is suspended. Contact the organisers.');
  return { token: issue(u.id), user: publicUser(u) };
}));
// Change password (signs out other devices).
app.post('/api/me/password', needUser, SEC.rateLimit('password', 10, 3600000), wrap((req) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (u.is_guest) throw new G.GameError('Register first to set a password.');
  if (!checkPass(String(req.body.current || ''), u.pass_hash)) throw new G.GameError('Your current password is wrong.');
  const next = String(req.body.next || '');
  if (next.length < 8) throw new G.GameError('Use a password of at least 8 characters.');
  run('UPDATE users SET pass_hash = ? WHERE id = ?', hashPass(next), u.id);
  run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', u.id, req.token);
  return { ok: true };
}));

app.post('/api/auth/logout', needUser, wrap((req) => { run('DELETE FROM sessions WHERE token = ?', req.token); return { ok: true }; }));
app.get('/api/me', wrap((req) => ({ user: req.user ? { ...publicUser(req.user), admin: isAdmin(req.user), role: SEC.roleOf(req.user), permissions: SEC.permissionsOf(req.user) } : null })));
// What players' devices need from the admin settings (formats, AI options, stadiums, commentary on/off).
app.get('/api/config', wrap(() => CONFIG.publicConfig()));

app.patch('/api/me', needUser, wrap((req) => {
  const b = req.body || {};
  let name = req.user.name;
  if ('name' in b) {
    name = cleanName(b.name);
    if (name.length < 2) throw new G.GameError('Enter a name with at least 2 characters.');
    run('UPDATE users SET display_name = ? WHERE id = ?', name, req.user.id);
  }
  // Favourite teams, from the synced team database.
  for (const [key, col, cat] of [['favIntl', 'fav_intl', 'international'], ['favIpl', 'fav_ipl', 'ipl']]) {
    if (!(key in b)) continue;
    if (b[key] && !get('SELECT 1 FROM cricket_teams WHERE id = ? AND category = ?', String(b[key]), cat)) throw new G.GameError('Pick a team from the list.');
    run(`UPDATE users SET ${col} = ? WHERE id = ?`, b[key] ? String(b[key]) : null, req.user.id);
  }
  return { user: publicUser({ ...req.user, name }) };
}));
// Profile picture: a small image resized on the device (JPEG, PNG or WebP, up to about 200 KB).
app.put('/api/me/avatar', needUser, wrap((req) => {
  const d = String(req.body?.dataUrl || '');
  if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(d)) throw new G.GameError('Use a JPEG, PNG or WebP picture.');
  if (d.length > 280000) throw new G.GameError('That picture is too large. Try a smaller one.');
  run('UPDATE users SET avatar = ? WHERE id = ?', d, req.user.id);
  return { ok: true };
}));
app.delete('/api/me/avatar', needUser, wrap((req) => { run('UPDATE users SET avatar = NULL WHERE id = ?', req.user.id); return { ok: true }; }));
// Anyone's picture: their uploaded one, or for a real squad player the photo from the cricket database.
app.get('/api/users/:id/avatar', (req, res) => {
  const u = get('SELECT avatar, player_id, is_ghost FROM users WHERE id = ?', req.params.id);
  if (u?.avatar) {
    const [, mime, b64] = u.avatar.match(/^data:([^;]+);base64,(.*)$/) || [];
    if (mime) { res.set('content-type', mime).set('cache-control', 'private, max-age=300'); return res.send(Buffer.from(b64, 'base64')); }
  }
  const img = u?.is_ghost && u.player_id ? get('SELECT image_url FROM cricket_players WHERE id = ?', u.player_id)?.image_url : null;
  if (img && /^https:\/\//.test(img)) return res.redirect(302, img);
  res.status(404).end();
});

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
                FROM members mb JOIN matches m ON m.id = mb.match_id WHERE mb.user_id = ? AND mb.banned = 0 AND COALESCE(json_extract(m.config, '$.participation'), '') <> 'aivai'
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
// Statistics and analysis: computed from saved, revealed deliveries only.
app.get('/api/users/:id/career', wrap((req) => {
  if (!get('SELECT 1 FROM users WHERE id = ?', req.params.id)) throw new G.GameError('Player not found.');
  return career(req.params.id);
}));
app.get('/api/matches/:id/analysis', wrap((req) => {
  const a = matchAnalysis(req.params.id.toUpperCase());
  if (!a) throw new G.GameError('No match with that code.');
  return { analysis: a, highlights: highlights(null, a) };
}));
app.get('/api/matches/:id/replay', wrap((req) => {
  const r = replay(req.params.id.toUpperCase());
  if (!r) throw new G.GameError('No match with that code.');
  return r;
}));
// Tournaments against the AI.
app.get('/api/tournaments/mine', needUser, wrap((req) => ({ tournaments: TOUR.listMine(req.user.id) })));
app.post('/api/tournaments', needUser, wrap((req) => ({ id: TOUR.createTournament(req.user.id, req.body || {}) })));
app.get('/api/tournaments/:id', wrap((req) => {
  const v = TOUR.view(req.params.id.toUpperCase(), req.user?.id);
  if (!v) throw new G.GameError('No tournament with that code.');
  return v;
}));
app.post('/api/tournaments/:id/play', needUser, wrap((req) => ({ matchId: TOUR.playNext(req.user.id, req.params.id.toUpperCase()) })));
app.post('/api/tournaments/:id/simulate', needUser, wrap((req) => {
  const limit = req.body?.limit === 1 ? 1 : Infinity;
  const job = TOUR.simulate(req.user.id, req.params.id.toUpperCase(), { limit });
  return { job: { running: job.running, played: job.played, current: job.current, error: job.error } };
}));
app.post('/api/tournaments/:id/abandon', needUser, wrap((req) => { TOUR.abandon(req.user.id, req.params.id.toUpperCase()); return { ok: true }; }));
// Career: level, achievements, challenges and milestones (recording any new unlocks).
app.get('/api/users/:id/achievements', wrap((req) => {
  if (!get('SELECT 1 FROM users WHERE id = ?', req.params.id)) throw new G.GameError('Player not found.');
  const { fresh, ...p } = CAREER.progress(req.params.id);
  return p;
}));
app.get('/api/admin/achievements', need('config.manage'), wrap(() => CAREER.listAll()));
app.post('/api/admin/achievements', ...staff('config.manage', 'achievement.save', (req) => { try { const id = CAREER.saveAchievement(req.body || {}); return { id, _audit: ['achievement', id, req.body] }; } catch (e) { throw new G.GameError(e.message); } }));
app.post('/api/admin/challenges', ...staff('config.manage', 'challenge.save', (req) => { try { const id = CAREER.saveChallenge(req.body || {}); return { id, _audit: ['challenge', id, req.body] }; } catch (e) { throw new G.GameError(e.message); } }));
app.get('/api/leaderboard', wrap((req) => ({ sort: req.query.sort || 'points', rows: leaderboard(String(req.query.sort || 'points')) })));
app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------- real cricket teams (read: anyone; edit: admins) ----------
// Validation messages go back to the person; programming errors are logged and reported generically.
const isBug = (e) => e instanceof TypeError || e instanceof ReferenceError || e instanceof SyntaxError || e instanceof RangeError || !(e instanceof Error);
const plain = (fn) => (req, res) => {
  Promise.resolve().then(() => fn(req, res)).then((out) => out !== undefined && res.json(out))
    .catch((e) => { if (isBug(e)) { serverError(e, req); res.status(500).json({ error: 'Something went wrong on the server.' }); } else res.status(400).json({ error: e.message }); });
};
app.get('/api/cricket/teams', plain(() => ({ ...CDB.listTeams(), provider: SYNC.providerName() })));
app.get('/api/cricket/teams/:id', plain((req) => { const t = CDB.getTeam(req.params.id); if (!t) throw new Error('Team not found.'); return t; }));
app.get('/api/admin/sync', need('admin.view'), plain(() => ({ status: CDB.syncStatus(), runs: CDB.recentSyncRuns(), provider: SYNC.providerName() })));
app.post('/api/admin/sync', need('cricket.manage'), plain(async (req) => { SEC.audit(req, 'sync.run'); return { result: await SYNC.runSync('manual'), status: CDB.syncStatus() }; }));
app.get('/api/admin/teams', need('admin.view'), plain(() => CDB.listTeams({ includeInactive: true })));
app.post('/api/admin/teams', need('cricket.manage'), plain((req) => { const id = CDB.adminSaveTeam(req.body || {}); SEC.audit(req, 'team.save', 'team', id, req.body); return { id }; }));
app.post('/api/admin/teams/:id/players', need('cricket.manage'), plain((req) => { const id = CDB.adminAddPlayer(req.params.id, req.body || {}); SEC.audit(req, 'player.add', 'team', req.params.id, { playerId: id, ...req.body }); return { id }; }));
app.patch('/api/admin/players/:id', need('cricket.manage'), plain((req) => { CDB.adminUpdatePlayer(Number(req.params.id), req.body || {}); SEC.audit(req, 'player.edit', 'player', req.params.id, req.body); return { ok: true }; }));
app.delete('/api/admin/teams/:id/players/:pid', need('cricket.manage'), plain((req) => { CDB.adminRemovePlayer(req.params.id, Number(req.params.pid)); SEC.audit(req, 'player.remove', 'team', req.params.id, { playerId: Number(req.params.pid) }); return { ok: true }; }));
app.get('/api/admin/cricket/seasons', need('admin.view'), plain(() => ({ seasons: CDB.seasons() })));
app.get('/api/admin/cricket/teams/:id/squad', need('admin.view'), plain((req) => CDB.squadHistory(req.params.id, req.query.season ? String(req.query.season) : null)));
app.get('/api/admin/cricket/players', need('admin.view'), plain((req) => ({ players: CDB.searchPlayers(req.query.q || '') })));
app.get('/api/admin/cricket/duplicates', need('admin.view'), plain(() => ({ groups: CDB.duplicates() })));
app.post('/api/admin/cricket/merge', need('cricket.manage'), plain((req) => { const r = CDB.mergePlayers(Number(req.body?.keep), Number(req.body?.duplicate)); SEC.audit(req, 'player.merge', 'player', req.body?.keep, { duplicate: req.body?.duplicate, ...r }); return r; }));
// Import squads from a spreadsheet: preview first (?dryRun=1), then apply.
app.post('/api/admin/cricket/import', need('cricket.manage'), express.raw({ type: 'application/octet-stream', limit: '5mb' }), plain(async (req) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new Error('Choose an .xlsx file.');
  let parsed;
  try { parsed = await IMPORTER.parseWorkbook(req.body); } catch { throw new Error("That file couldn't be read as an Excel workbook (.xlsx)."); }
  const name = String(req.query.name || 'spreadsheet').slice(0, 80);
  // Which existing team each one updates; any that match nothing would be added as new teams.
  const match = (category, t) => CDB.matchTeam('import', category, { name: t.name, short: t.short, extId: `${category}:${t.name.toLowerCase().replace(/[^a-z0-9]/g, '')}` })?.name || null;
  const preview = { compiled: parsed.compiled, international: parsed.international.map((t) => ({ name: t.name, players: t.players.length, squadFor: t.squadFor, announced: t.announced, sources: t.sources, updates: match('international', t) })),
    ipl: parsed.ipl.map((t) => ({ name: t.name, short: t.short, players: t.players.length, updates: match('ipl', t) })), excluded: parsed.excluded, replacements: parsed.replacements, warnings: parsed.warnings };
  if (req.query.dryRun) return { preview };
  if (parsed.warnings.length) throw new Error(parsed.warnings.join(' '));
  const result = IMPORTER.applyImport(parsed, { label: `Spreadsheet: ${name}` });
  SEC.audit(req, 'cricket.import', 'file', name, { squads: result.squads, newPlayers: result.newPlayers, transfers: result.transfers, removed: result.removedPlayers });
  return { preview, result, status: CDB.syncStatus() };
}));

// ---------- staff: overview, users, matches, configuration, logs, backups ----------
const txt = (e) => { throw new G.GameError(e.message); };
app.get('/api/admin/overview', need('admin.view'), wrap((req) => ({ ...ADMIN.overview(), sync: CDB.syncStatus(), integrity: INTEGRITY.lastIntegrity(), backups: SEC.can(req.user, 'system.manage') ? BACKUP.listBackups().slice(0, 1) : null, notifications: ADMIN.listNotifications(10), role: SEC.roleOf(req.user), permissions: SEC.permissionsOf(req.user) })));
app.get('/api/admin/users', need('users.view'), wrap((req) => ADMIN.listUsers(req.query)));
app.get('/api/admin/users/:id', need('users.view'), wrap((req) => ADMIN.userDetail(req.params.id)));
app.patch('/api/admin/users/:id', ...staff('users.edit', 'user.rename', (req) => { const ch = ADMIN.renameUser(req.user, req.params.id, req.body || {}); return { ok: true, changes: ch, _audit: ['user', req.params.id, ch] }; }));
app.post('/api/admin/users/:id/status', ...staff('users.suspend', 'user.status', (req) => {
  const r = ADMIN.setStatus(req.user, req.params.id, req.body || {});
  if (r.status === 'suspended') io.in(`u:${req.params.id}`).disconnectSockets(true);
  return { ok: true, ...r, _audit: ['user', req.params.id, r] };
}));
app.post('/api/admin/users/:id/role', ...staff('users.role', 'user.role', (req) => { const r = ADMIN.setRole(req.user, req.params.id, String(req.body?.role || '')); return { ok: true, ...r, _audit: ['user', req.params.id, r] }; }));
app.get('/api/admin/matches', need('matches.view'), wrap((req) => ADMIN.listMatches(req.query)));
app.get('/api/admin/matches/:id', need('matches.view'), wrap((req) => ADMIN.inspectMatch(req.params.id)));
app.post('/api/admin/matches/:id/abandon', need('matches.manage'), plain(async (req) => {
  const id = req.params.id.toUpperCase();
  const since = lastMsgId(id), ctx = G.newCtx();
  G.adminAbandon(req.user.id, id, req.body?.reason, ctx);
  SEC.audit(req, 'match.abandon', 'match', id, { reason: req.body?.reason });
  await broadcast(id, since, ctx);
  return { ok: true };
}));
app.post('/api/admin/matches/cleanup', need('matches.manage'), plain(async (req) => {
  const days = Math.max(1, Math.min(365, Number(req.body?.days) || 14));
  const ids = ADMIN.staleLobbies(days);
  for (const id of ids) { const ctx = G.newCtx(); G.adminAbandon(req.user.id, id, `not started for ${days} days`, ctx); }
  SEC.audit(req, 'match.cleanup', 'match', null, { days, count: ids.length });
  return { abandoned: ids.length };
}));
app.get('/api/admin/config', need('config.manage'), wrap(() => ({ config: CONFIG.getConfig(), events: Object.fromEntries(Object.entries(CONFIG.COMMENTARY_EVENTS).map(([k, v]) => [k, v.label])), placeholders: CONFIG.PLACEHOLDERS })));
app.put('/api/admin/config/:section', ...staff('config.manage', 'config.save', (req) => { let saved; try { saved = CONFIG.saveSection(req.params.section, req.body || {}); } catch (e) { txt(e); } return { section: req.params.section, saved, _audit: ['config', req.params.section, saved] }; }));
app.get('/api/admin/audit', need('audit.view'), wrap((req) => ({ entries: SEC.recentAudit({ before: Number(req.query.before) || undefined }) })));
app.get('/api/admin/errors', need('audit.view'), wrap(() => ({ errors: SEC.recentErrors() })));
app.get('/api/admin/notifications', need('admin.view'), wrap(() => ({ notifications: ADMIN.listNotifications(100) })));
app.post('/api/admin/notifications/read', need('admin.view'), wrap(() => { ADMIN.markNotificationsRead(); return { ok: true }; }));
app.get('/api/admin/system', need('system.manage'), wrap(() => ({ backups: BACKUP.listBackups(), pendingRestore: BACKUP.pendingRestore(), integrity: INTEGRITY.lastIntegrity(), backupDir: BACKUP.backupDir() })));
app.post('/api/admin/backups', ...staff('system.manage', 'backup.create', () => { let b; try { b = BACKUP.createBackup('manual'); } catch (e) { txt(e); } return { backup: b, _audit: ['backup', b.name] }; }));
app.get('/api/admin/backups/:name', need('system.manage'), (req, res) => {
  try { const p = BACKUP.backupPath(req.params.name); SEC.audit(req, 'backup.download', 'backup', req.params.name); res.download(p); }
  catch (e) { res.status(404).json({ error: e.message }); }
});
app.post('/api/admin/backups/:name/restore', ...staff('system.manage', 'backup.restore_scheduled', (req) => { let v; try { v = BACKUP.requestRestore(req.params.name); } catch (e) { txt(e); } return { ok: true, counts: v.counts, _audit: ['backup', req.params.name, v.counts] }; }));
app.delete('/api/admin/restore', ...staff('system.manage', 'backup.restore_cancelled', () => { BACKUP.cancelRestore(); return { ok: true }; }));
// Apply a scheduled restore now: the server stops and the platform starts it again (the restore runs before the database opens).
app.post('/api/admin/restart', ...staff('system.manage', 'server.restart', (req, res) => {
  if (!BACKUP.pendingRestore()) throw new G.GameError('No restore is scheduled.');
  res.on('finish', () => setTimeout(() => process.exit(1), 300));
  return { ok: true };
}));
app.post('/api/admin/integrity', ...staff('system.manage', 'integrity.run', () => { const r = INTEGRITY.runIntegrity('manual'); return { ...r, _audit: ['integrity', null, { ok: r.ok, problems: r.problemCount }] }; }));

// ---------- static client ----------
const dist = path.resolve('client/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api|socket\.io).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// ---------- realtime ----------
io.use((socket, next) => {
  const u = userFromToken(socket.handshake.auth?.token);
  if (!u || u.status === 'suspended') return next(new Error('unauthorized'));
  u.guest = !!u.guest;
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

// When a match finishes, check each person who played for new achievements and completed challenges.
const careerChecked = new Set();
function checkCareers(m) {
  if (careerChecked.has(m.id)) return;
  careerChecked.add(m.id);
  const people = all(`SELECT DISTINCT u.id FROM members mb JOIN users u ON u.id = mb.user_id
    WHERE mb.match_id = ? AND mb.team IS NOT NULL AND u.is_bot = 0 AND u.is_ghost = 0`, m.id);
  for (const p of people) announceUnlocks(p.id, m.id);
}
function announceUnlocks(userId, matchId) {
  try {
    for (const f of CAREER.progress(userId).fresh)
      io.to(`u:${userId}`).emit('notify', { matchId, kind: 'achievement', title: f.challenge ? `Challenge complete: ${f.title}` : `Achievement unlocked: ${f.title}`, body: f.challenge ? 'Experience added to your career.' : `${f.icon} See it on your profile.` });
  } catch (e) { console.error('career check failed', e); }
}
TOUR.onFinish((ownerId) => announceUnlocks(ownerId, null));

async function broadcast(matchId, sinceMsgId, ctx) {
  const m = G.loadMatch(matchId);
  if (m.status === 'completed') checkCareers(m);
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
      if (SEC.limited(`sock:${user.id}`, 60, 10000)) throw new G.GameError('Slow down a little.');
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
      if (!(e instanceof G.GameError)) SEC.logError('socket', e, { route: 'socket', userId: user.id });
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

// Staff notifications: stored for the admin dashboard, and shown to staff who are online.
function notifyStaff(kind, text) {
  try {
    ADMIN.addNotification(kind, text);
    const staffIds = all(`SELECT id, username, role, is_guest FROM users WHERE is_guest = 0 AND (role IN ('admin', 'moderator') OR LOWER(username) IN (${SEC.ownerNames().map(() => '?').join(',') || "''"}))`, ...SEC.ownerNames());
    for (const u of staffIds) io.to(`u:${u.id}`).emit('notify', { title: kind === 'sync' ? 'Cricket data' : kind === 'integrity' ? 'Data check' : kind === 'backup' ? 'Backups' : 'Server', body: text, kind: 'info' });
  } catch (e) { console.error(e); }
  console.warn(`[${kind}] ${text}`);
}
// Daily cricket data sync; failures are shown to staff.
SYNC.setAlertHandler((text) => notifyStaff('sync', text));
if (process.env.NODE_ENV !== 'test') {
  SYNC.startSchedule();
  BACKUP.startBackups((e) => notifyStaff('backup', `Automatic backup failed: ${e.message}`));
  // Integrity check once a day; staff hear about any problem.
  const integrityTick = () => {
    const last = INTEGRITY.lastIntegrity();
    if (last && Date.now() - last.at < 86400000) return;
    try { const r = INTEGRITY.runIntegrity('schedule'); if (!r.ok) notifyStaff('integrity', `Daily data check found ${r.problemCount} problem(s). Open Admin, System to see them.`); }
    catch (e) { SEC.logError('integrity', e); }
  };
  setTimeout(integrityTick, 60000).unref();
  setInterval(integrityTick, 3600000).unref();
}
process.on('unhandledRejection', (e) => SEC.logError('unhandledRejection', e));
process.on('uncaughtException', (e) => { SEC.logError('uncaughtException', e); process.exit(1); });

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => console.log(`FOOTY CRICKET LEAGUE on http://localhost:${PORT}`));
export { server };
