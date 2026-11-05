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
  s.on('state', (x) => c.states.push(x));
  s.on('private', (x) => c.privates.push(x));
  s.on('chat', (x) => c.chats.push(x));
  s.on('notify', (x) => c.notes.push(x));
  s.on('fx', (x) => c.fx.push(x));
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

// ====== Match 1: no umpire, captains run their lineups ======
const host = await client('Host Hana');
const ali = await client('Ali'), chen = await client('Chen');   // Lions
const bilal = await client('Bilal'), dev = await client('Dev'); // Tigers
const fan = await client('Fan');
const all5 = [host, ali, chen, bilal, dev, fan];

const m1 = (await api('/api/matches', { teamA: 'Lions', teamB: 'Tigers', config: { mode: 'auto', overs: 2, wickets: 2 } }, host.token)).id;
for (const c of all5) await c.open(m1);
await ali.ok('team:join', { team: 'A' }); await chen.ok('team:join', { team: 'A' });
await bilal.ok('team:join', { team: 'B' }); await dev.ok('team:join', { team: 'B' });
await settle();
let st = fan.last();
assert.equal(st.mode, 'auto'); assert.equal(st.umpire, null);
assert.equal(st.captains.A, id(ali), 'first to join captains'); assert.equal(st.captains.B, id(bilal));

// Captain powers are enforced on the server.
await chen.bad('captain', { action: { type: 'bat_order', team: 'A', userIds: [id(chen), id(ali)] } }, /captain/);
await bilal.bad('captain', { action: { type: 'bat_order', team: 'A', userIds: [id(chen), id(ali)] } }, /captain/);
await host.bad('umpire', { action: { type: 'pause' } }, /no umpire/);
await ali.ok('captain', { action: { type: 'bat_order', team: 'A', userIds: [id(chen), id(ali)] } });
await bilal.ok('captain', { action: { type: 'bowl_order', team: 'B', userIds: [id(dev), id(bilal)] } });
await fan.bad('match:start', {}, /host or a captain/);
await bilal.ok('match:start');
await settle();
st = fan.last();
assert.equal(st.current.strikerId, id(chen), 'captain chose the opener');
assert.equal(st.current.bowlerId, id(dev), 'captain chose the first bowler');
assert.ok(chen.notes.some((n) => n.kind === 'bat') && dev.notes.some((n) => n.kind === 'bowl'), 'both notified');

// Simultaneous submission: the brief's example. Bowler 423336, batter 542236.
await ali.bad('over:submit', { sequence: [1, 1, 1, 1, 1, 1] }, /isn't your over/);
await dev.bad('over:submit', { sequence: [1, 2, 3] }, /six numbers/);
await dev.bad('over:submit', { sequence: [1, 2, 3, 4, 5, 7] }, /six numbers/);
await dev.ok('over:submit', { sequence: [4, 2, 3, 3, 3, 6] });
await dev.bad('over:submit', { sequence: [1, 1, 1, 1, 1, 1] }, /already locked/);
await settle();
st = fan.last();
assert.equal(st.current.set.bowlerLocked, true); assert.equal(st.current.set.batterLocked, false);
assert.equal(st.current.set.reveal, null);
assert.deepEqual(dev.priv().myLocked, [4, 2, 3, 3, 3, 6]);
for (const c of [chen, fan, host, ali, bilal]) assert.equal(c.priv().myLocked, undefined, `${c.name} must not see the bowler's six`);
assert.equal(host.priv().bowlerSequence, undefined, 'no umpire, nobody else sees it');
assert.ok(chen.notes.some((n) => /locked in/.test(n.title)), 'batter told the bowler is locked in');
await bilal.bad('captain', { action: { type: 'next_bowler', team: 'B', userId: id(bilal) } }, /already started/);
await chen.ok('over:submit', { sequence: [5, 4, 2, 2, 3, 6] });
await settle();
st = fan.last();
assert.equal(st.innings[0].runs, 13); assert.equal(st.innings[0].wickets, 1); assert.equal(st.innings[0].balls, 5);
assert.equal(st.current.set.reveal.seq, '423336'); assert.equal(st.current.set.reveal.batSeq, '542236');
assert.deepEqual(st.current.set.balls.map((b) => b.runs), [5, 4, 2, 2, 0]);
assert.ok(fan.fx.some((f) => f.type === 'reveal' && f.wicket && f.balls.length === 5));
// Wicket ends the over: next batter from the captain's order, and Dev can't bowl twice in a row.
assert.equal(st.current.strikerId, id(ali)); assert.equal(st.current.bowlerId, id(bilal));
await bilal.bad('captain', { action: { type: 'next_bowler', team: 'B', userId: id(dev) } }, /two in a row/);

// Captain can change the incoming batter before they start.
await ali.ok('captain', { action: { type: 'next_batter', team: 'A', userId: id(chen) } });
await ali.ok('captain', { action: { type: 'next_batter', team: 'A', userId: id(ali) } });

// This time the batter locks in first.
await ali.ok('over:submit', { sequence: [1, 1, 1, 1, 1, 1] });
await settle();
assert.equal(bilal.priv().myLocked, undefined, 'bowler cannot see the batter');
assert.equal(fan.last().current.set.reveal, null);
await ali.bad('captain', { action: { type: 'next_batter', team: 'A', userId: id(chen) } }, /already started/);
await bilal.ok('over:submit', { sequence: [2, 2, 2, 2, 2, 2] });
await settle();
st = fan.last();
assert.equal(st.innings[0].runs, 19); assert.equal(st.innings[0].balls, 11);
assert.equal(st.current.bowlerId, id(dev)); assert.equal(st.current.cap, 1, 'only one ball left in the innings');
await dev.ok('over:submit', { sequence: [6, 6, 6, 6, 6, 6] });
await ali.ok('over:submit', { sequence: [5, 1, 1, 1, 1, 1] });
await settle();
st = fan.last();
// No umpire: the second innings starts by itself.
assert.equal(st.status, 'live'); assert.equal(st.current.number, 2);
assert.equal(st.innings[1].target, 25);
assert.equal(st.current.strikerId, id(bilal)); assert.equal(st.current.bowlerId, id(ali));
await ali.ok('over:submit', { sequence: [1, 1, 1, 1, 1, 1] });
await bilal.ok('over:submit', { sequence: [6, 6, 6, 6, 6, 6] });
await settle();
st = fan.last();
assert.equal(st.status, 'completed');
assert.equal(st.innings[1].balls, 5, 'chase stops the moment the target is passed');
assert.match(st.result.text, /Tigers won by 2 wickets/);
assert.ok(st.history.some((h) => /Lions batting order: Chen, Ali/.test(h.text)), 'lineup change in match history');

for (const c of all5) for (const s of c.states) {
  const set = s.current?.set;
  if (set && set.status === 'open') assert.equal(set.reveal, null, `${c.name} saw an open over`);
}
const pc = await api(`/api/users/${id(chen)}`);
assert.equal(pc.batting.runs, 13); assert.equal(pc.batting.outs, 1); assert.equal(pc.record.losses, 1);
const pd = await api(`/api/users/${id(dev)}`);
assert.equal(pd.bowling.wickets, 1); assert.equal(pd.record.wins, 1);

// Team selection: reuse both squads from a previous match.
const m3 = (await api('/api/matches', { copyFrom: m1, config: { mode: 'auto' } }, host.token)).id;
await host.open(m3); await settle();
const r3 = await host.emit('match:open', { matchId: m3 });
assert.deepEqual(r3.state.teams.A.players.map((p) => p.name), ['Chen', 'Ali']);
assert.equal(r3.state.captains.B, id(bilal));
await assert.rejects(api('/api/matches', { copyFrom: m1 }, (await api('/api/auth/guest', { name: 'Stranger' })).token), /only reuse/);

// ====== Match 2: with an umpire ======
const ump = await client('Umpire Uma');
const m2 = (await api('/api/matches', { config: { mode: 'umpire', overs: 1, wickets: 1, spectators: 'watch' } }, ump.token)).id;
for (const c of [ump, ali, bilal, fan]) await c.open(m2);
await ump.ok('umpire', { action: { type: 'assign', userId: id(ali), team: 'A' } });
await ump.ok('umpire', { action: { type: 'assign', userId: id(bilal), team: 'B' } });
await ali.bad('match:start', {}, /umpire/);
await ump.ok('match:start');
await bilal.ok('over:submit', { sequence: [2, 2, 2, 2, 2, 2] });
await settle();
assert.deepEqual(ump.priv().bowlerSequence, [2, 2, 2, 2, 2, 2], 'umpire privately verifies the bowler');
assert.equal(fan.priv().bowlerSequence, undefined); assert.equal(ali.priv().bowlerSequence, undefined);
await ali.ok('over:submit', { sequence: [5, 5, 2, 1, 1, 1] });
await settle();
assert.equal(fan.last().innings[0].runs, 10);
assert.equal(fan.last().status, 'innings_break', 'with an umpire, the umpire starts the next innings');
await ump.ok('umpire', { action: { type: 'void', reason: 'Batter misclicked' } });
await settle();
assert.equal(fan.last().innings[0].runs, 0); assert.equal(fan.last().status, 'live');
assert.equal(fan.last().current.open, false, 'both lock in again');
await ump.ok('umpire', { action: { type: 'pause' } });
await bilal.bad('over:submit', { sequence: [1, 1, 1, 1, 1, 1] }, /paused/);
await ump.ok('umpire', { action: { type: 'resume' } });

// Chat: private bowler-umpire line; watch-only spectators.
await bilal.ok('chat:send', { channel: `pvt:${id(bilal)}`, text: 'Ready' });
await fan.bad('chat:send', { text: 'hi' }, /watch but not chat/);
await ali.ok('chat:send', { text: 'Come on Lions' });
await settle();
assert.ok(ump.chats.some((m) => m.text === 'Ready')); assert.ok(!fan.chats.some((m) => m.text === 'Ready'));

// Reconnection keeps a locked-in six.
await bilal.ok('over:submit', { sequence: [3, 3, 3, 3, 3, 3] });
bilal.s.disconnect();
const s2 = io(base, { auth: { token: bilal.token }, transports: ['websocket'] });
const back = await new Promise((r) => s2.emit('match:open', { matchId: m2 }, r));
assert.deepEqual(back.private.myLocked, [3, 3, 3, 3, 3, 3]);
s2.disconnect();

console.log('✔ all match tests passed');
for (const c of [host, ali, chen, dev, fan, ump]) c.s.disconnect();
server.close(); process.exit(0);
