// The game rules. Every function here is server-authoritative: clients only send intents.
//
// An over works like this: the bowler and the batter each lock in six numbers, in any order.
// Neither can see the other's numbers. The moment the second one locks in, the server compares
// them ball by ball inside one transaction, records every ball, and reveals the whole over.
import crypto from 'node:crypto';
import { get, all, run, tx } from './db.js';
import { checkDigits, isDotOver, isTest } from './rules.js';
import { selectXI } from './aibrain.js';
import { getTeam } from './cricketdb.js';

export class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };
const now = () => Date.now();

export const DEFAULT_CONFIG = {
  mode: 'auto',             // 'auto' (no umpire, fully automatic) | 'umpire'
  play: 'over',             // 'over' (lock in the rest of the over at once) | 'ball' (one number per ball)
  format: 'custom',         // 't20' | 'odi' | 'custom' (limited overs) | 'test'
  // Test match settings (ignored for limited-overs matches)
  days: 3,
  sessionsPerDay: 3,
  oversPerSession: 15,
  inningsPerTeam: 2,
  sessionMinutes: 0,        // optional time limit shown as a countdown; 0 = off
  lunch: true, tea: true, stumps: true, // pause for these breaks (off = roll straight into the next session)
  followOn: true,
  // Who plays: 'team' (multiplayer teams), 'pvp' (one human v one human), 'ai' (one human v the AI)
  participation: 'team',
  teamSource: 'custom',     // 'custom' | 'real' (international/IPL teams; 1v1 only)
  aiLevel: 'medium',        // easy | medium | hard | expert
  aiPersonality: 'strategic', // strategic | aggressive | defensive | unpredictable (independent of level)
  xiSize: 11,               // players picked from a real squad
  allowSameTeam: false,
  quick: false,             // created from Quick Match (labels only; same engine)
  overs: 2,
  wickets: 3,
  playersPerTeam: 11,
  superOver: true,
  noConsecutive: true,       // a bowler can't bowl two overs in a row (when the team has another bowler)
  spectators: 'open',        // 'open' (watch + chat) | 'watch' (watch only)
};

export function sanitizeConfig(input = {}, base = DEFAULT_CONFIG) {
  const c = { ...base };
  const int = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  c.overs = int(input.overs, 1, 50, c.overs);
  c.wickets = int(input.wickets, 1, 20, input.format === 'test' && !('wickets' in input) ? 10 : c.wickets);
  c.playersPerTeam = int(input.playersPerTeam, 1, 15, c.playersPerTeam);
  if (input.mode === 'auto' || input.mode === 'umpire') c.mode = input.mode;
  if (input.play === 'over' || input.play === 'ball') c.play = input.play;
  if (['t20', 'odi', 'custom', 'test'].includes(input.format)) c.format = input.format;
  if (c.format === 't20') c.overs = 20;
  if (c.format === 'odi') c.overs = 50;
  c.days = int(input.days, 1, 5, c.days);
  c.sessionsPerDay = int(input.sessionsPerDay, 1, 4, c.sessionsPerDay);
  c.oversPerSession = int(input.oversPerSession, 1, 90, c.oversPerSession);
  c.inningsPerTeam = int(input.inningsPerTeam, 1, 2, c.inningsPerTeam);
  c.sessionMinutes = int(input.sessionMinutes, 0, 240, c.sessionMinutes);
  for (const k of ['lunch', 'tea', 'stumps', 'followOn', 'allowSameTeam', 'quick']) if (k in input) c[k] = !!input[k];
  if (['team', 'pvp', 'ai'].includes(input.participation)) c.participation = input.participation;
  if (['easy', 'medium', 'hard', 'expert'].includes(input.aiLevel)) c.aiLevel = input.aiLevel;
  if (['strategic', 'aggressive', 'defensive', 'unpredictable'].includes(input.aiPersonality)) c.aiPersonality = input.aiPersonality;
  c.teamSource = input.teamSource === 'real' && c.participation !== 'team' ? 'real' : 'custom';
  c.xiSize = int(input.xiSize, 2, 11, c.xiSize);
  if (c.participation !== 'team') c.playersPerTeam = c.teamSource === 'real' ? c.xiSize : 1; // 1v1
  if (c.participation === 'ai') c.mode = 'auto'; // an umpire would see the bowler's numbers; not needed against the AI
  if (input.spectators === 'open' || input.spectators === 'watch') c.spectators = input.spectators;
  for (const k of ['superOver', 'noConsecutive']) if (k in input) c[k] = !!input[k];
  return c;
}

// ---------- reads ----------
export function loadMatch(id) {
  const m = get('SELECT * FROM matches WHERE id = ?', id);
  if (!m) fail('Match not found.');
  // Matches created before modes existed always had an umpire.
  m.config = { ...DEFAULT_CONFIG, mode: 'umpire', format: 'custom', ...JSON.parse(m.config) };
  delete m.config.freshSetAfterWicket; // retired: overs are always six legal balls now
  m.result = m.result ? JSON.parse(m.result) : null;
  return m;
}
const teamName = (m, t) => (t === 'A' ? m.team_a : m.team_b);
const other = (t) => (t === 'A' ? 'B' : 'A');
const userName = (id) => get('SELECT display_name FROM users WHERE id = ?', id)?.display_name || 'Someone';
export const isUmpire = (m, uid) => m.config.mode === 'umpire' && m.umpire_id === uid;
const isHost = (m, uid) => m.umpire_id === uid;
const captainOf = (m, team) => (team === 'A' ? m.captain_a : m.captain_b);
const memberOf = (matchId, uid) => get('SELECT * FROM members WHERE match_id = ? AND user_id = ?', matchId, uid);

// The people (or roster players) who bat and bowl for a team. Controllers, who play on their behalf, aren't included.
export const teamPlayers = (matchId, team) =>
  all(`SELECT m.user_id AS id, u.display_name AS name, m.bat_order, m.bowl_order, m.bowls FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.match_id = ? AND m.team = ? AND m.banned = 0 AND m.kind = 'player' ORDER BY m.bat_order, m.joined_at`, matchId, team);
const controllerMember = (matchId, team) =>
  get(`SELECT * FROM members WHERE match_id = ? AND team = ? AND kind = 'controller' AND banned = 0`, matchId, team);
// Who submits for this player: themselves, or the human/AI controlling their roster.
export function controllerOf(matchId, playerId) {
  return get('SELECT controller_id FROM members WHERE match_id = ? AND user_id = ?', matchId, playerId)?.controller_id || null;
}
const actsFor = (matchId, userId, playerId) => !!playerId && (userId === playerId || controllerOf(matchId, playerId) === userId);
const bowlingLineup = (matchId, team) => {
  const squad = teamPlayers(matchId, team);
  const picked = squad.filter((p) => p.bowls).sort((a, b) => a.bowl_order - b.bowl_order || a.bat_order - b.bat_order);
  return picked.length ? picked : squad;
};

export const latestInnings = (matchId) =>
  get('SELECT * FROM innings WHERE match_id = ? ORDER BY number DESC LIMIT 1', matchId);

export function totals(inningsId) {
  const t = get(`SELECT COALESCE(SUM(runs),0) AS runs, COALESCE(SUM(is_wicket),0) AS wickets, COUNT(*) AS balls
                 FROM balls WHERE innings_id = ? AND voided = 0`, inningsId);
  const inn = get('SELECT extras FROM innings WHERE id = ?', inningsId);
  return { runs: t.runs + (inn?.extras || 0), wickets: t.wickets, balls: t.balls };
}
const openSet = (inningsId) => get(`SELECT * FROM sets WHERE innings_id = ? AND status = 'open'`, inningsId);
const lastOverBowler = (inningsId) =>
  get(`SELECT bowler_id FROM balls WHERE innings_id = ? AND voided = 0 ORDER BY ball_no DESC LIMIT 1`, inningsId)?.bowler_id || null;
// Balls still to come in the current over: six minus the legal deliveries already bowled in it,
// never more than the innings has left. Ball-by-ball matches always ask for one.
function ballsLeftInOver(inn) {
  const t = totals(inn.id);
  return Math.min(6 - (t.balls % 6), inn.max_balls - t.balls);
}
function capFor(m, inn) {
  let n = ballsLeftInOver(inn);
  // In a Test, a submission never runs past the end of the session (the over carries on next session).
  if (isTest(m.config)) n = Math.min(n, sessionQuota(m) - sessionBalls(m));
  return m.config.play === 'ball' ? Math.min(1, n) : n;
}
const atOverBoundary = (inn) => totals(inn.id).balls % 6 === 0;

export const oversText = (balls) => `${Math.floor(balls / 6)}.${balls % 6}`;
export const ballLabel = (n) => `${Math.floor((n - 1) / 6)}.${((n - 1) % 6) + 1}`;

// ---------- effects collected for the socket layer ----------
export const newCtx = () => ({ notify: [], fx: [], kicked: [] });

export function announce(matchId, text, meta = null, channel = 'public', kind = 'event') {
  run(`INSERT INTO messages (match_id, channel, user_id, kind, text, meta, created_at) VALUES (?,?,?,?,?,?,?)`,
    matchId, channel, null, kind, text, meta ? JSON.stringify(meta) : null, now());
}
// Every lineup change, umpire decision and correction goes into the match history.
function record(matchId, userId, action, text, detail = {}, say = true) {
  run('INSERT INTO audit (match_id, user_id, action, detail, text, created_at) VALUES (?,?,?,?,?,?)',
    matchId, userId, action, JSON.stringify(detail), text, now());
  if (say) announce(matchId, text, { type: 'history' }, 'public', 'system');
}

// ---------- match creation & membership ----------
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    const code = Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    if (!get('SELECT 1 FROM matches WHERE id = ?', code)) return code;
  }
}

export function createMatch(userId, { name, teamA, teamB, config, copyFrom, realTeams, quick }) {
  const id = newCode();
  const cfg = sanitizeConfig(quick ? { ...config, participation: 'ai', quick: true } : config);
  // Real international/IPL teams are only for one-v-one matches.
  if (realTeams && cfg.participation === 'team') fail('Real cricket teams are only available in one-v-one matches.');
  if (cfg.teamSource === 'real') {
    if (!realTeams?.A || !realTeams?.B) fail('Pick both teams.');
    if (realTeams.A === realTeams.B && !cfg.allowSameTeam) fail('Both sides picked the same team. Pick a different opponent or allow mirror matches.');
  }
  const realA = cfg.teamSource === 'real' ? getTeam(realTeams.A) : null;
  const realB = cfg.teamSource === 'real' ? getTeam(realTeams.B) : null;
  if (cfg.teamSource === 'real' && (!realA || !realB)) fail('One of those teams no longer exists. Pick again.');
  if (cfg.participation !== 'team') copyFrom = null;
  tx(() => {
    let a = (realA?.name || teamA || 'Team A').slice(0, 30), b = (realB?.name || teamB || 'Team B').slice(0, 30);
    if (realA && realB && realA.id === realB.id) { a = `${realA.name} (1)`.slice(0, 30); b = `${realB.name} (2)`.slice(0, 30); }
    const src = copyFrom ? get('SELECT * FROM matches WHERE id = ?', String(copyFrom).toUpperCase()) : null;
    if (copyFrom && (!src || !memberOf(src.id, userId))) fail('You can only reuse squads from a match you were in.');
    if (src && !teamA) a = src.team_a;
    if (src && !teamB) b = src.team_b;
    run(`INSERT INTO matches (id, name, umpire_id, config, team_a, team_b, toss_bat, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      id, (name || `${a} v ${b}`).slice(0, 60), userId, JSON.stringify(cfg), a, b, 'A', now());
    run('INSERT INTO members (match_id, user_id, joined_at) VALUES (?,?,?)', id, userId, now());
    if (src) {
      // Team selection: bring both squads over with their order and captains.
      const rows = all('SELECT * FROM members WHERE match_id = ? AND team IS NOT NULL AND banned = 0', src.id);
      for (const r of rows) {
        if (r.user_id === userId) run('UPDATE members SET team = ?, bat_order = ?, bowl_order = ?, bowls = ? WHERE match_id = ? AND user_id = ?', r.team, r.bat_order, r.bowl_order, r.bowls, id, userId);
        else run('INSERT INTO members (match_id, user_id, team, bat_order, bowl_order, bowls, joined_at) VALUES (?,?,?,?,?,?,?)', id, r.user_id, r.team, r.bat_order, r.bowl_order, r.bowls, now());
      }
      run('UPDATE matches SET captain_a = ?, captain_b = ? WHERE id = ?', src.captain_a, src.captain_b, id);
      fixCaptains(id);
    }
    if (cfg.participation !== 'team') setupOneVOne(id, userId, cfg, realA, realB);
    if (quick) startQuick(id, userId, quick.start);
    announce(id, cfg.participation === 'ai'
      ? `Match created: you v the AI (${cfg.aiLevel}).`
      : cfg.mode === 'umpire'
        ? 'Match created with an umpire. Share the link so friends can join.'
        : 'Match created. No umpire needed: the game runs itself. Share the link so friends can join.', null, 'public', 'system');
  });
  return id;
}

// ---------- one-v-one: real squads, roster players, the AI ----------
const ROLE_RANK = { wk: 0, bat: 1, ar: 2, bowl: 3 };
const teamMeta = (t, cat) => t ? ({
  source: 'real', teamId: t.id, category: cat || t.category, name: t.name, short: t.short, color: t.color, logo: t.logo, country: t.country,
  squad: t.squad.map((p) => ({ playerId: p.id, name: p.name, role: p.role, image: p.image })), squadSyncedAt: t.updatedAt, placeholders: !t.squad.length,
}) : null;

// A sensible default XI: a keeper, batters, all-rounders, then bowlers.
export function defaultXI(squad, size) {
  const by = (r) => squad.filter((p) => p.role === r);
  const pick = [...by('wk').slice(0, 1), ...by('bat').slice(0, 4), ...by('ar').slice(0, 2), ...by('bowl').slice(0, 4)];
  for (const p of squad) if (pick.length < size && !pick.includes(p)) pick.push(p);
  return pick.slice(0, size);
}

// Create the roster players for a team (replacing any previous XI). Lobby only.
function setXI(matchId, team, players, controllerId) {
  for (const old of all(`SELECT m.user_id FROM members m JOIN users u ON u.id = m.user_id WHERE m.match_id = ? AND m.team = ? AND u.is_ghost = 1`, matchId, team)) {
    run('DELETE FROM members WHERE match_id = ? AND user_id = ?', matchId, old.user_id);
  }
  const ordered = [...players].sort((a, b) => (ROLE_RANK[a.role] ?? 1) - (ROLE_RANK[b.role] ?? 1));
  const bowlers = [...players].filter((p) => p.role === 'bowl' || p.role === 'ar').sort((a, b) => (a.role === 'bowl' ? 0 : 1) - (b.role === 'bowl' ? 0 : 1));
  const bowlSet = bowlers.length >= 2 ? bowlers : players;
  ordered.forEach((p, i) => {
    const uid = crypto.randomUUID();
    run('INSERT INTO users (id, display_name, is_guest, is_ghost, player_id, created_at) VALUES (?,?,1,1,?,?)', uid, p.name.slice(0, 40), p.playerId || null, now());
    const bi = bowlSet.indexOf(p);
    run(`INSERT INTO members (match_id, user_id, team, bat_order, bowl_order, bowls, kind, controller_id, joined_at) VALUES (?,?,?,?,?,?, 'player', ?, ?)`,
      matchId, uid, team, i, bi >= 0 ? bi : 99, bi >= 0 ? 1 : 0, controllerId || null, now());
  });
}

function squadFor(meta, size) {
  if (meta.squad.length >= 2) return meta.squad;
  // No synced squad: clearly labelled stand-ins, never made-up real names.
  return Array.from({ length: size }, (_, i) => ({ playerId: null, name: `${meta.short || meta.name} player ${i + 1}`, role: i < 6 ? 'bat' : 'bowl' }));
}

function addController(matchId, team, userId) {
  const exists = memberOf(matchId, userId);
  if (exists) run(`UPDATE members SET team = ?, kind = 'controller', bowls = 0 WHERE match_id = ? AND user_id = ?`, team, matchId, userId);
  else run(`INSERT INTO members (match_id, user_id, team, kind, bowls, joined_at) VALUES (?,?,?, 'controller', 0, ?)`, matchId, userId, team, now());
  run(`UPDATE members SET controller_id = ? WHERE match_id = ? AND team = ? AND kind = 'player'`, userId, matchId, team);
  fixCaptains(matchId);
}

function createBot(cfg, label) {
  const id = crypto.randomUUID();
  const cap = (x) => x[0].toUpperCase() + x.slice(1);
  const pers = cfg.aiPersonality || 'strategic';
  const name = pers === 'strategic' ? `${label} AI (${cap(cfg.aiLevel)})` : `${label} AI (${cap(cfg.aiLevel)}, ${cap(pers)})`;
  run('INSERT INTO users (id, display_name, is_guest, is_bot, created_at) VALUES (?,?,1,1,?)', id, name.slice(0, 40), now());
  return id;
}

function setupOneVOne(matchId, userId, cfg, realA, realB) {
  const human = cfg.mode !== 'umpire'; // with an umpire, the creator umpires and two others play
  if (cfg.teamSource === 'real') {
    const metaA = teamMeta(realA), metaB = teamMeta(realB);
    run('UPDATE matches SET team_a_meta = ?, team_b_meta = ? WHERE id = ?', JSON.stringify(metaA), JSON.stringify(metaB), matchId);
    run('INSERT INTO team_selections (match_id, side, team_id, team_name, user_id, created_at) VALUES (?,?,?,?,?,?)', matchId, 'A', realA.id, realA.name, userId, now());
    run('INSERT INTO team_selections (match_id, side, team_id, team_name, user_id, created_at) VALUES (?,?,?,?,?,?)', matchId, 'B', realB.id, realB.name, userId, now());
    setXI(matchId, 'A', defaultXI(squadFor(metaA, cfg.xiSize), cfg.xiSize), null);
    // The AI picks its own XI for the format and its personality; a human side starts from the default XI.
    const squadB = squadFor(metaB, cfg.xiSize);
    setXI(matchId, 'B', cfg.participation === 'ai' ? selectXI(squadB, cfg.xiSize, cfg.format, cfg.aiPersonality) : defaultXI(squadB, cfg.xiSize), null);
    if (human) addController(matchId, 'A', userId);
    if (cfg.participation === 'ai') addController(matchId, 'B', createBot(cfg, realB.short || realB.name));
  } else {
    if (human) run(`UPDATE members SET team = 'A' WHERE match_id = ? AND user_id = ?`, matchId, userId);
    if (cfg.participation === 'ai') {
      const bot = createBot(cfg, 'The');
      run(`INSERT INTO members (match_id, user_id, team, joined_at) VALUES (?,?, 'B', ?)`, matchId, bot, now());
    }
  }
  fixCaptains(matchId);
}

// Quick Match: both lineups go in as picked (the default XI), then either the normal toss
// or straight into the match with the player's own choice of batting or bowling first.
function startQuick(matchId, userId, start) {
  run('UPDATE matches SET confirm_a = ?, confirm_b = ? WHERE id = ?', now(), now(), matchId);
  const m = loadMatch(matchId);
  if (start === 'bat' || start === 'bowl') {
    run(`UPDATE matches SET toss_caller = 'A', toss_call = 'skipped', toss_result = 'skipped', toss_winner = 'A', toss_decision = ?, toss_bat = ?, toss_at = ? WHERE id = ?`,
      start, start === 'bat' ? 'A' : 'B', now(), matchId);
    record(matchId, userId, 'quick_start', `Quick match: ${userName(userId)} chose to ${start} first (no toss).`, { start }, true);
    beginMatch(loadMatch(matchId), userId, newCtx());
  } else {
    const caller = crypto.randomInt(2) === 0 ? 'A' : 'B';
    run('UPDATE matches SET toss_caller = ? WHERE id = ?', caller, matchId);
    announce(matchId, `Quick match: lineups are set. ${teamName(m, caller)} call the toss.`, { type: 'toss_ready' });
  }
}

// A second human takes the open side in a one-v-one real-team match.
function claimSeat(m, userId, team) {
  if (controllerMember(m.id, team)) fail(`${teamName(m, team)} already has a player.`);
  const mem = memberOf(m.id, userId);
  if (mem?.kind === 'controller') fail('You are already playing in this match.');
  if (m.config.mode === 'umpire' && m.umpire_id === userId) fail('You are umpiring this match.');
  addController(m.id, team, userId);
  lineupChanged(m.id, team, `${userName(userId)} is playing as ${teamName(m, team)}`);
}

export function joinMatch(userId, matchId) {
  const m = loadMatch(matchId);
  const mem = memberOf(matchId, userId);
  if (mem?.banned) fail('You were removed from this match.');
  if (!mem) {
    run('INSERT INTO members (match_id, user_id, joined_at) VALUES (?,?,?)', matchId, userId, now());
    if (m.status === 'lobby') announce(matchId, `${userName(userId)} joined.`, null, 'public', 'system');
    return true;
  }
  return false;
}

// Every team with players has a captain; the first player in becomes captain by default.
function fixCaptains(matchId) {
  const m = get('SELECT captain_a, captain_b FROM matches WHERE id = ?', matchId);
  for (const t of ['A', 'B']) {
    // A team run by a controller (a human or the AI managing a real squad) is captained by that controller.
    const ctl = controllerMember(matchId, t);
    if (ctl) { run(`UPDATE matches SET ${t === 'A' ? 'captain_a' : 'captain_b'} = ? WHERE id = ?`, ctl.user_id, matchId); continue; }
    const squad = teamPlayers(matchId, t);
    const cap = t === 'A' ? m.captain_a : m.captain_b;
    if (!squad.some((p) => p.id === cap)) {
      run(`UPDATE matches SET ${t === 'A' ? 'captain_a' : 'captain_b'} = ? WHERE id = ?`, squad[0]?.id || null, matchId);
    }
  }
}

// ---------- lineup confirmation ----------
const confirmCol = (team) => (team === 'A' ? 'confirm_a' : 'confirm_b');
const tossDone = (m) => !!m.toss_result;
// Squads are fixed once the coin has been tossed.
function requireSquadsOpen(m) {
  if (m.status !== 'lobby') fail('Squads are locked once the match has started.');
  if (tossDone(m)) fail('Squads are locked after the toss.');
}
// Any change to a confirmed lineup before the toss means the captain has to confirm again.
function lineupChanged(matchId, team, why) {
  const m = loadMatch(matchId);
  if (m.status !== 'lobby' || tossDone(m) || !team) return;
  const was = team === 'A' ? m.confirm_a : m.confirm_b;
  if (was) {
    run(`UPDATE matches SET ${confirmCol(team)} = NULL, toss_caller = NULL WHERE id = ?`, matchId);
    record(matchId, m.umpire_id, 'unconfirm', `${teamName(m, team)}'s lineup changed (${why}), so it needs confirming again.`, { team }, true);
  } else if (m.toss_caller) run('UPDATE matches SET toss_caller = NULL WHERE id = ?', matchId);
}

export function confirmLineup(userId, matchId, team, ctx) {
  return tx(() => {
    const m = loadMatch(matchId);
    if (team !== 'A' && team !== 'B') fail('Pick a team.');
    if (captainOf(m, team) !== userId) fail(`Only ${teamName(m, team)}'s captain can confirm their lineup.`);
    if (m.status !== 'lobby' || tossDone(m)) fail('Lineups are already locked in for this match.');
    if ((team === 'A' ? m.confirm_a : m.confirm_b)) fail('Your lineup is already confirmed.');
    const squad = teamPlayers(matchId, team);
    if (!squad.length) fail('Your team needs at least one player.');
    run(`UPDATE matches SET ${confirmCol(team)} = ? WHERE id = ?`, now(), matchId);
    const order = squad.map((p) => p.name).join(', ');
    const bowlers = bowlingLineup(matchId, team).map((p) => p.name).join(', ');
    record(matchId, userId, 'confirm', `✅ ${teamName(m, team)} confirmed their lineup. Batting: ${order}. Bowling: ${bowlers}.`, { team });
    const after = loadMatch(matchId);
    if (after.confirm_a && after.confirm_b && !after.toss_caller) {
      // Both in: the system picks which captain calls the toss.
      const caller = crypto.randomInt(2) === 0 ? 'A' : 'B';
      run('UPDATE matches SET toss_caller = ? WHERE id = ?', caller, matchId);
      announce(matchId, `Both lineups confirmed. Ready for the toss: ${teamName(m, caller)}'s captain, ${userName(captainOf(after, caller))}, will call.`, { type: 'toss_ready' });
      ctx.notify.push({ userId: captainOf(after, caller), title: 'Call the toss', body: 'Heads or tails?', kind: 'bat' });
    } else {
      const other_ = other(team);
      if (captainOf(after, other_)) ctx.notify.push({ userId: captainOf(after, other_), title: `${teamName(m, team)} have confirmed`, body: 'Confirm your lineup to unlock the toss.', kind: 'info' });
    }
  });
}

// ---------- the toss ----------
export function callToss(userId, matchId, call, ctx) {
  return tx(() => {
    const m = loadMatch(matchId);
    if (m.status !== 'lobby') fail('The match has already started.');
    if (!m.confirm_a || !m.confirm_b || !m.toss_caller) fail('Both captains need to confirm their lineups before the toss.');
    if (m.toss_call) fail('The toss has already been called.');
    if (captainOf(m, m.toss_caller) !== userId) fail(`${userName(captainOf(m, m.toss_caller))} is calling this toss.`);
    if (call !== 'heads' && call !== 'tails') fail('Call heads or tails.');
    const result = crypto.randomInt(2) === 0 ? 'heads' : 'tails';
    const winner = call === result ? m.toss_caller : other(m.toss_caller);
    run('UPDATE matches SET toss_call = ?, toss_result = ?, toss_winner = ?, toss_at = ? WHERE id = ?', call, result, winner, now(), matchId);
    record(matchId, userId, 'toss', `🪙 ${userName(userId)} called ${call}. It's ${result}! ${teamName(m, winner)} win the toss.`, { call, result, winner }, false);
    announce(matchId, `🪙 ${teamName(m, m.toss_caller)} called ${call}. It's ${result}! ${teamName(m, winner)} win the toss.`, { type: 'toss' });
    ctx.fx.push({ type: 'toss', call, result, winner, winnerName: teamName(m, winner) });
    ctx.notify.push({ userId: captainOf(m, winner), title: 'You won the toss', body: 'Bat or bowl first?', kind: 'bat' });
  });
}

export function decideToss(userId, matchId, decision, ctx) {
  return tx(() => {
    const m = loadMatch(matchId);
    if (m.status !== 'lobby') fail('The match has already started.');
    if (!m.toss_winner) fail("The toss hasn't happened yet.");
    if (m.toss_decision) fail('The decision has already been made.');
    if (captainOf(m, m.toss_winner) !== userId) fail(`Only ${teamName(m, m.toss_winner)}'s captain decides.`);
    if (decision !== 'bat' && decision !== 'bowl') fail('Choose bat or bowl.');
    const batFirst = decision === 'bat' ? m.toss_winner : other(m.toss_winner);
    run('UPDATE matches SET toss_decision = ?, toss_bat = ? WHERE id = ?', decision, batFirst, matchId);
    record(matchId, userId, 'toss_decision', `${teamName(m, m.toss_winner)} won the toss and chose to ${decision} first.`, { decision });
    if (m.config.mode === 'auto') beginMatch(loadMatch(matchId), userId, ctx);
    else ctx.notify.push({ userId: m.umpire_id, title: 'Ready to start', body: `${teamName(m, batFirst)} bat first. Start the match when everyone's ready.`, kind: 'umpire' });
  });
}

function beginMatch(m, userId, ctx) {
  fixCaptains(m.id);
  run(`UPDATE matches SET status = 'live', started_at = ? WHERE id = ?`, now(), m.id);
  if (isTest(m.config)) startSessionRow(m, 1, 1);
  record(m.id, userId, 'start', 'The match is live.', {}, false);
  createInnings(loadMatch(m.id), 1, ctx);
}

function putInTeam(m, uid, team) {
  const mem = memberOf(m.id, uid);
  if (!mem || mem.banned) fail('That person is not in this match.');
  if (team && mem.team !== team && teamPlayers(m.id, team).length >= m.config.playersPerTeam) fail(`${teamName(m, team)} is full.`);
  const inn = latestInnings(m.id);
  if (inn && inn.status === 'live' && (inn.striker_id === uid || inn.bowler_id === uid)) {
    if (openSet(inn.id)) fail(`${userName(uid)} is in the middle of an over.`);
  }
  const bat = (get('SELECT MAX(bat_order) AS o FROM members WHERE match_id = ? AND team = ?', m.id, team)?.o ?? -1) + 1;
  const bowl = (get('SELECT MAX(bowl_order) AS o FROM members WHERE match_id = ? AND team = ?', m.id, team)?.o ?? -1) + 1;
  run('UPDATE members SET team = ?, bat_order = ?, bowl_order = ?, bowls = 1 WHERE match_id = ? AND user_id = ?', team, bat, bowl, m.id, uid);
  fixCaptains(m.id);
  if (mem.team !== team) {
    if (mem.team) lineupChanged(m.id, mem.team, `${userName(uid)} left`);
    if (team) lineupChanged(m.id, team, `${userName(uid)} joined`);
  }
  if (inn && inn.status === 'live') refreshCurrent(loadMatch(m.id), inn);
}

// ---------- choosing who's on ----------
function dismissals(inningsId) {
  const map = new Map();
  for (const r of all('SELECT batter_id, SUM(is_wicket) AS n FROM balls WHERE innings_id = ? AND voided = 0 GROUP BY batter_id', inningsId)) map.set(r.batter_id, r.n);
  return map;
}
// Next batter in the captain's order who has been out the fewest times (so small squads cycle).
function pickStriker(m, inn) {
  const order = teamPlayers(m.id, inn.batting);
  if (!order.length) fail(`${teamName(m, inn.batting)} has no players.`);
  const d = dismissals(inn.id);
  return order.reduce((best, p) => ((d.get(p.id) || 0) < (d.get(best.id) || 0) ? p : best), order[0]).id;
}
// Next bowler in the captain's bowling order, never the previous over's bowler if that rule is on.
function pickBowler(m, inn, last) {
  const lineup = bowlingLineup(m.id, inn.bowling);
  if (!lineup.length) fail(`${teamName(m, inn.bowling)} has no players.`);
  const start = last ? lineup.findIndex((p) => p.id === last) + 1 : 0;
  for (let k = 0; k < lineup.length; k++) {
    const p = lineup[(start + k) % lineup.length];
    if (!(m.config.noConsecutive && p.id === last && lineupSize(m, inn) > 1)) return p.id;
  }
  return lineup[0].id;
}
const lineupSize = (m, inn) => bowlingLineup(m.id, inn.bowling).length;

// Has the batter on strike not started yet? (Only then can the captain swap who's in.)
function strikerFresh(inn) {
  if (openSet(inn.id)) return false;
  const t = totals(inn.id);
  return !get('SELECT 1 FROM balls WHERE innings_id = ? AND batter_id = ? AND stint = ? AND voided = 0', inn.id, inn.striker_id, t.wickets);
}

// After lineup changes, make sure the people "on" are still valid choices.
function refreshCurrent(m, inn) {
  if (inn.status !== 'live' || openSet(inn.id)) return;
  const batters = teamPlayers(m.id, inn.batting).map((p) => p.id);
  if (!batters.includes(inn.striker_id) || strikerFresh(inn)) {
    const s = pickStriker(m, inn);
    if (s !== inn.striker_id) run('UPDATE innings SET striker_id = ? WHERE id = ?', s, inn.id);
  }
  const bowlers = bowlingLineup(m.id, inn.bowling).map((p) => p.id);
  if (!bowlers.includes(inn.bowler_id) && atOverBoundary(inn)) run('UPDATE innings SET bowler_id = ? WHERE id = ?', pickBowler(m, inn, lastOverBowler(inn.id)), inn.id);
}

function overCall(m, inn, ctx, why = '') {
  const mm = loadMatch(m.id);
  const cur = latestInnings(m.id);
  if (mm.status !== 'live' || !cur || cur.status !== 'live') return;
  const n = capFor(mm, cur);
  const what = n === 1 ? 'Pick your number' : `Lock in ${n} numbers`;
  ctx.notify.push({ userId: cur.bowler_id, title: 'Your turn: bowl', body: `${why}${what} against ${userName(cur.striker_id)}.`, kind: 'bowl' });
  ctx.notify.push({ userId: cur.striker_id, title: 'Your turn: bat', body: `${why}${what} against ${userName(cur.bowler_id)}.`, kind: 'bat' });
}

const teamTotal = (matchId, team) =>
  all('SELECT id FROM innings WHERE match_id = ? AND batting = ?', matchId, team).reduce((s, i) => s + totals(i.id).runs, 0);
const NO_LIMIT = 1_000_000_000; // Test innings have no over limit

function createInnings(m, number, ctx, opts = {}) {
  if (isTest(m.config)) return createTestInnings(m, number, ctx, opts);
  const prev = number > 1 ? get('SELECT * FROM innings WHERE match_id = ? AND number = ?', m.id, number - 1) : null;
  const superOver = number >= 3;
  let batting, target = null;
  if (number === 1) batting = m.toss_bat;
  else if (number === 2) batting = other(prev.batting);
  else if (number === 3) batting = get('SELECT batting FROM innings WHERE match_id = ? AND number = 2', m.id).batting;
  else batting = other(prev.batting);
  if (number === 2 || number === 4) target = totals(prev.id).runs + 1;
  const maxBalls = superOver ? 6 : m.config.overs * 6;
  const maxWickets = superOver ? Math.min(2, m.config.wickets) : m.config.wickets;
  insertInnings(m, number, batting, target, maxBalls, maxWickets, superOver, false);
  const label = superOver ? `Super over (${number === 3 ? 'first' : 'second'} half)` : number === 1 ? 'First innings' : 'Second innings';
  const inn = latestInnings(m.id);
  announce(m.id, `${label}: ${teamName(m, batting)} bat${target ? `, needing ${target} to win` : ''}. ${userName(inn.striker_id)} faces ${userName(inn.bowler_id)}.`, { type: 'innings', number });
  overCall(m, null, ctx);
}

function insertInnings(m, number, batting, target, maxBalls, maxWickets, superOver, followOn) {
  const draft = { id: -1, batting, bowling: other(batting) };
  const striker = pickStriker(m, draft);
  const bowler = pickBowler(m, draft, null);
  run(`INSERT INTO innings (match_id, number, batting, bowling, max_balls, max_wickets, target, super_over, follow_on, striker_id, bowler_id, started_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, m.id, number, batting, other(batting), maxBalls, maxWickets, target, superOver ? 1 : 0, followOn ? 1 : 0, striker, bowler, now());
}

// ---------- Test match innings ----------
const ORDINAL = ['', 'First', 'Second', 'Third', 'Fourth'];
function createTestInnings(m, number, ctx, { followOn = false } = {}) {
  const inn = (k) => get('SELECT * FROM innings WHERE match_id = ? AND number = ?', m.id, k);
  let batting;
  if (number === 1) batting = m.toss_bat;
  else if (number === 2) batting = other(inn(1).batting);
  else if (number === 3) batting = followOn ? inn(2).batting : inn(1).batting;
  else batting = other(inn(3).batting);
  let target = null;
  const last = m.config.inningsPerTeam === 1 ? 2 : 4;
  if (number === last) target = Math.max(1, teamTotal(m.id, other(batting)) - teamTotal(m.id, batting) + 1);
  insertInnings(m, number, batting, target, NO_LIMIT, m.config.wickets, false, followOn);
  const cur = latestInnings(m.id);
  const fresh = loadMatch(m.id);
  announce(m.id, `Day ${fresh.test_day}, session ${fresh.test_session}. ${ORDINAL[number]} innings${followOn ? ' (follow-on)' : ''}: ${teamName(m, batting)} bat${target ? `, needing ${target} to win` : ''}. ${userName(cur.striker_id)} faces ${userName(cur.bowler_id)}.`, { type: 'innings', number });
  overCall(m, null, ctx);
}

// Normal Test follow-on margins, scaled to the match length.
export const followOnMargin = (cfg) => (cfg.days >= 5 ? 200 : cfg.days >= 3 ? 150 : cfg.days === 2 ? 100 : 75);
function followOnPending(m) {
  if (!isTest(m.config) || m.config.inningsPerTeam !== 2 || !m.config.followOn) return null;
  const rows = all('SELECT * FROM innings WHERE match_id = ? ORDER BY number', m.id);
  if (rows.length !== 2 || rows[1].status !== 'done') return null;
  const lead = totals(rows[0].id).runs - totals(rows[1].id).runs;
  return lead >= followOnMargin(m.config) ? { team: rows[0].batting, lead } : null;
}

export function startMatch(userId, matchId, ctx) {
  return tx(() => {
    const m = loadMatch(matchId);
    if (m.status !== 'lobby') fail('The match has already started.');
    if (!m.confirm_a || !m.confirm_b) fail('Both captains must confirm their lineups first.');
    if (!m.toss_decision) fail('Finish the toss first: the winning captain chooses to bat or bowl.');
    if (m.config.mode === 'umpire' ? !isUmpire(m, userId) : !(isHost(m, userId) || m.captain_a === userId || m.captain_b === userId))
      fail(m.config.mode === 'umpire' ? 'Only the umpire can start the match.' : 'Only the host or a captain can start the match.');
    beginMatch(m, userId, ctx);
  });
}

export function nextInnings(userId, matchId, ctx) {
  return tx(() => {
    const m = loadMatch(matchId);
    if (!isUmpire(m, userId)) fail('Only the umpire can start the next innings.');
    if (m.status !== 'innings_break') fail('There is no innings break right now.');
    if (followOnPending(m)) fail(`${teamName(m, followOnPending(m).team)}'s captain decides on the follow-on first.`);
    const inn = latestInnings(matchId);
    run(`UPDATE matches SET status = 'live' WHERE id = ?`, matchId);
    record(matchId, userId, 'next_innings', `The umpire started innings ${inn.number + 1}.`, {}, false);
    createInnings(m, inn.number + 1, ctx);
  });
}

// ---------- the over: both sides lock in their numbers ----------
const commit = (digits) => {
  const salt = crypto.randomBytes(8).toString('hex');
  return { salt, hash: crypto.createHash('sha256').update(`${digits}:${salt}`).digest('hex') };
};
// The bowler's numbers that count towards the repetition rule right now: those bowled in the
// over in progress since its start or since the last wicket in it, whichever is later.
// A wicket resets this count; it does not reset the over's legal-ball count.
function bowledThisOver(inn) {
  const t = totals(inn.id);
  if (t.balls % 6 === 0) return [];
  const overStart = t.balls - (t.balls % 6) + 1;
  const lastWicket = get('SELECT MAX(ball_no) AS n FROM balls WHERE innings_id = ? AND voided = 0 AND is_wicket = 1 AND ball_no >= ?', inn.id, overStart)?.n;
  const from = lastWicket ? lastWicket + 1 : overStart;
  return all('SELECT bowl_num FROM balls WHERE innings_id = ? AND voided = 0 AND ball_no >= ? ORDER BY ball_no', inn.id, from).map((r) => r.bowl_num);
}

export function submitOver(userId, matchId, seq, ctx) {
  return tx(() => {
    const m = loadMatch(matchId);
    if (m.status === 'suspended') fail('The match is suspended. It carries on when the host resumes it.');
    if (m.status === 'session_break' || m.status === 'day_break') fail('It\'s a break between sessions. Play resumes when the next session starts.');
    if (m.status !== 'live') fail('The match is not in play.');
    if (m.paused) fail('The umpire has paused the match.');
    const inn = latestInnings(matchId);
    if (!inn || inn.status !== 'live') fail('No innings in progress.');
    if (get(`SELECT 1 FROM dot_rules WHERE innings_id = ? AND status = 'pending'`, inn.id)) fail('Waiting for the umpire to rule on the dot-over requirement.');
    let set = openSet(inn.id);
    const bowlerId = set ? set.bowler_id : inn.bowler_id;
    const batterId = set ? set.batter_id : inn.striker_id;
    const role = actsFor(matchId, userId, bowlerId) ? 'bowl' : actsFor(matchId, userId, batterId) ? 'bat' : null;
    if (!role) fail("It isn't your turn.");
    // How many numbers this submission must have: one per ball still to come in this over (and session), or exactly one ball by ball.
    const need = set ? set.cap - set.used : capFor(m, inn);
    if (need < 1) fail('This session is over. Wait for the next one to start.');
    if (!Array.isArray(seq) || seq.length !== need || !seq.every((n) => Number.isInteger(n)))
      fail(need === 1 ? 'Pick exactly one number.' : `Enter exactly ${need} numbers: that's how many balls are left in this over.`);
    const problem = checkDigits(m.config, role, seq, role === 'bowl' ? bowledThisOver(inn) : []);
    if (problem) fail(problem);
    if (!set) {
      run(`INSERT INTO sets (innings_id, bowler_id, batter_id, seq, salt, hash, cap, created_at) VALUES (?,?,?,?,?,?,?,?)`,
        inn.id, bowlerId, batterId, '', '', '', need, now());
      set = openSet(inn.id);
    }
    const digits = seq.join('');
    const { salt, hash } = commit(digits);
    if (role === 'bowl') {
      if (set.seq) fail("You've already locked in. It can't be changed.");
      run('UPDATE sets SET seq = ?, salt = ?, hash = ?, bowl_at = ? WHERE id = ?', digits, salt, hash, now(), set.id);
    } else {
      if (set.bat_seq) fail("You've already locked in. It can't be changed.");
      run('UPDATE sets SET bat_seq = ?, bat_salt = ?, bat_hash = ?, bat_at = ? WHERE id = ?', digits, salt, hash, now(), set.id);
    }
    set = get('SELECT * FROM sets WHERE id = ?', set.id);
    if (m.config.play === 'over') announce(matchId, `🔒 ${userName(role === 'bowl' ? bowlerId : batterId)} has locked in.`, { type: 'locked', role, hash });
    if (role === 'bowl' && isUmpire(m, m.umpire_id) && !actsFor(matchId, m.umpire_id, batterId) && m.config.play === 'over')
      ctx.notify.push({ userId: m.umpire_id, title: 'Bowler locked in', body: `${userName(userId)}'s numbers are in your umpire panel.`, kind: 'info' });

    if (set.seq && set.bat_seq) reveal(m, inn, set, ctx);
    else {
      const waiting = role === 'bowl' ? batterId : bowlerId;
      ctx.notify.push({ userId: waiting, title: `${userName(role === 'bowl' ? bowlerId : batterId)} is locked in`, body: need === 1 ? 'Your turn: pick your number.' : `Your turn: lock in your ${need} numbers.`, kind: role === 'bowl' ? 'bat' : 'bowl' });
    }
  });
}

const activeRule = (inningsId, batterId) =>
  get(`SELECT * FROM dot_rules WHERE innings_id = ? AND batter_id = ? AND status = 'active'`, inningsId, batterId);
const resolveRule = (id, status, note = null) =>
  run('UPDATE dot_rules SET status = ?, resolved_at = ?, note = COALESCE(?, note) WHERE id = ?', status, now(), note, id);

function reveal(m, inn, set, ctx) {
  const bowl = set.seq.split('').map(Number);
  const bat = set.bat_seq.split('').map(Number);
  const start = totals(inn.id);
  const batter = userName(set.batter_id), bowler = userName(set.bowler_id);
  const test = isTest(m.config);
  const sIdx = test ? sessionIdx(m) : null;
  // (set.used is only non-zero for an over that was half-played under the very first one-ball-at-a-time rules.)
  let runs = start.runs, balls = start.balls, wickets = start.wickets, used = set.used, wicket = false;
  let pendingRule = false, newRule = false;
  const out = [];
  for (let i = set.used; i < set.cap; i++) {
    const pick = bat[i - set.used];
    wicket = pick === bowl[i];
    const r = wicket ? 0 : pick;
    balls += 1; runs += r; used += 1;
    const ins = run(`INSERT INTO balls (innings_id, set_id, set_index, ball_no, stint, batter_id, bowler_id, bowl_num, bat_num, runs, is_wicket, session_idx, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, inn.id, set.id, i, balls, start.wickets, set.batter_id, set.bowler_id, bowl[i], pick, r, wicket ? 1 : 0, sIdx, now());
    const ball = { i, pos: (balls - 1) % 6, bat: pick, bowl: bowl[i], runs: r, wicket };
    out.push(ball);
    const label = ballLabel(balls);
    const line = wicket ? `OUT! Both picked ${bowl[i]}. ${batter} is out.`
      : r === 6 ? `SIX! ${batter} 6, ${bowler} ${bowl[i]}.` : r === 4 ? `FOUR! ${batter} 4, ${bowler} ${bowl[i]}.`
      : r === 0 ? `Dot ball. ${batter} 0, ${bowler} ${bowl[i]}.`
      : `${r} run${r > 1 ? 's' : ''}. ${batter} ${pick}, ${bowler} ${bowl[i]}.`;
    if (wicket) wickets += 1;
    announce(m.id, `${line} ${teamName(m, inn.batting)} ${runs}/${wickets} (ball ${label}).`, { type: 'ball', runs: r, wicket, bat: pick, bowl: bowl[i], over: label });

    if (test) {
      // Dot-over requirement: score off ball 1 or 2 of this over, or it's a violation.
      const overIdx = Math.floor((balls - 1) / 6);
      const req = activeRule(inn.id, set.batter_id);
      if (req && req.over_idx === overIdx) {
        if (wicket) resolveRule(req.id, 'dismissed');
        else if (r > 0) { resolveRule(req.id, 'met'); announce(m.id, `✅ ${batter} scored and has met the dot-over requirement.`, { type: 'rule' }); }
        else if (ball.pos === 1) {
          if (m.config.mode === 'auto') {
            run(`UPDATE balls SET is_wicket = 1, dismissal = 'dot_rule' WHERE id = ?`, Number(ins.lastInsertRowid));
            resolveRule(req.id, 'violated', 'Out under the dot-over rule');
            wicket = true; wickets += 1; ball.wicket = true;
            announce(m.id, `❌ Dot-over rule: ${batter} didn't score off the first two balls of the over and is out.`, { type: 'rule', wicket: true });
          } else {
            resolveRule(req.id, 'pending');
            pendingRule = true;
            announce(m.id, `⚠ Dot-over rule broken: ${batter} didn't score off the first two balls of the over. Play is held until the umpire rules.`, { type: 'rule' });
            ctx.notify.push({ userId: m.umpire_id, title: 'Rule the dot-over requirement', body: `${batter} didn't score off the first two balls. Give out or waive.`, kind: 'umpire' });
          }
        }
      }
      if (!wicket && !pendingRule && ball.pos === 5) {
        const overBalls = all('SELECT * FROM balls WHERE innings_id = ? AND voided = 0 AND ball_no BETWEEN ? AND ? ORDER BY ball_no', inn.id, overIdx * 6 + 1, overIdx * 6 + 6);
        if (isDotOver(overBalls, set.batter_id)) {
          run('INSERT INTO dot_rules (match_id, innings_id, batter_id, over_idx, created_at) VALUES (?,?,?,?,?)', m.id, inn.id, set.batter_id, overIdx + 1, now());
          newRule = true;
          announce(m.id, `⚠ Scoring requirement: ${batter} faced a dot over and must score within the first 2 legal balls of the next over.`, { type: 'rule' });
        }
      }
    }
    if (wicket || pendingRule || (inn.target && runs >= inn.target) || balls >= inn.max_balls) break;
  }
  const overRuns = out.reduce((s, b) => s + b.runs, 0);
  const faced = out.length;
  const t = totals(inn.id);
  const ended = (inn.target && t.runs >= inn.target) || t.wickets >= inn.max_wickets || t.balls >= inn.max_balls;
  run(`UPDATE sets SET used = ?, status = 'closed', end_reason = ?, revealed_at = ? WHERE id = ?`,
    used, ended ? 'innings' : wicket ? 'wicket' : pendingRule ? 'rule' : 'complete', now(), set.id);
  ctx.fx.push({ type: 'reveal', balls: out, cap: set.cap, batter, bowler, runs: overRuns, wicket });
  if (set.cap > 1) announce(m.id, `Revealed: ${batter} ${overRuns} run${overRuns === 1 ? '' : 's'} off ${faced} ball${faced === 1 ? '' : 's'}${wicket ? ', then out' : ''}. Bowler ${set.seq.slice(set.used)}, batter ${set.bat_seq.slice(0, set.cap - set.used)}.`, { type: 'over' });
  if (pendingRule) return; // the umpire rules first
  progress(m, inn, { wicket, lastBowler: set.bowler_id, newRule, batterId: set.batter_id }, ctx);
}

// What happens after a reveal (or an umpire ruling): next batter, next bowler, innings end, session end.
function progress(m, inn, { wicket, lastBowler, newRule, batterId }, ctx) {
  const t = totals(inn.id);
  const ended = (inn.target && t.runs >= inn.target) || t.wickets >= inn.max_wickets || t.balls >= inn.max_balls;
  const overDone = t.balls % 6 === 0;
  if (ended) endInnings(m, inn, ctx);
  else {
    const fresh = latestInnings(m.id);
    if (wicket) {
      const nb = pickStriker(m, fresh);
      run('UPDATE innings SET striker_id = ? WHERE id = ?', nb, inn.id);
      const left = 6 - (t.balls % 6);
      announce(m.id, `${userName(nb)} walks out to bat${overDone ? '' : ` to face the last ${left} ball${left === 1 ? '' : 's'} of the over`}. ${inn.max_wickets - t.wickets} wicket${inn.max_wickets - t.wickets > 1 ? 's' : ''} left.`, { type: 'newbatter' });
    }
    if (overDone) {
      const nextBowler = pickBowler(m, fresh, lastBowler);
      run('UPDATE innings SET bowler_id = ? WHERE id = ?', nextBowler, inn.id);
      announce(m.id, `End of over ${t.balls / 6}. ${teamName(m, inn.batting)} ${t.runs}/${t.wickets}. ${userName(nextBowler)} bowls next.`, { type: 'endover' });
    }
    if (newRule) {
      const cur = latestInnings(m.id);
      const body = `${userName(batterId)} must score within the first 2 legal balls of the next over.`;
      for (const uid of new Set([batterId, cur.bowler_id, isUmpire(m, m.umpire_id) ? m.umpire_id : null].filter(Boolean)))
        ctx.notify.push({ userId: uid, title: 'Scoring requirement active', body, kind: 'info' });
    }
    // Ball by ball, only call people when a new over or a new batter starts.
    if (overDone || wicket || m.config.play === 'over') overCall(m, inn, ctx, wicket ? 'Wicket! ' : overDone ? 'New over. ' : '');
  }
  if (isTest(m.config)) sessionCheck(m, ctx);
}

function endInnings(m, inn, ctx, reason = null) {
  if (isTest(m.config)) return endTestInnings(m, inn, ctx, reason);
  run(`UPDATE innings SET status = 'done', ended_at = ? WHERE id = ?`, now(), inn.id);
  const t = totals(inn.id);
  const n = inn.number;
  announce(m.id, `Innings over: ${teamName(m, inn.batting)} ${t.runs}/${t.wickets} (${oversText(t.balls)} overs).`, { type: 'innings_end', number: n });
  const auto = m.config.mode === 'auto';
  const breakOrNext = (msg) => {
    if (auto) { createInnings(m, n + 1, ctx); return; }
    run(`UPDATE matches SET status = 'innings_break' WHERE id = ?`, m.id);
    announce(m.id, `${msg} Waiting for the umpire to start the next innings.`, { type: 'break' });
    ctx.notify.push({ userId: m.umpire_id, title: 'Innings break', body: 'Start the next innings when everyone is ready.', kind: 'umpire' });
  };
  if (n === 1 || n === 3) return breakOrNext(`${teamName(m, other(inn.batting))} need ${t.runs + 1} to win.`);

  const first = get('SELECT * FROM innings WHERE match_id = ? AND number = ?', m.id, n - 1);
  const a = totals(first.id);
  const so = n === 4 ? ' in the super over' : '';
  let result;
  if (t.runs >= inn.target) {
    const left = inn.max_wickets - t.wickets;
    result = { winner: inn.batting, tie: false, text: `${teamName(m, inn.batting)} won by ${left} wicket${left === 1 ? '' : 's'}${so}.` };
  } else if (t.runs === inn.target - 1) {
    if (n === 2 && m.config.superOver) {
      announce(m.id, `Scores level at ${t.runs}! It's going to a super over.`, { type: 'tie' });
      ctx.fx.push({ type: 'tie' });
      return breakOrNext('Super over time.');
    }
    result = { winner: null, tie: true, text: `Match tied${so}.` };
  } else {
    const by = a.runs - t.runs;
    result = { winner: first.batting, tie: false, text: `${teamName(m, first.batting)} won by ${by} run${by === 1 ? '' : 's'}${so}.` };
  }
  finishMatch(m, result, ctx);
}

function endTestInnings(m, inn, ctx, reason) {
  const t = totals(inn.id);
  const why = reason || (inn.target && t.runs >= inn.target ? 'target' : t.wickets >= inn.max_wickets ? 'all_out' : 'ended');
  run(`UPDATE innings SET status = 'done', ended_at = ?, end_reason = ? WHERE id = ?`, now(), why, inn.id);
  // Any outstanding dot-over requirement ends with the innings.
  run(`UPDATE dot_rules SET status = 'innings_end', resolved_at = ? WHERE innings_id = ? AND status IN ('active', 'pending')`, now(), inn.id);
  const n = inn.number;
  announce(m.id, `Innings over: ${teamName(m, inn.batting)} ${t.runs}/${t.wickets}${why === 'declared' ? ' declared' : why === 'all_out' ? ' all out' : ''} (${oversText(t.balls)} overs).`, { type: 'innings_end', number: n });
  const auto = m.config.mode === 'auto';
  const next = (k, opts = {}) => {
    if (auto) return createTestInnings(m, k, ctx, opts);
    run(`UPDATE matches SET status = 'innings_break' WHERE id = ?`, m.id);
    announce(m.id, 'Innings break. Waiting for the umpire to start the next innings.', { type: 'break' });
    ctx.notify.push({ userId: m.umpire_id, title: 'Innings break', body: 'Start the next innings when everyone is ready.', kind: 'umpire' });
  };
  const ipt = m.config.inningsPerTeam;
  const last = ipt === 1 ? 2 : 4;
  if (n === 1) return next(2);
  if (n === 2 && ipt === 2) {
    const fo = followOnPending(m);
    if (fo) {
      run(`UPDATE matches SET status = 'innings_break' WHERE id = ?`, m.id);
      announce(m.id, `${teamName(m, fo.team)} lead by ${fo.lead}. Their captain can enforce the follow-on.`, { type: 'follow_on' });
      ctx.notify.push({ userId: captainOf(m, fo.team), title: 'Follow-on?', body: `You lead by ${fo.lead}. Make them bat again, or bat yourselves.`, kind: 'bat' });
      return;
    }
    return next(3);
  }
  if (n === 3) {
    // Has the side that batted twice still not caught up? Then it's an innings win.
    const twice = inn.batting, once = other(twice);
    const diff = teamTotal(m.id, once) - teamTotal(m.id, twice);
    if (diff > 0) return finishMatch(m, { winner: once, tie: false, text: `${teamName(m, once)} won by an innings and ${diff} run${diff === 1 ? '' : 's'}.`, reason: 'innings' }, ctx);
    return next(4);
  }
  if (n === last) {
    const chasing = inn.batting, defending = other(chasing);
    const a = teamTotal(m.id, defending), b = teamTotal(m.id, chasing);
    let result;
    if (b > a) { const left = inn.max_wickets - t.wickets; result = { winner: chasing, tie: false, text: `${teamName(m, chasing)} won by ${left} wicket${left === 1 ? '' : 's'}.`, reason: 'chase' }; }
    else if (b === a) result = { winner: null, tie: true, text: 'Match tied.', reason: 'tie' };
    else result = { winner: defending, tie: false, text: `${teamName(m, defending)} won by ${a - b} run${a - b === 1 ? '' : 's'}.`, reason: 'defended' };
    return finishMatch(m, result, ctx);
  }
  return next(n + 1);
}

// ---------- Test match sessions ----------
export const sessionIdx = (m) => ((m.test_day || 1) - 1) * m.config.sessionsPerDay + (m.test_session || 1);
const sessionBalls = (m) => get(`SELECT COUNT(*) AS n FROM balls b JOIN innings i ON i.id = b.innings_id
  WHERE i.match_id = ? AND b.voided = 0 AND b.session_idx = ?`, m.id, sessionIdx(m)).n;
const sessionQuota = (m) => m.config.oversPerSession * 6;
const breakName = (m, dayEnd) => dayEnd ? (m.config.stumps ? 'Stumps' : 'End of the day')
  : m.test_session === 1 && m.config.lunch ? 'Lunch' : m.test_session === 2 && m.config.tea ? 'Tea' : 'Session break';

function startSessionRow(m, day, num) {
  const idx = (day - 1) * m.config.sessionsPerDay + num;
  run('UPDATE matches SET test_day = ?, test_session = ?, session_started_at = ?, break_request = NULL WHERE id = ?', day, num, now(), m.id);
  run('INSERT OR IGNORE INTO match_sessions (match_id, idx, day, num, started_at) VALUES (?,?,?,?,?)', m.id, idx, day, num, now());
}

function sessionCheck(mIn, ctx) {
  const m = loadMatch(mIn.id);
  if (!isTest(m.config) || !['live', 'innings_break'].includes(m.status)) return;
  if (sessionBalls(m) < sessionQuota(m)) return;
  endSession(m, ctx, 'overs', null);
}

function endSession(m, ctx, reason, byUser) {
  const idx = sessionIdx(m);
  const spd = m.config.sessionsPerDay;
  const dayEnd = m.test_session >= spd;
  const lastOfMatch = idx >= m.config.days * spd;
  run('UPDATE match_sessions SET ended_at = ?, end_reason = ?, ended_by = ? WHERE match_id = ? AND idx = ?', now(), reason, byUser, m.id, idx);
  run('UPDATE matches SET break_request = NULL WHERE id = ?', m.id);
  // A session ending means nobody should be told to bowl or bat right now.
  for (let i = ctx.notify.length - 1; i >= 0; i--) if (ctx.notify[i].kind === 'bat' || ctx.notify[i].kind === 'bowl') ctx.notify.splice(i, 1);
  const s = sessionSummary(m, idx);
  const line = `Day ${m.test_day}, session ${m.test_session}: ${s.runs} run${s.runs === 1 ? '' : 's'}, ${s.wickets} wicket${s.wickets === 1 ? '' : 's'} in ${oversText(s.balls)} overs.`;
  if (lastOfMatch) {
    announce(m.id, `${line} That's the end of day ${m.test_day}, the last scheduled day.`, { type: 'session_end' });
    return finishMatch(m, { winner: null, tie: false, draw: true, text: 'Match drawn: the scheduled days are over.', reason: 'time' }, ctx);
  }
  const name = breakName(m, dayEnd);
  const pause = reason !== 'overs' || (dayEnd ? m.config.stumps : m.test_session === 1 ? m.config.lunch : m.test_session === 2 ? m.config.tea : true);
  const by = reason === 'manual' ? ` (ended early by ${userName(byUser)})` : reason === 'requested' ? ' (break requested by a captain)' : '';
  record(m.id, byUser || m.umpire_id, 'session_end', `${dayEnd ? '🌙' : '☕'} ${name}${by}. ${line}`, { idx, reason });
  ctx.fx.push({ type: 'session', name, day: m.test_day, session: m.test_session, dayEnd });
  if (!pause) {
    // This break is switched off in the match settings: roll straight into the next session.
    const day = dayEnd ? m.test_day + 1 : m.test_day, num = dayEnd ? 1 : m.test_session + 1;
    startSessionRow(m, day, num);
    announce(m.id, `No break: day ${day}, session ${num} starts straight away.`, { type: 'session_start' });
    return;
  }
  run('UPDATE matches SET status = ? WHERE id = ?', dayEnd ? 'day_break' : 'session_break', m.id);
  for (const p of all('SELECT user_id FROM members WHERE match_id = ? AND banned = 0 AND team IS NOT NULL', m.id))
    ctx.notify.push({ userId: p.user_id, title: `${name}`, body: `${line} The match is saved. Play continues when the next session starts.`, kind: 'info' });
}

// After a break or suspension: is there an innings to carry on, or does one need starting?
function statusAfterBreak(m) {
  const inn = latestInnings(m.id);
  return inn && inn.status === 'live' ? 'live' : 'innings_break';
}

export function testAction(userId, matchId, a, ctx) {
  return tx(() => {
    const m = loadMatch(matchId);
    const ump = isUmpire(m, userId), host = isHost(m, userId);
    const cap = ['A', 'B'].find((t) => captainOf(m, t) === userId);
    const admin = m.config.mode === 'umpire' ? ump : host; // who runs sessions
    const inn = latestInnings(matchId);
    switch (a.type) {
      case 'suspend': {
        if (!host) fail(m.config.mode === 'umpire' ? 'Only the umpire can suspend the match.' : 'Only the match host can suspend the match.');
        if (!['live', 'session_break', 'day_break', 'innings_break'].includes(m.status)) fail('The match can only be suspended while it is in progress.');
        const reason = String(a.reason || '').slice(0, 140);
        run('INSERT INTO suspensions (match_id, suspended_by, suspended_at, reason, status_before, day, session) VALUES (?,?,?,?,?,?,?)',
          matchId, userId, now(), reason || null, m.status, m.test_day, m.test_session);
        run(`UPDATE matches SET status = 'suspended' WHERE id = ?`, matchId);
        const t = inn ? totals(inn.id) : null;
        record(matchId, userId, 'suspend', `⏸ Match suspended and saved${reason ? ` (${reason})` : ''}.${t ? ` ${teamName(m, inn.batting)} ${t.runs}/${t.wickets} after ${oversText(t.balls)} overs.` : ''} The same link carries on when it resumes.`);
        for (const p of all('SELECT user_id FROM members WHERE match_id = ? AND banned = 0', matchId))
          if (p.user_id !== userId) ctx.notify.push({ userId: p.user_id, title: 'Match suspended', body: 'Progress is saved. You will be notified when it resumes.', kind: 'info' });
        break;
      }
      case 'resume': {
        if (!host) fail(m.config.mode === 'umpire' ? 'Only the umpire can resume the match.' : 'Only the match host can resume the match.');
        if (m.status !== 'suspended') fail('The match is not suspended.');
        const s = get('SELECT * FROM suspensions WHERE match_id = ? AND resumed_at IS NULL ORDER BY id DESC LIMIT 1', matchId);
        const back = s?.status_before || statusAfterBreak(m);
        run('UPDATE suspensions SET resumed_by = ?, resumed_at = ? WHERE id = ?', userId, now(), s?.id ?? -1);
        run('UPDATE matches SET status = ?, resumed_at = ? WHERE id = ?', back, now(), matchId);
        const t = inn ? totals(inn.id) : null;
        const where = isTest(m.config) ? `Day ${m.test_day}, session ${m.test_session}` : 'The match';
        record(matchId, userId, 'resume', `▶ Match resumed. ${where}${t && inn.status === 'live' ? `, ${teamName(m, inn.batting)} ${t.runs}/${t.wickets}, next ball ${ballLabel(t.balls + 1)}` : ''}.${back === 'session_break' || back === 'day_break' ? ' Still at the break: start the next session to play on.' : ''}`);
        for (const p of all('SELECT user_id FROM members WHERE match_id = ? AND banned = 0', matchId))
          if (p.user_id !== userId) ctx.notify.push({ userId: p.user_id, title: 'Match resumed', body: 'Pick up where you left off.', kind: 'info' });
        if (back === 'live') overCall(m, inn, ctx, 'Resumed. ');
        break;
      }
      case 'next_session': {
        if (!isTest(m.config)) fail('Sessions are only used in Test matches.');
        if (!(admin || (m.config.mode === 'auto' && cap))) fail(m.config.mode === 'umpire' ? 'Only the umpire can start the next session.' : 'Only the host or a captain can start the next session.');
        if (m.status !== 'session_break' && m.status !== 'day_break') fail('There is no break to end.');
        const dayEnd = m.status === 'day_break';
        const day = dayEnd ? m.test_day + 1 : m.test_day, num = dayEnd ? 1 : m.test_session + 1;
        startSessionRow(m, day, num);
        const back = statusAfterBreak(m);
        run('UPDATE matches SET status = ? WHERE id = ?', back, matchId);
        record(matchId, userId, 'session_start', `▶ Day ${day}, session ${num} is underway.`);
        for (const p of all('SELECT user_id FROM members WHERE match_id = ? AND banned = 0 AND team IS NOT NULL', matchId))
          ctx.notify.push({ userId: p.user_id, title: `Day ${day}, session ${num}`, body: 'Play has restarted.', kind: 'info' });
        if (back === 'live') overCall(loadMatch(matchId), inn, ctx);
        break;
      }
      case 'end_session': {
        if (!isTest(m.config)) fail('Sessions are only used in Test matches.');
        if (!admin) fail(m.config.mode === 'umpire' ? 'Only the umpire can end a session.' : 'Only the match host can end a session.');
        if (m.status !== 'live' && m.status !== 'innings_break') fail('No session is in progress.');
        endSession(m, ctx, a.requested ? 'requested' : 'manual', userId);
        break;
      }
      case 'request_break': {
        if (!isTest(m.config)) fail('Sessions are only used in Test matches.');
        if (!cap) fail('Only a captain can ask for a session break.');
        if (m.status !== 'live') fail('Play is not in progress.');
        run('UPDATE matches SET break_request = ? WHERE id = ?', cap, matchId);
        record(matchId, userId, 'request_break', `${teamName(m, cap)}'s captain asked for a session break.`);
        ctx.notify.push({ userId: m.umpire_id, title: 'Session break requested', body: `${teamName(m, cap)}'s captain is asking to end the session.`, kind: 'umpire' });
        break;
      }
      case 'decline_break': {
        if (!admin) fail('Only the umpire or host can answer a break request.');
        if (!m.break_request) fail('No break has been requested.');
        run('UPDATE matches SET break_request = NULL WHERE id = ?', matchId);
        record(matchId, userId, 'decline_break', 'The session break request was declined. Play on.');
        break;
      }
      case 'declare': {
        if (!isTest(m.config)) fail('Declarations are only for Test matches.');
        if (m.status !== 'live' || !inn || inn.status !== 'live') fail('No innings in progress.');
        if (!(captainOf(m, inn.batting) === userId || ump)) fail(`Only ${teamName(m, inn.batting)}'s captain${m.config.mode === 'umpire' ? ' or the umpire' : ''} can declare.`);
        if (openSet(inn.id)) fail('Wait until the current submission is revealed, then declare.');
        run('UPDATE innings SET declared = 1 WHERE id = ?', inn.id);
        record(matchId, userId, 'declare', `📣 ${teamName(m, inn.batting)} declare at ${totals(inn.id).runs}/${totals(inn.id).wickets}.`);
        endTestInnings(m, inn, ctx, 'declared');
        sessionCheck(m, ctx);
        break;
      }
      case 'follow_on': {
        const fo = followOnPending(m);
        if (!fo || m.status !== 'innings_break') fail('There is no follow-on decision to make.');
        if (!(captainOf(m, fo.team) === userId || ump)) fail(`Only ${teamName(m, fo.team)}'s captain decides the follow-on.`);
        const enforce = !!a.enforce;
        run(`UPDATE matches SET status = 'live' WHERE id = ?`, matchId);
        record(matchId, userId, 'follow_on', enforce
          ? `${teamName(m, fo.team)} enforce the follow-on: ${teamName(m, other(fo.team))} bat again.`
          : `${teamName(m, fo.team)} decline the follow-on and bat again themselves.`);
        createTestInnings(loadMatch(matchId), 3, ctx, { followOn: enforce });
        break;
      }
      case 'rule': {
        if (!ump) fail('Only the umpire rules on the dot-over requirement.');
        const req = inn && get(`SELECT * FROM dot_rules WHERE innings_id = ? AND status = 'pending'`, inn.id);
        if (!req) fail('There is nothing to rule on.');
        const lastBall = get('SELECT * FROM balls WHERE innings_id = ? AND batter_id = ? AND voided = 0 ORDER BY ball_no DESC LIMIT 1', inn.id, req.batter_id);
        if (a.decision === 'out') {
          run(`UPDATE balls SET is_wicket = 1, dismissal = 'dot_rule' WHERE id = ?`, lastBall.id);
          resolveRule(req.id, 'violated', 'Given out by the umpire');
          record(matchId, userId, 'rule_out', `❌ Umpire's ruling: ${userName(req.batter_id)} is out under the dot-over rule.`);
          progress(m, inn, { wicket: true, lastBowler: lastBall.bowler_id }, ctx);
        } else if (a.decision === 'waive') {
          resolveRule(req.id, 'waived', 'Waived by the umpire');
          record(matchId, userId, 'rule_waive', `Umpire's ruling: the dot-over requirement for ${userName(req.batter_id)} is waived. Play on.`);
          progress(m, inn, { wicket: false, lastBowler: lastBall.bowler_id }, ctx);
        } else fail('Rule out or waive.');
        break;
      }
      default: fail('Unknown action.');
    }
  });
}

function sessionSummary(m, idx) {
  const rows = all(`SELECT b.*, i.batting, i.number AS inn FROM balls b JOIN innings i ON i.id = b.innings_id
    WHERE i.match_id = ? AND b.voided = 0 AND b.session_idx = ? ORDER BY b.id`, m.id, idx);
  const sum = { runs: 0, wickets: 0, balls: rows.length, innings: [], batters: [], bowlers: [] };
  const inns = new Map(), bat = new Map(), bowl = new Map();
  for (const b of rows) {
    sum.runs += b.runs; sum.wickets += b.is_wicket;
    const x = inns.get(b.inn) || { number: b.inn, battingName: teamName(m, b.batting), bowlingName: teamName(m, other(b.batting)), runs: 0, wickets: 0, balls: 0 };
    x.runs += b.runs; x.wickets += b.is_wicket; x.balls += 1; inns.set(b.inn, x);
    const y = bat.get(b.batter_id) || { id: b.batter_id, name: userName(b.batter_id), runs: 0, balls: 0, outs: 0 };
    y.runs += b.runs; y.balls += 1; y.outs += b.is_wicket; bat.set(b.batter_id, y);
    const z = bowl.get(b.bowler_id) || { id: b.bowler_id, name: userName(b.bowler_id), runs: 0, balls: 0, wickets: 0 };
    z.runs += b.runs; z.balls += 1; z.wickets += b.is_wicket && b.dismissal !== 'dot_rule' ? 1 : 0; bowl.set(b.bowler_id, z);
  }
  sum.innings = [...inns.values()]; sum.batters = [...bat.values()]; sum.bowlers = [...bowl.values()];
  return sum;
}

function finishMatch(m, result, ctx, status = 'completed') {
  run(`UPDATE matches SET status = ?, result = ?, ended_at = ? WHERE id = ?`, status, JSON.stringify(result), now(), m.id);
  run(`UPDATE sets SET status = 'cancelled' WHERE status = 'open' AND innings_id IN (SELECT id FROM innings WHERE match_id = ?)`, m.id);
  run(`UPDATE innings SET status = 'done', ended_at = COALESCE(ended_at, ?) WHERE match_id = ?`, now(), m.id);
  run(`UPDATE dot_rules SET status = 'innings_end', resolved_at = ? WHERE match_id = ? AND status IN ('active', 'pending')`, now(), m.id);
  if (isTest(m.config)) run('UPDATE match_sessions SET ended_at = COALESCE(ended_at, ?), end_reason = COALESCE(end_reason, ?) WHERE match_id = ?', now(), 'match_over', m.id);
  announce(m.id, `🏆 ${result.text} Stats have been saved to every player's profile.`, { type: 'result' });
  ctx.fx.push({ type: 'result', text: result.text });
  for (const p of all('SELECT user_id FROM members WHERE match_id = ? AND banned = 0', m.id))
    ctx.notify.push({ userId: p.user_id, title: 'Match over', body: result.text, kind: 'info' });
}

// ---------- players picking their own team (lobby only) ----------
export function joinTeam(userId, matchId, team, ctx) {
  return tx(() => {
    const m = loadMatch(matchId);
    if (m.status !== 'lobby' || tossDone(m)) fail('Teams are locked after the toss.');
    const t = team === 'A' || team === 'B' ? team : null;
    if (m.config.teamSource === 'real') {
      if (!t) fail('Ask the match creator to start a new match if you need to leave.');
      claimSeat(m, userId, t);
      record(matchId, userId, 'join_team', `${userName(userId)} is playing as ${teamName(m, t)}.`);
      return;
    }
    const before = memberOf(matchId, userId)?.team;
    if (before === t) return;
    putInTeam(m, userId, t);
    record(matchId, userId, 'join_team', t ? `${userName(userId)} joined ${teamName(m, t)}.` : `${userName(userId)} left ${teamName(m, before)}.`);
  });
}

// ---------- captain controls (enforced here, not just hidden in the UI) ----------
export function captainAction(userId, matchId, a, ctx) {
  return tx(() => {
    const m = loadMatch(matchId);
    if (m.status === 'completed' || m.status === 'abandoned') fail('This match has finished.');
    const team = a.team === 'A' || a.team === 'B' ? a.team : fail('Pick a team.');
    if (captainOf(m, team) !== userId) fail(`Only ${teamName(m, team)}'s captain can change their lineup.`);
    const tn = teamName(m, team);
    const squad = teamPlayers(matchId, team);
    const ids = squad.map((p) => p.id);
    const inn = latestInnings(matchId);
    const live = inn && inn.status === 'live';
    switch (a.type) {
      case 'bat_order': {
        const order = Array.isArray(a.userIds) ? a.userIds.map(String) : [];
        if (order.length !== ids.length || !order.every((id) => ids.includes(id))) fail('The batting order must list every player once.');
        order.forEach((id, i) => run('UPDATE members SET bat_order = ? WHERE match_id = ? AND user_id = ?', i, matchId, id));
        if (live && inn.batting === team) refreshCurrent(m, latestInnings(matchId));
        record(matchId, userId, 'bat_order', `${tn} batting order: ${order.map(userName).join(', ')}.`, { team, order });
        lineupChanged(matchId, team, 'batting order');
        break;
      }
      case 'bowl_order': {
        const order = Array.isArray(a.userIds) ? a.userIds.map(String) : [];
        if (!order.length) fail('Keep at least one bowler in the lineup.');
        if (!order.every((id) => ids.includes(id)) || new Set(order).size !== order.length) fail('Pick bowlers from your own team.');
        if (live && inn.bowling === team && !order.includes(inn.bowler_id) && (openSet(inn.id) || !atOverBoundary(inn)))
          fail(`${userName(inn.bowler_id)} is in the middle of an over and has to finish it.`);
        for (const id of ids) {
          const i = order.indexOf(id);
          run('UPDATE members SET bowls = ?, bowl_order = ? WHERE match_id = ? AND user_id = ?', i >= 0 ? 1 : 0, i >= 0 ? i : 99, matchId, id);
        }
        if (live && inn.bowling === team) refreshCurrent(m, latestInnings(matchId));
        record(matchId, userId, 'bowl_order', `${tn} bowling order: ${order.map(userName).join(', ')}.`, { team, order });
        lineupChanged(matchId, team, 'bowling order');
        break;
      }
      case 'next_bowler': {
        if (!live || inn.bowling !== team) fail(`${tn} aren't bowling right now.`);
        if (openSet(inn.id) || !atOverBoundary(inn)) fail(`${userName(inn.bowler_id)} is in the middle of an over. Pick the next bowler once it ends.`);
        if (!ids.includes(a.userId)) fail(`Pick someone from ${tn}.`);
        const last = lastOverBowler(inn.id);
        if (m.config.noConsecutive && a.userId === last && squad.length > 1) fail(`${userName(a.userId)} bowled the last over and can't bowl two in a row.`);
        run('UPDATE innings SET bowler_id = ? WHERE id = ?', a.userId, inn.id);
        record(matchId, userId, 'next_bowler', `${tn} captain picked ${userName(a.userId)} to bowl the next over.`, { team, userId: a.userId });
        overCall(m, inn, ctx);
        break;
      }
      case 'next_batter': {
        if (!live || inn.batting !== team) fail(`${tn} aren't batting right now.`);
        if (!strikerFresh(inn)) fail(`${userName(inn.striker_id)} has already started batting.`);
        if (!ids.includes(a.userId)) fail(`Pick someone from ${tn}.`);
        // Players who are out can only come back once everyone else has had a turn.
        const d = dismissals(inn.id);
        const fewest = Math.min(...ids.map((x) => d.get(x) || 0));
        if ((d.get(a.userId) || 0) > fewest) fail(`${userName(a.userId)} is out. Pick someone who hasn't batted yet.`);
        run('UPDATE innings SET striker_id = ? WHERE id = ?', a.userId, inn.id);
        record(matchId, userId, 'next_batter', `${tn} captain sent ${userName(a.userId)} in to bat.`, { team, userId: a.userId });
        overCall(m, inn, ctx);
        break;
      }
      case 'add': {
        requireSquadsOpen(m);
        if (m.config.teamSource === 'real') fail('Real teams pick their XI from the squad instead.');
        const mem = memberOf(matchId, a.userId);
        if (!mem || mem.banned || mem.team) fail('Pick someone who is watching, not already in a team.');
        putInTeam(m, a.userId, team);
        record(matchId, userId, 'add_player', `${userName(a.userId)} joins ${tn} (picked by the captain).`, { team, userId: a.userId });
        ctx.notify.push({ userId: a.userId, title: `You're playing for ${tn}`, body: 'Your captain added you to the squad.', kind: 'info' });
        break;
      }
      case 'remove': {
        requireSquadsOpen(m);
        if (m.config.teamSource === 'real') fail('Real teams pick their XI from the squad instead.');
        if (!ids.includes(a.userId)) fail(`That player isn't in ${tn}.`);
        if (a.userId === userId) fail('Hand the captaincy to someone else first.');
        if (squad.length === 1) fail('A team needs at least one player.');
        if (live && openSet(inn.id) && (inn.striker_id === a.userId || inn.bowler_id === a.userId)) fail(`${userName(a.userId)} is in the middle of an over.`);
        putInTeam(m, a.userId, null);
        record(matchId, userId, 'remove_player', `${userName(a.userId)} left ${tn}'s lineup (captain's decision).`, { team, userId: a.userId });
        break;
      }
      case 'select_xi': {
        if (m.config.teamSource !== 'real') fail('Playing XIs are picked for real teams only.');
        requireSquadsOpen(m);
        const meta = JSON.parse((team === 'A' ? m.team_a_meta : m.team_b_meta) || 'null');
        const pool = squadFor(meta, m.config.xiSize);
        const want = Math.min(m.config.xiSize, pool.length);
        const picks = (Array.isArray(a.playerIds) ? a.playerIds : []).map((pid) => pool.find((p) => String(p.playerId) === String(pid))).filter(Boolean);
        if (new Set(picks).size !== want) fail(`Pick exactly ${want} players from the squad.`);
        setXI(matchId, team, picks, userId);
        record(matchId, userId, 'select_xi', `${tn} playing XI: ${picks.map((p) => p.name).join(', ')}.`, { team });
        lineupChanged(matchId, team, 'new playing XI');
        break;
      }
      case 'xi_captain': {
        if (m.config.teamSource !== 'real') fail('Only for real teams.');
        if (!ids.includes(a.userId)) fail(`Pick someone from ${tn}'s XI.`);
        const col = team === 'A' ? 'team_a_meta' : 'team_b_meta';
        const meta = JSON.parse(m[col] || '{}');
        meta.captainId = a.userId;
        run(`UPDATE matches SET ${col} = ? WHERE id = ?`, JSON.stringify(meta), matchId);
        record(matchId, userId, 'xi_captain', `${userName(a.userId)} will captain ${tn}.`, { team });
        break;
      }
      case 'captain': {
        if (m.config.teamSource === 'real') fail('In real-team matches, use "captain on the field" for the XI.');
        if (!ids.includes(a.userId)) fail(`Pick someone from ${tn}.`);
        run(`UPDATE matches SET ${team === 'A' ? 'captain_a' : 'captain_b'} = ? WHERE id = ?`, a.userId, matchId);
        record(matchId, userId, 'captain', `${userName(a.userId)} is now ${tn}'s captain.`, { team, userId: a.userId });
        lineupChanged(matchId, team, 'new captain');
        ctx.notify.push({ userId: a.userId, title: `You're captain of ${tn}`, body: 'You now set the batting and bowling lineups.', kind: 'info' });
        break;
      }
      default: fail('Unknown captain action.');
    }
  });
}

// ---------- host / umpire controls ----------
export function umpireAction(userId, matchId, a, ctx) {
  return tx(() => {
    const m = loadMatch(matchId);
    const ump = isUmpire(m, userId), host = isHost(m, userId);
    const needUmpire = () => { if (!ump) fail(m.config.mode === 'umpire' ? 'Only the umpire can do that.' : 'This match has no umpire, so that is automatic.'); };
    const needHost = () => { if (!host) fail(m.config.mode === 'umpire' ? 'Only the umpire can do that.' : 'Only the match host can do that.'); };
    const inn = latestInnings(matchId);
    switch (a.type) {
      case 'assign': {
        needHost();
        requireSquadsOpen(m);
        if (m.config.participation !== 'team') fail('In one-v-one matches, players join from the invite link.');
        const team = a.team === 'A' || a.team === 'B' ? a.team : null;
        putInTeam(m, a.userId, team);
        record(matchId, userId, 'assign', team ? `${userName(a.userId)} joins ${teamName(m, team)}.` : `${userName(a.userId)} is now watching.`, { userId: a.userId, team });
        if (team) ctx.notify.push({ userId: a.userId, title: `You're playing for ${teamName(m, team)}`, body: 'You were added to the squad.', kind: 'info' });
        break;
      }
      case 'captain': {
        needHost();
        const team = a.team === 'A' ? 'A' : 'B';
        if (!teamPlayers(matchId, team).some((p) => p.id === a.userId)) fail(`Pick someone from ${teamName(m, team)}.`);
        run(`UPDATE matches SET ${team === 'A' ? 'captain_a' : 'captain_b'} = ? WHERE id = ?`, a.userId, matchId);
        record(matchId, userId, 'captain', `${userName(a.userId)} is ${teamName(m, team)}'s captain.`, { team, userId: a.userId });
        lineupChanged(matchId, team, 'new captain');
        ctx.notify.push({ userId: a.userId, title: `You're captain of ${teamName(m, team)}`, body: 'You set the batting and bowling lineups.', kind: 'info' });
        break;
      }
      case 'setup': {
        needHost();
        if (m.status !== 'lobby') fail('Match settings are locked once play starts.');
        const cfg = sanitizeConfig(a.config || {}, m.config);
        run('UPDATE matches SET name = ?, team_a = ?, team_b = ?, toss_bat = ?, config = ? WHERE id = ?',
          (a.name || m.name).slice(0, 60), (a.teamA || m.team_a).slice(0, 30), (a.teamB || m.team_b).slice(0, 30),
          m.toss_bat, JSON.stringify({ ...cfg, play: m.config.play }), matchId);
        record(matchId, userId, 'setup', 'Match settings updated.', {}, false);
        break;
      }
      case 'pause': case 'resume': {
        needUmpire();
        if (m.status !== 'live' && m.status !== 'innings_break') fail('The match is not in play.');
        const p = a.type === 'pause' ? 1 : 0;
        run('UPDATE matches SET paused = ? WHERE id = ?', p, matchId);
        record(matchId, userId, a.type, p ? '⏸ The umpire has paused play.' : '▶ Play resumes.');
        break;
      }
      case 'void': {
        // Cancel the last revealed over completely; both players lock in again.
        needUmpire();
        if (!inn) fail('Nothing to correct.');
        if (!(m.status === 'live' || (m.status === 'innings_break' && inn.status === 'done'))) fail('Corrections are only possible during play or the innings break.');
        const set = get(`SELECT * FROM sets WHERE innings_id = ? AND status = 'closed' AND used > 0
                         AND EXISTS (SELECT 1 FROM balls WHERE set_id = sets.id AND voided = 0) ORDER BY id DESC LIMIT 1`, inn.id);
        if (!set) fail('No over to void in this innings.');
        const reason = String(a.reason || '').slice(0, 140) || 'Umpire correction';
        run(`UPDATE sets SET status = 'cancelled' WHERE innings_id = ? AND status = 'open'`, inn.id);
        const firstVoid = get('SELECT MIN(created_at) AS t FROM balls WHERE set_id = ? AND voided = 0', set.id).t;
        run('UPDATE balls SET voided = 1 WHERE set_id = ?', set.id);
        // Undo any dot-over requirement the voided balls created or settled.
        run('DELETE FROM dot_rules WHERE innings_id = ? AND created_at >= ?', inn.id, firstVoid);
        run(`UPDATE dot_rules SET status = 'active', resolved_at = NULL WHERE innings_id = ? AND resolved_at >= ? AND status <> 'innings_end'`, inn.id, firstVoid);
        run(`UPDATE sets SET end_reason = 'voided' WHERE id = ?`, set.id);
        run(`UPDATE innings SET status = 'live', ended_at = NULL, striker_id = ?, bowler_id = ? WHERE id = ?`, set.batter_id, set.bowler_id, inn.id);
        run(`UPDATE matches SET status = 'live' WHERE id = ?`, matchId);
        record(matchId, userId, 'void_over', `Umpire voided the last reveal (${reason}). ${userName(set.bowler_id)} and ${userName(set.batter_id)} lock in again.`, { setId: set.id, reason });
        overCall(m, inn, ctx, 'Over voided. ');
        break;
      }
      case 'adjust': {
        needUmpire();
        if (!inn) fail('No innings yet.');
        if (m.status !== 'live' && m.status !== 'innings_break') fail('Adjustments are only possible during the match.');
        const delta = parseInt(a.runs, 10);
        if (!delta || Math.abs(delta) > 50) fail('Enter a run adjustment between -50 and 50.');
        const reason = String(a.reason || '').slice(0, 140) || 'Umpire adjustment';
        run('UPDATE innings SET extras = extras + ? WHERE id = ?', delta, inn.id);
        record(matchId, userId, 'adjust_runs', `Umpire adjustment: ${delta > 0 ? '+' : ''}${delta} to ${teamName(m, inn.batting)} (${reason}).`, { delta, reason });
        const t = totals(inn.id);
        if (inn.status === 'live' && inn.target && t.runs >= inn.target) {
          run(`UPDATE sets SET status = 'cancelled' WHERE innings_id = ? AND status = 'open'`, inn.id);
          endInnings(m, inn, ctx);
        }
        break;
      }
      case 'end': {
        if (m.config.mode === 'umpire') needUmpire(); else needHost();
        if (m.status === 'completed' || m.status === 'abandoned') fail('This match has finished.');
        if (m.status === 'lobby' && a.outcome !== 'abandon') fail('The match has not started.');
        if (a.outcome === 'draw' && !isTest(m.config)) fail('Only Test matches can be drawn.');
        const reason = String(a.reason || '').slice(0, 140);
        let result;
        if (a.outcome === 'A' || a.outcome === 'B') result = { winner: a.outcome, tie: false, text: `${teamName(m, a.outcome)} won (${ump ? "umpire's decision" : 'declared by the host'}${reason ? `: ${reason}` : ''}).` };
        else if (a.outcome === 'tie') result = { winner: null, tie: true, text: `Match declared a tie${reason ? ` (${reason})` : ''}.` };
        else if (a.outcome === 'draw') result = { winner: null, tie: false, draw: true, text: `Match drawn${reason ? ` (${reason})` : ''}.`, reason: 'declared_draw' };
        else result = { winner: null, tie: false, abandoned: true, text: `Match abandoned${reason ? ` (${reason})` : ''}.` };
        record(matchId, userId, 'end_match', `Match ended early: ${result.text}`, { outcome: a.outcome, reason }, false);
        finishMatch(m, result, ctx, result.abandoned ? 'abandoned' : 'completed');
        break;
      }
      case 'mute': {
        needHost();
        if (a.userId === userId) fail('You cannot mute yourself.');
        run('UPDATE members SET muted = ? WHERE match_id = ? AND user_id = ?', a.muted ? 1 : 0, matchId, a.userId);
        record(matchId, userId, a.muted ? 'mute' : 'unmute', `${userName(a.userId)} was ${a.muted ? 'muted' : 'unmuted'} in chat.`, { userId: a.userId }, false);
        ctx.notify.push({ userId: a.userId, title: a.muted ? 'You have been muted' : 'You can chat again', body: a.muted ? 'You were muted in the match chat.' : 'You were unmuted.', kind: 'info' });
        break;
      }
      case 'kick': {
        needHost();
        if (a.userId === userId) fail('You cannot remove yourself.');
        if (inn && inn.status === 'live' && (inn.striker_id === a.userId || inn.bowler_id === a.userId)) fail("That player is on right now. Their captain needs to change the lineup first.");
        const was = memberOf(matchId, a.userId)?.team;
        run('UPDATE members SET banned = 1, team = NULL WHERE match_id = ? AND user_id = ?', matchId, a.userId);
        fixCaptains(matchId);
        if (was) lineupChanged(matchId, was, `${userName(a.userId)} was removed`);
        record(matchId, userId, 'kick', `${userName(a.userId)} was removed from the match.`, { userId: a.userId });
        ctx.kicked.push(a.userId);
        break;
      }
      case 'delete_message': {
        needHost();
        run('UPDATE messages SET deleted = 1 WHERE id = ? AND match_id = ?', a.messageId, matchId);
        record(matchId, userId, 'delete_message', 'A chat message was removed.', { messageId: a.messageId }, false);
        break;
      }
      default: fail('Unknown action.');
    }
  });
}

// ---------- chat ----------
export function canReadChannel(m, userId, channel) {
  if (channel === 'public') return true;
  if (m.config.mode !== 'umpire') return false;
  const owner = channel.startsWith('pvt:') ? channel.slice(4) : null;
  return !!owner && (owner === userId || m.umpire_id === userId);
}

export function postChat(userId, matchId, channel, text) {
  const m = loadMatch(matchId);
  const mem = memberOf(matchId, userId);
  if (!mem || mem.banned) fail('Join the match to chat.');
  if (channel === 'public') {
    if (mem.muted) fail('You have been muted.');
    if (m.config.spectators === 'watch' && !mem.team && !isHost(m, userId)) fail('Spectators can watch but not chat in this match.');
  }
  if (!canReadChannel(m, userId, channel)) fail('You cannot post in that channel.');
  const clean = String(text || '').trim().slice(0, 300);
  if (!clean) fail('Type a message first.');
  const r = run('INSERT INTO messages (match_id, channel, user_id, kind, text, created_at) VALUES (?,?,?,?,?,?)',
    matchId, channel, userId, 'user', clean, now());
  return Number(r.lastInsertRowid);
}

export function toggleReaction(userId, matchId, messageId, emoji) {
  const msg = get('SELECT * FROM messages WHERE id = ? AND match_id = ?', messageId, matchId);
  if (!msg || msg.deleted) fail('Message not found.');
  const m = loadMatch(matchId);
  if (!canReadChannel(m, userId, msg.channel)) fail('Message not found.');
  if (![...emoji].length || [...emoji].length > 2) fail('Pick an emoji.');
  const had = get('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, userId, emoji);
  if (had) run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, userId, emoji);
  else run('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?,?,?)', messageId, userId, emoji);
  return msg.channel;
}

export function messageView(row) {
  const reactions = all('SELECT emoji, COUNT(*) AS n, GROUP_CONCAT(user_id) AS users FROM reactions WHERE message_id = ? GROUP BY emoji', row.id)
    .map((r) => ({ emoji: r.emoji, n: r.n, users: r.users.split(',') }));
  return {
    id: row.id, channel: row.channel, kind: row.kind, userId: row.user_id,
    name: row.user_id ? userName(row.user_id) : null,
    text: row.deleted ? null : row.text, deleted: !!row.deleted,
    meta: row.meta ? JSON.parse(row.meta) : null, at: row.created_at, reactions,
  };
}

export function chatHistory(m, userId, limit = 150) {
  const chans = ['public'];
  if (m.config.mode === 'umpire') {
    if (m.umpire_id === userId) for (const r of all(`SELECT DISTINCT channel FROM messages WHERE match_id = ? AND channel LIKE 'pvt:%'`, m.id)) chans.push(r.channel);
    else chans.push(`pvt:${userId}`);
  }
  const out = [];
  for (const c of chans) {
    const rows = all('SELECT * FROM (SELECT * FROM messages WHERE match_id = ? AND channel = ? ORDER BY id DESC LIMIT ?) ORDER BY id', m.id, c, limit);
    out.push(...rows.map(messageView));
  }
  return out.sort((a, b) => a.id - b.id);
}

// ---------- state views ----------
function scorecard(m, inn) {
  const batting = all(`SELECT b.batter_id AS id, u.display_name AS name, SUM(runs) AS runs, COUNT(*) AS balls,
      SUM(CASE WHEN runs = 4 THEN 1 ELSE 0 END) AS fours, SUM(CASE WHEN runs = 6 THEN 1 ELSE 0 END) AS sixes, SUM(is_wicket) AS outs
    FROM balls b JOIN users u ON u.id = b.batter_id WHERE innings_id = ? AND voided = 0 GROUP BY b.batter_id ORDER BY MIN(b.ball_no)`, inn.id);
  const bowling = all(`SELECT b.bowler_id AS id, u.display_name AS name, COUNT(*) AS balls, SUM(runs) AS runs,
      SUM(CASE WHEN is_wicket = 1 AND COALESCE(dismissal, '') <> 'dot_rule' THEN 1 ELSE 0 END) AS wickets,
      COUNT(DISTINCT set_id) AS overs
    FROM balls b JOIN users u ON u.id = b.bowler_id WHERE innings_id = ? AND voided = 0 GROUP BY b.bowler_id ORDER BY MIN(b.ball_no)`, inn.id);
  const overs = all(`SELECT s.id, s.bowler_id, s.batter_id, s.end_reason, COUNT(b.id) AS balls, COALESCE(SUM(b.runs),0) AS runs, COALESCE(SUM(b.is_wicket),0) AS wickets
    FROM sets s JOIN balls b ON b.set_id = s.id AND b.voided = 0 WHERE s.innings_id = ? AND s.status = 'closed' GROUP BY s.id ORDER BY s.id`, inn.id)
    .map((o, i) => ({ n: i + 1, bowler: userName(o.bowler_id), bowlerId: o.bowler_id, batter: userName(o.batter_id), balls: o.balls, runs: o.runs, wickets: o.wickets }));
  const t = totals(inn.id);
  return {
    number: inn.number, superOver: !!inn.super_over, batting: inn.batting, bowling: inn.bowling,
    battingName: teamName(m, inn.batting), runs: t.runs, wickets: t.wickets, balls: t.balls, extras: inn.extras,
    overs: oversText(t.balls), maxBalls: inn.max_balls, maxWickets: inn.max_wickets, target: inn.target, status: inn.status,
    card: { batting, bowling }, overList: overs,
  };
}

function setView(set) {
  const balls = all('SELECT set_index, bat_num, bowl_num, runs, is_wicket, voided FROM balls WHERE set_id = ? ORDER BY set_index', set.id);
  const closed = set.status !== 'open';
  return {
    id: set.id, cap: set.cap, used: set.used, status: set.status, endReason: set.end_reason,
    bowlerId: set.bowler_id, batterId: set.batter_id,
    bowlerLocked: !!set.seq, batterLocked: !!set.bat_seq,
    bowlerHash: set.hash || null, batterHash: set.bat_hash || null,
    balls: balls.map((b) => ({ i: b.set_index, bat: b.bat_num, bowl: b.bowl_num, runs: b.runs, wicket: !!b.is_wicket, voided: !!b.voided })),
    // Sequences and salts become public only once the over is revealed, so anyone can check the fingerprints.
    reveal: closed ? { seq: set.seq || null, salt: set.salt || null, batSeq: set.bat_seq || null, batSalt: set.bat_salt || null } : null,
  };
}

export function publicState(matchId) {
  const m = loadMatch(matchId);
  const members = all(`SELECT m.user_id AS id, u.display_name AS name, u.is_guest AS guest, m.team, m.bat_order AS ord,
                         m.bowl_order AS bowlOrd, m.bowls, m.muted, m.kind, m.controller_id AS controller, u.is_bot AS bot, u.is_ghost AS ghost, u.player_id AS playerId
                       FROM members m JOIN users u ON u.id = m.user_id WHERE m.match_id = ? AND m.banned = 0 ORDER BY m.joined_at`, matchId)
    .map((x) => ({ ...x, bowls: !!x.bowls, muted: !!x.muted, bot: !!x.bot, ghost: !!x.ghost }));
  const inningsRows = all('SELECT * FROM innings WHERE match_id = ? ORDER BY number', matchId);
  const innings = inningsRows.map((i) => scorecard(m, i));
  const inn = inningsRows[inningsRows.length - 1];
  let current = null;
  if (inn) {
    const open = openSet(inn.id);
    const last = open || get(`SELECT * FROM sets WHERE innings_id = ? AND status <> 'cancelled' ORDER BY id DESC LIMIT 1`, inn.id);
    const t = totals(inn.id);
    const rr = t.balls ? (t.runs * 6) / t.balls : 0;
    const need = inn.target ? Math.max(0, inn.target - t.runs) : null;
    const left = inn.max_balls - t.balls;
    let phase = m.status;
    if (m.status === 'live') phase = m.paused ? 'paused' : 'awaiting_over';
    const inOver = Math.min(6 - (t.balls % 6), left);
    // Which over the strip shows: the one in progress, or the one just finished until the next ball is revealed.
    const showIdx = t.balls > 0 && t.balls % 6 === 0 && !open ? t.balls / 6 - 1 : Math.floor(t.balls / 6);
    const overBalls = all(`SELECT b.*, u.display_name AS batter FROM balls b JOIN users u ON u.id = b.batter_id
        WHERE innings_id = ? AND voided = 0 AND ball_no BETWEEN ? AND ? ORDER BY ball_no`, inn.id, showIdx * 6 + 1, showIdx * 6 + 6)
      .map((b) => ({ pos: (b.ball_no - 1) % 6, ballNo: b.ball_no, bat: b.bat_num, bowl: b.bowl_num, runs: b.runs, wicket: !!b.is_wicket, batter: b.batter }));
    current = {
      over: {
        number: showIdx + 1, balls: overBalls, slots: Math.min(6, inn.max_balls - showIdx * 6),
        finished: overBalls.length > 0 && showIdx < Math.floor(t.balls / 6) || inn.status === 'done',
      },
      overNumber: Math.floor(t.balls / 6) + 1, ballInOver: (t.balls % 6) + 1, ballsLeftInOver: inOver,
      number: inn.number, phase, strikerId: inn.striker_id, bowlerId: inn.bowler_id,
      strikerName: userName(inn.striker_id), bowlerName: userName(inn.bowler_id),
      set: last ? setView(last) : null, open: !!open,
      // How many numbers the next submission needs: the balls left in this over, or one at a time.
      cap: open ? open.cap - open.used : inn.status === 'live' ? capFor(m, inn) : m.config.play === 'ball' ? 1 : inOver,
      lastOverBowler: lastOverBowler(inn.id), strikerFresh: inn.status === 'live' ? strikerFresh(inn) : false,
      runRate: rr.toFixed(2), need, ballsLeft: left,
      requiredRate: need != null && left > 0 ? ((need * 6) / left).toFixed(2) : null,
      dismissed: Object.fromEntries(dismissals(inn.id)),
      // Numbers the bowler has already used this over (limited overs: max 3 of each).
      bowledThisOver: bowledThisOver(inn),
    };
  }
  let test = null;
  if (isTest(m.config)) {
    const reqs = inn ? all(`SELECT * FROM dot_rules WHERE innings_id = ? AND status IN ('active', 'pending')`, inn.id) : [];
    const tb = inn ? totals(inn.id).balls : 0;
    const sessions = all('SELECT * FROM match_sessions WHERE match_id = ? ORDER BY idx', m.id).map((r) => ({
      idx: r.idx, day: r.day, num: r.num, startedAt: r.started_at, endedAt: r.ended_at, endReason: r.end_reason, ...sessionSummary(m, r.idx),
    }));
    const days = [];
    for (const x of sessions) {
      const d = days.find((y) => y.day === x.day) || (days.push({ day: x.day, runs: 0, wickets: 0, balls: 0, sessions: 0 }), days[days.length - 1]);
      d.runs += x.runs; d.wickets += x.wickets; d.balls += x.balls; d.sessions += 1;
    }
    const sb = m.test_day ? sessionBalls(m) : 0;
    const totalA = teamTotal(m.id, 'A'), totalB = teamTotal(m.id, 'B');
    let situation = null;
    if (inn && inn.target && inn.status === 'live') {
      const need = inn.target - totals(inn.id).runs;
      situation = `${teamName(m, inn.batting)} need ${need} to win`;
    } else if (inn && inn.number > 1) {
      const diff = teamTotal(m.id, inn.batting) - teamTotal(m.id, other(inn.batting));
      situation = diff === 0 ? 'Scores level' : `${teamName(m, inn.batting)} ${diff > 0 ? 'lead' : 'trail'} by ${Math.abs(diff)}`;
    }
    test = {
      day: m.test_day, session: m.test_session, days: m.config.days, sessionsPerDay: m.config.sessionsPerDay,
      oversPerSession: m.config.oversPerSession, sessionBalls: sb, sessionBallsLeft: sessionQuota(m) - sb,
      sessionStartedAt: m.session_started_at, sessionMinutes: m.config.sessionMinutes,
      breakRequest: m.break_request, resumedAt: m.resumed_at, totals: { A: totalA, B: totalB }, situation,
      followOn: m.status === 'innings_break' ? followOnPending(m) : null, followOnMargin: followOnMargin(m.config),
      requirements: reqs.map((r) => ({
        id: r.id, batterId: r.batter_id, name: userName(r.batter_id), status: r.status,
        ballsLeft: Math.floor(tb / 6) === r.over_idx ? Math.max(0, 2 - (tb % 6)) : 2, startsNextOver: Math.floor(tb / 6) < r.over_idx,
      })),
      sessions, daySummaries: days,
      suspensions: all('SELECT * FROM suspensions WHERE match_id = ? ORDER BY id DESC LIMIT 20', m.id).map((x) => ({
        at: x.suspended_at, by: userName(x.suspended_by), reason: x.reason, resumedAt: x.resumed_at, resumedBy: x.resumed_by ? userName(x.resumed_by) : null, day: x.day, session: x.session,
      })),
    };
  }
  const commentary = all(`SELECT b.*, i.number AS inn, bu.display_name AS batter, bo.display_name AS bowler
      FROM balls b JOIN innings i ON i.id = b.innings_id JOIN users bu ON bu.id = b.batter_id JOIN users bo ON bo.id = b.bowler_id
      WHERE i.match_id = ? ORDER BY b.id DESC LIMIT 60`, matchId)
    .map((b) => ({ id: b.id, inn: b.inn, over: ballLabel(b.ball_no), ballNo: b.ball_no, batter: b.batter, bowler: b.bowler,
      bat: b.bat_num, bowl: b.bowl_num, runs: b.runs, wicket: !!b.is_wicket, voided: !!b.voided }));
  const history = all('SELECT id, action, text, created_at FROM audit WHERE match_id = ? AND text IS NOT NULL ORDER BY id DESC LIMIT 60', matchId)
    .map((h) => ({ id: h.id, action: h.action, text: h.text, at: h.created_at }));
  // Where the match is in its lifecycle, for the status banner.
  let stage = m.status;
  if (m.status === 'lobby') {
    if (!m.confirm_a || !m.confirm_b) stage = 'awaiting_lineups';
    else if (!m.toss_call) stage = 'toss_call';
    else if (!m.toss_decision) stage = 'toss_decision';
    else stage = 'ready_to_start';
  }
  if (stage === 'live' && m.resumed_at && m.resumed_at > Date.now() - 10 * 60 * 1000) {
    const since = get(`SELECT 1 FROM balls b JOIN innings i ON i.id = b.innings_id WHERE i.match_id = ? AND b.created_at > ? LIMIT 1`, m.id, m.resumed_at);
    if (!since) stage = 'resumed';
  }
  return {
    id: m.id, name: m.name, status: m.status, stage, paused: !!m.paused, config: m.config, tossBat: m.toss_bat,
    mode: m.config.mode, play: m.config.play, format: m.config.format, test,
    participation: m.config.participation, teamSource: m.config.teamSource, aiLevel: m.config.participation === 'ai' ? m.config.aiLevel : null,
    aiPersonality: m.config.participation === 'ai' ? m.config.aiPersonality || 'strategic' : null,
    teamMeta: { A: m.team_a_meta ? JSON.parse(m.team_a_meta) : null, B: m.team_b_meta ? JSON.parse(m.team_b_meta) : null },
    lineups: { A: { confirmedAt: m.confirm_a || null }, B: { confirmedAt: m.confirm_b || null } },
    toss: { caller: m.toss_caller, call: m.toss_call, result: m.toss_result, winner: m.toss_winner, decision: m.toss_decision, at: m.toss_at },
    host: { id: m.umpire_id, name: userName(m.umpire_id) },
    umpire: m.config.mode === 'umpire' ? { id: m.umpire_id, name: userName(m.umpire_id) } : null,
    captains: { A: m.captain_a, B: m.captain_b },
    teams: {
      A: { name: m.team_a, players: members.filter((x) => x.team === 'A' && x.kind === 'player').sort((a, b) => a.ord - b.ord), controller: members.find((x) => x.team === 'A' && x.kind === 'controller') || null },
      B: { name: m.team_b, players: members.filter((x) => x.team === 'B' && x.kind === 'player').sort((a, b) => a.ord - b.ord), controller: members.find((x) => x.team === 'B' && x.kind === 'controller') || null },
    },
    members, innings, current, commentary, history, result: m.result, createdAt: m.created_at,
  };
}

// Extra, per-user information that must never go into the public broadcast.
export function privateState(matchId, userId) {
  const m = loadMatch(matchId);
  const inn = latestInnings(matchId);
  const mem = memberOf(matchId, userId);
  const out = { isUmpire: isUmpire(m, userId), isHost: isHost(m, userId), muted: !!mem?.muted, team: mem?.team || null };
  out.captainOf = ['A', 'B'].filter((t) => captainOf(m, t) === userId);
  if (inn) {
    const set = openSet(inn.id);
    if (set && actsFor(matchId, userId, set.bowler_id) && set.seq) out.myLocked = set.seq.split('').map(Number);
    if (set && actsFor(matchId, userId, set.batter_id) && set.bat_seq) out.myLocked = set.bat_seq.split('').map(Number);
    // With an umpire, the umpire privately sees the bowler's six (never the batter's), unless the umpire is the batter.
    if (set && out.isUmpire && set.seq && !actsFor(matchId, userId, set.batter_id)) out.bowlerSequence = set.seq.split('').map(Number);
  }
  return out;
}
