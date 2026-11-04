// End-to-end test: real server, real sockets, four clients. Run with `npm test`.
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
  const c = { name, token, user, s, states: [], privates: [], chats: [], notes: [] };
  s.on('state', (x) => c.states.push(x));
  s.on('private', (x) => c.privates.push(x));
  s.on('chat', (x) => c.chats.push(x));
  s.on('notify', (x) => c.notes.push(x));
  c.emit = (ev, payload) => new Promise((r) => s.emit(ev, { matchId: c.matchId, ...payload }, r));
  c.ok = async (ev, payload) => { const r = await c.emit(ev, payload); assert.ok(r.ok, `${name} ${ev}: ${r.error}`); return r; };
  c.bad = async (ev, payload, re) => { const r = await c.emit(ev, payload); assert.equal(r.ok, false, `${name} ${ev} should fail`); if (re) assert.match(r.error, re); return r; };
  c.open = async (matchId) => { c.matchId = matchId; const r = await c.ok('match:open', { matchId }); c.state = r.state; return r; };
  c.last = () => c.states[c.states.length - 1];
  return c;
}
const settle = () => new Promise((r) => setTimeout(r, 40));

const ump = await client('Umpire Uma');
const ali = await client('Ali');      // Team A batter
const bilal = await client('Bilal');  // Team B bowler
const fan = await client('Fan Farah');

const { id } = await api('/api/matches', { name: 'Test Final', teamA: 'Lions', teamB: 'Tigers', config: { overs: 2, wickets: 2, superOver: true } }, ump.token);
for (const c of [ump, ali, bilal, fan]) await c.open(id);
await ump.ok('umpire', { action: { type: 'assign', userId: ali.user.id, team: 'A' } });
await ump.ok('umpire', { action: { type: 'assign', userId: bilal.user.id, team: 'B' } });
await fan.bad('match:start', {}, /umpire/);
await ump.ok('match:start');
await settle();
assert.equal(fan.last().current.phase, 'awaiting_sequence');
assert.ok(bilal.notes.some((n) => n.kind === 'bowl'), 'bowler notified');

// Only the bowler may seal, exactly six numbers 1-6, once.
await ali.bad('bowler:submit', { sequence: [1, 2, 3, 4, 5, 6] }, /not the bowler/);
await bilal.bad('bowler:submit', { sequence: [1, 2, 3] }, /six numbers/);
await bilal.ok('bowler:submit', { sequence: [3, 4, 4, 2, 1, 6] });
await bilal.bad('bowler:submit', { sequence: [1, 1, 1, 1, 1, 1] }, /already sealed/);
await settle();
assert.ok(ali.notes.some((n) => n.kind === 'bat'), 'batter notified');
assert.deepEqual(bilal.privates.at(-1).mySequence, [3, 4, 4, 2, 1, 6]);
for (const c of [ali, fan, ump]) assert.equal(c.privates.at(-1).mySequence, undefined, `${c.name} must not see sequence`);
assert.equal(fan.last().current.set.reveal, null);

// The brief's worked example: 5 6 6 3 1 vs 3 4 4 2 1 → 20 runs, out on ball 5.
for (const [i, n] of [5, 6, 6, 3, 1].entries()) await ali.ok('batter:play', { number: n, ballNo: i + 1 });
await ali.bad('batter:play', { number: 2, ballNo: 5 }); // duplicate / stale ball
await fan.bad('batter:play', { number: 2, ballNo: 6 }, /bowler|turn/);
await settle();
let inn = fan.last().innings[0];
assert.equal(inn.runs, 20); assert.equal(inn.wickets, 1); assert.equal(inn.balls, 5);
assert.equal(fan.last().current.set.reveal.seq, '344216', 'sequence revealed once over closed');

// Fresh six-ball set for the new batter (1 v 1, so Ali bats again).
await bilal.ok('bowler:submit', { sequence: [1, 1, 1, 1, 1, 1] });
for (let b = 6; b <= 11; b++) await ali.ok('batter:play', { number: 2, ballNo: b });
await bilal.ok('bowler:submit', { sequence: [6, 6, 6, 6, 6, 6] });
await settle();
assert.equal(fan.last().current.set.cap, 1, 'last set only has the one remaining ball');
await ali.ok('batter:play', { number: 4, ballNo: 12 });
await settle();
assert.equal(fan.last().status, 'innings_break');
assert.equal(fan.last().innings[0].runs, 36);

// Second innings: Tigers need 37. Engineer a tie at 36 to test the super over.
await ump.ok('match:nextInnings');
await ali.ok('bowler:submit', { sequence: [1, 1, 1, 1, 1, 1] });
for (let b = 1; b <= 6; b++) await bilal.ok('batter:play', { number: 6, ballNo: b });
await ali.ok('bowler:submit', { sequence: [1, 1, 1, 1, 1, 1] });
await bilal.ok('batter:play', { number: 1, ballNo: 7 });
await ali.ok('bowler:submit', { sequence: [1, 1, 1, 1, 1, 1] });
await bilal.ok('batter:play', { number: 1, ballNo: 8 });
await settle();
assert.equal(fan.last().status, 'innings_break');
assert.equal(fan.last().innings[1].target, 37);
assert.equal(fan.last().innings[1].runs, 36);

// Super over: Tigers bat first (they batted second), 2 wickets.
await ump.ok('match:nextInnings');
await settle();
assert.equal(fan.last().current.number, 3);
await ali.ok('bowler:submit', { sequence: [1, 2, 3, 4, 5, 6] });
await bilal.ok('batter:play', { number: 1, ballNo: 1 });
await ali.ok('bowler:submit', { sequence: [1, 2, 3, 4, 5, 6] });
await bilal.ok('batter:play', { number: 1, ballNo: 2 });
await ump.ok('match:nextInnings');
await bilal.ok('bowler:submit', { sequence: [1, 1, 1, 1, 1, 1] });
await ali.ok('batter:play', { number: 3, ballNo: 1 });
await settle();
const fin = fan.last();
assert.equal(fin.status, 'completed');
assert.equal(fin.result.winner, 'A');
assert.match(fin.result.text, /Lions won by 2 wickets in the super over/);

// Secrecy audit over every message the batter and spectator ever received.
for (const c of [ali, fan, bilal]) for (const st of c.states) {
  const set = st.current?.set;
  if (set && set.status === 'open') assert.equal(set.reveal, null, `${c.name} saw an open sequence`);
}
assert.ok(!fan.privates.some((p) => p.mySequence || p.unsealedSequence || p.audit));

// Stats persisted.
const pa = await api(`/api/users/${ali.user.id}`);
assert.equal(pa.batting.runs, 39); assert.equal(pa.batting.highest, 20); assert.equal(pa.record.wins, 1);
const pb = await api(`/api/users/${bilal.user.id}`);
assert.equal(pb.batting.runs, 36); assert.equal(pb.batting.ducks, 3); assert.equal(pb.record.losses, 1);
assert.equal(pb.bowling.wickets, 1);
const lb = await api('/api/leaderboard?sort=runs');
assert.equal(lb.rows[0].name, 'Ali');

// ---------- Match 2: corrections, disputes, chat privacy and moderation ----------
const m2 = (await api('/api/matches', { config: { overs: 1, wickets: 1 } }, ump.token)).id;
for (const c of [ump, ali, bilal, fan]) await c.open(m2);
await ump.ok('umpire', { action: { type: 'assign', userId: ali.user.id, team: 'A' } });
await ump.ok('umpire', { action: { type: 'assign', userId: bilal.user.id, team: 'B' } });
await ump.ok('match:start');
await bilal.ok('bowler:submit', { sequence: [2, 2, 2, 2, 2, 2] });
await ump.bad('umpire', { action: { type: 'unseal', reason: '' } }, /reason/);
await ump.ok('umpire', { action: { type: 'unseal', reason: 'Batter disputes ball 1' } });
await settle();
assert.deepEqual(ump.privates.at(-1).unsealedSequence, [2, 2, 2, 2, 2, 2]);
assert.equal(fan.privates.at(-1).unsealedSequence, undefined);
await ali.ok('batter:play', { number: 5, ballNo: 1 });
await ump.ok('umpire', { action: { type: 'void', reason: 'Misclick' } });
await settle();
assert.equal(fan.last().innings[0].runs, 0);
assert.equal(fan.last().current.phase, 'awaiting_sequence', 'void forces a fresh sequence');
await ump.ok('umpire', { action: { type: 'adjust', runs: 3, reason: 'Penalty' } });
await settle();
assert.equal(fan.last().innings[0].runs, 3);
assert.ok(ump.privates.at(-1).audit.some((a) => a.action === 'void_ball'));

// Private bowler-umpire channel.
await bilal.ok('chat:send', { channel: `pvt:${bilal.user.id}`, text: 'Ready for the next one' });
await fan.bad('chat:send', { channel: `pvt:${bilal.user.id}`, text: 'sneaky' });
await fan.ok('chat:send', { text: 'What a game! 🔥' });
await settle();
assert.ok(ump.chats.some((m) => m.text === 'Ready for the next one'));
assert.ok(!fan.chats.some((m) => m.text === 'Ready for the next one'));
assert.ok(!ali.chats.some((m) => m.text === 'Ready for the next one'));
assert.ok(ali.chats.some((m) => m.text === 'What a game! 🔥'));
const msgId = ali.chats.find((m) => m.text === 'What a game! 🔥').id;
await ali.ok('chat:react', { messageId: msgId, emoji: '👏' });

await ump.ok('umpire', { action: { type: 'mute', userId: fan.user.id, muted: true } });
await new Promise((r) => setTimeout(r, 650));
await fan.bad('chat:send', { text: 'hello?' }, /muted/);
await ump.ok('umpire', { action: { type: 'kick', userId: fan.user.id } });
await settle();
const re = await fan.emit('match:open', { matchId: m2 });
assert.equal(re.ok, false);

// Reconnection: a fresh socket for the bowler gets the private sequence back.
await bilal.ok('bowler:submit', { sequence: [4, 4, 4, 4, 4, 4] });
bilal.s.disconnect();
const s2 = io(base, { auth: { token: bilal.token }, transports: ['websocket'] });
const r2 = await new Promise((r) => s2.emit('match:open', { matchId: m2 }, r));
assert.deepEqual(r2.private.mySequence, [4, 4, 4, 4, 4, 4]);
assert.ok(r2.chat.some((m) => m.text === 'Ready for the next one'), 'private history restored');
s2.disconnect();

console.log('✔ all match tests passed');
for (const c of [ump, ali, fan]) c.s.disconnect();
server.close(); process.exit(0);
