// Phase 3: statistics, analysis, replay and highlights. Every figure is checked against the saved deliveries,
// and the replay is checked against the engine's own scorecard for every match played here.
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
const G = await import('../server/engine.js');
const AI = await import('../server/ai.js');
const B = await import('../server/aibrain.js');
const CDB = await import('../server/cricketdb.js');
const AN = await import('../server/analytics.js');
const ST = await import('../server/stats.js');
const { all, get, run } = await import('../server/db.js');
const { rulesFor } = await import('../server/rules.js');
CDB.seedIfEmpty();

function rng(seed) { let h = seed >>> 0 || 1; return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1e9) / 1e9; }; }
let n = 0;
const user = (name) => { const id = `p${++n}`; run('INSERT INTO users (id, display_name, is_guest, created_at) VALUES (?,?,1,?)', id, name, Date.now()); return id; };
const ctx = () => G.newCtx();
const picker = (format, rand) => {
  const r = rulesFor({ format });
  return (role, need, soFar0) => {
    const out = [], soFar = [...soFar0];
    for (let i = 0; i < need; i++) {
      const opts = role === 'bat' ? r.batter : r.bowler.filter((d) => !B.wouldBreak(d, soFar));
      const d = opts[Math.floor(rand() * opts.length)]; out.push(d); if (role === 'bowl') soFar.push(d);
    }
    return out;
  };
};

// Play a match against the AI to the end.
function vsAI(hid, config, { real = false, seed = 1 } = {}) {
  const rand = rng(seed), pick = picker(config.format || 'custom', rand);
  const id = G.createMatch(hid, { name: `stats ${seed}`, teamA: 'Mine', teamB: 'Bots', realTeams: real ? { A: 'int-ind', B: 'int-aus' } : undefined,
    config: { ...config, participation: 'ai', teamSource: real ? 'real' : 'custom', aiLevel: 'hard', xiSize: 5 } });
  const controls = (st, pid) => pid === hid || st.members.find((x) => x.id === pid)?.controller === hid;
  for (let g = 0; g < 20000; g++) {
    let acted = false;
    for (let k = 0; k < 6 && AI.aiStep(id); k++) acted = true;
    const st = G.publicState(id);
    if (st.status === 'completed') return id;
    if (st.status === 'lobby') {
      if (!st.lineups.A.confirmedAt && !st.toss.result) { G.confirmLineup(hid, id, 'A', ctx()); continue; }
      if (st.stage === 'toss_call' && st.captains[st.toss.caller] === hid) { G.callToss(hid, id, 'heads', ctx()); continue; }
      if (st.stage === 'toss_decision' && st.captains[st.toss.winner] === hid) { G.decideToss(hid, id, 'bat', ctx()); continue; }
    } else if (st.status === 'innings_break') {
      if (st.test?.followOn && st.captains[st.test.followOn.team] === hid) { G.testAction(hid, id, { type: 'follow_on', enforce: true }, ctx()); continue; }
      if (!acted) { G.nextInnings(hid, id, ctx()); continue; }
    } else if (st.status === 'session_break' || st.status === 'day_break') { G.testAction(hid, id, { type: 'next_session' }, ctx()); continue; }
    else if (st.status === 'live') {
      const c = st.current, bw = c.open ? c.set.bowlerId : c.bowlerId, bt = c.open ? c.set.batterId : c.strikerId;
      if (controls(st, bw) && !(c.open && c.set.bowlerLocked)) { G.submitOver(hid, id, pick('bowl', c.cap, c.bowledThisOver), ctx()); continue; }
      if (controls(st, bt) && !(c.open && c.set.batterLocked)) { G.submitOver(hid, id, pick('bat', c.cap, []), ctx()); continue; }
    }
    if (!acted) throw new Error(`stuck at ${st.status}`);
  }
  throw new Error('never finished');
}

// An umpired 1 v 1 match with a voided over and run adjustments, played to the end.
function umpired(seed) {
  const rand = rng(seed), pick = picker('custom', rand);
  const ump = user('Umpire'), a = user('Asha'), b = user('Bilal');
  const id = G.createMatch(ump, { name: 'umpired', teamA: 'Ash XI', teamB: 'Bil XI', config: { mode: 'umpire', format: 'custom', overs: 3, wickets: 3, play: 'over' } });
  G.joinMatch(a, id); G.joinMatch(b, id);
  G.joinTeam(a, id, 'A', ctx()); G.joinTeam(b, id, 'B', ctx());
  G.confirmLineup(a, id, 'A', ctx()); G.confirmLineup(b, id, 'B', ctx());
  let st = G.publicState(id);
  G.callToss(st.captains[st.toss.caller], id, 'heads', ctx());
  st = G.publicState(id);
  G.decideToss(st.captains[st.toss.winner], id, st.toss.winner === 'A' ? 'bat' : 'bowl', ctx());
  G.startMatch(ump, id, ctx());
  let voided = false, adjusted = 0;
  for (let g = 0; g < 2000; g++) {
    st = G.publicState(id);
    if (st.status === 'completed') return { id, a, b };
    if (st.status === 'innings_break') {
      if (adjusted === 1) { G.umpireAction(ump, id, { type: 'adjust', runs: -1, reason: 'Recount' }, ctx()); adjusted++; continue; }
      G.nextInnings(ump, id, ctx()); continue;
    }
    const c = st.current;
    if (!c.open && c.ballInOver === 1 && st.innings[0].balls === 6 && !voided) { G.umpireAction(ump, id, { type: 'void', reason: 'Wrong numbers entered' }, ctx()); voided = true; continue; }
    if (!c.open && st.innings.length === 1 && st.innings[0].balls >= 3 && adjusted === 0) { G.umpireAction(ump, id, { type: 'adjust', runs: 2, reason: 'Missed runs' }, ctx()); adjusted = 1; continue; }
    const bw = c.open ? c.set.bowlerId : c.bowlerId, bt = c.open ? c.set.batterId : c.strikerId;
    if (!(c.open && c.set.bowlerLocked)) G.submitOver(bw, id, pick('bowl', c.cap, c.bowledThisOver), ctx());
    else G.submitOver(bt, id, pick('bat', c.cap, []), ctx());
  }
  throw new Error('umpired match never finished');
}

const human = user('Lehan');
const played = [];
played.push(vsAI(human, { format: 'custom', overs: 3, wickets: 3 }, { seed: 1 }));
played.push(vsAI(human, { format: 'custom', overs: 2, wickets: 2, play: 'ball' }, { seed: 2 }));
played.push(vsAI(human, { format: 't20', wickets: 4 }, { real: true, seed: 3 }));
played.push(vsAI(human, { format: 'odi', wickets: 3 }, { real: true, seed: 4 }));
played.push(vsAI(human, { format: 'test', days: 2, sessionsPerDay: 2, oversPerSession: 3, inningsPerTeam: 2, wickets: 3 }, { real: true, seed: 5 }));
played.push(vsAI(human, { format: 'test', days: 1, sessionsPerDay: 3, oversPerSession: 2, inningsPerTeam: 2, wickets: 4 }, { real: false, seed: 6 }));
for (let s = 0; s < 12; s++) played.push(vsAI(human, { format: ['custom', 't20', 'test'][s % 3], overs: 2, wickets: 2, days: 1, sessionsPerDay: 2, oversPerSession: 2, inningsPerTeam: 2 }, { real: s % 2 === 0, seed: 10 + s }));
const ump = umpired(99);
played.push(ump.id);

// ===== 1. Replay and analysis match the engine's scorecard, for every match =====
let checkedBalls = 0;
for (const id of played) {
  const st = G.publicState(id);                // the engine's own scorecard
  const rp = AN.replay(id), an = AN.matchAnalysis(id);
  for (const card of st.innings) {
    const label = `${id} innings ${card.number}`;
    const frames = rp.frames.filter((f) => f.innings === card.number);
    const counted = frames.filter((f) => f.type === 'ball' && !f.voided);
    const last = [...frames].reverse().find((f) => f.score);
    // Final replay score = scorecard.
    assert.equal(last.score.runs, card.runs, `${label}: replay runs (the engine total includes umpire adjustments)`);
    assert.equal(last.score.wickets, card.wickets, `${label}: replay wickets`);
    assert.equal(counted.length, card.balls, `${label}: replay balls`);
    // Rebuild the batting and bowling cards from the replay's deliveries alone.
    const bat = {}, bowl = {};
    for (const f of counted) {
      bat[f.batter] ??= { runs: 0, balls: 0 }; bat[f.batter].runs += f.runs; bat[f.batter].balls++;
      bowl[f.bowler] ??= { runs: 0, balls: 0 }; bowl[f.bowler].runs += f.runs; bowl[f.bowler].balls++;
      assert.equal(f.runs, f.wicket ? 0 : f.bat, `${label}: replay runs follow the numbers`);
    }
    for (const r of card.card.batting) assert.deepEqual(bat[r.name], { runs: r.runs, balls: r.balls }, `${label}: ${r.name} batting`);
    for (const r of card.card.bowling) assert.deepEqual(bowl[r.name], { runs: r.runs, balls: r.balls }, `${label}: ${r.name} bowling`);
    // The replay's running score never jumps: each ball adds exactly its runs.
    let prev = 0;
    for (const f of frames.filter((x) => x.score)) {
      if (f.type === 'ball' && !f.voided) assert.equal(f.score.runs, prev + f.runs, `${label}: running score`);
      if (f.type === 'adjustment') assert.equal(f.score.runs, prev + f.delta, `${label}: adjustment`);
      prev = f.score.runs;
    }
    // Analysis agrees too, and its parts add up.
    const ia = an.innings.find((i) => i.number === card.number);
    assert.equal(ia.runs, G.totals(ia.id).runs, `${label}: analysis total`);
    assert.equal(ia.wickets, card.wickets); assert.equal(ia.balls, card.balls);
    assert.equal(ia.battingCard.reduce((s, x) => s + x.runs, 0) + ia.adjustments, ia.runs, `${label}: batting card + adjustments = total`);
    assert.equal(ia.bowlingCard.reduce((s, x) => s + x.runs, 0), ia.ballRuns, `${label}: bowling card = runs off the bat`);
    assert.equal(ia.partnerships.reduce((s, x) => s + x.runs, 0), ia.ballRuns, `${label}: partnerships add up`);
    assert.equal(ia.overList.reduce((s, x) => s + x.runs, 0), ia.ballRuns, `${label}: overs add up`);
    assert.equal(ia.fow.length, ia.wickets, `${label}: one fall of wicket per wicket`);
    assert.equal(ia.bowlingCard.reduce((s, x) => s + x.wickets, 0), card.card.bowling.reduce((s, x) => s + x.wickets, 0), `${label}: bowlers' wickets`);
    for (const r of card.card.batting) {
      const a = ia.battingCard.find((x) => x.id === r.id);
      assert.equal(a.fours, r.fours); assert.equal(a.sixes, r.sixes); assert.equal(a.outs, r.outs);
    }
    // Dots and maidens recount directly from the balls table.
    const rows = all('SELECT * FROM balls WHERE innings_id = ? AND voided = 0', ia.id);
    assert.equal(ia.bowlingCard.reduce((s, x) => s + x.dots, 0), rows.filter((b) => b.runs === 0).length, `${label}: dots`);
    checkedBalls += rows.length;
  }
  // Test sessions and days add up to the match.
  if (an.test) {
    const ballRuns = an.innings.reduce((s, i) => s + i.ballRuns, 0), balls = an.innings.reduce((s, i) => s + i.balls, 0);
    assert.equal(an.test.sessions.reduce((s, x) => s + x.runs, 0), ballRuns, `${id}: sessions add up`);
    assert.equal(an.test.days.reduce((s, x) => s + x.balls, 0), balls, `${id}: days add up`);
    assert.ok(rp.frames.some((f) => f.type === 'session'), `${id}: replay marks the sessions`);
  }
  // Every highlight points at a real delivery in the replay.
  const ids = new Set(rp.frames.filter((f) => f.type === 'ball').map((f) => f.id));
  for (const h of AN.highlights(id)) if (h.ballId != null) assert.ok(ids.has(h.ballId), `${id}: highlight "${h.title}" refers to a real delivery`);
  const hl = AN.highlights(id);
  assert.equal(hl.filter((h) => h.kind === 'wicket').length, an.innings.reduce((s, i) => s + i.wickets, 0), `${id}: a highlight for every wicket`);
  if (an.result?.winner) assert.ok(hl.some((h) => h.kind === 'winner') || an.innings.at(-1).adjustments, `${id}: the winning moment is highlighted`);
  // Transitions are in order: each innings starts before its balls and ends after them.
  const starts = rp.frames.filter((f) => f.type === 'innings_start').map((f) => f.i), ends = rp.frames.filter((f) => f.type === 'innings_end').map((f) => f.i);
  starts.forEach((s, k) => { if (ends[k] != null) assert.ok(s < ends[k]); });
  assert.equal(rp.frames.at(-1).type, 'match_end');
}
console.log(`  replay = scorecard for ${played.length} matches (${checkedBalls} deliveries)`);

// ===== 2. Voided overs and umpire adjustments =====
{
  const rp = AN.replay(ump.id);
  assert.ok(rp.frames.some((f) => f.type === 'ball' && f.voided), 'voided deliveries are shown in the replay');
  const adj = rp.frames.filter((f) => f.type === 'adjustment');
  assert.deepEqual(adj.map((f) => [f.innings, f.delta]), [[1, 2], [1, -1]], 'adjustments appear where they were made');
  const an = AN.matchAnalysis(ump.id);
  assert.equal(an.innings[0].adjustments, 1); assert.ok(an.innings[0].voidedBalls > 0, 'voided deliveries are counted separately');
}

// ===== 3. Career statistics trace back to deliveries =====
{
  const c = AN.career(human);
  // Independent recount straight from the balls table, crediting the controller of real-team squad players.
  const owned = all(`SELECT b.*, COALESCE(bm.controller_id, b.batter_id) AS bo, COALESCE(wm.controller_id, b.bowler_id) AS wo
      FROM balls b JOIN innings i ON i.id = b.innings_id JOIN matches m ON m.id = i.match_id
      LEFT JOIN members bm ON bm.match_id = i.match_id AND bm.user_id = b.batter_id
      LEFT JOIN members wm ON wm.match_id = i.match_id AND wm.user_id = b.bowler_id
      WHERE m.status = 'completed' AND b.voided = 0 AND i.super_over = 0`);
  const mine = owned.filter((b) => b.bo === human), mineBowl = owned.filter((b) => b.wo === human);
  assert.ok(mine.length > 0 && mineBowl.length > 0);
  assert.equal(c.batting.runs, mine.reduce((s, b) => s + b.runs, 0), 'career runs');
  assert.equal(c.batting.balls, mine.length, 'balls faced');
  assert.equal(c.batting.dismissals, mine.filter((b) => b.is_wicket).length, 'dismissals');
  assert.equal(c.batting.fours, mine.filter((b) => b.runs === 4).length); assert.equal(c.batting.sixes, mine.filter((b) => b.runs === 6).length);
  assert.equal(c.batting.dots, mine.filter((b) => b.runs === 0).length, 'dot balls');
  assert.equal(c.bowling.balls, mineBowl.length); assert.equal(c.bowling.runs, mineBowl.reduce((s, b) => s + b.runs, 0));
  assert.equal(c.bowling.wickets, mineBowl.filter((b) => b.is_wicket && b.dismissal !== 'dot_rule').length, 'wickets');
  assert.equal(c.batting.average, c.batting.dismissals ? +(c.batting.runs / c.batting.dismissals).toFixed(2) : null);
  assert.equal(c.bowling.economy, +((c.bowling.runs * 6) / c.bowling.balls).toFixed(2));
  // Real-team play counts for the person controlling the squad.
  const ghostRuns = owned.filter((b) => b.bo === human && b.batter_id !== human).reduce((s, b) => s + b.runs, 0);
  assert.ok(ghostRuns > 0, 'runs scored as real-team players count');
  // Splits add back up to the career.
  assert.equal(c.formats.reduce((s, f) => s + f.batting.runs, 0), c.batting.runs, 'format splits add up');
  assert.equal(c.teams.reduce((s, f) => s + f.bowling.wickets, 0), c.bowling.wickets, 'team splits add up');
  assert.equal(c.record.matches, played.length - 1, 'every match against the AI counts');
  assert.equal(c.ai.overall.matches, played.length - 1);
  assert.equal(c.ai.byOpponent[0].label, 'hard, strategic');
  assert.ok(c.formats.some((f) => f.key === 'test') && c.formats.some((f) => f.key === 'odi'));
  assert.equal(c.recent.length, 10);
  // Highest score and best figures are real knocks and spells.
  const top = c.bests.batting[0];
  const knock = all('SELECT SUM(runs) AS r, COUNT(*) AS n FROM balls b JOIN innings i ON i.id = b.innings_id WHERE i.id = ? AND b.batter_id = ? AND b.stint = (SELECT stint FROM balls WHERE innings_id = ? AND batter_id = ? AND voided = 0 GROUP BY stint ORDER BY SUM(runs) DESC, COUNT(*) LIMIT 1) AND b.voided = 0', top.inningsId, top.batterId, top.inningsId, top.batterId)[0];
  assert.equal(knock.r, top.runs, 'top score is a real knock'); assert.equal(c.batting.highest.runs, top.runs);
  if (c.bests.bowling[0]) {
    const s = c.bests.bowling[0];
    const w = get(`SELECT COUNT(*) AS c FROM balls WHERE innings_id = ? AND bowler_id = ? AND voided = 0 AND is_wicket = 1 AND COALESCE(dismissal, '') <> 'dot_rule'`, s.inningsId, s.bowlerId).c;
    assert.equal(w, s.wickets, 'best figures are a real spell');
  }
  // Profile and leaderboard use the same attribution.
  const lb = ST.leaderboard('runs').find((r) => r.id === human);
  assert.equal(lb.runs, c.batting.runs, 'leaderboard runs match the career');
  // Umpired players have careers too; the umpire, who never played, has none.
  const ua = AN.career(ump.a);
  assert.equal(ua.record.matches, 1); assert.ok(ua.batting.balls > 0 || ua.bowling.balls > 0);
  assert.equal(AN.career(user('Nobody')).batting.innings, 0, 'no deliveries, no stats');
  assert.equal(AN.career(user('Nobody2')).batting.average, null, 'no invented averages');
}

// ===== 4. A live match only shows what has been revealed =====
{
  const hid = user('Live');
  const id = G.createMatch(hid, { name: 'live', teamA: 'A', teamB: 'B', quick: { start: 'bowl' }, config: { participation: 'ai', format: 'custom', overs: 5, wickets: 5 } });
  G.submitOver(hid, id, [1, 2, 3, 4, 5, 6], ctx()); // the human's numbers are locked in but not revealed
  const rp = AN.replay(id);
  assert.equal(rp.frames.filter((f) => f.type === 'ball').length, 0, 'nothing appears before the reveal');
  assert.ok(!JSON.stringify(rp).includes('"seq"'));
}

console.log('✔ all statistics, analysis, replay and highlight tests passed');
process.exit(0);
