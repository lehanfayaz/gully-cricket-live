// Phase 6: commentary never contradicts the scorecard. Every line is checked against the replay
// (which is itself checked against the scorecard) and the deliveries it describes.
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
const G = await import('../server/engine.js');
const AI = await import('../server/ai.js');
const B = await import('../server/aibrain.js');
const AN = await import('../server/analytics.js');
const { commentary } = await import('../server/commentary.js');
const { all, run } = await import('../server/db.js');
const { rulesFor } = await import('../server/rules.js');

let n = 0;
const user = (name) => { const id = `b${++n}`; run('INSERT INTO users (id, display_name, is_guest, created_at) VALUES (?,?,1,?)', id, name, Date.now()); return id; };
const ctx = () => G.newCtx();
const teamName = (m, t) => (t === 'A' ? m.team_a : m.team_b);
function rng(seed) { let h = seed >>> 0 || 1; return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1e9) / 1e9; }; }

// Two people, no umpire. script(role, need, state) returns the numbers.
function pvp(config, script, umpire = false) {
  const host = user('Host'), a = user('Asha'), b = user('Bilal');
  const id = G.createMatch(host, { name: 'c', teamA: 'Asha XI', teamB: 'Bilal XI', config: { mode: umpire ? 'umpire' : 'auto', ...config } });
  G.joinMatch(a, id); G.joinMatch(b, id); G.joinTeam(a, id, 'A', ctx()); G.joinTeam(b, id, 'B', ctx());
  G.confirmLineup(a, id, 'A', ctx()); G.confirmLineup(b, id, 'B', ctx());
  let st = G.publicState(id);
  G.callToss(st.captains[st.toss.caller], id, 'heads', ctx());
  st = G.publicState(id);
  G.decideToss(st.captains[st.toss.winner], id, st.toss.winner === 'A' ? 'bat' : 'bowl', ctx());
  if (umpire) G.startMatch(host, id, ctx());
  for (let g = 0; g < 5000; g++) {
    st = G.publicState(id);
    if (st.status === 'completed') return { id, host };
    if (st.status === 'session_break' || st.status === 'day_break') { G.testAction(a, id, { type: 'next_session' }, ctx()); continue; }
    if (st.status === 'innings_break') { if (st.test?.followOn) G.testAction(st.captains[st.test.followOn.team], id, { type: 'follow_on', enforce: false }, ctx()); else G.nextInnings(host, id, ctx()); continue; }
    const extra = script.hook?.(st, host, id);
    if (extra) continue;
    const c = st.current;
    const bw = c.open ? c.set.bowlerId : c.bowlerId, bt = c.open ? c.set.batterId : c.strikerId;
    if (!(c.open && c.set.bowlerLocked)) G.submitOver(bw, id, script('bowl', c.cap, st), ctx());
    else G.submitOver(bt, id, script('bat', c.cap, st), ctx());
  }
  throw new Error('match never finished');
}

function check(id, label) {
  const m = G.loadMatch(id);
  const lines = commentary(m, { limit: 100000, teamName });
  const rp = AN.replay(id), an = AN.matchAnalysis(id);
  const frameOf = Object.fromEntries(rp.frames.filter((f) => f.type === 'ball').map((f) => [f.id, f]));
  const balls = Object.fromEntries(all('SELECT b.*, i.number AS inn, i.target, i.max_balls FROM balls b JOIN innings i ON i.id = b.innings_id WHERE i.match_id = ?', id).map((b) => [b.id, b]));
  const knockEnd = {};
  for (const i of an.innings) for (const k of i.knocks) knockEnd[k.lastBallId] = k;
  assert.equal(lines.length, Object.keys(balls).length, `${label}: a line for every delivery`);
  let checked = 0;
  for (const l of lines) {
    const b = balls[l.id], f = frameOf[l.id];
    // The score in the line is the scorecard's score at that ball.
    assert.equal(l.score, `${f.score.runs}/${f.score.wickets}`, `${label} ${l.over}: score in commentary`);
    if (!l.voided) assert.ok(l.text.includes(`${f.score.runs}/${f.score.wickets}`), `${label} ${l.over}: the line states the right score`);
    // What happened matches the ball.
    if (b.voided) assert.match(l.text, /Voided/);
    else if (b.dismissal === 'dot_rule') assert.match(l.text, /dot-over rule/);
    else if (b.is_wicket) { assert.match(l.text, /^(.*\. )?OUT!/); assert.ok(l.text.includes(`departs for ${knockEnd[b.id].runs} `), `${label} ${l.over}: dismissed batter's score`); }
    else if (b.runs === 6) assert.match(l.text, /SIX!/);
    else if (b.runs === 4) assert.match(l.text, /FOUR!/);
    if (!b.is_wicket || b.dismissal === 'dot_rule') assert.doesNotMatch(l.text, /has found the matching number|Matching numbers/);
    if (b.runs !== 6) assert.doesNotMatch(l.text, /SIX!/);
    if (b.runs !== 4) assert.doesNotMatch(l.text, /FOUR!/);
    // The chase equation.
    const mm = l.text.match(/needing (\d+) runs? from (\d+) balls?/);
    if (mm) { assert.equal(+mm[1], b.target - f.score.runs, `${label}: runs needed`); assert.equal(+mm[2], b.max_balls - f.score.overs.split('.').reduce((o, x, i) => (i ? o + +x : +x * 6), 0), `${label}: balls left`); }
    // A fifty is only called when the knock crosses 50.
    if (/a fifty for/.test(l.text)) { const k = Object.values(knockEnd).find((x) => b.id >= x.firstBallId && b.id <= x.lastBallId); assert.ok(k.runs >= 50); }
    if (!/test/.test(m.config.format)) assert.doesNotMatch(l.text, /dot-over|scoring requirement|Day \d/);
    checked++;
  }
  return { lines, checked };
}

let total = 0;
// 1. A Test with a six-ball dot over and then a dot-rule dismissal (no umpire: automatic).
{
  const r = rulesFor({ format: 'test' });
  let phase = 0; // 0: dot over, 1: two more dots, then normal
  const script = (role, need, st) => {
    const c = st.current, inn = st.innings.at(-1);
    if (role === 'bowl') { const out = [], so = [...c.bowledThisOver]; for (let i = 0; i < need; i++) { const d = [1, 2, 3, 4, 6].find((x) => !B.wouldBreak(x, so)); out.push(d); so.push(d); } return out; }
    if (inn.number === 1 && inn.balls < 8) return Array(need).fill(0);
    return Array(need).fill(r.batter.includes(4) ? 4 : 1).map((x, i) => [4, 3, 2, 6][(i + inn.balls) % 4]);
  };
  const { id } = pvp({ format: 'test', days: 1, sessionsPerDay: 2, oversPerSession: 3, inningsPerTeam: 1, wickets: 3 }, script);
  const { lines } = check(id, 'test');
  assert.ok(lines.some((l) => /completed a six-ball dot over and must score within the next two legal balls/.test(l.text)), 'dot over called');
  assert.ok(lines.some((l) => /must score off the next legal ball/.test(l.text)), 'requirement countdown');
  assert.ok(lines.some((l) => /out under the dot-over rule/.test(l.text)), 'dot-rule dismissal called');
  assert.ok(lines.some((l) => /Day 1, session 2 is underway/.test(l.text)), 'session start called');
  total += lines.length;
}
// 2. An umpired match with run adjustments and a voided over: the commentary score follows the scorecard.
{
  let adjusted = false, voided = false;
  const rand = rng(4);
  const script = (role, need, st) => {
    const r = rulesFor({ format: 'custom' }), out = [], so = [...(role === 'bowl' ? st.current.bowledThisOver : [])];
    for (let i = 0; i < need; i++) { const o = role === 'bat' ? r.batter : r.bowler.filter((d) => !B.wouldBreak(d, so)); const d = o[Math.floor(rand() * o.length)]; out.push(d); if (role === 'bowl') so.push(d); }
    return out;
  };
  script.hook = (st, host, id) => {
    if (!adjusted && st.innings[0]?.balls >= 4 && !st.current.open) { G.umpireAction(host, id, { type: 'adjust', runs: 3, reason: 'Recount' }, ctx()); adjusted = true; return true; }
    if (!voided && st.innings[0]?.balls >= 9 && !st.current.open) { G.umpireAction(host, id, { type: 'void', reason: 'Mistake' }, ctx()); voided = true; return true; }
    return false;
  };
  const { id } = pvp({ format: 'custom', overs: 3, wickets: 3 }, script, true);
  const { lines } = check(id, 'umpired');
  assert.ok(adjusted && voided && lines.some((l) => l.voided));
  total += lines.length;
}
// 3. AI v AI matches in every limited format, as in tournaments.
for (const [k, format] of [['t20', 't20'], ['odi', 'odi'], ['custom', 'custom']].entries()) {
  const owner = user('Owner');
  const id = G.createTournamentMatch(owner, { name: 'x', config: { format: format[1], overs: 5, wickets: 10, untilWinner: true }, tournament: { id: 'T', fixtureId: k, label: 'Check' },
    sides: { A: { name: 'Lions', short: 'LIO', level: 'expert', personality: 'aggressive' }, B: { name: 'Tigers', short: 'TIG', level: 'hard', personality: 'defensive' } } });
  while (AI.aiStep(id));
  total += check(id, format[0]).lines.length;
}
console.log(`  ${total} commentary lines checked against the scorecard`);
console.log('✔ all commentary tests passed');
process.exit(0);
