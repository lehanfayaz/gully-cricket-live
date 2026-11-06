// Phase 7: admin, security and production readiness. Every admin operation is exercised through the real
// HTTP API with real permissions, and every protection is tested by trying to get around it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
process.env.DB_PATH = ':memory:';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.ADMIN_USERNAMES = 'owner';
const { server } = await import('../server/index.js');
const G = await import('../server/engine.js');
const AI = await import('../server/ai.js');
const B = await import('../server/aibrain.js');
const CDB = await import('../server/cricketdb.js');
const TOUR = await import('../server/tournament.js');
const INTEGRITY = await import('../server/integrity.js');
const SEC = await import('../server/security.js');
const { db, run, get, all } = await import('../server/db.js');
const { commentary } = await import('../server/commentary.js');
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
const base = `http://localhost:${server.address().port}`;
const call = async (method, p, body, token) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
};
const ok = async (method, p, body, token) => { const r = await call(method, p, body, token); if (r.status >= 400) throw new Error(`${method} ${p}: ${r.status} ${r.error}`); return r; };
const ctx = () => G.newCtx();
const reg = (username) => ok('POST', '/api/auth/register', { username, password: 'password123', name: username });

const owner = await reg('owner'), mod = await reg('mod'), alice = await reg('alice'), bob = await reg('bob');

// ===== 1. Declaring at any time in a Test =====
{
  // Two people, no umpire. Batter's captain declares (a) with numbers locked in for the next ball,
  // (b) during a session break, (c) while suspended.
  const host = alice.user.id, other = bob.user.id;
  const make = (cfg) => {
    const id = G.createMatch(host, { name: 'd', teamA: 'A', teamB: 'B', config: { mode: 'auto', format: 'test', days: 2, sessionsPerDay: 2, oversPerSession: 2, inningsPerTeam: 2, wickets: 5, ...cfg } });
    G.joinMatch(other, id); G.joinTeam(host, id, 'A', ctx()); G.joinTeam(other, id, 'B', ctx());
    G.confirmLineup(host, id, 'A', ctx()); G.confirmLineup(other, id, 'B', ctx());
    let st = G.publicState(id); G.callToss(st.captains[st.toss.caller], id, 'heads', ctx());
    st = G.publicState(id); G.decideToss(st.captains[st.toss.winner], id, st.toss.winner === 'A' ? 'bat' : 'bowl', ctx());
    return id;
  };
  const bowl = (id) => { const s = G.publicState(id); const c = s.current; const so = [...c.bowledThisOver]; const out = []; for (let i = 0; i < c.cap; i++) { const d = [1, 2, 3, 6].find((x) => !B.wouldBreak(x, so)); out.push(d); so.push(d); } G.submitOver(c.bowlerId, id, out, ctx()); };
  const bat = (id) => { const s = G.publicState(id); G.submitOver(s.current.strikerId, id, Array(s.current.cap).fill(4), ctx()); };
  // (a) mid-over, with the bowler's numbers locked in and unseen
  let id = make();
  bowl(id); bat(id); bowl(id);
  let st = G.publicState(id);
  assert.ok(st.current.open && st.current.set.bowlerLocked, 'bowler locked in for the next over');
  const battingCap = st.captains[st.innings[0].batting];
  const before = st.innings[0].runs;
  G.testAction(battingCap, id, { type: 'declare' }, ctx());
  st = G.publicState(id);
  assert.equal(st.innings[0].status, 'done'); assert.equal(st.innings[0].runs, before, 'the discarded numbers scored nothing');
  assert.equal(st.innings.length, 2, 'the next innings starts');
  assert.equal(get(`SELECT COUNT(*) AS n FROM sets s JOIN innings i ON i.id = s.innings_id WHERE i.match_id = ? AND s.status = 'cancelled' AND s.end_reason = 'declared'`, id).n, 1);
  assert.ok(!G.publicState(id).current.open, 'nothing left open');
  // (b) during a session break
  id = make();
  for (let k = 0; k < 2; k++) { bowl(id); bat(id); }
  st = G.publicState(id);
  assert.equal(st.status, 'session_break');
  G.testAction(st.captains[st.innings[0].batting], id, { type: 'declare' }, ctx());
  st = G.publicState(id);
  assert.equal(st.status, 'session_break', 'the break carries on'); assert.equal(st.innings[0].status, 'done'); assert.equal(st.innings.length, 2);
  G.testAction(host, id, { type: 'next_session' }, ctx());
  assert.equal(G.publicState(id).status, 'live', 'play resumes with the second innings');
  // (c) while suspended
  id = make();
  bowl(id); bat(id);
  G.testAction(host, id, { type: 'suspend', reason: 'rain' }, ctx());
  st = G.publicState(id);
  G.testAction(st.captains[st.innings[0].batting], id, { type: 'declare' }, ctx());
  st = G.publicState(id);
  assert.equal(st.status, 'suspended'); assert.equal(st.innings[0].status, 'done');
  // Only the batting captain.
  id = make(); bowl(id);
  st = G.publicState(id);
  assert.throws(() => G.testAction(st.captains[st.innings[0].bowling], id, { type: 'declare' }, ctx()), /captain/);
  // Not in limited-overs matches.
  const lim = G.createMatch(host, { name: 'l', teamA: 'A', teamB: 'B', config: { format: 'custom', overs: 2 } });
  assert.throws(() => G.testAction(host, lim, { type: 'declare' }, ctx()), /only for Test/);
}

// ===== 2. Roles and permissions =====
{
  const anon = await call('GET', '/api/admin/overview');
  assert.equal(anon.status, 401);
  assert.equal((await call('GET', '/api/admin/overview', null, alice.token)).status, 403, 'players are kept out');
  const me = await ok('GET', '/api/me', null, owner.token);
  assert.equal(me.user.role, 'admin'); assert.ok(me.user.permissions.includes('system.manage'));
  // Make "mo" a moderator.
  await ok('POST', `/api/admin/users/${mod.user.id}/role`, { role: 'moderator' }, owner.token);
  assert.equal((await ok('GET', '/api/me', null, mod.token)).user.role, 'moderator');
  // Moderators: users and matches, but not configuration, data, roles, logs or backups.
  await ok('GET', '/api/admin/users', null, mod.token);
  await ok('GET', '/api/admin/matches?group=completed', null, mod.token);
  for (const [m, p, body] of [['PUT', '/api/admin/config/ai', { levels: ['easy'] }], ['POST', '/api/admin/sync', {}], ['POST', `/api/admin/users/${alice.user.id}/role`, { role: 'admin' }],
    ['GET', '/api/admin/audit'], ['POST', '/api/admin/backups', {}], ['POST', '/api/admin/teams', { category: 'ipl', name: 'X' }], ['PATCH', `/api/admin/users/${alice.user.id}`, { name: 'Hacked' }]])
    assert.equal((await call(m, p, body, mod.token)).status, 403, `moderator can't ${m} ${p}`);
  // Safety rails on roles.
  assert.match((await call('POST', `/api/admin/users/${owner.user.id}/role`, { role: 'player' }, owner.token)).error, /Owner accounts/);
  const guest = await ok('POST', '/api/auth/guest', { name: 'Guesty' });
  assert.match((await call('POST', `/api/admin/users/${guest.user.id}/role`, { role: 'moderator' }, owner.token)).error, /register/);
  assert.match((await call('POST', `/api/admin/users/${alice.user.id}/role`, { role: 'emperor' }, owner.token)).error, /Role must be/);
}

// ===== 3. Accounts: rename, suspend, sessions, passwords =====
{
  assert.match((await call('PATCH', `/api/admin/users/${alice.user.id}`, { username: 'bob' }, owner.token)).error, /taken/);
  assert.match((await call('PATCH', `/api/admin/users/${alice.user.id}`, { username: 'A!' }, owner.token)).error, /3–20/);
  await ok('PATCH', `/api/admin/users/${alice.user.id}`, { username: 'alice2', name: 'Alice' }, owner.token);
  assert.equal((await ok('GET', `/api/admin/users/${alice.user.id}`, null, owner.token)).user.username, 'alice2');
  // Suspension: needs a reason; signs out everywhere; blocks sign-in; moderators can suspend players.
  assert.match((await call('POST', `/api/admin/users/${bob.user.id}/status`, { status: 'suspended' }, mod.token)).error, /reason/);
  await ok('POST', `/api/admin/users/${bob.user.id}/status`, { status: 'suspended', reason: 'abusive chat' }, mod.token);
  assert.equal((await call('GET', '/api/me', null, bob.token)).user, null, 'signed out everywhere');
  assert.match((await call('POST', '/api/auth/login', { username: 'bob', password: 'password123' })).error, /suspended/);
  assert.match((await call('POST', `/api/admin/users/${owner.user.id}/status`, { status: 'suspended', reason: 'test' }, mod.token)).error, /Owner|staff/);
  assert.match((await call('POST', `/api/admin/users/${mod.user.id}/status`, { status: 'suspended', reason: 'test' }, mod.token)).error, /own account/);
  await ok('POST', `/api/admin/users/${bob.user.id}/status`, { status: 'active' }, mod.token);
  const bob2 = await ok('POST', '/api/auth/login', { username: 'bob', password: 'password123' });
  await ok('GET', '/api/me', null, bob2.token);
  // Career statistics in the user view.
  const detail = await ok('GET', `/api/admin/users/${alice.user.id}`, null, owner.token);
  assert.ok(detail.career && detail.career.record && detail.level);
  // Sessions expire after SESSION_DAYS without use.
  run('UPDATE sessions SET last_used_at = ?, created_at = ? WHERE token = ?', Date.now() - (SEC.SESSION_DAYS + 1) * 86400000, Date.now() - (SEC.SESSION_DAYS + 1) * 86400000, bob2.token);
  assert.equal((await ok('GET', '/api/me', null, bob2.token)).user, null, 'expired session');
  // Changing password signs out other devices.
  const a1 = await ok('POST', '/api/auth/login', { username: 'alice2', password: 'password123' });
  const a2 = await ok('POST', '/api/auth/login', { username: 'alice2', password: 'password123' });
  assert.match((await call('POST', '/api/me/password', { current: 'wrong', next: 'newpassword1' }, a1.token)).error, /current password/);
  await ok('POST', '/api/me/password', { current: 'password123', next: 'newpassword1' }, a1.token);
  assert.equal((await ok('GET', '/api/me', null, a2.token)).user, null, 'other device signed out');
  assert.ok((await ok('GET', '/api/me', null, a1.token)).user, 'this device stays signed in');
  alice.token = a1.token;
}

// ===== 4. Rate limits and input limits =====
{
  let blocked = false;
  for (let i = 0; i < 12; i++) { const r = await call('POST', '/api/auth/login', { username: 'mod', password: 'nope-nope' }); if (/Too many/.test(r.error || '')) { blocked = true; break; } }
  assert.ok(blocked, 'repeated wrong passwords for an account are slowed down');
  // Profile pictures of a realistic size are accepted (they were too big for the old 32 KB limit).
  const pic = 'data:image/jpeg;base64,' + Buffer.alloc(90000, 7).toString('base64');
  await ok('PUT', '/api/me/avatar', { dataUrl: pic }, alice.token);
  assert.equal((await call('POST', '/api/auth/guest', { name: 'x'.repeat(50000) })).status, 413, 'oversized bodies are refused');
  // Security headers.
  const r = await fetch(`${base}/api/config`);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-powered-by'), null);
}

// ===== 5. Configuration is enforced by the server =====
{
  await ok('PUT', '/api/admin/config/formats', { enabled: ['t20', 'custom'], maxCustomOvers: 10, maxTestDays: 5 }, owner.token);
  assert.throws(() => G.createMatch(alice.user.id, { name: 'x', teamA: 'A', teamB: 'B', config: { format: 'test' } }), /Test matches aren't available/);
  assert.throws(() => G.createMatch(alice.user.id, { name: 'x', teamA: 'A', teamB: 'B', config: { format: 'custom', overs: 12 } }), /at most 10 overs/);
  G.createMatch(alice.user.id, { name: 'x', teamA: 'A', teamB: 'B', config: { format: 'custom', overs: 10 } });
  await ok('PUT', '/api/admin/config/ai', { levels: ['easy', 'medium'], defaultLevel: 'medium', personalities: ['strategic', 'defensive'], defaultPersonality: 'defensive' }, owner.token);
  assert.throws(() => G.createMatch(alice.user.id, { name: 'x', teamA: 'A', teamB: 'B', config: { participation: 'ai', aiLevel: 'expert', format: 't20' } }), /expert AI isn't available/);
  const q = G.createMatch(alice.user.id, { name: 'x', teamA: 'A', teamB: 'B', quick: { start: 'bat' }, config: { format: 'custom', overs: 2 } });
  assert.equal(G.loadMatch(q).config.aiPersonality, 'defensive', 'admin default personality');
  assert.throws(() => TOUR.createTournament(alice.user.id, { kind: 'knockout', teams: [{ name: 'Aa' }, { name: 'Bb' }], humanIndex: 0, match: { format: 'odi' } }), /ODI matches aren't available/);
  assert.throws(() => TOUR.createTournament(alice.user.id, { kind: 'knockout', teams: [{ name: 'Aa' }, { name: 'Bb' }], humanIndex: 0, match: { format: 't20', aiLevel: 'hard' } }), /hard AI/);
  const pub = await ok('GET', '/api/config');
  assert.deepEqual(pub.formats.enabled, ['t20', 'custom']); assert.deepEqual(pub.ai.levels, ['easy', 'medium']);
  assert.match((await call('PUT', '/api/admin/config/ai', { levels: [], personalities: ['strategic'] }, owner.token)).error, /at least one/);
  // Stadium themes, including admin-made ones.
  await ok('PUT', '/api/admin/config/themes', { enabled: ['night', 'ipl', 'x-desert'], default: 'x-desert', custom: [{ id: 'desert', name: 'Desert', sky: '#E8B36A', stands: '#8A4B2A', accent: '#FFD23F' }] }, owner.token);
  const th = (await ok('GET', '/api/config')).themes;
  assert.equal(th.default, 'x-desert'); assert.equal(th.custom[0].name, 'Desert');
  assert.match((await call('PUT', '/api/admin/config/themes', { enabled: ['night'], custom: [{ name: 'Bad', sky: 'red', stands: '#000000', accent: '#000000' }] }, owner.token)).error, /Colours/);
  // Restore the defaults for the rest of the tests.
  await ok('PUT', '/api/admin/config/formats', { enabled: ['test', 't20', 'odi', 'custom'], maxCustomOvers: 50, maxTestDays: 5 }, owner.token);
  await ok('PUT', '/api/admin/config/ai', { levels: ['easy', 'medium', 'hard', 'expert'], personalities: ['strategic', 'aggressive', 'defensive', 'unpredictable'], defaultLevel: 'medium', defaultPersonality: 'strategic' }, owner.token);
}

// ===== 6. Commentary templates: validated, used, and still consistent with the scorecard =====
{
  for (const [ev, line, re] of [['six', 'A big {four} hit', /placeholder/], ['four', '{batter} hits it for six', /different kind/], ['wicket', '{batter} out for 0', /numbers/], ['dot', 'Nothing {bogus}', /placeholder/]])
    assert.match((await call('PUT', '/api/admin/config/commentary', { templates: { [ev]: [line] } }, owner.token)).error, re, `${ev}: ${line}`);
  await ok('PUT', '/api/admin/config/commentary', { enabled: true, templates: { six: ['{batter} sends it into the crowd off {bowler}!'], wicket: ['{bowler} has {batter} with a matching {bowl}.'] } }, owner.token);
  const id = G.createMatch(alice.user.id, { name: 'c', teamA: 'A', teamB: 'B', quick: { start: 'bat' }, config: { format: 'custom', overs: 1, wickets: 1, play: 'ball' } });
  const botId = G.publicState(id).members.find((x) => x.bot).id;
  G.submitOver(botId, id, [1], ctx()); G.submitOver(alice.user.id, id, [6], ctx());   // a six
  G.submitOver(botId, id, [2], ctx()); G.submitOver(alice.user.id, id, [2], ctx());   // out
  const lines = commentary(G.loadMatch(id), { limit: 10, teamName: (m, t) => (t === 'A' ? m.team_a : m.team_b) });
  assert.match(lines.find((l) => l.runs === 6).text, /SIX! .* sends it into the crowd/);
  assert.match(lines.find((l) => l.wicket).text, /OUT! .* with a matching 2\./);
  assert.ok(lines.find((l) => l.wicket).text.includes('departs for 6 off 2 balls'), 'numbers still from the record');
  await ok('PUT', '/api/admin/config/commentary', { enabled: false, templates: {} }, owner.token);
  assert.ok(G.publicState(id).commentary.every((c) => c.text === null), 'commentary switched off for everyone');
  await ok('PUT', '/api/admin/config/commentary', { enabled: true, templates: {} }, owner.token);
}

// ===== 7. Scores can't be changed outside the game rules =====
let sample;
{
  const id = G.createMatch(alice.user.id, { name: 's', teamA: 'A', teamB: 'B', quick: { start: 'bat' }, config: { format: 'custom', overs: 3, wickets: 3 } });
  for (let k = 0; k < 2; k++) { while (AI.aiStep(id)); const s = G.publicState(id); G.submitOver(alice.user.id, id, Array(s.current.cap).fill(5), ctx()); }
  while (AI.aiStep(id));
  sample = id;
  const ball = get('SELECT b.* FROM balls b JOIN innings i ON i.id = b.innings_id WHERE i.match_id = ? AND b.is_wicket = 0 LIMIT 1', id);
  for (const sql of [`UPDATE balls SET runs = 6 WHERE id = ${ball.id}`, `UPDATE balls SET bat_num = 1 WHERE id = ${ball.id}`, `UPDATE balls SET is_wicket = 1 WHERE id = ${ball.id}`,
    `DELETE FROM balls WHERE id = ${ball.id}`, `UPDATE sets SET seq = '111111' WHERE id = ${ball.set_id}`, `DELETE FROM sets WHERE id = ${ball.set_id}`, `DELETE FROM audit WHERE match_id = '${id}'`, `UPDATE audit SET text = 'x' WHERE match_id = '${id}'`])
    assert.throws(() => db.exec(sql), /cannot|append-only/, sql);
  // A failed action changes nothing (whole action rolls back).
  const n = get('SELECT COUNT(*) AS n FROM sets').n;
  assert.throws(() => G.submitOver(alice.user.id, id, [9, 9, 9, 9, 9, 9], ctx()));
  assert.equal(get('SELECT COUNT(*) AS n FROM sets').n, n);
}

// ===== 8. Integrity checks catch tampering =====
{
  let r = INTEGRITY.runIntegrity('test');
  assert.ok(r.ok, `clean database: ${JSON.stringify(r.problems.slice(0, 3))}`);
  // Simulate corruption by someone bypassing the app (drop the guard, change a ball, put it back).
  const ball = get('SELECT b.* FROM balls b JOIN innings i ON i.id = b.innings_id WHERE i.match_id = ? AND b.is_wicket = 0 LIMIT 1', sample);
  db.exec('DROP TRIGGER balls_no_edit');
  db.exec(`UPDATE balls SET runs = runs + 1 WHERE id = ${ball.id}`);
  r = INTEGRITY.runIntegrity('test');
  assert.ok(!r.ok && r.problems.some((p) => p.matchId === sample && p.kind === 'runs'), 'changed runs detected');
  db.exec(`UPDATE balls SET runs = runs - 1, bowl_num = CASE WHEN bowl_num = 1 THEN 2 ELSE 1 END WHERE id = ${ball.id}`);
  r = INTEGRITY.runIntegrity('test');
  assert.ok(r.problems.some((p) => p.kind === 'delivery'), 'a delivery that differs from the locked-in numbers is detected');
  db.exec(`UPDATE balls SET bowl_num = ${ball.bowl_num} WHERE id = ${ball.id}`);
  db.exec('DROP TRIGGER sets_seq_fixed');
  const set = get('SELECT * FROM sets WHERE id = ?', ball.set_id);
  db.exec(`UPDATE sets SET salt = 'forged' WHERE id = ${set.id}`);
  r = INTEGRITY.runIntegrity('test');
  assert.ok(r.problems.some((p) => p.kind === 'commitment'), 'a sequence that no longer matches its hash is detected');
  db.exec(`UPDATE sets SET salt = '${set.salt}' WHERE id = ${set.id}`);
  assert.ok(INTEGRITY.runIntegrity('test').ok, 'clean again');
  // Put the guards back (the schema recreates them).
  db.exec(`CREATE TRIGGER balls_no_edit BEFORE UPDATE OF bat_num, bowl_num, runs, ball_no, innings_id, batter_id, bowler_id, set_id, stint, session_idx ON balls BEGIN SELECT RAISE(ABORT, 'Recorded deliveries cannot be changed.'); END;`);
  const run2 = await ok('POST', '/api/admin/integrity', {}, owner.token);
  assert.ok(run2.ok && run2.matches > 0);
}

// ===== 9. Match management =====
{
  // Active, inspect (no hidden numbers shown), abandon, cleanup.
  const id = G.createMatch(alice.user.id, { name: 'Inspect me', teamA: 'A', teamB: 'B', quick: { start: 'bowl' }, config: { format: 'custom', overs: 3, wickets: 3 } });
  G.submitOver(alice.user.id, id, [1, 2, 3, 4, 5, 6], ctx()); // alice bowls; hidden until the AI bats
  const list = await ok('GET', '/api/admin/matches?group=active', null, mod.token);
  assert.ok(list.matches.some((m) => m.id === id));
  const ins = await ok('GET', `/api/admin/matches/${id}`, null, mod.token);
  assert.equal(ins.submissions.at(-1).bowl, 'locked in (hidden)', 'staff never see unrevealed numbers');
  assert.ok(!JSON.stringify(ins).includes('123456'));
  assert.ok(ins.events.length > 0 && Array.isArray(ins.problems));
  assert.match((await call('POST', `/api/admin/matches/${id}/abandon`, { reason: '' }, mod.token)).error, /reason/);
  await ok('POST', `/api/admin/matches/${id}/abandon`, { reason: 'reported by players' }, mod.token);
  assert.equal(G.loadMatch(id).status, 'abandoned');
  assert.ok((await ok('GET', '/api/admin/matches?group=abandoned', null, mod.token)).matches.some((m) => m.id === id && m.abandonedReason === 'reported by players'));
  assert.ok((await ok('GET', `/api/admin/matches/${id}`, null, mod.token)).events.some((e) => e.action === 'admin_abandon'));
  // Suspended matches are listed.
  const t = G.createMatch(alice.user.id, { name: 'Rainy', teamA: 'A', teamB: 'B', config: { format: 'test', mode: 'auto', days: 1, sessionsPerDay: 1, oversPerSession: 2 } });
  G.joinMatch(bob.user.id, t); G.joinTeam(alice.user.id, t, 'A', ctx()); G.joinTeam(bob.user.id, t, 'B', ctx());
  G.confirmLineup(alice.user.id, t, 'A', ctx()); G.confirmLineup(bob.user.id, t, 'B', ctx());
  let st = G.publicState(t); G.callToss(st.captains[st.toss.caller], t, 'heads', ctx()); st = G.publicState(t); G.decideToss(st.captains[st.toss.winner], t, 'bat', ctx());
  G.testAction(alice.user.id, t, { type: 'suspend', reason: 'bad light' }, ctx());
  assert.ok((await ok('GET', '/api/admin/matches?group=suspended', null, mod.token)).matches.some((m) => m.id === t));
  // Abandoning a tournament match counts as no result there.
  const tid = TOUR.createTournament(alice.user.id, { kind: 'knockout', teams: [{ name: 'Aa' }, { name: 'Bb' }], humanIndex: 0, match: { format: 'custom', overs: 2 } });
  const tm = TOUR.playNext(alice.user.id, tid);
  await ok('POST', `/api/admin/matches/${tm}/abandon`, { reason: 'player left' }, owner.token);
  assert.equal(TOUR.view(tid, alice.user.id).fixtures[0].decidedBy, 'seeding');
  // Stale lobbies.
  const old = G.createMatch(bob.user.id, { name: 'Forgotten', teamA: 'A', teamB: 'B', config: { format: 'custom', overs: 2 } });
  db.exec('DROP TRIGGER audit_append_only');
  run('UPDATE matches SET created_at = ? WHERE id = ?', Date.now() - 40 * 86400000, old);
  run('UPDATE audit SET created_at = ? WHERE match_id = ?', Date.now() - 40 * 86400000, old);
  db.exec(`CREATE TRIGGER audit_append_only BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'The match event log is append-only.'); END;`);
  const cl = await ok('POST', '/api/admin/matches/cleanup', { days: 30 }, mod.token);
  assert.ok(cl.abandoned >= 1); assert.equal(G.loadMatch(old).status, 'abandoned');
}

// ===== 10. Audit log, errors, notifications, overview =====
{
  const log = (await ok('GET', '/api/admin/audit', null, owner.token)).entries;
  for (const a of ['user.role', 'user.rename', 'user.status', 'config.save', 'match.abandon', 'match.cleanup', 'integrity.run'])
    assert.ok(log.some((e) => e.action === a), `audit has ${a}`);
  const sus = log.find((e) => e.action === 'user.status');
  assert.equal(sus.username, 'mod'); assert.ok(sus.ip);
  assert.throws(() => db.exec('DELETE FROM admin_audit'), /append-only/);
  const ov = await ok('GET', '/api/admin/overview', null, owner.token);
  assert.ok(ov.users >= 4 && ov.matches && 'sync' in ov && ov.integrity);
  await ok('POST', '/api/admin/notifications/read', {}, owner.token);
  await ok('GET', '/api/admin/errors', null, owner.token);
}

// ===== 11. Sync: identity preservation, duplicates, merging, history =====
{
  const ch = () => ({ newTeams: [], renamedTeams: [], newPlayers: 0, transfers: 0, removedPlayers: 0 });
  const c1 = ch();
  const a = CDB.upsertPlayer('prov', { extId: 'p1', name: 'Shubman Gill', country: 'India', role: 'bat' }, c1);
  // The provider changes the id: still the same person.
  const c2 = ch();
  const b = CDB.upsertPlayer('prov', { extId: 'p1-new', name: 'Shubman Gill', country: 'India' }, c2);
  assert.equal(b, a, 'same person after an id change'); assert.equal(c2.newPlayers, 0); assert.equal(c2.linkedPlayers, 1);
  // A second source with its own id: still the same person.
  assert.equal(CDB.upsertPlayer('sheet', { extId: 'Shubman Gill', name: 'Shubman Gill', country: 'India' }, ch()), a);
  // Two different people with the same name in different countries stay separate.
  const other = CDB.upsertPlayer('prov', { extId: 'p2', name: 'Mohammad Nabi', country: 'Afghanistan' }, ch());
  const other2 = CDB.upsertPlayer('prov', { extId: 'p3', name: 'Mohammad Nabi', country: 'Pakistan' }, ch());
  assert.notEqual(other, other2);
  // A true duplicate (entered by hand) is found and can be merged; squads move across.
  const season = CDB.currentSeason('international');
  run(`INSERT INTO cricket_players (source, ext_id, name, country, updated_at) VALUES ('manual', 'm1', 'Shubman  Gill', 'India', ?)`, Date.now());
  const dup = get(`SELECT id FROM cricket_players WHERE ext_id = 'm1'`).id;
  run(`INSERT INTO cricket_squads (team_id, season_id, player_id, active, source, added_at) VALUES ('int-ind', ?, ?, 1, 'manual', ?)`, season, dup, Date.now());
  const d = await ok('GET', '/api/admin/cricket/duplicates', null, owner.token);
  assert.ok(d.groups.some((g) => g.some((p) => p.id === dup) && g.some((p) => p.id === a)), 'duplicate found');
  await ok('POST', '/api/admin/cricket/merge', { keep: a, duplicate: dup }, owner.token);
  assert.ok(get(`SELECT 1 FROM cricket_squads WHERE team_id = 'int-ind' AND player_id = ? AND active = 1`, a), 'squad place moved to the kept record');
  assert.ok(!(await ok('GET', '/api/admin/cricket/duplicates', null, owner.token)).groups.some((g) => g.some((p) => p.id === dup)));
  // Season views and stale data.
  assert.ok((await ok('GET', '/api/admin/cricket/seasons', null, owner.token)).seasons.length > 0);
  assert.ok((await ok('GET', '/api/admin/cricket/teams/int-ind/squad', null, owner.token)).players.some((p) => p.id === a));
  assert.ok((await ok('GET', '/api/admin/cricket/players?q=Gill', null, owner.token)).players.some((p) => p.id === a && p.ids.length >= 3));
  assert.equal(CDB.syncStatus().stale, true, 'squads that were never synced are flagged as possibly out of date');
  // Finished matches keep the names they were played with, whatever happens to the database later.
  const m = G.createMatch(alice.user.id, { name: 'hist', realTeams: { A: 'int-ind', B: 'int-aus' }, quick: { start: 'bat' }, config: { format: 'custom', overs: 1, participation: 'ai', teamSource: 'real', xiSize: 3 } });
  const meta = G.loadMatch(m).team_a_meta;
  CDB.adminSaveTeam({ id: 'int-ind', name: 'Bharat', short: 'BHA' });
  assert.equal(G.loadMatch(m).team_a_meta, meta, 'match keeps its own snapshot');
  assert.equal(G.loadMatch(m).team_a, 'India');
}

// ===== 12. Backups and recovery (in a separate process with a real database file) =====
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcl-bk-'));
  const dbf = path.join(dir, 'cricket.db');
  const root = path.resolve('.');
  const script = path.join(dir, 's.mjs');
  fs.writeFileSync(script, `
    process.env.DB_PATH = ${JSON.stringify(dbf)};
    const B = await import(${JSON.stringify(path.join(root, 'server/backup.js'))});
    const { run, get } = await import(${JSON.stringify(path.join(root, 'server/db.js'))});
    const step = process.argv[2];
    if (step === 'one') {
      run('INSERT INTO users (id, display_name, is_guest, created_at) VALUES (?,?,1,?)', 'u1', 'Before', Date.now());
      const b = B.createBackup('manual');
      run('INSERT INTO users (id, display_name, is_guest, created_at) VALUES (?,?,1,?)', 'u2', 'After', Date.now());
      const v = B.requestRestore(b.name);
      console.log(JSON.stringify({ b, v, list: B.listBackups().length }));
    } else {
      console.log(JSON.stringify({ users: get('SELECT COUNT(*) AS n FROM users').n, pending: B.pendingRestore() }));
    }
  `);
  const one = JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, 'one'], { encoding: 'utf8' }).trim().split('\n').pop());
  assert.ok(one.b.ok && one.b.counts.users === 1 && one.list === 1, 'backup made and verified');
  const two = JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, 'two'], { encoding: 'utf8' }).trim().split('\n').pop());
  assert.equal(two.users, 1, 'restored at start-up to the backup'); assert.equal(two.pending, null);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('pre-restore-')), 'the replaced database was kept');
  // Command-line restore refuses a damaged file.
  const bad = path.join(dir, 'bad.db'); fs.writeFileSync(bad, 'not a database');
  assert.throws(() => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'server/tools/restore.js'), bad], { env: { ...process.env, DB_PATH: dbf }, stdio: 'pipe' }));
  fs.rmSync(dir, { recursive: true, force: true });
  // Backups through the API need a real file: the in-memory test database explains why not.
  assert.match((await call('POST', '/api/admin/backups', {}, owner.token)).error, /in memory/);
  assert.match((await call('GET', '/api/admin/backups/..%2F..%2Fetc%2Fpasswd', null, owner.token)).error || '', /Unknown backup|no longer/);
}

// ===== 13. Importing squads from the workbook =====
{
  const file = fs.readFileSync(new URL('../server/data/squads-2026-11-06.xlsx', import.meta.url));
  const up = (q, token) => fetch(`${base}/api/admin/cricket/import?name=Cricket_Squads_Nov2026.xlsx${q}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${token}` }, body: file }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
  assert.equal((await up('&dryRun=1', mod.token)).status, 403, 'moderators cannot import');
  // India was renamed "Bharat" above: the preview warns that it would be a new team. Put the name back first.
  assert.equal((await up('&dryRun=1', owner.token)).preview.international.find((t) => t.name === 'India').updates, null);
  CDB.adminSaveTeam({ id: 'int-ind', name: 'India', short: 'IND' });
  const pv = await up('&dryRun=1', owner.token);
  assert.equal(pv.preview.international.length, 10); assert.equal(pv.preview.ipl.length, 10);
  assert.ok([...pv.preview.international, ...pv.preview.ipl].every((t) => t.updates), 'every team matches an existing one');
  assert.equal(pv.preview.international.reduce((s, t) => s + t.players, 0), 164);
  assert.equal(pv.preview.ipl.reduce((s, t) => s + t.players, 0), 250);
  assert.deepEqual(pv.preview.excluded.map((x) => x.player).sort(), ['Litton Das', 'Mustafizur Rahman']);
  assert.equal(pv.preview.replacements.length, 19);
  assert.equal(CDB.getTeam('ipl-dc').squad.find((p) => p.name === 'Rishabh Pant'), undefined, 'a preview changes nothing');
  const res = await up('', owner.token);
  assert.equal(res.result.squads, 20);
  assert.equal(CDB.getTeam('ipl-kkr').squad.length, 25);
  assert.ok(CDB.getTeam('ipl-dc').squad.some((p) => p.name === 'Rishabh Pant'), 'IPL 2027 trade applied (Pant to DC)');
  assert.ok(!CDB.getTeam('ipl-lsg').squad.some((p) => p.name === 'Rishabh Pant'));
  assert.ok(CDB.getTeam('int-ind').squad.some((p) => p.name === 'Virat Kohli'));
  const gill = all(`SELECT DISTINCT s.player_id FROM cricket_squads s JOIN cricket_players p ON p.id = s.player_id WHERE p.name = 'Shubman Gill' AND s.active = 1`);
  assert.equal(gill.length, 1, 'one Shubman Gill in both India and Gujarat Titans');
  assert.ok(CDB.getTeam('int-ind').squad.find((p) => p.name === 'Ishan Kishan')?.role === 'wk', 'roles from the sheet');
  assert.equal(CDB.syncStatus().lastSource, 'Spreadsheet: Cricket_Squads_Nov2026.xlsx'); assert.equal(CDB.syncStatus().stale, false);
  // Teams not in the file are untouched; importing again changes nothing.
  const again = await up('', owner.token);
  assert.equal(again.result.newPlayers, 0); assert.equal(again.result.removedPlayers, 0); assert.equal(again.result.transfers, 0);
  // Not a workbook.
  assert.match((await fetch(`${base}/api/admin/cricket/import`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${owner.token}` }, body: 'hello' }).then((r) => r.json())).error, /couldn't be read/);
  // A match created now uses the new squads; the data check still passes.
  const m = G.createMatch(alice.user.id, { name: 'new squads', realTeams: { A: 'ipl-dc', B: 'ipl-csk' }, quick: { start: 'bat' }, config: { format: 't20', participation: 'ai', teamSource: 'real', xiSize: 11 } });
  assert.ok(G.publicState(m).teams.A.players.length === 11);
  assert.ok(INTEGRITY.runIntegrity('test').ok);
}

console.log('✔ all admin, security and production-readiness tests passed');
process.exit(0);
