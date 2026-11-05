import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';

export default function Profile() {
  const { id } = useParams();
  const { user, setUser, toast } = useApp();
  const [p, setP] = useState(null);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  useEffect(() => { setP(null); api(`/api/users/${id}`).then((r) => { setP(r); setName(r.user.name); }).catch((e) => setErr(e.message)); }, [id]);
  if (err) return <p className="p-8 text-center text-chalk-dim">{err}</p>;
  if (!p) return <p className="p-8 text-center text-chalk-dim">Loading stats…</p>;
  const b = p.batting, w = p.bowling, r = p.record;
  const isMe = user?.id === id;
  const rename = async (e) => {
    e.preventDefault();
    try { const res = await api('/api/me', { method: 'PATCH', body: { name } }); setUser(res.user); toast({ title: 'Name updated', ms: 2000 }); } catch (x) { toast({ title: 'Name not changed', body: x.message }); }
  };
  const big = [
    ['Runs', b.runs], ['Highest', `${b.highest}${b.highestNotOut ? '*' : ''}`], ['Average', b.average ?? '-'], ['Strike rate', b.strikeRate ?? '-'],
  ];
  const small = [
    ['Matches', r.matches], ['Won', r.wins], ['Lost', r.losses], ['Tied', r.ties], ['Drawn', r.draws || 0],
    ['Balls faced', b.balls], ['Times out', b.outs], ['Fours', b.fours], ['Sixes', b.sixes], ['Ducks', b.ducks],
    ['Wickets taken', w.wickets], ['Balls bowled', w.balls], ['Economy', w.economy ?? '-'],
  ];
  return (
    <div className="space-y-4 px-4 pb-12 pt-2">
      <header>
        <h1 className="font-display text-5xl font-extrabold leading-none">{p.user.name}</h1>
        <p className="mt-1 text-chalk-dim">{p.user.guest ? 'Guest player' : `@${p.user.username}`}, playing since {new Date(p.user.created_at).toLocaleDateString()}</p>
      </header>
      <section className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-pitch-600 sm:grid-cols-4">
        {big.map(([k, v]) => (
          <div key={k} className="bg-pitch-800 p-4">
            <div className="font-display text-5xl font-extrabold tabular-nums text-flood">{v}</div>
            <div className="text-sm text-chalk-dim">{k}</div>
          </div>
        ))}
      </section>
      <section className="panel grid grid-cols-3 gap-y-3 p-4 sm:grid-cols-6">
        {small.map(([k, v]) => (
          <div key={k}><div className="font-display text-2xl font-bold tabular-nums">{v}</div><div className="text-xs text-chalk-dim">{k}</div></div>
        ))}
      </section>
      {isMe && (
        <section className="panel space-y-3 p-4">
          <form onSubmit={rename} className="flex items-end gap-2">
            <div className="flex-1"><label className="label" htmlFor="rn">Display name</label><input id="rn" className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={24} /></div>
            <button className="btn-ghost">Save name</button>
          </form>
          {user.guest && <Upgrade />}
        </section>
      )}
      <section className="panel p-4">
        <h2 className="font-display text-2xl font-bold">Match history</h2>
        {p.history.length === 0 ? <p className="mt-1 text-chalk-dim">No finished matches yet.</p> : (
          <ul className="mt-2 divide-y divide-pitch-600">
            {p.history.map((h) => (
              <li key={h.id}>
                <Link to={`/m/${h.id}`} className="flex items-center gap-3 py-2.5 hover:text-flood">
                  <span className={`w-12 shrink-0 rounded-full py-0.5 text-center text-xs font-bold ${h.outcome === 'won' ? 'bg-turf text-pitch-900' : h.outcome === 'lost' ? 'bg-leather' : 'bg-pitch-600'}`}>{h.outcome === 'played' ? '—' : h.outcome}</span>
                  <span className="min-w-0"><span className="block truncate font-semibold">{h.name}</span><span className="block truncate text-sm text-chalk-dim">{h.result}</span></span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Upgrade() {
  const { setUser, toast } = useApp();
  const [f, setF] = useState({ username: '', password: '' });
  const submit = async (e) => {
    e.preventDefault();
    try { const r = await api('/api/auth/register', { body: f }); setUser(r.user); toast({ title: 'Account created', body: 'Your stats now follow you to any device.' }); }
    catch (x) { toast({ title: 'Account not created', body: x.message }); }
  };
  return (
    <form onSubmit={submit} className="space-y-2 border-t border-pitch-600 pt-3">
      <p className="text-sm text-chalk-dim">You're a guest, so your stats live in this browser. Add a username and password to keep them on any device.</p>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input aria-label="Username" className="field" placeholder="Username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} autoComplete="username" />
        <input aria-label="Password" type="password" className="field" placeholder="Password (8+ characters)" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
        <button className="btn-go">Save my stats</button>
      </div>
    </form>
  );
}
