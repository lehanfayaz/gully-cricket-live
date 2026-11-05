// The game rules. Every function here is server-authoritative: clients only send intents.
//
// An over works like this: the bowler and the batter each lock in six numbers, in any order.
// Neither can see the other's numbers. The moment the second one locks in, the server compares
// them ball by ball inside one transaction, records every ball, and reveals the whole over.
import crypto from 'node:crypto';
import { get, all, run, tx } from './db.js';

export class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };
const now = () => Date.now();

export const DEFAULT_CONFIG = {
  mode: 'auto',             // 'auto' (no umpire, fully automatic) | 'umpire'
  overs: 2,
  wickets: 3,
  playersPerTeam: 11,
  superOver: true,
  freshSetAfterWicket: true, // a wicket ends the over; the new batter faces a fresh over
  noConsecutive: true,       // a bowler can't bowl two overs in a row (when the team has another bowler)
  spectators: 'open',        // 'open' (watch + chat) | 'watch' (watch only)
};

export function sanitizeConfig(input = {}, base = DEFAULT_CONFIG) {
  const c = { ...base };
  const int = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  c.overs = int(input.overs, 1, 50, c.overs);
  c.wickets = int(input.wickets, 1, 20, c.wickets);
  c.playersPerTeam = int(input.playersPerTeam, 1, 15, c.playersPerTeam);
  if (input.mode === 'auto' || input.mode === 'umpire') c.mode = input.mode;
  if (input.spectators === 'open' || input.spectators === 'watch') c.spectators = input.spectators;
  for (const k of ['superOver', 'freshSetAfterWicket', 'noConsecutive']) if (k in input) c[k] = !!input[k];
  return c;
}

// ---------- reads ----------
export function loadMatch(id) {
  const m = get('SELECT * FROM matches WHERE id = ?', id);
  if (!m) fail('Match not found.');
  // Matches created before modes existed always had an umpire.
  m.config = { ...DEFAULT_CONFIG, mode: 'umpire', ...JSON.parse(m.config) };
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

export const teamPlayers = (matchId, team) =>
  all(`SELECT m.user_id AS id, u.display_name AS name, m.bat_order, m.bowl_order, m.bowls FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.match_id = ? AND m.team = ? AND m.banned = 0 ORDER BY m.bat_order, m.joined_at`, matchId, team);
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
  get(`SELECT bowler_id FROM sets WHERE innings_id = ? AND status = 'closed' AND used > 0 ORDER BY id DESC LIMIT 1`, inningsId)?.bowler_id || null;

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

export function createMatch(userId, { name, teamA, teamB, config, tossBat, copyFrom }) {
  const id = newCode();
  const cfg = sanitizeConfig(config);
  tx(() => {
    let a = (teamA || 'Team A').slice(0, 30), b = (teamB || 'Team B').slice(0, 30);
    const src = copyFrom ? get('SELECT * FROM matches WHERE id = ?', String(copyFrom).toUpperCase()) : null;
    if (copyFrom && (!src || !memberOf(src.id, userId))) fail('You can only reuse squads from a match you were in.');
    if (src && !teamA) a = src.team_a;
    if (src && !teamB) b = src.team_b;
    run(`INSERT INTO matches (id, name, umpire_id, config, team_a, team_b, toss_bat, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      id, (name || `${a} v ${b}`).slice(0, 60), userId, JSON.stringify(cfg), a, b, tossBat === 'B' ? 'B' : 'A', now());
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
    announce(id, cfg.mode === 'umpire'
      ? 'Match created with an umpire. Share the link so friends can join.'
      : 'Match created. No umpire needed: the game runs itself. Share the link so friends can join.', null, 'public', 'system');
  });
  return id;
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
    const squad = teamPlayers(matchId, t);
    const cap = t === 'A' ? m.captain_a : m.captain_b;
    if (!squad.some((p) => p.id === cap)) {
      run(`UPDATE matches SET ${t === 'A' ? 'captain_a' : 'captain_b'} = ? WHERE id = ?`, squad[0]?.id || null, matchId);
    }
  }
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
  if (!bowlers.includes(inn.bowler_id)) run('UPDATE innings SET bowler_id = ? WHERE id = ?', pickBowler(m, inn, lastOverBowler(inn.id)), inn.id);
}

function overCall(m, inn, ctx, why = '') {
  const cur = latestInnings(m.id);
  ctx.notify.push({ userId: cur.bowler_id, title: 'Your over: bowl', body: `${why}Lock in six numbers against ${userName(cur.striker_id)}.`, kind: 'bowl' });
  ctx.notify.push({ userId: cur.striker_id, title: 'Your over: bat', body: `${why}Lock in six numbers against ${userName(cur.bowler_id)}.`, kind: 'bat' });
}

function createInnings(m, number, ctx) {
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
  const draft = { id: -1, batting, bowling: other(batting) };
  const striker = pickStriker(m, draft);
  const bowler = pickBowler(m, draft, null);
  run(`INSERT INTO innings (match_id, number, batting, bowling, max_balls, max_wickets, target, super_over, striker_id, bowler_id, started_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`, m.id, number, batting, other(batting), maxBalls, maxWickets, target, superOver ? 1 : 0, striker, bowler, now());
  const label = superOver ? `Super over (${number === 3 ? 'first' : 'second'} half)` : number === 1 ? 'First innings' : 'Second innings';
  announce(m.id, `${label}: ${teamName(m, batting)} bat${target ? `, needing ${target} to win` : ''}. ${userName(striker)} faces ${userName(bowler)}.`, { type: 'innings', number });
  overCall(m, null, ctx);
}

function canStart(m, uid) {
  if (m.config.mode === 'umpire') return isUmpire(m, uid);
  return isHost(m, uid) || m.captain_a === uid || m.captain_b === uid;
}

export function startMatch(userId, matchId, ctx) {
  return tx(() => {
    const m = loadMatch(matchId);
    if (m.status !== 'lobby') fail('The match has already started.');
    if (!canStart(m, userId)) fail(m.config.mode === 'umpire' ? 'Only the umpire can start the match.' : 'Only the match host or a captain can start the match.');
    if (!teamPlayers(matchId, 'A').length || !teamPlayers(matchId, 'B').length) fail('Each team needs at least one player.');
    fixCaptains(matchId);
    run(`UPDATE matches SET status = 'live', started_at = ? WHERE id = ?`, now(), matchId);
    record(matchId, userId, 'start', `${userName(userId)} started the match.`, {}, false);
    createInnings({ ...loadMatch(matchId) }, 1, ctx);
  });
}

export function nextInnings(userId, matchId, ctx) {
  return tx(() => {
    const m = loadMatch(matchId);
    if (!isUmpire(m, userId)) fail('Only the umpire can start the next innings.');
    if (m.status !== 'innings_break') fail('There is no innings break right now.');
    const inn = latestInnings(matchId);
    run(`UPDATE matches SET status = 'live' WHERE id = ?`, matchId);
    record(matchId, userId, 'next_innings', `The umpire started innings ${inn.number + 1}.`, {}, false);
    createInnings(m, inn.number + 1, ctx);
  });
}

// ---------- the over: both sides lock in six numbers ----------
const commit = (digits) => {
  const salt = crypto.randomBytes(8).toString('hex');
  return { salt, hash: crypto.createHash('sha256').update(`${digits}:${salt}`).digest('hex') };
};

export function submitOver(userId, matchId, seq, ctx) {
  return tx(() => {
    const m = loadMatch(matchId);
    if (m.status !== 'live') fail('The match is not in play.');
    if (m.paused) fail('The umpire has paused the match.');
    const inn = latestInnings(matchId);
    if (!inn || inn.status !== 'live') fail('No innings in progress.');
    if (!Array.isArray(seq) || seq.length !== 6 || !seq.every((n) => Number.isInteger(n) && n >= 1 && n <= 6))
      fail('Enter exactly six numbers, each from 1 to 6.');

    let set = openSet(inn.id);
    const bowlerId = set ? set.bowler_id : inn.bowler_id;
    const batterId = set ? set.batter_id : inn.striker_id;
    const role = userId === bowlerId ? 'bowl' : userId === batterId ? 'bat' : null;
    if (!role) fail("It isn't your over.");
    if (!set) {
      const t = totals(inn.id);
      const left = inn.max_balls - t.balls;
      const cap = m.config.freshSetAfterWicket ? Math.min(6, left) : Math.min(6 - (t.balls % 6), left);
      run(`INSERT INTO sets (innings_id, bowler_id, batter_id, seq, salt, hash, cap, created_at) VALUES (?,?,?,?,?,?,?,?)`,
        inn.id, bowlerId, batterId, '', '', '', cap, now());
      set = openSet(inn.id);
    }
    const digits = seq.join('');
    const { salt, hash } = commit(digits);
    if (role === 'bowl') {
      if (set.seq) fail("You've already locked in this over. It can't be changed.");
      run('UPDATE sets SET seq = ?, salt = ?, hash = ?, bowl_at = ? WHERE id = ?', digits, salt, hash, now(), set.id);
    } else {
      if (set.bat_seq) fail("You've already locked in this over. It can't be changed.");
      run('UPDATE sets SET bat_seq = ?, bat_salt = ?, bat_hash = ?, bat_at = ? WHERE id = ?', digits, salt, hash, now(), set.id);
    }
    set = get('SELECT * FROM sets WHERE id = ?', set.id);
    announce(matchId, `🔒 ${userName(userId)} has locked in their six.`, { type: 'locked', role, hash });
    if (role === 'bowl' && isUmpire(m, m.umpire_id) && m.umpire_id !== batterId)
      ctx.notify.push({ userId: m.umpire_id, title: 'Bowler locked in', body: `${userName(userId)}'s six are in your umpire panel.`, kind: 'info' });

    if (set.seq && set.bat_seq) reveal(m, inn, set, ctx);
    else {
      const waiting = role === 'bowl' ? batterId : bowlerId;
      ctx.notify.push({ userId: waiting, title: `${userName(userId)} is locked in`, body: 'Your turn: lock in your six numbers.', kind: role === 'bowl' ? 'bat' : 'bowl' });
    }
  });
}

function reveal(m, inn, set, ctx) {
  const bowl = set.seq.split('').map(Number);
  const bat = set.bat_seq.split('').map(Number);
  const start = totals(inn.id);
  const batter = userName(set.batter_id), bowler = userName(set.bowler_id);
  // (set.used is only non-zero for an over that was half-played under the old one-ball-at-a-time rules.)
  let runs = start.runs, balls = start.balls, wickets = start.wickets, used = set.used, wicket = false;
  const out = [];
  for (let i = set.used; i < set.cap; i++) {
    wicket = bat[i] === bowl[i];
    const r = wicket ? 0 : bat[i];
    balls += 1; runs += r; used += 1;
    run(`INSERT INTO balls (innings_id, set_id, set_index, ball_no, stint, batter_id, bowler_id, bowl_num, bat_num, runs, is_wicket, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, inn.id, set.id, i, balls, start.wickets, set.batter_id, set.bowler_id, bowl[i], bat[i], r, wicket ? 1 : 0, now());
    out.push({ i, bat: bat[i], bowl: bowl[i], runs: r, wicket });
    const label = ballLabel(balls);
    const line = wicket ? `OUT! Both picked ${bowl[i]}. ${batter} is out.`
      : r === 6 ? `SIX! ${batter} 6, ${bowler} ${bowl[i]}.` : r === 4 ? `FOUR! ${batter} 4, ${bowler} ${bowl[i]}.`
      : `${r} run${r > 1 ? 's' : ''}. ${batter} ${bat[i]}, ${bowler} ${bowl[i]}.`;
    if (wicket) wickets += 1;
    announce(m.id, `${line} ${teamName(m, inn.batting)} ${runs}/${wickets} (ball ${label}).`, { type: 'ball', runs: r, wicket, bat: bat[i], bowl: bowl[i], over: label });
    if (wicket || (inn.target && runs >= inn.target) || balls >= inn.max_balls) break;
  }
  const overRuns = out.reduce((s, b) => s + b.runs, 0);
  const faced = out.length;
  const t = totals(inn.id);
  const chased = inn.target && t.runs >= inn.target;
  const ended = chased || t.wickets >= inn.max_wickets || t.balls >= inn.max_balls;
  run(`UPDATE sets SET used = ?, status = 'closed', end_reason = ?, revealed_at = ? WHERE id = ?`,
    used, ended ? 'innings' : wicket ? 'wicket' : 'complete', now(), set.id);
  ctx.fx.push({ type: 'reveal', balls: out, cap: set.cap, batter, bowler, runs: overRuns, wicket });
  announce(m.id, `Over revealed: ${batter} ${overRuns} run${overRuns === 1 ? '' : 's'} off ${faced} ball${faced === 1 ? '' : 's'}${wicket ? ', then out' : ''}. Bowler ${set.seq}, batter ${set.bat_seq}.`, { type: 'over' });

  if (ended) return endInnings(m, inn, ctx);
  const fresh = latestInnings(m.id);
  if (wicket) {
    const nb = pickStriker(m, fresh);
    run('UPDATE innings SET striker_id = ? WHERE id = ?', nb, inn.id);
    announce(m.id, `${userName(nb)} walks out to bat. ${inn.max_wickets - t.wickets} wicket${inn.max_wickets - t.wickets > 1 ? 's' : ''} left.`, { type: 'newbatter' });
  }
  if (!wicket || m.config.freshSetAfterWicket) {
    const nextBowler = pickBowler(m, fresh, set.bowler_id);
    run('UPDATE innings SET bowler_id = ? WHERE id = ?', nextBowler, inn.id);
    if (!wicket) announce(m.id, `End of over. ${teamName(m, inn.batting)} ${t.runs}/${t.wickets} after ${oversText(t.balls)}. ${userName(nextBowler)} bowls next.`, { type: 'endover' });
  }
  overCall(m, inn, ctx, wicket ? 'Wicket! ' : 'New over. ');
}

function endInnings(m, inn, ctx) {
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

function finishMatch(m, result, ctx, status = 'completed') {
  run(`UPDATE matches SET status = ?, result = ?, ended_at = ? WHERE id = ?`, status, JSON.stringify(result), now(), m.id);
  run(`UPDATE sets SET status = 'cancelled' WHERE status = 'open' AND innings_id IN (SELECT id FROM innings WHERE match_id = ?)`, m.id);
  run(`UPDATE innings SET status = 'done', ended_at = COALESCE(ended_at, ?) WHERE match_id = ?`, now(), m.id);
  announce(m.id, `🏆 ${result.text} Stats have been saved to every player's profile.`, { type: 'result' });
  ctx.fx.push({ type: 'result', text: result.text });
  for (const p of all('SELECT user_id FROM members WHERE match_id = ? AND banned = 0', m.id))
    ctx.notify.push({ userId: p.user_id, title: 'Match over', body: result.text, kind: 'info' });
}

// ---------- players picking their own team (lobby only) ----------
export function joinTeam(userId, matchId, team, ctx) {
  return tx(() => {
    const m = loadMatch(matchId);
    if (m.status !== 'lobby') fail('Teams are locked once the match starts. Ask a captain to add you.');
    const t = team === 'A' || team === 'B' ? team : null;
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
        break;
      }
      case 'bowl_order': {
        const order = Array.isArray(a.userIds) ? a.userIds.map(String) : [];
        if (!order.length) fail('Keep at least one bowler in the lineup.');
        if (!order.every((id) => ids.includes(id)) || new Set(order).size !== order.length) fail('Pick bowlers from your own team.');
        for (const id of ids) {
          const i = order.indexOf(id);
          run('UPDATE members SET bowls = ?, bowl_order = ? WHERE match_id = ? AND user_id = ?', i >= 0 ? 1 : 0, i >= 0 ? i : 99, matchId, id);
        }
        if (live && inn.bowling === team) refreshCurrent(m, latestInnings(matchId));
        record(matchId, userId, 'bowl_order', `${tn} bowling order: ${order.map(userName).join(', ')}.`, { team, order });
        break;
      }
      case 'next_bowler': {
        if (!live || inn.bowling !== team) fail(`${tn} aren't bowling right now.`);
        if (openSet(inn.id)) fail('This over has already started. Pick the bowler for the next one after it.');
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
        run('UPDATE innings SET striker_id = ? WHERE id = ?', a.userId, inn.id);
        record(matchId, userId, 'next_batter', `${tn} captain sent ${userName(a.userId)} in to bat.`, { team, userId: a.userId });
        overCall(m, inn, ctx);
        break;
      }
      case 'add': {
        const mem = memberOf(matchId, a.userId);
        if (!mem || mem.banned || mem.team) fail('Pick someone who is watching, not already in a team.');
        putInTeam(m, a.userId, team);
        record(matchId, userId, 'add_player', `${userName(a.userId)} joins ${tn} (picked by the captain).`, { team, userId: a.userId });
        ctx.notify.push({ userId: a.userId, title: `You're playing for ${tn}`, body: 'Your captain added you to the squad.', kind: 'info' });
        break;
      }
      case 'remove': {
        if (!ids.includes(a.userId)) fail(`That player isn't in ${tn}.`);
        if (a.userId === userId) fail('Hand the captaincy to someone else first.');
        if (squad.length === 1) fail('A team needs at least one player.');
        if (live && openSet(inn.id) && (inn.striker_id === a.userId || inn.bowler_id === a.userId)) fail(`${userName(a.userId)} is in the middle of an over.`);
        putInTeam(m, a.userId, null);
        record(matchId, userId, 'remove_player', `${userName(a.userId)} left ${tn}'s lineup (captain's decision).`, { team, userId: a.userId });
        break;
      }
      case 'captain': {
        if (!ids.includes(a.userId)) fail(`Pick someone from ${tn}.`);
        run(`UPDATE matches SET ${team === 'A' ? 'captain_a' : 'captain_b'} = ? WHERE id = ?`, a.userId, matchId);
        record(matchId, userId, 'captain', `${userName(a.userId)} is now ${tn}'s captain.`, { team, userId: a.userId });
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
        if (m.status !== 'lobby') fail('Once the match starts, only captains change their squads.');
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
        ctx.notify.push({ userId: a.userId, title: `You're captain of ${teamName(m, team)}`, body: 'You set the batting and bowling lineups.', kind: 'info' });
        break;
      }
      case 'setup': {
        needHost();
        if (m.status !== 'lobby') fail('Match settings are locked once play starts.');
        const cfg = sanitizeConfig(a.config || {}, m.config);
        run('UPDATE matches SET name = ?, team_a = ?, team_b = ?, toss_bat = ?, config = ? WHERE id = ?',
          (a.name || m.name).slice(0, 60), (a.teamA || m.team_a).slice(0, 30), (a.teamB || m.team_b).slice(0, 30),
          a.tossBat === 'B' ? 'B' : a.tossBat === 'A' ? 'A' : m.toss_bat, JSON.stringify(cfg), matchId);
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
        run('UPDATE balls SET voided = 1 WHERE set_id = ?', set.id);
        run(`UPDATE sets SET end_reason = 'voided' WHERE id = ?`, set.id);
        run(`UPDATE innings SET status = 'live', ended_at = NULL, striker_id = ?, bowler_id = ? WHERE id = ?`, set.batter_id, set.bowler_id, inn.id);
        run(`UPDATE matches SET status = 'live' WHERE id = ?`, matchId);
        record(matchId, userId, 'void_over', `Umpire voided the last over (${reason}). ${userName(set.bowler_id)} and ${userName(set.batter_id)} lock in again.`, { setId: set.id, reason });
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
        const reason = String(a.reason || '').slice(0, 140);
        let result;
        if (a.outcome === 'A' || a.outcome === 'B') result = { winner: a.outcome, tie: false, text: `${teamName(m, a.outcome)} won (${ump ? "umpire's decision" : 'declared by the host'}${reason ? `: ${reason}` : ''}).` };
        else if (a.outcome === 'tie') result = { winner: null, tie: true, text: `Match declared a tie${reason ? ` (${reason})` : ''}.` };
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
        run('UPDATE members SET banned = 1, team = NULL WHERE match_id = ? AND user_id = ?', matchId, a.userId);
        fixCaptains(matchId);
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
  const bowling = all(`SELECT b.bowler_id AS id, u.display_name AS name, COUNT(*) AS balls, SUM(runs) AS runs, SUM(is_wicket) AS wickets,
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
                         m.bowl_order AS bowlOrd, m.bowls, m.muted
                       FROM members m JOIN users u ON u.id = m.user_id WHERE m.match_id = ? AND m.banned = 0 ORDER BY m.joined_at`, matchId)
    .map((x) => ({ ...x, bowls: !!x.bowls, muted: !!x.muted }));
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
    const ballsLeftThisOver = m.config.freshSetAfterWicket ? Math.min(6, left) : Math.min(6 - (t.balls % 6), left);
    current = {
      number: inn.number, phase, strikerId: inn.striker_id, bowlerId: inn.bowler_id,
      strikerName: userName(inn.striker_id), bowlerName: userName(inn.bowler_id),
      set: last ? setView(last) : null, open: !!open, cap: open ? open.cap : ballsLeftThisOver,
      lastOverBowler: lastOverBowler(inn.id), strikerFresh: inn.status === 'live' ? strikerFresh(inn) : false,
      runRate: rr.toFixed(2), need, ballsLeft: left,
      requiredRate: need != null && left > 0 ? ((need * 6) / left).toFixed(2) : null,
      dismissed: Object.fromEntries(dismissals(inn.id)),
    };
  }
  const commentary = all(`SELECT b.*, i.number AS inn, bu.display_name AS batter, bo.display_name AS bowler
      FROM balls b JOIN innings i ON i.id = b.innings_id JOIN users bu ON bu.id = b.batter_id JOIN users bo ON bo.id = b.bowler_id
      WHERE i.match_id = ? ORDER BY b.id DESC LIMIT 60`, matchId)
    .map((b) => ({ id: b.id, inn: b.inn, over: ballLabel(b.ball_no), ballNo: b.ball_no, batter: b.batter, bowler: b.bowler,
      bat: b.bat_num, bowl: b.bowl_num, runs: b.runs, wicket: !!b.is_wicket, voided: !!b.voided }));
  const history = all('SELECT id, action, text, created_at FROM audit WHERE match_id = ? AND text IS NOT NULL ORDER BY id DESC LIMIT 60', matchId)
    .map((h) => ({ id: h.id, action: h.action, text: h.text, at: h.created_at }));
  return {
    id: m.id, name: m.name, status: m.status, paused: !!m.paused, config: m.config, tossBat: m.toss_bat,
    mode: m.config.mode,
    host: { id: m.umpire_id, name: userName(m.umpire_id) },
    umpire: m.config.mode === 'umpire' ? { id: m.umpire_id, name: userName(m.umpire_id) } : null,
    captains: { A: m.captain_a, B: m.captain_b },
    teams: {
      A: { name: m.team_a, players: members.filter((x) => x.team === 'A').sort((a, b) => a.ord - b.ord) },
      B: { name: m.team_b, players: members.filter((x) => x.team === 'B').sort((a, b) => a.ord - b.ord) },
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
    if (set && set.bowler_id === userId && set.seq) out.myLocked = set.seq.split('').map(Number);
    if (set && set.batter_id === userId && set.bat_seq) out.myLocked = set.bat_seq.split('').map(Number);
    // With an umpire, the umpire privately sees the bowler's six (never the batter's), unless the umpire is the batter.
    if (set && out.isUmpire && set.seq && set.batter_id !== userId) out.bowlerSequence = set.seq.split('').map(Number);
  }
  return out;
}
