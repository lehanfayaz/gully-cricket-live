// AI opponent, Phase 2: every difficulty × personality, played as complete matches through the real engine
// (Test, T20, ODI, Quick, complete-over and ball-by-ball), plus fairness and strength checks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
process.env.DB_PATH = ':memory:';
const G = await import('../server/engine.js');
const AI = await import('../server/ai.js');
const B = await import('../server/aibrain.js');
const CDB = await import('../server/cricketdb.js');
const { all, get, run } = await import('../server/db.js');
const { checkDigits, rulesFor } = await import('../server/rules.js');
CDB.seedIfEmpty();

// A deterministic random source for repeatable runs.
function rng(seed) { let h = seed >>> 0 || 1; return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1e9) / 1e9; }; }
let n = 0;
const user = (name) => { const id = `h${++n}`; run('INSERT INTO users (id, display_name, is_guest, created_at) VALUES (?,?,1,?)', id, name, Date.now()); return id; };
const ctx = () => G.newCtx();

// A human who has habits (so there's something to learn) but always plays legally.
function humanPicker(format, rand, style) {
  const rules = rulesFor({ format });
  const fav = { bat: rules.batter[rules.batter.length - 1], bowl: rules.bowler[0] };
  return (role, need, bowledSoFar) => {
    const digits = role === 'bat' ? rules.batter : rules.bowler;
    const out = [], soFar = [...bowledSoFar];
    for (let i = 0; i < need; i++) {
      let options = role === 'bowl' ? digits.filter((d) => !B.wouldBreak(d, soFar)) : digits;
      let d = style === 'patterned' && rand() < 0.6 && options.includes(fav[role]) ? fav[role] : options[Math.floor(rand() * options.length)];
      out.push(d); if (role === 'bowl') soFar.push(d);
    }
    return out;
  };
}

const LEVELS = B.LEVELS, PERS = B.PERSONALITIES;
const SCENARIOS = [
  { name: 'Test', config: { format: 'test', days: 1, sessionsPerDay: 2, oversPerSession: 3, inningsPerTeam: 2, wickets: 4 }, real: true },
  { name: 'T20', config: { format: 't20', wickets: 4 }, real: true },
  { name: 'ODI', config: { format: 'odi', wickets: 3 }, real: true },
  { name: 'Quick', config: { format: 'custom', overs: 2, wickets: 2 }, quick: true, real: false },
];
const FINISHED = new Set(['completed', 'abandoned']);
const stats = { matches: 0, balls: 0, aiSubmissions: 0, byFormat: {}, results: {} };

function playMatch({ level, personality, scenario, play, seed }) {
  const rand = rng(seed);
  const hid = user('Human');
  const id = G.createMatch(hid, {
    name: `${level}/${personality}/${scenario.name}/${play}`, teamA: 'Humans', teamB: 'Bots',
    realTeams: scenario.real ? { A: 'int-ind', B: 'int-aus' } : undefined,
    quick: scenario.quick ? { start: seed % 3 === 0 ? 'bat' : seed % 3 === 1 ? 'bowl' : 'toss' } : undefined,
    config: { ...scenario.config, play, participation: 'ai', teamSource: scenario.real ? 'real' : 'custom', aiLevel: level, aiPersonality: personality, xiSize: 6 },
  });
  const pick = humanPicker(scenario.config.format, rand, seed % 2 ? 'patterned' : 'random');
  const humanControls = (st, pid) => pid === hid || st.members.find((x) => x.id === pid)?.controller === hid;
  let guard = 0;
  for (;;) {
    let st = G.publicState(id);
    if (FINISHED.has(st.status)) break;
    assert.ok(++guard < 20000, `${level}/${personality}/${scenario.name}/${play}: match never finished (stuck at ${st.status}/${st.stage})`);
    // The AI acts first if it can (it may need several steps).
    let acted = false;
    for (let k = 0; k < 6; k++) { const r = AI.aiStep(id); if (!r) break; acted = true; if (r.what.endsWith('submission')) stats.aiSubmissions++; }
    st = G.publicState(id);
    if (FINISHED.has(st.status)) break;
    // Then the human.
    const myTeam = 'A';
    try {
      if (st.status === 'lobby') {
        if (!st.lineups[myTeam].confirmedAt && !st.toss.result) { G.confirmLineup(hid, id, myTeam, ctx()); continue; }
        if (st.stage === 'toss_call' && st.captains[st.toss.caller] === hid) { G.callToss(hid, id, rand() < 0.5 ? 'heads' : 'tails', ctx()); continue; }
        if (st.stage === 'toss_decision' && st.captains[st.toss.winner] === hid) { G.decideToss(hid, id, rand() < 0.5 ? 'bat' : 'bowl', ctx()); continue; }
      } else if (st.status === 'innings_break') {
        if (st.test?.followOn && st.captains[st.test.followOn.team] === hid) { G.testAction(hid, id, { type: 'follow_on', enforce: rand() < 0.5 }, ctx()); continue; }
        if (!acted) { G.nextInnings(hid, id, ctx()); continue; }
      } else if (st.status === 'session_break' || st.status === 'day_break') {
        G.testAction(hid, id, { type: 'next_session' }, ctx()); continue;
      } else if (st.status === 'live' && st.current) {
        const cur = st.current;
        const bowlerId = cur.open ? cur.set.bowlerId : cur.bowlerId, batterId = cur.open ? cur.set.batterId : cur.strikerId;
        if (humanControls(st, bowlerId) && !(cur.open && cur.set.bowlerLocked)) { G.submitOver(hid, id, pick('bowl', cur.cap, cur.bowledThisOver), ctx()); continue; }
        if (humanControls(st, batterId) && !(cur.open && cur.set.batterLocked)) { G.submitOver(hid, id, pick('bat', cur.cap, []), ctx()); continue; }
      }
    } catch (e) {
      if (!(e instanceof G.GameError)) throw e;
      throw new Error(`${level}/${personality}/${scenario.name}/${play}: human action refused: ${e.message} (status ${st.status})`);
    }
    if (!acted) assert.fail(`${level}/${personality}/${scenario.name}/${play}: nobody can act (status ${st.status}, stage ${st.stage})`);
  }
  return { id, hid };
}

// Audit a finished match from the revealed record only.
function audit(id, label) {
  const m = G.loadMatch(id);
  const rules = rulesFor(m.config);
  const bot = get(`SELECT m.user_id FROM members m JOIN users u ON u.id = m.user_id WHERE m.match_id = ? AND u.is_bot = 1`, id).user_id;
  const aiSide = new Set(all(`SELECT user_id FROM members WHERE match_id = ? AND (user_id = ? OR controller_id = ?)`, id, bot, bot).map((r) => r.user_id));
  const inns = all('SELECT * FROM innings WHERE match_id = ? ORDER BY number', id);
  let aiBalls = 0;
  for (const inn of inns) {
    const balls = all('SELECT * FROM balls WHERE innings_id = ? AND voided = 0 ORDER BY ball_no', inn.id);
    let since = [], over = -1;
    for (const b of balls) {
      const o = Math.floor((b.ball_no - 1) / 6);
      if (o !== over) { over = o; since = []; }
      // Digits allowed for the format, for both sides.
      assert.ok(rules.batter.includes(b.bat_num), `${label}: batter digit ${b.bat_num} not allowed`);
      assert.ok(rules.bowler.includes(b.bowl_num), `${label}: bowler digit ${b.bowl_num} not allowed`);
      // Repetition rule, counted since the over's start or its last wicket.
      assert.ok(!B.wouldBreak(b.bowl_num, since), `${label}: repetition rule broken at ball ${b.ball_no} (${since.join('')}+${b.bowl_num})`);
      since.push(b.bowl_num);
      if (b.is_wicket) since = [];
      // Scores come only from the numbers: a match is out for 0, otherwise the batter's number.
      if (b.dismissal !== 'dot_rule') {
        assert.equal(!!b.is_wicket, b.bat_num === b.bowl_num, `${label}: wicket flag doesn't match the numbers`);
        assert.equal(b.runs, b.is_wicket ? 0 : b.bat_num, `${label}: runs don't match the numbers`);
      }
      if (aiSide.has(b.bowler_id) || aiSide.has(b.batter_id)) aiBalls++;
    }
    const sum = balls.reduce((a, b) => a + b.runs, 0) + (inn.extras || 0);
    assert.equal(G.totals(inn.id).runs, sum, `${label}: innings total isn't the sum of its balls`);
  }
  assert.equal(get(`SELECT COUNT(*) AS c FROM ai_decisions WHERE match_id = ? AND kind = 'fallback'`, id).c, 0, `${label}: the AI needed its fallback`);
  assert.ok(aiBalls > 0, `${label}: the AI never played a ball`);
  stats.balls += aiBalls;
  return m;
}

// ===== 1. The full grid =====
let seed = 7;
const t0 = Date.now();
for (const level of LEVELS) for (const personality of PERS) for (const scenario of SCENARIOS) for (const play of ['over', 'ball']) {
  const label = `${level}/${personality}/${scenario.name}/${play}`;
  const { id } = playMatch({ level, personality, scenario, play, seed: seed++ });
  const m = audit(id, label);
  assert.equal(m.status, 'completed', `${label}: finished as ${m.status}`);
  stats.matches++;
  stats.byFormat[scenario.name] = (stats.byFormat[scenario.name] || 0) + 1;
  const r = m.result?.draw ? 'draw' : m.result?.winner === 'B' ? 'ai' : m.result?.winner === 'A' ? 'human' : 'tie/other';
  stats.results[r] = (stats.results[r] || 0) + 1;
}
console.log(`  grid: ${stats.matches} complete matches (${Object.entries(stats.byFormat).map(([k, v]) => `${k} ${v}`).join(', ')}), ${stats.balls} balls involving the AI, ${stats.aiSubmissions} AI submissions, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  results: ${JSON.stringify(stats.results)}`);
const kinds = Object.fromEntries(all('SELECT kind, COUNT(*) AS c FROM ai_decisions GROUP BY kind').map((r) => [r.kind, r.c]));
console.log(`  AI decisions: ${JSON.stringify(kinds)}`);
for (const k of ['confirm', 'toss_decision', 'submit', 'next_bowler']) assert.ok(kinds[k] > 0, `the grid exercised ${k}`);

// ===== 2. Settings are independent and visible =====
{
  const hid = user('Settings');
  const id = G.createMatch(hid, { name: 'x', teamA: 'A', teamB: 'B', config: { participation: 'ai', aiLevel: 'expert', aiPersonality: 'defensive' } });
  const st = G.publicState(id);
  assert.equal(st.aiLevel, 'expert'); assert.equal(st.aiPersonality, 'defensive');
  assert.ok(st.members.some((x) => x.bot && /Expert, Defensive/.test(x.name)), 'the bot is named with its level and personality');
  assert.equal(G.sanitizeConfig({ participation: 'ai', aiPersonality: 'sneaky' }).aiPersonality, 'strategic', 'unknown personalities are refused');
  assert.equal(G.sanitizeConfig({ participation: 'ai', aiLevel: 'easy', aiPersonality: 'aggressive' }).aiLevel, 'easy');
}

// ===== 3. Fairness =====
// 3a. The AI's code never reads open submissions: no access to the sets table's sequences or private state.
for (const f of ['server/ai.js', 'server/aibrain.js']) {
  const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bsets\b/.test(src), `${f} must not query the sets table`);
  assert.ok(!/bat_seq|\.seq\b|bat_salt|privateState/.test(src), `${f} must not read hidden sequences`);
}
assert.ok(!/from '\.\/db\.js'|from '\.\/engine\.js'/.test(fs.readFileSync(new URL('../server/aibrain.js', import.meta.url), 'utf8')), 'the decision layer has no database or engine access');
// 3b. The AI's choice is the same whether or not the human has already locked in.
for (const level of LEVELS) for (const personality of PERS) {
  const hid = user('Order');
  const id = G.createMatch(hid, { name: 'o', teamA: 'A', teamB: 'B', quick: { start: 'bowl' }, config: { participation: 'ai', format: 'custom', overs: 10, wickets: 10, aiLevel: level, aiPersonality: personality } });
  const pickH = humanPicker('custom', rng(99), 'patterned');
  // Play a few overs so there's history, then compare at an over start.
  for (let i = 0; i < 4; i++) {
    let st = G.publicState(id); if (st.status !== 'live') break;
    G.submitOver(hid, id, pickH('bowl', st.current.cap, st.current.bowledThisOver), ctx());
    AI.aiStep(id); // the AI bats; the over is revealed. (Stop before it locks in for the next one.)
  }
  const st0 = G.publicState(id);
  assert.equal(st0.status, 'live'); assert.equal(st0.innings.length, 1, 'still the first innings');
  const before = AI.chooseNumbers({ state: st0, role: 'bat', need: st0.current.cap, aiTeam: 'B', level, personality, rand: rng(5), humanId: hid });
  G.submitOver(hid, id, pickH('bowl', st0.current.cap, st0.current.bowledThisOver), ctx()); // the human locks in first
  const st1 = G.publicState(id);
  assert.ok(st1.current.open && st1.current.set.bowlerLocked && !st1.current.set.batterLocked);
  const after = AI.chooseNumbers({ state: st1, role: 'bat', need: st1.current.cap, aiTeam: 'B', level, personality, rand: rng(5), humanId: hid });
  assert.deepEqual(after, before, `${level}/${personality}: a locked-in human submission must not change the AI's choice`);
}
// 3c. The AI submits through the same validation: an illegal sequence from it is refused like anyone's.
{
  const hid = user('Val');
  const id = G.createMatch(hid, { name: 'v', teamA: 'A', teamB: 'B', quick: { start: 'bat' }, config: { participation: 'ai', format: 'custom', overs: 2, wickets: 2 } });
  const st = G.publicState(id);
  const bot = st.members.find((x) => x.bot).id;
  assert.throws(() => G.submitOver(bot, id, [5, 5, 5, 5, 1, 2], ctx()), /./, 'four of a kind is refused for the AI too');
  assert.throws(() => G.submitOver(bot, id, [3, 3, 3, 5, 5, 5], ctx()), /./, 'two triples are refused for the AI too');
}

// ===== 4. Difficulty levels genuinely differ =====
// Simulate the decision layer against a habitual opponent and measure outcomes.
function battingTrial(level, personality, bowlerHabit, balls = 3000, format = 'custom') {
  const rand = rng(1234), rules = rulesFor({ format });
  const hist = []; let runs = 0, outs = 0, since = [];
  for (let b = 0; b < balls; b++) {
    const pos = b % 6; if (pos === 0) since = [];
    let bowl = bowlerHabit(b, hist, rand);
    if (B.wouldBreak(bowl, since)) bowl = rules.bowler.find((d) => !B.wouldBreak(d, since));
    const [bat] = B.chooseBatting({ format, need: 1, level, personality, rand, oppHistory: hist.slice(-200), bowledSinceWicket: since, ballInOver: pos + 1,
      situation: { format, target: null, ballsLeft: 60, wicketsLeft: 5 }, dotsThisOver: 0 });
    if (bat === bowl) { outs++; since = []; } else { runs += bat; since.push(bowl); }
    hist.push({ d: bowl, pos });
  }
  return { avg: runs / Math.max(1, outs), outs, runs };
}
function bowlingTrial(level, personality, batterHabit, balls = 3000, format = 'custom') {
  const rand = rng(4321);
  const hist = []; let runs = 0, outs = 0, since = [];
  for (let b = 0; b < balls; b++) {
    const pos = b % 6; if (pos === 0) since = [];
    const bat = batterHabit(b, hist, rand);
    const [bowl] = B.chooseBowling({ format, need: 1, level, personality, rand, oppHistory: hist.slice(-200), bowledSinceWicket: since, ballInOver: pos + 1,
      situation: { format, target: null, ballsLeft: 60, wicketsLeft: 5 } });
    assert.ok(!B.wouldBreak(bowl, since), 'bowling trial respects the repetition rule');
    if (bat === bowl) { outs++; since = []; } else { runs += bat; since.push(bowl); }
    hist.push({ d: bat, pos });
  }
  return { avg: runs / Math.max(1, outs), outs, runs };
}
// Habits of increasing subtlety: a favourite number, a cycle, and a position habit.
const habits = {
  favourite: (b, h, r) => (r() < 0.55 ? 4 : 1 + Math.floor(r() * 6)),
  cycle: (b) => [2, 5, 3, 6, 1, 4][b % 6] === 6 && b % 12 > 5 ? 2 : [2, 5, 3, 6, 1, 4][b % 6],
  afterSix: (b, h, r) => (h[h.length - 1]?.d === 6 ? 1 : r() < 0.5 ? 6 : 1 + Math.floor(r() * 5)),
};
console.log('  batting average (runs per wicket) against a habitual bowler:');
for (const [name, habit] of Object.entries(habits)) {
  const row = Object.fromEntries(LEVELS.map((l) => [l, battingTrial(l, 'strategic', habit).avg]));
  console.log(`    ${name.padEnd(9)} ${LEVELS.map((l) => `${l} ${row[l].toFixed(1)}`).join('  ')}`);
  assert.ok(row.medium > row.easy, `${name}: medium bats better than easy`);
  assert.ok(row.hard > row.medium, `${name}: hard bats better than medium`);
  assert.ok(row.expert >= row.hard * 0.95, `${name}: expert at least matches hard`);
}
// Expert's advantage shows on subtler patterns (sequence habits).
{
  const hard = battingTrial('hard', 'strategic', habits.cycle).avg, expert = battingTrial('expert', 'strategic', habits.cycle).avg;
  assert.ok(expert > hard, `expert reads a repeating cycle better than hard (${expert.toFixed(1)} v ${hard.toFixed(1)})`);
}
console.log('  bowling average conceded (lower is better) against a habitual batter:');
const batHabit = (b, h, r) => (r() < 0.5 ? 6 : 1 + Math.floor(r() * 6));
{
  const row = Object.fromEntries(LEVELS.map((l) => [l, bowlingTrial(l, 'strategic', batHabit).avg]));
  console.log(`    favourite ${LEVELS.map((l) => `${l} ${row[l].toFixed(1)}`).join('  ')}`);
  assert.ok(row.medium < row.easy && row.hard <= row.medium * 1.05 && row.expert <= row.hard * 1.05, 'bowling improves with difficulty');
  // A subtler batter: no favourite number overall, but a habit by position in the over.
  const posHabit = (b, h, r) => (r() < 0.7 ? [6, 1, 4, 2, 5, 3][b % 6] : 1 + Math.floor(r() * 6));
  const sub = Object.fromEntries(LEVELS.map((l) => [l, bowlingTrial(l, 'strategic', posHabit).avg]));
  console.log(`    position  ${LEVELS.map((l) => `${l} ${sub[l].toFixed(1)}`).join('  ')}`);
  assert.ok(sub.hard < sub.medium * 0.7 && sub.expert <= sub.hard * 1.05, 'hard and expert read position habits that medium misses');
}

// ===== 5. Personalities genuinely differ =====
{
  const meanDigit = (personality) => {
    const rand = rng(77); let s = 0; const N = 2000;
    for (let i = 0; i < N; i++) s += B.chooseBatting({ format: 'custom', need: 1, level: 'hard', personality, rand, oppHistory: [], bowledSinceWicket: [], ballInOver: 1, situation: { format: 'custom', target: null, ballsLeft: 60, wicketsLeft: 5 } })[0];
    return s / N;
  };
  const agg = meanDigit('aggressive'), def = meanDigit('defensive');
  assert.ok(agg > def + 0.3, `aggressive swings bigger than defensive (${agg.toFixed(2)} v ${def.toFixed(2)})`);
  // Against a habitual bowler, defensive gets out less often per ball than aggressive.
  const a = battingTrial('hard', 'aggressive', habits.favourite), d = battingTrial('hard', 'defensive', habits.favourite);
  assert.ok(d.outs < a.outs, `defensive loses fewer wickets (${d.outs} v ${a.outs})`);
  // Unpredictable is harder to read: its picks are more evenly spread.
  const entropy = (personality) => {
    const rand = rng(31), c = {};
    const hist = Array.from({ length: 60 }, (_, i) => ({ d: i % 3 ? 4 : 2, pos: i % 6 }));
    for (let i = 0; i < 3000; i++) { const d = B.chooseBatting({ format: 'custom', need: 1, level: 'expert', personality, rand, oppHistory: hist, bowledSinceWicket: [], ballInOver: 1, situation: { format: 'custom', target: null, ballsLeft: 60, wicketsLeft: 5 } })[0]; c[d] = (c[d] || 0) + 1; }
    return -Object.values(c).reduce((s, k) => s + (k / 3000) * Math.log2(k / 3000), 0);
  };
  assert.ok(entropy('unpredictable') > entropy('strategic') + 0.1, 'unpredictable spreads its picks more');
  // Captaincy: XI shape follows format and personality.
  const squad = [...Array(3)].map((_, i) => ({ playerId: `w${i}`, name: `W${i}`, role: 'wk' }))
    .concat([...Array(8)].map((_, i) => ({ playerId: `b${i}`, name: `B${i}`, role: 'bat' })))
    .concat([...Array(5)].map((_, i) => ({ playerId: `a${i}`, name: `A${i}`, role: 'ar' })))
    .concat([...Array(8)].map((_, i) => ({ playerId: `o${i}`, name: `O${i}`, role: 'bowl' })));
  const count = (xi, r) => xi.filter((p) => p.role === r).length;
  assert.equal(B.selectXI(squad, 11, 't20', 'strategic').length, 11);
  assert.ok(count(B.selectXI(squad, 11, 'test', 'strategic'), 'bowl') > count(B.selectXI(squad, 11, 't20', 'strategic'), 'bowl'), 'Tests pick more specialist bowlers');
  assert.ok(count(B.selectXI(squad, 11, 't20', 'aggressive'), 'bat') > count(B.selectXI(squad, 11, 't20', 'defensive'), 'bat'), 'aggressive picks more batters');
  const options = [{ id: 'x', balls: 18, runs: 40, wickets: 3 }, { id: 'y', balls: 18, runs: 14, wickets: 0 }, { id: 'z', balls: 12, runs: 20, wickets: 1 }];
  assert.equal(B.chooseBowler({ options, last: 'z', noConsecutive: true, phase: 'death', level: 'hard', personality: 'strategic', rand: rng(1) }), 'y', 'strategic bowls the economical bowler at the death');
  assert.equal(B.chooseBowler({ options, last: 'z', noConsecutive: true, phase: 'middle', level: 'hard', personality: 'aggressive', rand: rng(1) }), 'x', 'aggressive bowls the wicket-taker');
  assert.notEqual(B.chooseBowler({ options, last: 'y', noConsecutive: true, phase: 'death', level: 'hard', personality: 'strategic', rand: rng(1) }), 'y', 'never two overs in a row');
}

// ===== 6. Situation awareness =====
{
  const W = (s) => B.wicketCost({ format: 'custom', target: null, wicketsLeft: 5, ...s }, 'hard', 'strategic');
  assert.ok(W({ target: 100, need: 80, ballsLeft: 12 }) < W({ target: 100, need: 10, ballsLeft: 30 }), 'a steep chase makes a wicket cheaper than a cruise');
  assert.ok(W({ ballsLeft: 3 }) < W({ ballsLeft: 60 }), 'last-over slog when setting a total');
  assert.ok(W({ ballsLeft: 30, wicketsLeft: 1 }) > W({ ballsLeft: 30, wicketsLeft: 5 }), 'last wicket is guarded');
  const T = (s) => B.wicketCost({ format: 'test', wicketsLeft: 5, ...s }, 'hard', 'strategic');
  assert.ok(T({ target: 400, need: 380, scheduledBallsLeft: 60 }) > T({ target: 100, need: 40, scheduledBallsLeft: 300 }), 'Test: bats for the draw when the target is out of reach');
  assert.equal(B.wicketCost({ format: 'custom', target: 100, need: 80, ballsLeft: 12, wicketsLeft: 5 }, 'easy', 'strategic'),
    B.wicketCost({ format: 'custom', target: 100, need: 10, ballsLeft: 60, wicketsLeft: 5 }, 'easy', 'strategic'), 'easy ignores the situation');
  // Dot-over requirement: never blocks when it must score.
  const rand = rng(3);
  for (let i = 0; i < 500; i++) {
    const seq = B.chooseBatting({ format: 'test', need: 6, level: LEVELS[i % 4], personality: PERS[i % 4], rand, oppHistory: [], bowledSinceWicket: [], ballInOver: 1, situation: { format: 'test', wicketsLeft: 5 }, requirement: { startsNextOver: false, ballsLeft: 2 } });
    assert.ok(seq[0] !== 0 && seq[1] !== 0, 'scores off balls 1 and 2 under the dot-over rule');
  }
}

// ===== 7. Bowling fuzz: every level × personality × format, from any point in an over =====
{
  let cases = 0;
  for (const format of ['custom', 'test']) {
    const rules = rulesFor({ format });
    const rand = rng(11);
    for (let k = 0; k < 4000; k++) {
      const level = LEVELS[k % 4], personality = PERS[(k >> 2) % 4];
      const already = []; const len = Math.floor(rand() * 5);
      while (already.length < len) { const opts = rules.bowler.filter((d) => !B.wouldBreak(d, already)); already.push(opts[Math.floor(rand() * opts.length)]); }
      const hist = Array.from({ length: Math.floor(rand() * 80) }, (_, i) => ({ d: rules.batter[Math.floor(rand() * rules.batter.length)], pos: i % 6 }));
      const need = 6 - already.length;
      const seq = B.chooseBowling({ format, need, level, personality, rand, oppHistory: hist, bowledSinceWicket: already, ballInOver: already.length + 1, situation: { format, wicketsLeft: 5, ballsLeft: 30 } });
      assert.equal(checkDigits({ format }, 'bowl', seq, already), null, `${format} ${level}/${personality}: ${already.join('')}|${seq.join('')}`);
      const bat = B.chooseBatting({ format, need, level, personality, rand, oppHistory: hist.map((x) => ({ ...x, d: rules.bowler[x.d % rules.bowler.length] })), bowledSinceWicket: already, ballInOver: already.length + 1, situation: { format, wicketsLeft: 5, ballsLeft: 30 } });
      assert.equal(checkDigits({ format }, 'bat', bat, []), null, `${format} batting ${level}/${personality}: ${bat.join('')}`);
      cases++;
    }
  }
  console.log(`  fuzz: ${cases} decision cases, no rule violations`);
}

console.log('✔ all AI grid, fairness and strength tests passed');
process.exit(0);
