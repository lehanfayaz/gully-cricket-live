// Rule verification: every example from the specification, through the real engine, in both formats and play styles.
import assert from 'node:assert/strict';
process.env.DB_PATH = ':memory:';
const G = await import('../server/engine.js');
const { checkDigits } = await import('../server/rules.js');
const { run } = await import('../server/db.js');

let n = 0;
const user = (name) => { const id = `u${++n}`; run('INSERT INTO users (id, display_name, is_guest, created_at) VALUES (?,?,1,?)', id, name, Date.now()); return id; };
const ok = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label}: ${e.message}`); } };
const bad = (fn, re, label) => assert.throws(fn, re, label);
const results = [];
const check = (label, pass) => { results.push([label, pass]); assert.ok(pass, label); };

// A no-umpire 1 v 1 match that's live, with player A batting. Returns ids and helpers.
function liveMatch(config) {
  const host = user('Host'), a = user('Bat'), b = user('Bowl');
  const ctx = G.newCtx();
  const id = G.createMatch(host, { config: { mode: 'auto', ...config } });
  G.joinMatch(a, id); G.joinMatch(b, id);
  G.joinTeam(a, id, 'A', ctx); G.joinTeam(b, id, 'B', ctx);
  G.confirmLineup(a, id, 'A', ctx); G.confirmLineup(b, id, 'B', ctx);
  let s = G.publicState(id);
  G.callToss(s.captains[s.toss.caller], id, 'heads', ctx);
  s = G.publicState(id);
  const winner = s.toss.winner;
  G.decideToss(s.captains[winner], id, winner === 'A' ? 'bat' : 'bowl', ctx); // A bats first either way
  const st = () => G.publicState(id);
  return {
    id, host, a, b, st,
    bowl: (seq) => G.submitOver(st().current.bowlerId, id, seq, G.newCtx()),
    bat: (seq) => G.submitOver(st().current.strikerId, id, seq, G.newCtx()),
    test: (action) => G.testAction(host, id, action, G.newCtx()),
  };
}
const as = (s) => s.split('').map(Number);

// ---------- 1. Digit availability ----------
for (const [fmt, role, digit, allowed] of [
  ['test', 'bat', 0, true], ['test', 'bat', 5, false], ['test', 'bowl', 0, false], ['test', 'bowl', 5, false], ['test', 'bowl', 6, true],
  ['custom', 'bat', 0, false], ['custom', 'bat', 5, true], ['custom', 'bowl', 0, false], ['custom', 'bowl', 5, true],
]) check(`${fmt} ${role} ${digit} ${allowed ? 'allowed' : 'refused'}`, !checkDigits({ format: fmt }, role, [digit]) === allowed);
for (const d of [0, 1, 2, 3, 4, 6]) check(`Test batter may pick ${d}`, !checkDigits({ format: 'test' }, 'bat', [d]));
for (const d of [1, 2, 3, 4, 5, 6]) check(`Limited batter may pick ${d} any number of times`, !checkDigits({ format: 'custom' }, 'bat', [d, d, d, d, d, d]));

// ---------- 2. Bowler repetition examples, via the engine (complete over) ----------
const LIMITED_EXAMPLES = [['333552', true], ['333555', false], ['555333', false], ['333442', true], ['555442', true], ['333444', false], ['64444', false], ['665555', false], ['666123', true], ['555123', true], ['000123', false]];
const TEST_EXAMPLES = [['333442', true], ['333444', false], ['64444', false], ['666123', true], ['333224', true], ['444663', true], ['555123', false], ['000123', false]];
for (const [fmt, list] of [['custom', LIMITED_EXAMPLES], ['test', TEST_EXAMPLES]]) {
  for (const [seq, valid] of list) {
    const m = liveMatch(fmt === 'test' ? { format: 'test', days: 1, sessionsPerDay: 1, oversPerSession: 10, wickets: 3 } : { format: 'custom', overs: 2, wickets: 3 });
    const digits = as(seq);
    // Pad 5-digit examples to the 6 balls the over needs, with numbers that keep the verdict.
    const full = digits.length === 6 ? digits : [...digits, 1];
    let accepted = true;
    try { m.bowl(full); } catch { accepted = false; }
    check(`${fmt === 'test' ? 'Test' : 'Limited'} bowler ${seq}: ${valid ? 'valid' : 'invalid'}`, accepted === valid);
  }
}
check('3335522 (7 numbers) refused: more than the balls left', (() => { const m = liveMatch({ overs: 2 }); try { m.bowl(as('3335522')); return false; } catch (e) { return /exactly 6/.test(e.message); } })());

// ---------- 3. Ball by ball: tracked across the over ----------
for (const fmt of ['custom', 'test']) {
  const m = liveMatch(fmt === 'test' ? { format: 'test', play: 'ball', days: 1, sessionsPerDay: 1, oversPerSession: 10, wickets: 3 } : { play: 'ball', overs: 2, wickets: 3 });
  for (const d of [3, 3, 3]) { m.bowl([d]); m.bat([1]); }
  bad(() => m.bowl([3]), /at most 3 times/, 'fourth 3');
  m.bowl([4]); m.bat([1]);
  m.bowl([4]); m.bat([1]);
  bad(() => m.bowl([4]), /Only one number/, 'second triple');
  check(`${fmt === 'test' ? 'Test' : 'Limited'} ball-by-ball: 4th use and a second triple are refused`, true);
  m.bowl([2]); m.bat([1]); // ball 6 ends the over
  check(`${fmt} new over resets the count`, (() => { try { m.bowl([3]); m.bat([1]); m.bowl([3]); m.bat([1]); m.bowl([3]); m.bat([1]); return true; } catch { return false; } })());
}

// ---------- 4. Wicket reset: 444663, out on ball 2, then 4443 ----------
for (const [fmt, play] of [['custom', 'over'], ['test', 'over'], ['custom', 'ball'], ['test', 'ball']]) {
  const cfg = fmt === 'test' ? { format: 'test', play, days: 1, sessionsPerDay: 1, oversPerSession: 10, wickets: 3 } : { play, overs: 2, wickets: 3 };
  const m = liveMatch(cfg);
  if (play === 'over') { m.bowl(as('444663')); m.bat(as('142222')); }
  else { m.bowl([4]); m.bat([1]); m.bowl([4]); m.bat([4]); }
  const s = m.st();
  check(`${fmt}/${play}: wicket on ball 2`, s.innings[0].wickets === 1 && s.innings[0].balls === 2);
  check(`${fmt}/${play}: repetition count reset after the wicket`, s.current.bowledThisOver.length === 0);
  check(`${fmt}/${play}: over still has 4 balls left (ball count not reset)`, s.current.ballsLeftInOver === 4 && s.current.ballInOver === 3);
  if (play === 'over') ok(() => { m.bowl(as('4443')); m.bat(as('1111')); }, `${fmt} 4443 accepted`);
  else for (const d of [4, 4, 4, 3]) ok(() => { m.bowl([d]); m.bat([1]); }, `${fmt} ball ${d}`);
  const after = m.st();
  check(`${fmt}/${play}: 4443 accepted; over completes at 6 legal balls`, after.innings[0].balls === 6 && after.innings[0].overs === '1.0');
}

// ---------- 5. Test: session break mid-over, suspension, and the same over carrying on ----------
{
  const m = liveMatch({ format: 'test', play: 'ball', days: 2, sessionsPerDay: 2, oversPerSession: 5, wickets: 3 });
  m.bowl([3]); m.bat([1]); m.bowl([3]); m.bat([1]);
  const before = m.st();
  m.test({ type: 'end_session' });
  check('Session ended early by the host: session break, innings still live', m.st().status === 'session_break' && m.st().innings[0].status === 'live');
  m.test({ type: 'suspend', reason: 'test' });
  check('Suspended', m.st().status === 'suspended');
  bad(() => m.bowl([1]), /suspended/, 'no play while suspended');
  m.test({ type: 'resume' });
  check('Resume restores the exact state (still at the break)', m.st().status === 'session_break');
  m.test({ type: 'next_session' });
  const s = m.st();
  check('Same over carries on into the next session', s.current.ballInOver === 3 && s.current.ballsLeftInOver === 4);
  check('Same batter and bowler', s.current.strikerId === before.current.strikerId && s.current.bowlerId === before.current.bowlerId);
  check('Repetition count carries across the session break', JSON.stringify(s.current.bowledThisOver) === '[3,3]');
  m.bowl([3]); m.bat([1]);
  bad(() => m.bowl([3]), /at most 3 times/, 'fourth 3 after the break');
  check('Fourth 3 refused after the break (tracking preserved)', true);
}

// ---------- 6. Test dot-over rule: survives breaks and suspension; cancelled by dismissal or innings end ----------
{
  const m = liveMatch({ format: 'test', days: 2, sessionsPerDay: 2, oversPerSession: 1, wickets: 3 });
  const batter = m.st().current.strikerId;
  m.bowl(as('666112')); m.bat(as('000000'));
  let s = m.st();
  check('Dot over creates a requirement', s.test.requirements.length === 1 && s.test.requirements[0].batterId === batter);
  check('Session over after 1 over; innings not complete', s.status === 'session_break' && s.innings[0].status === 'live');
  m.test({ type: 'suspend' }); m.test({ type: 'resume' }); m.test({ type: 'next_session' });
  s = m.st();
  check('Requirement survives the break and suspension', s.test.requirements.length === 1 && s.test.requirements[0].ballsLeft === 2);
  m.bowl(as('112233')); m.bat(as('100000')); // out first ball (1 v 1): dismissed, requirement cancelled
  s = m.st();
  check('Dismissal cancels the requirement', s.test.requirements.length === 0 && s.innings[0].wickets === 1);
}
{
  const m = liveMatch({ format: 'test', days: 1, sessionsPerDay: 1, oversPerSession: 20, wickets: 2 });
  m.bowl(as('666112')); m.bat(as('000000'));
  check('Requirement active before the innings ends', m.st().test.requirements.length === 1);
  const cap = m.st().captains.A;
  G.testAction(cap, m.id, { type: 'declare' }, G.newCtx());
  check('Innings end cancels the requirement', m.st().test.requirements.length === 0);
  check('New innings starts with no requirement', m.st().innings.length === 2 && m.st().test.requirements.length === 0);
}

// ---------- 7. Integrity: duplicates, wrong counts, wrong player ----------
{
  const m = liveMatch({ overs: 2, wickets: 3 });
  m.bowl(as('123456'));
  bad(() => m.bowl(as('123456')), /already locked/, 'duplicate');
  bad(() => G.submitOver(m.host, m.id, as('123456'), G.newCtx()), /isn't your turn/, 'not your turn');
  bad(() => m.bat([1, 2]), /exactly 6/, 'wrong count');
  check('Duplicate, wrong-player and wrong-count submissions refused', true);
}

for (const [label] of results) void label;
console.log(`✔ all ${results.length} rule checks passed`);
process.exit(0);
