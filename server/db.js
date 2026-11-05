// SQLite persistence (Node's built-in node:sqlite — no native build step).
// Single process + synchronous queries means every game action runs atomically.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const file = process.env.DB_PATH || path.resolve('data/cricket.db');
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });

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
addColumn('audit', 'text', 'TEXT');                                 // readable line for match history

const cache = new Map();
const stmt = (sql) => {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
};
export const get = (sql, ...p) => stmt(sql).get(...p);
export const all = (sql, ...p) => stmt(sql).all(...p);
export const run = (sql, ...p) => stmt(sql).run(...p);

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
