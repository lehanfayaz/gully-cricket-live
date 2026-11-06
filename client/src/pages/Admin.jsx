// Admin: cricket data sync status and manual corrections to teams and squads.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import TeamBadge from '../components/TeamBadge.jsx';

const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
const ROLES = [['bat', 'Batter'], ['wk', 'Keeper'], ['ar', 'All-rounder'], ['bowl', 'Bowler']];

export function CricketData() {
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
  const canEdit = user?.permissions?.includes('cricket.manage');
  const runNow = async () => {
    setBusy(true);
    try { const r = await api('/api/admin/sync', { body: {} }); toast({ title: 'Sync finished', body: `${r.result.squads} squads, ${r.result.newPlayers} new players, ${r.result.transfers} transfers.` }); }
    catch (e) { toast({ title: 'Sync failed', body: e.message }); }
    setBusy(false); load();
  };
  return (
    <div className="space-y-4">
      <section className="panel space-y-2 p-4">
        <h2 className="font-display text-2xl font-bold">Sync</h2>
        {!sync ? <p className="text-chalk-dim">Loading…</p> : (
          <>
            <p className="text-sm">{sync.provider ? <>Source: <b>{sync.provider}</b>. Runs daily; retries an hour after a failure.</> : <span className="text-flood">No data provider set. Add CRICKETDATA_API_KEY to the server's environment (free key at cricketdata.org).</span>}</p>
            <p className="text-sm">Last successful sync: <b>{when(sync.status.lastSuccessAt)}</b></p>
            {sync.status.lastError && <p className="rounded-lg bg-leather/20 p-2 text-sm text-leather">Last problem: {sync.status.lastError}</p>}
            {canEdit && <button className="btn-go" disabled={busy || !sync.provider} onClick={runNow}>{busy ? "Syncing…" : "Sync now"}</button>}
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
          {canEdit && <button className="btn-ghost py-1.5 text-base" onClick={() => setOpen("new")}>Add a team</button>}
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

// Achievements and challenges are rules stored as data: add or change them here, no code changes needed.
export function CareerRules() {
  const { toast } = useApp();
  const [d, setD] = useState(null);
  const [edit, setEdit] = useState(null); // { kind: 'achievement'|'challenge', item }
  const load = () => api('/api/admin/achievements').then(setD).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!d) return null;
  const row = (kind, x) => (
    <li key={x.id} className="flex items-center gap-2 py-2">
      <span className="w-8 text-center text-xl" aria-hidden>{kind === 'achievement' ? x.icon : ''}</span>
      <span className="min-w-0 flex-1"><span className={`block font-semibold ${x.active ? '' : 'text-chalk-faint line-through'}`}>{x.title}{kind === 'challenge' ? <span className="ml-1 text-xs font-normal text-chalk-faint">{x.period}</span> : null}</span>
        <span className="block truncate text-xs text-chalk-faint">{describeRule(x.rule)}. {x.xp} XP. {kind === 'achievement' ? `${x.unlocks} unlocked` : `${x.completions} completions`}.</span></span>
      <button type="button" className="btn-ghost px-3 py-1 text-sm" onClick={() => setEdit({ kind, item: x })}>Edit</button>
    </li>
  );
  return (
    <section className="panel space-y-3 p-4">
      <h2 className="font-display text-2xl font-bold">Achievements and challenges</h2>
      <p className="text-sm text-chalk-dim">Each one is a rule checked against players' completed matches. New and changed rules apply to past matches straight away. Switching one off hides it, but never takes it away from players who earned it.</p>
      {edit ? <RuleForm d={d} edit={edit} onDone={(saved) => { setEdit(null); if (saved) { toast({ title: 'Saved', ms: 2000 }); load(); } }} /> : (
        <div className="flex gap-2">
          <button type="button" className="btn-go" onClick={() => setEdit({ kind: 'achievement', item: null })}>New achievement</button>
          <button type="button" className="btn-ghost" onClick={() => setEdit({ kind: 'challenge', item: null })}>New challenge</button>
        </div>
      )}
      <h3 className="font-display text-xl font-bold">Achievements</h3>
      <ul className="divide-y divide-pitch-600">{d.achievements.map((x) => row('achievement', x))}</ul>
      <h3 className="font-display text-xl font-bold">Challenges</h3>
      <ul className="divide-y divide-pitch-600">{d.challenges.map((x) => row('challenge', x))}</ul>
    </section>
  );
}
const WHERE_LABEL = { won: 'won', format: 'format', overs: 'overs =', maxOvers: 'overs ≤', vsAI: 'v the AI', aiLevel: 'AI level', maxWicketsLost: 'wickets lost ≤', hatTrick: 'hat-trick', teamCategory: 'team from', tournament: 'tournament match', allIpl: 'all IPL teams', kind: 'tournament format' };
function describeRule(r) {
  if (!r) return 'No rule';
  const w = Object.entries(r.where || {}).map(([k, v]) => `${WHERE_LABEL[k] || k} ${Array.isArray(v) ? v.join('/') : v}`).join(', ');
  const what = r.type === 'max' ? `best ${r.field} in a match ≥ ${r.target}` : r.type === 'sum' ? `total ${r.field} ≥ ${r.target}` : r.type === 'count' ? `${r.target} matches` : r.type === 'streak' ? `${r.target} in a row` : `${r.target} tournament win${r.target === 1 ? '' : 's'}`;
  return `${what}${w ? ` where ${w}` : ''}`;
}
const BOOL = ['won', 'vsAI', 'hatTrick', 'tournament', 'allIpl'];
const NUM = ['overs', 'maxOvers', 'maxWicketsLost'];
function RuleForm({ d, edit, onDone }) {
  const { toast } = useApp();
  const it = edit.item;
  const [f, setF] = useState({ id: it?.id || '', title: it?.title || '', description: it?.description || '', icon: it?.icon || '🏅', xp: it?.xp ?? 50, period: it?.period || 'daily', active: it?.active ?? true,
    type: it?.rule?.type || 'count', field: it?.rule?.field || 'runs', target: it?.rule?.target ?? 1,
    where: Object.entries(it?.rule?.where || {}).map(([k, v]) => ({ k, v: Array.isArray(v) ? v.join(', ') : String(v) })) });
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e });
  const conds = f.type === 'tournaments' ? d.schema.tournamentConditions : d.schema.conditions;
  const value = (k, v) => (BOOL.includes(k) ? v.trim() !== 'false' : NUM.includes(k) ? Number(v) : v.split(',').map((x) => x.trim()).filter(Boolean));
  const save = async (e) => {
    e.preventDefault();
    const rule = { type: f.type, target: Number(f.target), ...(f.type === 'max' || f.type === 'sum' ? { field: f.field } : {}), where: Object.fromEntries(f.where.filter((w) => w.k).map((w) => [w.k, value(w.k, w.v)])) };
    try { await api(edit.kind === 'achievement' ? '/api/admin/achievements' : '/api/admin/challenges', { body: { id: f.id, title: f.title, description: f.description, icon: f.icon, xp: Number(f.xp), period: f.period, active: f.active, rule } }); onDone(true); }
    catch (x) { toast({ title: 'Not saved', body: x.message }); }
  };
  return (
    <form onSubmit={save} className="space-y-3 rounded-xl bg-pitch-900/60 p-3">
      <div className="grid gap-2 sm:grid-cols-[1fr_2fr_5rem]">
        <div><label className="label" htmlFor="rid">Id</label><input id="rid" className="field" value={f.id} onChange={set('id')} disabled={!!it} placeholder="e.g. fast-fifty" /></div>
        <div><label className="label" htmlFor="rt">Title</label><input id="rt" className="field" value={f.title} onChange={set('title')} maxLength={40} /></div>
        {edit.kind === 'achievement' && <div><label className="label" htmlFor="ri">Icon</label><input id="ri" className="field" value={f.icon} onChange={set('icon')} maxLength={8} /></div>}
      </div>
      <div><label className="label" htmlFor="rd">Description</label><input id="rd" className="field" value={f.description} onChange={set('description')} maxLength={140} /></div>
      <div className="grid gap-2 sm:grid-cols-4">
        {edit.kind === 'challenge' && <div><label className="label" htmlFor="rp">Period</label><select id="rp" className="field" value={f.period} onChange={set('period')}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="longterm">Long term</option></select></div>}
        <div><label className="label" htmlFor="rty">Rule</label><select id="rty" className="field" value={f.type} onChange={set('type')}>{Object.keys(d.schema.types).map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
        {(f.type === 'max' || f.type === 'sum') && <div><label className="label" htmlFor="rf">Field</label><select id="rf" className="field" value={f.field} onChange={set('field')}>{Object.keys(d.schema.fields).map((k) => <option key={k} value={k}>{k}</option>)}</select></div>}
        <div><label className="label" htmlFor="rtg">Target</label><input id="rtg" type="number" min="1" className="field" value={f.target} onChange={set('target')} /></div>
        <div><label className="label" htmlFor="rx">XP</label><input id="rx" type="number" min="0" className="field" value={f.xp} onChange={set('xp')} /></div>
      </div>
      <p className="text-xs text-chalk-faint">{d.schema.types[f.type]}{(f.type === 'max' || f.type === 'sum') ? `: ${d.schema.fields[f.field]}` : ''}.</p>
      <div>
        <span className="label">Only matches where</span>
        {f.where.map((w, i) => (
          <div key={i} className="mb-1 flex gap-2">
            <select aria-label="Condition" className="field" value={w.k} onChange={(e) => setF({ ...f, where: f.where.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)) })}>
              <option value="">Pick a condition</option>{Object.keys(conds).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <input aria-label="Value" className="field" value={w.v} placeholder={BOOL.includes(w.k) ? 'true or false' : NUM.includes(w.k) ? 'a number' : 'values, comma-separated'} onChange={(e) => setF({ ...f, where: f.where.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)) })} />
            <button type="button" className="btn-ghost px-3" aria-label="Remove condition" onClick={() => setF({ ...f, where: f.where.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
        <button type="button" className="text-sm text-chalk-dim underline" onClick={() => setF({ ...f, where: [...f.where, { k: '', v: '' }] })}>Add a condition</button>
        {f.where.filter((w) => w.k).map((w) => <p key={w.k} className="text-xs text-chalk-faint">{w.k}: {conds[w.k]}</p>)}
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.active} onChange={set('active')} /> Active</label>
      <div className="flex gap-2"><button className="btn-go">Save</button><button type="button" className="btn-ghost" onClick={() => onDone(false)}>Cancel</button></div>
    </form>
  );
}
