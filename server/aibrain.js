// The AI's decision-making, as pure functions. It is given only public information
// (the opponent's already-revealed picks, the score, the rules) and returns its picks.
// It has no database access, so it cannot look at anything hidden.
import { rulesFor } from './rules.js';

export const LEVELS = ['easy', 'medium', 'hard', 'expert'];
export const PERSONALITIES = ['strategic', 'aggressive', 'defensive', 'unpredictable'];

// How each difficulty thinks.
const LEVEL = {
  easy:   { predictor: 'none',     exploitRule: false, situation: 0,   temp: 5.0, plan: false, avoidDotOver: false },
  medium: { predictor: 'frequency', exploitRule: true,  situation: 0.5, temp: 2.4, plan: false, avoidDotOver: false },
  hard:   { predictor: 'blend',    exploitRule: true,  situation: 1,   temp: 1.4, plan: true,  avoidDotOver: true },
  expert: { predictor: 'ensemble', exploitRule: true,  situation: 1,   temp: 1.0, plan: true,  avoidDotOver: true },
};
// How each personality leans. risk scales the cost of losing a wicket; high favours big numbers;
// hunt scales how much a bowler goes for wickets; temp scales randomness; noise adds deliberate surprise.
const PERSONALITY = {
  strategic:     { risk: 1.0,  high: 0,     hunt: 1.0, temp: 1.0, noise: 0,   situation: 1.4 },
  aggressive:    { risk: 0.55, high: 0.35,  hunt: 1.35, temp: 0.9, noise: 0,  situation: 1.0 },
  defensive:     { risk: 1.8,  high: -0.25, hunt: 0.7, temp: 0.9, noise: 0,   situation: 1.0 },
  unpredictable: { risk: 1.0,  high: 0,     hunt: 1.0, temp: 2.0, noise: 2.5, situation: 0.8 },
};

// ---------- reading the opponent ----------
// history: the opponent's revealed picks, oldest first: [{ d, pos }] (pos = 0..5 within the over).
const norm = (p, digits) => {
  const s = digits.reduce((a, d) => a + (p[d] || 0), 0);
  return Object.fromEntries(digits.map((d) => [d, s ? (p[d] || 0) / s : 1 / digits.length]));
};
const PREDICTORS = {
  uniform: (h, digits) => norm({}, digits),
  frequency: (h, digits) => norm(Object.fromEntries(digits.map((d) => [d, 1 + h.filter((x) => x.d === d).length])), digits),
  recency: (h, digits) => {
    const p = Object.fromEntries(digits.map((d) => [d, 0.6]));
    let w = 1;
    for (let i = h.length - 1; i >= 0 && i >= h.length - 80; i--, w *= 0.9) if (p[h[i].d] != null) p[h[i].d] += w;
    return norm(p, digits);
  },
  // What usually follows their last pick?
  transition: (h, digits) => {
    const p = Object.fromEntries(digits.map((d) => [d, 0.5]));
    const last = h[h.length - 1]?.d;
    for (let i = 1; i < h.length; i++) if (h[i - 1].d === last && p[h[i].d] != null) p[h[i].d] += 1;
    return norm(p, digits);
  },
  // What follows their last two picks?
  transition2: (h, digits) => {
    const p = Object.fromEntries(digits.map((d) => [d, 0.4]));
    const a = h[h.length - 2]?.d, b = h[h.length - 1]?.d;
    for (let i = 2; i < h.length; i++) if (h[i - 2].d === a && h[i - 1].d === b && p[h[i].d] != null) p[h[i].d] += 1;
    return norm(p, digits);
  },
  // Habits by position in the over (e.g. always 6 on the first ball).
  position: (h, digits, pos) => {
    const p = Object.fromEntries(digits.map((d) => [d, 0.5]));
    for (const x of h) if (x.pos === pos && p[x.d] != null) p[x.d] += 1;
    return norm(p, digits);
  },
  // Do they like repeating their last pick?
  repeat: (h, digits) => {
    const n = h.length;
    if (n < 2) return norm({}, digits);
    let rep = 0;
    for (let i = 1; i < n; i++) if (h[i].d === h[i - 1].d) rep++;
    const r = (rep + 1) / (n + digits.length);
    const last = h[n - 1].d;
    return norm(Object.fromEntries(digits.map((d) => [d, d === last ? r : (1 - r) / (digits.length - 1)])), digits);
  },
};
const mix = (parts, digits) => {
  const p = {};
  for (const [w, dist] of parts) for (const d of digits) p[d] = (p[d] || 0) + w * dist[d];
  return norm(p, digits);
};
// Expert: score each predictor on how well it would have predicted this opponent's recent picks,
// then trust the ones that have been right.
function ensemble(h, digits, pos) {
  const names = ['uniform', 'frequency', 'recency', 'transition', 'transition2', 'position', 'repeat'];
  const score = Object.fromEntries(names.map((n) => [n, 0]));
  const from = Math.max(3, h.length - 40);
  for (let t = from; t < h.length; t++) {
    const past = h.slice(Math.max(0, t - 200), t);
    for (const n of names) score[n] += Math.log(PREDICTORS[n](past, digits, h[t].pos)[h[t].d] || 1e-6);
  }
  const k = Math.max(1, h.length - from);
  const best = Math.max(...names.map((n) => score[n] / k));
  const parts = names.map((n) => [Math.exp(4 * (score[n] / k - best)), PREDICTORS[n](h.slice(-200), digits, pos)]);
  const tot = parts.reduce((a, [w]) => a + w, 0);
  return mix(parts.map(([w, d]) => [w / tot, d]), digits);
}
export function predict(levelName, h, digits, pos) {
  const L = LEVEL[levelName] || LEVEL.medium;
  if (L.predictor === 'none' || !h.length) return PREDICTORS.uniform(h, digits);
  if (L.predictor === 'frequency') return mix([[0.5, PREDICTORS.frequency(h, digits)], [0.5, PREDICTORS.uniform(h, digits)]], digits);
  if (L.predictor === 'blend') return mix([[0.45, PREDICTORS.recency(h, digits)], [0.3, PREDICTORS.transition(h, digits)], [0.25, PREDICTORS.position(h, digits, pos)]], digits);
  return ensemble(h, digits, pos);
}

// Bowler repetition rule (public: depends only on balls already bowled since the last wicket this over).
export function wouldBreak(n, soFar) {
  const c = {};
  for (const x of soFar) c[x] = (c[x] || 0) + 1;
  const next = (c[n] || 0) + 1;
  return next > 3 || (next === 3 && Object.entries(c).some(([d, k]) => Number(d) !== n && k >= 3));
}

function softPick(scores, temperature, rand) {
  const entries = Object.entries(scores);
  if (!entries.length) return null;
  const max = Math.max(...entries.map(([, v]) => v));
  const w = entries.map(([d, v]) => [d, Math.exp((v - max) / Math.max(0.05, temperature))]);
  let r = rand() * w.reduce((a, [, x]) => a + x, 0);
  for (const [d, x] of w) { r -= x; if (r <= 0) return Number(d); }
  return Number(w[w.length - 1][0]);
}

// ---------- the match situation → how costly is a wicket, in runs ----------
// s: { format, target, need, ballsLeft, wicketsLeft, inningsNumber, battingFirst, scheduledBallsLeft, lead }
export function wicketCost(s, levelName, personalityName) {
  const L = LEVEL[levelName] || LEVEL.medium, P = PERSONALITY[personalityName] || PERSONALITY.strategic;
  let base = 10, situational = 10;
  if (s.format === 'test') {
    base = 16; situational = 16;
    if (s.target && s.need > (s.scheduledBallsLeft || 0) * 2.4) situational = 34;        // can't win: bat for the draw
    else if (s.target && s.need < (s.scheduledBallsLeft || 0) * 1.2) situational = 10;   // chase is on
  } else if (s.target && s.ballsLeft > 0) {
    const rate = s.need / s.ballsLeft;
    situational = rate > 3.2 ? 3 : rate > 2.4 ? 6 : rate < 1.2 ? 20 : 11;
  } else if (s.ballsLeft > 0) {
    // Setting a total: the more overs left per wicket in hand, the more a wicket is worth; swing at the end.
    const oversPerWicket = s.ballsLeft / 6 / Math.max(1, s.wicketsLeft);
    situational = Math.min(22, Math.max(3, 4 + 6 * oversPerWicket));
    if (s.ballsLeft <= 6) situational = 3;
  }
  if (s.wicketsLeft <= 1) situational *= 1.6;
  const weight = Math.min(1, L.situation * P.situation);
  return (base * (1 - weight) + situational * weight) * P.risk;
}

// ---------- choosing numbers ----------
// Batting: maximise expected runs minus the cost of getting out, with personality and some randomness.
// ctx: { format, need, level, personality, oppHistory, bowledSinceWicket, ballInOver, situation, requirement, dotsThisOver, rand }
export function chooseBatting(ctx) {
  const L = LEVEL[ctx.level] || LEVEL.medium, P = PERSONALITY[ctx.personality] || PERSONALITY.strategic;
  const rules = rulesFor({ format: ctx.format });
  const W = wicketCost(ctx.situation, ctx.level, ctx.personality);
  const out = [];
  let dots = ctx.dotsThisOver || 0;
  for (let i = 0; i < ctx.need; i++) {
    const pos = (ctx.ballInOver - 1 + i) % 6;
    const p = predict(ctx.level, ctx.oppHistory, rules.bowler, pos);
    // Numbers the repetition rule now forbids the bowler are safe (certain only for the first ball).
    if (L.exploitRule && i === 0) for (const d of rules.bowler) if (wouldBreak(d, ctx.bowledSinceWicket || [])) p[d] = 0;
    const pn = norm(p, rules.bowler);
    const scores = {};
    for (const d of rules.batter) {
      const pOut = d === 0 ? 0 : pn[d] || 0;
      scores[d] = d * (1 - pOut) - W * pOut + P.high * d + (P.noise ? (ctx.rand() - 0.5) * P.noise : 0);
    }
    // Test dot-over rule: must score off balls 1 and 2 of the over in question.
    const req = ctx.requirement;
    // (A submission never crosses into the next over, so only the current over's balls 1–2 matter.)
    if (req && !req.startsNextOver && pos < 2) delete scores[0];
    // Avoid setting up a dot over without need (it forces scoring early next over).
    if (L.avoidDotOver && scores[0] != null && pos === 5 && dots === 5) scores[0] -= 2;
    const d = softPick(scores, L.temp * P.temp, ctx.rand);
    out.push(d);
    dots = pos === 5 ? 0 : d === 0 ? dots + 1 : -99;
  }
  return out;
}

// Bowling: go for the numbers this batter is likely to pick, weighted by what each would cost us,
// always within the repetition rule.
// ctx: { format, need, level, personality, oppHistory, bowledSinceWicket, ballInOver, situation, batterForm, rand }
export function chooseBowling(ctx) {
  const L = LEVEL[ctx.level] || LEVEL.medium, P = PERSONALITY[ctx.personality] || PERSONALITY.strategic;
  const rules = rulesFor({ format: ctx.format });
  let W = wicketCost(ctx.situation, ctx.level, ctx.personality) * P.hunt;
  if (ctx.batterForm && ctx.batterForm.balls >= 6 && ctx.batterForm.runs / ctx.batterForm.balls > 2.5) W *= 1.25; // a set batter is worth more
  const soFar = [...(ctx.bowledSinceWicket || [])];
  const out = [];
  for (let i = 0; i < ctx.need; i++) {
    const pos = (ctx.ballInOver - 1 + i) % 6;
    const p = predict(ctx.level, ctx.oppHistory, rules.batter, pos);
    const scores = {};
    for (const d of rules.bowler) {
      if (wouldBreak(d, soFar)) continue; // the same rule a human bowler follows
      scores[d] = (p[d] || 0) * (W + d) * 6 + (P.noise ? (ctx.rand() - 0.5) * P.noise : 0);
    }
    // Planning: don't spend the one allowed triple early unless it's clearly the best option.
    if (L.plan && i < ctx.need - 1) {
      const vals = Object.values(scores);
      const spread = Math.max(...vals) - Math.min(...vals) || 1;
      for (const d of Object.keys(scores)) if (soFar.filter((x) => x === Number(d)).length === 2) scores[d] -= 0.15 * spread;
    }
    const d = softPick(scores, L.temp * P.temp, ctx.rand);
    out.push(d); soFar.push(d);
  }
  return out;
}

// ---------- captaincy ----------
const ROLE_PLAN = {
  limited: { wk: 1, bat: 4, ar: 3, bowl: 3 },
  test: { wk: 1, bat: 5, ar: 1, bowl: 4 },
};
export function selectXI(squad, size, format, personality = 'strategic') {
  const plan = { ...ROLE_PLAN[format === 'test' ? 'test' : 'limited'] };
  if (personality === 'aggressive') { plan.bat += 1; plan.bowl -= 1; }
  if (personality === 'defensive') { plan.bowl += 1; plan.bat -= 1; }
  const by = (r) => squad.filter((p) => p.role === r);
  const pick = [];
  for (const r of ['wk', 'bat', 'ar', 'bowl']) pick.push(...by(r).slice(0, plan[r]));
  for (const p of squad) if (pick.length < size && !pick.includes(p)) pick.push(p);
  return pick.slice(0, size);
}

// Choose who bowls the next over, from this innings' figures (public).
// options: [{ id, balls, runs, wickets }], last: who bowled the last over
export function chooseBowler({ options, last, noConsecutive, phase, level, personality, rand }) {
  const pool = options.filter((o) => !(noConsecutive && o.id === last && options.length > 1));
  if (!pool.length) return null;
  if (level === 'easy') return null; // keeps the lineup's rotation
  if (personality === 'unpredictable') return pool[Math.floor(rand() * pool.length)].id;
  const econ = (o) => (o.balls ? (o.runs * 6) / o.balls : 12);
  const fresh = (o) => (o.balls ? 0 : 1);
  const score = (o) => {
    if (personality === 'aggressive') return o.wickets * 3 - econ(o) * 0.3 + fresh(o);
    if (personality === 'defensive') return -econ(o) + fresh(o) * 0.5;
    // strategic: wickets early, economy at the death
    return phase === 'death' ? -econ(o) * 1.2 + o.wickets : o.wickets * 2 - econ(o) * 0.5 + fresh(o) * 0.8;
  };
  return [...pool].sort((a, b) => score(b) - score(a))[0].id;
}
