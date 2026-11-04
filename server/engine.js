// The game rules. Every function here is server-authoritative: clients only send intents.
import crypto from 'node:crypto';
import { get, all, run, tx } from './db.js';

export class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };
const now = () => Date.now();

export const DEFAULT_CONFIG = {
  overs: 2,               // overs per innings (6 legal balls each)
  wickets: 3,             // wickets per innings
  playersPerTeam: 11,     // maximum squad size
  superOver: true,        // play a super over on a tie
  freshSetAfterWicket: true, // WhatsApp rule: a new batter always gets a fresh 6-ball sequence
  autoBowler: true,       // rotate bowlers automatically after each completed over
};

export function sanitizeConfig(input = {}) {
  const c = { ...DEFAULT_CONFIG };
  const int = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  c.overs = int(input.overs, 1, 50, c.overs);
  c.wickets = int(input.wickets, 1, 20, c.wickets);
  c.playersPerTeam = int(input.playersPerTeam, 1, 15, c.playersPerTeam);
  for (const k of ['superOver', 'freshSetAfterWicket', 'autoBowler']) if (k in input) c[k] = !!input[k];
  return c;
}

// ---------- reads ----------
export function loadMatch(id) {
  const m = get('SELECT * FROM matches WHERE id = ?', id);
  if (!m) fail('Match not found.');
  m.config = JSON.parse(m.config);
  m.result = m.result ? JSON.parse(m.result) : null;
  return m;
}
const teamName = (m, t) => (t === 'A' ? m.team_a : m.team_b);
const other = (t) => (t === 'A' ? 'B' : 'A');
const userName = (id) => get('SELECT display_name FROM users WHERE id = ?', id)?.display_name || 'Someone';

export const teamPlayers = (matchId, team) =>
  all(`SELECT m.user_id AS id, u.display_name AS name, m.bat_order FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.match_id = ? AND m.team = ? AND m.banned = 0 ORDER BY m.bat_order, m.joined_at`, matchId, team);

export const latestInnings = (matchId) =>
  get('SELECT * FROM innings WHERE match_id = ? ORDER BY number DESC LIMIT 1', matchId);

export function totals(inningsId) {
  const t = get(`SELECT COALESCE(SUM(runs),0) AS runs, COALESCE(SUM(is_wicket),0) AS wickets, COUNT(*) AS balls
                 FROM balls WHERE innings_id = ? AND voided = 0`, inningsId);
  const inn = get('SELECT extras FROM innings WHERE id = ?', inningsId);
  return { runs: t.runs + (inn?.extras || 0), wickets: t.wickets, balls: t.balls };
}
const openSet = (inningsId) => get(`SELECT * FROM sets WHERE innings_id = ? AND status = 'open'`, inningsId);

export const oversText = (balls) => `${Math.floor(balls / 6)}.${balls % 6}`;
// Cricket notation for the nth ball: ball 1 is 0.1, ball 6 is 0.6, ball 7 is 1.1.
export const ballLabel = (n) => `${Math.floor((n - 1) / 6)}.${((n - 1) % 6) + 1}`;

// ---------- effects collected for the socket layer ----------
export const newCtx = () => ({ notify: [], fx: [], kicked: [] });

export function announce(matchId, text, meta = null, channel = 'public', kind = 'event') {
  run(`INSERT INTO messages (match_id, channel, user_id, kind, text, meta, created_at) VALUES (?,?,?,?,?,?,?)`,
    matchId, channel, null, kind, text, meta ? JSON.stringify(meta) : null, now());
}
function audit(matchId, userId, action, detail) {
  run('INSERT INTO audit (match_id, user_id, action, detail, created_at) VALUES (?,?,?,?,?)',
    matchId, userId, action, JSON.stringify(detail || {}), now());
}

// ---------- match creation & membership ----------
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    const code = Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    if (!get('SELECT 1 FROM matches WHERE id = ?', code)) return code;
  }
}

export function createMatch(userId, { name, teamA, teamB, config }) {
  const id = newCode();
  tx(() => {
    run(`INSERT INTO matches (id, name, umpire_id, config, team_a, team_b, created_at) VALUES (?,?,?,?,?,?,?)`,
      id, (name || 'Friendly match').slice(0, 60), userId, JSON.stringify(sanitizeConfig(config)),
      (teamA || 'Team A').slice(0, 30), (teamB || 'Team B').slice(0, 30), now());
    run('INSERT INTO members (match_id, user_id, joined_at) VALUES (?,?,?)', id, userId, now());
    announce(id, `Match created. Share the link so friends can join.`, null, 'public', 'system');
  });
  return id;
}

export function joinMatch(userId, matchId) {
  const m = loadMatch(matchId);
  const mem = get('SELECT * FROM members WHERE match_id = ? AND user_id = ?', matchId, userId);
  if (mem?.banned) fail('The umpire removed you from this match.');
  if (!mem) {
    run('INSERT INTO members (match_id, user_id, joined_at) VALUES (?,?,?)', matchId, userId, now());
    if (m.status === 'lobby') announce(matchId, `${userName(userId)} joined.`, null, 'public', 'system');
    return true;
  }
  return false;
}

// ---------- umpire helpers ----------
function requireUmpire(m, userId) { if (m.umpire_id !== userId) fail('Only the umpire can do that.'); }
function requireActive(m) {
  if (m.status === 'completed' || m.status === 'abandoned') fail('This match has finished.');
}

function pickBowler(m, inn, prevBowler) {
  const squad = teamPlayers(m.id, inn.bowling);
  if (!squad.length) fail('The bowling team has no players.');
  if (!prevBowler) return squad[0].id;
  const i = squad.findIndex((p) => p.id === prevBowler);
  return squad[(i + 1) % squad.length].id;
}

function nextBatter(m, inn, wickets) {
  const order = teamPlayers(m.id, inn.batting);
  if (!order.length) fail('The batting team has no players.');
  // Fewer players than wickets (e.g. 1 v 1): the order cycles, so a player can bat again.
  return order[wickets % order.length].id;
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
  const inn = { batting, bowling: other(batting) };
  const striker = nextBatter(m, inn, 0);
  const bowler = pickBowler(m, inn, null);
  run(`INSERT INTO innings (match_id, number, batting, bowling, max_balls, max_wickets, target, super_over, striker_id, bowler_id, started_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`, m.id, number, batting, other(batting), maxBalls, maxWickets, target, superOver ? 1 : 0, striker, bowler, now());

  const label = superOver ? `Super over (${number === 3 ? 'first' : 'second'} half)` : number === 1 ? 'First innings' : 'Second innings';
  announce(m.id, `${label}: ${teamName(m, batting)} bat${target ? `, needing ${target} to win` : ''}. ${userName(striker)} to face ${userName(bowler)}.`,
    { type: 'innings', number });
  ctx.notify.push({ userId: bowler, title: 'You are bowling', body: 'Seal your six numbers for the over.', kind: 'bowl' });
  ctx.notify.push({ userId: striker, title: 'You are opening the batting', body: `Waiting for ${userName(bowler)} to seal the over.`, kind: 'info' });
}

export function startMatch(userId, matchId, ctx) {
  return tx(() => {
    const m = loadMatch(matchId);
    requireUmpire(m, userId);
    if (m.status !== 'lobby') fail('The match has already started.');
    if (!teamPlayers(matchId, 'A').length || !teamPlayers(matchId, 'B').length) fail('Each team needs at least one player.');
    run(`UPDATE matches SET status = 'live', started_at = ? WHERE id = ?`, now(), matchId);
    audit(matchId, userId, 'start', {});
    createInnings({ ...m, status: 'live' }, 1, ctx);
  });
}

export function nextInnings(userId, matchId, ctx) {
  return tx(() => {
    const m = loadMatch(matchId);
    requireUmpire(m, userId);
    if (m.status !== 'innings_break') fail('There is no innings break right now.');
    const inn = latestInnings(matchId);
    run(`UPDATE matches SET status = 'live' WHERE id = ?`, matchId);
    audit(matchId, userId, 'next_innings', { number: inn.number + 1 });
    createInnings(m, inn.number + 1, ctx);
  });
}

// ---------- bowler ----------
export function submitSequence(userId, matchId, seq, ctx) {
  return tx(() => {
    const m = loadMatch(matchId);
    if (m.status !== 'live') fail('The match is not in play.');
    if (m.paused) fail('The umpire has paused the match.');
    const inn = latestInnings(matchId);
    if (!inn || inn.status !== 'live') fail('No innings in progress.');
    if (inn.bowler_id !== userId) fail('You are not the bowler for this over.');
    if (openSet(inn.id)) fail('You have already sealed this over. It cannot be changed.');
    if (!Array.isArray(seq) || seq.length !== 6 || !seq.every((n) => Number.isInteger(n) && n >= 1 && n <= 6))
      fail('Pick exactly six numbers, each from 1 to 6.');

    const t = totals(inn.id);
    const left = inn.max_balls - t.balls;
    const cap = m.config.freshSetAfterWicket ? Math.min(6, left) : Math.min(6 - (t.balls % 6), left);
    const digits = seq.join('');
    const salt = crypto.randomBytes(8).toString('hex');
    const hash = crypto.createHash('sha256').update(`${digits}:${salt}`).digest('hex');
    run(`INSERT INTO sets (innings_id, bowler_id, batter_id, seq, salt, hash, cap, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      inn.id, userId, inn.striker_id, digits, salt, hash, cap, now());

    announce(matchId, `${userName(userId)} has sealed the over. ${userName(inn.striker_id)}, you're on strike.`, { type: 'sealed', hash });
    announce(matchId, `Sequence sealed (fingerprint ${hash.slice(0, 10)}). The umpire cannot see it unless a dispute is raised.`,
      { type: 'sealed', hash }, `pvt:${userId}`, 'system');
    ctx.notify.push({ userId: inn.striker_id, title: 'Your turn to bat', body: `${userName(userId)} has bowled. Pick a number for ball 1.`, kind: 'bat' });
    ctx.notify.push({ userId: m.umpire_id, title: 'Over sealed', body: `${userName(userId)} submitted the sequence privately.`, kind: 'info' });
  });
}

// ---------- batter ----------
export function playBall(userId, matchId, num, ballNo, ctx) {
  return tx(() => {
    const m = loadMatch(matchId);
    if (m.status !== 'live') fail('The match is not in play.');
    if (m.paused) fail('The umpire has paused the match.');
    const inn = latestInnings(matchId);
    if (!inn || inn.status !== 'live') fail('No innings in progress.');
    const set = openSet(inn.id);
    if (!set) fail('Wait for the bowler to seal the over.');
    if (set.batter_id !== userId) fail('It is not your turn to bat.');
    if (!Number.isInteger(num) || num < 1 || num > 6) fail('Pick a number from 1 to 6.');
    const before = totals(inn.id);
    if (ballNo !== before.balls + 1) fail('That ball has already been played.');

    const bowl = Number(set.seq[set.used]);
    const wicket = bowl === num;
    const runs = wicket ? 0 : num;
    run(`INSERT INTO balls (innings_id, set_id, set_index, ball_no, stint, batter_id, bowler_id, bowl_num, bat_num, runs, is_wicket, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      inn.id, set.id, set.used, ballNo, before.wickets, userId, set.bowler_id, bowl, num, runs, wicket ? 1 : 0, now());
    run('UPDATE sets SET used = used + 1 WHERE id = ?', set.id);

    const t = totals(inn.id);
    const batter = userName(userId), bowler = userName(set.bowler_id);
    const over = ballLabel(ballNo);
    let line;
    if (wicket) line = `OUT! ${bowler} matched ${bowl}. ${batter} is out.`;
    else if (runs === 6) line = `SIX! ${batter} picks 6, ${bowler} had ${bowl}.`;
    else if (runs === 4) line = `FOUR! ${batter} picks 4, ${bowler} had ${bowl}.`;
    else line = `${runs} run${runs > 1 ? 's' : ''}. ${batter} picks ${num}, ${bowler} had ${bowl}.`;
    announce(matchId, `${line} ${teamName(m, inn.batting)} ${t.runs}/${t.wickets} (ball ${over}).`,
      { type: 'ball', runs, wicket, bat: num, bowl, over, score: `${t.runs}/${t.wickets}` });
    ctx.fx.push({ type: wicket ? 'wicket' : runs === 6 ? 'six' : runs === 4 ? 'four' : 'runs', runs, batter, bowler });

    const chased = inn.target && t.runs >= inn.target;
    const allOut = t.wickets >= inn.max_wickets;
    const ballsDone = t.balls >= inn.max_balls;

    if (chased || allOut || ballsDone) {
      closeSet(set, 'innings');
      endInnings(m, inn, ctx);
    } else if (wicket) {
      closeSet(set, 'wicket');
      const nb = nextBatter(m, inn, t.wickets);
      run('UPDATE innings SET striker_id = ? WHERE id = ?', nb, inn.id);
      announce(matchId, `${userName(nb)} walks out to bat. ${inn.max_wickets - t.wickets} wicket${inn.max_wickets - t.wickets > 1 ? 's' : ''} left.`, { type: 'newbatter' });
      ctx.notify.push({ userId: nb, title: "You're in!", body: `A wicket fell. Get ready, ${bowler} is sealing a fresh over.`, kind: 'bat' });
      ctx.notify.push({ userId: set.bowler_id, title: 'Wicket! Bowl again', body: `Seal a fresh sequence for ${userName(nb)}.`, kind: 'bowl' });
    } else if (set.used + 1 >= set.cap) {
      closeSet(set, 'complete');
      const nextBowler = m.config.autoBowler ? pickBowler(m, inn, set.bowler_id) : set.bowler_id;
      run('UPDATE innings SET bowler_id = ? WHERE id = ?', nextBowler, inn.id);
      announce(matchId, `End of over. ${teamName(m, inn.batting)} ${t.runs}/${t.wickets} after ${oversText(t.balls)} overs. ${userName(nextBowler)} to bowl next.`, { type: 'over' });
      ctx.notify.push({ userId: nextBowler, title: 'You are bowling', body: 'Seal your six numbers for the next over.', kind: 'bowl' });
    }
  });
}

function closeSet(set, reason) {
  run(`UPDATE sets SET status = 'closed', end_reason = ? WHERE id = ?`, reason, set.id);
}

function endInnings(m, inn, ctx) {
  run(`UPDATE innings SET status = 'done', ended_at = ? WHERE id = ?`, now(), inn.id);
  const t = totals(inn.id);
  const n = inn.number;
  announce(m.id, `Innings over: ${teamName(m, inn.batting)} ${t.runs}/${t.wickets} (${oversText(t.balls)} overs).`, { type: 'innings_end', number: n });

  if (n === 1 || n === 3) {
    run(`UPDATE matches SET status = 'innings_break' WHERE id = ?`, m.id);
    announce(m.id, `${teamName(m, other(inn.batting))} need ${t.runs + 1} to win. Waiting for the umpire to start the next innings.`, { type: 'break' });
    ctx.notify.push({ userId: m.umpire_id, title: 'Innings break', body: 'Start the next innings when everyone is ready.', kind: 'umpire' });
    return;
  }
  // n is 2 or 4: the chase is over
  const first = get('SELECT * FROM innings WHERE match_id = ? AND number = ?', m.id, n - 1);
  const a = totals(first.id);
  const so = n === 4 ? ' in the super over' : '';
  let result;
  if (t.runs >= inn.target) {
    const left = inn.max_wickets - t.wickets;
    result = { winner: inn.batting, tie: false, text: `${teamName(m, inn.batting)} won by ${left} wicket${left === 1 ? '' : 's'}${so}.` };
  } else if (t.runs === inn.target - 1) {
    if (n === 2 && m.config.superOver) {
      run(`UPDATE matches SET status = 'innings_break' WHERE id = ?`, m.id);
      announce(m.id, `Scores level at ${t.runs}! It's going to a super over.`, { type: 'tie' });
      ctx.notify.push({ userId: m.umpire_id, title: 'Tie! Super over', body: 'Start the super over when ready.', kind: 'umpire' });
      ctx.fx.push({ type: 'tie' });
      return;
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
  const everyone = all('SELECT user_id FROM members WHERE match_id = ? AND banned = 0', m.id);
  for (const p of everyone) ctx.notify.push({ userId: p.user_id, title: 'Match over', body: result.text, kind: 'info' });
}

// ---------- umpire controls ----------
export function umpireAction(userId, matchId, a, ctx) {
  return tx(() => {
    const m = loadMatch(matchId);
    requireUmpire(m, userId);
    const inn = latestInnings(matchId);
    switch (a.type) {
      case 'assign': {
        requireActive(m);
        const mem = get('SELECT * FROM members WHERE match_id = ? AND user_id = ?', matchId, a.userId);
        if (!mem || mem.banned) fail('That person is not in this match.');
        const team = a.team === 'A' || a.team === 'B' ? a.team : null;
        if (inn && inn.status === 'live') {
          const set = openSet(inn.id);
          if (set && (set.batter_id === a.userId || set.bowler_id === a.userId)) fail('That player is in the middle of an over.');
          if (!team && (inn.striker_id === a.userId || inn.bowler_id === a.userId)) fail('Pick a different striker or bowler first.');
        }
        if (team && mem.team !== team && teamPlayers(matchId, team).length >= m.config.playersPerTeam) fail('That team is full.');
        const order = (get('SELECT MAX(bat_order) AS o FROM members WHERE match_id = ? AND team = ?', matchId, team)?.o ?? -1) + 1;
        run('UPDATE members SET team = ?, bat_order = ? WHERE match_id = ? AND user_id = ?', team, order, matchId, a.userId);
        audit(matchId, userId, 'assign', { userId: a.userId, team });
        announce(matchId, team ? `${userName(a.userId)} joins ${teamName(m, team)}.` : `${userName(a.userId)} is now spectating.`, null, 'public', 'system');
        if (team) ctx.notify.push({ userId: a.userId, title: `You're playing for ${teamName(m, team)}`, body: 'The umpire added you to the squad.', kind: 'info' });
        break;
      }
      case 'order': {
        const team = a.team === 'A' ? 'A' : 'B';
        const ids = Array.isArray(a.userIds) ? a.userIds : [];
        ids.forEach((id, i) => run('UPDATE members SET bat_order = ? WHERE match_id = ? AND user_id = ? AND team = ?', i, matchId, id, team));
        audit(matchId, userId, 'batting_order', { team, ids });
        break;
      }
      case 'setup': {
        if (m.status !== 'lobby') fail('Match settings are locked once play starts.');
        const cfg = sanitizeConfig({ ...m.config, ...(a.config || {}) });
        run('UPDATE matches SET name = ?, team_a = ?, team_b = ?, toss_bat = ?, config = ? WHERE id = ?',
          (a.name || m.name).slice(0, 60), (a.teamA || m.team_a).slice(0, 30), (a.teamB || m.team_b).slice(0, 30),
          a.tossBat === 'B' ? 'B' : a.tossBat === 'A' ? 'A' : m.toss_bat, JSON.stringify(cfg), matchId);
        audit(matchId, userId, 'setup', a);
        break;
      }
      case 'pause': case 'resume': {
        requireActive(m);
        if (m.status === 'lobby') fail('The match has not started.');
        const p = a.type === 'pause' ? 1 : 0;
        run('UPDATE matches SET paused = ? WHERE id = ?', p, matchId);
        audit(matchId, userId, a.type, {});
        announce(matchId, p ? '⏸ The umpire has paused play.' : '▶ Play resumes.', { type: a.type });
        break;
      }
      case 'bowler': case 'striker': {
        if (!inn || inn.status !== 'live') fail('No innings in progress.');
        if (openSet(inn.id)) fail('Wait until the current over is finished.');
        const team = a.type === 'bowler' ? inn.bowling : inn.batting;
        if (!teamPlayers(matchId, team).some((p) => p.id === a.userId)) fail(`Pick someone from ${teamName(m, team)}.`);
        run(`UPDATE innings SET ${a.type === 'bowler' ? 'bowler_id' : 'striker_id'} = ? WHERE id = ?`, a.userId, inn.id);
        audit(matchId, userId, a.type, { userId: a.userId });
        announce(matchId, a.type === 'bowler' ? `Bowling change: ${userName(a.userId)} will bowl.` : `${userName(a.userId)} comes in to bat.`, null, 'public', 'system');
        ctx.notify.push(a.type === 'bowler'
          ? { userId: a.userId, title: 'You are bowling', body: 'Seal your six numbers for the over.', kind: 'bowl' }
          : { userId: a.userId, title: "You're in!", body: 'Get ready to bat.', kind: 'bat' });
        break;
      }
      case 'void': {
        // Void the most recent ball. The over it belonged to is closed and the bowler seals a fresh one,
        // because the voided ball's number (and possibly the whole sequence) has already been revealed.
        if (!inn) fail('Nothing to correct.');
        if (!(m.status === 'live' || (m.status === 'innings_break' && inn.status === 'done'))) fail('Corrections are only possible during play or the innings break.');
        const ball = get('SELECT * FROM balls WHERE innings_id = ? AND voided = 0 ORDER BY ball_no DESC LIMIT 1', inn.id);
        if (!ball) fail('No balls to void in this innings.');
        const reason = String(a.reason || '').slice(0, 140) || 'Umpire correction';
        run(`UPDATE sets SET status = 'cancelled' WHERE innings_id = ? AND status = 'open' AND id <> ?`, inn.id, ball.set_id);
        run(`UPDATE sets SET status = 'closed', end_reason = COALESCE(end_reason, 'voided') WHERE id = ?`, ball.set_id);
        run('UPDATE balls SET voided = 1 WHERE id = ?', ball.id);
        run(`UPDATE innings SET status = 'live', ended_at = NULL, striker_id = ?, bowler_id = ? WHERE id = ?`, ball.batter_id, ball.bowler_id, inn.id);
        run(`UPDATE matches SET status = 'live' WHERE id = ?`, matchId);
        audit(matchId, userId, 'void_ball', { ball, reason });
        announce(matchId, `Umpire correction: ball ${ball.ball_no} of the innings removed (${reason}). ${userName(ball.bowler_id)} seals a fresh over.`, { type: 'correction' });
        ctx.notify.push({ userId: ball.bowler_id, title: 'Ball voided', body: 'Seal a fresh sequence to continue.', kind: 'bowl' });
        break;
      }
      case 'adjust': {
        if (!inn) fail('No innings yet.');
        if (m.status !== 'live' && m.status !== 'innings_break') fail('Adjustments are only possible during the match.');
        const delta = parseInt(a.runs, 10);
        if (!delta || Math.abs(delta) > 50) fail('Enter a run adjustment between -50 and 50.');
        const reason = String(a.reason || '').slice(0, 140) || 'Umpire adjustment';
        run('UPDATE innings SET extras = extras + ? WHERE id = ?', delta, inn.id);
        audit(matchId, userId, 'adjust_runs', { innings: inn.number, delta, reason });
        announce(matchId, `Umpire adjustment: ${delta > 0 ? '+' : ''}${delta} run${Math.abs(delta) === 1 ? '' : 's'} to ${teamName(m, inn.batting)} (${reason}).`, { type: 'correction' });
        const t = totals(inn.id);
        if (inn.status === 'live' && inn.target && t.runs >= inn.target) {
          const set = openSet(inn.id); if (set) closeSet(set, 'innings');
          endInnings(m, inn, ctx);
        }
        break;
      }
      case 'unseal': {
        if (!inn) fail('No innings in progress.');
        const set = openSet(inn.id);
        if (!set) fail('There is no sealed over right now.');
        if (set.batter_id === userId) fail('You are the batter, so you cannot unseal this over.');
        const reason = String(a.reason || '').slice(0, 140);
        if (!reason) fail('Give a reason for the dispute.');
        run('UPDATE sets SET unsealed_by = ? WHERE id = ?', userId, set.id);
        audit(matchId, userId, 'unseal', { setId: set.id, reason });
        announce(matchId, `⚖ The umpire opened the sealed over for a dispute review: ${reason}`, { type: 'dispute' });
        break;
      }
      case 'end': {
        requireActive(m);
        const reason = String(a.reason || '').slice(0, 140);
        let result;
        if (a.outcome === 'A' || a.outcome === 'B') result = { winner: a.outcome, tie: false, text: `${teamName(m, a.outcome)} won (umpire's decision${reason ? `: ${reason}` : ''}).` };
        else if (a.outcome === 'tie') result = { winner: null, tie: true, text: `Match declared a tie${reason ? ` (${reason})` : ''}.` };
        else result = { winner: null, tie: false, abandoned: true, text: `Match abandoned${reason ? ` (${reason})` : ''}.` };
        audit(matchId, userId, 'end_match', { outcome: a.outcome, reason });
        finishMatch(m, result, ctx, result.abandoned ? 'abandoned' : 'completed');
        break;
      }
      case 'mute': {
        if (a.userId === m.umpire_id) fail('You cannot mute yourself.');
        run('UPDATE members SET muted = ? WHERE match_id = ? AND user_id = ?', a.muted ? 1 : 0, matchId, a.userId);
        audit(matchId, userId, a.muted ? 'mute' : 'unmute', { userId: a.userId });
        ctx.notify.push({ userId: a.userId, title: a.muted ? 'You have been muted' : 'You can chat again', body: a.muted ? 'The umpire muted you in the match chat.' : 'The umpire unmuted you.', kind: 'info' });
        break;
      }
      case 'kick': {
        if (a.userId === m.umpire_id) fail('You cannot remove yourself.');
        if (inn && inn.status === 'live' && (inn.striker_id === a.userId || inn.bowler_id === a.userId)) fail('Change the striker or bowler before removing this player.');
        run('UPDATE members SET banned = 1, team = NULL WHERE match_id = ? AND user_id = ?', matchId, a.userId);
        audit(matchId, userId, 'kick', { userId: a.userId });
        announce(matchId, `${userName(a.userId)} was removed by the umpire.`, null, 'public', 'system');
        ctx.kicked.push(a.userId);
        break;
      }
      case 'delete_message': {
        run('UPDATE messages SET deleted = 1 WHERE id = ? AND match_id = ?', a.messageId, matchId);
        audit(matchId, userId, 'delete_message', { messageId: a.messageId });
        break;
      }
      default: fail('Unknown action.');
    }
  });
}

// ---------- chat ----------
export function canReadChannel(m, userId, channel) {
  if (channel === 'public') return true;
  const owner = channel.startsWith('pvt:') ? channel.slice(4) : null;
  return !!owner && (owner === userId || m.umpire_id === userId);
}

export function postChat(userId, matchId, channel, text) {
  const m = loadMatch(matchId);
  const mem = get('SELECT * FROM members WHERE match_id = ? AND user_id = ?', matchId, userId);
  if (!mem || mem.banned) fail('Join the match to chat.');
  if (mem.muted && channel === 'public') fail('The umpire has muted you.');
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

export function chatHistory(m, userId, limit = 120) {
  const chans = ['public'];
  if (m.umpire_id === userId) {
    for (const r of all(`SELECT DISTINCT channel FROM messages WHERE match_id = ? AND channel LIKE 'pvt:%'`, m.id)) chans.push(r.channel);
  } else chans.push(`pvt:${userId}`);
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
      SUM(CASE WHEN runs = 4 THEN 1 ELSE 0 END) AS fours, SUM(CASE WHEN runs = 6 THEN 1 ELSE 0 END) AS sixes,
      SUM(is_wicket) AS outs
    FROM balls b JOIN users u ON u.id = b.batter_id WHERE innings_id = ? AND voided = 0
    GROUP BY b.batter_id ORDER BY MIN(b.ball_no)`, inn.id);
  const bowling = all(`SELECT b.bowler_id AS id, u.display_name AS name, COUNT(*) AS balls, SUM(runs) AS runs, SUM(is_wicket) AS wickets
    FROM balls b JOIN users u ON u.id = b.bowler_id WHERE innings_id = ? AND voided = 0
    GROUP BY b.bowler_id ORDER BY MIN(b.ball_no)`, inn.id);
  const t = totals(inn.id);
  return {
    number: inn.number, superOver: !!inn.super_over, batting: inn.batting, bowling: inn.bowling,
    battingName: teamName(m, inn.batting), runs: t.runs, wickets: t.wickets, balls: t.balls, extras: inn.extras,
    overs: oversText(t.balls), maxBalls: inn.max_balls, maxWickets: inn.max_wickets, target: inn.target, status: inn.status,
    card: { batting, bowling },
  };
}

function setView(set, revealAll) {
  const balls = all('SELECT set_index, bat_num, bowl_num, runs, is_wicket, voided FROM balls WHERE set_id = ? ORDER BY set_index', set.id);
  const closed = set.status !== 'open';
  return {
    id: set.id, cap: set.cap, used: set.used, status: set.status, endReason: set.end_reason,
    hash: set.hash, bowlerId: set.bowler_id, batterId: set.batter_id,
    balls: balls.map((b) => ({ i: b.set_index, bat: b.bat_num, bowl: b.bowl_num, runs: b.runs, wicket: !!b.is_wicket, voided: !!b.voided })),
    // The full sequence and salt are only made public once the over is finished, so anyone can verify the fingerprint.
    reveal: closed || revealAll ? { seq: set.seq, salt: closed ? set.salt : null } : null,
  };
}

export function publicState(matchId) {
  const m = loadMatch(matchId);
  const members = all(`SELECT m.user_id AS id, u.display_name AS name, u.is_guest AS guest, m.team, m.bat_order AS ord, m.muted
                       FROM members m JOIN users u ON u.id = m.user_id WHERE m.match_id = ? AND m.banned = 0 ORDER BY m.joined_at`, matchId);
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
    if (m.status === 'live') phase = m.paused ? 'paused' : open ? 'awaiting_shot' : 'awaiting_sequence';
    current = {
      number: inn.number, phase, strikerId: inn.striker_id, bowlerId: inn.bowler_id,
      strikerName: userName(inn.striker_id), bowlerName: userName(inn.bowler_id),
      nextBallNo: t.balls + 1, set: last ? setView(last, false) : null, open: !!open,
      runRate: rr.toFixed(2), need, ballsLeft: left,
      requiredRate: need != null && left > 0 ? ((need * 6) / left).toFixed(2) : null,
    };
  }
  const commentary = all(`SELECT b.*, i.number AS inn, bu.display_name AS batter, bo.display_name AS bowler
      FROM balls b JOIN innings i ON i.id = b.innings_id JOIN users bu ON bu.id = b.batter_id JOIN users bo ON bo.id = b.bowler_id
      WHERE i.match_id = ? ORDER BY b.id DESC LIMIT 60`, matchId)
    .map((b) => ({ id: b.id, inn: b.inn, over: ballLabel(b.ball_no), ballNo: b.ball_no, batter: b.batter, bowler: b.bowler,
      bat: b.bat_num, bowl: b.bowl_num, runs: b.runs, wicket: !!b.is_wicket, voided: !!b.voided }));
  return {
    id: m.id, name: m.name, status: m.status, paused: !!m.paused, config: m.config, tossBat: m.toss_bat,
    umpire: { id: m.umpire_id, name: userName(m.umpire_id) },
    teams: {
      A: { name: m.team_a, players: members.filter((x) => x.team === 'A').sort((a, b) => a.ord - b.ord) },
      B: { name: m.team_b, players: members.filter((x) => x.team === 'B').sort((a, b) => a.ord - b.ord) },
    },
    members, innings, current, commentary, result: m.result, createdAt: m.created_at,
  };
}

// Extra, per-user information that must never go into the public broadcast.
export function privateState(matchId, userId) {
  const m = loadMatch(matchId);
  const inn = latestInnings(matchId);
  const out = { isUmpire: m.umpire_id === userId };
  const mem = get('SELECT muted FROM members WHERE match_id = ? AND user_id = ?', matchId, userId);
  out.muted = !!mem?.muted;
  if (inn) {
    const set = openSet(inn.id);
    if (set && set.bowler_id === userId) out.mySequence = set.seq.split('').map(Number);
    if (set && out.isUmpire && set.unsealed_by === userId) out.unsealedSequence = set.seq.split('').map(Number);
  }
  if (out.isUmpire) out.audit = all('SELECT a.*, u.display_name AS name FROM audit a JOIN users u ON u.id = a.user_id WHERE match_id = ? ORDER BY a.id DESC LIMIT 40', matchId)
    .map((r) => ({ id: r.id, action: r.action, name: r.name, detail: JSON.parse(r.detail || '{}'), at: r.created_at }));
  return out;
}
