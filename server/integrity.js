// Data integrity checks: the database file itself, then every match checked from first principles —
// each locked-in sequence against its published hash, each delivery against the numbers locked in,
// runs against the numbers, digits and the repetition rule, ball numbering, and tournament results.
import crypto from 'node:crypto';
import { all, db, get, run } from './db.js';
import { rulesFor } from './rules.js';

const sha = (digits, salt) => crypto.createHash('sha256').update(`${digits}:${salt}`).digest('hex');
const breaksRule = (n, soFar) => {
  const c = {}; for (const x of soFar) c[x] = (c[x] || 0) + 1;
  const next = (c[n] || 0) + 1;
  return next > 3 || (next === 3 && Object.entries(c).some(([d, k]) => Number(d) !== n && k >= 3));
};

export function checkMatch(matchId) {
  const problems = [];
  const add = (kind, detail) => problems.push({ matchId, kind, detail });
  const m = get('SELECT * FROM matches WHERE id = ?', matchId);
  if (!m) return [{ matchId, kind: 'missing', detail: 'Match not found.' }];
  let config = {};
  try { config = JSON.parse(m.config); } catch { add('config', 'The match settings are unreadable.'); }
  const rules = rulesFor({ format: config.format || 'custom' });
  for (const inn of all('SELECT * FROM innings WHERE match_id = ? ORDER BY number', matchId)) {
    const label = `Innings ${inn.number}`;
    const sets = Object.fromEntries(all('SELECT * FROM sets WHERE innings_id = ?', inn.id).map((s) => [s.id, s]));
    // 1. Every revealed sequence matches the hash published when it was locked in.
    for (const s of Object.values(sets)) {
      if (s.status === 'open') continue;
      if (s.seq && s.hash && sha(s.seq, s.salt) !== s.hash) add('commitment', `${label}: the bowler's numbers for submission ${s.id} don't match their published hash.`);
      if (s.bat_seq && s.bat_hash && sha(s.bat_seq, s.bat_salt) !== s.bat_hash) add('commitment', `${label}: the batter's numbers for submission ${s.id} don't match their published hash.`);
    }
    const balls = all('SELECT * FROM balls WHERE innings_id = ? ORDER BY id', inn.id);
    let expectNo = 1, overStart = 1, since = [], wkts = 0;
    for (const b of balls) {
      const s = sets[b.set_id];
      const where = `${label}, ball ${Math.floor((b.ball_no - 1) / 6)}.${((b.ball_no - 1) % 6) + 1}`;
      // 2. The delivery is exactly what was locked in.
      if (!s) add('orphan', `${where}: no submission recorded for this delivery.`);
      else {
        if (s.seq && Number(s.seq[b.set_index]) !== b.bowl_num) add('delivery', `${where}: bowler's number ${b.bowl_num} isn't the one locked in (${s.seq[b.set_index]}).`);
        if (s.bat_seq && Number(s.bat_seq[b.set_index]) !== b.bat_num) add('delivery', `${where}: batter's number ${b.bat_num} isn't the one locked in (${s.bat_seq[b.set_index]}).`);
      }
      if (b.voided) continue;
      // 3. Ball numbers run 1, 2, 3 … with no gaps or repeats.
      if (b.ball_no !== expectNo) add('numbering', `${where}: expected ball ${expectNo}.`);
      expectNo = b.ball_no + 1;
      // 4. Runs come only from the numbers.
      if (b.dismissal === 'dot_rule') { if (b.runs !== 0 || !b.is_wicket) add('runs', `${where}: a dot-over-rule dismissal must score 0.`); }
      else if (b.is_wicket !== (b.bat_num === b.bowl_num ? 1 : 0)) add('wicket', `${where}: wicket doesn't match the numbers (${b.bat_num} v ${b.bowl_num}).`);
      else if (b.runs !== (b.is_wicket ? 0 : b.bat_num)) add('runs', `${where}: ${b.runs} runs recorded for ${b.bat_num} v ${b.bowl_num}.`);
      // 5. Digits allowed for the format, and the bowler repetition rule.
      if (!rules.batter.includes(b.bat_num)) add('digits', `${where}: batter's ${b.bat_num} isn't allowed in this format.`);
      if (!rules.bowler.includes(b.bowl_num)) add('digits', `${where}: bowler's ${b.bowl_num} isn't allowed in this format.`);
      const o = Math.floor((b.ball_no - 1) / 6) * 6 + 1;
      if (o !== overStart) { overStart = o; since = []; }
      if (breaksRule(b.bowl_num, since)) add('repetition', `${where}: the bowler's ${b.bowl_num} breaks the repetition rule.`);
      since.push(b.bowl_num);
      if (b.is_wicket) { since = []; wkts++; }
    }
    if (wkts > inn.max_wickets) add('wickets', `${label}: ${wkts} wickets recorded, more than the ${inn.max_wickets} allowed.`);
    if (expectNo - 1 > inn.max_balls) add('overs', `${label}: more balls than the innings allows.`);
    if (m.status === 'completed' && inn.status !== 'done') add('status', `${label} is still open in a finished match.`);
  }
  return problems;
}

export function runIntegrity(trigger = 'manual') {
  const started = Date.now();
  const dbCheck = db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check);
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  const problems = [];
  if (!(dbCheck.length === 1 && dbCheck[0] === 'ok')) problems.push({ kind: 'database', detail: `SQLite integrity check: ${dbCheck.slice(0, 5).join('; ')}` });
  if (fk.length) problems.push({ kind: 'database', detail: `${fk.length} rows point at records that don't exist (${[...new Set(fk.map((r) => r.table))].join(', ')}).` });
  const matches = all(`SELECT id FROM matches WHERE status <> 'lobby'`);
  for (const m of matches) problems.push(...checkMatch(m.id));
  // Tournament fixtures agree with their matches.
  for (const f of all(`SELECT f.*, m.status AS ms FROM tournament_fixtures f LEFT JOIN matches m ON m.id = f.match_id WHERE f.status = 'completed' AND f.match_id IS NOT NULL`))
    if (!['completed', 'abandoned'].includes(f.ms)) problems.push({ kind: 'tournament', detail: `Tournament ${f.tournament_id}: ${f.round_name} is marked played but its match is ${f.ms || 'missing'}.` });
  const summary = { matches: matches.length, problems: problems.slice(0, 500), problemCount: problems.length, ms: Date.now() - started };
  run('INSERT INTO integrity_runs (at, trigger, ok, summary) VALUES (?,?,?,?)', Date.now(), trigger, problems.length ? 0 : 1, JSON.stringify(summary));
  return { ok: !problems.length, ...summary };
}
export const lastIntegrity = () => { const r = get('SELECT * FROM integrity_runs ORDER BY id DESC LIMIT 1'); return r ? { ...r, ok: !!r.ok, summary: JSON.parse(r.summary) } : null; };
