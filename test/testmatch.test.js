// Test match format: sessions, suspend/resume, digit rules, dot-over rule, declarations, follow-on, results.
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
process.env.PORT = '0';
const { server } = await import('../server/index.js');
const { io } = await import('socket.io-client');
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
const base = `http://localhost:${server.address().port}`;

const api = async (path, body, token) => {
  const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
};
async function client(name) {
  const { token, user } = await api('/api/auth/guest', { name });
  const s = io(base, { auth: { token }, transports: ['websocket'] });
  const c = { name, token, user, s, states: [], privates: [], notes: [] };
  s.on('state', (x) => c.states.push(x)); s.on('private', (x) => c.privates.push(x)); s.on('notify', (x) => c.notes.push(x));
  c.emit = (ev, payload) => new Promise((r) => s.emit(ev, { matchId: c.matchId, ...payload }, r));
  c.ok = async (ev, payload) => { const r = await c.emit(ev, payload); assert.ok(r.ok, `${name} ${ev}: ${r.error}`); return r; };
  c.bad = async (ev, payload, re) => { const r = await c.emit(ev, payload); assert.equal(r.ok, false, `${name} ${ev} should fail`); if (re) assert.match(r.error, re); return r; };
  c.open = async (matchId) => { c.matchId = matchId; return c.ok('match:open', { matchId }); };
  c.last = () => c.states[c.states.length - 1];
  return c;
}
const settle = () => new Promise((r) => setTimeout(r, 40));
const id = (c) => c.user.id;

const host = await client('Host'), ali = await client('Ali'), chen = await client('Chen'), bilal = await client('Bilal'), dev = await client('Dev'), fan = await client('Fan');
const ump = await client('Umpire');
const byId = Object.fromEntries([host, ali, chen, bilal, dev, fan, ump].map((c) => [id(c), c]));
const bowler = () => byId[fan.last().current.bowlerId];
const batter = () => byId[fan.last().current.strikerId];
const T = (action) => ({ action });

// Join, confirm, toss; the toss winner chooses `decision`. Returns which team bats first.
async function setup(creator, config, teams, decision = 'bat') {
  const mid = (await api('/api/matches', { teamA: 'Lions', teamB: 'Tigers', config }, creator.token)).id;
  for (const c of [creator, ...teams.A, ...teams.B, fan]) await c.open(mid);
  for (const t of ['A', 'B']) for (const c of teams[t]) await c.ok('team:join', { team: t });
  await teams.A[0].ok('lineup:confirm', { team: 'A' }); await teams.B[0].ok('lineup:confirm', { team: 'B' });
  await settle();
  let st = fan.last();
  await byId[st.captains[st.toss.caller]].ok('toss:call', { call: 'heads' });
  await settle(); st = fan.last();
  await byId[st.captains[st.toss.winner]].ok('toss:decide', { decision });
  await settle();
  return { mid, batFirst: decision === 'bat' ? fan.last().toss.winner : (fan.last().toss.winner === 'A' ? 'B' : 'A') };
}

// ===== 1. No umpire, complete over: sessions, suspend/resume, dot-over rule, declaration, chase =====
const t1 = await setup(host, { format: 'test', mode: 'auto', play: 'over', days: 2, sessionsPerDay: 2, oversPerSession: 1, wickets: 3 },
  { A: [ali, chen], B: [bilal, dev] });
let st = fan.last();
assert.equal(st.format, 'test'); assert.equal(st.status, 'live');
assert.equal(st.test.day, 1); assert.equal(st.test.session, 1); assert.equal(st.test.sessionBallsLeft, 6);
assert.equal(st.innings[0].batting, t1.batFirst);
const batCap = byId[st.captains[t1.batFirst]];

// Test digit rules: batter 0,1,2,3,4,6 (no 5); bowler 1,2,3,4,6 (no 0 or 5); no repetition limit.
await batter().bad('over:submit', { sequence: [5, 0, 0, 0, 0, 0] }, /5 isn't allowed/);
await bowler().bad('over:submit', { sequence: [0, 6, 6, 6, 6, 6] }, /0 isn't allowed/);
await bowler().bad('over:submit', { sequence: [5, 6, 6, 6, 6, 6] }, /5 isn't allowed/);
const b1 = bowler(), firstBat = batter();
await b1.ok('over:submit', { sequence: [6, 6, 6, 6, 6, 6] }); // fine in a Test: no repetition limit
await firstBat.ok('over:submit', { sequence: [0, 0, 0, 0, 0, 0] }); // a dot over
await settle();
st = fan.last();
assert.equal(st.innings[0].runs, 0); assert.equal(st.innings[0].balls, 6);
// Session 1 is 1 over: it ends, but the innings does not.
assert.equal(st.status, 'session_break'); assert.equal(st.innings[0].status, 'live');
assert.equal(st.test.requirements.length, 1); assert.equal(st.test.requirements[0].batterId, id(firstBat));
assert.equal(st.test.requirements[0].ballsLeft, 2);
assert.ok(st.test.sessions[0].endedAt); assert.equal(st.test.sessions[0].balls, 6);
await firstBat.bad('over:submit', { sequence: [1, 1, 1, 1, 1, 1] }, /break/);

// Suspend during the break, resume: nothing advances by itself and the requirement survives.
await batCap.bad('test', T({ type: 'suspend' }), /host/);
await host.ok('test', T({ type: 'suspend', reason: 'Dinner' }));
await settle();
assert.equal(fan.last().status, 'suspended');
await host.bad('test', T({ type: 'next_session' }), /no break/);
await host.ok('test', T({ type: 'resume' }));
await settle();
st = fan.last();
assert.equal(st.status, 'session_break', 'resume restores the exact state: still at the break');
assert.equal(st.test.requirements.length, 1, 'requirement survives suspension');
assert.equal(st.test.suspensions.length, 1);

await batCap.ok('test', T({ type: 'next_session' })); // no umpire: a captain can restart play
await settle();
st = fan.last();
assert.equal(st.status, 'live'); assert.equal(st.test.day, 1); assert.equal(st.test.session, 2);
assert.equal(st.current.strikerId, id(firstBat), 'same batter carries on');
// Over 2: two dot balls to start, so the dot-over rule puts the batter out (no umpire).
await bowler().ok('over:submit', { sequence: [1, 1, 1, 1, 1, 1] });
await firstBat.ok('over:submit', { sequence: [0, 0, 6, 6, 6, 6] });
await settle();
st = fan.last();
assert.equal(st.innings[0].wickets, 1); assert.equal(st.innings[0].balls, 8);
assert.equal(st.test.requirements.length, 0);
assert.equal(st.innings[0].card.bowling.find((b) => b.wickets !== undefined).wickets, 0, 'rule dismissals are not credited to the bowler');
assert.notEqual(st.current.strikerId, id(firstBat));
assert.equal(st.current.cap, 4, 'new batter finishes the over: 4 balls');
await bowler().ok('over:submit', { sequence: [2, 2, 2, 2] });
await batter().ok('over:submit', { sequence: [1, 1, 1, 1] });
await settle();
st = fan.last();
assert.equal(st.innings[0].runs, 4);
assert.equal(st.status, 'day_break', 'last session of day 1: stumps');
assert.equal(st.test.daySummaries[0].runs, 4); assert.equal(st.test.days, 2);
await batCap.ok('test', T({ type: 'next_session' }));
await settle();
st = fan.last();
assert.equal(st.test.day, 2); assert.equal(st.test.session, 1); assert.equal(st.status, 'live');

// Declaration ends the innings (not the session).
await byId[st.captains[t1.batFirst === 'A' ? 'B' : 'A']].bad('test', T({ type: 'declare' }), /captain/);
await batCap.ok('test', T({ type: 'declare' }));
await settle();
st = fan.last();
assert.equal(st.innings.length, 2); assert.equal(st.status, 'live');
// Second innings: three quick wickets (all out for 0).
for (let k = 0; k < 3; k++) { await bowler().ok('over:submit', { sequence: Array(fan.last().current.cap).fill(1) }); await batter().ok('over:submit', { sequence: Array(fan.last().current.cap).fill(1) }); await settle(); }
st = fan.last();
assert.equal(st.innings.length, 3, 'third innings starts automatically');
assert.equal(st.test.situation.includes('lead by 4'), true);
await batCap.ok('test', T({ type: 'declare' }));
await settle();
st = fan.last();
assert.equal(st.innings[3].target, 5);
await bowler().ok('over:submit', { sequence: [1, 1, 1] });
await batter().ok('over:submit', { sequence: [6, 6, 6] });
await settle();
st = fan.last();
assert.equal(st.status, 'completed'); assert.match(st.result.text, /won by 3 wickets/);

// ===== 2. With umpire, ball by ball: the umpire rules on a broken dot-over requirement; time runs out → draw =====
const t2 = await setup(ump, { format: 'test', mode: 'umpire', play: 'ball', days: 1, sessionsPerDay: 1, oversPerSession: 2, wickets: 2, inningsPerTeam: 1 },
  { A: [ali], B: [bilal] });
assert.equal(fan.last().stage, 'ready_to_start');
await ump.ok('match:start');
await settle();
for (let k = 0; k < 6; k++) { await bowler().ok('over:submit', { sequence: [6] }); await batter().ok('over:submit', { sequence: [0] }); }
await settle();
st = fan.last();
assert.equal(st.test.requirements.length, 1);
assert.ok(ump.notes.some((n) => /Scoring requirement/.test(n.title)), 'umpire told about the requirement');
await bowler().ok('over:submit', { sequence: [4] }); await batter().ok('over:submit', { sequence: [0] });
await settle();
assert.equal(fan.last().test.requirements[0].ballsLeft, 1, 'countdown is by legal balls');
await bowler().ok('over:submit', { sequence: [4] }); await batter().ok('over:submit', { sequence: [0] });
await settle();
st = fan.last();
assert.equal(st.test.requirements[0].status, 'pending');
await bowler().bad('over:submit', { sequence: [4] }, /umpire to rule/);
await ali.bad('test', T({ type: 'rule', decision: 'waive' }), /umpire/);
await ump.ok('test', T({ type: 'rule', decision: 'waive' }));
for (let k = 0; k < 4; k++) { await bowler().ok('over:submit', { sequence: [1] }); await batter().ok('over:submit', { sequence: [6] }); }
await settle();
st = fan.last();
assert.equal(st.innings[0].runs, 24);
assert.equal(st.status, 'completed'); assert.equal(st.result.draw, true, 'scheduled time over: draw');

// ===== 3. Follow-on and an innings victory =====
const t3 = await setup(host, { format: 'test', mode: 'auto', play: 'over', days: 1, sessionsPerDay: 1, oversPerSession: 30, wickets: 1 },
  { A: [ali], B: [bilal] });
const first = t3.batFirst, second = first === 'A' ? 'B' : 'A';
for (let o = 0; o < 3; o++) { await bowler().ok('over:submit', { sequence: [1, 1, 1, 1, 1, 1] }); await batter().ok('over:submit', { sequence: [6, 6, 6, 6, 6, 6] }); await settle(); }
await byId[fan.last().captains[first]].ok('test', T({ type: 'declare' }));
await settle();
await bowler().ok('over:submit', { sequence: [2, 2, 2, 2, 2, 2] }); await batter().ok('over:submit', { sequence: [2, 2, 2, 2, 2, 2] });
await settle();
st = fan.last();
assert.equal(st.status, 'innings_break'); assert.equal(st.test.followOn.team, first); assert.equal(st.test.followOn.lead, 108);
await byId[st.captains[second]].bad('test', T({ type: 'follow_on', enforce: true }), /captain decides/);
await byId[st.captains[first]].ok('test', T({ type: 'follow_on', enforce: true }));
await settle();
st = fan.last();
assert.equal(st.innings[2].batting, second, 'follow-on: same side bats again');
await bowler().ok('over:submit', { sequence: [3, 3, 3, 3, 3, 3] }); await batter().ok('over:submit', { sequence: [3, 3, 3, 3, 3, 3] });
await settle();
st = fan.last();
assert.match(st.result.text, /won by an innings and 108 runs/);

// Limited overs untouched: a T20 is 20 overs.
const lim = (await api('/api/matches', { config: { format: 't20' } }, host.token)).id;
await host.open(lim);
const r = await host.emit('match:open', { matchId: lim });
assert.equal(r.state.config.overs, 20); assert.equal(r.state.test, null);

console.log('✔ all Test match tests passed');
for (const c of Object.values(byId)) c.s.disconnect();
server.close(); process.exit(0);
