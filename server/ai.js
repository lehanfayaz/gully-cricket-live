// The AI opponent. It is an ordinary participant: it decides from the same public information a human
// opponent sees (the public match state and the balls already revealed — never an open submission),
// then acts through the same engine functions (submitOver, captainAction, confirmLineup, callToss…)
// and the same validation. The decision-making itself lives in aibrain.js as pure functions.
import { all, get, run } from './db.js';
import * as G from './engine.js';
import { checkDigits } from './rules.js';
import * as B from './aibrain.js';

export { LEVELS, PERSONALITIES } from './aibrain.js';

// ---------- what the AI may know: revealed balls only ----------
// The opponent's revealed picks in this match, oldest first, with their position in the over.
// Only the balls table is read: a ball exists there only after both sides locked in and it was revealed.
export function revealedHistory(matchId, opponentTeam, role) {
  const col = role === 'bowl' ? 'bowl_num' : 'bat_num';
  const side = role === 'bowl' ? 'bowling' : 'batting';
  return all(`SELECT b.${col} AS d, b.ball_no AS n FROM balls b JOIN innings i ON i.id = b.innings_id
              WHERE i.match_id = ? AND i.${side} = ? AND b.voided = 0 ORDER BY b.id`, matchId, opponentTeam)
    .map((r) => ({ d: r.d, pos: (r.n - 1) % 6 }));
}
// Expert also remembers how this human played in their other matches (all of it already revealed).
function pastHistory(matchId, humanId, role) {
  if (!humanId) return [];
  const col = role === 'bowl' ? 'bowl_num' : 'bat_num', who = role === 'bowl' ? 'bowler_id' : 'batter_id';
  return all(`SELECT b.${col} AS d, b.ball_no AS n FROM balls b JOIN innings i ON i.id = b.innings_id
              JOIN members mm ON mm.match_id = i.match_id AND mm.user_id = b.${who}
              JOIN matches x ON x.id = i.match_id
              WHERE i.match_id <> ? AND b.voided = 0 AND (mm.user_id = ? OR mm.controller_id = ?)
              ORDER BY b.id DESC LIMIT 240`, matchId, humanId, humanId)
    .reverse().map((r) => ({ d: r.d, pos: (r.n - 1) % 6, past: true }));
}

// A small deterministic random source, so a decision taken at a given moment is stable
// (e.g. the AI doesn't keep changing its mind about the next bowler on every refresh).
function seeded(...parts) {
  let h = 2166136261;
  for (const ch of parts.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1e9) / 1e9; };
}

const scheduledBallsLeft = (t) => t
  ? Math.max(0, (t.days * t.sessionsPerDay - ((t.day - 1) * t.sessionsPerDay + t.session)) * t.oversPerSession * 6 + t.sessionBallsLeft)
  : 600;

// The match situation from the public state, in the shape the brain expects.
export function situationOf(state, aiTeam) {
  const cur = state.current, inn = state.innings[state.innings.length - 1];
  return {
    format: state.format,
    target: inn?.target || null,
    need: cur?.need ?? null,
    ballsLeft: cur?.ballsLeft ?? 0,
    wicketsLeft: inn ? inn.maxWickets - inn.wickets : 10,
    inningsNumber: inn?.number || 1,
    battingFirst: inn ? !inn.target : true,
    scheduledBallsLeft: state.format === 'test' ? scheduledBallsLeft(state.test) : cur?.ballsLeft ?? 0,
    aiBatting: inn?.batting === aiTeam,
  };
}

// ---------- choosing numbers (kept as one entry point for tests and callers) ----------
// history may be injected (tests); otherwise it is read from revealed balls.
export function chooseNumbers({ state, role, need, aiTeam, level = 'medium', personality = 'strategic', rand = Math.random, history, humanId }) {
  const cur = state.current;
  const oppTeam = aiTeam === 'A' ? 'B' : 'A';
  const oppRole = role === 'bat' ? 'bowl' : 'bat';
  let h = history || revealedHistory(state.id, oppTeam, oppRole);
  if (!history && level === 'expert' && h.length < 60) h = [...pastHistory(state.id, humanId, oppRole), ...h];
  const ctx = {
    format: state.format, need, level, personality, rand, oppHistory: h,
    bowledSinceWicket: cur?.bowledThisOver || [], ballInOver: cur?.ballInOver || 1,
    situation: situationOf(state, aiTeam),
  };
  if (role === 'bat') {
    ctx.requirement = state.test?.requirements?.find((r) => r.batterId === cur.strikerId && r.status === 'active') || null;
    // Scoreless balls so far in this over (-99 once anything has been scored), for the dot-over rule.
    const sofar = cur?.over && !cur.over.finished ? cur.over.balls : [];
    ctx.dotsThisOver = sofar.some((b) => b.runs > 0) ? -99 : sofar.length;
    return B.chooseBatting(ctx);
  }
  const inn = state.innings[state.innings.length - 1];
  const form = inn?.card?.batting?.find((b) => b.id === cur?.strikerId);
  ctx.batterForm = form ? { runs: form.runs, balls: form.balls } : null;
  return B.chooseBowling(ctx);
}

// ---------- the AI's turn in each phase of the match ----------
const ROLE_RANK = { wk: 0, bat: 1, ar: 2, bowl: 3 };
function battingOrder(players, format, personality) {
  const rank = (p) => {
    let r = ROLE_RANK[p.role] ?? 1;
    // Aggressive limited-overs captains push the all-rounders up the order.
    if (personality === 'aggressive' && format !== 'test' && p.role === 'ar') r = 0.5;
    return r;
  };
  return [...players].sort((a, b) => rank(a) - rank(b));
}

function tossDecision(format, level, personality, rand) {
  if (level === 'easy') return rand() < 0.5 ? 'bat' : 'bowl';
  if (personality === 'unpredictable') return rand() < 0.5 ? 'bat' : 'bowl';
  if (format === 'test') return personality === 'defensive' && level !== 'medium' ? 'bowl' : 'bat';
  if (personality === 'aggressive') return 'bat';  // set a big total
  return 'bowl';                                   // know the target
}

// One step for the AI in this match, if it has something to do. Returns a description or null.
// Acts for every AI side in the match (one against a human, or both in a tournament AI v AI fixture).
export function aiStep(matchId) {
  const m = G.loadMatch(matchId);
  if (m.config.participation !== 'ai' && m.config.participation !== 'aivai') return null;
  const bots = all(`SELECT m.user_id, m.team FROM members m JOIN users u ON u.id = m.user_id WHERE m.match_id = ? AND u.is_bot = 1 AND m.banned = 0 ORDER BY m.team`, matchId);
  for (const bot of bots) {
    const r = stepFor(matchId, bot);
    if (r) return r;
  }
  return null;
}

function stepFor(matchId, bot) {
  const m = G.loadMatch(matchId);
  const uid = bot.user_id, team = bot.team;
  const side = m.config.aiSides?.[team];
  const level = side?.level || m.config.aiLevel, personality = side?.personality || m.config.aiPersonality || 'strategic';
  const strong = level === 'hard' || level === 'expert';
  const state = G.publicState(matchId);
  const human = state.members.find((x) => !x.bot && !x.ghost && x.team && x.team !== team)?.id || null;
  const ctx = G.newCtx();
  const log = (kind, detail) => run('INSERT INTO ai_decisions (match_id, user_id, kind, detail, created_at) VALUES (?,?,?,?,?)', matchId, uid, kind, JSON.stringify({ ...detail, level, personality }), Date.now());
  const isCaptain = state.captains[team] === uid;

  if (state.status === 'lobby') {
    if (!state.lineups[team].confirmedAt && !state.toss.result) {
      const players = state.teams[team].players;
      if (state.teamSource === 'real' && players.length > 1 && isCaptain) {
        const withRole = players.map((p) => ({ ...p, role: (state.teamMeta[team]?.squad || []).find((s) => s.playerId === p.playerId)?.role || 'bat' }));
        const order = battingOrder(withRole, state.format, personality);
        G.captainAction(uid, matchId, { type: 'bat_order', team, userIds: order.map((p) => p.id) }, ctx);
        const bowlers = [...withRole].filter((p) => p.role === 'bowl' || p.role === 'ar')
          .sort((a, b) => (a.role === 'bowl' ? 0 : 1) - (b.role === 'bowl' ? 0 : 1));
        if (bowlers.length >= 2) G.captainAction(uid, matchId, { type: 'bowl_order', team, userIds: bowlers.map((p) => p.id) }, ctx);
      }
      G.confirmLineup(uid, matchId, team, ctx);
      log('confirm', { team });
      return { ctx, what: 'confirmed lineup' };
    }
    if (state.stage === 'toss_call' && state.captains[state.toss.caller] === uid) {
      const call = Math.random() < 0.5 ? 'heads' : 'tails';
      G.callToss(uid, matchId, call, ctx); log('toss_call', { call });
      return { ctx, what: 'called the toss' };
    }
    if (state.stage === 'toss_decision' && state.captains[state.toss.winner] === uid) {
      const decision = tossDecision(state.format, level, personality, Math.random);
      G.decideToss(uid, matchId, decision, ctx); log('toss_decision', { decision });
      return { ctx, what: `chose to ${decision}` };
    }
    return null;
  }

  if (state.status === 'innings_break' && state.test?.followOn && state.captains[state.test.followOn.team] === uid) {
    const lead = state.test.followOn.lead ?? 0;
    let enforce;
    if (level === 'easy' || personality === 'unpredictable') enforce = Math.random() < 0.5;
    else if (personality === 'aggressive') enforce = true;
    else if (personality === 'defensive') enforce = strong && lead >= 250;
    else enforce = strong || lead >= 250;
    G.testAction(uid, matchId, { type: 'follow_on', enforce }, ctx); log('follow_on', { enforce, lead });
    return { ctx, what: enforce ? 'enforced the follow-on' : 'declined the follow-on' };
  }

  if (state.status !== 'live' || state.paused) return null;
  const cur = state.current;
  if (!cur) return null;
  const inn = state.innings[state.innings.length - 1];
  const controls = (pid) => pid === uid || state.members.find((x) => x.id === pid)?.controller === uid;

  // Test: declare the third innings once the lead is out of reach (hard and expert only).
  if (state.format === 'test' && strong && !cur.open && inn.batting === team && inn.number === 3 && state.test && isCaptain) {
    const t = state.test;
    const lead = t.totals[team] - t.totals[team === 'A' ? 'B' : 'A'];
    const ballsLeft = scheduledBallsLeft(t);
    const factor = { aggressive: 1.3, strategic: 1.6, defensive: 2.1, unpredictable: 1.6 }[personality] ?? 1.6;
    if (lead > 0 && lead > ballsLeft * factor) {
      G.testAction(uid, matchId, { type: 'declare' }, ctx); log('declare', { lead, ballsLeft });
      return { ctx, what: 'declared' };
    }
  }

  // Captaincy at an over boundary: pick the next bowler from this innings' figures.
  if (isCaptain && !cur.open && inn.bowling === team && cur.ballInOver === 1 && inn.balls > 0 && level !== 'easy') {
    const bowlers = state.members.filter((x) => x.team === team && x.kind === 'player' && x.bowls);
    if (bowlers.length > 1) {
      const fig = Object.fromEntries((inn.card?.bowling || []).map((b) => [b.id, b]));
      const options = bowlers.map((b) => ({ id: b.id, balls: fig[b.id]?.balls || 0, runs: fig[b.id]?.runs || 0, wickets: fig[b.id]?.wickets || 0 }));
      const frac = inn.maxBalls ? inn.balls / inn.maxBalls : 0.5;
      const phase = state.format === 'test' ? 'middle' : frac >= 0.8 ? 'death' : frac < 0.2 ? 'powerplay' : 'middle';
      // Keep the workload spread: nobody bowls more than a fair share in limited overs.
      const maxBalls = state.format === 'test' ? Infinity : Math.ceil((inn.maxBalls || 120) / Math.max(5, bowlers.length) / 6) * 6;
      const pool = options.filter((o) => o.balls < maxBalls);
      const pick = B.chooseBowler({ options: pool.length >= 2 ? pool : options, last: cur.lastOverBowler, noConsecutive: m.config.noConsecutive, phase, level, personality, rand: seeded(matchId, inn.number, inn.balls) });
      if (pick && pick !== cur.bowlerId) {
        G.captainAction(uid, matchId, { type: 'next_bowler', team, userId: pick }, ctx);
        log('next_bowler', { userId: pick, phase });
        return { ctx, what: 'changed the bowler' };
      }
    }
  }
  // Captaincy after a wicket: an unpredictable captain may shuffle who comes in next.
  if (isCaptain && !cur.open && inn.batting === team && cur.strikerFresh && personality === 'unpredictable' && level !== 'easy') {
    const players = state.teams[team].players;
    const d = cur.dismissed || {};
    const fewest = Math.min(...players.map((p) => d[p.id] || 0));
    const eligible = players.filter((p) => (d[p.id] || 0) === fewest);
    const rand = seeded(matchId, inn.number, inn.wickets, 'bat');
    const pick = eligible.length > 1 && rand() < 0.35 ? eligible[Math.floor(rand() * eligible.length)].id : null;
    if (pick && pick !== cur.strikerId) {
      G.captainAction(uid, matchId, { type: 'next_batter', team, userId: pick }, ctx);
      log('next_batter', { userId: pick });
      return { ctx, what: 'sent in a batter' };
    }
  }

  const bowlerId = cur.open ? cur.set.bowlerId : cur.bowlerId;
  const batterId = cur.open ? cur.set.batterId : cur.strikerId;
  let role = null;
  if (controls(bowlerId) && !(cur.open && cur.set.bowlerLocked)) role = 'bowl';
  else if (controls(batterId) && !(cur.open && cur.set.batterLocked)) role = 'bat';
  if (!role) return null;
  if (state.test?.requirements?.some((r) => r.status === 'pending')) return null;
  const need = cur.cap;
  let seq = chooseNumbers({ state, role, need, aiTeam: team, level, personality, humanId: human });
  // Belt and braces: the engine validates again, exactly as for a human.
  if (checkDigits(m.config, role, seq, role === 'bowl' ? cur.bowledThisOver : [])) {
    log('fallback', { role, seq }); // should never happen; the tests assert it doesn't
    seq = chooseNumbers({ state, role, need, aiTeam: team, level: 'easy', personality: 'strategic', history: [] });
  }
  G.submitOver(uid, matchId, seq, ctx);
  log('submit', { role, count: seq.length });
  return { ctx, what: `${role} submission` };
}
