// Tournaments: one human team against AI teams. Every fixture is a real match through the engine:
// the human plays theirs in the normal match screen; AI v AI fixtures are played out ball by ball by the
// same AI, rules and validation. Standings, net run rate, qualification and the bracket are always
// recomputed from completed matches, so they can never drift from the record.
import crypto from 'node:crypto';
import { all, get, run, tx } from './db.js';
import * as G from './engine.js';
import { aiStep } from './ai.js';
import { getTeam } from './cricketdb.js';
import { matchAnalysis } from './analytics.js';

const fail = (msg) => { throw new G.GameError(msg); };
const now = () => Date.now();
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const PERSONALITIES = ['strategic', 'aggressive', 'defensive', 'unpredictable'];
const LEVELS = ['easy', 'medium', 'hard', 'expert'];
const CUSTOM_COLORS = ['#7A4FD6', '#D6557A', '#2E9C8F', '#C9772E', '#4F7AD6', '#8FA33A', '#B04848', '#3A8FB0'];
export const KINDS = ['knockout', 'league', 'groups', 'custom'];
const GROUP_NAMES = 'ABCDEFGH';
const nextPow2 = (n) => { let p = 1; while (p < n) p *= 2; return p; };
const ordinalWord = (n) => ['', 'first', 'second', 'third', 'fourth'][n] || `${n}th`;

// ---------- creation ----------
function normalize(kind, input, n) {
  const int = (v, lo, hi, d) => { const x = parseInt(v, 10); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  const s = { thirdPlace: !!input.thirdPlace };
  if (kind === 'knockout') Object.assign(s, { groups: 0, legs: 1, qualify: n });
  else if (kind === 'league') Object.assign(s, { groups: 1, legs: int(input.legs, 1, 2, 1), qualify: [1, 2, 4].includes(+input.qualify) ? +input.qualify : 2 });
  else if (kind === 'groups') Object.assign(s, { groups: int(input.groups, 2, 4, 2), legs: 1, qualify: int(input.qualify, 1, 2, 2) });
  else Object.assign(s, { groups: int(input.groups, 0, 4, 2), legs: int(input.legs, 1, 2, 1), qualify: int(input.qualify, 1, 8, 2) });
  if (s.groups === 0) s.qualify = n;
  if (s.groups > 0) {
    const smallest = Math.floor(n / s.groups);
    if (smallest < 2) fail(`${n} teams can't be split into ${s.groups} groups of at least two.`);
    if (s.qualify > smallest) fail(`Only ${smallest} teams are in the smallest group, so at most ${smallest} can qualify from each.`);
  }
  if (kind === 'league' && s.qualify > n) fail(`There are only ${n} teams.`);
  return s;
}

function matchSettings(input) {
  const format = ['t20', 'odi', 'custom'].includes(input.format) ? input.format : 't20';
  const int = (v, lo, hi, d) => { const x = parseInt(v, 10); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  return {
    format, overs: format === 't20' ? 20 : format === 'odi' ? 50 : int(input.overs, 1, 50, 5),
    wickets: int(input.wickets, 1, 10, 10), play: input.play === 'ball' ? 'ball' : 'over',
    aiLevel: LEVELS.includes(input.aiLevel) ? input.aiLevel : 'medium',
    aiPersonality: PERSONALITIES.includes(input.aiPersonality) ? input.aiPersonality : 'mixed',
    xiSize: int(input.xiSize, 2, 11, 11),
  };
}

// Round robin by the circle method: every team once per round where possible.
function roundRobin(keys) {
  const arr = keys.length % 2 ? [...keys, null] : [...keys];
  const n = arr.length, rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i], b = arr[n - 1 - i];
      if (a && b) pairs.push(r % 2 ? [b, a] : [a, b]);
    }
    rounds.push(pairs);
    arr.splice(1, 0, arr.pop()); // rotate all but the first
  }
  return rounds;
}

// Standard bracket order for seeds 1..P (1 v P, then 2 v P-1 in the other half, …).
function bracketOrder(p) {
  let order = [1, 2];
  while (order.length < p) { const m = order.length * 2 + 1; order = order.flatMap((s) => [s, m - s]); }
  return order;
}

function roundName(teamsInRound) {
  return teamsInRound === 2 ? 'Final' : teamsInRound === 4 ? 'Semi-final' : teamsInRound === 8 ? 'Quarter-final' : `Round of ${teamsInRound}`;
}

export function createTournament(ownerId, body = {}) {
  const kind = KINDS.includes(body.kind) ? body.kind : fail('Pick a tournament format.');
  const name = String(body.name || '').trim().slice(0, 60) || 'My tournament';
  const list = Array.isArray(body.teams) ? body.teams : [];
  if (list.length < 2) fail('Pick at least two teams.');
  if (list.length > 16) fail('A tournament can have up to 16 teams.');
  const humanIndex = Number.isInteger(body.humanIndex) && body.humanIndex >= 0 && body.humanIndex < list.length ? body.humanIndex : fail('Pick which team is yours.');
  const structure = normalize(kind, body.structure || {}, list.length);
  const settings = { ...matchSettings(body.match || {}), ...structure };
  // Teams, from the latest synced team database (real) or named by the player (custom).
  const seen = new Set();
  const teams = list.map((t, i) => {
    if (t.teamId) {
      const real = getTeam(String(t.teamId));
      if (!real) fail('One of those teams is no longer in the team database. Pick again.');
      if (seen.has(real.id)) fail(`${real.name} is in the list twice.`);
      seen.add(real.id);
      return { name: real.name, short: real.short, color: real.color, logo: real.logo, country: real.country, category: real.category, teamId: real.id };
    }
    const nm = String(t.name || '').trim().slice(0, 30);
    if (nm.length < 2) fail('Give every custom team a name.');
    if (seen.has(nm.toLowerCase())) fail(`There are two teams called ${nm}.`);
    seen.add(nm.toLowerCase());
    return { name: nm, short: nm.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'TM', color: CUSTOM_COLORS[i % CUSTOM_COLORS.length], logo: null, country: null, category: 'custom', teamId: null };
  }).map((t, i) => ({ ...t, key: `T${i + 1}`, seed: i + 1, human: i === humanIndex }));
  // Groups by snake seeding, so the top seeds are spread out.
  if (settings.groups > 0) teams.forEach((t, i) => {
    const r = Math.floor(i / settings.groups), pos = i % settings.groups;
    t.group = GROUP_NAMES[r % 2 === 0 ? pos : settings.groups - 1 - pos];
  });
  let pi = 0;
  for (const t of teams) t.personality = t.human ? null : settings.aiPersonality === 'mixed' ? PERSONALITIES[pi++ % 4] : settings.aiPersonality;

  const id = crypto.randomBytes(5).toString('hex').toUpperCase();
  tx(() => {
    run('INSERT INTO tournaments (id, owner_id, name, kind, settings, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, ownerId, name, kind, JSON.stringify(settings), 'active', now(), now());
    for (const t of teams) run(`INSERT INTO tournament_teams (tournament_id, key, seed, name, short, color, logo, country, category, team_id, group_name, human, personality) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, t.key, t.seed, t.name, t.short, t.color, t.logo, t.country, t.category, t.teamId, t.group || null, t.human ? 1 : 0, t.personality);
    let order = 0;
    const fix = (f) => Number(run(`INSERT INTO tournament_fixtures (tournament_id, order_no, stage, round, round_name, group_name, slot, home, away, home_src, away_src, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, ++order, f.stage, f.round, f.roundName, f.group || null, f.slot || 0, f.home || null, f.away || null, f.homeSrc ? JSON.stringify(f.homeSrc) : null, f.awaySrc ? JSON.stringify(f.awaySrc) : null, f.status || 'pending').lastInsertRowid);
    // Group (league) stage: rounds interleaved across groups.
    let leagueRounds = 0;
    if (settings.groups > 0) {
      const byGroup = GROUP_NAMES.slice(0, settings.groups).split('').map((g) => {
        let rounds = roundRobin(teams.filter((t) => t.group === g).map((t) => t.key));
        if (settings.legs === 2) rounds = [...rounds, ...rounds.map((rd) => rd.map(([a, b]) => [b, a]))];
        return { g, rounds };
      });
      leagueRounds = Math.max(...byGroup.map((x) => x.rounds.length));
      for (let r = 0; r < leagueRounds; r++) for (const { g, rounds } of byGroup) for (const [home, away] of rounds[r] || [])
        fix({ stage: 'group', round: r + 1, roundName: settings.groups > 1 ? `Group ${g}, round ${r + 1}` : `Round ${r + 1}`, group: g, home, away, status: 'ready' });
    }
    // Knockout stage.
    const Q = settings.groups > 0 ? settings.groups * settings.qualify : teams.length;
    if (Q >= 2) {
      const groups = GROUP_NAMES.slice(0, settings.groups).split('');
      let firstRound; // list of [src, src]
      if (settings.groups >= 2 && settings.groups % 2 === 0 && settings.qualify === 2) {
        // Group winners meet runners-up from the paired group; teams from one group only meet again in the final.
        const top = [], bottom = [];
        for (let k = 0; k < groups.length; k += 2) {
          const [g1, g2] = [groups[k], groups[k + 1]];
          top.push([{ type: 'group', group: g1, rank: 1 }, { type: 'group', group: g2, rank: 2 }]);
          bottom.push([{ type: 'group', group: g2, rank: 1 }, { type: 'group', group: g1, rank: 2 }]);
        }
        firstRound = [...top, ...bottom];
      } else {
        const seeds = settings.groups > 0
          ? Array.from({ length: settings.qualify }, (_, r) => (r % 2 ? [...groups].reverse() : groups).map((g) => ({ type: 'group', group: g, rank: r + 1 }))).flat()
          : teams.map((t) => ({ type: 'seed', key: t.key }));
        const P = nextPow2(Q), order = bracketOrder(P);
        firstRound = [];
        for (let i = 0; i < P; i += 2) firstRound.push([order[i], order[i + 1]].map((s) => (s <= Q ? seeds[s - 1] : { type: 'bye' })));
      }
      const P = firstRound.length * 2;
      let prev = [];
      const totalRounds = Math.log2(P);
      for (let r = 1; r <= totalRounds; r++) {
        const inRound = P / 2 ** (r - 1);
        const ids = [];
        const count = inRound / 2;
        const thirdNow = settings.thirdPlace && inRound === 2 && prev.length === 2;
        if (thirdNow) fix({ stage: 'third', round: leagueRounds + r, roundName: 'Third-place play-off', homeSrc: { type: 'loser', fixture: prev[0] }, awaySrc: { type: 'loser', fixture: prev[1] } });
        for (let j = 0; j < count; j++) {
          const [hs, as] = r === 1 ? firstRound[j] : [{ type: 'winner', fixture: prev[2 * j] }, { type: 'winner', fixture: prev[2 * j + 1] }];
          ids.push(fix({ stage: 'knockout', round: leagueRounds + r, roundName: count > 1 ? `${roundName(inRound)} ${j + 1}` : roundName(inRound), slot: j, homeSrc: hs, awaySrc: as }));
        }
        prev = ids;
      }
    }
    syncIn(id);
  });
  return id;
}

// ---------- standings ----------
function inningsOf(matchId) {
  return all('SELECT * FROM innings WHERE match_id = ? AND super_over = 0 ORDER BY number', matchId).map((i) => ({ ...i, total: G.totals(i.id) }));
}
// Points: win 2, tie or no result 1. Net run rate: runs scored per over minus runs conceded per over;
// a side bowled out is counted as having faced its full quota of overs (ICC rule). No-result matches are left out of NRR.
export function standings(tid, group) {
  const teams = all('SELECT * FROM tournament_teams WHERE tournament_id = ? AND group_name = ? ORDER BY seed', tid, group);
  const fixtures = all(`SELECT * FROM tournament_fixtures WHERE tournament_id = ? AND stage = 'group' AND group_name = ?`, tid, group);
  const t = Object.fromEntries(teams.map((x) => [x.key, { key: x.key, name: x.name, short: x.short, color: x.color, logo: x.logo, country: x.country, human: !!x.human, seed: x.seed, played: 0, won: 0, lost: 0, tied: 0, noResult: 0, points: 0, runsFor: 0, ballsFaced: 0, runsAgainst: 0, ballsBowled: 0, remaining: 0, form: [] }]));
  for (const f of fixtures) {
    if (f.status !== 'completed') { if (t[f.home]) t[f.home].remaining++; if (t[f.away]) t[f.away].remaining++; continue; }
    const m = get('SELECT status, result FROM matches WHERE id = ?', f.match_id);
    const res = parse(m?.result, {}) || {};
    const keyOf = (side) => (side === 'A' ? f.side_a : f.side_a === f.home ? f.away : f.home);
    for (const k of [f.home, f.away]) t[k].played++;
    if (res.winner) {
      const w = keyOf(res.winner), l = w === f.home ? f.away : f.home;
      t[w].won++; t[w].points += 2; t[l].lost++; t[w].form.push('W'); t[l].form.push('L');
    } else if (res.tie) { for (const k of [f.home, f.away]) { t[k].tied++; t[k].points += 1; t[k].form.push('T'); } }
    else { for (const k of [f.home, f.away]) { t[k].noResult++; t[k].points += 1; t[k].form.push('N'); } }
    if (res.winner || res.tie) {
      for (const inn of inningsOf(f.match_id)) {
        const bat = keyOf(inn.batting), bowl = bat === f.home ? f.away : f.home;
        const balls = inn.total.wickets >= inn.max_wickets ? inn.max_balls : inn.total.balls;
        t[bat].runsFor += inn.total.runs; t[bat].ballsFaced += balls;
        t[bowl].runsAgainst += inn.total.runs; t[bowl].ballsBowled += balls;
      }
    }
  }
  const rows = Object.values(t).map((r) => {
    const nrr = (r.ballsFaced ? r.runsFor / (r.ballsFaced / 6) : 0) - (r.ballsBowled ? r.runsAgainst / (r.ballsBowled / 6) : 0);
    return { ...r, nrr: r.ballsFaced || r.ballsBowled ? +nrr.toFixed(3) : 0, maxPoints: r.points + 2 * r.remaining, form: r.form.slice(-5) };
  });
  rows.sort((a, b) => b.points - a.points || b.nrr - a.nrr || b.won - a.won || a.seed - b.seed);
  return { complete: fixtures.length > 0 && fixtures.every((f) => f.status === 'completed'), rows };
}

// Qualification: certain once no result can change it (on points alone), otherwise where they stand now.
function withQualification(table, qualify, finalStage) {
  return table.rows.map((r, i) => {
    let status;
    if (table.complete) status = i < qualify ? 'qualified' : 'eliminated';
    else {
      const others = table.rows.filter((x) => x.key !== r.key);
      if (others.filter((x) => x.maxPoints >= r.points).length < qualify) status = 'qualified';
      else if (others.filter((x) => x.points > r.maxPoints).length >= qualify) status = 'eliminated';
      else status = i < qualify ? 'in' : 'out';
    }
    return { ...r, rank: i + 1, status, champion: finalStage && table.complete && i === 0 };
  });
}

// ---------- keeping the tournament up to date ----------
function teamRow(tid, key) { return get('SELECT * FROM tournament_teams WHERE tournament_id = ? AND key = ?', tid, key); }

function syncIn(tid) {
  const T = get('SELECT * FROM tournaments WHERE id = ?', tid);
  if (!T) return;
  const settings = parse(T.settings, {});
  for (let guard = 0; guard < 100; guard++) {
    let changed = false;
    // 1. Matches that have finished.
    for (const f of all(`SELECT * FROM tournament_fixtures WHERE tournament_id = ? AND status = 'live'`, tid)) {
      const m = get('SELECT status, result FROM matches WHERE id = ?', f.match_id);
      if (!m || (m.status !== 'completed' && m.status !== 'abandoned')) continue;
      const res = parse(m.result, {}) || {};
      const keyOf = (side) => (side === 'A' ? f.side_a : f.side_a === f.home ? f.away : f.home);
      let winner = res.winner ? keyOf(res.winner) : null, decided = 'result', text = res.text || 'No result.';
      if (!winner && f.stage !== 'group') {
        // A knockout must produce a team to go through: with no result on the field, the higher seed advances.
        const [h, a] = [teamRow(tid, f.home), teamRow(tid, f.away)];
        winner = h.seed < a.seed ? h.key : a.key; decided = 'seeding';
        text = `${text} ${teamRow(tid, winner).name} go through as the higher seed.`;
      }
      run(`UPDATE tournament_fixtures SET status = 'completed', winner = ?, decided_by = ?, result_text = ?, completed_at = ? WHERE id = ?`, winner, decided, text, now(), f.id);
      changed = true;
    }
    // 2. Knockout places that can now be filled.
    const groupTables = {};
    const tableFor = (g) => (groupTables[g] ??= standings(tid, g));
    for (const f of all(`SELECT * FROM tournament_fixtures WHERE tournament_id = ? AND status = 'pending' ORDER BY order_no`, tid)) {
      const resolve = (src) => {
        if (!src) return null;
        if (src.type === 'seed') return src.key;
        if (src.type === 'bye') return 'BYE';
        if (src.type === 'group') { const tb = tableFor(src.group); return tb.complete ? tb.rows[src.rank - 1]?.key || 'BYE' : null; }
        const g = get('SELECT * FROM tournament_fixtures WHERE id = ?', src.fixture);
        if (g?.status !== 'completed' && g?.status !== 'bye') return null;
        if (src.type === 'winner') return g.winner;
        return g.status === 'bye' ? 'BYE' : g.winner === g.home ? g.away : g.home;
      };
      const h = f.home || resolve(parse(f.home_src)), a = f.away || resolve(parse(f.away_src));
      if (h !== f.home || a !== f.away) { run('UPDATE tournament_fixtures SET home = ?, away = ? WHERE id = ?', h === 'BYE' ? null : h, a === 'BYE' ? null : a, f.id); }
      if (h && a) {
        if (h === 'BYE' || a === 'BYE') {
          const w = h === 'BYE' ? (a === 'BYE' ? null : a) : h;
          run(`UPDATE tournament_fixtures SET status = 'bye', winner = ?, decided_by = 'bye', result_text = ?, completed_at = ? WHERE id = ?`, w, w ? `${teamRow(tid, w).name} go through with a bye.` : 'No teams.', now(), f.id);
        } else run(`UPDATE tournament_fixtures SET status = 'ready' WHERE id = ?`, f.id);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // 3. The champion.
  if (T.status === 'active') {
    const final = get(`SELECT * FROM tournament_fixtures WHERE tournament_id = ? AND stage = 'knockout' ORDER BY round DESC, order_no DESC LIMIT 1`, tid);
    let champion = null;
    if (final) { if (final.status === 'completed' || final.status === 'bye') champion = final.winner; }
    else if (settings.groups > 0) { const tb = standings(tid, 'A'); if (tb.complete) champion = tb.rows[0].key; }
    const left = get(`SELECT COUNT(*) AS c FROM tournament_fixtures WHERE tournament_id = ? AND status NOT IN ('completed', 'bye')`, tid).c;
    if (champion && left === 0) run(`UPDATE tournaments SET status = 'completed', champion = ?, completed_at = ?, updated_at = ? WHERE id = ?`, champion, now(), now(), tid);
  }
}
export const sync = (tid) => tx(() => syncIn(tid));

// ---------- playing fixtures ----------
export function nextFixture(tid) {
  return get(`SELECT * FROM tournament_fixtures WHERE tournament_id = ? AND status IN ('ready', 'live') ORDER BY order_no LIMIT 1`, tid);
}
const humanKey = (tid) => get('SELECT key FROM tournament_teams WHERE tournament_id = ? AND human = 1', tid)?.key;
const involvesHuman = (tid, f) => f && (f.home === humanKey(tid) || f.away === humanKey(tid));

function startFixture(T, f) {
  if (f.match_id) return f.match_id;
  const settings = parse(T.settings, {});
  const hk = humanKey(T.id);
  const [aKey, bKey] = f.away === hk ? [f.away, f.home] : [f.home, f.away]; // the human is always side A
  const side = (key) => {
    const t = teamRow(T.id, key);
    return { realId: t.team_id || null, name: t.name, short: t.short, color: t.color, human: !!t.human, level: settings.aiLevel, personality: t.personality || 'strategic' };
  };
  const human = aKey === hk;
  const matchId = G.createTournamentMatch(T.owner_id, {
    name: `${T.name}: ${f.round_name}`,
    config: { format: settings.format, overs: settings.overs, wickets: settings.wickets, play: human ? settings.play : 'over', superOver: true, untilWinner: f.stage !== 'group', xiSize: settings.xiSize, noConsecutive: true },
    sides: { A: side(aKey), B: side(bKey) },
    tournament: { id: T.id, name: T.name, fixtureId: f.id, label: `${T.name}, ${f.round_name}` },
  });
  run(`UPDATE tournament_fixtures SET match_id = ?, side_a = ?, status = 'live' WHERE id = ?`, matchId, aKey, f.id);
  run('UPDATE tournaments SET updated_at = ? WHERE id = ?', now(), T.id);
  return matchId;
}

// The human's next match: created (or reopened) only when every earlier fixture has been played.
export function playNext(userId, tid) {
  const T = ownTournament(userId, tid);
  sync(tid);
  const f = nextFixture(tid);
  if (!f) fail('There are no more matches to play.');
  if (!involvesHuman(tid, f)) fail('Other matches come first. Play them, then your match is next.');
  return startFixture(T, f);
}

// Play out AI v AI fixtures, ball by ball through the engine, up to the human's next match (or the end).
const jobs = new Map();
export function jobOf(tid) { return jobs.get(tid) || null; }
export function simulate(userId, tid, { limit = Infinity } = {}) {
  const T = ownTournament(userId, tid);
  if (T.status !== 'active') fail('This tournament has finished.');
  if (jobs.get(tid)?.running) return jobs.get(tid);
  const job = { running: true, played: 0, current: null, error: null, startedAt: now() };
  jobs.set(tid, job);
  (async () => {
    try {
      for (;;) {
        sync(tid);
        const f = nextFixture(tid);
        if (!f || involvesHuman(tid, f) || job.played >= limit) break;
        job.current = f.round_name;
        const matchId = startFixture(get('SELECT * FROM tournaments WHERE id = ?', tid), f);
        await playOut(matchId);
        job.played++;
      }
      sync(tid);
    } catch (e) { job.error = e.message; console.error('Tournament simulation error', e); }
    job.running = false; job.current = null;
  })();
  return job;
}
// Run an AI v AI match to the end: every action is the AI acting through the engine, exactly as against a person.
export async function playOut(matchId) {
  for (let steps = 0; ; steps++) {
    const r = aiStep(matchId);
    if (!r) {
      const m = get('SELECT status FROM matches WHERE id = ?', matchId);
      if (m.status === 'completed' || m.status === 'abandoned') return;
      throw new Error(`AI match ${matchId} is stuck at ${m.status}.`);
    }
    if (steps % 25 === 24) await new Promise((res) => setImmediate(res)); // let other requests through
    if (steps > 20000) throw new Error(`AI match ${matchId} did not finish.`);
  }
}

function ownTournament(userId, tid) {
  const T = get('SELECT * FROM tournaments WHERE id = ?', tid);
  if (!T) fail('No tournament with that code.');
  if (T.owner_id !== userId) fail('Only the player who created this tournament can play it.');
  return T;
}
export function abandon(userId, tid) {
  const T = ownTournament(userId, tid);
  if (T.status !== 'active') fail('This tournament has already finished.');
  run(`UPDATE tournaments SET status = 'abandoned', updated_at = ? WHERE id = ?`, now(), tid);
}

// ---------- tournament statistics (from the deliveries of its matches) ----------
function tournamentStats(tid, teams) {
  const fx = all(`SELECT * FROM tournament_fixtures WHERE tournament_id = ? AND status = 'completed' AND match_id IS NOT NULL`, tid);
  const byName = Object.fromEntries(teams.map((t) => [t.key, t]));
  const players = new Map(), knocks = new Map(), spells = new Map(), totals = [];
  let runs = 0, wickets = 0, sixes = 0, fours = 0, balls = 0;
  for (const f of fx) {
    const keyOf = (side) => (side === 'A' ? f.side_a : f.side_a === f.home ? f.away : f.home);
    const humanName = get(`SELECT u.display_name AS n FROM members mb JOIN users u ON u.id = mb.user_id WHERE mb.match_id = ? AND u.is_bot = 0 AND u.is_ghost = 0 AND mb.team IS NOT NULL`, f.match_id)?.n;
    for (const inn of all('SELECT * FROM innings WHERE match_id = ? AND super_over = 0', f.match_id)) {
      const t = G.totals(inn.id);
      totals.push({ team: byName[keyOf(inn.batting)].name, against: byName[keyOf(inn.batting === 'A' ? 'B' : 'A')].name, runs: t.runs, wickets: t.wickets, overs: G.oversText(t.balls), matchId: f.match_id, round: f.round_name });
      for (const b of all(`SELECT b.*, ub.display_name AS bn, ub.player_id AS bp, ub.is_ghost AS bg, uw.display_name AS wn, uw.player_id AS wp, uw.is_ghost AS wg
          FROM balls b JOIN users ub ON ub.id = b.batter_id JOIN users uw ON uw.id = b.bowler_id WHERE b.innings_id = ? AND b.voided = 0 ORDER BY b.id`, inn.id)) {
        const bk = keyOf(inn.batting), wk = keyOf(inn.bowling);
        // One entry per player: squad players by their player record; a one-player custom side is the team itself.
        const who = (team, name, pid, ghost) => ({ id: `${team}:${ghost ? pid || name : 'solo'}`, name: ghost ? name : byName[team].human ? humanName || byName[team].name : byName[team].name, team });
        const bat = who(bk, b.bn, b.bp, b.bg), bowl = who(wk, b.wn, b.wp, b.wg);
        for (const p of [bat, bowl]) if (!players.has(p.id)) players.set(p.id, { ...p, teamName: byName[p.team].name, runs: 0, balls: 0, outs: 0, sixes: 0, fours: 0, wickets: 0, bowled: 0, conceded: 0 });
        const P = players.get(bat.id), W = players.get(bowl.id);
        P.runs += b.runs; P.balls++; if (b.is_wicket) P.outs++; if (b.runs === 6) P.sixes++; if (b.runs === 4) P.fours++;
        W.bowled++; W.conceded += b.runs; if (b.is_wicket && b.dismissal !== 'dot_rule') W.wickets++;
        const kk = `${inn.id}:${b.stint}:${b.batter_id}`;
        if (!knocks.has(kk)) knocks.set(kk, { name: P.name, teamName: P.teamName, runs: 0, balls: 0, out: false, matchId: f.match_id, round: f.round_name });
        const K = knocks.get(kk); K.runs += b.runs; K.balls++; if (b.is_wicket) K.out = true;
        const sk = `${inn.id}:${b.bowler_id}`;
        if (!spells.has(sk)) spells.set(sk, { name: W.name, teamName: W.teamName, wickets: 0, runs: 0, balls: 0, matchId: f.match_id, round: f.round_name });
        const S = spells.get(sk); S.balls++; S.runs += b.runs; if (b.is_wicket && b.dismissal !== 'dot_rule') S.wickets++;
        runs += b.runs; balls++; if (b.is_wicket) wickets++; if (b.runs === 6) sixes++; if (b.runs === 4) fours++;
      }
    }
  }
  const ps = [...players.values()];
  const top = (arr, key, filt = () => true) => [...arr].filter(filt).sort(key).slice(0, 5);
  return {
    matches: fx.length, runs, wickets, sixes, fours, balls, overs: G.oversText(balls),
    mostRuns: top(ps, (a, b) => b.runs - a.runs || a.balls - b.balls, (p) => p.balls > 0).map((p) => ({ name: p.name, team: p.teamName, runs: p.runs, balls: p.balls, average: p.outs ? +(p.runs / p.outs).toFixed(2) : null, strikeRate: p.balls ? +((p.runs * 100) / p.balls).toFixed(1) : null })),
    mostWickets: top(ps, (a, b) => b.wickets - a.wickets || a.conceded - b.conceded, (p) => p.wickets > 0).map((p) => ({ name: p.name, team: p.teamName, wickets: p.wickets, runs: p.conceded, overs: G.oversText(p.bowled), economy: p.bowled ? +((p.conceded * 6) / p.bowled).toFixed(2) : null })),
    mostSixes: top(ps, (a, b) => b.sixes - a.sixes, (p) => p.sixes > 0).map((p) => ({ name: p.name, team: p.teamName, sixes: p.sixes })),
    highestScores: top([...knocks.values()], (a, b) => b.runs - a.runs || a.balls - b.balls, (k) => k.runs > 0),
    bestBowling: top([...spells.values()], (a, b) => b.wickets - a.wickets || a.runs - b.runs, (s) => s.wickets > 0).map((s) => ({ ...s, overs: G.oversText(s.balls) })),
    highestTotals: top(totals, (a, b) => b.runs - a.runs),
    lowestTotals: top(totals, (a, b) => a.runs - b.runs),
  };
}

// ---------- the dashboard ----------
export function view(tid, viewerId) {
  const T = get('SELECT * FROM tournaments WHERE id = ?', tid);
  if (!T) return null;
  if (T.status === 'active') sync(tid);
  const t = get('SELECT * FROM tournaments WHERE id = ?', tid);
  const settings = parse(t.settings, {});
  const teams = all('SELECT * FROM tournament_teams WHERE tournament_id = ? ORDER BY seed', tid)
    .map((x) => ({ key: x.key, seed: x.seed, name: x.name, short: x.short, color: x.color, logo: x.logo, country: x.country, category: x.category, teamId: x.team_id, group: x.group_name, human: !!x.human, personality: x.personality }));
  const byKey = Object.fromEntries(teams.map((x) => [x.key, x]));
  const describeSrc = (src) => {
    if (!src) return null;
    if (src.type === 'group') return `${src.rank === 1 ? 'Winner' : src.rank === 2 ? 'Runner-up' : `${ordinalWord(src.rank)} place`}${settings.groups > 1 ? `, group ${src.group}` : ''}`;
    if (src.type === 'bye') return 'Bye';
    if (src.type === 'seed') return byKey[src.key]?.name;
    const g = get('SELECT round_name FROM tournament_fixtures WHERE id = ?', src.fixture);
    return `${src.type === 'winner' ? 'Winner' : 'Loser'}, ${g?.round_name || 'previous round'}`;
  };
  const fixtures = all('SELECT * FROM tournament_fixtures WHERE tournament_id = ? ORDER BY order_no', tid).map((f) => {
    const m = f.match_id ? get('SELECT status, result FROM matches WHERE id = ?', f.match_id) : null;
    const score = f.match_id ? all('SELECT * FROM innings WHERE match_id = ? ORDER BY number', f.match_id).map((i) => {
      const tt = G.totals(i.id);
      const key = i.batting === 'A' ? f.side_a : f.side_a === f.home ? f.away : f.home;
      return { team: key, superOver: !!i.super_over, runs: tt.runs, wickets: tt.wickets, overs: G.oversText(tt.balls) };
    }) : [];
    return {
      id: f.id, order: f.order_no, stage: f.stage, round: f.round, roundName: f.round_name, group: f.group_name, slot: f.slot,
      home: f.home, away: f.away, homeLabel: f.home ? byKey[f.home].name : describeSrc(parse(f.home_src)), awayLabel: f.away ? byKey[f.away].name : describeSrc(parse(f.away_src)),
      status: f.status, matchId: f.match_id, matchStatus: m?.status || null, winner: f.winner, decidedBy: f.decided_by, result: f.result_text, score,
      human: !!(f.home && byKey[f.home]?.human) || !!(f.away && byKey[f.away]?.human),
    };
  });
  const groups = settings.groups > 0 ? GROUP_NAMES.slice(0, settings.groups).split('').map((g) => {
    const tb = standings(tid, g);
    const noKnockout = !fixtures.some((f) => f.stage !== 'group');
    return { name: g, complete: tb.complete, qualify: settings.qualify, rows: withQualification(tb, settings.qualify, noKnockout) };
  }) : [];
  const ko = fixtures.filter((f) => f.stage === 'knockout');
  const rounds = [...new Set(ko.map((f) => f.round))].map((r) => ({ round: r, name: ko.find((f) => f.round === r).roundName.replace(/ \d+$/, ''), fixtures: ko.filter((f) => f.round === r) }));
  const next = nextFixture(tid);
  const hk = humanKey(tid);
  const nextHuman = fixtures.find((f) => (f.status === 'ready' || f.status === 'live' || f.status === 'pending') && (f.home === hk || f.away === hk));
  const aiBefore = next && !involvesHuman(tid, next) ? fixtures.filter((f) => (f.status === 'ready' || f.status === 'live') && !f.human && (!nextHuman || f.order < nextHuman.order)).length : 0;
  // Is the human team still in it? Out once eliminated from its group or beaten in the knockout,
  // and with no fixture left to play (a beaten semi-finalist may still have the third-place play-off).
  const myRow = groups.flatMap((g) => g.rows).find((r) => r.key === hk);
  const beaten = fixtures.some((x) => x.stage === 'knockout' && x.status === 'completed' && (x.home === hk || x.away === hk) && x.winner !== hk);
  const hasFixture = fixtures.some((x) => ['ready', 'live', 'pending'].includes(x.status) && (x.home === hk || x.away === hk));
  const humanOut = t.status === 'active' && ((myRow?.status === 'eliminated') || beaten) && !hasFixture;
  const finalFx = [...ko].reverse()[0];
  const final = finalFx?.status === 'completed' && finalFx.matchId ? matchAnalysis(finalFx.matchId) : null;
  return {
    id: t.id, name: t.name, kind: t.kind, status: t.status, owner: t.owner_id === viewerId, createdAt: t.created_at, updatedAt: t.updated_at, completedAt: t.completed_at,
    champion: t.champion ? byKey[t.champion] : null, settings, teams, fixtures, groups, bracket: rounds,
    third: fixtures.find((f) => f.stage === 'third') || null,
    next: next ? { id: next.id, human: involvesHuman(tid, next), roundName: next.round_name, matchId: next.match_id } : null,
    nextHuman: nextHuman || null, aiBefore, humanOut,
    progress: { played: fixtures.filter((f) => f.status === 'completed').length, total: fixtures.filter((f) => f.status !== 'bye').length },
    job: jobOf(tid), stats: tournamentStats(tid, teams),
    final: final && { matchId: finalFx.matchId, result: final.result?.text, innings: final.innings.map((i) => ({ number: i.number, superOver: i.superOver, battingName: i.battingName, runs: i.runs, wickets: i.wickets, overs: i.overs, battingCard: i.battingCard, bowlingCard: i.bowlingCard })), bestBatter: final.bestBatter, bestBowler: final.bestBowler },
  };
}
export function listMine(userId) {
  return all(`SELECT t.*, (SELECT name FROM tournament_teams WHERE tournament_id = t.id AND human = 1) AS my_team,
      (SELECT name FROM tournament_teams WHERE tournament_id = t.id AND key = t.champion) AS champion_name,
      (SELECT COUNT(*) FROM tournament_fixtures WHERE tournament_id = t.id AND status = 'completed') AS played,
      (SELECT COUNT(*) FROM tournament_fixtures WHERE tournament_id = t.id AND status <> 'bye') AS total
    FROM tournaments t WHERE t.owner_id = ? ORDER BY t.updated_at DESC LIMIT 30`, userId)
    .map((t) => ({ id: t.id, name: t.name, kind: t.kind, status: t.status, myTeam: t.my_team, champion: t.champion_name, played: t.played, total: t.total, updatedAt: t.updated_at }));
}
