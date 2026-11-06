// Phase 5: profiles, achievements, challenges, levels. Unlocks are earned in real matches played through the engine.
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.ADMIN_USERNAMES = 'boss';
const { server } = await import('../server/index.js');
const G = await import('../server/engine.js');
const AI = await import('../server/ai.js');
const TOUR = await import('../server/tournament.js');
const CAREER = await import('../server/career.js');
const { run, get } = await import('../server/db.js');
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
const base = `http://localhost:${server.address().port}`;
const api = async (path, body, token, method) => {
  const r = await fetch(base + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j;
};
const ctx = () => G.newCtx();

// A scripted match: the human hits 6 every ball; when the AI bats, the human bowls its number (a wicket every ball).
function scripted(uid, mid) {
  let k = 0;
  for (let g = 0; g < 3000; g++) {
    const st = G.publicState(mid);
    if (st.status === 'completed') return st;
    if (st.status === 'lobby') {
      if (!st.lineups.A.confirmedAt && !st.toss.result) G.confirmLineup(uid, mid, 'A', ctx());
      else if (st.stage === 'toss_call' && st.captains[st.toss.caller] === uid) G.callToss(uid, mid, 'heads', ctx());
      else if (st.stage === 'toss_decision' && st.captains[st.toss.winner] === uid) G.decideToss(uid, mid, 'bat', ctx());
      else if (!AI.aiStep(mid)) throw new Error('lobby stuck');
      continue;
    }
    const c = st.current;
    const mine = (pid) => pid === uid || st.members.find((x) => x.id === pid)?.controller === uid;
    const bot = st.members.find((x) => x.bot).id;
    const bw = c.open ? c.set.bowlerId : c.bowlerId, bt = c.open ? c.set.batterId : c.strikerId;
    const humanBats = mine(bt);
    if (!(c.open && c.set.bowlerLocked)) {
      const seq = humanBats ? Array.from({ length: c.cap }, (_, i) => [1, 2, 3, 4, 5][(k + i) % 5]) : Array(c.cap).fill(2);
      k += c.cap;
      G.submitOver(humanBats ? bot : uid, mid, seq, ctx());
    } else G.submitOver(humanBats ? uid : bot, mid, Array(c.cap).fill(humanBats ? 6 : 2), ctx());
    void bw;
  }
  throw new Error('scripted match never finished');
}

const reg = await api('/api/auth/register', { username: 'lehan', password: 'password123', name: 'Lehan' });
const uid = reg.user.id, token = reg.token;

// Nothing played yet: Rookie, everything locked, no invented progress.
let p = await api(`/api/users/${uid}/achievements`);
assert.equal(p.level.name, 'Rookie'); assert.equal(p.level.xp, 0);
assert.ok(p.achievements.length >= 8 && p.achievements.every((a) => !a.unlocked && a.progress === 0));
assert.ok(p.challenges.daily.list.length > 0 && p.challenges.daily.list.length <= 3);
assert.ok(p.challenges.weekly.list.length > 0 && p.challenges.longterm.list.length >= 3);

// One match: 5 overs v the Expert AI, ball by ball. 30 sixes, a hat-trick, a win, no wickets lost.
const mid = G.createMatch(uid, { name: 'Career', teamA: 'Lehan XI', teamB: 'Bots', quick: { start: 'bat' }, config: { format: 'custom', overs: 5, wickets: 3, play: 'ball', aiLevel: 'expert' } });
const st = scripted(uid, mid);
assert.equal(st.result.winner, 'A');
assert.equal(st.innings[0].runs, 180);
p = await api(`/api/users/${uid}/achievements`);
const A = Object.fromEntries(p.achievements.map((a) => [a.id, a]));
for (const id of ['first-fifty', 'first-century', 'hat-trick', 'six-machine', 'giant-killer', 'first-win']) {
  assert.ok(A[id].unlocked, `${id} unlocked`);
  assert.equal(A[id].ref.id, mid, `${id} points at the match that earned it`);
  assert.equal(A[id].unlockedAt, G.loadMatch(mid).ended_at, `${id} dated when the match ended`);
}
for (const id of ['test-specialist', 'unbeaten', 'champion', 'run-machine']) assert.ok(!A[id].unlocked, `${id} still locked`);
assert.equal(A.unbeaten.value, 1); assert.equal(A.unbeaten.target, 10);
assert.equal(A['run-machine'].value, 180); assert.ok(Math.abs(A['run-machine'].progress - 0.18) < 1e-9, 'progress is real');
// Stored unlocks: recorded once, never duplicated.
assert.equal(get('SELECT COUNT(*) AS c FROM user_achievements WHERE user_id = ?', uid).c, p.achievements.filter((a) => a.unlocked).length);
await api(`/api/users/${uid}/achievements`);
assert.equal(get('SELECT COUNT(*) AS c FROM user_achievements WHERE user_id = ?', uid).c, p.achievements.filter((a) => a.unlocked).length);
// Challenges in today's and this week's windows.
const daily = Object.fromEntries(p.challenges.daily.list.map((c) => [c.id, c]));
if (daily['d-fifty-5']) assert.ok(daily['d-fifty-5'].done, 'fifty in a 5-over match');
if (daily['d-tight-win']) assert.ok(daily['d-tight-win'].done, 'won without losing more than two wickets');
const weekly = Object.fromEntries(p.challenges.weekly.list.map((c) => [c.id, c]));
if (weekly['w-expert']) assert.ok(weekly['w-expert'].done);
// Each challenge rule evaluated directly, independent of rotation.
const facts = CAREER.matchFacts(uid);
assert.equal(facts.length, 1);
assert.deepEqual({ runs: facts[0].runs, sixes: facts[0].sixes, wicketsTaken: facts[0].wicketsTaken, hatTrick: facts[0].hatTrick, wicketsLost: facts[0].wicketsLost, won: facts[0].won, aiLevel: facts[0].aiLevel, overs: facts[0].overs },
  { runs: 180, sixes: 30, wicketsTaken: 3, hatTrick: true, wicketsLost: 0, won: true, aiLevel: 'expert', overs: 5 });
assert.ok(CAREER.evaluate({ type: 'max', field: 'runs', target: 50, where: { overs: 5 } }, facts, []).done);
assert.ok(CAREER.evaluate({ type: 'count', target: 1, where: { won: true, maxWicketsLost: 2 } }, facts, []).done);
assert.ok(!CAREER.evaluate({ type: 'count', target: 1, where: { won: true, format: ['test'] } }, facts, []).done, 'no Test win');
// Windows: yesterday's challenge doesn't count today's match.
const day = CAREER.periodOf('daily');
assert.ok(!CAREER.evaluate({ type: 'count', target: 1, where: { won: true } }, facts, [], day.from - 86400000, day.from).done);
// Level from play and achievements.
assert.ok(p.level.xp > 300 && p.level.breakdown.play === 180 + 3 * 15 + 50);
assert.equal(p.level.name, 'Amateur', 'past 300 XP with an achievement; Professional needs 1,500 XP');
assert.equal(p.level.next.name, 'Professional');
assert.equal(p.level.xp, p.level.breakdown.play + p.level.breakdown.achievements + p.level.breakdown.challenges);
assert.ok(p.milestones.some((m) => m.title === 'First win') && p.milestones.some((m) => m.title === '100 career runs'));

// Streaks: a loss breaks the run (evaluator on facts in order).
const fake = (won, t) => ({ id: `m${t}`, endedAt: t, won, runs: 0 });
assert.equal(CAREER.evaluate({ type: 'streak', target: 3, where: { won: true } }, [fake(true, 1), fake(true, 2), fake(false, 3), fake(true, 4)], []).value, 2);
assert.ok(CAREER.evaluate({ type: 'streak', target: 3, where: { won: true } }, [fake(true, 1), fake(true, 2), fake(true, 3), fake(false, 4)], []).done);

// A tournament win with IPL franchises: Champion, IPL Champion and the long-term IPL-style challenge.
{
  const tid = TOUR.createTournament(uid, { kind: 'knockout', name: 'Mini IPL', teams: [{ teamId: 'ipl-csk' }, { teamId: 'ipl-mi' }], humanIndex: 0, match: { format: 'custom', overs: 2, wickets: 2, aiLevel: 'hard', aiPersonality: 'strategic', play: 'ball', xiSize: 3 } });
  const tm = TOUR.playNext(uid, tid);
  const s2 = scripted(uid, tm);
  assert.equal(s2.result.winner, 'A');
  const v = TOUR.view(tid, uid);
  assert.equal(v.status, 'completed'); assert.ok(v.champion.human);
  p = await api(`/api/users/${uid}/achievements`);
  const B = Object.fromEntries(p.achievements.map((a) => [a.id, a]));
  assert.ok(B.champion.unlocked && B['ipl-champion'].unlocked);
  assert.equal(B.champion.ref.id, tid); assert.equal(B.champion.ref.kind, 'tournament');
  assert.ok(p.challenges.longterm.list.find((c) => c.id === 'l-ipl-tournament').done);
  assert.equal(p.tournamentWins, 1);
  // Real-team play counts: runs scored by squad players are the controlling person's.
  assert.equal(CAREER.matchFacts(uid).at(-1).runs, s2.innings[0].runs);
}

// Admins add a new achievement without any code change; it applies to past matches straight away.
const boss = await api('/api/auth/register', { username: 'boss', password: 'password123', name: 'Boss' });
await assert.rejects(api('/api/admin/achievements', { id: 'x', title: 'X', rule: { type: 'sum', field: 'sixes', target: 20 } }, token), /permission/);
await assert.rejects(api('/api/admin/achievements', { id: 'bad', title: 'Bad', rule: { type: 'sum', field: 'nonsense', target: 20 } }, boss.token), /Pick a field/);
await assert.rejects(api('/api/admin/achievements', { id: 'bad2', title: 'Bad', rule: { type: 'count', target: 1, where: { secret: true } } }, boss.token), /Unknown condition/);
await api('/api/admin/achievements', { id: 'twenty-sixes', title: 'Twenty Sixes', description: 'Hit 20 sixes', icon: '6️⃣', xp: 40, rule: { type: 'sum', field: 'sixes', target: 20 } }, boss.token);
await api('/api/admin/challenges', { id: 'd-test', period: 'daily', title: 'Win one', description: 'Win a match today', xp: 10, rule: { type: 'count', target: 1, where: { won: true } } }, boss.token);
p = await api(`/api/users/${uid}/achievements`);
assert.ok(p.achievements.find((a) => a.id === 'twenty-sixes').unlocked, 'new rule applies to the existing record');
const list = await api('/api/admin/achievements', null, boss.token);
assert.ok(list.schema.fields.sixes && list.achievements.find((a) => a.id === 'twenty-sixes').unlocks === 1);
// Switching an achievement off hides it for players who haven't earned it, but never takes away an unlock.
await api('/api/admin/achievements', { id: 'unbeaten', title: 'Unbeaten', rule: { type: 'streak', target: 10, where: { won: true } }, active: false }, boss.token);
await api('/api/admin/achievements', { id: 'six-machine', title: 'Six Machine', rule: { type: 'sum', field: 'sixes', target: 10 }, active: false }, boss.token);
p = await api(`/api/users/${uid}/achievements`);
assert.ok(!p.achievements.some((a) => a.id === 'unbeaten'));
assert.ok(p.achievements.find((a) => a.id === 'six-machine').unlocked, 'earned unlocks stay');

// Profile: favourite teams and picture.
await api('/api/me', { favIntl: 'int-ind', favIpl: 'ipl-csk' }, token, 'PATCH');
await assert.rejects(api('/api/me', { favIntl: 'ipl-mi' }, token, 'PATCH'), /Pick a team/);
const png = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('base64');
await api('/api/me/avatar', { dataUrl: png }, token, 'PUT');
await assert.rejects(api('/api/me/avatar', { dataUrl: 'data:text/html;base64,PGI+' }, token, 'PUT'), /JPEG, PNG or WebP/);
const prof = await api(`/api/users/${uid}`);
assert.equal(prof.user.favIntl.id, 'int-ind'); assert.equal(prof.user.favIpl.id, 'ipl-csk'); assert.ok(prof.user.hasAvatar);
const img = await fetch(`${base}/api/users/${uid}/avatar`);
assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
assert.equal((await fetch(`${base}/api/users/nobody/avatar`)).status, 404);

console.log(`  level ${p.level.name} (${p.level.xp} XP), ${p.achievements.filter((a) => a.unlocked).length} achievements unlocked`);
console.log('✔ all career, achievement and challenge tests passed');
process.exit(0);
