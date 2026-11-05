// The AI opponent. It is an ordinary participant: it decides from the same public information a human
// opponent sees (the public match state and the balls already revealed — never an open submission),
// then acts through the same engine functions (submitOver, confirmLineup, callToss…) and validation.
import { all, get, run } from './db.js';
import * as G from './engine.js';
import { checkDigits, rulesFor } from './rules.js';

const LEVELS = { easy: 0, medium: 1, hard: 2, expert: 3 };

// ---------- what the AI knows: public state + revealed balls only ----------
function revealedPicks(matchId, opponentTeam, role) {
  // role = the opponent's role. Revealed balls are in the balls table only after both sides locked in.
  const col = role === 'bowl' ? 'bowl_num' : 'bat_num';
  const side = role === 'bowl' ? 'bowling' : 'batting';
  return all(`SELECT b.${col} AS d FROM balls b JOIN innings i ON i.id = b.innings_id
              WHERE i.match_id = ? AND i.${side} = ? AND b.voided = 0 ORDER BY b.id`, matchId, opponentTeam).map((r) => r.d);
}

// Probability the opponent picks each digit, from their history (more weight on recent picks).
function opponentModel(level, allowed, history) {
  const p = Object.fromEntries(allowed.map((d) => [d, 1]));
  if (level >= 2 && history.length) {
    let w = 1;
    for (let i = history.length - 1; i >= 0 && i >= history.length - 60; i--, w *= 0.94) if (p[history[i]] != null) p[history[i]] += 1.6 * w;
  }
  if (level >= 3 && history.length >= 2) {
    // Expert also learns what tends to follow the opponent's last pick.
    const last = history[history.length - 1];
    for (let i = 1; i < history.length; i++) if (history[i - 1] === last && p[history[i]] != null) p[history[i]] += 1.2;
  }
  const sum = Object.values(p).reduce((a, b) => a + b, 0);
  for (const d of allowed) p[d] /= sum;
  return p;
}

// Bowler repetition rule (public: it only depends on balls already bowled this over).
function wouldBreak(n, soFar) {
  const c = {};
  for (const x of soFar) c[x] = (c[x] || 0) + 1;
  const next = (c[n] || 0) + 1;
  return next > 3 || (next === 3 && Object.entries(c).some(([d, k]) => Number(d) !== n && k >= 3));
}

function softPick(scores, temperature, rand) {
  const entries = Object.entries(scores);
  if (temperature == null) return Number(entries[Math.floor(rand() * entries.length)][0]);
  const max = Math.max(...entries.map(([, v]) => v));
  const w = entries.map(([d, v]) => [d, Math.exp((v - max) / temperature)]);
  let r = rand() * w.reduce((a, [, x]) => a + x, 0);
  for (const [d, x] of w) { r -= x; if (r <= 0) return Number(d); }
  return Number(w[w.length - 1][0]);
}
// Randomness by level (easy is pure random). Never fully deterministic, or a human could read it.
const TEMP = { bat: [null, 3.5, 2.0, 1.4], bowl: [null, 4.0, 2.5, 1.8] };

// How much a wicket "costs" right now, in runs. Higher = play safer.
function wicketCost(state, aiBatting) {
  const cur = state.current, inn = state.innings[state.innings.length - 1];
  const wicketsLeft = inn.maxWickets - inn.wickets;
  let cost = 10;
  if (state.format === 'test') {
    cost = 16;
    const t = state.test;
    const scheduledLeft = t ? (t.days * t.sessionsPerDay - ((t.day - 1) * t.sessionsPerDay + t.session)) * t.oversPerSession * 6 + t.sessionBallsLeft : 600;
    if (inn.target) { const need = cur.need; if (need > scheduledLeft * 2.4) cost = 30; } // can't win: bat for the draw
  } else if (inn.target && cur.ballsLeft > 0) {
    const rate = cur.need / cur.ballsLeft; // runs needed per ball
    cost = rate > 3.2 ? 4 : rate > 2.4 ? 7 : rate < 1.2 ? 18 : 11;
  } else if (cur.ballsLeft > 0) {
    cost = Math.max(4, 14 * Math.min(1, wicketsLeft / Math.max(1, cur.ballsLeft / 6)));
  }
  if (wicketsLeft <= 1) cost *= 1.6;
  return aiBatting ? cost : cost; // same scale used for both sides
}

// ---------- choosing numbers ----------
export function chooseNumbers({ state, role, need, aiTeam, level, rand = Math.random }) {
  const lv = LEVELS[level] ?? 1;
  const rules = rulesFor({ format: state.format });
  const cur = state.current;
  const oppTeam = aiTeam === 'A' ? 'B' : 'A';
  const W = wicketCost(state, role === 'bat');
  const out = [];
  if (role === 'bat') {
    const bowlAllowed = rules.bowler;
    const model = opponentModel(lv, bowlAllowed, revealedPicks(state.id, oppTeam, 'bowl'));
    // The bowler's numbers this over are public; anything the repetition rule now forbids them is safe.
    const bowled = [...(cur.bowledThisOver || [])];
    const req = state.test?.requirements?.find((r) => r.batterId === cur.strikerId && r.status === 'active');
    for (let i = 0; i < need; i++) {
      const p = { ...model };
      if (lv >= 1) for (const d of bowlAllowed) if (i === 0 && wouldBreak(d, bowled)) p[d] = 0;
      const sum = Object.values(p).reduce((a, b) => a + b, 0) || 1;
      const scores = {};
      for (const d of rules.batter) {
        const pOut = d === 0 ? 0 : (p[d] || 0) / sum;
        scores[d] = d * (1 - pOut) - W * pOut;
      }
      // Dot-over rule: must score off ball 1 or 2 of the over — never block then.
      const ballInOver = (cur.ballInOver - 1 + i) % 6;
      if (req && !req.startsNextOver && ballInOver < req.ballsLeft) delete scores[0];
      if (req && req.startsNextOver && ballInOver < 2) delete scores[0];
      out.push(softPick(scores, TEMP.bat[lv], rand));
    }
  } else {
    const model = opponentModel(lv, rules.batter, revealedPicks(state.id, oppTeam, 'bat'));
    const soFar = [...(cur.bowledThisOver || [])];
    for (let i = 0; i < need; i++) {
      const scores = {};
      for (const d of rules.bowler) {
        if (wouldBreak(d, soFar)) continue; // the same rule a human bowler follows
        // Expected value for the bowler: chance of matching × (wicket value + runs saved).
        scores[d] = (model[d] || 0) * (W + d) * 6;
      }
      const d = softPick(scores, TEMP.bowl[lv], rand);
      out.push(d); soFar.push(d);
    }
  }
  return out;
}

// ---------- the AI's turn in each phase of the match ----------
function bowlingOrder(players) {
  const rank = (p) => (p.role === 'bowl' ? 0 : p.role === 'ar' ? 1 : 2);
  return [...players].sort((a, b) => rank(a) - rank(b));
}

// One step for the AI in this match, if it has something to do. Returns a description or null.
export function aiStep(matchId) {
  const m = G.loadMatch(matchId);
  if (m.config.participation !== 'ai') return null;
  const bot = get(`SELECT m.user_id, m.team FROM members m JOIN users u ON u.id = m.user_id WHERE m.match_id = ? AND u.is_bot = 1 AND m.banned = 0`, matchId);
  if (!bot) return null;
  const uid = bot.user_id, team = bot.team, level = m.config.aiLevel;
  const lv = LEVELS[level] ?? 1;
  const state = G.publicState(matchId);
  const ctx = G.newCtx();
  const log = (kind, detail) => run('INSERT INTO ai_decisions (match_id, user_id, kind, detail, created_at) VALUES (?,?,?,?,?)', matchId, uid, kind, JSON.stringify(detail), Date.now());

  if (state.status === 'lobby') {
    if (!state.lineups[team].confirmedAt && !state.toss.result) {
      if (state.teamSource === 'real' && state.teams[team].players.length > 1) {
        const order = bowlingOrder(state.teams[team].players.map((p) => ({ ...p, role: (state.teamMeta[team]?.squad || []).find((s) => s.playerId === p.playerId)?.role })));
        const bowlers = order.filter((p) => p.role === 'bowl' || p.role === 'ar');
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
      const decision = state.format === 'test' ? 'bat' : lv >= 2 ? 'bowl' : Math.random() < 0.5 ? 'bat' : 'bowl';
      G.decideToss(uid, matchId, decision, ctx); log('toss_decision', { decision });
      return { ctx, what: `chose to ${decision}` };
    }
    return null;
  }

  if (state.status === 'innings_break' && state.test?.followOn && state.captains[state.test.followOn.team] === uid) {
    const enforce = lv >= 2 || Math.random() < 0.5;
    G.testAction(uid, matchId, { type: 'follow_on', enforce }, ctx); log('follow_on', { enforce });
    return { ctx, what: enforce ? 'enforced the follow-on' : 'declined the follow-on' };
  }

  if (state.status !== 'live' || state.paused) return null;
  const cur = state.current;
  if (!cur) return null;
  const bowlerId = cur.open ? cur.set.bowlerId : cur.bowlerId;
  const batterId = cur.open ? cur.set.batterId : cur.strikerId;
  const controls = (pid) => pid === uid || state.members.find((x) => x.id === pid)?.controller === uid;
  const inn = state.innings[state.innings.length - 1];

  // Test: declare the third innings once the lead is out of reach (hard and expert only).
  if (state.format === 'test' && lv >= 2 && !cur.open && inn.batting === team && inn.number === 3 && state.test) {
    const t = state.test;
    const lead = t.totals[team] - t.totals[team === 'A' ? 'B' : 'A'];
    const ballsLeft = (t.days * t.sessionsPerDay - ((t.day - 1) * t.sessionsPerDay + t.session)) * t.oversPerSession * 6 + t.sessionBallsLeft;
    if (lead > 0 && lead > ballsLeft * 1.6) {
      G.testAction(uid, matchId, { type: 'declare' }, ctx); log('declare', { lead, ballsLeft });
      return { ctx, what: 'declared' };
    }
  }

  let role = null;
  if (controls(bowlerId) && !(cur.open && cur.set.bowlerLocked)) role = 'bowl';
  else if (controls(batterId) && !(cur.open && cur.set.batterLocked)) role = 'bat';
  if (!role) return null;
  if (state.test?.requirements?.some((r) => r.status === 'pending')) return null;
  const need = cur.cap;
  let seq = chooseNumbers({ state, role, need, aiTeam: team, level });
  // Belt and braces: the engine validates again, exactly as for a human.
  if (checkDigits(m.config, role, seq, role === 'bowl' ? cur.bowledThisOver : [])) seq = chooseNumbers({ state, role, need, aiTeam: team, level: 'easy' });
  G.submitOver(uid, matchId, seq, ctx);
  log('submit', { role, count: seq.length, level });
  return { ctx, what: `${role} submission` };
}
