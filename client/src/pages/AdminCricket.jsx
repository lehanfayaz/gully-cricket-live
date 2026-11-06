// Cricket data tools for staff: spreadsheet import, seasons, squad history, player search and duplicates.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';

const when = (t) => (t ? new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const ROLE = { bat: 'Batter', bowl: 'Bowler', ar: 'All-rounder', wk: 'Keeper' };

export function CricketTools({ perms }) {
  const canEdit = perms.includes('cricket.manage');
  return (
    <>
      {canEdit && <Import />}
      <Seasons />
      <SquadHistory />
      <Players />
      <Duplicates canEdit={canEdit} />
    </>
  );
}

function Import() {
  const { toast } = useApp();
  const [file, setFile] = useState(null), [preview, setPreview] = useState(null), [busy, setBusy] = useState(false), [done, setDone] = useState(null);
  const send = async (dry) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/cricket/import?name=${encodeURIComponent(file.name)}${dry ? '&dryRun=1' : ''}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${localStorage.getItem('gcl_token')}` }, body: await file.arrayBuffer() });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      if (dry) setPreview(j.preview); else { setDone(j.result); setPreview(null); toast({ title: 'Squads imported', body: `${j.result.squads} squads, ${j.result.newPlayers} new players.` }); }
    } catch (e) { toast({ title: 'Import failed', body: e.message }); }
    setBusy(false);
  };
  const total = (l) => l.reduce((s, t) => s + t.players, 0);
  return (
    <section className="panel space-y-3 p-4">
      <h2 className="font-display text-2xl font-bold">Import squads from a spreadsheet</h2>
      <p className="text-sm text-chalk-dim">An .xlsx workbook with sheets that have “Team” and “Player” columns (and optionally Role, Country, Code, Notes, Source). IPL sheets are recognised by name or a Code column. Players marked released or ruled out are left out. You'll see a preview before anything changes. Teams not in the file aren't touched; imported squads aren't overwritten by the automatic sync.</p>
      <div className="flex flex-wrap items-center gap-2">
        <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Spreadsheet" onChange={(e) => { setFile(e.target.files?.[0] || null); setPreview(null); setDone(null); }} className="text-sm" />
        <button type="button" className="btn-ghost" disabled={!file || busy} onClick={() => send(true)}>Preview</button>
      </div>
      {preview && (
        <div className="space-y-2 rounded-xl bg-pitch-900/60 p-3 text-sm">
          <p><b>{preview.international.length} international squads</b> ({total(preview.international)} players) and <b>{preview.ipl.length} IPL squads</b> ({total(preview.ipl)} players){preview.compiled ? `, compiled ${preview.compiled}` : ''}.</p>
          {preview.international.length > 0 && <p className="text-chalk-dim">{preview.international.map((t) => `${t.name} ${t.players}`).join(', ')}</p>}
          {preview.ipl.length > 0 && <p className="text-chalk-dim">{preview.ipl.map((t) => `${t.short || t.name} ${t.players}`).join(', ')}</p>}
          {[...preview.international, ...preview.ipl].some((t) => !t.updates) && <p className="text-flood">New teams will be added for: {[...preview.international, ...preview.ipl].filter((t) => !t.updates).map((t) => t.name).join(', ')}. If one of these is an existing team under another name, rename it first so it's updated instead.</p>}
                    {preview.excluded.length > 0 && <p>Left out: {preview.excluded.map((x) => `${x.player} (${x.team}: ${x.notes})`).join('; ')}.</p>}
          {preview.replacements.length > 0 && <p className="text-chalk-dim">{preview.replacements.length} in-season replacements are listed separately and are not applied to the squads.</p>}
          {preview.warnings.map((w) => <p key={w} className="text-leather">{w}</p>)}
          <button type="button" className="btn-go" disabled={busy || preview.warnings.length > 0} onClick={() => send(false)}>Import these squads</button>
        </div>
      )}
      {done && <p className="text-sm text-turf">Imported: {done.squads} squads, {done.newPlayers} new players, {done.linkedPlayers || 0} matched to existing records, {done.transfers} moves between teams, {done.removedPlayers} no longer in a squad (kept for history).</p>}
    </section>
  );
}

function Seasons() {
  const [d, setD] = useState(null);
  useEffect(() => { api('/api/admin/cricket/seasons').then(setD).catch(() => setD({ seasons: [] })); }, []);
  if (!d) return null;
  return (
    <section className="panel overflow-x-auto p-4">
      <h2 className="font-display text-2xl font-bold">Seasons</h2>
      <p className="text-sm text-chalk-dim">Squads are stored per season, so a player's earlier teams are kept. The current season of each competition is what players pick from.</p>
      <table className="mt-2 w-full min-w-[30rem] text-sm [&_td]:px-2"><tbody>{d.seasons.map((s) => (
        <tr key={s.id} className="border-t border-pitch-600"><td className="py-1.5 font-semibold">{s.name}</td><td>{s.category}</td><td>{s.teams} teams, {s.players} players</td><td>{s.current ? <span className="text-turf">current</span> : 'earlier'}</td><td className="text-chalk-dim">updated {when(s.updatedAt)}</td></tr>
      ))}</tbody></table>
    </section>
  );
}

function SquadHistory() {
  const [teams, setTeams] = useState([]), [team, setTeam] = useState(''), [season, setSeason] = useState(''), [d, setD] = useState(null);
  useEffect(() => { api('/api/admin/teams').then((r) => setTeams(r.teams)).catch(() => {}); }, []);
  useEffect(() => { if (!team) return; api(`/api/admin/cricket/teams/${team}/squad${season ? `?season=${season}` : ''}`).then(setD).catch(() => setD(null)); }, [team, season]);
  return (
    <section className="panel space-y-2 p-4">
      <h2 className="font-display text-2xl font-bold">Squads by season</h2>
      <div className="flex flex-wrap gap-2">
        <select className="field w-auto" aria-label="Team" value={team} onChange={(e) => { setTeam(e.target.value); setSeason(''); }}><option value="">Pick a team</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        {d?.seasons.length > 0 && <select className="field w-auto" aria-label="Season" value={season || d.season} onChange={(e) => setSeason(e.target.value)}>{d.seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
      </div>
      {d && (d.players.length ? (
        <ul className="grid gap-x-4 text-sm sm:grid-cols-2">{d.players.map((p) => (
          <li key={p.id} className={`flex justify-between gap-2 border-t border-pitch-600 py-1 ${p.active ? '' : 'text-chalk-faint line-through'}`}>
            <span>{p.name} <span className="text-chalk-faint">{ROLE[p.role] || ''}{p.country ? `, ${p.country}` : ''}</span></span>
            <span className="shrink-0 text-xs text-chalk-faint">{p.active ? `added ${when(p.added_at)}${p.added_by ? ` (${p.added_by})` : ''}` : `left ${when(p.removed_at)}`}</span>
          </li>
        ))}</ul>
      ) : <p className="text-sm text-chalk-dim">No squad recorded for this season. Matches use numbered stand-in players.</p>)}
    </section>
  );
}

function Players() {
  const [q, setQ] = useState(''), [d, setD] = useState(null);
  useEffect(() => { if (q.trim().length < 2) { setD(null); return; } const h = setTimeout(() => api(`/api/admin/cricket/players?q=${encodeURIComponent(q)}`).then(setD).catch(() => {}), 250); return () => clearTimeout(h); }, [q]);
  return (
    <section className="panel space-y-2 p-4">
      <h2 className="font-display text-2xl font-bold">Players</h2>
      <input className="field max-w-sm" placeholder="Search players by name" aria-label="Search players" value={q} onChange={(e) => setQ(e.target.value)} />
      {d && (d.players.length ? <ul className="text-sm">{d.players.map((p) => (
        <li key={p.id} className="border-t border-pitch-600 py-1.5"><b>{p.name}</b> <span className="text-chalk-dim">{ROLE[p.role] || ''}{p.country ? `, ${p.country}` : ''}{p.teams ? `. Now: ${p.teams}` : '. Not in a current squad'}</span>
          <span className="block text-xs text-chalk-faint">Record {p.id}{p.locked ? ', edited by an admin' : ''}. Known as: {p.ids.map((x) => `${x.source} ${x.ext_id}`).join('; ')}</span></li>
      ))}</ul> : <p className="text-sm text-chalk-dim">No players match.</p>)}
    </section>
  );
}

function Duplicates({ canEdit }) {
  const { toast } = useApp();
  const [d, setD] = useState(null);
  const load = () => api('/api/admin/cricket/duplicates').then(setD).catch(() => setD({ groups: [] }));
  useEffect(() => { load(); }, []);
  if (!d) return null;
  const merge = async (keep, dup) => {
    if (!window.confirm(`Merge ${dup.name} (record ${dup.id}) into record ${keep.id}? Squad places and past matches move to the kept record.`)) return;
    try { await api('/api/admin/cricket/merge', { body: { keep: keep.id, duplicate: dup.id } }); toast({ title: 'Merged' }); load(); } catch (e) { toast({ title: 'Not merged', body: e.message }); }
  };
  return (
    <section className="panel space-y-2 p-4">
      <h2 className="font-display text-2xl font-bold">Possible duplicates</h2>
      <p className="text-sm text-chalk-dim">Records with the same name and no conflicting country. The sync already recognises the same person by id and by name; these are the ones it couldn't be sure about.</p>
      {d.groups.length ? d.groups.map((g, i) => (
        <div key={i} className="rounded-lg bg-pitch-900/60 p-2 text-sm">
          {g.map((p, k) => (
            <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
              <span><b>{p.name}</b> <span className="text-chalk-dim">record {p.id}, {p.source}{p.country ? `, ${p.country}` : ''}{p.teams.length ? `, in ${p.teams.join(', ')}` : ''}</span></span>
              {canEdit && k > 0 && <button type="button" className="underline" onClick={() => merge(g[0], p)}>Merge into record {g[0].id}</button>}
            </div>
          ))}
        </div>
      )) : <p className="text-sm text-turf">None found.</p>}
    </section>
  );
}
