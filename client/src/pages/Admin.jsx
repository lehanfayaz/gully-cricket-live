// Admin: cricket data sync status and manual corrections to teams and squads.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import TeamBadge from '../components/TeamBadge.jsx';

const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
const ROLES = [['bat', 'Batter'], ['wk', 'Keeper'], ['ar', 'All-rounder'], ['bowl', 'Bowler']];

export default function Admin() {
  const { user, toast } = useApp();
  const [sync, setSync] = useState(null);
  const [teams, setTeams] = useState(null);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => {
    api('/api/admin/sync').then(setSync).catch((e) => toast({ title: 'Not allowed', body: e.message }));
    api('/api/admin/teams').then(setTeams).catch(() => {});
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!user?.admin) return <p className="p-8 text-center text-chalk-dim">This page is for admins. Admins are the registered usernames listed in the server's ADMIN_USERNAMES setting.</p>;
  const runNow = async () => {
    setBusy(true);
    try { const r = await api('/api/admin/sync', { body: {} }); toast({ title: 'Sync finished', body: `${r.result.squads} squads, ${r.result.newPlayers} new players, ${r.result.transfers} transfers.` }); }
    catch (e) { toast({ title: 'Sync failed', body: e.message }); }
    setBusy(false); load();
  };
  return (
    <div className="space-y-4 px-4 pb-12 pt-2">
      <h1 className="font-display text-5xl font-extrabold leading-none">Cricket data</h1>
      <section className="panel space-y-2 p-4">
        <h2 className="font-display text-2xl font-bold">Sync</h2>
        {!sync ? <p className="text-chalk-dim">Loading…</p> : (
          <>
            <p className="text-sm">{sync.provider ? <>Source: <b>{sync.provider}</b>. Runs daily; retries an hour after a failure.</> : <span className="text-flood">No data provider set. Add CRICKETDATA_API_KEY to the server's environment (free key at cricketdata.org).</span>}</p>
            <p className="text-sm">Last successful sync: <b>{when(sync.status.lastSuccessAt)}</b></p>
            {sync.status.lastError && <p className="rounded-lg bg-leather/20 p-2 text-sm text-leather">Last problem: {sync.status.lastError}</p>}
            <button className="btn-go" disabled={busy || !sync.provider} onClick={runNow}>{busy ? 'Syncing…' : 'Sync now'}</button>
            {sync.runs.length > 0 && (
              <table className="mt-2 w-full text-sm">
                <thead className="text-left text-chalk-dim"><tr><th className="font-medium">Started</th><th className="font-medium">Trigger</th><th className="font-medium">Result</th></tr></thead>
                <tbody>
                  {sync.runs.map((r) => (
                    <tr key={r.id} className="border-t border-pitch-600 align-top">
                      <td className="py-1 pr-2">{when(r.startedAt)}</td><td className="pr-2">{r.trigger}</td>
                      <td>{r.ok == null ? 'Running' : r.ok ? `OK: ${r.summary?.squads ?? 0} squads, +${r.summary?.newPlayers ?? 0} players, ${r.summary?.transfers ?? 0} transfers, ${r.summary?.removedPlayers ?? 0} left${r.summary?.newTeams?.length ? `, new teams: ${r.summary.newTeams.join(', ')}` : ''}${r.error ? `. Warning: ${r.error}` : ''}` : <span className="text-leather">Failed: {r.error}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>
      <section className="panel p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display text-2xl font-bold">Teams</h2>
          <button className="btn-ghost py-1.5 text-base" onClick={() => setOpen('new')}>Add a team</button>
        </div>
        <p className="text-sm text-chalk-dim">Edits here are kept: the sync won't overwrite a team or player an admin has changed.</p>
        {open === 'new' && <TeamForm onDone={() => { setOpen(null); load(); }} />}
        {teams?.categories.map((c) => (
          <div key={c.id} className="mt-3">
            <h3 className="font-display text-xl font-bold">{c.name} <span className="text-sm font-medium text-chalk-dim">{c.season}</span></h3>
            <ul className="mt-1 divide-y divide-pitch-600">
              {teams.teams.filter((t) => t.category === c.id).map((t) => (
                <li key={t.id}>
                  <button className="flex w-full items-center gap-2 py-2 text-left hover:text-flood" onClick={() => setOpen(open === t.id ? null : t.id)}>
                    <TeamBadge team={t} size={26} /><span className="flex-1">{t.name}{!t.active && <span className="text-chalk-faint"> (hidden)</span>}</span>
                    <span className="text-xs text-chalk-faint">{t.squadSize} players, {t.source}</span>
                  </button>
                  {open === t.id && <TeamEditor id={t.id} onDone={load} />}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}

function TeamForm({ team, onDone }) {
  const { toast } = useApp();
  const [f, setF] = useState({ category: team?.category || 'international', name: team?.name || '', short: team?.short || '', color: team?.color || '#2A6E4C', logoUrl: team?.logo || '', country: team?.country || '', active: team?.active ?? true });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = async (e) => {
    e.preventDefault();
    try { await api('/api/admin/teams', { body: { ...f, id: team?.id } }); toast({ title: 'Team saved', ms: 2000 }); onDone(); } catch (x) { toast({ title: 'Not saved', body: x.message }); }
  };
  return (
    <form onSubmit={save} className="my-2 grid gap-2 rounded-xl bg-pitch-900/60 p-3 sm:grid-cols-3">
      {!team && <select className="field" value={f.category} onChange={set('category')}><option value="international">International</option><option value="ipl">IPL</option></select>}
      <input className="field" placeholder="Team name" value={f.name} onChange={set('name')} />
      <input className="field" placeholder="Short code" value={f.short} onChange={set('short')} maxLength={6} />
      <input className="field" placeholder="Country code (e.g. IN)" value={f.country} onChange={set('country')} maxLength={6} />
      <input className="field" placeholder="Logo URL (optional)" value={f.logoUrl} onChange={set('logoUrl')} />
      <label className="flex items-center gap-2 text-sm">Colour <input type="color" value={f.color} onChange={set('color')} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.active} onChange={set('active')} /> Show in team lists</label>
      <button className="btn-go sm:col-span-3">Save team</button>
    </form>
  );
}

function TeamEditor({ id, onDone }) {
  const { toast } = useApp();
  const [t, setT] = useState(null);
  const [p, setP] = useState({ name: '', role: 'bat' });
  const load = () => api(`/api/cricket/teams/${id}`).then(setT);
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!t) return <p className="py-2 text-sm text-chalk-dim">Loading…</p>;
  const add = async (e) => {
    e.preventDefault();
    try { await api(`/api/admin/teams/${id}/players`, { body: p }); setP({ name: '', role: 'bat' }); load(); onDone(); } catch (x) { toast({ title: 'Not added', body: x.message }); }
  };
  const remove = async (pid) => { await api(`/api/admin/teams/${id}/players/${pid}`, { method: 'DELETE' }); load(); onDone(); };
  const rename = async (pl) => {
    const name = window.prompt('Player name', pl.name);
    if (!name) return;
    await api(`/api/admin/players/${pl.id}`, { method: 'PATCH', body: { name, role: pl.role } }); load();
  };
  return (
    <div className="mb-3 space-y-2">
      <TeamForm team={t} onDone={onDone} />
      <ul className="grid gap-1 text-sm sm:grid-cols-2">
        {t.squad.map((pl) => (
          <li key={pl.id} className="flex items-center gap-2 rounded bg-pitch-900/50 px-2 py-1">
            <span className="flex-1 truncate">{pl.name}</span>
            <span className="text-xs text-chalk-faint">{ROLES.find(([k]) => k === pl.role)?.[1] || ''}</span>
            <button className="text-xs text-chalk-dim underline" onClick={() => rename(pl)}>Edit</button>
            <button className="text-xs text-leather underline" onClick={() => remove(pl.id)}>Remove</button>
          </li>
        ))}
        {!t.squad.length && <li className="text-chalk-faint">No squad yet. Run a sync, or add players by hand.</li>}
      </ul>
      <form onSubmit={add} className="flex gap-2">
        <input className="field py-2" placeholder="Add a player" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
        <select className="field w-36 py-2" value={p.role} onChange={(e) => setP({ ...p, role: e.target.value })}>{ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <button className="btn-ghost py-2">Add</button>
      </form>
    </div>
  );
}
