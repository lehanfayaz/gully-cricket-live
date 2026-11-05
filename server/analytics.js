// Statistics, match analysis, ball-by-ball replay and highlights.
// Everything here is derived from the saved, revealed deliveries (the balls table) plus the
// umpire's recorded run adjustments. Nothing is estimated: if a record doesn't exist, the stat is absent.
import { all, get } from './db.js';

const overs = (b) => `${Math.floor(b / 6)}.${b % 6}`;
const ballLabel = (n) => `${Math.floor((n - 1) / 6)}.${((n - 1) % 6) + 1}`;
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(2));
const per = (a, b, k = 1) => (b ? r2((a * k) / b) : null);
const credited = (b) => b.is_wicket && b.dismissal !== 'dot_rule'; // wickets the bowler gets credit for
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const FORMAT_NAME = { test: 'Test', t20: 'T20', odi: 'ODI', custom: 'Custom overs' };

function teamNames(m) {
  const a = parse(m.team_a_meta), b = parse(m.team_b_meta);
  return { A: a?.name || m.team_a, B: b?.name || m.team_b };
}

// ---------- aggregations over a list of deliveries (shared by match and career views) ----------
// Batting: one knock = one batter's stint at the crease (the balls between two wickets).
export function battingFrom(balls) {
  const knocks = new Map();
  for (const b of balls) {
    const k = `${b.innings_id}:${b.stint}:${b.batter_id}`;
    if (!knocks.has(k)) knocks.set(k, { inningsId: b.innings_id, matchId: b.match_id, batterId: b.batter_id, name: b.batter_name, runs: 0, balls: 0, fours: 0, sixes: 0, dots: 0, out: false, dismissal: null, firstBallId: b.id, lastBallId: b.id });
    const x = knocks.get(k);
    x.runs += b.runs; x.balls++; x.lastBallId = b.id;
    if (b.runs === 4) x.fours++;
    if (b.runs === 6) x.sixes++;
    if (b.runs === 0) x.dots++;
    if (b.is_wicket) { x.out = true; x.dismissal = b.dismissal === 'dot_rule' ? 'dot-over rule' : `matched by ${b.bowler_name}`; x.bowler = b.bowler_name; }
  }
  const list = [...knocks.values()];
  const s = { innings: list.length, runs: 0, balls: 0, fours: 0, sixes: 0, dots: 0, dismissals: 0, notOuts: 0, ducks: 0, fifties: 0, hundreds: 0 };
  for (const k of list) {
    s.runs += k.runs; s.balls += k.balls; s.fours += k.fours; s.sixes += k.sixes; s.dots += k.dots;
    if (k.out) s.dismissals++; else s.notOuts++;
    if (k.out && k.runs === 0) s.ducks++;
    if (k.runs >= 100) s.hundreds++; else if (k.runs >= 50) s.fifties++;
  }
  const best = [...list].sort((a, b) => b.runs - a.runs || a.balls - b.balls)[0] || null;
  s.matches = new Set(list.map((k) => k.matchId)).size;
  s.highest = best ? { runs: best.runs, notOut: !best.out, balls: best.balls, matchId: best.matchId, name: best.name } : null;
  s.average = per(s.runs, s.dismissals);
  s.strikeRate = per(s.runs, s.balls, 100);
  return { summary: s, knocks: list };
}

// Bowling: figures per bowler per innings; maidens are complete six-ball overs by one bowler with no runs.
export function bowlingFrom(balls) {
  const spells = new Map(), oversMap = new Map();
  for (const b of balls) {
    const k = `${b.innings_id}:${b.bowler_id}`;
    if (!spells.has(k)) spells.set(k, { inningsId: b.innings_id, matchId: b.match_id, bowlerId: b.bowler_id, name: b.bowler_name, balls: 0, runs: 0, wickets: 0, dots: 0, maidens: 0 });
    const x = spells.get(k);
    x.balls++; x.runs += b.runs;
    if (credited(b)) x.wickets++;
    if (b.runs === 0) x.dots++;
    const ok = `${b.innings_id}:${Math.floor((b.ball_no - 1) / 6)}`;
    if (!oversMap.has(ok)) oversMap.set(ok, { key: k, balls: 0, runs: 0, bowlers: new Set() });
    const o = oversMap.get(ok);
    o.balls++; o.runs += b.runs; o.bowlers.add(b.bowler_id);
  }
  for (const o of oversMap.values()) if (o.balls === 6 && o.runs === 0 && o.bowlers.size === 1) spells.get(o.key).maidens++;
  const list = [...spells.values()];
  const s = { innings: list.length, balls: 0, runs: 0, wickets: 0, dots: 0, maidens: 0, fiveWickets: 0 };
  for (const x of list) { s.balls += x.balls; s.runs += x.runs; s.wickets += x.wickets; s.dots += x.dots; s.maidens += x.maidens; if (x.wickets >= 5) s.fiveWickets++; }
  const best = [...list].sort((a, b) => b.wickets - a.wickets || a.runs - b.runs)[0] || null;
  s.matches = new Set(list.map((x) => x.matchId)).size;
  s.overs = overs(s.balls);
  s.average = per(s.runs, s.wickets);
  s.economy = per(s.runs, s.balls, 6);
  s.strikeRate = per(s.balls, s.wickets);
  s.best = best ? { wickets: best.wickets, runs: best.runs, balls: best.balls, matchId: best.matchId, name: best.name } : null;
  return { summary: s, spells: list.map((x) => ({ ...x, overs: overs(x.balls), economy: per(x.runs, x.balls, 6) })) };
}

// ---------- one match ----------
function loadMatchRecord(matchId) {
  const m = get('SELECT * FROM matches WHERE id = ?', matchId);
  if (!m) return null;
  m.config = parse(m.config, {});
  m.result = parse(m.result);
  const innings = all('SELECT * FROM innings WHERE match_id = ? ORDER BY number', matchId);
  const balls = all(`SELECT b.*, i.match_id, i.number AS inn_no, ub.display_name AS batter_name, uw.display_name AS bowler_name, ms.day, ms.num AS session_num
      FROM balls b JOIN innings i ON i.id = b.innings_id
      LEFT JOIN users ub ON ub.id = b.batter_id LEFT JOIN users uw ON uw.id = b.bowler_id
      LEFT JOIN match_sessions ms ON ms.match_id = i.match_id AND ms.idx = b.session_idx
      WHERE i.match_id = ? ORDER BY i.number, b.id`, matchId);
  // Umpire run adjustments are not deliveries; they are placed in the innings they were made in, at the time they were made.
  const adjustments = all(`SELECT detail, created_at FROM audit WHERE match_id = ? AND action = 'adjust_runs' ORDER BY id`, matchId)
    .map((a) => ({ delta: parse(a.detail, {}).delta || 0, reason: parse(a.detail, {}).reason || 'Umpire adjustment', at: a.created_at }))
    .filter((a) => a.delta);
  for (const a of adjustments) a.inningsId = [...innings].reverse().find((i) => i.started_at <= a.at)?.id ?? innings[0]?.id;
  const controllers = Object.fromEntries(all('SELECT user_id, controller_id FROM members WHERE match_id = ? AND controller_id IS NOT NULL', matchId).map((r) => [r.user_id, r.controller_id]));
  return { m, innings, balls, adjustments, names: teamNames(m), controllers };
}

function inningsAnalysis(rec, inn) {
  const all_ = rec.balls.filter((b) => b.innings_id === inn.id);
  const balls = all_.filter((b) => !b.voided);
  const adj = rec.adjustments.filter((a) => a.inningsId === inn.id);
  const placed = adj.reduce((s, a) => s + a.delta, 0);
  // Adjustments whose time wasn't recorded (older matches) still count, as one unplaced entry.
  if (placed !== inn.extras) adj.push({ delta: inn.extras - placed, reason: 'Umpire adjustment (time not recorded)', at: Infinity, inningsId: inn.id });
  const adjBefore = (t) => adj.filter((a) => a.at <= t).reduce((s, a) => s + a.delta, 0);

  let runs = 0, wkts = 0;
  const fow = [], overList = [], progression = [];
  for (const b of balls) {
    runs += b.runs;
    if (b.is_wicket) { wkts++; fow.push({ wicket: wkts, score: runs + adjBefore(b.created_at), ballNo: b.ball_no, over: ballLabel(b.ball_no), batter: b.batter_name, bowler: b.bowler_name, dismissal: b.dismissal === 'dot_rule' ? 'dot-over rule' : 'matched', ballId: b.id }); }
    const o = Math.floor((b.ball_no - 1) / 6);
    if (!overList[o]) overList[o] = { number: o + 1, runs: 0, wickets: 0, balls: [], bowlers: [] };
    const ov = overList[o];
    ov.runs += b.runs; if (b.is_wicket) ov.wickets++;
    ov.balls.push({ id: b.id, bat: b.bat_num, bowl: b.bowl_num, runs: b.runs, wicket: !!b.is_wicket });
    if (!ov.bowlers.includes(b.bowler_name)) ov.bowlers.push(b.bowler_name);
    ov.score = { runs: runs + adjBefore(b.created_at), wickets: wkts };
    ov.firstBallId ??= b.id;
  }
  for (const ov of overList.filter(Boolean)) progression.push({ over: ov.number, runs: ov.score.runs, wickets: ov.score.wickets, overRuns: ov.runs });

  // Partnerships: runs added for each wicket (one batter faces at a time, so this is that stand at the crease).
  const parts = new Map();
  for (const b of balls) {
    if (!parts.has(b.stint)) parts.set(b.stint, { wicket: b.stint + 1, runs: 0, balls: 0, batters: [], broken: false });
    const p = parts.get(b.stint);
    p.runs += b.runs; p.balls++;
    if (!p.batters.includes(b.batter_name)) p.batters.push(b.batter_name);
    if (b.is_wicket) p.broken = true;
  }
  const bat = battingFrom(balls), bowl = bowlingFrom(balls);
  // Batting card: per batter across their knocks in this innings, in order of appearance.
  const card = new Map();
  for (const k of bat.knocks) {
    if (!card.has(k.batterId)) card.set(k.batterId, { id: k.batterId, name: k.name, runs: 0, balls: 0, fours: 0, sixes: 0, dots: 0, outs: 0, dismissals: [] });
    const c = card.get(k.batterId);
    c.runs += k.runs; c.balls += k.balls; c.fours += k.fours; c.sixes += k.sixes; c.dots += k.dots;
    if (k.out) { c.outs++; c.dismissals.push(k.dismissal); }
  }
  const total = runs + inn.extras;
  return {
    id: inn.id, number: inn.number, superOver: !!inn.super_over, batting: inn.batting, bowling: inn.bowling,
    battingName: rec.names[inn.batting], bowlingName: rec.names[inn.bowling], target: inn.target, status: inn.status,
    runs: total, ballRuns: runs, adjustments: inn.extras, adjustmentList: adj.map(({ delta, reason }) => ({ delta, reason })),
    wickets: wkts, balls: balls.length, overs: overs(balls.length), runRate: per(total, balls.length, 6),
    voidedBalls: all_.length - balls.length,
    battingCard: [...card.values()].map((c) => ({ ...c, strikeRate: per(c.runs, c.balls, 100) })),
    bowlingCard: bowl.spells.map(({ bowlerId, name, balls: bb, overs: ov, runs: rr, wickets, dots, maidens, economy }) => ({ id: bowlerId, name, balls: bb, overs: ov, runs: rr, wickets, dots, maidens, economy, average: per(rr, wickets), strikeRate: per(bb, wickets) })),
    knocks: bat.knocks, fow, partnerships: [...parts.values()], overList: overList.filter(Boolean), progression,
  };
}

function sessionStats(rec) {
  if (rec.m.config.format !== 'test') return null;
  const sessions = all('SELECT * FROM match_sessions WHERE match_id = ? ORDER BY idx', rec.m.id).map((s) => ({ idx: s.idx, day: s.day, num: s.num, endReason: s.end_reason, runs: 0, wickets: 0, balls: 0, byTeam: {} }));
  const byIdx = Object.fromEntries(sessions.map((s) => [s.idx, s]));
  const innById = Object.fromEntries(rec.innings.map((i) => [i.id, i]));
  let close = null;
  const days = new Map();
  for (const b of rec.balls.filter((x) => !x.voided)) {
    const s = byIdx[b.session_idx];
    if (!s) continue;
    const team = rec.names[innById[b.innings_id].batting];
    s.runs += b.runs; s.balls++; if (b.is_wicket) s.wickets++;
    s.byTeam[team] ??= { runs: 0, wickets: 0, balls: 0 };
    s.byTeam[team].runs += b.runs; s.byTeam[team].balls++; if (b.is_wicket) s.byTeam[team].wickets++;
    if (!days.has(s.day)) days.set(s.day, { day: s.day, runs: 0, wickets: 0, balls: 0, sessions: 0 });
    const d = days.get(s.day);
    d.runs += b.runs; d.balls++; if (b.is_wicket) d.wickets++;
    close = { day: s.day, ballId: b.id };
    d.closeBallId = b.id;
  }
  for (const d of days.values()) d.sessions = sessions.filter((s) => s.day === d.day).length;
  for (const s of sessions) { s.overs = overs(s.balls); s.runRate = per(s.runs, s.balls, 6); }
  for (const d of days.values()) { d.overs = overs(d.balls); d.runRate = per(d.runs, d.balls, 6); }
  return { sessions, days: [...days.values()], close };
}

// Full analysis of one match: innings summaries, cards, fall of wickets, partnerships, best players, sessions.
export function matchAnalysis(matchId) {
  const rec = loadMatchRecord(matchId);
  if (!rec) return null;
  const innings = rec.innings.map((i) => inningsAnalysis(rec, i));
  const valid = rec.balls.filter((b) => !b.voided && !rec.innings.find((i) => i.id === b.innings_id)?.super_over);
  // Best performers, by the actual player on the field (for real teams, the squad player).
  const batMatch = new Map(), bowlMatch = new Map();
  for (const b of valid) {
    if (!batMatch.has(b.batter_id)) batMatch.set(b.batter_id, { id: b.batter_id, name: b.batter_name, runs: 0, balls: 0, outs: 0 });
    const x = batMatch.get(b.batter_id); x.runs += b.runs; x.balls++; if (b.is_wicket) x.outs++;
    if (!bowlMatch.has(b.bowler_id)) bowlMatch.set(b.bowler_id, { id: b.bowler_id, name: b.bowler_name, wickets: 0, runs: 0, balls: 0 });
    const y = bowlMatch.get(b.bowler_id); y.balls++; y.runs += b.runs; if (credited(b)) y.wickets++;
  }
  const bestBatter = [...batMatch.values()].sort((a, b) => b.runs - a.runs || a.balls - b.balls)[0] || null;
  const bestBowler = [...bowlMatch.values()].filter((x) => x.wickets > 0).sort((a, b) => b.wickets - a.wickets || a.runs - b.runs)[0] || null;
  const allParts = innings.flatMap((i) => i.partnerships.map((p) => ({ ...p, innings: i.number, team: i.battingName })));
  const totalRuns = innings.reduce((s, i) => s + i.runs, 0), totalBalls = innings.reduce((s, i) => s + i.balls, 0);
  return {
    id: rec.m.id, name: rec.m.name, status: rec.m.status, format: rec.m.config.format, formatName: FORMAT_NAME[rec.m.config.format] || 'Custom overs',
    teams: rec.names, result: rec.m.result,
    totals: { runs: totalRuns, wickets: innings.reduce((s, i) => s + i.wickets, 0), balls: totalBalls, overs: overs(totalBalls), runRate: per(totalRuns, totalBalls, 6) },
    bestBatter: bestBatter && { ...bestBatter, strikeRate: per(bestBatter.runs, bestBatter.balls, 100) },
    bestBowler: bestBowler && { ...bestBowler, overs: overs(bestBowler.balls), economy: per(bestBowler.runs, bestBowler.balls, 6) },
    highestPartnership: [...allParts].sort((a, b) => b.runs - a.runs || a.balls - b.balls)[0] || null,
    innings, test: sessionStats(rec),
  };
}

// ---------- ball-by-ball replay ----------
// A timeline of every delivery in order, with the running score, over summaries and innings transitions.
// Voided deliveries are shown (marked) but never counted, exactly as on the scorecard.
export function replay(matchId) {
  const rec = loadMatchRecord(matchId);
  if (!rec) return null;
  const a = matchAnalysis(matchId);
  const frames = [];
  for (const inn of rec.innings) {
    const ia = a.innings.find((x) => x.id === inn.id);
    const balls = rec.balls.filter((b) => b.innings_id === inn.id);
    const adj = ia.adjustmentList.map((x, i) => ({ ...x, at: rec.adjustments.filter((y) => y.inningsId === inn.id)[i]?.at ?? Infinity }));
    frames.push({ type: 'innings_start', innings: inn.number, superOver: !!inn.super_over, batting: rec.names[inn.batting], bowling: rec.names[inn.bowling], target: inn.target });
    let runs = 0, wkts = 0, legal = 0, session = null, overRuns = 0, overWkts = 0, ai = 0;
    const flushAdj = (t) => {
      while (ai < adj.length && adj[ai].at <= t) {
        runs += adj[ai].delta;
        frames.push({ type: 'adjustment', innings: inn.number, delta: adj[ai].delta, reason: adj[ai].reason, score: { runs, wickets: wkts } });
        ai++;
      }
    };
    for (const b of balls) {
      flushAdj(b.created_at);
      if (b.session_idx && b.session_idx !== session && rec.m.config.format === 'test') {
        session = b.session_idx;
        frames.push({ type: 'session', innings: inn.number, day: b.day, session: b.session_num, score: { runs, wickets: wkts } });
      }
      if (b.voided) {
        frames.push({ type: 'ball', voided: true, id: b.id, innings: inn.number, ballNo: b.ball_no, over: ballLabel(b.ball_no), batter: b.batter_name, bowler: b.bowler_name, bat: b.bat_num, bowl: b.bowl_num, runs: 0, wicket: false, score: { runs, wickets: wkts, overs: overs(legal) } });
        continue;
      }
      runs += b.runs; legal++; overRuns += b.runs;
      if (b.is_wicket) { wkts++; overWkts++; }
      frames.push({
        type: 'ball', id: b.id, innings: inn.number, ballNo: b.ball_no, over: ballLabel(b.ball_no), batter: b.batter_name, bowler: b.bowler_name,
        bat: b.bat_num, bowl: b.bowl_num, runs: b.runs, wicket: !!b.is_wicket, dismissal: b.is_wicket ? (b.dismissal === 'dot_rule' ? 'dot-over rule' : 'matched') : null,
        day: b.day ?? null, session: b.session_num ?? null,
        score: { runs, wickets: wkts, overs: overs(legal) },
        need: inn.target ? Math.max(0, inn.target - runs) : null,
      });
      if (legal % 6 === 0) {
        frames.push({ type: 'over_end', innings: inn.number, over: legal / 6, runs: overRuns, wickets: overWkts, bowler: b.bowler_name, score: { runs, wickets: wkts, overs: overs(legal) } });
        overRuns = 0; overWkts = 0;
      }
    }
    flushAdj(Infinity);
    if (legal % 6 && inn.status === 'done') frames.push({ type: 'over_end', innings: inn.number, over: Math.ceil(legal / 6), partial: true, runs: overRuns, wickets: overWkts, score: { runs, wickets: wkts, overs: overs(legal) } });
    if (inn.status === 'done') frames.push({ type: 'innings_end', innings: inn.number, team: rec.names[inn.batting], reason: inn.end_reason || null, declared: !!inn.declared, score: { runs, wickets: wkts, overs: overs(legal) } });
  }
  if (rec.m.status === 'completed' && rec.m.result) frames.push({ type: 'match_end', result: rec.m.result.text });
  frames.forEach((f, i) => { f.i = i; });
  return { id: rec.m.id, name: rec.m.name, teams: rec.names, format: rec.m.config.format, status: rec.m.status, frames };
}

// ---------- automatic highlights ----------
export function highlights(matchId, analysis = matchAnalysis(matchId)) {
  if (!analysis) return null;
  const out = [];
  const A = analysis;
  for (const inn of A.innings) {
    const tag = `${inn.battingName}${A.innings.length > 2 || inn.superOver ? ` (${inn.superOver ? 'super over' : `innings ${inn.number}`})` : ''}`;
    for (const w of inn.fow) out.push({ kind: 'wicket', innings: inn.number, ballId: w.ballId, title: `Wicket: ${w.batter}`, detail: `${w.dismissal === 'matched' ? `${w.bowler} matched the number` : 'Out under the dot-over rule'} at ${w.over}. ${tag} ${w.score}/${w.wicket}.` });
    // Consecutive scoring sequences.
    const balls = inn.overList.flatMap((o) => o.balls.map((b) => ({ ...b, over: o.number })));
    let best = null, cur = null, bestB = null, curB = null;
    for (const b of balls) {
      if (b.runs > 0) { cur = cur ? { ...cur, n: cur.n + 1, runs: cur.runs + b.runs } : { n: 1, runs: b.runs, from: b.id }; if (!best || cur.n > best.n || (cur.n === best.n && cur.runs > best.runs)) best = cur; } else cur = null;
      if (b.runs === 4 || b.runs === 6) { curB = curB ? { ...curB, n: curB.n + 1, runs: curB.runs + b.runs } : { n: 1, runs: b.runs, from: b.id }; if (!bestB || curB.n > bestB.n) bestB = curB; } else curB = null;
    }
    if (best && best.n >= 4) out.push({ kind: 'streak', innings: inn.number, ballId: best.from, title: `${best.n} scoring balls in a row`, detail: `${tag} scored off ${best.n} consecutive deliveries for ${best.runs} runs.` });
    if (bestB && bestB.n >= 3) out.push({ kind: 'streak', innings: inn.number, ballId: bestB.from, title: `${bestB.n} boundaries in a row`, detail: `${tag} hit ${bestB.n} fours or sixes in succession (${bestB.runs} runs).` });
  }
  // Highest-scoring overs across the match: the top three.
  const tagOf = (inn) => `${inn.battingName}${A.innings.length > 2 || inn.superOver ? ` (${inn.superOver ? 'super over' : `innings ${inn.number}`})` : ''}`;
  const allOvers = A.innings.flatMap((inn) => inn.overList.map((ov) => ({ ov, inn })));
  for (const { ov, inn } of allOvers.filter((x) => x.ov.runs > 0).sort((a, b) => b.ov.runs - a.ov.runs).slice(0, 3))
    out.push({ kind: 'big_over', innings: inn.number, ballId: ov.firstBallId, runs: ov.runs, title: `${ov.runs} runs off over ${ov.number}`, detail: `${tagOf(inn)}, bowled by ${ov.bowlers.join(' and ')}: ${ov.balls.map((b) => (b.wicket ? 'W' : b.runs)).join(' ')}.` });
  // Match-winning delivery.
  if (A.status === 'completed' && A.result?.winner) {
    const last = [...A.innings].reverse().find((i) => i.balls > 0);
    const ball = last?.overList.at(-1)?.balls.at(-1);
    if (ball) {
      const chased = last.batting === A.result.winner && last.target && last.runs >= last.target;
      const defended = last.bowling === A.result.winner && (ball.wicket || last.status === 'done');
      if (chased || defended)
        out.push({ kind: 'winner', innings: last.number, ballId: ball.id, title: chased ? 'Winning runs' : ball.wicket ? 'The final wicket' : 'The final ball', detail: `${chased ? `${ball.runs} off the last ball faced` : ball.wicket ? 'Matched number to finish it' : `${ball.runs} off the last ball`}. ${A.result.text}` });
    }
  }
  // Best individual performances.
  const knocks = A.innings.filter((i) => !i.superOver).flatMap((i) => i.knocks.map((k) => ({ ...k, team: i.battingName, innings: i.number })));
  const topKnock = knocks.sort((a, b) => b.runs - a.runs || a.balls - b.balls)[0];
  if (topKnock && topKnock.runs > 0) out.push({ kind: 'performance', innings: topKnock.innings, ballId: topKnock.firstBallId, title: `Top score: ${topKnock.name} ${topKnock.runs}${topKnock.out ? '' : '*'}`, detail: `${topKnock.runs} off ${plural(topKnock.balls, 'ball')} (${plural(topKnock.fours, 'four')}, ${plural(topKnock.sixes, 'six', 'sixes')}) for ${topKnock.team}.` });
  const spells = A.innings.filter((i) => !i.superOver).flatMap((i) => i.bowlingCard.map((s) => ({ ...s, team: i.bowlingName, innings: i.number })));
  const topSpell = spells.filter((s) => s.wickets > 0).sort((a, b) => b.wickets - a.wickets || a.runs - b.runs)[0];
  if (topSpell) out.push({ kind: 'performance', innings: topSpell.innings, title: `Best bowling: ${topSpell.name} ${topSpell.wickets}/${topSpell.runs}`, detail: `${topSpell.overs} overs, economy ${topSpell.economy ?? '-'}, ${topSpell.dots} dot balls for ${topSpell.team}.` });
  // Tests: the sessions that mattered, and each day.
  if (A.test) {
    const played = A.test.sessions.filter((s) => s.balls > 0);
    const most = [...played].sort((a, b) => b.runs - a.runs)[0];
    const wk = [...played].sort((a, b) => b.wickets - a.wickets || a.runs - b.runs)[0];
    if (most) out.push({ kind: 'session', title: `Most productive session: day ${most.day}, session ${most.num}`, detail: `${most.runs} runs for ${most.wickets} wickets in ${most.overs} overs (${Object.entries(most.byTeam).map(([t, x]) => `${t} ${x.runs}/${x.wickets}`).join(', ')}).` });
    if (wk && wk.wickets > 0 && wk !== most) out.push({ kind: 'session', title: `Most wickets in a session: day ${wk.day}, session ${wk.num}`, detail: `${wk.wickets} wickets for ${wk.runs} runs in ${wk.overs} overs.` });
    for (const d of A.test.days) out.push({ kind: 'day', ballId: d.closeBallId, title: `Day ${d.day}`, detail: `${d.runs} runs and ${d.wickets} wickets in ${d.overs} overs across ${d.sessions} session${d.sessions === 1 ? '' : 's'}.` });
  }
  return out;
}

// ---------- careers ----------
// A person's deliveries: balls they played themselves, or as the controller of a real-team squad player.
// Completed matches only; super overs are kept out of career figures, as in real cricket.
function careerBalls(userId) {
  return all(`SELECT b.*, i.match_id, i.number AS inn_no, ub.display_name AS batter_name, uw.display_name AS bowler_name,
        COALESCE(bm.controller_id, b.batter_id) AS bat_owner, COALESCE(wm.controller_id, b.bowler_id) AS bowl_owner
      FROM balls b JOIN innings i ON i.id = b.innings_id JOIN matches m ON m.id = i.match_id
      LEFT JOIN members bm ON bm.match_id = i.match_id AND bm.user_id = b.batter_id
      LEFT JOIN members wm ON wm.match_id = i.match_id AND wm.user_id = b.bowler_id
      LEFT JOIN users ub ON ub.id = b.batter_id LEFT JOIN users uw ON uw.id = b.bowler_id
      WHERE m.status = 'completed' AND b.voided = 0 AND i.super_over = 0
        AND (COALESCE(bm.controller_id, b.batter_id) = ? OR COALESCE(wm.controller_id, b.bowler_id) = ?)
      ORDER BY b.id`, userId, userId);
}

function careerMatches(userId) {
  return all(`SELECT m.id, m.name, m.config, m.result, m.ended_at, m.team_a, m.team_b, m.team_a_meta, m.team_b_meta, mb.team
      FROM members mb JOIN matches m ON m.id = mb.match_id
      WHERE mb.user_id = ? AND m.status = 'completed' AND mb.team IS NOT NULL ORDER BY m.ended_at DESC`, userId)
    .map((r) => {
      const config = parse(r.config, {}), result = parse(r.result, {}) || {};
      const names = teamNames(r);
      const outcome = result.tie ? 'tie' : result.draw ? 'draw' : result.winner ? (result.winner === r.team ? 'won' : 'lost') : 'no result';
      return { id: r.id, name: r.name, endedAt: r.ended_at, format: config.format || 'custom', quick: !!config.quick, team: names[r.team], opponent: names[r.team === 'A' ? 'B' : 'A'],
        vsAI: config.participation === 'ai', aiLevel: config.aiLevel || null, aiPersonality: config.aiPersonality || (config.participation === 'ai' ? 'strategic' : null), outcome, result: result.text || null };
    });
}

const record = (ms) => ({ matches: ms.length, won: ms.filter((x) => x.outcome === 'won').length, lost: ms.filter((x) => x.outcome === 'lost').length, tied: ms.filter((x) => x.outcome === 'tie').length, drawn: ms.filter((x) => x.outcome === 'draw').length });

export function career(userId) {
  const balls = careerBalls(userId);
  const matches = careerMatches(userId);
  const byMatch = Object.fromEntries(matches.map((x) => [x.id, x]));
  const batBalls = balls.filter((b) => b.bat_owner === userId), bowlBalls = balls.filter((b) => b.bowl_owner === userId);
  const bat = battingFrom(batBalls), bowl = bowlingFrom(bowlBalls);
  const split = (keyOf, label) => {
    const groups = new Map();
    for (const mt of matches) { const k = keyOf(mt); if (k == null) continue; if (!groups.has(k)) groups.set(k, { key: k, label: label(mt), matches: [] }); groups.get(k).matches.push(mt); }
    return [...groups.values()].map((g) => {
      const ids = new Set(g.matches.map((x) => x.id));
      return { key: g.key, label: g.label, record: record(g.matches),
        batting: battingFrom(batBalls.filter((b) => ids.has(b.match_id))).summary, bowling: bowlingFrom(bowlBalls.filter((b) => ids.has(b.match_id))).summary };
    }).sort((a, b) => b.record.matches - a.record.matches);
  };
  const recent = matches.slice(0, 10).map((mt) => {
    const bb = battingFrom(batBalls.filter((b) => b.match_id === mt.id)).summary, ww = bowlingFrom(bowlBalls.filter((b) => b.match_id === mt.id)).summary;
    return { ...mt, runs: bb.runs, balls: bb.balls, outs: bb.dismissals, wickets: ww.wickets, conceded: ww.runs, bowled: ww.balls };
  });
  const tagMatch = (x) => ({ ...x, match: byMatch[x.matchId]?.name || null, format: byMatch[x.matchId]?.format || null, endedAt: byMatch[x.matchId]?.endedAt || null });
  return {
    record: record(matches),
    batting: bat.summary,
    bowling: bowl.summary,
    formats: split((x) => x.format, (x) => FORMAT_NAME[x.format] || 'Custom overs'),
    teams: split((x) => x.team, (x) => x.team),
    ai: { overall: record(matches.filter((x) => x.vsAI)), byOpponent: split((x) => (x.vsAI ? `${x.aiLevel}/${x.aiPersonality}` : null), (x) => `${x.aiLevel}, ${x.aiPersonality}`) },
    recent,
    bests: {
      batting: [...bat.knocks].sort((a, b) => b.runs - a.runs || a.balls - b.balls).slice(0, 5).map(({ firstBallId, lastBallId, ...k }) => tagMatch(k)),
      bowling: [...bowl.spells].filter((s) => s.wickets > 0).sort((a, b) => b.wickets - a.wickets || a.runs - b.runs).slice(0, 5).map(tagMatch),
    },
  };
}
