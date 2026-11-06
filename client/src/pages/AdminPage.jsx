// The admin dashboard. Each tab appears only for staff with the permission it needs; the server checks
// the same permissions on every request.
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import { loadAppConfig } from '../appConfig.js';
import { CareerRules, CricketData } from './Admin.jsx';
import { CricketTools } from './AdminCricket.jsx';

const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const TABS = [
  ['overview', 'Overview', 'admin.view'], ['users', 'Users', 'users.view'], ['matches', 'Matches', 'matches.view'],
  ['cricket', 'Cricket data', 'admin.view'], ['settings', 'Settings', 'config.manage'], ['logs', 'Logs', 'audit.view'], ['system', 'System', 'system.manage'],
];
const useLoad = (url, deps = []) => {
  const [d, setD] = useState(null), [err, setErr] = useState('');
  const load = useCallback(() => api(url).then((x) => { setD(x); setErr(''); }).catch((e) => setErr(e.message)), [url]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return [d, load, err];
};

export default function AdminPage() {
  const { user } = useApp();
  const perms = user?.permissions || [];
  const [tab, setTab] = useState('overview');
  if (!perms.includes('admin.view')) return <p className="p-8 text-center text-chalk-dim">This page is for the organisers. Owners are set in the server's ADMIN_USERNAMES setting; they can make others moderators or admins.</p>;
  const tabs = TABS.filter(([, , p]) => perms.includes(p));
  return (
    <div className="space-y-4 px-4 pb-12 pt-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="font-display text-5xl font-extrabold leading-none">Admin</h1>
        <span className="text-sm text-chalk-dim">Signed in as {user.username}, {user.role}</span>
      </div>
      <nav className="no-scrollbar flex gap-1 overflow-x-auto pb-1" aria-label="Admin sections">
        {tabs.map(([k, l]) => <button key={k} type="button" aria-current={tab === k} onClick={() => setTab(k)} className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold ${tab === k ? 'bg-flood text-pitch-900' : 'bg-pitch-700 text-chalk-dim hover:text-chalk'}`}>{l}</button>)}
      </nav>
      {tab === 'overview' && <Overview go={setTab} perms={perms} />}
      {tab === 'users' && <Users perms={perms} />}
      {tab === 'matches' && <Matches perms={perms} />}
      {tab === 'cricket' && <div className="space-y-4"><CricketData /><CricketTools perms={perms} /></div>}
      {tab === 'settings' && <Settings />}
      {tab === 'logs' && <Logs />}
      {tab === 'system' && <SystemTab />}
    </div>
  );
}

const Card = ({ k, v, sub, onClick }) => (
  <button type="button" onClick={onClick} disabled={!onClick} className="panel p-4 text-left enabled:hover:ring-2 enabled:hover:ring-pitch-500">
    <div className="font-display text-4xl font-bold tabular-nums">{v}</div><div className="text-sm text-chalk-dim">{k}</div>{sub && <div className="text-xs text-chalk-faint">{sub}</div>}
  </button>
);

function Overview({ go, perms }) {
  const { toast } = useApp();
  const [d, load, err] = useLoad('/api/admin/overview');
  if (err) return <p className="text-leather">{err}</p>;
  if (!d) return <p className="text-chalk-dim">Loading…</p>;
  const read = async () => { await api('/api/admin/notifications/read', { body: {} }).catch((e) => toast({ title: 'Not done', body: e.message })); load(); };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card k="Players" v={d.users} sub={`${d.registered} registered, ${d.activeToday} active today`} onClick={perms.includes('users.view') ? () => go('users') : null} />
        <Card k="Live and waiting matches" v={d.matches.active} sub={`${d.matches.suspended} suspended`} onClick={() => go('matches')} />
        <Card k="Suspended accounts" v={d.suspended} onClick={perms.includes('users.view') ? () => go('users') : null} />
        <Card k="Server errors today" v={d.errorsToday} onClick={perms.includes('audit.view') ? () => go('logs') : null} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <section className="panel p-4"><h2 className="font-display text-xl font-bold">Cricket data</h2>
          <p className={`text-sm ${d.sync.stale ? 'text-flood' : 'text-chalk-dim'}`}>{d.sync.lastSuccessAt ? `Last synced ${when(d.sync.lastSuccessAt)}${d.sync.lastSource ? ` from ${d.sync.lastSource}` : ''}.` : 'Never synced.'}{d.sync.stale ? ` Squads older than ${d.sync.staleDays} days are shown to players with their date, as possibly out of date.` : ''}</p>
          {d.sync.lastError && <p className="mt-1 text-sm text-leather">Last problem: {d.sync.lastError}</p>}</section>
        <section className="panel p-4"><h2 className="font-display text-xl font-bold">Data check</h2>
          {d.integrity ? <p className={`text-sm ${d.integrity.ok ? 'text-turf' : 'text-leather'}`}>{d.integrity.ok ? `All good: ${d.integrity.summary.matches} matches checked` : `${d.integrity.summary.problemCount} problem(s) found`} ({when(d.integrity.at)}).</p> : <p className="text-sm text-chalk-dim">Not run yet. It runs daily.</p>}</section>
        <section className="panel p-4"><h2 className="font-display text-xl font-bold">Backups</h2>
          {d.backups ? (d.backups[0] ? <p className="text-sm text-chalk-dim">Latest: {when(d.backups[0].at)} ({d.backups[0].trigger}){d.backups[0].ok ? ', verified' : ''}.</p> : <p className="text-sm text-flood">No backups yet.</p>) : <p className="text-sm text-chalk-dim">Admins only.</p>}</section>
      </div>
      <section className="panel p-4">
        <div className="flex items-baseline justify-between gap-2"><h2 className="font-display text-xl font-bold">Notifications ({d.unread} unread)</h2>{d.unread > 0 && <button type="button" className="text-sm text-chalk-dim underline" onClick={read}>Mark all read</button>}</div>
        {d.notifications.length ? <ul className="mt-2 divide-y divide-pitch-600 text-sm">{d.notifications.map((n) => <li key={n.id} className={`py-2 ${n.read ? 'text-chalk-dim' : ''}`}><span className="text-xs text-chalk-faint">{when(n.at)}, {n.kind}</span><br />{n.text}</li>)}</ul> : <p className="text-sm text-chalk-dim">Nothing to report.</p>}
      </section>
    </div>
  );
}

// ---------- users ----------
function Users({ perms }) {
  const [q, setQ] = useState(''), [status, setStatus] = useState(''), [page, setPage] = useState(1), [open, setOpen] = useState(null);
  const [d, load, err] = useLoad(`/api/admin/users?q=${encodeURIComponent(q)}&status=${status}&page=${page}`, [q, status, page]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input className="field max-w-xs py-2" placeholder="Search name, username or id" aria-label="Search users" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <select className="field w-auto py-2" aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All accounts</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="guest">Guests</option></select>
      </div>
      {err && <p className="text-leather">{err}</p>}
      {open && <UserDetail id={open} perms={perms} onClose={() => { setOpen(null); load(); }} />}
      {d && (
        <section className="panel overflow-x-auto p-2">
          <table className="w-full min-w-[36rem] text-sm [&_td]:px-2 [&_th]:px-2">
            <thead className="text-left text-chalk-dim"><tr><th className="py-1 font-medium">Name</th><th className="font-medium">Username</th><th className="font-medium">Role</th><th className="font-medium">Status</th><th className="font-medium">Matches</th><th className="font-medium">Last seen</th></tr></thead>
            <tbody>{d.users.map((u) => (
              <tr key={u.id} className="cursor-pointer border-t border-pitch-600 hover:bg-pitch-700" onClick={() => setOpen(u.id)}>
                <td className="py-2 font-semibold"><button type="button" className="text-left underline-offset-2 hover:underline">{u.name}</button></td><td>{u.guest ? <span className="text-chalk-faint">guest</span> : u.username}</td>
                <td>{u.role}{u.owner ? ' (owner)' : ''}</td><td className={u.status === 'suspended' ? 'text-leather' : ''}>{u.status}</td><td className="tabular-nums">{u.matches}</td><td className="text-chalk-dim">{when(u.lastSeenAt)}</td>
              </tr>
            ))}</tbody>
          </table>
          <div className="flex items-center justify-between p-2 text-sm text-chalk-dim">
            <span>{d.total} accounts</span>
            <span className="flex gap-2"><button type="button" className="btn-ghost px-3 py-1" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><button type="button" className="btn-ghost px-3 py-1" disabled={page * d.per >= d.total} onClick={() => setPage(page + 1)}>Next</button></span>
          </div>
        </section>
      )}
    </div>
  );
}

function UserDetail({ id, perms, onClose }) {
  const { toast } = useApp();
  const [d, load, err] = useLoad(`/api/admin/users/${id}`, [id]);
  const [f, setF] = useState(null), [reason, setReason] = useState(''), [role, setRole] = useState('');
  useEffect(() => { if (d) { setF({ username: d.user.username || '', name: d.user.name }); setRole(d.user.role); } }, [d]);
  if (err) return <p className="text-leather">{err}</p>;
  if (!d || !f) return <p className="text-chalk-dim">Loading…</p>;
  const u = d.user;
  const act = async (fn, msg) => { try { await fn(); toast({ title: msg, ms: 2000 }); load(); } catch (e) { toast({ title: 'Not done', body: e.message }); } };
  const b = d.career.batting, w = d.career.bowling, r = d.career.record;
  return (
    <section className="panel space-y-3 p-4 ring-2 ring-flood/40">
      <div className="flex items-start justify-between gap-2">
        <div><h2 className="font-display text-3xl font-bold">{u.name}</h2><p className="text-sm text-chalk-dim">{u.guest ? 'Guest' : `@${u.username}`}, {u.role}{u.owner ? ' (owner)' : ''}, joined {when(u.createdAt)}, {d.sessions} signed-in device(s)</p>
          {u.status === 'suspended' && <p className="text-sm text-leather">Suspended {when(u.suspendedAt)}: {u.suspendedReason}</p>}</div>
        <button type="button" className="btn-ghost px-3 py-1" onClick={onClose}>Close</button>
      </div>
      <div className="grid grid-cols-3 gap-2 text-sm sm:grid-cols-6">
        {[['Matches', r.matches], ['Won', r.won], ['Runs', b.runs], ['Average', b.average ?? '–'], ['Wickets', w.wickets], ['Economy', w.economy ?? '–']].map(([k, v]) => <div key={k}><div className="font-display text-2xl font-bold">{v}</div><div className="text-chalk-dim">{k}</div></div>)}
      </div>
      {d.level && <p className="text-sm text-chalk-dim">Level {d.level.name}, {d.level.xp} XP, {d.level.achievements} achievements, {d.level.tournamentWins} tournament wins. <Link className="underline" to={`/u/${u.id}`}>Open profile</Link></p>}
      {perms.includes('users.edit') && (
        <form className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); act(() => api(`/api/admin/users/${id}`, { method: 'PATCH', body: u.guest ? { name: f.name } : f }), 'Saved'); }}>
          {!u.guest && <div><label className="label" htmlFor="au">Username</label><input id="au" className="field" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></div>}
          <div><label className="label" htmlFor="an">Display name</label><input id="an" className="field" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <button className="btn-go">Save names</button>
        </form>
      )}
      {perms.includes('users.role') && !u.owner && !u.guest && (
        <div className="flex flex-wrap items-end gap-2">
          <div><label className="label" htmlFor="ar">Role</label><select id="ar" className="field" value={role} onChange={(e) => setRole(e.target.value)}><option value="player">Player</option><option value="moderator">Moderator</option><option value="admin">Admin</option></select></div>
          <button type="button" className="btn-ghost" disabled={role === u.role} onClick={() => act(() => api(`/api/admin/users/${id}/role`, { body: { role } }), 'Role changed')}>Change role</button>
        </div>
      )}
      {perms.includes('users.suspend') && !u.owner && (u.status === 'suspended'
        ? <button type="button" className="btn-go" onClick={() => act(() => api(`/api/admin/users/${id}/status`, { body: { status: 'active' } }), 'Account reactivated')}>Reactivate account</button>
        : <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1"><label className="label" htmlFor="sr">Reason for suspending</label><input id="sr" className="field" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} /></div>
            <button type="button" className="btn-ghost text-leather" disabled={reason.trim().length < 3} onClick={() => { if (window.confirm(`Suspend ${u.name}? They'll be signed out everywhere.`)) act(() => api(`/api/admin/users/${id}/status`, { body: { status: 'suspended', reason } }), 'Account suspended'); }}>Suspend</button>
          </div>)}
      {d.recent.length > 0 && <div><h3 className="font-display text-lg font-bold">Recent matches</h3><ul className="text-sm">{d.recent.map((m) => <li key={m.id}><Link className="underline" to={`/m/${m.id}/stats`}>{m.name}</Link> <span className="text-chalk-dim">{m.outcome}, {m.runs} runs, {m.wickets} wickets</span></li>)}</ul></div>}
    </section>
  );
}

// ---------- matches ----------
function Matches({ perms }) {
  const { toast } = useApp();
  const [group, setGroup] = useState('active'), [q, setQ] = useState(''), [page, setPage] = useState(1), [open, setOpen] = useState(null), [days, setDays] = useState(14);
  const [d, load, err] = useLoad(`/api/admin/matches?group=${group}&q=${encodeURIComponent(q)}&page=${page}`, [group, q, page]);
  const cleanup = async () => {
    if (!window.confirm(`Abandon every lobby that hasn't started in ${days} days?`)) return;
    try { const r = await api('/api/admin/matches/cleanup', { body: { days } }); toast({ title: `${r.abandoned} lobbies abandoned` }); load(); } catch (e) { toast({ title: 'Not done', body: e.message }); }
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {[['active', 'Active'], ['suspended', 'Suspended'], ['completed', 'Completed'], ['abandoned', 'Abandoned']].map(([k, l]) => <button key={k} type="button" aria-pressed={group === k} onClick={() => { setGroup(k); setPage(1); setOpen(null); }} className={`rounded-full px-3 py-1 text-sm font-semibold ${group === k ? 'bg-turf text-pitch-900' : 'bg-pitch-700 text-chalk-dim'}`}>{l}</button>)}
        <input className="field ml-auto w-48 py-1.5 text-sm" placeholder="Code or name" aria-label="Search matches" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
      </div>
      {open && <MatchInspect id={open} perms={perms} onClose={() => { setOpen(null); load(); }} />}
      {err && <p className="text-leather">{err}</p>}
      {d && (
        <section className="panel overflow-x-auto p-2">
          <table className="w-full min-w-[36rem] text-sm [&_td]:px-2 [&_th]:px-2">
            <thead className="text-left text-chalk-dim"><tr><th className="py-1 font-medium">Code</th><th className="font-medium">Match</th><th className="font-medium">Format</th><th className="font-medium">Status</th><th className="font-medium">People</th><th className="font-medium">Last activity</th></tr></thead>
            <tbody>{d.matches.map((m) => (
              <tr key={m.id} className="cursor-pointer border-t border-pitch-600 hover:bg-pitch-700" onClick={() => setOpen(m.id)}>
                <td className="py-2 font-mono"><button type="button" className="hover:underline">{m.id}</button></td>
                <td><span className="font-semibold">{m.name}</span>{m.tournament && <span className="block text-xs text-chalk-faint">{m.tournament}</span>}{m.result && <span className="block text-xs text-chalk-dim">{m.result}</span>}</td>
                <td>{m.format}{m.participation === 'ai' ? ' v AI' : m.participation === 'aivai' ? ' AI v AI' : ''}</td><td>{m.status.replace('_', ' ')}</td><td className="tabular-nums">{m.people}</td><td className="text-chalk-dim">{when(m.endedAt || m.lastEventAt || m.createdAt)}</td>
              </tr>
            ))}</tbody>
          </table>
          {!d.matches.length && <p className="p-3 text-chalk-dim">No matches here.</p>}
          <div className="flex items-center justify-between p-2 text-sm text-chalk-dim"><span>{d.total} matches</span>
            <span className="flex gap-2"><button type="button" className="btn-ghost px-3 py-1" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><button type="button" className="btn-ghost px-3 py-1" disabled={page * d.per >= d.total} onClick={() => setPage(page + 1)}>Next</button></span></div>
        </section>
      )}
      {perms.includes('matches.manage') && group === 'active' && (
        <section className="panel flex flex-wrap items-end gap-2 p-4">
          <div><label className="label" htmlFor="cd">Abandon lobbies not started for (days)</label><input id="cd" type="number" min="1" max="365" className="field w-28" value={days} onChange={(e) => setDays(Number(e.target.value))} /></div>
          <button type="button" className="btn-ghost" onClick={cleanup}>Clean up old lobbies</button>
        </section>
      )}
    </div>
  );
}

function MatchInspect({ id, perms, onClose }) {
  const { toast } = useApp();
  const [d, load, err] = useLoad(`/api/admin/matches/${id}`, [id]);
  const [reason, setReason] = useState(''), [show, setShow] = useState('events');
  if (err) return <p className="text-leather">{err}</p>;
  if (!d) return <p className="text-chalk-dim">Loading…</p>;
  const m = d.match;
  const abandon = async () => {
    if (!window.confirm(`Abandon ${m.name}? It ends as no result; nothing already played changes.`)) return;
    try { await api(`/api/admin/matches/${id}/abandon`, { body: { reason } }); toast({ title: 'Match abandoned' }); load(); } catch (e) { toast({ title: 'Not done', body: e.message }); }
  };
  return (
    <section className="panel space-y-3 p-4 ring-2 ring-flood/40">
      <div className="flex items-start justify-between gap-2">
        <div><h2 className="font-display text-3xl font-bold">{m.name} <span className="font-mono text-lg text-chalk-dim">{m.id}</span></h2>
          <p className="text-sm text-chalk-dim">{m.status.replace('_', ' ')}, {m.config.format}{m.config.participation === 'ai' ? ' against the AI' : ''}, created {when(m.createdAt)}{m.endedAt ? `, ended ${when(m.endedAt)}` : ''}.</p>
          {m.result && <p className="text-sm">{m.result.text}</p>}</div>
        <button type="button" className="btn-ghost px-3 py-1" onClick={onClose}>Close</button>
      </div>
      <div className="flex flex-wrap gap-3 text-sm">{d.score.map((i) => <span key={i.number} className="rounded-lg bg-pitch-900/60 px-3 py-1"><b>{i.team}</b> {i.runs}/{i.wickets} ({i.overs}){i.extras ? `, umpire adjustments ${i.extras}` : ''}</span>)}
        <Link className="underline" to={`/m/${m.id}`}>Open match</Link><Link className="underline" to={`/m/${m.id}/stats`}>Scorecard and replay</Link></div>
      <div className={`rounded-xl p-3 text-sm ${d.problems.length ? 'bg-leather/20 text-leather' : 'bg-turf/10 text-turf'}`}>
        {d.problems.length ? <><b>{d.problems.length} scoring problem(s):</b><ul className="list-disc pl-5">{d.problems.map((p, i) => <li key={i}>{p.detail}</li>)}</ul></> : 'Scoring checks out: every delivery matches the numbers locked in, their published hashes, and the rules.'}
      </div>
      <div className="flex gap-1">{[['events', `Event log (${d.events.length})`], ['subs', `Submissions (${d.submissions.length})`], ['people', `People (${d.members.length})`]].map(([k, l]) => <button key={k} type="button" aria-pressed={show === k} onClick={() => setShow(k)} className={`rounded-full px-3 py-1 text-sm ${show === k ? 'bg-turf text-pitch-900' : 'bg-pitch-700'}`}>{l}</button>)}</div>
      {show === 'events' && <ol className="max-h-80 overflow-y-auto text-sm">{d.events.map((e) => <li key={e.id} className="border-t border-pitch-600 py-1"><span className="text-xs text-chalk-faint">{when(e.at)}, {e.who || 'system'}, {e.action}</span><br />{e.text}</li>)}</ol>}
      {show === 'subs' && (
        <div className="max-h-80 overflow-auto"><table className="w-full text-sm [&_td]:px-1.5"><thead className="text-left text-chalk-dim"><tr><th>#</th><th>Inn</th><th>Bowler</th><th>Batter</th><th>Bowled</th><th>Batted</th><th>Status</th></tr></thead>
          <tbody>{d.submissions.map((s) => <tr key={s.id} className="border-t border-pitch-600"><td>{s.id}</td><td>{s.innings}</td><td>{s.bowler}</td><td>{s.batter}</td><td className="font-mono">{s.bowl}</td><td className="font-mono">{s.bat}</td><td>{s.status}{s.endReason ? ` (${s.endReason})` : ''}</td></tr>)}</tbody></table>
          <p className="mt-1 text-xs text-chalk-faint">Numbers still hidden from the players are hidden here too.</p></div>
      )}
      {show === 'people' && <ul className="text-sm">{d.members.map((x) => <li key={x.id}>{x.name} <span className="text-chalk-dim">{x.team ? `team ${x.team}` : 'watching'}{x.bot ? ', AI' : ''}{x.ghost ? ', squad player' : ''}{x.banned ? ', removed' : ''}</span></li>)}</ul>}
      {perms.includes('matches.manage') && !['completed', 'abandoned'].includes(m.status) && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1"><label className="label" htmlFor="ab">Reason (shown to the players)</label><input id="ab" className="field" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={140} /></div>
          <button type="button" className="btn-ghost text-leather" disabled={reason.trim().length < 3} onClick={abandon}>Abandon match</button>
        </div>
      )}
      {m.abandonedReason && <p className="text-sm text-chalk-dim">Abandoned by the organisers: {m.abandonedReason}</p>}
    </section>
  );
}

// ---------- settings ----------
const LEVELS = ['easy', 'medium', 'hard', 'expert'], PERS = ['strategic', 'aggressive', 'defensive', 'unpredictable'], FORMATS = [['test', 'Test'], ['t20', 'T20'], ['odi', 'ODI'], ['custom', 'Custom overs']];
const BUILT = [['day', 'Day'], ['night', 'Night'], ['international', 'International'], ['ipl', 'IPL-style'], ['custom', "Player's own colours"]];
function Settings() {
  const { toast } = useApp();
  const [d, load, err] = useLoad('/api/admin/config');
  const [c, setC] = useState(null);
  useEffect(() => { if (d) setC(JSON.parse(JSON.stringify(d.config))); }, [d]);
  if (err) return <p className="text-leather">{err}</p>;
  if (!c) return <p className="text-chalk-dim">Loading…</p>;
  const save = async (section, body) => { try { await api(`/api/admin/config/${section}`, { method: 'PUT', body }); toast({ title: 'Saved', ms: 2000 }); load(); loadAppConfig(true); } catch (e) { toast({ title: 'Not saved', body: e.message }); } };
  const tog = (list, x) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
  const set = (section, patch) => setC({ ...c, [section]: { ...c[section], ...patch } });
  return (
    <div className="space-y-4">
      <section className="panel space-y-3 p-4">
        <h2 className="font-display text-2xl font-bold">AI opponents</h2>
        <fieldset><legend className="label">Difficulty levels offered</legend><div className="flex flex-wrap gap-3">{LEVELS.map((l) => <label key={l} className="flex items-center gap-1.5 capitalize"><input type="checkbox" checked={c.ai.levels.includes(l)} onChange={() => set('ai', { levels: tog(c.ai.levels, l) })} />{l}</label>)}</div></fieldset>
        <fieldset><legend className="label">Personalities offered</legend><div className="flex flex-wrap gap-3">{PERS.map((p) => <label key={p} className="flex items-center gap-1.5 capitalize"><input type="checkbox" checked={c.ai.personalities.includes(p)} onChange={() => set('ai', { personalities: tog(c.ai.personalities, p) })} />{p}</label>)}</div></fieldset>
        <div className="grid grid-cols-2 gap-2">
          <div><label className="label" htmlFor="dl">Default difficulty</label><select id="dl" className="field capitalize" value={c.ai.defaultLevel} onChange={(e) => set('ai', { defaultLevel: e.target.value })}>{c.ai.levels.map((l) => <option key={l}>{l}</option>)}</select></div>
          <div><label className="label" htmlFor="dp">Default personality</label><select id="dp" className="field capitalize" value={c.ai.defaultPersonality} onChange={(e) => set('ai', { defaultPersonality: e.target.value })}>{c.ai.personalities.map((l) => <option key={l}>{l}</option>)}</select></div>
        </div>
        <button type="button" className="btn-go" onClick={() => save('ai', c.ai)}>Save AI settings</button>
      </section>
      <section className="panel space-y-3 p-4">
        <h2 className="font-display text-2xl font-bold">Match formats</h2>
        <div className="flex flex-wrap gap-3">{FORMATS.map(([k, l]) => <label key={k} className="flex items-center gap-1.5"><input type="checkbox" checked={c.formats.enabled.includes(k)} onChange={() => set('formats', { enabled: tog(c.formats.enabled, k) })} />{l}</label>)}</div>
        <div className="grid grid-cols-2 gap-2">
          <div><label className="label" htmlFor="mo">Most overs in a custom match</label><input id="mo" type="number" min="1" max="50" className="field" value={c.formats.maxCustomOvers} onChange={(e) => set('formats', { maxCustomOvers: Number(e.target.value) })} /></div>
          <div><label className="label" htmlFor="md">Most days in a Test</label><input id="md" type="number" min="1" max="5" className="field" value={c.formats.maxTestDays} onChange={(e) => set('formats', { maxTestDays: Number(e.target.value) })} /></div>
        </div>
        <p className="text-xs text-chalk-faint">Applies to new matches and tournaments. Matches already under way keep their settings.</p>
        <button type="button" className="btn-go" onClick={() => save('formats', c.formats)}>Save formats</button>
      </section>
      <section className="panel space-y-3 p-4">
        <h2 className="font-display text-2xl font-bold">Stadium themes</h2>
        <div className="flex flex-wrap gap-3">{[...BUILT, ...c.themes.custom.map((t) => [t.id, t.name])].map(([k, l]) => <label key={k} className="flex items-center gap-1.5"><input type="checkbox" checked={c.themes.enabled.includes(k)} onChange={() => set('themes', { enabled: tog(c.themes.enabled, k) })} />{l}</label>)}</div>
        <div><label className="label" htmlFor="dt">Default for new players</label><select id="dt" className="field" value={c.themes.default} onChange={(e) => set('themes', { default: e.target.value })}>{[...BUILT, ...c.themes.custom.map((t) => [t.id, t.name])].filter(([k]) => c.themes.enabled.includes(k)).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="space-y-2">
          <span className="label">Themes you've made</span>
          {c.themes.custom.map((t, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-pitch-900/60 p-2">
              <input aria-label="Theme name" className="field w-40 py-1.5" value={t.name} onChange={(e) => set('themes', { custom: c.themes.custom.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              {['sky', 'stands', 'accent'].map((k) => <label key={k} className="flex items-center gap-1 text-sm capitalize">{k}<input type="color" value={t[k]} onChange={(e) => set('themes', { custom: c.themes.custom.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)) })} className="h-8 w-10 bg-transparent" /></label>)}
              <button type="button" className="text-sm text-chalk-dim underline" onClick={() => set('themes', { custom: c.themes.custom.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          ))}
          <button type="button" className="text-sm text-chalk-dim underline" onClick={() => set('themes', { custom: [...c.themes.custom, { name: 'New stadium', sky: '#1B2A4A', stands: '#7A4FD6', accent: '#FFD23F' }] })}>Add a theme</button>
        </div>
        <button type="button" className="btn-go" onClick={() => save('themes', c.themes)}>Save stadiums</button>
      </section>
      <section className="panel space-y-3 p-4">
        <h2 className="font-display text-2xl font-bold">Commentary</h2>
        <label className="flex items-center gap-2"><input type="checkbox" checked={c.commentary.enabled} onChange={(e) => set('commentary', { enabled: e.target.checked })} /> Commentary on for everyone (players can still switch it off for themselves)</label>
        <p className="text-sm text-chalk-dim">Write your own lines for each kind of ball, one per line; they're picked in turn. Use {d.placeholders.map((p) => `{${p}}`).join(', ')}. Numbers aren't allowed in the text: the score, runs needed and totals are always added from the record, so commentary can't contradict the scorecard. Leave a box empty to use the built-in lines.</p>
        {Object.entries(d.events).map(([ev, label]) => (
          <div key={ev}><label className="label" htmlFor={`t-${ev}`}>{label}</label>
            <textarea id={`t-${ev}`} rows={2} className="field" value={(c.commentary.templates[ev] || []).join('\n')} placeholder="Built-in lines" onChange={(e) => set('commentary', { templates: { ...c.commentary.templates, [ev]: e.target.value.split('\n') } })} /></div>
        ))}
        <button type="button" className="btn-go" onClick={() => save('commentary', { enabled: c.commentary.enabled, templates: Object.fromEntries(Object.entries(c.commentary.templates).map(([k, v]) => [k, v.filter((x) => x.trim())])) })}>Save commentary</button>
      </section>
      <CareerRules />
    </div>
  );
}

// ---------- logs ----------
function Logs() {
  const [show, setShow] = useState('audit');
  const [entries, setEntries] = useState([]);
  const [errors] = useLoad('/api/admin/errors');
  const more = async (before) => { const r = await api(`/api/admin/audit${before ? `?before=${before}` : ''}`); setEntries((x) => (before ? [...x, ...r.entries] : r.entries)); };
  useEffect(() => { more(); }, []);
  return (
    <div className="space-y-3">
      <div className="flex gap-1">{[['audit', 'Admin actions'], ['errors', 'Server errors']].map(([k, l]) => <button key={k} type="button" aria-pressed={show === k} onClick={() => setShow(k)} className={`rounded-full px-3 py-1 text-sm font-semibold ${show === k ? 'bg-turf text-pitch-900' : 'bg-pitch-700'}`}>{l}</button>)}</div>
      {show === 'audit' && (
        <section className="panel overflow-x-auto p-2">
          <p className="p-2 text-xs text-chalk-faint">Every staff action is recorded here and can't be edited or deleted. Match events (every ball, umpire decision and declaration) are in each match's event log.</p>
          <table className="w-full min-w-[36rem] text-sm [&_td]:px-2"><tbody>{entries.map((e) => (
            <tr key={e.id} className="border-t border-pitch-600 align-top"><td className="whitespace-nowrap py-1.5 text-chalk-dim">{when(e.at)}</td><td>{e.username}</td><td className="font-semibold">{e.action}</td><td>{e.target_type ? `${e.target_type} ${e.target_id || ''}` : ''}</td><td className="max-w-xs truncate text-chalk-faint" title={e.detail || ''}>{e.detail}</td><td className="text-chalk-faint">{e.ip}</td></tr>
          ))}</tbody></table>
          {entries.length >= 200 && <button type="button" className="btn-ghost m-2 px-3 py-1" onClick={() => more(entries.at(-1).id)}>Older</button>}
        </section>
      )}
      {show === 'errors' && (
        <section className="panel p-2">
          {errors?.errors.length ? <ul className="divide-y divide-pitch-600 text-sm">{errors.errors.map((e) => <li key={e.id} className="p-2"><span className="text-xs text-chalk-faint">{when(e.at)}, {e.source}{e.route ? `, ${e.route}` : ''}</span><br /><b>{e.message}</b><details><summary className="cursor-pointer text-xs text-chalk-dim">Details</summary><pre className="overflow-x-auto whitespace-pre-wrap text-xs text-chalk-faint">{e.stack}</pre></details></li>)}</ul> : <p className="p-3 text-chalk-dim">No server errors recorded.</p>}
        </section>
      )}
    </div>
  );
}

// ---------- system: backups, restore, data checks ----------
function SystemTab() {
  const { toast } = useApp();
  const [d, load, err] = useLoad('/api/admin/system');
  const [check, setCheck] = useState(null), [busy, setBusy] = useState(false);
  if (err) return <p className="text-leather">{err}</p>;
  if (!d) return <p className="text-chalk-dim">Loading…</p>;
  const act = async (fn, msg) => { setBusy(true); try { const r = await fn(); if (msg) toast({ title: msg, ms: 2500 }); load(); return r; } catch (e) { toast({ title: 'Not done', body: e.message }); } finally { setBusy(false); } };
  const download = async (name) => {
    const r = await fetch(`/api/admin/backups/${name}`, { headers: { authorization: `Bearer ${localStorage.getItem('gcl_token')}` } });
    if (!r.ok) return toast({ title: 'Download failed', body: (await r.json().catch(() => ({}))).error });
    const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
  };
  const last = check?.summary || check || d.integrity?.summary;
  return (
    <div className="space-y-4">
      <section className="panel space-y-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="font-display text-2xl font-bold">Backups</h2><button type="button" className="btn-go" disabled={busy} onClick={() => act(() => api('/api/admin/backups', { body: {} }), 'Backup made and verified')}>Back up now</button></div>
        <p className="text-sm text-chalk-dim">Automatic backups run every few hours (set BACKUP_HOURS; the newest BACKUP_KEEP are kept) into {d.backupDir}. Each one is checked before it's kept.</p>
        {d.pendingRestore && (
          <div className="rounded-xl bg-flood/15 p-3 text-sm">
            <p><b>A restore is scheduled</b> from {d.pendingRestore.backup.split('/').pop()}. It's applied the next time the server starts; the current database is kept beside it.</p>
            <div className="mt-2 flex gap-2"><button type="button" className="btn-flood" disabled={busy} onClick={() => { if (window.confirm('Restart the server now and restore? Everyone is disconnected for a few seconds.')) act(() => api('/api/admin/restart', { body: {} }), 'Restarting…'); }}>Restart and restore now</button>
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => act(() => api('/api/admin/restore', { method: 'DELETE' }), 'Restore cancelled')}>Cancel restore</button></div>
          </div>
        )}
        {d.backups.length ? (
          <div className="overflow-x-auto"><table className="w-full min-w-[34rem] text-sm [&_td]:px-2"><tbody>{d.backups.map((b) => (
            <tr key={b.name} className="border-t border-pitch-600"><td className="py-1.5">{when(b.at)}</td><td>{b.trigger}</td><td>{(b.size / 1024 / 1024).toFixed(1)} MB</td><td>{b.ok ? 'verified' : 'unchecked'}{b.counts ? `, ${b.counts.matches} matches` : ''}</td>
              <td className="whitespace-nowrap text-right"><button type="button" className="mr-3 underline" onClick={() => download(b.name)}>Download</button>
                <button type="button" className="underline" onClick={() => { if (window.confirm(`Restore from ${when(b.at)}? Everything since then is replaced at the next restart (the current database is kept as a copy).`)) act(() => api(`/api/admin/backups/${b.name}/restore`, { body: {} }), 'Restore scheduled'); }}>Restore</button></td></tr>
          ))}</tbody></table></div>
        ) : <p className="text-sm text-flood">No backups yet.</p>}
      </section>
      <section className="panel space-y-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="font-display text-2xl font-bold">Data check</h2><button type="button" className="btn-go" disabled={busy} onClick={async () => setCheck(await act(() => api('/api/admin/integrity', { body: {} }), null))}>Check now</button></div>
        <p className="text-sm text-chalk-dim">Checks the database file, then every match: each delivery against the numbers locked in and their published hashes, runs against the numbers, digits, the repetition rule, ball numbering and tournament results. Runs daily; staff are told about any problem.</p>
        {last && <p className={`text-sm ${last.problemCount ? 'text-leather' : 'text-turf'}`}>{last.problemCount ? `${last.problemCount} problem(s)` : 'All good'}: {last.matches} matches checked{last.ms != null ? ` in ${last.ms} ms` : ''}.</p>}
        {last?.problems?.length > 0 && <ul className="max-h-72 list-disc overflow-y-auto pl-5 text-sm">{last.problems.map((p, i) => <li key={i}>{p.matchId && <Link className="font-mono underline" to={`/m/${p.matchId}/stats`}>{p.matchId}</Link>} {p.detail}</li>)}</ul>}
      </section>
    </div>
  );
}
