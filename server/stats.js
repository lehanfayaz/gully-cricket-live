// Player statistics, computed from the permanent ball-by-ball record of finished matches.
import { get, all } from './db.js';

const FINISHED = `SELECT i.id FROM innings i JOIN matches m ON m.id = i.match_id WHERE m.status = 'completed'`;

export function battingStats(userId) {
  const b = get(`SELECT COUNT(*) AS balls, COALESCE(SUM(runs),0) AS runs, COALESCE(SUM(is_wicket),0) AS outs,
      COALESCE(SUM(runs = 6),0) AS sixes, COALESCE(SUM(runs = 4),0) AS fours
    FROM balls WHERE batter_id = ? AND voided = 0 AND innings_id IN (${FINISHED})`, userId);
  // A "knock" is one stint at the crease: the balls a batter faced between two wickets.
  const knocks = all(`SELECT SUM(runs) AS runs, MAX(is_wicket) AS out FROM balls
    WHERE batter_id = ? AND voided = 0 AND innings_id IN (${FINISHED}) GROUP BY innings_id, stint`, userId);
  const highest = knocks.reduce((h, k) => Math.max(h, k.runs), 0);
  const highestNotOut = knocks.some((k) => k.runs === highest && !k.out) && knocks.length > 0;
  const ducks = knocks.filter((k) => k.runs === 0 && k.out).length;
  return {
    ...b, knocks: knocks.length, highest, highestNotOut, ducks,
    average: b.outs ? +(b.runs / b.outs).toFixed(2) : null,
    strikeRate: b.balls ? +((b.runs * 100) / b.balls).toFixed(1) : null,
  };
}

export function bowlingStats(userId) {
  const r = get(`SELECT COUNT(*) AS balls, COALESCE(SUM(runs),0) AS runs, COALESCE(SUM(is_wicket = 1 AND COALESCE(dismissal, '') <> 'dot_rule'),0) AS wickets
    FROM balls WHERE bowler_id = ? AND voided = 0 AND innings_id IN (${FINISHED})`, userId);
  return { ...r, economy: r.balls ? +((r.runs * 6) / r.balls).toFixed(2) : null };
}

export function recordStats(userId) {
  const rows = all(`SELECT m.id, m.name, m.result, mb.team, m.ended_at, m.team_a, m.team_b
    FROM members mb JOIN matches m ON m.id = mb.match_id
    WHERE mb.user_id = ? AND m.status = 'completed'
      AND (mb.team IS NOT NULL OR EXISTS (SELECT 1 FROM balls b JOIN innings i ON i.id = b.innings_id
        WHERE i.match_id = m.id AND (b.batter_id = mb.user_id OR b.bowler_id = mb.user_id)))
    ORDER BY m.ended_at DESC`, userId);
  let wins = 0, losses = 0, ties = 0, draws = 0;
  const history = rows.map((r) => {
    const res = r.result ? JSON.parse(r.result) : {};
    let outcome = 'played';
    if (res.tie) { ties++; outcome = 'tie'; }
    else if (res.draw) { draws++; outcome = 'draw'; }
    else if (res.winner && r.team) { if (res.winner === r.team) { wins++; outcome = 'won'; } else { losses++; outcome = 'lost'; } }
    return { id: r.id, name: r.name, result: res.text, outcome, endedAt: r.ended_at, team: r.team ? (r.team === 'A' ? r.team_a : r.team_b) : null };
  });
  return { matches: rows.length, wins, losses, ties, draws, history };
}

export function profile(userId) {
  const u = get('SELECT id, username, display_name AS name, is_guest AS guest, created_at FROM users WHERE id = ?', userId);
  if (!u) return null;
  const rec = recordStats(userId);
  return { user: { ...u, guest: !!u.guest }, batting: battingStats(userId), bowling: bowlingStats(userId),
    record: { matches: rec.matches, wins: rec.wins, losses: rec.losses, ties: rec.ties, draws: rec.draws }, history: rec.history.slice(0, 30) };
}

export function leaderboard(sort = 'runs') {
  const rows = all(`
    WITH bat AS (SELECT batter_id AS id, SUM(runs) AS runs, COUNT(*) AS balls, SUM(is_wicket) AS outs, SUM(runs = 6) AS sixes
                 FROM balls WHERE voided = 0 AND innings_id IN (${FINISHED}) GROUP BY batter_id),
         bowl AS (SELECT bowler_id AS id, SUM(is_wicket = 1 AND COALESCE(dismissal, '') <> 'dot_rule') AS wickets, COUNT(*) AS balls, SUM(runs) AS conceded
                  FROM balls WHERE voided = 0 AND innings_id IN (${FINISHED}) GROUP BY bowler_id),
         rec AS (SELECT mb.user_id AS id, COUNT(*) AS matches,
                   SUM(json_extract(m.result, '$.winner') = mb.team) AS wins
                 FROM members mb JOIN matches m ON m.id = mb.match_id
                 WHERE m.status = 'completed' AND mb.team IS NOT NULL GROUP BY mb.user_id)
    SELECT u.id, u.display_name AS name,
      COALESCE(bat.runs,0) AS runs, COALESCE(bat.balls,0) AS balls, COALESCE(bat.outs,0) AS outs, COALESCE(bat.sixes,0) AS sixes,
      COALESCE(bowl.wickets,0) AS wickets, COALESCE(bowl.balls,0) AS bowled, COALESCE(bowl.conceded,0) AS conceded,
      COALESCE(rec.matches,0) AS matches, COALESCE(rec.wins,0) AS wins
    FROM users u LEFT JOIN bat ON bat.id = u.id LEFT JOIN bowl ON bowl.id = u.id LEFT JOIN rec ON rec.id = u.id
    WHERE bat.id IS NOT NULL OR bowl.id IS NOT NULL`);
  for (const r of rows) {
    r.strikeRate = r.balls ? +((r.runs * 100) / r.balls).toFixed(1) : 0;
    r.average = r.outs ? +(r.runs / r.outs).toFixed(2) : r.runs;
    // Ranking points: runs, plus 20 per wicket taken, plus 25 per win.
    r.points = r.runs + r.wickets * 20 + r.wins * 25;
  }
  const keys = { runs: 'runs', wickets: 'wickets', wins: 'wins', strikeRate: 'strikeRate', sixes: 'sixes', points: 'points' };
  const k = keys[sort] || 'points';
  const list = k === 'strikeRate' ? rows.filter((r) => r.balls >= 12) : rows;
  return list.sort((a, b) => b[k] - a[k] || b.points - a.points).slice(0, 100).map((r, i) => ({ rank: i + 1, ...r }));
}
