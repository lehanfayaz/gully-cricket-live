// Import squads from a spreadsheet (e.g. a curated workbook compiled from official announcements).
// Columns are found by their headings, so the sheets can be in any order. It goes through the same
// pipeline as the live sync: same people are recognised, squads are stored per season, players who
// leave are kept for history, and the import is logged as a sync run.
import ExcelJS from 'exceljs';
import { get, run, tx } from './db.js';
import * as C from './cricketdb.js';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const text = (v) => String(v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'object' ? (v.text ?? v.result ?? (v.richText ? v.richText.map((r) => r.text).join('') : '')) : v).trim();
const ROLE = (r) => { const s = norm(r); return /wicketkeeper|keeper|^wk/.test(s) ? 'wk' : /allrounder/.test(s) ? 'ar' : /bowler/.test(s) ? 'bowl' : /batter|batsman/.test(s) ? 'bat' : null; };

function sheetRows(ws) {
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => rows.push(row.values.slice(1).map(text)));
  return rows;
}
// The first row that has a "Player" heading (or "Player brought in") is the header.
function table(ws, need) {
  const rows = sheetRows(ws);
  const h = rows.findIndex((r) => need.every((n) => r.some((c) => norm(c) === n)));
  if (h < 0) return null;
  const head = rows[h].map(norm);
  const col = (...names) => head.findIndex((c) => names.some((n) => c.startsWith(n)));
  return { col, rows: rows.slice(h + 1).filter((r) => r.some(Boolean)) };
}

export async function parseWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out = { international: [], ipl: [], replacements: [], excluded: [], warnings: [], compiled: null };
  for (const ws of wb.worksheets) {
    const name = norm(ws.name);
    if (!out.compiled) for (const r of sheetRows(ws).slice(0, 4)) { const m = r.join(' ').match(/compiled\s+(\d{1,2}\s+\w+\s+\d{4})/i); if (m) out.compiled = m[1]; }
    if (name.includes('replacement')) {
      const t = table(ws, ['team', 'playerbroughtin', 'playerreplaced']);
      if (t) for (const r of t.rows) { const team = r[t.col('team')], inn = r[t.col('playerbroughtin')], outp = r[t.col('playerreplaced')]; if (team && inn) out.replacements.push({ team, in: inn, out: outp, reason: r[t.col('reason')] }); }
      continue;
    }
    const t = table(ws, ['team', 'player']);
    if (!t) continue;
    const ipl = name.includes('ipl') || t.col('code') >= 0;
    const teams = new Map();
    for (const r of t.rows) {
      const team = r[t.col('team')], player = r[t.col('player')];
      if (!team || !player) continue;
      const notes = r[t.col('notes', 'status')] || '';
      // Released players, and those ruled out of the squad, aren't part of it.
      if (/^released|ruled out/i.test(notes)) { out.excluded.push({ team, player, notes }); continue; }
      if (!teams.has(team)) teams.set(team, { name: team, short: ipl ? r[t.col('code')] || null : null, squadFor: r[t.col('squadfor')] || null, announced: r[t.col('announced')] || null, sources: new Set(), players: [] });
      const T = teams.get(team);
      const src = r[t.col('source')]; if (src) T.sources.add(src);
      T.players.push({ name: player, role: ROLE(r[t.col('role')]) || (/\bwk\b/i.test(notes) ? 'wk' : null), country: ipl ? r[t.col('country')] || null : team, notes: notes || null, overseas: ipl ? /overseas/i.test(r[t.col('indian')] || '') : null });
    }
    for (const T of teams.values()) (ipl ? out.ipl : out.international).push({ ...T, sources: [...T.sources] });
  }
  if (!out.international.length && !out.ipl.length) out.warnings.push('No squads found. Each sheet needs "Team" and "Player" headings.');
  return out;
}

// Apply a parsed workbook. Teams not in the file are left as they are.
export function applyImport(parsed, { label }) {
  const source = 'import';
  const id = Number(run('INSERT INTO sync_runs (provider, trigger, started_at) VALUES (?,?,?)', label, 'import', Date.now()).lastInsertRowid);
  const changes = { newTeams: [], renamedTeams: [], newPlayers: 0, transfers: 0, removedPlayers: 0, squads: 0, calls: 0, skipped: [], linkedPlayers: 0, unmatchedTeams: [] };
  try {
    tx(() => {
      for (const [category, list] of [['international', parsed.international], ['ipl', parsed.ipl]]) {
        if (!list.length) continue;
        const season = C.currentSeason(category);
        // Name the season by what it now holds, so players see how current it is.
        if (category === 'international') run('UPDATE cricket_seasons SET name = ?, updated_at = ? WHERE id = ?', `Latest announced squads${parsed.compiled ? ` (as of ${parsed.compiled})` : ''}`, Date.now(), season);
        else run('UPDATE cricket_seasons SET name = ?, updated_at = ? WHERE id = ?', `IPL squads${parsed.compiled ? ` (as of ${parsed.compiled})` : ''}`, Date.now(), season);
        for (const T of list) {
          const known = C.matchTeam(source, category, { name: T.name, short: T.short });
          if (!known) { changes.unmatchedTeams.push(T.name); }
          const teamId = C.upsertTeam(source, category, { name: known?.name || T.name, short: T.short || known?.short, extId: `${category}:${norm(T.name)}` }, changes);
          // One identity per person across sheets: name + country.
          const ids = T.players.map((p) => C.upsertPlayer(source, { extId: `${norm(p.name)}:${norm(p.country)}`, name: p.name, role: p.role, country: p.country }, changes));
          C.setSquad(teamId, season, [...new Set(ids)], source, changes, category);
          changes.squads += 1;
        }
      }
    });
    delete changes._moved; delete changes._released; delete changes._seen; delete changes._seenExt;
    changes.excluded = parsed.excluded; changes.replacementsNotApplied = parsed.replacements.length;
    run('UPDATE sync_runs SET finished_at = ?, ok = 1, summary = ? WHERE id = ?', Date.now(), JSON.stringify(changes), id);
    return changes;
  } catch (e) {
    run('UPDATE sync_runs SET finished_at = ?, ok = 0, error = ? WHERE id = ?', Date.now(), String(e.message || e), id);
    throw e;
  }
}
