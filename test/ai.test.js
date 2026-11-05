// AI opponent, one-v-one modes, real teams and the cricket data sync (against a mock provider).
import assert from 'node:assert/strict';
import http from 'node:http';

// ----- a mock CricketData.org API -----
const roles = ['WK-Batsman', 'Batsman', 'Batsman', 'Batsman', 'Batsman', 'Batting Allrounder', 'Bowling Allrounder', 'Bowler', 'Bowler', 'Bowler', 'Bowler', 'Bowler', 'Batsman', 'Bowler', 'Batsman'];
const squad = (name, short, prefix, n = 15) => ({ teamName: name, shortname: short, img: null,
  players: Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, name: `${short} Test Player ${i + 1}`, role: roles[i], battingStyle: 'Right Handed Bat', playerImg: null })) });
let iplSquads = [squad('Chennai Super Kings', 'CSK', 'csk'), squad('Mumbai Indians', 'MI', 'mi')];
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (data) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'success', data, info: { hitsToday: 1 } })); };
  if (u.pathname === '/v1/series' && u.searchParams.get('search')) return send([
    { id: 'ipl25', name: 'Indian Premier League 2025', startDate: '2025-03-22' }, { id: 'ipl26', name: 'Indian Premier League 2026', startDate: '2026-03-28' }]);
  if (u.pathname === '/v1/series') return send(u.searchParams.get('offset') === '0'
    ? [{ id: 's1', name: 'Australia tour of India, 2026', startDate: '2026-10-01', squads: 2 }, { id: 'x', name: 'Big Bash League 2026', startDate: '2026-12-01', squads: 8 }] : []);
  if (u.pathname === '/v1/series_squad' && u.searchParams.get('id') === 'ipl26') return send(iplSquads);
  if (u.pathname === '/v1/series_squad' && u.searchParams.get('id') === 's1') return send([squad('India', 'IND', 'ind'), squad('Australia', 'AUS', 'aus')]);
  res.statusCode = 404; res.end('{}');
});
await new Promise((r) => mock.listen(0, r));
process.env.CRICKETDATA_API_KEY = 'test-key';
process.env.CRICKETDATA_BASE_URL = `http://localhost:${mock.address().port}/v1`;
process.env.DB_PATH = ':memory:';
process.env.PORT = '0';
process.env.AI_DELAY_MS = '20';
process.env.NODE_ENV = 'test';
process.env.ADMIN_USERNAMES = 'boss';

const { server } = await import('../server/index.js');
const SYNC = await import('../server/sync.js');
const CDB = await import('../server/cricketdb.js');
const { chooseNumbers } = await import('../server/ai.js');
const { checkDigits } = await import('../server/rules.js');
const { io } = await import('socket.io-client');
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
const base = `http://localhost:${server.address().port}`;
const api = async (path, body, token, method) => {
  const r = await fetch(base + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
};
async function client(name) {
  const { token, user } = await api('/api/auth/guest', { name });
  const s = io(base, { auth: { token }, transports: ['websocket'] });
  const c = { name, token, user, s, states: [], privates: [] };
  s.on('state', (x) => c.states.push(x)); s.on('private', (x) => c.privates.push(x));
  c.emit = (ev, payload) => new Promise((r) => s.emit(ev, { matchId: c.matchId, ...payload }, r));
  c.ok = async (ev, payload) => { const r = await c.emit(ev, payload); assert.ok(r.ok, `${name} ${ev}: ${r.error}`); return r; };
  c.bad = async (ev, payload, re) => { const r = await c.emit(ev, payload); assert.equal(r.ok, false, `${name} ${ev} should fail`); if (re) assert.match(r.error, re); return r; };
  c.open = async (matchId) => { c.matchId = matchId; return c.ok('match:open', { matchId }); };
  c.last = () => c.states[c.states.length - 1];
  return c;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await wait(25); } throw new Error(`Timed out: ${label}`); }

// ===== 1. Sync =====
const before = await api('/api/cricket/teams');
assert.ok(before.teams.some((t) => t.id === 'int-ind' && t.squadSize === 0), 'seeded teams, no invented players');
const boss = await api('/api/auth/register', { username: 'boss', password: 'password123' });
const plainUser = await api('/api/auth/register', { username: 'pleb', password: 'password123' });
await assert.rejects(api('/api/admin/sync', {}, plainUser.token), /Only admins/);
const r1 = await api('/api/admin/sync', {}, boss.token);
assert.equal(r1.result.squads, 4);
assert.equal(r1.result.newPlayers, 60);
let t = await api('/api/cricket/teams');
assert.ok(t.sync.lastSuccessAt, 'last successful sync recorded');
assert.equal(t.teams.find((x) => x.id === 'ipl-csk').squadSize, 15);
assert.equal(t.teams.find((x) => x.id === 'int-ind').squadSize, 15);
assert.equal(CDB.currentSeason('ipl'), 'ipl-2026', 'latest IPL season becomes current');
// Next season: a player moves from CSK to MI, one is released.
const moved = iplSquads[0].players.pop();
iplSquads[1].players.push(moved);
iplSquads[0].players.pop();
const r2 = await api('/api/admin/sync', {}, boss.token);
assert.equal(r2.result.newPlayers, 0, 'no duplicate player records');
assert.equal(r2.result.transfers, 1); assert.equal(r2.result.removedPlayers, 1);
assert.equal((await api('/api/cricket/teams/ipl-mi')).squad.length, 16);
// Admin correction survives the next sync.
const ind = await api('/api/cricket/teams/int-ind');
await api(`/api/admin/players/${ind.squad[0].id}`, { name: 'Corrected Name', role: 'wk' }, boss.token, 'PATCH');
await api('/api/admin/sync', {}, boss.token);
assert.ok((await api('/api/cricket/teams/int-ind')).squad.some((p) => p.name === 'Corrected Name'));
// A failing provider is logged and keeps the old data.
const realBase = process.env.CRICKETDATA_BASE_URL;
process.env.CRICKETDATA_BASE_URL = 'http://localhost:1/v1';
await assert.rejects(api('/api/admin/sync', {}, boss.token));
process.env.CRICKETDATA_BASE_URL = realBase;
const status = await api('/api/admin/sync', undefined, boss.token);
assert.ok(status.status.lastError); assert.equal((await api('/api/cricket/teams/int-ind')).squad.length, 15);

// ===== 2. AI follows every rule (fuzz) and never depends on hidden picks =====
const fakeState = (format, bowled, extra = {}) => ({ id: 'none', format, current: { bowledThisOver: bowled, ballInOver: bowled.length + 1, strikerId: 's', cap: 6 - bowled.length, need: 50, ballsLeft: 60 },
  innings: [{ maxWickets: 10, wickets: 2, target: null }], test: format === 'test' ? { days: 3, sessionsPerDay: 3, oversPerSession: 15, day: 1, session: 1, sessionBallsLeft: 60, requirements: [], ...extra } : null });
let seed = 7; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (let k = 0; k < 3000; k++) {
  const format = k % 2 ? 'test' : 'custom';
  const pool = format === 'test' ? [1, 2, 3, 4, 6] : [1, 2, 3, 4, 5, 6];
  const bowled = [];
  for (let j = 0; j < k % 6; j++) { const opts = pool.filter((d) => !checkDigits({ format }, 'bowl', [d], bowled)); bowled.push(opts[Math.floor(rand() * opts.length)]); }
  for (const level of ['easy', 'medium', 'hard', 'expert']) {
    const st = fakeState(format, bowled);
    const b = chooseNumbers({ state: st, role: 'bowl', need: 6 - bowled.length, aiTeam: 'B', level, rand });
    assert.equal(checkDigits({ format }, 'bowl', b, bowled), null, `AI bowler broke a rule: ${b} after ${bowled}`);
    const bt = chooseNumbers({ state: st, role: 'bat', need: 6 - bowled.length, aiTeam: 'B', level, rand });
    assert.equal(checkDigits({ format }, 'bat', bt), null, `AI batter broke a rule: ${bt}`);
  }
}
// Dot-over requirement: the AI batter never blocks (0) on the two balls it must score off.
for (let k = 0; k < 400; k++) {
  const st = fakeState('test', [], { requirements: [{ batterId: 's', status: 'active', ballsLeft: 2, startsNextOver: false }] });
  const seq = chooseNumbers({ state: st, role: 'bat', need: 6, aiTeam: 'B', level: ['easy', 'medium', 'hard', 'expert'][k % 4], rand });
  assert.notEqual(seq[0], 0); assert.notEqual(seq[1], 0);
}

// ===== 3. Player v AI with real teams: India v Australia =====
const hum = await client('Lehan');
await assert.rejects(api('/api/matches', { realTeams: { A: 'int-ind', B: 'int-aus' }, config: { participation: 'team', teamSource: 'real' } }, hum.token), /only available in one-v-one/);
await assert.rejects(api('/api/matches', { realTeams: { A: 'int-ind', B: 'int-ind' }, config: { participation: 'ai', teamSource: 'real' } }, hum.token), /same team/);
const m1 = (await api('/api/matches', { realTeams: { A: 'int-ind', B: 'int-aus' }, config: { participation: 'ai', teamSource: 'real', aiLevel: 'hard', overs: 2, wickets: 3, mode: 'umpire' } }, hum.token)).id;
await hum.open(m1);
let st = await until(() => hum.last()?.lineups?.B.confirmedAt && hum.last(), 'AI confirms its lineup');
assert.equal(st.mode, 'auto', 'no umpire against the AI');
assert.equal(st.teams.A.name, 'India'); assert.equal(st.teams.B.name, 'Australia');
assert.equal(st.teamMeta.A.teamId, 'int-ind'); assert.equal(st.teamMeta.B.squad.length, 15, 'squad snapshot saved with the match');
assert.equal(st.teams.A.players.length, 11); assert.equal(st.teams.B.players.length, 11);
assert.equal(st.captains.A, hum.user.id); assert.ok(st.members.find((x) => x.id === st.captains.B).bot);
// Pick a different XI, then confirm.
const pool = st.teamMeta.A.squad.map((p) => p.playerId);
await hum.bad('captain', { action: { type: 'select_xi', team: 'A', playerIds: pool.slice(0, 5) } }, /exactly 11/);
await hum.bad('captain', { action: { type: 'select_xi', team: 'B', playerIds: pool.slice(0, 11) } }, /captain/);
await hum.ok('captain', { action: { type: 'select_xi', team: 'A', playerIds: pool.slice(4, 15) } });
await hum.ok('lineup:confirm', { team: 'A' });
// Toss: the AI calls or decides on its own.
st = await until(() => { const s = hum.last(); return (s.stage === 'toss_call' && s.captains[s.toss.caller] === hum.user.id) || s.stage === 'toss_decision' || s.status === 'live' ? s : null; }, 'toss');
if (st.stage === 'toss_call') { await hum.ok('toss:call', { call: 'heads' }); st = await until(() => (hum.last().stage !== 'toss_call' ? hum.last() : null), 'toss result'); }
if (st.stage === 'toss_decision' && st.captains[st.toss.winner] === hum.user.id) await hum.ok('toss:decide', { decision: 'bat' });
st = await until(() => (hum.last().status === 'live' ? hum.last() : null), 'match live');
// Play: whenever it's my players' turn, submit; the AI does its own.
const mine = (s, pid) => s.members.find((x) => x.id === pid)?.controller === hum.user.id;
let safety = 0;
while (hum.last().status !== 'completed' && safety++ < 200) {
  const s = hum.last(), cur = s.current;
  const bowlerId = cur.open ? cur.set.bowlerId : cur.bowlerId, batterId = cur.open ? cur.set.batterId : cur.strikerId;
  const priv = hum.privates[hum.privates.length - 1];
  if (s.status === 'live' && !priv?.myLocked && (mine(s, bowlerId) || mine(s, batterId))) {
    const role = mine(s, bowlerId) ? 'bowl' : 'bat';
    const seq = role === 'bowl' ? [1, 2, 3, 4, 5, 6].filter((d, i, a) => true).slice(0, cur.cap) : Array(cur.cap).fill(4);
    const r = await hum.emit('over:submit', { sequence: seq });
    assert.ok(r.ok || /already locked/.test(r.error), r.error);
  }
  await wait(40);
}
st = hum.last();
assert.equal(st.status, 'completed', 'the match against the AI finishes');
assert.ok(st.innings[0].balls > 0 && st.innings[1].balls > 0);
const lb = await api('/api/leaderboard?sort=runs');
assert.ok(!lb.rows.some((r) => /Test Player|AI/.test(r.name)), 'roster players and the AI stay off the leaderboard');
const prof = await api(`/api/users/${hum.user.id}`);
assert.equal(prof.record.matches, 1, 'the human gets the result on their profile');

// ===== 4. Player v Player with IPL teams =====
const p1 = await client('Ravi'), p2 = await client('Sam'), watcher = await client('Fan');
const m2 = (await api('/api/matches', { realTeams: { A: 'ipl-mi', B: 'ipl-csk' }, config: { participation: 'pvp', teamSource: 'real', overs: 1, wickets: 2, xiSize: 4 } }, p1.token)).id;
for (const c of [p1, p2, watcher]) await c.open(m2);
await wait(60);
st = p2.last() || (await p2.emit('match:open', { matchId: m2 })).state;
assert.equal(st.teams.A.players.length, 4, 'XI size setting respected');
assert.equal(st.teams.B.controller, null, 'second seat open');
await watcher.bad('lineup:confirm', { team: 'B' }, /captain/);
await p2.ok('team:join', { team: 'B' });
await watcher.bad('team:join', { team: 'B' }, /already has a player/);
await p1.ok('lineup:confirm', { team: 'A' }); await p2.ok('lineup:confirm', { team: 'B' });
await wait(60);
st = watcher.last();
const caller = [p1, p2].find((c) => c.user.id === st.captains[st.toss.caller]);
await caller.ok('toss:call', { call: 'tails' }); await wait(60);
st = watcher.last();
await [p1, p2].find((c) => c.user.id === st.captains[st.toss.winner]).ok('toss:decide', { decision: 'bat' });
await wait(60);
st = watcher.last();
assert.equal(st.status, 'live');
const ctl = (pid) => [p1, p2].find((c) => c.user.id === st.members.find((x) => x.id === pid).controller);
await watcher.bad('over:submit', { sequence: [1, 2, 3, 4, 5, 6] }, /isn't your turn/);
await ctl(st.current.bowlerId).ok('over:submit', { sequence: [1, 1, 2, 2, 3, 3] });
await wait(40);
assert.equal(watcher.last().current.set.reveal, null);
assert.equal(ctl(st.current.strikerId).privates.at(-1).myLocked, undefined, 'opponent cannot see the bowler\'s picks');
await ctl(st.current.strikerId).ok('over:submit', { sequence: [6, 6, 6, 6, 6, 6] });
await wait(60);
assert.equal(watcher.last().innings[0].runs, 36);
assert.equal(watcher.last().teamMeta.A.name, 'Mumbai Indians');

// ===== 5. Custom 1v1 against the AI still works =====
const solo = await client('Solo');
const m3 = (await api('/api/matches', { teamA: 'Mine', teamB: 'Bots', config: { participation: 'ai', aiLevel: 'easy', overs: 1, wickets: 1, play: 'ball' } }, solo.token)).id;
await solo.open(m3);
st = await until(() => solo.last()?.lineups?.B.confirmedAt && solo.last(), 'custom AI confirms');
assert.equal(st.teams.A.players[0].id, solo.user.id); assert.ok(st.teams.B.players[0].bot);

console.log('✔ all AI and real-team tests passed');
for (const c of [hum, p1, p2, watcher, solo]) c.s.disconnect();
server.close(); mock.close(); process.exit(0);
