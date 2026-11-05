// Keeps the cricket master database up to date from the configured data provider.
// Runs once a day (and on start-up if the last good sync is older than that); admins can also run it by hand.
import { all, run, get, tx } from './db.js';
import * as C from './cricketdb.js';
import { createCricketData } from './providers/cricketdata.js';

const DAY = 24 * 60 * 60 * 1000;
let running = null;
let onAlert = () => {};
export const setAlertHandler = (fn) => { onAlert = fn; };

export function provider() {
  const key = process.env.CRICKETDATA_API_KEY;
  if (!key) return null;
  return createCricketData({ apiKey: key, baseUrl: process.env.CRICKETDATA_BASE_URL || undefined });
}
export const providerName = () => (process.env.CRICKETDATA_API_KEY ? 'CricketData.org' : null);

export async function runSync(trigger = 'manual') {
  if (running) return running;
  const p = provider();
  if (!p) throw new Error('No data provider is configured. Set CRICKETDATA_API_KEY on the server.');
  const id = Number(run('INSERT INTO sync_runs (provider, trigger, started_at) VALUES (?,?,?)', p.name, trigger, Date.now()).lastInsertRowid);
  running = (async () => {
    const changes = { newTeams: [], renamedTeams: [], newPlayers: 0, transfers: 0, removedPlayers: 0, squads: 0, calls: 0, skipped: [] };
    try {
      const results = [];
      // IPL and international are fetched separately so one failing doesn't block the other.
      try { results.push({ category: 'ipl', ...(await p.ipl()) }); } catch (e) { changes.skipped.push(`IPL: ${e.message}`); }
      try {
        const names = all(`SELECT name FROM cricket_teams WHERE category = 'international'`).map((t) => t.name);
        results.push({ category: 'international', ...(await p.international(names)) });
      } catch (e) { changes.skipped.push(`International: ${e.message}`); }
      if (!results.length) throw new Error(changes.skipped.join(' '));
      tx(() => {
        for (const r of results) {
          C.upsertSeason(r.category, { ...r.season, source: p.name });
          for (const sq of r.squads) {
            if (!sq.team.name || !sq.players.length) continue;
            const teamId = C.upsertTeam(p.name, r.category, sq.team, changes);
            const ids = sq.players.map((pl) => C.upsertPlayer(p.name, pl, changes));
            C.setSquad(teamId, r.season.id, ids, p.name, changes, r.category);
            changes.squads += 1;
          }
        }
      });
      changes.calls = p.calls;
      delete changes._moved; delete changes._released;
      run('UPDATE sync_runs SET finished_at = ?, ok = 1, summary = ?, error = ? WHERE id = ?', Date.now(), JSON.stringify(changes), changes.skipped.join(' ') || null, id);
      if (changes.skipped.length) onAlert(`Cricket data sync finished with warnings: ${changes.skipped.join(' ')}`);
      return changes;
    } catch (e) {
      run('UPDATE sync_runs SET finished_at = ?, ok = 0, error = ?, summary = ? WHERE id = ?', Date.now(), String(e.message || e), JSON.stringify(changes), id);
      onAlert(`Cricket data sync failed: ${e.message || e}. Teams keep their last synced squads.`);
      throw e;
    } finally { running = null; }
  })();
  return running;
}

export function startSchedule() {
  // Once a day after a good sync; after a failure, try again an hour later.
  const due = () => {
    if (!provider()) return false;
    const s = C.syncStatus();
    if (s.running) return false;
    if (s.lastSuccessAt && Date.now() - s.lastSuccessAt < DAY) return false;
    if (s.lastAttemptAt && Date.now() - s.lastAttemptAt < 60 * 60 * 1000) return false;
    return true;
  };
  const tick = () => { if (due()) runSync('schedule').catch(() => {}); };
  setTimeout(tick, 5000);
  return setInterval(tick, 15 * 60 * 1000);
}
