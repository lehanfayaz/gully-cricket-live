// Phase 4: tournaments against the AI. Full tournaments of every kind are played from start to champion with no
// manual edits: the human's matches through the engine (random legal picks), AI v AI fixtures by the AI itself.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.DB_PATH = ':memory:';
const G = await import('../server/engine.js');
const AI = await import('../server/ai.js');
const B = await import('../server/aibrain.js');
const CDB = await import('../server/cricketdb.js');
const TOUR = await import('../server/tournament.js');
const { all, get, run } = await import('../server/db.js');
const { rulesFor } = await import('../server/rules.js');
CDB.seedIfEmpty();

function rng(seed) { let h = seed >>> 0 || 1; return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1e9) / 1e9; }; }
let n = 0;
const user = (name) => { const id = `t${++n}`; run('INSERT INTO users (id, display_name, is_guest, created_at) VALUES (?,?,1,?)', id, name, Date.now()); return id; };
const ctx = () => G.newCtx();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The human plays their match like a person would: confirm, toss, then legal numbers until it ends.
function playHumanMatch(uid, matchId, rand) {
  for (let g = 0; g < 20000; g++) {
    let acted = false;
    for (let k = 0; k < 6 && AI.aiStep(matchId); k++) acted = true;
    const st = G.publicState(matchId);
    if (st.status === 'completed') return st;
    const r = rulesFor({ format: st.format });
    const pick = (role, need, so) => { const out = [], s = [...so]; for (let i = 0; i < need; i++) { const o = role === 'bat' ? r.batter : r.bowler.filter((d) => !B.wouldBreak(d, s)); const d = o[Math.floor(rand() * o.length)]; out.push(d); if (role === 'bowl') s.push(d); } return out; };
    const mine = (pid) => pid === uid || st.members.find((x) => x.id === pid)?.controller === uid;
    if (st.status === 'lobby') {
      if (!st.lineups.A.confirmedAt && !st.toss.result) { G.confirmLineup(uid, matchId, 'A', ctx()); continue; }
      if (st.stage === 'toss_call' && st.captains[st.toss.caller] === uid) { G.callToss(uid, matchId, 'heads', ctx()); continue; }
      if (st.stage === 'toss_decision' && st.captains[st.toss.winner] === uid) { G.decideToss(uid, matchId, rand() < 0.5 ? 'bat' : 'bowl', ctx()); continue; }
    } else if (st.status === 'live') {
      const c = st.current, bw = c.open ? c.set.bowlerId : c.bowlerId, bt = c.open ? c.set.batterId : c.strikerId;
      if (mine(bw) && !(c.open && c.set.bowlerLocked)) { G.submitOver(uid, matchId, pick('bowl', c.cap, c.bowledThisOver), ctx()); continue; }
      if (mine(bt) && !(c.open && c.set.batterLocked)) { G.submitOver(uid, matchId, pick('bat', c.cap, []), ctx()); continue; }
    }
    if (!acted) throw new Error(`human match stuck at ${st.status}/${st.stage}`);
  }
  throw new Error('human match never finished');
}

// Drive a tournament to its champion using only the public actions: simulate, play, repeat.
async function runTournament(uid, tid, seed) {
  const rand = rng(seed);
  for (let guard = 0; guard < 400; guard++) {
    const v = TOUR.view(tid, uid);
    if (v.status === 'completed') return v;
    if (v.job?.running) { await wait(5); continue; }
    if (v.job?.error) throw new Error(v.job.error);
    if (v.next?.human) { const mid = TOUR.playNext(uid, tid); playHumanMatch(uid, mid, rand); continue; }
    TOUR.simulate(uid, tid);
    await wait(1);
  }
  throw new Error('tournament never finished');
}

// Recompute a group table independently from the matches and compare.
function checkTable(v, tid) {
  for (const g of v.groups) {
    const fx = v.fixtures.filter((f) => f.stage === 'group' && f.group === g.name && f.status === 'completed');
    let points = 0;
    for (const row of g.rows) {
      let rf = 0, bf = 0, ra = 0, bb = 0, pts = 0, played = 0;
      for (const f of fx.filter((x) => x.home === row.key || x.away === row.key)) {
        played++;
        const m = G.loadMatch(f.matchId);
        const fr = get('SELECT side_a FROM tournament_fixtures WHERE id = ?', f.id);
        const mySide = fr.side_a === row.key ? 'A' : 'B';
        if (m.result.winner === mySide) pts += 2; else if (!m.result.winner) pts += 1;
        if (m.result.winner || m.result.tie) for (const inn of all('SELECT * FROM innings WHERE match_id = ? AND super_over = 0', f.matchId)) {
          const t = G.totals(inn.id), balls = t.wickets >= inn.max_wickets ? inn.max_balls : t.balls;
          if (inn.batting === mySide) { rf += t.runs; bf += balls; } else { ra += t.runs; bb += balls; }
        }
      }
      assert.equal(row.points, pts, `${row.name}: points`);
      assert.equal(row.played, played, `${row.name}: played`);
      const nrr = (bf ? rf / (bf / 6) : 0) - (bb ? ra / (bb / 6) : 0);
      assert.ok(Math.abs(row.nrr - nrr) < 0.0006, `${row.name}: NRR ${row.nrr} v ${nrr}`);
      points += row.points;
    }
    assert.equal(points, fx.length * 2, `group ${g.name}: two points handed out per match`);
    // Sorted by points, then NRR.
    for (let i = 1; i < g.rows.length; i++) assert.ok(g.rows[i - 1].points > g.rows[i].points || (g.rows[i - 1].points === g.rows[i].points && g.rows[i - 1].nrr >= g.rows[i].nrr), 'table order');
  }
}

function checkFinished(v, label) {
  assert.equal(v.status, 'completed', `${label}: finished`);
  assert.ok(v.champion, `${label}: a champion`);
  assert.ok(v.fixtures.every((f) => f.status === 'completed' || f.status === 'bye'), `${label}: every fixture done`);
  for (const f of v.fixtures.filter((x) => x.status === 'completed')) {
    assert.ok(f.matchId, `${label}: ${f.roundName} was played as a match`);
    const m = G.loadMatch(f.matchId);
    assert.equal(m.status, 'completed', `${label}: ${f.roundName} match completed`);
    if (f.stage !== 'group') {
      assert.ok(f.winner, `${label}: ${f.roundName} has a winner`);
      assert.equal(f.decidedBy, 'result', `${label}: knockouts decided on the field`);
    }
    // Every ball of every match follows the rules.
    for (const inn of all('SELECT * FROM innings WHERE match_id = ?', f.matchId)) {
      const r = rulesFor(m.config);
      let since = [], over = -1;
      for (const b of all('SELECT * FROM balls WHERE innings_id = ? AND voided = 0 ORDER BY ball_no', inn.id)) {
        const o = Math.floor((b.ball_no - 1) / 6); if (o !== over) { over = o; since = []; }
        assert.ok(r.batter.includes(b.bat_num) && r.bowler.includes(b.bowl_num), 'digits');
        assert.ok(!B.wouldBreak(b.bowl_num, since), 'repetition rule'); since.push(b.bowl_num); if (b.is_wicket) since = [];
      }
    }
  }
  // The champion won the final (or topped the league when there's no knockout).
  const ko = v.fixtures.filter((f) => f.stage === 'knockout');
  if (ko.length) assert.equal(v.champion.key, ko.at(-1).winner, `${label}: champion won the final`);
  else assert.equal(v.champion.key, v.groups[0].rows[0].key, `${label}: champion topped the table`);
  // Knockout teams come from the right places.
  for (const f of ko.filter((x) => x.round === Math.min(...ko.map((y) => y.round)))) {
    for (const [key, label2] of [[f.home, f.homeLabel], [f.away, f.awayLabel]]) if (key) assert.ok(v.teams.some((t) => t.key === key), label2);
  }
}

const TEAMS = (k) => ['int-ind', 'int-aus', 'int-eng', 'int-pak', 'int-nz', 'int-sa', 'int-sl', 'int-wi', 'ipl-csk', 'ipl-mi', 'ipl-rcb', 'ipl-kkr'].slice(0, k).map((id) => ({ teamId: id }));
const real = CDB.listTeams().teams.map((t) => t.id);
for (const t of TEAMS(12)) assert.ok(real.includes(t.teamId), `${t.teamId} is in the team database`);

const owner = user('Lehan');
const summary = [];

// 1. Group stage then knockout: 8 teams, 2 groups, top two through, semis, third place and final. T20.
{
  const tid = TOUR.createTournament(owner, { kind: 'groups', name: 'World Cup', teams: TEAMS(8), humanIndex: 0, structure: { groups: 2, qualify: 2, thirdPlace: true }, match: { format: 'custom', overs: 2, wickets: 3, aiLevel: 'hard' } });
  let v = TOUR.view(tid, owner);
  assert.equal(v.fixtures.filter((f) => f.stage === 'group').length, 12, 'two groups of four: 6 matches each');
  assert.equal(v.fixtures.filter((f) => f.stage === 'knockout').length, 3, 'two semis and a final');
  assert.equal(v.fixtures.filter((f) => f.stage === 'third').length, 1);
  assert.deepEqual(v.groups.map((g) => g.rows.length), [4, 4]);
  // Snake seeding: seeds 1 and 2 in different groups.
  assert.notEqual(v.teams[0].group, v.teams[1].group);
  // The semis are cross-group: winner of A v runner-up of B.
  const semis = v.fixtures.filter((f) => f.roundName.startsWith('Semi'));
  assert.deepEqual(semis.map((f) => [f.homeLabel, f.awayLabel]), [['Winner, group A', 'Runner-up, group B'], ['Winner, group B', 'Runner-up, group A']]);
  // Personalities are mixed across AI teams; the human team has none.
  assert.equal(v.teams[0].personality, null);
  assert.equal(new Set(v.teams.slice(1).map((t) => t.personality)).size, 4);
  // Halfway through the group stage, the table is consistent and knockouts are still unknown.
  const rand = rng(3);
  for (let i = 0; i < 6; i++) { v = TOUR.view(tid, owner); if (v.next.human) playHumanMatch(owner, TOUR.playNext(owner, tid), rand); else { TOUR.simulate(owner, tid, { limit: 1 }); while (TOUR.jobOf(tid)?.running) await wait(2); } }
  v = TOUR.view(tid, owner);
  checkTable(v, tid);
  assert.ok(semis.every((f) => !v.fixtures.find((x) => x.id === f.id).home), 'semis wait for the groups');
  v = await runTournament(owner, tid, 4);
  checkTable(v, tid);
  checkFinished(v, 'groups');
  // Semi-finalists are exactly the top two of each group.
  const finalists = v.fixtures.filter((f) => f.roundName.startsWith('Semi')).flatMap((f) => [f.home, f.away]).sort();
  assert.deepEqual(finalists, v.groups.flatMap((g) => g.rows.slice(0, 2).map((r) => r.key)).sort(), 'semi-finalists are the top two of each group');
  const semiA = v.fixtures.find((f) => f.roundName === 'Semi-final 1');
  assert.equal(semiA.home, v.groups[0].rows[0].key); assert.equal(semiA.away, v.groups[1].rows[1].key);
  // Third-place play-off is between the beaten semi-finalists.
  const third = v.fixtures.find((f) => f.stage === 'third');
  const losers = v.fixtures.filter((f) => f.roundName.startsWith('Semi')).map((f) => (f.winner === f.home ? f.away : f.home)).sort();
  assert.deepEqual([third.home, third.away].sort(), losers);
  assert.ok(v.final && v.final.innings.length >= 2, 'final scorecard available');
  assert.ok(v.stats.matches === 16 && v.stats.mostRuns.length && v.stats.highestTotals.length, 'tournament stats');
  // Stats trace to deliveries: total runs equal the sum of every non-super-over ball in the tournament's matches.
  const ids = v.fixtures.filter((f) => f.matchId).map((f) => f.matchId);
  const sumRuns = ids.reduce((s, id) => s + (get(`SELECT COALESCE(SUM(b.runs),0) AS r FROM balls b JOIN innings i ON i.id = b.innings_id WHERE i.match_id = ? AND i.super_over = 0 AND b.voided = 0`, id).r), 0);
  assert.equal(v.stats.runs, sumRuns, 'tournament runs = sum of deliveries');
  summary.push(`groups+knockout: champion ${v.champion.name}, ${v.progress.played} matches`);
}

// 2. Round robin with a final (league), double round, ODI-style settings shortened via custom overs; 5 teams (odd number).
{
  const tid = TOUR.createTournament(owner, { kind: 'league', name: 'League', teams: [...TEAMS(4), { name: 'Gully Kings' }], humanIndex: 4, structure: { legs: 2, qualify: 2 }, match: { format: 'custom', overs: 2, wickets: 2, aiLevel: 'medium', aiPersonality: 'aggressive' } });
  let v = TOUR.view(tid, owner);
  assert.equal(v.fixtures.filter((f) => f.stage === 'group').length, 20, '5 teams, home and away: 20 matches');
  assert.equal(v.fixtures.filter((f) => f.stage === 'knockout').length, 1, 'top two meet in a final');
  assert.ok(v.teams.filter((t) => !t.human).every((t) => t.personality === 'aggressive'));
  v = await runTournament(owner, tid, 7);
  checkTable(v, tid); checkFinished(v, 'league');
  const final = v.fixtures.find((f) => f.roundName === 'Final');
  assert.deepEqual([final.home, final.away], v.groups[0].rows.slice(0, 2).map((r) => r.key), 'final is first v second');
  summary.push(`league: champion ${v.champion.name}`);
}

// 3. Pure league, winner takes all (no knockout).
{
  const tid = TOUR.createTournament(owner, { kind: 'league', name: 'Table', teams: TEAMS(4), humanIndex: 2, structure: { legs: 1, qualify: 1 }, match: { format: 'custom', overs: 1, wickets: 2 } });
  let v = TOUR.view(tid, owner);
  assert.equal(v.fixtures.length, 6);
  v = await runTournament(owner, tid, 8);
  checkTable(v, tid); checkFinished(v, 'table');
  summary.push(`league table: champion ${v.champion.name}`);
}

// 4. Knockout with byes: 6 teams -> bracket of 8, top two seeds get byes.
{
  const tid = TOUR.createTournament(owner, { kind: 'knockout', name: 'Cup', teams: TEAMS(6), humanIndex: 5, structure: { thirdPlace: false }, match: { format: 'custom', overs: 2, wickets: 3, aiLevel: 'expert' } });
  let v = TOUR.view(tid, owner);
  assert.equal(v.fixtures.filter((f) => f.status === 'bye').length, 2, 'two byes');
  assert.ok(v.fixtures.filter((f) => f.status === 'bye').every((f) => ['T1', 'T2'].includes(f.winner)), 'top seeds get the byes');
  assert.deepEqual(v.bracket.map((r) => r.name), ['Quarter-final', 'Semi-final', 'Final']);
  v = await runTournament(owner, tid, 9);
  checkFinished(v, 'knockout');
  assert.equal(v.fixtures.filter((f) => f.status === 'completed').length, 5, 'n - 1 matches played');
  summary.push(`knockout: champion ${v.champion.name}`);
}

// 5. Custom: 4 groups of 3, group winners only, IPL + international + custom teams, ball-by-ball for the human.
{
  const teams = [...TEAMS(10).slice(0, 6), { teamId: 'ipl-csk' }, { teamId: 'ipl-mi' }, { teamId: 'ipl-rcb' }, { teamId: 'ipl-kkr' }, { name: 'Street XI' }, { name: 'Lane Lions' }];
  const tid = TOUR.createTournament(owner, { kind: 'custom', name: 'Mixed', teams, humanIndex: 10, structure: { groups: 4, legs: 1, qualify: 1, thirdPlace: true }, match: { format: 'custom', overs: 1, wickets: 2, play: 'ball' } });
  let v = TOUR.view(tid, owner);
  assert.deepEqual(v.groups.map((g) => g.rows.length), [3, 3, 3, 3]);
  assert.equal(v.fixtures.filter((f) => f.stage === 'group').length, 12);
  v = await runTournament(owner, tid, 10);
  checkTable(v, tid); checkFinished(v, 'custom');
  summary.push(`custom: champion ${v.champion.name}`);
}

// 6. Real T20 and ODI settings (full overs) for a small knockout, real squads where synced.
for (const format of ['t20', 'odi']) {
  const tid = TOUR.createTournament(owner, { kind: 'knockout', name: format, teams: TEAMS(4), humanIndex: 1, match: { format, wickets: 3, xiSize: 5 } });
  const v0 = TOUR.view(tid, owner);
  assert.equal(v0.settings.overs, format === 't20' ? 20 : 50);
  const v = await runTournament(owner, tid, 11);
  checkFinished(v, format);
  const m = G.loadMatch(v.fixtures.at(-1).matchId);
  assert.equal(m.config.overs, format === 't20' ? 20 : 50);
  assert.equal(m.config.untilWinner, true, 'knockouts play super overs until there is a winner');
}

// 7. Repeated super overs: a knockout tie goes to a second super over until someone wins.
{
  const tid = TOUR.createTournament(owner, { kind: 'knockout', name: 'Tie', teams: TEAMS(2), humanIndex: 0, match: { format: 'custom', overs: 1, wickets: 1 } });
  const mid = TOUR.playNext(owner, tid);
  // Toss straight to the human batting first, then script both sides (the AI side through the same engine calls).
  let st = G.publicState(mid);
  G.confirmLineup(owner, mid, 'A', ctx()); while (AI.aiStep(mid) && G.publicState(mid).stage !== 'toss_call' && G.publicState(mid).stage !== 'toss_decision');
  for (let g = 0; g < 10; g++) {
    st = G.publicState(mid);
    if (st.status === 'live') break;
    if (st.stage === 'toss_call' && st.captains[st.toss.caller] === owner) G.callToss(owner, mid, 'heads', ctx());
    else if (st.stage === 'toss_decision' && st.captains[st.toss.winner] === owner) G.decideToss(owner, mid, 'bat', ctx());
    else if (!AI.aiStep(mid)) break;
  }
  st = G.publicState(mid);
  const bot = st.members.find((x) => x.bot).id;
  const batterOf = () => { const s = G.publicState(mid); return s.current.strikerId === owner || s.members.find((x) => x.id === s.current.strikerId)?.controller === owner ? owner : bot; };
  const over = (batSeq) => { const s = G.publicState(mid); const bat = batterOf(); const bowl = bat === owner ? bot : owner; G.submitOver(bowl, mid, [2, 3, 4, 5, 6, 2].slice(0, s.current.cap), ctx()); G.submitOver(bat, mid, batSeq.slice(0, s.current.cap), ctx()); };
  for (let k = 0; k < 4; k++) over([1, 1, 1, 1, 1, 1]); // match tied (6 v 6), then the super over tied (6 v 6)
  st = G.publicState(mid);
  assert.equal(st.innings.length, 5, 'a second super over after the first one tied');
  assert.ok(st.innings[4].superOver && st.innings[4].batting === st.innings[3].batting, 'the side that batted second in the last super over bats first');
  over([6, 6, 6, 6, 6, 6]); // 36 in the first half of the next super over
  over([1, 1, 1, 1, 1, 2]); // the chase falls short
  st = G.publicState(mid);
  assert.equal(st.status, 'completed'); assert.ok(st.result.winner, 'a winner, eventually');
  const v = TOUR.view(tid, owner);
  assert.equal(v.status, 'completed'); assert.equal(v.fixtures[0].decidedBy, 'result');
}

// 8. Fairness: no declaring results or adjusting scores in a tournament match; you can only abandon (no result).
{
  const tid = TOUR.createTournament(owner, { kind: 'knockout', name: 'Fair', teams: TEAMS(2), humanIndex: 0, match: { format: 'custom', overs: 2, wickets: 2 } });
  const mid = TOUR.playNext(owner, tid);
  assert.throws(() => G.umpireAction(owner, mid, { type: 'end', outcome: 'A' }, ctx()), /decided on the field/);
  assert.throws(() => TOUR.playNext(user('Stranger'), tid), /Only the player who created/);
  G.umpireAction(owner, mid, { type: 'end', outcome: 'abandon' }, ctx());
  const v = TOUR.view(tid, owner);
  assert.equal(v.status, 'completed');
  assert.equal(v.fixtures[0].decidedBy, 'seeding', 'an abandoned knockout goes to the higher seed');
  assert.equal(v.champion.key, 'T1');
}

// 9. Validation.
assert.throws(() => TOUR.createTournament(owner, { kind: 'groups', teams: TEAMS(5), humanIndex: 0, structure: { groups: 3 } }), /groups of at least two/);
assert.throws(() => TOUR.createTournament(owner, { kind: 'knockout', teams: [{ teamId: 'int-ind' }, { teamId: 'int-ind' }], humanIndex: 0 }), /twice/);
assert.throws(() => TOUR.createTournament(owner, { kind: 'knockout', teams: TEAMS(3) }), /which team is yours/);

// 10. Persistence: exit mid-tournament and continue in a brand-new server process from the saved state.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcl-tour-'));
  const db = path.join(dir, 't.db');
  const script = path.join(dir, 'step.mjs');
  const root = path.resolve('.');
  fs.writeFileSync(script, `
    process.env.DB_PATH = ${JSON.stringify(db)};
    const T = await import(${JSON.stringify(path.join(root, 'server/tournament.js'))});
    const G = await import(${JSON.stringify(path.join(root, 'server/engine.js'))});
    const AI = await import(${JSON.stringify(path.join(root, 'server/ai.js'))});
    const C = await import(${JSON.stringify(path.join(root, 'server/cricketdb.js'))});
    const { run, get } = await import(${JSON.stringify(path.join(root, 'server/db.js'))});
    const B = await import(${JSON.stringify(path.join(root, 'server/aibrain.js'))});
    C.seedIfEmpty();
    const [mode, tidArg] = process.argv.slice(2);
    let tid = tidArg;
    if (mode === 'start') {
      run('INSERT INTO users (id, display_name, is_guest, created_at) VALUES (?,?,1,?)', 'p', 'P', Date.now());
      tid = T.createTournament('p', { kind: 'groups', name: 'Persist', teams: ['int-ind','int-aus','int-eng','int-pak'].map((teamId) => ({ teamId })), humanIndex: 0, structure: { groups: 2, qualify: 1 }, match: { format: 'custom', overs: 1, wickets: 2 } });
    }
    // Play until the human's match is half-way through (start) or to the end (finish).
    for (let g = 0; g < 500; g++) {
      const v = T.view(tid, 'p');
      if (v.status === 'completed') break;
      if (!v.next.human) { T.simulate('p', tid); while (T.jobOf(tid)?.running) await new Promise((r) => setTimeout(r, 2)); continue; }
      const mid = T.playNext('p', tid);
      for (let k = 0; k < 400; k++) {
        while (AI.aiStep(mid));
        const s = G.publicState(mid);
        if (s.status === 'completed') break;
        if (s.status === 'lobby') { if (!s.lineups.A.confirmedAt) G.confirmLineup('p', mid, 'A', G.newCtx()); else if (s.stage === 'toss_call') G.callToss('p', mid, 'heads', G.newCtx()); else if (s.stage === 'toss_decision') G.decideToss('p', mid, 'bat', G.newCtx()); continue; }
        const bowled = s.innings.reduce((a, i) => a + i.balls, 0);
        if (mode === 'start' && bowled >= 1 && s.status === 'live') { console.log(JSON.stringify({ tid, mid, balls: bowled })); process.exit(0); }
        const c = s.current, mine = (pid) => pid === 'p' || s.members.find((x) => x.id === pid)?.controller === 'p';
        const bw = c.open ? c.set.bowlerId : c.bowlerId;
        const role = mine(bw) && !(c.open && c.set.bowlerLocked) ? 'bowl' : 'bat';
        const seq = role === 'bowl' ? [1,2,3,4,5,6].filter((d, i, a) => true).slice(0, c.cap) : Array(c.cap).fill(4);
        G.submitOver('p', mid, seq, G.newCtx());
      }
    }
    const v = T.view(tid, 'p');
    console.log(JSON.stringify({ tid, status: v.status, champion: v.champion?.name, played: v.progress.played }));
  `);
  const out1 = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", script, "start"], { encoding: "utf8" });
  const first = JSON.parse(out1.trim().split("\n").pop());
  assert.ok(first.mid && first.balls >= 1, 'stopped part-way through the human match');
  const second = JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, 'finish', first.tid], { encoding: 'utf8' }).trim().split('\n').pop());
  assert.equal(second.status, 'completed', 'a new process carried on from the saved state to a champion');
  assert.ok(second.champion);
  fs.rmSync(dir, { recursive: true, force: true });
  summary.push(`persistence: resumed in a new process, champion ${second.champion}`);
}

for (const s of summary) console.log(`  ${s}`);
console.log('✔ all tournament tests passed');
process.exit(0);
