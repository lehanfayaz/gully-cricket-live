// SQLite persistence (Node's built-in node:sqlite — no native build step).
// Single process + synchronous queries means every game action runs atomically.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const file = process.env.DB_PATH || path.resolve('data/cricket.db');
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

// A restore requested from the admin page is applied here, before the database is opened.
if (file !== ':memory:') {
  const pending = path.join(path.dirname(file), 'restore-pending.json');
  if (fs.existsSync(pending)) {
    try {
      const { backup } = JSON.parse(fs.readFileSync(pending, 'utf8'));
      const check = new DatabaseSync(backup, { readOnly: true });
      const ok = check.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok';
      check.close();
      if (!ok) throw new Error('the backup failed its integrity check');
      const keep = path.join(path.dirname(file), `pre-restore-${Date.now()}.db`);
      if (fs.existsSync(file)) fs.copyFileSync(file, keep);
      for (const ext of ['-wal', '-shm']) if (fs.existsSync(file + ext)) fs.rmSync(file + ext);
      fs.copyFileSync(backup, file);
      console.warn(`Database restored from ${backup}. The previous database was kept as ${keep}.`);
    } catch (e) { console.error(`Restore not applied: ${e.message}. Starting with the current database.`); }
    fs.rmSync(pending, { force: true });
  }
}

export const db = new DatabaseSync(file);
db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  pass_hash TEXT,
  is_guest INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  umpire_id TEXT NOT NULL REFERENCES users(id),
  config TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'lobby',      -- lobby | live | innings_break | completed | abandoned
  paused INTEGER NOT NULL DEFAULT 0,
  team_a TEXT NOT NULL DEFAULT 'Team A',
  team_b TEXT NOT NULL DEFAULT 'Team B',
  toss_bat TEXT NOT NULL DEFAULT 'A',         -- team that bats first
  result TEXT,                                -- JSON
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS members (
  match_id TEXT NOT NULL REFERENCES matches(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  team TEXT,                                  -- 'A' | 'B' | NULL (spectator)
  bat_order INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, user_id)
);
CREATE TABLE IF NOT EXISTS innings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL REFERENCES matches(id),
  number INTEGER NOT NULL,
  batting TEXT NOT NULL,
  bowling TEXT NOT NULL,
  max_balls INTEGER NOT NULL,
  max_wickets INTEGER NOT NULL,
  target INTEGER,
  super_over INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'live',        -- live | done
  striker_id TEXT,
  bowler_id TEXT,
  extras INTEGER NOT NULL DEFAULT 0,          -- umpire run adjustments
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE (match_id, number)
);
CREATE TABLE IF NOT EXISTS sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  innings_id INTEGER NOT NULL REFERENCES innings(id),
  bowler_id TEXT NOT NULL,
  batter_id TEXT NOT NULL,
  seq TEXT NOT NULL,                          -- six digits, never sent to anyone but the bowler until closed
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,                         -- sha256(seq:salt), published at submission
  cap INTEGER NOT NULL,                       -- balls this set can be used for
  used INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',        -- open | closed | cancelled
  end_reason TEXT,                            -- complete | wicket | innings
  unsealed_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS balls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  innings_id INTEGER NOT NULL REFERENCES innings(id),
  set_id INTEGER NOT NULL REFERENCES sets(id),
  set_index INTEGER NOT NULL,
  ball_no INTEGER NOT NULL,                   -- legal ball number in the innings (1-based)
  stint INTEGER NOT NULL,                     -- wickets fallen before this ball: groups a batter's knock
  batter_id TEXT NOT NULL,
  bowler_id TEXT NOT NULL,
  bowl_num INTEGER NOT NULL,
  bat_num INTEGER NOT NULL,
  runs INTEGER NOT NULL,
  is_wicket INTEGER NOT NULL,
  voided INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS balls_innings ON balls(innings_id, voided);
CREATE INDEX IF NOT EXISTS balls_batter ON balls(batter_id);
CREATE INDEX IF NOT EXISTS balls_bowler ON balls(bowler_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL REFERENCES matches(id),
  channel TEXT NOT NULL,                      -- 'public' | 'pvt:<bowlerUserId>'
  user_id TEXT,
  kind TEXT NOT NULL,                         -- user | system | event
  text TEXT NOT NULL,
  meta TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_match ON messages(match_id, channel, id);
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
`);

// ---- in-place upgrades for databases created by earlier versions ----
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('matches', 'captain_a', 'TEXT');
addColumn('matches', 'captain_b', 'TEXT');
addColumn('members', 'bowl_order', 'INTEGER NOT NULL DEFAULT 0');
addColumn('members', 'bowls', 'INTEGER NOT NULL DEFAULT 1');      // in the bowling lineup?
addColumn('sets', 'bat_seq', 'TEXT');                               // batter's six, sealed until both are in
addColumn('sets', 'bat_salt', 'TEXT');
addColumn('sets', 'bat_hash', 'TEXT');
addColumn('sets', 'bowl_at', 'INTEGER');
addColumn('sets', 'bat_at', 'INTEGER');
addColumn('sets', 'revealed_at', 'INTEGER');
addColumn('audit', 'text', 'TEXT');
// Lineup confirmation and the toss
addColumn('matches', 'confirm_a', 'INTEGER');                      // timestamp the captain confirmed, NULL = pending
addColumn('matches', 'confirm_b', 'INTEGER');
addColumn('matches', 'toss_caller', 'TEXT');                       // team whose captain calls ('A' | 'B')
addColumn('matches', 'toss_call', 'TEXT');                         // 'heads' | 'tails'
addColumn('matches', 'toss_result', 'TEXT');                       // 'heads' | 'tails'
addColumn('matches', 'toss_winner', 'TEXT');                       // 'A' | 'B'
addColumn('matches', 'toss_decision', 'TEXT');                     // 'bat' | 'bowl'
addColumn('matches', 'toss_at', 'INTEGER');
// Test matches: days, sessions, suspension, declarations, follow-on, dot-over rule
addColumn('matches', 'test_day', 'INTEGER');                       // current day (1-based)
addColumn('matches', 'test_session', 'INTEGER');                   // current session within the day (1-based)
addColumn('matches', 'session_started_at', 'INTEGER');
addColumn('matches', 'break_request', 'TEXT');                     // team whose captain asked for a session break
addColumn('matches', 'resumed_at', 'INTEGER');
addColumn('innings', 'follow_on', 'INTEGER NOT NULL DEFAULT 0');
addColumn('innings', 'declared', 'INTEGER NOT NULL DEFAULT 0');
addColumn('innings', 'end_reason', 'TEXT');
addColumn('balls', 'session_idx', 'INTEGER');                       // which session (Tests) the ball was bowled in
addColumn('balls', 'dismissal', 'TEXT');                            // NULL/'matched' or 'dot_rule'
// 1v1 matches, AI players and real teams
addColumn('users', 'is_ghost', 'INTEGER NOT NULL DEFAULT 0');      // a roster player (e.g. from a real squad) played by a human or the AI
addColumn('users', 'is_bot', 'INTEGER NOT NULL DEFAULT 0');        // the AI opponent
addColumn('users', 'player_id', 'INTEGER');                        // cricket_players.id for roster players
addColumn('members', 'kind', "TEXT NOT NULL DEFAULT 'player'");    // player | controller (controls a team's roster players)
addColumn('members', 'controller_id', 'TEXT');                     // who submits for this roster player
addColumn('matches', 'team_a_meta', 'TEXT');                       // JSON snapshot: source, category, logo, colour, squad…
addColumn('matches', 'team_b_meta', 'TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS team_selections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL, side TEXT NOT NULL, team_id TEXT, team_name TEXT, user_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL
);
`);
db.exec(`
CREATE TABLE IF NOT EXISTS match_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL REFERENCES matches(id),
  idx INTEGER NOT NULL,                       -- 1, 2, 3 … across the whole match
  day INTEGER NOT NULL,
  num INTEGER NOT NULL,                       -- session number within the day
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,                            -- overs | manual | requested | match_over
  ended_by TEXT,
  UNIQUE (match_id, idx)
);
CREATE TABLE IF NOT EXISTS suspensions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL REFERENCES matches(id),
  suspended_by TEXT NOT NULL,
  suspended_at INTEGER NOT NULL,
  reason TEXT,
  status_before TEXT NOT NULL,                -- restored exactly on resume
  day INTEGER, session INTEGER,
  resumed_by TEXT,
  resumed_at INTEGER
);
CREATE TABLE IF NOT EXISTS dot_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id TEXT NOT NULL REFERENCES matches(id),
  innings_id INTEGER NOT NULL REFERENCES innings(id),
  batter_id TEXT NOT NULL,
  over_idx INTEGER NOT NULL,                  -- the over (0-based in the innings) where they must score
  status TEXT NOT NULL DEFAULT 'active',      -- active | met | dismissed | innings_end | pending | violated | waived
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  note TEXT
);
`);                                 // readable line for match history

const cache = new Map();
const stmt = (sql) => {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
};
export const get = (sql, ...p) => stmt(sql).get(...p);
export const all = (sql, ...p) => stmt(sql).all(...p);
export const run = (sql, ...p) => stmt(sql).run(...p);

// Tournaments against the AI (one human team, the rest AI). Standings are never stored: they are
// recomputed from the completed matches each time, so they can't drift from the record.
db.exec(`
CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                         -- knockout | league | groups | custom
  settings TEXT NOT NULL,                     -- JSON: match format, structure, AI
  status TEXT NOT NULL DEFAULT 'active',      -- active | completed | abandoned
  champion TEXT,                              -- team key
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS tournament_teams (
  tournament_id TEXT NOT NULL REFERENCES tournaments(id),
  key TEXT NOT NULL,                          -- T1, T2 … (seed order)
  seed INTEGER NOT NULL,
  name TEXT NOT NULL, short TEXT, color TEXT, logo TEXT, category TEXT, country TEXT,
  team_id TEXT,                               -- cricket_teams.id for real teams; NULL for custom
  group_name TEXT,
  human INTEGER NOT NULL DEFAULT 0,
  personality TEXT,
  PRIMARY KEY (tournament_id, key)
);
CREATE TABLE IF NOT EXISTS tournament_fixtures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id),
  order_no INTEGER NOT NULL,
  stage TEXT NOT NULL,                        -- group | knockout | third
  round INTEGER NOT NULL,
  round_name TEXT NOT NULL,
  group_name TEXT,
  slot INTEGER NOT NULL DEFAULT 0,
  home TEXT, away TEXT,                       -- team keys once known
  home_src TEXT, away_src TEXT,               -- JSON: where a knockout side comes from
  match_id TEXT,
  side_a TEXT,                                -- which team key played as side A in the match
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | ready | live | completed | bye
  winner TEXT,
  decided_by TEXT,                            -- result | seeding | bye
  result_text TEXT,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tfix ON tournament_fixtures (tournament_id, order_no);
`);

// Player profiles and career progression. Achievements and challenges are rules stored as data.
addColumn('users', 'avatar', 'TEXT');          // small data: URL (resized on the device before upload)
addColumn('users', 'fav_intl', 'TEXT');        // cricket_teams.id
addColumn('users', 'fav_ipl', 'TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS achievements (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, icon TEXT, xp INTEGER NOT NULL DEFAULT 0,
  rule TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY, period TEXT NOT NULL, title TEXT NOT NULL, description TEXT, xp INTEGER NOT NULL DEFAULT 0,
  rule TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_achievements (
  user_id TEXT NOT NULL, achievement_id TEXT NOT NULL,
  unlocked_at INTEGER NOT NULL,                 -- when the qualifying match or tournament ended
  ref TEXT, ref_kind TEXT,                      -- that match or tournament
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, achievement_id)
);
CREATE TABLE IF NOT EXISTS user_challenges (
  user_id TEXT NOT NULL, challenge_id TEXT NOT NULL, period_key TEXT NOT NULL,
  completed_at INTEGER NOT NULL, ref TEXT, recorded_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, challenge_id, period_key)
);
`);

// ---------- Phase 7: accounts, roles, audit and protection ----------
addColumn('users', 'role', "TEXT NOT NULL DEFAULT 'player'");      // player | moderator | admin
addColumn('users', 'status', "TEXT NOT NULL DEFAULT 'active'");    // active | suspended
addColumn('users', 'suspended_reason', 'TEXT');
addColumn('users', 'suspended_at', 'INTEGER');
addColumn('users', 'last_seen_at', 'INTEGER');
addColumn('sessions', 'last_used_at', 'INTEGER');
addColumn('matches', 'abandoned_reason', 'TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user_id TEXT, username TEXT,
  action TEXT NOT NULL, target_type TEXT, target_id TEXT, detail TEXT, ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_audit ON admin_audit (at);
CREATE TABLE IF NOT EXISTS error_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, source TEXT, route TEXT, user_id TEXT, message TEXT, stack TEXT
);
CREATE TABLE IF NOT EXISTS admin_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, read_at INTEGER
);
CREATE TABLE IF NOT EXISTS integrity_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, trigger TEXT, ok INTEGER NOT NULL, summary TEXT
);
-- Recorded deliveries are permanent. The only changes the game itself makes are allowed:
-- voiding (0 -> 1, never back), and a dot-over-rule dismissal on a ball that scored nothing.
CREATE TRIGGER IF NOT EXISTS balls_no_edit BEFORE UPDATE OF bat_num, bowl_num, runs, ball_no, innings_id, batter_id, bowler_id, set_id, stint, session_idx ON balls
BEGIN SELECT RAISE(ABORT, 'Recorded deliveries cannot be changed.'); END;
CREATE TRIGGER IF NOT EXISTS balls_wicket_rule BEFORE UPDATE OF is_wicket, dismissal ON balls
WHEN NOT (NEW.is_wicket = 1 AND NEW.dismissal = 'dot_rule' AND OLD.runs = 0) AND (NEW.is_wicket IS NOT OLD.is_wicket OR NEW.dismissal IS NOT OLD.dismissal)
BEGIN SELECT RAISE(ABORT, 'Recorded deliveries cannot be changed.'); END;
CREATE TRIGGER IF NOT EXISTS balls_unvoid BEFORE UPDATE OF voided ON balls WHEN NEW.voided < OLD.voided
BEGIN SELECT RAISE(ABORT, 'A voided delivery stays voided.'); END;
CREATE TRIGGER IF NOT EXISTS balls_no_delete BEFORE DELETE ON balls
BEGIN SELECT RAISE(ABORT, 'Recorded deliveries cannot be deleted.'); END;
-- Locked-in numbers can't be swapped once committed.
CREATE TRIGGER IF NOT EXISTS sets_seq_fixed BEFORE UPDATE OF seq, salt, hash ON sets
WHEN OLD.hash IS NOT NULL AND OLD.hash <> '' AND (NEW.seq IS NOT OLD.seq OR NEW.salt IS NOT OLD.salt OR NEW.hash IS NOT OLD.hash)
BEGIN SELECT RAISE(ABORT, 'Locked-in numbers cannot be changed.'); END;
CREATE TRIGGER IF NOT EXISTS sets_batseq_fixed BEFORE UPDATE OF bat_seq, bat_salt, bat_hash ON sets
WHEN OLD.bat_hash IS NOT NULL AND OLD.bat_hash <> '' AND (NEW.bat_seq IS NOT OLD.bat_seq OR NEW.bat_salt IS NOT OLD.bat_salt OR NEW.bat_hash IS NOT OLD.bat_hash)
BEGIN SELECT RAISE(ABORT, 'Locked-in numbers cannot be changed.'); END;
CREATE TRIGGER IF NOT EXISTS sets_no_delete BEFORE DELETE ON sets
BEGIN SELECT RAISE(ABORT, 'Submissions cannot be deleted.'); END;
CREATE TRIGGER IF NOT EXISTS innings_no_delete BEFORE DELETE ON innings
BEGIN SELECT RAISE(ABORT, 'Innings cannot be deleted.'); END;
-- The match event log and the admin audit log are append-only.
CREATE TRIGGER IF NOT EXISTS audit_append_only BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'The match event log is append-only.'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'The match event log is append-only.'); END;
CREATE TRIGGER IF NOT EXISTS admin_audit_append_only BEFORE UPDATE ON admin_audit BEGIN SELECT RAISE(ABORT, 'The admin audit log is append-only.'); END;
CREATE TRIGGER IF NOT EXISTS admin_audit_no_delete BEFORE DELETE ON admin_audit BEGIN SELECT RAISE(ABORT, 'The admin audit log is append-only.'); END;
`);
// Keep a database file safe: write-ahead logging, and foreign keys checked.
try { db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;'); } catch {}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
