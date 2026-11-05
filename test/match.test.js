// End-to-end tests: real server, real sockets, several clients. Run with `npm test`.
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
  const c = { name, token, user, s, states: [], privates: [], chats: [], notes: [], fx: [] };
  s.on('state', (x) => c.states.push(x)); s.on('private', (x) => c.privates.push(x));
  s.on('chat', (x) => c.chats.push(x)); s.on('notify', (x) => c.notes.push(x)); s.on('fx', (x) => c.fx.push(x));
  c.emit = (ev, payload) => new Promise((r) => s.emit(ev, { matchId: c.matchId, ...payload }, r));
  c.ok = async (ev, payload) => { const r = await c.emit(ev, payload); assert.ok(r.ok, `${name} ${ev}: ${r.error}`); return r; };
  c.bad = async (ev, payload, re) => { const r = await c.emit(ev, payload); assert.equal(r.ok, false, `${name} ${ev} should fail`); if (re) assert.match(r.error, re); return r; };
  c.open = async (matchId) => { c.matchId = matchId; return c.ok('match:open', { matchId }); };
  c.last = () => c.states[c.states.length - 1];
  c.priv = () => c.privates[c.privates.length - 1];
  return c;
}
const settle = () => new Promise((r) => setTimeout(r, 40));
const id = (c) => c.user.id;

// Runs the toss for whoever was picked to call, and returns the winning team.
async function doToss(watch, byId, decision) {
  await settle();
  const st = watch.last();
  assert.equal(st.stage, 'toss_call');
  const caller = byId[st.captains[st.toss.caller]];
  const other = Object.values(byId).find((c) => c !== caller && (id(c) === st.captains.A || id(c) === st.captains.B));
  await other.bad('toss:call', { call: 'heads' }, /calling this toss/);
  await caller.bad('toss:decide', { decision: 'bat' }, /hasn't happened/);
  await caller.ok('toss:call', { call: 'heads' });
  await caller.bad('toss:call', { call: 'tails' }, /already been called/);
  await settle();
  const t = watch.last().toss;
  assert.equal(t.call, 'heads'); assert.ok(['heads', 'tails'].includes(t.result));
  assert.equal(t.winner, t.result === 'heads' ? st.toss.caller : (st.toss.caller === 'A' ? 'B' : 'A'));
  assert.ok(watch.fx.some((f) => f.type === 'toss'));
  const winner = byId[watch.last().captains[t.winner]];
  const loser = winner === caller ? other : caller;
  await loser.bad('toss:decide', { decision: 'bat' }, /captain decides/);
  await winner.ok('toss:decide', { decision });
  await settle();
  return t.winner;
}

// ====== Match 1: no umpire, complete-over play ======
const host = await client('Host Hana');
const ali = await client('Ali'), chen = await client('Chen'), bilal = await client('Bilal'), dev = await client('Dev');
const fan = await client('Fan');
const byId = Object.fromEntries([host, ali, chen, bilal, dev, fan].map((c) => [id(c), c]));
const m1 = (await api('/api/matches', { teamA: 'Lions', teamB: 'Tigers', config: { mode: 'auto', play: 'over', overs: 2, wickets: 3 } }, host.token)).id;
for (const c of Object.values(byId)) await c.open(m1);
await ali.ok('team:join', { team: 'A' }); await chen.ok('team:join', { team: 'A' });
await bilal.ok('team:join', { team: 'B' }); await dev.ok('team:join', { team: 'B' });
await settle();
assert.equal(fan.last().stage, 'awaiting_lineups');
assert.equal(fan.last().play, 'over');

// Nothing can skip lineup confirmation.
await host.bad('match:start', {}, /confirm/);
await ali.bad('toss:call', { call: 'heads' }, /confirm/);
await chen.bad('lineup:confirm', { team: 'A' }, /captain/);
await bilal.bad('lineup:confirm', { team: 'A' }, /captain/);
await ali.ok('lineup:confirm', { team: 'A' });
await ali.bad('lineup:confirm', { team: 'A' }, /already confirmed/);
await settle();
assert.ok(fan.last().lineups.A.confirmedAt); assert.equal(fan.last().lineups.B.confirmedAt, null);
// Changing a confirmed lineup before the toss resets its confirmation.
await ali.ok('captain', { action: { type: 'bat_order', team: 'A', userIds: [id(chen), id(ali)] } });
await settle();
assert.equal(fan.last().lineups.A.confirmedAt, null, 'confirmation reset after a change');
assert.ok(fan.last().history.some((h) => /needs confirming again/.test(h.text)));
await ali.ok('lineup:confirm', { team: 'A' });
await bilal.ok('lineup:confirm', { team: 'B' });
const tossWinner = await doToss(fan, byId, 'bowl');
let st = fan.last();
// No umpire: the decision starts the match straight away.
assert.equal(st.status, 'live'); assert.equal(st.stage, 'live');
const batTeam = tossWinner === 'A' ? 'B' : 'A';
assert.equal(st.innings[0].batting, batTeam, 'winner chose to bowl, so the other side bats');
await fan.bad('team:join', { team: 'A' }, /locked/);
const batCap = byId[st.captains[batTeam]];
await batCap.bad('captain', { action: { type: 'add', team: batTeam, userId: id(fan) } }, /locked/);

// Over 1 needs six numbers.
const bowler = () => byId[fan.last().current.bowlerId];
const batter = () => byId[fan.last().current.strikerId];
assert.equal(st.current.cap, 6); assert.equal(st.current.ballsLeftInOver, 6);
const b1 = bowler();
await b1.bad('over:submit', { sequence: [4, 2, 3, 3, 3] }, /exactly 6/);
await b1.ok('over:submit', { sequence: [4, 2, 3, 3, 3, 6] });
const firstBatter = batter();
await firstBatter.ok('over:submit', { sequence: [5, 4, 2, 2, 3, 6] });
await settle();
st = fan.last();
assert.equal(st.innings[0].runs, 13); assert.equal(st.innings[0].wickets, 1); assert.equal(st.innings[0].balls, 5);
// The next batter finishes the same over: one ball left, so one number each, same bowler.
assert.equal(st.current.cap, 1); assert.equal(st.current.ballsLeftInOver, 1);
assert.equal(st.current.bowlerId, id(b1), 'the bowler finishes their over');
assert.notEqual(st.current.strikerId, id(firstBatter));
assert.equal(st.current.over.balls.length, 5); assert.equal(st.current.over.finished, false);
const batCapt = byId[st.captains[batTeam]];
await batCapt.bad('captain', { action: { type: 'next_batter', team: batTeam, userId: id(firstBatter) } }, /is out/);
await batter().bad('over:submit', { sequence: [1, 2, 3, 4, 5, 6] }, /exactly 1|one number/);
await b1.ok('over:submit', { sequence: [1] });
await batter().ok('over:submit', { sequence: [2] });
await settle();
st = fan.last();
assert.equal(st.innings[0].runs, 15); assert.equal(st.innings[0].balls, 6);
assert.equal(st.current.over.number, 1); assert.equal(st.current.over.finished, true, 'strip keeps showing the finished over');
assert.notEqual(st.current.bowlerId, id(b1), 'new over, new bowler');
assert.equal(st.current.cap, 6, 'back to six for a new over');
const bowlCap = byId[st.captains[tossWinner]];
await bowlCap.bad('captain', { action: { type: 'next_bowler', team: tossWinner, userId: id(b1) } }, /two in a row/);
// Limited-overs bowler limit: no number more than three times in an over.
for (const bad of [[6, 6, 5, 5, 5, 5], [1, 1, 1, 1, 2, 3], [5, 5, 5, 5, 1, 2]]) await bowler().bad('over:submit', { sequence: bad }, /at most 3 times/);
await bowler().bad('over:submit', { sequence: [0, 0, 0, 1, 2, 3] }, /isn't allowed/);
await bowler().ok('over:submit', { sequence: [5, 5, 5, 1, 2, 3] });
await batter().ok('over:submit', { sequence: [6, 6, 6, 6, 6, 6] });
await settle();
st = fan.last();
assert.equal(st.current.number, 2, 'second innings starts by itself');
assert.equal(st.innings[0].runs, 51); assert.equal(st.innings[1].target, 52);
// Second innings: three quick wickets; each new batter needs one fewer number.
for (const want of [6, 5, 4]) {
  assert.equal(fan.last().current.cap, want);
  await bowler().ok('over:submit', { sequence: [1, 2, 2, 3, 3, 4].slice(0, want) });
  await batter().ok('over:submit', { sequence: Array(want).fill(1) });
  await settle();
}
st = fan.last();
assert.equal(st.status, 'completed');
assert.match(st.result.text, /won by 51 runs/);
for (const c of Object.values(byId)) for (const s of c.states) {
  const set = s.current?.set;
  if (set && set.status === 'open') assert.equal(set.reveal, null, `${c.name} saw hidden numbers`);
}

// ====== Match 2: with umpire, ball-by-ball ======
const ump = await client('Umpire Uma');
byId[id(ump)] = ump;
const m2 = (await api('/api/matches', { config: { mode: 'umpire', play: 'ball', overs: 1, wickets: 1 } }, ump.token)).id;
for (const c of [ump, ali, bilal, fan]) await c.open(m2);
await ali.ok('team:join', { team: 'A' }); await bilal.ok('team:join', { team: 'B' });
await ali.ok('lineup:confirm', { team: 'A' }); await bilal.ok('lineup:confirm', { team: 'B' });
const w2 = await doToss(fan, byId, 'bat');
assert.equal(fan.last().stage, 'ready_to_start', 'with an umpire, the umpire starts after the toss');
await ali.bad('match:start', {}, /umpire/);
await ump.ok('match:start');
await settle();
st = fan.last();
assert.equal(st.innings[0].batting, w2);
assert.equal(st.current.cap, 1);
await bowler().bad('over:submit', { sequence: [1, 2] }, /one number/);
await bowler().ok('over:submit', { sequence: [3] });
await settle();
assert.deepEqual(ump.priv().bowlerSequence, [3]);
assert.equal(fan.last().current.set.reveal, null);
await bowler().bad('over:submit', { sequence: [4] }, /already locked/);
await batter().ok('over:submit', { sequence: [4] });
await settle();
st = fan.last();
assert.equal(st.innings[0].runs, 4); assert.equal(st.current.ballsLeftInOver, 5); assert.equal(st.current.over.balls.length, 1);
for (let k = 0; k < 3; k++) { await bowler().ok('over:submit', { sequence: [1] }); await batter().ok('over:submit', { sequence: [2] }); }
// Ball by ball, the limit is tracked across the over: a fourth 1 is refused.
await bowler().bad('over:submit', { sequence: [1] }, /at most 3 times.*3 already bowled/);
await bowler().ok('over:submit', { sequence: [4] }); await batter().ok('over:submit', { sequence: [2] });
await settle();
assert.equal(fan.last().current.ballsLeftInOver, 1);
await ump.ok('umpire', { action: { type: 'void', reason: 'Test correction' } });
await settle();
assert.equal(fan.last().innings[0].runs, 10, 'void removes one ball in ball-by-ball mode');
assert.equal(fan.last().current.ballsLeftInOver, 2);
await bowler().ok('over:submit', { sequence: [5] }); await batter().ok('over:submit', { sequence: [5] });
await settle();
assert.equal(fan.last().status, 'innings_break', 'all out (1 wicket)');
await ump.ok('match:nextInnings');
await settle();
for (let k = 0; k < 2; k++) { await bowler().ok('over:submit', { sequence: [1] }); await batter().ok('over:submit', { sequence: [6] }); await settle(); }
await settle();
st = fan.last();
assert.equal(st.status, 'completed'); assert.match(st.result.text, /won by 1 wicket/);
const profile = await api(`/api/users/${id(ali)}`);
assert.ok(profile.record.matches >= 2, 'stats still saved');

console.log('✔ all match tests passed');
for (const c of Object.values(byId)) c.s.disconnect();
server.close(); process.exit(0);
