// Staff operations: users, matches, notifications. Every change goes through here, is checked server-side,
// and is written to the admin audit log by the routes that call it.
import { all, get, run, tx } from './db.js';
import * as G from './engine.js';
import { career } from './analytics.js';
import { progress } from './career.js';
import { checkMatch } from './integrity.js';
import { ROLES, isOwner, roleOf } from './security.js';

const fail = (m) => { throw new G.GameError(m); };
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// ---------- users ----------
export function listUsers({ q = '', status = '', role = '', page = 1 } = {}) {
  const where = ['u.is_bot = 0', 'u.is_ghost = 0'], args = [];
  if (q) { where.push('(u.username LIKE ? OR u.display_name LIKE ? OR u.id = ?)'); args.push(`%${q}%`, `%${q}%`, q); }
  if (status === 'active' || status === 'suspended') { where.push('u.status = ?'); args.push(status); }
  if (status === 'guest') where.push('u.is_guest = 1');
  if (ROLES.includes(role)) { where.push('u.role = ?'); args.push(role); }
  const per = 50, offset = (Math.max(1, Number(page) || 1) - 1) * per;
  const total = get(`SELECT COUNT(*) AS n FROM users u WHERE ${where.join(' AND ')}`, ...args).n;
  const rows = all(`SELECT u.*, (SELECT COUNT(*) FROM members m JOIN matches x ON x.id = m.match_id WHERE m.user_id = u.id AND m.team IS NOT NULL AND x.status = 'completed') AS matches
    FROM users u WHERE ${where.join(' AND ')} ORDER BY COALESCE(u.last_seen_at, u.created_at) DESC LIMIT ? OFFSET ?`, ...args, per, offset);
  return { total, page: Number(page) || 1, per, users: rows.map(userRow) };
}
const userRow = (u) => ({ id: u.id, username: u.username, name: u.display_name, guest: !!u.is_guest, role: roleOf({ ...u, guest: !!u.is_guest }), owner: isOwner({ ...u, guest: !!u.is_guest }),
  status: u.status || 'active', suspendedReason: u.suspended_reason, suspendedAt: u.suspended_at, createdAt: u.created_at, lastSeenAt: u.last_seen_at, matches: u.matches ?? null });

export function userDetail(id) {
  const u = get('SELECT * FROM users WHERE id = ? AND is_bot = 0 AND is_ghost = 0', id);
  if (!u) fail('User not found.');
  const c = career(id);
  let level = null;
  try { const p = progress(id); level = { name: p.level.name, xp: p.level.xp, achievements: p.achievements.filter((a) => a.unlocked).length, tournamentWins: p.tournamentWins }; } catch {}
  return {
    user: userRow(u), sessions: get('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', id).n,
    career: { record: c.record, batting: c.batting, bowling: c.bowling }, level,
    recent: c.recent.slice(0, 10).map((m) => ({ id: m.id, name: m.name, outcome: m.outcome, endedAt: m.endedAt, runs: m.runs, wickets: m.wickets })),
  };
}

export function renameUser(actor, id, input) {
  const u = get('SELECT * FROM users WHERE id = ? AND is_bot = 0 AND is_ghost = 0', id);
  if (!u) fail('User not found.');
  const changes = {};
  if (input.username !== undefined) {
    if (u.is_guest) fail('Guests have no username to change.');
    const username = String(input.username).trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) fail('Usernames are 3–20 letters, numbers or underscores.');
    if (username !== u.username && get('SELECT 1 FROM users WHERE username = ? AND id <> ?', username, id)) fail('That username is taken.');
    if (isOwner({ ...u, guest: false }) && username !== u.username) fail('Owner accounts (set on the server) keep their username.');
    if (username !== u.username) changes.username = [u.username, username];
  }
  if (input.name !== undefined) {
    const name = String(input.name).replace(/\s+/g, ' ').trim().slice(0, 24);
    if (name.length < 2) fail('Display names need at least 2 characters.');
    if (name !== u.display_name) changes.name = [u.display_name, name];
  }
  if (!Object.keys(changes).length) fail('Nothing to change.');
  if (changes.username) run('UPDATE users SET username = ? WHERE id = ?', changes.username[1], id);
  if (changes.name) run('UPDATE users SET display_name = ? WHERE id = ?', changes.name[1], id);
  return changes;
}

export function setStatus(actor, id, { status, reason }) {
  const u = get('SELECT * FROM users WHERE id = ? AND is_bot = 0 AND is_ghost = 0', id);
  if (!u) fail('User not found.');
  if (!['active', 'suspended'].includes(status)) fail('Status must be active or suspended.');
  if (id === actor.id) fail("You can't suspend your own account.");
  const target = { ...u, guest: !!u.is_guest };
  if (status === 'suspended') {
    if (isOwner(target)) fail('Owner accounts (set on the server) cannot be suspended.');
    // Moderators can't suspend staff.
    if (roleOf(target) !== 'player' && roleOf(actor) !== 'admin') fail('Only admins can suspend staff accounts.');
    const why = String(reason || '').trim().slice(0, 200);
    if (why.length < 3) fail('Give a reason for the suspension.');
    tx(() => {
      run(`UPDATE users SET status = 'suspended', suspended_reason = ?, suspended_at = ? WHERE id = ?`, why, Date.now(), id);
      run('DELETE FROM sessions WHERE user_id = ?', id); // signed out everywhere
    });
    return { status, reason: why };
  }
  run(`UPDATE users SET status = 'active', suspended_reason = NULL, suspended_at = NULL WHERE id = ?`, id);
  return { status };
}

export function setRole(actor, id, role) {
  const u = get('SELECT * FROM users WHERE id = ? AND is_bot = 0 AND is_ghost = 0', id);
  if (!u) fail('User not found.');
  if (!ROLES.includes(role)) fail('Role must be player, moderator or admin.');
  if (u.is_guest && role !== 'player') fail('Guests need to register before they can be staff.');
  if (isOwner({ ...u, guest: !!u.is_guest })) fail('Owner accounts are always admins (set on the server).');
  if (id === actor.id) fail("You can't change your own role.");
  run('UPDATE users SET role = ? WHERE id = ?', role, id);
  return { from: u.role || 'player', to: role };
}

// ---------- matches ----------
const GROUPS = {
  active: ['lobby', 'live', 'innings_break', 'session_break', 'day_break'],
  suspended: ['suspended'], completed: ['completed'], abandoned: ['abandoned'],
};
export function listMatches({ group = 'active', q = '', page = 1 } = {}) {
  const statuses = GROUPS[group] || GROUPS.active;
  const where = [`m.status IN (${statuses.map(() => '?').join(',')})`], args = [...statuses];
  if (q) { where.push('(m.id = ? OR m.name LIKE ?)'); args.push(String(q).toUpperCase(), `%${q}%`); }
  const per = 50, offset = (Math.max(1, Number(page) || 1) - 1) * per;
  const total = get(`SELECT COUNT(*) AS n FROM matches m WHERE ${where.join(' AND ')}`, ...args).n;
  const rows = all(`SELECT m.*, u.display_name AS host,
      (SELECT MAX(created_at) FROM audit a WHERE a.match_id = m.id) AS last_event,
      (SELECT COUNT(*) FROM members x JOIN users xu ON xu.id = x.user_id WHERE x.match_id = m.id AND x.team IS NOT NULL AND xu.is_bot = 0 AND xu.is_ghost = 0) AS people
    FROM matches m LEFT JOIN users u ON u.id = m.umpire_id WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(m.ended_at, (SELECT MAX(created_at) FROM audit a WHERE a.match_id = m.id), m.created_at) DESC LIMIT ? OFFSET ?`, ...args, per, offset);
  return { total, page: Number(page) || 1, per, matches: rows.map((m) => {
    const c = parse(m.config, {});
    return { id: m.id, name: m.name, status: m.status, format: c.format || 'custom', participation: c.participation || 'team', tournament: c.tournament?.name || null,
      host: m.host, people: m.people, createdAt: m.created_at, endedAt: m.ended_at, lastEventAt: m.last_event, result: parse(m.result)?.text || null, abandonedReason: m.abandoned_reason };
  }) };
}

// Everything needed to investigate a match. Numbers still hidden (an open submission) are never shown,
// not even to staff: only that someone has locked in.
export function inspectMatch(id) {
  const m = get('SELECT * FROM matches WHERE id = ?', String(id).toUpperCase());
  if (!m) fail('No match with that code.');
  const st = G.publicState(m.id);
  const events = all('SELECT a.*, u.display_name AS who FROM audit a LEFT JOIN users u ON u.id = a.user_id WHERE a.match_id = ? ORDER BY a.id', m.id)
    .map((e) => ({ id: e.id, at: e.created_at, who: e.who, action: e.action, text: e.text, detail: parse(e.detail) }));
  const submissions = all(`SELECT s.*, i.number AS inn, ub.display_name AS bowler, uw.display_name AS batter FROM sets s JOIN innings i ON i.id = s.innings_id
      LEFT JOIN users ub ON ub.id = s.bowler_id LEFT JOIN users uw ON uw.id = s.batter_id WHERE i.match_id = ? ORDER BY s.id`, m.id)
    .map((s) => ({ id: s.id, innings: s.inn, bowler: s.bowler, batter: s.batter, status: s.status, endReason: s.end_reason, cap: s.cap, used: s.used, createdAt: s.created_at,
      bowl: s.status === 'open' ? (s.seq ? 'locked in (hidden)' : 'waiting') : s.seq, bat: s.status === 'open' ? (s.bat_seq ? 'locked in (hidden)' : 'waiting') : s.bat_seq,
      bowlHash: s.hash || null, batHash: s.bat_hash || null }));
  const members = all(`SELECT m.user_id, m.team, m.kind, m.banned, u.display_name AS name, u.is_bot, u.is_ghost, m.controller_id FROM members m JOIN users u ON u.id = m.user_id WHERE m.match_id = ?`, m.id)
    .map((x) => ({ id: x.user_id, name: x.name, team: x.team, kind: x.kind, bot: !!x.is_bot, ghost: !!x.is_ghost, controller: x.controller_id, banned: !!x.banned }));
  return {
    match: { id: m.id, name: m.name, status: m.status, createdAt: m.created_at, endedAt: m.ended_at, result: parse(m.result), config: parse(m.config, {}), abandonedReason: m.abandoned_reason },
    score: st.innings.map((i) => ({ number: i.number, team: st.teams[i.batting]?.name, runs: i.runs, wickets: i.wickets, overs: i.overs, status: i.status, extras: i.extras })),
    members, events, submissions, problems: checkMatch(m.id),
  };
}

// Lobbies nobody started: abandoned after this many days without activity.
export function staleLobbies(days) {
  const cutoff = Date.now() - days * 86400000;
  return all(`SELECT m.id FROM matches m WHERE m.status = 'lobby' AND m.created_at < ? AND COALESCE((SELECT MAX(created_at) FROM audit a WHERE a.match_id = m.id), 0) < ?`, cutoff, cutoff).map((r) => r.id);
}

// ---------- notifications for staff ----------
export const addNotification = (kind, text) => Number(run('INSERT INTO admin_notifications (at, kind, text) VALUES (?,?,?)', Date.now(), kind, String(text).slice(0, 1000)).lastInsertRowid);
export const listNotifications = (limit = 50) => all('SELECT * FROM admin_notifications ORDER BY id DESC LIMIT ?', limit).map((n) => ({ id: n.id, at: n.at, kind: n.kind, text: n.text, read: !!n.read_at }));
export const markNotificationsRead = () => run('UPDATE admin_notifications SET read_at = ? WHERE read_at IS NULL', Date.now());

// ---------- overview ----------
export function overview() {
  const n = (sql, ...a) => get(sql, ...a).n;
  const day = Date.now() - 86400000;
  return {
    users: n('SELECT COUNT(*) AS n FROM users WHERE is_bot = 0 AND is_ghost = 0'), registered: n('SELECT COUNT(*) AS n FROM users WHERE is_bot = 0 AND is_ghost = 0 AND is_guest = 0'),
    suspended: n(`SELECT COUNT(*) AS n FROM users WHERE status = 'suspended'`), activeToday: n('SELECT COUNT(*) AS n FROM users WHERE last_seen_at > ?', day),
    matches: Object.fromEntries(Object.entries(GROUPS).map(([g, st]) => [g, n(`SELECT COUNT(*) AS n FROM matches WHERE status IN (${st.map(() => '?').join(',')})`, ...st)])),
    tournaments: n(`SELECT COUNT(*) AS n FROM tournaments WHERE status = 'active'`),
    errorsToday: n('SELECT COUNT(*) AS n FROM error_log WHERE at > ?', day),
    unread: n('SELECT COUNT(*) AS n FROM admin_notifications WHERE read_at IS NULL'),
  };
}
