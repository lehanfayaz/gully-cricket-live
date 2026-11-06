// Automated commentary, written from the saved deliveries and the match's own state. Every number in a
// line (score, wickets, runs needed, a batter's total) is computed from the same ball records the
// scorecard uses, so the commentary can't contradict it. Wording varies, but is fixed per ball (it's
// chosen from the ball's id), so the same ball always reads the same way.
import { all } from './db.js';
import { getConfig, fillTemplate } from './config.js';

const pick = (id, options) => options[Math.abs(Math.imul(id, 2654435761)) % options.length];
const ballLabel = (n) => `${Math.floor((n - 1) / 6)}.${((n - 1) % 6) + 1}`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Lines for the latest `limit` deliveries of a match (newest first), each with its context.
export function commentary(m, { limit = 60, teamName }) {
  const latest = all(`SELECT b.id, b.innings_id FROM balls b JOIN innings i ON i.id = b.innings_id WHERE i.match_id = ? ORDER BY b.id DESC LIMIT ?`, m.id, limit);
  if (!latest.length) return [];
  const wanted = new Set(latest.map((x) => x.id));
  const test = m.config.format === 'test';
  const out = [];
  // Umpire run adjustments count in the score from the moment they were made, as on the scorecard.
  const inns = all('SELECT id, started_at FROM innings WHERE match_id = ? ORDER BY number', m.id);
  const adjustments = all(`SELECT detail, created_at FROM audit WHERE match_id = ? AND action = 'adjust_runs' ORDER BY id`, m.id)
    .map((a) => { const d = JSON.parse(a.detail || '{}'); return { delta: d.delta || 0, at: a.created_at, innId: d.inningsId ?? [...inns].reverse().find((i) => i.started_at <= a.created_at)?.id }; });
  for (const innId of [...new Set(latest.map((x) => x.innings_id))]) {
    const inn = all('SELECT * FROM innings WHERE id = ?', innId)[0];
    const balls = all(`SELECT b.*, bu.display_name AS batter, bo.display_name AS bowler, ms.day, ms.num AS session_num
        FROM balls b JOIN users bu ON bu.id = b.batter_id JOIN users bo ON bo.id = b.bowler_id
        LEFT JOIN match_sessions ms ON ms.match_id = ? AND ms.idx = b.session_idx
        WHERE b.innings_id = ? ORDER BY b.id`, m.id, innId);
    const rules = test ? all('SELECT * FROM dot_rules WHERE innings_id = ?', innId) : [];
    const team = teamName(m, inn.batting);
    const adj = (t) => adjustments.filter((a) => a.innId === innId && a.at < t).reduce((x, a) => x + a.delta, 0);
    let runs = 0, wkts = 0, legal = 0, session = null, overRuns = [];
    const knock = new Map(), overDots = new Map();
    for (const b of balls) {
      if (b.voided) { if (wanted.has(b.id)) out.push(line(b, inn, `Voided by the umpire: this delivery doesn't count.`, { runs: runs + adj(b.created_at), wkts })); continue; }
      runs += b.runs; legal++; if (b.is_wicket) wkts++;
      const kk = `${b.stint}:${b.batter_id}`;
      const prevKnock = knock.get(kk) || { runs: 0, balls: 0 };
      const k = { runs: prevKnock.runs + b.runs, balls: prevKnock.balls + 1 };
      knock.set(kk, k);
      const overIdx = Math.floor((b.ball_no - 1) / 6), pos = (b.ball_no - 1) % 6;
      overRuns[overIdx] = (overRuns[overIdx] || 0) + b.runs;
      // Dots by the same batter through this over, for the six-ball dot-over rule.
      const od = overDots.get(overIdx) || { batter: b.batter_id, dots: 0, clean: true };
      if (od.batter !== b.batter_id || b.runs > 0 || b.is_wicket) od.clean = false; else od.dots++;
      overDots.set(overIdx, od);
      if (!wanted.has(b.id)) { if (b.session_idx) session = b.session_idx; continue; }

      const parts = [];
      // Openers and session starts.
      if (legal === 1) parts.push(inn.super_over ? `Super over: ${team} bat.` : inn.target ? `${team} begin the chase, needing ${inn.target} to win.` : `${team} begin their innings.`);
      if (test && b.session_idx && b.session_idx !== session && legal > 1) parts.push(`Day ${b.day}, session ${b.session_num} is underway.`);
      if (b.session_idx) session = b.session_idx;
      // The delivery itself. Admin templates (if any) replace the built-in wording; the kind of ball is
      // always stated, and every number comes from the record.
      const id = b.id;
      const tpl = getConfig().commentary.templates || {};
      const vals = { batter: b.batter, bowler: b.bowler, bat: b.bat_num, bowl: b.bowl_num, runs: b.runs };
      const ev = b.is_wicket ? (b.dismissal === 'dot_rule' ? null : 'wicket') : b.runs === 6 ? 'six' : b.runs === 4 ? 'four' : b.runs === 0 ? 'dot' : 'runs';
      const mark = { wicket: ['OUT!', /\bout\b/i], six: ['SIX!', /\bsix\b/i], four: ['FOUR!', /\bfour\b/i] }[ev];
      const custom = ev && tpl[ev]?.length ? fillTemplate(pick(id, tpl[ev]), vals) : null;
      const fromTpl = custom && mark && !mark[1].test(custom) ? `${mark[0]} ${custom}` : custom;
      if (b.is_wicket && b.dismissal === 'dot_rule') parts.push(`OUT! ${b.batter} hasn't scored off the first two balls of the over and is out under the dot-over rule.`);
      else if (b.is_wicket) {
        if (fromTpl) parts.push(fromTpl); else parts.push(pick(id, [`OUT! ${b.bowler} has found the matching number. Both picked ${b.bowl_num}.`, `OUT! ${b.bowler} reads it perfectly: ${b.bowl_num} against ${b.bowl_num}.`, `OUT! Matching numbers, ${b.bowl_num} and ${b.bowl_num}. ${b.batter} has to go.`]));
        if (fromTpl && !/^OUT!/.test(parts.at(-1))) parts[parts.length - 1] = `OUT! ${parts.at(-1)}`;
        parts.push(`${b.batter} departs for ${k.runs} off ${plural(k.balls, 'ball')}.`);
        // Why this one mattered, judged from the record.
        const needLeft = inn.target ? inn.target - runs - adj(b.created_at) : null, ballsLeft = inn.max_balls - legal;
        if (prevKnock.runs >= 30) parts.push(`A crucial wicket: the set batter is gone.`);
        else if (inn.target && needLeft > 0 && ballsLeft > 0 && needLeft <= ballsLeft * 2.5 && ballsLeft <= 18) parts.push(`A crucial wicket at this stage of the chase.`);
        else if (wkts === inn.max_wickets - 1) parts.push(`${team} are down to their last wicket.`);
      } else if (fromTpl) parts.push(fromTpl);
      else if (b.runs === 6) parts.push(pick(id, [`SIX! ${b.batter} picks 6 and ${b.bowler} went ${b.bowl_num}.`, `SIX! A brave 6 from ${b.batter}; ${b.bowler} had ${b.bowl_num}.`, `SIX! Maximum. ${b.bowler}'s ${b.bowl_num} was nowhere near it.`]));
      else if (b.runs === 4) parts.push(pick(id, [`FOUR! A clever selection. ${b.batter} scores 4 runs.`, `FOUR! ${b.batter} picks 4, ${b.bowler} had ${b.bowl_num}.`, `FOUR! Well chosen by ${b.batter}; ${b.bowler} went ${b.bowl_num}.`]));
      else if (b.runs === 0) parts.push(pick(id, [`Dot ball. ${b.batter} blocks with 0; ${b.bowler} had ${b.bowl_num}.`, `No run. ${b.batter} plays it safe with 0.`, `${b.batter} picks 0, a dot. ${b.bowler} had ${b.bowl_num}.`]));
      else parts.push(pick(id, [`${plural(b.runs, 'run')}. ${b.batter} picks ${b.bat_num}, ${b.bowler} ${b.bowl_num}.`, `${b.batter} takes ${b.runs}; ${b.bowler} had ${b.bowl_num}.`, `${b.bat_num} against ${b.bowl_num}: ${plural(b.runs, 'run')} to ${b.batter}.`]));
      // Milestones (from the knock's own total).
      if (!b.is_wicket) for (const ms of [50, 100, 150, 200]) if (prevKnock.runs < ms && k.runs >= ms) parts.push(`That brings up ${ms === 50 ? 'a fifty' : ms === 100 ? 'a century' : ms} for ${b.batter}, off ${plural(k.balls, 'ball')}.`);
      // Test dot-over rule.
      if (test) {
        const req = rules.find((r) => r.batter_id === b.batter_id && r.over_idx === overIdx);
        if (req && pos <= 1 && !b.is_wicket) {
          if (b.runs > 0) parts.push(`That meets the scoring requirement.`);
          else if (pos === 0) parts.push(`The batter must score off the next legal ball.`);
          else if (req.status === 'waived') parts.push(`No score off the first two balls; the umpire waived the requirement.`);
          else if (req.status === 'pending') parts.push(`No score off the first two balls; the umpire will rule on it.`);
        }
        if (pos === 5 && od.clean && od.dots === 6) parts.push(`${b.batter} has completed a six-ball dot over and must score within the next two legal balls.`);
      }
      // Over summary and the state of play.
      if (pos === 5 && !b.is_wicket) parts.push(`End of over ${overIdx + 1}: ${plural(overRuns[overIdx], 'run')} from it.`);
      const total = runs + adj(b.created_at);
      const state = `${team} ${total}/${wkts}`;
      if (inn.target) {
        const need = inn.target - total, left = inn.max_balls - legal;
        if (need <= 0) parts.push(`${team} reach the target. ${state}.`);
        else if (!test && left > 0 && wkts < inn.max_wickets) parts.push(`${state}, needing ${plural(need, 'run')} from ${plural(left, 'ball')}.`);
        else parts.push(`${state}.`);
      } else parts.push(`${state}${test ? '' : ` after ${ballLabel(b.ball_no)} overs`}.`);
      out.push(line(b, inn, parts.join(' '), { runs: total, wkts }));
    }
  }
  return out.sort((a, b) => b.id - a.id);
}

function line(b, inn, text, score) {
  return { id: b.id, inn: inn.number, over: ballLabel(b.ball_no), ballNo: b.ball_no, batter: b.batter, bowler: b.bowler,
    bat: b.bat_num, bowl: b.bowl_num, runs: b.runs, wicket: !!b.is_wicket, voided: !!b.voided, text, score: `${score.runs}/${score.wkts}` };
}
