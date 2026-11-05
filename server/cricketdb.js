// Real cricket teams and squads: a master database kept separate from match data.
// Matches store their own snapshot of a team, so later updates here never change finished matches.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, get, all, run, tx } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS cricket_categories (
  id TEXT PRIMARY KEY,                      -- international | ipl | …
  name TEXT NOT NULL,
  season_id TEXT                            -- the season whose squads are "current" for this category
);
CREATE TABLE IF NOT EXISTS cricket_seasons (
  id TEXT PRIMARY KEY,                      -- e.g. ipl-2026, int-current
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  year INTEGER,
  source TEXT, ext_id TEXT,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS cricket_teams (
  id TEXT PRIMARY KEY,                      -- stable internal id, e.g. int-ind, ipl-csk
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  short TEXT,
  country TEXT,                             -- ISO code where it applies (for a flag)
  color TEXT,
  logo_url TEXT,
  member TEXT,                              -- full | associate (international)
  active INTEGER NOT NULL DEFAULT 1,
  locked INTEGER NOT NULL DEFAULT 0,        -- edited by an admin: the sync won't overwrite name/short/logo
  source TEXT NOT NULL DEFAULT 'seed',      -- seed | cricketdata | manual
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS cricket_team_ext (
  team_id TEXT NOT NULL REFERENCES cricket_teams(id),
  source TEXT NOT NULL,
  ext_id TEXT NOT NULL,                     -- provider's id, or a normalised name when the provider has none
  PRIMARY KEY (source, ext_id)
);
CREATE TABLE IF NOT EXISTS cricket_players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  ext_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT,                                -- bat | bowl | ar | wk
  batting_style TEXT, bowling_style TEXT, country TEXT,
  image_url TEXT,
  locked INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER,
  UNIQUE (source, ext_id)
);
CREATE TABLE IF NOT EXISTS cricket_squads (
  team_id TEXT NOT NULL REFERENCES cricket_teams(id),
  season_id TEXT NOT NULL REFERENCES cricket_seasons(id),
  player_id INTEGER NOT NULL REFERENCES cricket_players(id),
  active INTEGER NOT NULL DEFAULT 1,
  source TEXT,
  added_at INTEGER, removed_at INTEGER,
  PRIMARY KEY (team_id, season_id, player_id)
);
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  trigger TEXT NOT NULL,                    -- schedule | manual | startup
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  ok INTEGER,
  error TEXT,
  summary TEXT                              -- JSON: counts of new/renamed teams, new players, transfers, removals
);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT);
`);

const now = () => Date.now();
export const getSetting = (k) => get('SELECT value FROM app_settings WHERE key = ?', k)?.value ?? null;
export const setSetting = (k, v) => run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v == null ? null : String(v));

// ---------- seed (first run only; never overwrites synced or edited data) ----------
const here = path.dirname(fileURLToPath(import.meta.url));
export function seedIfEmpty() {
  const seed = JSON.parse(fs.readFileSync(path.join(here, 'data/teams.seed.json'), 'utf8'));
  tx(() => {
    for (const c of seed.categories) {
      run('INSERT OR IGNORE INTO cricket_categories (id, name, season_id) VALUES (?,?,?)', c.id, c.name, c.seasonId);
      run('INSERT OR IGNORE INTO cricket_seasons (id, category, name, updated_at) VALUES (?,?,?,?)', c.seasonId, c.id, c.seasonName, now());
    }
    for (const t of seed.teams) {
      run(`INSERT OR IGNORE INTO cricket_teams (id, category, name, short, country, color, member, source, updated_at)
           VALUES (?,?,?,?,?,?,?, 'seed', ?)`, t.id, t.category, t.name, t.short, t.country || null, t.color, t.member || null, now());
    }
  });
  if (!getSetting('seed_as_of')) setSetting('seed_as_of', seed.asOf);
}

// ---------- reads ----------
const ROLE_ORDER = { bat: 0, wk: 1, ar: 2, bowl: 3 };
export function currentSeason(category) {
  return get('SELECT season_id FROM cricket_categories WHERE id = ?', category)?.season_id;
}
export function squadOf(teamId) {
  const t = get('SELECT * FROM cricket_teams WHERE id = ?', teamId);
  if (!t) return [];
  const season = currentSeason(t.category);
  return all(`SELECT p.id, p.name, p.role, p.image_url AS image, p.batting_style AS batting, p.bowling_style AS bowling, p.source
    FROM cricket_squads s JOIN cricket_players p ON p.id = s.player_id
    WHERE s.team_id = ? AND s.season_id = ? AND s.active = 1`, teamId, season)
    .sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9) || a.name.localeCompare(b.name));
}
export function teamView(t) {
  return {
    id: t.id, category: t.category, name: t.name, short: t.short, country: t.country, color: t.color,
    logo: t.logo_url, member: t.member, active: !!t.active, source: t.source, updatedAt: t.updated_at,
    squadSize: get(`SELECT COUNT(*) AS n FROM cricket_squads WHERE team_id = ? AND season_id = ? AND active = 1`, t.id, currentSeason(t.category))?.n || 0,
  };
}
export function listTeams({ includeInactive = false } = {}) {
  const cats = all('SELECT c.*, s.name AS season_name FROM cricket_categories c LEFT JOIN cricket_seasons s ON s.id = c.season_id');
  const teams = all(`SELECT * FROM cricket_teams ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY category, member = 'full' DESC, name`).map(teamView);
  return { categories: cats.map((c) => ({ id: c.id, name: c.name, season: c.season_name })), teams, sync: syncStatus() };
}
export function getTeam(id) {
  const t = get('SELECT * FROM cricket_teams WHERE id = ?', id);
  return t ? { ...teamView(t), squad: squadOf(id) } : null;
}
export function syncStatus() {
  const last = get('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1');
  const ok = get('SELECT * FROM sync_runs WHERE ok = 1 ORDER BY id DESC LIMIT 1');
  return {
    lastSuccessAt: ok?.finished_at || null, lastAttemptAt: last?.started_at || null,
    lastError: last && !last.ok && last.finished_at ? last.error : null, running: !!(last && !last.finished_at),
    seedAsOf: getSetting('seed_as_of'),
  };
}

// ---------- writes used by the sync service ----------
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// Find our team for a provider team: provider id first, then exact name or short code within the category.
export function matchTeam(source, category, ext) {
  if (ext.extId) {
    const hit = get('SELECT team_id FROM cricket_team_ext WHERE source = ? AND ext_id = ?', source, String(ext.extId));
    if (hit) return get('SELECT * FROM cricket_teams WHERE id = ?', hit.team_id);
  }
  const byName = all('SELECT * FROM cricket_teams WHERE category = ?', category)
    .find((t) => norm(t.name) === norm(ext.name) || (ext.short && norm(t.short) === norm(ext.short)));
  return byName || null;
}

export function upsertTeam(source, category, ext, changes) {
  let t = matchTeam(source, category, ext);
  if (!t) {
    const id = `${category === 'international' ? 'int' : category}-${slug(ext.short || ext.name)}`;
    run(`INSERT INTO cricket_teams (id, category, name, short, logo_url, member, source, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      id, category, ext.name, ext.short || null, ext.logo || null, ext.member || null, source, now());
    changes.newTeams.push(ext.name);
    t = get('SELECT * FROM cricket_teams WHERE id = ?', id);
  } else if (!t.locked) {
    if (ext.name && ext.name !== t.name) changes.renamedTeams.push(`${t.name} → ${ext.name}`);
    run(`UPDATE cricket_teams SET name = COALESCE(?, name), short = COALESCE(?, short), logo_url = COALESCE(?, logo_url),
         active = 1, source = ?, updated_at = ? WHERE id = ?`, ext.name || null, ext.short || null, ext.logo || null, source, now(), t.id);
  }
  if (ext.extId) run('INSERT OR IGNORE INTO cricket_team_ext (team_id, source, ext_id) VALUES (?,?,?)', t.id, source, String(ext.extId));
  return t.id;
}

export function upsertSeason(category, season) {
  run(`INSERT INTO cricket_seasons (id, category, name, year, source, ext_id, updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, year = excluded.year, ext_id = excluded.ext_id, updated_at = excluded.updated_at`,
    season.id, category, season.name, season.year || null, season.source || null, season.extId || null, now());
  // A newer season becomes the current one for its category.
  const cur = get('SELECT c.season_id, s.year FROM cricket_categories c LEFT JOIN cricket_seasons s ON s.id = c.season_id WHERE c.id = ?', category);
  if (!cur?.season_id || !cur.year || (season.year && season.year >= cur.year)) run('UPDATE cricket_categories SET season_id = ? WHERE id = ?', season.id, category);
}

export function upsertPlayer(source, p, changes) {
  const existing = get('SELECT * FROM cricket_players WHERE source = ? AND ext_id = ?', source, String(p.extId));
  if (!existing) {
    const r = run(`INSERT INTO cricket_players (source, ext_id, name, role, batting_style, bowling_style, country, image_url, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, source, String(p.extId), p.name, p.role || null, p.batting || null, p.bowling || null, p.country || null, p.image || null, now());
    changes.newPlayers += 1;
    return Number(r.lastInsertRowid);
  }
  if (!existing.locked) {
    run(`UPDATE cricket_players SET name = ?, role = COALESCE(?, role), batting_style = COALESCE(?, batting_style), bowling_style = COALESCE(?, bowling_style),
         country = COALESCE(?, country), image_url = COALESCE(?, image_url), updated_at = ? WHERE id = ?`,
      p.name, p.role || null, p.batting || null, p.bowling || null, p.country || null, p.image || null, now(), existing.id);
  }
  return existing.id;
}

// Replace a team's squad for a season: new players are added, missing ones marked inactive (kept for history).
export function setSquad(teamId, seasonId, playerIds, source, changes, category) {
  const current = new Set(all('SELECT player_id FROM cricket_squads WHERE team_id = ? AND season_id = ? AND active = 1', teamId, seasonId).map((r) => r.player_id));
  const incoming = new Set(playerIds);
  for (const pid of incoming) {
    if (current.has(pid)) continue;
    // An admin took this player out of the squad: respect that until an admin adds them back.
    if (get(`SELECT 1 FROM cricket_squads WHERE team_id = ? AND season_id = ? AND player_id = ? AND active = 0 AND source = 'manual'`, teamId, seasonId, pid)) continue;
    // Same season, different team before? That's a transfer, not a new person.
    const prev = get(`SELECT s.team_id FROM cricket_squads s JOIN cricket_teams t ON t.id = s.team_id
      WHERE s.player_id = ? AND s.season_id = ? AND s.active = 1 AND s.team_id <> ? AND t.category = ?`, pid, seasonId, teamId, category);
    if (prev) {
      run('UPDATE cricket_squads SET active = 0, removed_at = ? WHERE player_id = ? AND season_id = ? AND team_id = ?', now(), pid, seasonId, prev.team_id);
      changes.transfers += 1;
      (changes._moved ||= new Set()).add(pid);
    } else if (changes._released?.has(pid)) {
      // Left another squad earlier in this same sync: a transfer, not a release.
      changes._released.delete(pid);
      changes.removedPlayers -= 1; changes.transfers += 1;
    }
    run(`INSERT INTO cricket_squads (team_id, season_id, player_id, active, source, added_at) VALUES (?,?,?,1,?,?)
         ON CONFLICT(team_id, season_id, player_id) DO UPDATE SET active = 1, removed_at = NULL, source = excluded.source`,
      teamId, seasonId, pid, source, now());
  }
  for (const pid of current) {
    if (incoming.has(pid)) continue;
    const manual = get('SELECT source FROM cricket_squads WHERE team_id = ? AND season_id = ? AND player_id = ?', teamId, seasonId, pid)?.source === 'manual';
    if (manual) continue; // admin additions stay until an admin removes them
    run('UPDATE cricket_squads SET active = 0, removed_at = ? WHERE team_id = ? AND season_id = ? AND player_id = ?', now(), teamId, seasonId, pid);
    if (changes._moved?.has(pid)) continue;
    changes.removedPlayers += 1;
    (changes._released ||= new Set()).add(pid);
  }
}

// ---------- admin edits ----------
export function adminSaveTeam(input) {
  const category = input.category === 'ipl' ? 'ipl' : input.category === 'international' ? 'international' : null;
  if (!input.id && !category) throw new Error('Pick a category.');
  const name = String(input.name || '').trim().slice(0, 60);
  if (!name) throw new Error('Enter a team name.');
  const fields = [name, String(input.short || '').trim().slice(0, 6) || null, input.color || null, input.logoUrl || null, input.country || null, input.active === false ? 0 : 1];
  if (input.id) {
    if (!get('SELECT 1 FROM cricket_teams WHERE id = ?', input.id)) throw new Error('Team not found.');
    run('UPDATE cricket_teams SET name = ?, short = ?, color = ?, logo_url = ?, country = ?, active = ?, locked = 1, updated_at = ? WHERE id = ?', ...fields, now(), input.id);
    return input.id;
  }
  const id = `${category === 'international' ? 'int' : category}-${slug(input.short || name)}`;
  if (get('SELECT 1 FROM cricket_teams WHERE id = ?', id)) throw new Error('A team with that code already exists.');
  run(`INSERT INTO cricket_teams (id, category, name, short, color, logo_url, country, active, locked, source, updated_at) VALUES (?,?,?,?,?,?,?,?,1,'manual',?)`, id, category, ...fields, now());
  return id;
}
export function adminAddPlayer(teamId, input) {
  const t = get('SELECT * FROM cricket_teams WHERE id = ?', teamId);
  if (!t) throw new Error('Team not found.');
  const name = String(input.name || '').trim().slice(0, 60);
  if (!name) throw new Error('Enter the player\'s name.');
  const role = ['bat', 'bowl', 'ar', 'wk'].includes(input.role) ? input.role : null;
  return tx(() => {
    const ext = `manual-${now()}-${Math.random().toString(36).slice(2, 8)}`;
    const r = run(`INSERT INTO cricket_players (source, ext_id, name, role, image_url, locked, updated_at) VALUES ('manual', ?, ?, ?, ?, 1, ?)`, ext, name, role, input.imageUrl || null, now());
    const pid = Number(r.lastInsertRowid);
    run(`INSERT INTO cricket_squads (team_id, season_id, player_id, active, source, added_at) VALUES (?,?,?,1,'manual',?)`, teamId, currentSeason(t.category), pid, now());
    return pid;
  });
}
export function adminUpdatePlayer(playerId, input) {
  const p = get('SELECT * FROM cricket_players WHERE id = ?', playerId);
  if (!p) throw new Error('Player not found.');
  const role = ['bat', 'bowl', 'ar', 'wk'].includes(input.role) ? input.role : p.role;
  run('UPDATE cricket_players SET name = ?, role = ?, image_url = ?, locked = 1, updated_at = ? WHERE id = ?',
    String(input.name || p.name).trim().slice(0, 60), role, input.imageUrl ?? p.image_url, now(), playerId);
}
export function adminRemovePlayer(teamId, playerId) {
  const t = get('SELECT * FROM cricket_teams WHERE id = ?', teamId);
  if (!t) throw new Error('Team not found.');
  run('UPDATE cricket_squads SET active = 0, removed_at = ?, source = ? WHERE team_id = ? AND season_id = ? AND player_id = ?', now(), 'manual', teamId, currentSeason(t.category), playerId);
}
export const recentSyncRuns = (n = 15) => all('SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?', n)
  .map((r) => ({ id: r.id, provider: r.provider, trigger: r.trigger, startedAt: r.started_at, finishedAt: r.finished_at, ok: r.ok == null ? null : !!r.ok, error: r.error, summary: r.summary ? JSON.parse(r.summary) : null }));
