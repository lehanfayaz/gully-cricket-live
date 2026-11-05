// Career progression: achievements, challenges, levels and milestones.
// Achievements and challenges are data (rules in the database that admins can add or change). They are
// evaluated against facts computed from the player's completed matches and won tournaments, so nothing here
// touches gameplay, and every unlock can be traced to the match (or tournament) that earned it.
import { all, get, run, tx } from './db.js';
import { careerBalls, careerMatches } from './analytics.js';

const now = () => Date.now();
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// ---------- the vocabulary rules can use ----------
// Per-match facts (numbers) that a rule can count, add up, or take the best of.
export const FIELDS = {
  runs: 'Runs scored in the match',
  balls: 'Balls faced in the match',
  fours: 'Fours hit in the match',
  sixes: 'Sixes hit in the match',
  bestKnock: 'Highest single innings score in the match',
  wicketsTaken: 'Wickets taken in the match',
  bestSpell: 'Most wickets in one innings in the match',
  conceded: 'Runs conceded in the match',
  wicketsLost: "Wickets your side lost while batting",
};
// Conditions a match must meet to count.
export const CONDITIONS = {
  won: 'You won the match (true/false)',
  format: 'Match format is one of: test, t20, odi, custom',
  overs: 'Match had exactly this many overs',
  maxOvers: 'Match had at most this many overs',
  vsAI: 'Played against the AI (true/false)',
  aiLevel: 'AI difficulty is one of: easy, medium, hard, expert',
  maxWicketsLost: 'Your side lost at most this many wickets',
  hatTrick: 'You took a hat-trick in the match (true/false)',
  teamCategory: 'You played as a team from: international, ipl, custom',
  tournament: 'It was a tournament match (true/false)',
};
export const TOURNAMENT_CONDITIONS = { teamCategory: 'Your team was from: international, ipl, custom', allIpl: 'Every team was an IPL franchise (true/false)', kind: 'Tournament format is one of: knockout, league, groups, custom' };
export const TYPES = {
  max: 'Best single-match value of a field reaches the target',
  sum: 'Total of a field across matches reaches the target',
  count: 'Number of matches meeting the conditions reaches the target',
  streak: 'Consecutive matches meeting the conditions reaches the target',
  tournaments: 'Number of tournaments won reaches the target',
};

// Check a rule's shape (admins write these), so a bad rule can't break evaluation.
export function validateRule(rule) {
  const fail = (m) => { throw new Error(m); };
  if (!rule || typeof rule !== 'object') fail('The rule is missing.');
  if (!TYPES[rule.type]) fail(`Rule type must be one of: ${Object.keys(TYPES).join(', ')}.`);
  if ((rule.type === 'max' || rule.type === 'sum') && !FIELDS[rule.field]) fail(`Pick a field: ${Object.keys(FIELDS).join(', ')}.`);
  const target = Number(rule.target);
  if (!Number.isFinite(target) || target < 1 || target > 1e6) fail('The target must be a number from 1 upwards.');
  const allowed = rule.type === 'tournaments' ? TOURNAMENT_CONDITIONS : CONDITIONS;
  const where = rule.where || {};
  for (const k of Object.keys(where)) if (!allowed[k]) fail(`Unknown condition "${k}". Allowed: ${Object.keys(allowed).join(', ')}.`);
  return { type: rule.type, field: rule.field || null, target, where };
}

// ---------- facts from the record ----------
export function matchFacts(userId) {
  const matches = careerMatches(userId).slice().reverse(); // oldest first
  const balls = careerBalls(userId);
  const byMatch = new Map(matches.map((m) => [m.id, { ...m, runs: 0, balls: 0, fours: 0, sixes: 0, wicketsTaken: 0, conceded: 0, bestKnock: 0, bestSpell: 0, hatTrick: false, wicketsLost: 0 }]));
  const knocks = new Map(), spells = new Map(), streaks = new Map();
  for (const b of balls) {
    const f = byMatch.get(b.match_id);
    if (!f) continue;
    if (b.bat_owner === userId) {
      f.runs += b.runs; f.balls++; if (b.runs === 4) f.fours++; if (b.runs === 6) f.sixes++;
      const k = `${b.innings_id}:${b.stint}:${b.batter_id}`;
      knocks.set(k, (knocks.get(k) || 0) + b.runs);
      f.bestKnock = Math.max(f.bestKnock, knocks.get(k));
    }
    if (b.bowl_owner === userId) {
      f.conceded += b.runs;
      const credited = b.is_wicket && b.dismissal !== 'dot_rule';
      if (credited) f.wicketsTaken++;
      const sk = `${b.innings_id}:${b.bowler_id}`;
      if (credited) spells.set(sk, (spells.get(sk) || 0) + 1);
      f.bestSpell = Math.max(f.bestSpell, spells.get(sk) || 0);
      // Hat-trick: three wickets with three consecutive deliveries by the same bowler (across overs too).
      const run_ = credited ? (streaks.get(sk) || 0) + 1 : 0;
      streaks.set(sk, run_);
      if (run_ >= 3) f.hatTrick = true;
    }
  }
  // Wickets your side lost while batting (main innings only, not super overs).
  for (const f of byMatch.values()) {
    f.wicketsLost = get(`SELECT COALESCE(SUM(b.is_wicket),0) AS w FROM balls b JOIN innings i ON i.id = b.innings_id
      WHERE i.match_id = ? AND i.batting = ? AND i.super_over = 0 AND b.voided = 0`, f.id, f.side).w;
    f.won = f.outcome === 'won';
  }
  return [...byMatch.values()].sort((a, b) => a.endedAt - b.endedAt);
}

export function tournamentWins(userId) {
  return all(`SELECT t.id, t.name, t.kind, t.completed_at, tt.category,
      (SELECT COUNT(*) FROM tournament_teams x WHERE x.tournament_id = t.id AND x.category <> 'ipl') AS non_ipl
    FROM tournaments t JOIN tournament_teams tt ON tt.tournament_id = t.id AND tt.key = t.champion
    WHERE t.owner_id = ? AND t.status = 'completed' AND tt.human = 1 ORDER BY t.completed_at`, userId)
    .map((t) => ({ id: t.id, name: t.name, kind: t.kind, endedAt: t.completed_at, teamCategory: t.category, allIpl: t.non_ipl === 0 }));
}

const matches = (f, where) => Object.entries(where).every(([k, v]) => {
  switch (k) {
    case 'won': return f.won === !!v;
    case 'format': return [].concat(v).includes(f.format);
    case 'overs': return f.overs === Number(v);
    case 'maxOvers': return f.overs != null && f.overs <= Number(v);
    case 'vsAI': return f.vsAI === !!v;
    case 'aiLevel': return f.vsAI && [].concat(v).includes(f.aiLevel);
    case 'maxWicketsLost': return f.wicketsLost <= Number(v);
    case 'hatTrick': return f.hatTrick === !!v;
    case 'teamCategory': return [].concat(v).includes(f.teamCategory);
    case 'tournament': return !!f.tournamentId === !!v;
    case 'allIpl': return f.allIpl === !!v;
    case 'kind': return [].concat(v).includes(f.kind);
    default: return false;
  }
});

// Evaluate one rule over facts in a time window. Returns progress and, once reached, when and where.
export function evaluate(rule, facts, tours, from = 0, to = Infinity) {
  const r = validateRule(rule);
  const list = (r.type === 'tournaments' ? tours : facts).filter((f) => f.endedAt >= from && f.endedAt < to);
  let value = 0, cur = 0, achievedAt = null, at = null;
  for (const f of list) {
    const ok = matches(f, r.where);
    if (r.type === 'streak') { cur = ok ? cur + 1 : 0; value = Math.max(value, cur); }
    else if (!ok) continue;
    else if (r.type === 'count' || r.type === 'tournaments') value++;
    else if (r.type === 'sum') value += f[r.field] || 0;
    else if (r.type === 'max') value = Math.max(value, f[r.field] || 0);
    if (achievedAt == null && value >= r.target) { achievedAt = f.endedAt; at = { id: f.id, name: f.name, kind: r.type === 'tournaments' ? 'tournament' : 'match' }; }
  }
  return { value, target: r.target, progress: Math.min(1, value / r.target), done: achievedAt != null, achievedAt, at };
}

// ---------- defaults (admins can edit, add, or switch these off) ----------
const DEFAULT_ACHIEVEMENTS = [
  ['first-fifty', 'First Fifty', 'Score 50 runs in an innings', '🏏', 50, { type: 'max', field: 'bestKnock', target: 50 }],
  ['first-century', 'First Century', 'Score 100 runs in an innings', '💯', 150, { type: 'max', field: 'bestKnock', target: 100 }],
  ['hat-trick', 'Hat-trick', 'Take wickets with three consecutive deliveries', '🎩', 150, { type: 'count', target: 1, where: { hatTrick: true } }],
  ['six-machine', 'Six Machine', 'Hit 10 sixes', '💥', 50, { type: 'sum', field: 'sixes', target: 10 }],
  ['test-specialist', 'Test Specialist', 'Win 10 Test matches', '🧢', 300, { type: 'count', target: 10, where: { won: true, format: ['test'] } }],
  ['giant-killer', 'Giant Killer', 'Beat the Expert AI', '🗡️', 150, { type: 'count', target: 1, where: { won: true, aiLevel: ['expert'] } }],
  ['unbeaten', 'Unbeaten', 'Win 10 matches in a row', '🔥', 300, { type: 'streak', target: 10, where: { won: true } }],
  ['champion', 'Champion', 'Win a tournament', '🏆', 250, { type: 'tournaments', target: 1 }],
  ['first-win', 'Off the Mark', 'Win your first match', '✅', 20, { type: 'count', target: 1, where: { won: true } }],
  ['five-for', 'Five-for', 'Take 5 wickets in an innings', '🖐️', 120, { type: 'max', field: 'bestSpell', target: 5 }],
  ['run-machine', 'Run Machine', 'Score 1,000 career runs', '⚙️', 200, { type: 'sum', field: 'runs', target: 1000 }],
  ['wicket-hunter', 'Wicket Hunter', 'Take 50 career wickets', '🎯', 200, { type: 'sum', field: 'wicketsTaken', target: 50 }],
  ['ipl-champion', 'IPL Champion', 'Win a tournament with an IPL franchise', '👑', 250, { type: 'tournaments', target: 1, where: { teamCategory: ['ipl'] } }],
  ['test-winner', 'Five-Day Hero', 'Win a Test match', '🏟️', 80, { type: 'count', target: 1, where: { won: true, format: ['test'] } }],
];
const DEFAULT_CHALLENGES = [
  ['d-fifty-5', 'daily', 'Fifty in a five-over match', 'Score 50 runs in a 5-over match', 60, { type: 'max', field: 'runs', target: 50, where: { overs: 5 } }],
  ['d-tight-win', 'daily', 'Clinical win', 'Win without losing more than two wickets', 50, { type: 'count', target: 1, where: { won: true, maxWicketsLost: 2 } }],
  ['d-three-wickets', 'daily', 'Three in a match', 'Take 3 wickets in a match', 40, { type: 'max', field: 'wicketsTaken', target: 3 }],
  ['d-five-sixes', 'daily', 'Clear the ropes', 'Hit 5 sixes today', 40, { type: 'sum', field: 'sixes', target: 5 }],
  ['w-expert', 'weekly', 'Beat the Expert', 'Defeat the Expert AI this week', 150, { type: 'count', target: 1, where: { won: true, aiLevel: ['expert'] } }],
  ['w-five-wins', 'weekly', 'Five wins', 'Win 5 matches this week', 120, { type: 'count', target: 5, where: { won: true } }],
  ['w-200-runs', 'weekly', '200 for the week', 'Score 200 runs this week', 100, { type: 'sum', field: 'runs', target: 200 }],
  ['l-five-streak', 'longterm', 'Winning run', 'Win five consecutive matches', 200, { type: 'streak', target: 5, where: { won: true } }],
  ['l-test-win', 'longterm', 'Test match win', 'Win a Test match', 150, { type: 'count', target: 1, where: { won: true, format: ['test'] } }],
  ['l-ipl-tournament', 'longterm', 'IPL-style title', 'Win a tournament made up of IPL franchises', 250, { type: 'tournaments', target: 1, where: { allIpl: true } }],
];

export function seedDefaults() {
  tx(() => {
    DEFAULT_ACHIEVEMENTS.forEach(([id, title, description, icon, xp, rule], i) =>
      run('INSERT OR IGNORE INTO achievements (id, title, description, icon, xp, rule, active, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?,?)', id, title, description, icon, xp, JSON.stringify(rule), i, now(), now()));
    DEFAULT_CHALLENGES.forEach(([id, period, title, description, xp, rule], i) =>
      run('INSERT OR IGNORE INTO challenges (id, period, title, description, xp, rule, active, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?,?)', id, period, title, description, xp, JSON.stringify(rule), i, now(), now()));
  });
}

// ---------- periods ----------
const DAY = 86400000;
export function periodOf(period, t = now()) {
  if (period === 'daily') { const s = Math.floor(t / DAY) * DAY; return { key: new Date(s).toISOString().slice(0, 10), from: s, to: s + DAY }; }
  if (period === 'weekly') {
    const d = new Date(Math.floor(t / DAY) * DAY); const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    const s = d.getTime() - dow * DAY; return { key: `W${new Date(s).toISOString().slice(0, 10)}`, from: s, to: s + 7 * DAY };
  }
  return { key: 'all', from: 0, to: Infinity };
}
// Up to three daily and three weekly challenges, rotating by date so each period has a fresh set.
function rotate(list, key, n) {
  if (list.length <= n) return list;
  let h = 0; for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const start = h % list.length;
  return Array.from({ length: n }, (_, i) => list[(start + i) % list.length]);
}

// ---------- levels ----------
// Levels need experience earned on the field (runs, wickets, wins, weighted by the opponent) and
// achievements, not just matches started.
export const LEVELS = [
  { name: 'Rookie', xp: 0, achievements: 0 },
  { name: 'Amateur', xp: 300, achievements: 1 },
  { name: 'Professional', xp: 1500, achievements: 4 },
  { name: 'Elite', xp: 5000, achievements: 8 },
  { name: 'Legend', xp: 15000, achievements: 12 },
];
const WIN_XP = { easy: 10, medium: 20, hard: 35, expert: 50 };
export function xpFromPlay(facts) {
  let xp = 0;
  for (const f of facts) {
    xp += f.runs + 15 * f.wicketsTaken;
    if (f.won) xp += f.vsAI ? WIN_XP[f.aiLevel] || 20 : 30;
  }
  return xp;
}
export function levelFor(xp, achievementCount) {
  let i = 0;
  LEVELS.forEach((l, k) => { if (xp >= l.xp && achievementCount >= l.achievements) i = k; });
  const next = LEVELS[i + 1] || null;
  return { index: i, name: LEVELS[i].name, next: next && { name: next.name, xp: next.xp, achievements: next.achievements }, xp, achievementCount };
}

// ---------- the full picture for one player (and record new unlocks) ----------
export function progress(userId) {
  const facts = matchFacts(userId), tours = tournamentWins(userId);
  const defs = all('SELECT * FROM achievements ORDER BY sort, created_at');
  const unlocked = Object.fromEntries(all('SELECT * FROM user_achievements WHERE user_id = ?', userId).map((r) => [r.achievement_id, r]));
  const fresh = [];
  const achievements = defs.map((a) => {
    let ev = null, error = null;
    try { ev = evaluate(parse(a.rule), facts, tours); } catch (e) { error = e.message; }
    const was = unlocked[a.id];
    if (!was && ev?.done && a.active) {
      run('INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, unlocked_at, ref, ref_kind, recorded_at) VALUES (?,?,?,?,?,?)', userId, a.id, ev.achievedAt, ev.at?.id || null, ev.at?.kind || null, now());
      fresh.push({ id: a.id, title: a.title, icon: a.icon });
    }
    const done = !!was || (!!ev?.done && !!a.active);
    return { id: a.id, title: a.title, description: a.description, icon: a.icon, xp: a.xp, active: !!a.active,
      unlocked: done, unlockedAt: was?.unlocked_at || (done ? ev.achievedAt : null), ref: was ? { id: was.ref, kind: was.ref_kind } : ev?.at || null,
      value: ev?.value ?? null, target: ev?.target ?? null, progress: done ? 1 : ev?.progress ?? 0, error };
  }).filter((a) => a.active || a.unlocked);
  // Challenges for the current periods.
  const chDefs = all('SELECT * FROM challenges WHERE active = 1 ORDER BY sort, created_at');
  const done = all('SELECT * FROM user_challenges WHERE user_id = ?', userId);
  const doneKey = new Set(done.map((d) => `${d.challenge_id}|${d.period_key}`));
  const challenges = {};
  for (const period of ['daily', 'weekly', 'longterm']) {
    const p = periodOf(period);
    const pool = chDefs.filter((c) => c.period === period);
    challenges[period] = { key: p.key, endsAt: Number.isFinite(p.to) ? p.to : null, list: rotate(pool, p.key, period === 'longterm' ? pool.length : 3).map((c) => {
      let ev = null, error = null;
      try { ev = evaluate(parse(c.rule), facts, tours, p.from, p.to); } catch (e) { error = e.message; }
      const k = `${c.id}|${p.key}`;
      if (ev?.done && !doneKey.has(k)) {
        run('INSERT OR IGNORE INTO user_challenges (user_id, challenge_id, period_key, completed_at, ref, recorded_at) VALUES (?,?,?,?,?,?)', userId, c.id, p.key, ev.achievedAt, ev.at?.id || null, now());
        doneKey.add(k); fresh.push({ id: c.id, title: c.title, icon: '⭐', challenge: true });
      }
      const row = done.find((d) => d.challenge_id === c.id && d.period_key === p.key);
      return { id: c.id, title: c.title, description: c.description, xp: c.xp, done: doneKey.has(k), completedAt: row?.completed_at || (ev?.done ? ev.achievedAt : null), value: ev?.value ?? 0, target: ev?.target ?? null, progress: doneKey.has(k) ? 1 : ev?.progress ?? 0, error };
    }) };
  }
  // Experience: play, plus achievements and completed challenges (every completion ever, not just this period).
  const unlockedList = achievements.filter((a) => a.unlocked);
  const challengeXp = get('SELECT COALESCE(SUM(c.xp),0) AS x FROM user_challenges u JOIN challenges c ON c.id = u.challenge_id WHERE u.user_id = ?', userId).x;
  const playXp = xpFromPlay(facts);
  const xp = playXp + unlockedList.reduce((s, a) => s + a.xp, 0) + challengeXp;
  const level = levelFor(xp, unlockedList.length);
  return { level: { ...level, breakdown: { play: playXp, achievements: unlockedList.reduce((s, a) => s + a.xp, 0), challenges: challengeXp } },
    achievements, challenges, milestones: milestones(facts, tours, unlockedList), tournamentWins: tours.length, fresh };
}

// Career milestones: the first time each landmark was passed, with the match it happened in.
function milestones(facts, tours, unlocked) {
  const out = [];
  const marks = { runs: [100, 500, 1000, 2500, 5000, 10000], wicketsTaken: [10, 25, 50, 100, 250], wins: [1, 10, 25, 50, 100], matches: [1, 10, 25, 50, 100] };
  const label = { runs: 'career runs', wicketsTaken: 'career wickets', wins: 'wins', matches: 'matches played' };
  const tot = { runs: 0, wicketsTaken: 0, wins: 0, matches: 0 };
  for (const f of facts) {
    const add = { runs: f.runs, wicketsTaken: f.wicketsTaken, wins: f.won ? 1 : 0, matches: 1 };
    for (const k of Object.keys(marks)) {
      const before = tot[k]; tot[k] += add[k];
      for (const m of marks[k]) if (before < m && tot[k] >= m) out.push({ title: m === 1 ? (k === 'wins' ? 'First win' : 'First match') : `${m.toLocaleString()} ${label[k]}`, at: f.endedAt, ref: { id: f.id, name: f.name, kind: 'match' } });
    }
  }
  for (const t of tours) out.push({ title: `Won ${t.name}`, at: t.endedAt, ref: { id: t.id, name: t.name, kind: 'tournament' } });
  for (const a of unlocked) out.push({ title: `${a.icon} ${a.title}`, at: a.unlockedAt, ref: a.ref, achievement: true });
  return out.sort((a, b) => b.at - a.at);
}

// ---------- admin ----------
const cleanText = (s, n) => String(s || '').trim().slice(0, n);
export function saveAchievement(input) {
  const id = cleanText(input.id, 40).toLowerCase().replace(/[^a-z0-9-]/g, '-') || null;
  if (!id) throw new Error('Give it an id (letters, numbers and dashes).');
  const rule = validateRule(input.rule);
  const title = cleanText(input.title, 40); if (!title) throw new Error('Give it a title.');
  const exists = get('SELECT id FROM achievements WHERE id = ?', id);
  const vals = [title, cleanText(input.description, 140), cleanText(input.icon, 8) || '🏅', Math.max(0, Math.min(5000, parseInt(input.xp, 10) || 0)), JSON.stringify(rule), input.active === false ? 0 : 1, now()];
  if (exists) run('UPDATE achievements SET title = ?, description = ?, icon = ?, xp = ?, rule = ?, active = ?, updated_at = ? WHERE id = ?', ...vals, id);
  else run('INSERT INTO achievements (title, description, icon, xp, rule, active, updated_at, id, sort, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', ...vals, id, 1000, now());
  return id;
}
export function saveChallenge(input) {
  const id = cleanText(input.id, 40).toLowerCase().replace(/[^a-z0-9-]/g, '-') || null;
  if (!id) throw new Error('Give it an id (letters, numbers and dashes).');
  if (!['daily', 'weekly', 'longterm'].includes(input.period)) throw new Error('Pick daily, weekly or long-term.');
  const rule = validateRule(input.rule);
  const title = cleanText(input.title, 40); if (!title) throw new Error('Give it a title.');
  const exists = get('SELECT id FROM challenges WHERE id = ?', id);
  const vals = [input.period, title, cleanText(input.description, 140), Math.max(0, Math.min(5000, parseInt(input.xp, 10) || 0)), JSON.stringify(rule), input.active === false ? 0 : 1, now()];
  if (exists) run('UPDATE challenges SET period = ?, title = ?, description = ?, xp = ?, rule = ?, active = ?, updated_at = ? WHERE id = ?', ...vals, id);
  else run('INSERT INTO challenges (period, title, description, xp, rule, active, updated_at, id, sort, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', ...vals, id, 1000, now());
  return id;
}
export const listAll = () => ({
  achievements: all('SELECT * FROM achievements ORDER BY sort, created_at').map((a) => ({ ...a, rule: parse(a.rule), active: !!a.active, unlocks: get('SELECT COUNT(*) AS c FROM user_achievements WHERE achievement_id = ?', a.id).c })),
  challenges: all('SELECT * FROM challenges ORDER BY period, sort, created_at').map((c) => ({ ...c, rule: parse(c.rule), active: !!c.active, completions: get('SELECT COUNT(*) AS c FROM user_challenges WHERE challenge_id = ?', c.id).c })),
  schema: { types: TYPES, fields: FIELDS, conditions: CONDITIONS, tournamentConditions: TOURNAMENT_CONDITIONS },
});
