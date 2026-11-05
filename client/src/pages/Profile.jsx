import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';

const SECTIONS = [['overview', 'Career'], ['batting', 'Batting'], ['bowling', 'Bowling'], ['formats', 'Formats'], ['teams', 'Teams'], ['ai', 'v the AI'], ['form', 'Recent form'], ['bests', 'Career bests']];
const dash = (v) => (v == null ? '–' : v);
const score = (k) => `${k.runs}${k.notOut || k.out === false ? '*' : ''}`;

export default function Profile() {
  const { id } = useParams();
  const { user, setUser, toast } = useApp();
  const [p, setP] = useState(null);
  const [c, setC] = useState(null);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  const [sec, setSec] = useState('overview');
  useEffect(() => {
    setP(null); setC(null);
    Promise.all([api(`/api/users/${id}`), api(`/api/users/${id}/career`)])
      .then(([r, k]) => { setP(r); setC(k); setName(r.user.name); }).catch((e) => setErr(e.message));
  }, [id]);
  if (err) return <p className="p-8 text-center text-chalk-dim">{err}</p>;
  if (!p || !c) return <p className="p-8 text-center text-chalk-dim">Loading stats…</p>;
  const b = c.batting, w = c.bowling, r = c.record;
  const isMe = user?.id === id;
  const rename = async (e) => {
    e.preventDefault();
    try { const res = await api('/api/me', { method: 'PATCH', body: { name } }); setUser(res.user); toast({ title: 'Name updated', ms: 2000 }); } catch (x) { toast({ title: 'Name not changed', body: x.message }); }
  };
  return (
    <div className="space-y-4 px-4 pb-12 pt-2">
      <header>
        <h1 className="font-display text-5xl font-extrabold leading-none">{p.user.name}</h1>
        <p className="mt-1 text-chalk-dim">{p.user.guest ? 'Guest player' : `@${p.user.username}`}, playing since {new Date(p.user.created_at).toLocaleDateString()}</p>
      </header>
      <nav className="flex gap-1 overflow-x-auto pb-1" aria-label="Statistics sections">
        {SECTIONS.map(([k, l]) => (
          <button key={k} type="button" aria-current={sec === k} onClick={() => setSec(k)}
            className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold ${sec === k ? 'bg-flood text-pitch-900' : 'bg-pitch-700 text-chalk-dim hover:text-chalk'}`}>{l}</button>
        ))}
      </nav>
      {r.matches === 0 && <p className="panel p-4 text-chalk-dim">No finished matches yet. Stats appear here once a match is completed.</p>}
      {r.matches > 0 && sec === 'overview' && <Overview b={b} w={w} r={r} />}
      {r.matches > 0 && sec === 'batting' && <BattingRecord b={b} />}
      {r.matches > 0 && sec === 'bowling' && <BowlingRecord w={w} />}
      {r.matches > 0 && sec === 'formats' && <Splits rows={c.formats} empty="No finished matches yet." />}
      {r.matches > 0 && sec === 'teams' && <Splits rows={c.teams} empty="No finished matches yet." />}
      {r.matches > 0 && sec === 'ai' && (c.ai.overall.matches ? <><RecordRow title="All matches against the AI" r={c.ai.overall} /><Splits rows={c.ai.byOpponent} /></> : <p className="panel p-4 text-chalk-dim">No finished matches against the AI yet.</p>)}
      {r.matches > 0 && sec === 'form' && <><Form rows={c.recent} /><History rows={p.history} /></>}
      {r.matches > 0 && sec === 'bests' && <Bests bests={c.bests} me={p.user.name} />}
      {isMe && (
        <section className="panel space-y-3 p-4">
          <form onSubmit={rename} className="flex items-end gap-2">
            <div className="flex-1"><label className="label" htmlFor="rn">Display name</label><input id="rn" className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={24} /></div>
            <button className="btn-ghost">Save name</button>
          </form>
          {user.guest && <Upgrade />}
        </section>
      )}
      <p className="text-xs text-chalk-faint">Every figure is counted from the deliveries of completed matches. Super overs are left out of career figures. Real-team matches count for the person playing them.</p>
    </div>
  );
}

const Grid = ({ items }) => (
  <section className="panel grid grid-cols-3 gap-y-4 p-4 sm:grid-cols-6">
    {items.map(([k, v]) => <div key={k}><div className="font-display text-2xl font-bold tabular-nums">{dash(v)}</div><div className="text-xs text-chalk-dim">{k}</div></div>)}
  </section>
);

function Overview({ b, w, r }) {
  const big = [['Runs', b.runs], ['Highest', b.highest ? score(b.highest) : '–'], ['Wickets', w.wickets], ['Best bowling', w.best ? `${w.best.wickets}/${w.best.runs}` : '–']];
  return (
    <>
      <section className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-pitch-600 sm:grid-cols-4">
        {big.map(([k, v]) => <div key={k} className="bg-pitch-800 p-4"><div className="font-display text-5xl font-extrabold tabular-nums text-flood">{v}</div><div className="text-sm text-chalk-dim">{k}</div></div>)}
      </section>
      <Grid items={[['Matches', r.matches], ['Won', r.won], ['Lost', r.lost], ['Tied', r.tied], ['Drawn', r.drawn], ['Win %', r.matches ? Math.round((r.won * 100) / r.matches) : null],
        ['Batting avg', b.average], ['Strike rate', b.strikeRate], ['Bowling avg', w.average], ['Economy', w.economy], ['Fours', b.fours], ['Sixes', b.sixes]]} />
    </>
  );
}
function BattingRecord({ b }) {
  return <Grid items={[['Matches', b.matches], ['Innings', b.innings], ['Not outs', b.notOuts], ['Runs', b.runs], ['Highest', b.highest ? score(b.highest) : null], ['Average', b.average],
    ['Strike rate', b.strikeRate], ['Balls faced', b.balls], ['Fours', b.fours], ['Sixes', b.sixes], ['Dot balls', b.dots], ['Dismissals', b.dismissals], ['Ducks', b.ducks], ['50s', b.fifties], ['100s', b.hundreds]]} />;
}
function BowlingRecord({ w }) {
  return <Grid items={[['Matches', w.matches], ['Innings', w.innings], ['Overs', w.overs], ['Deliveries', w.balls], ['Runs', w.runs], ['Wickets', w.wickets],
    ['Average', w.average], ['Economy', w.economy], ['Strike rate', w.strikeRate], ['Dot balls', w.dots], ['Maidens', w.maidens], ['Best', w.best ? `${w.best.wickets}/${w.best.runs}` : null], ['5-wicket hauls', w.fiveWickets]]} />;
}
const RecordRow = ({ title, r }) => <div className="panel p-4"><div className="font-display text-xl font-bold">{title}</div><p className="text-sm text-chalk-dim">Played {r.matches}: won {r.won}, lost {r.lost}{r.tied ? `, tied ${r.tied}` : ''}{r.drawn ? `, drawn ${r.drawn}` : ''}</p></div>;
function Splits({ rows, empty }) {
  if (!rows.length) return <p className="panel p-4 text-chalk-dim">{empty}</p>;
  return (
    <section className="panel overflow-x-auto p-4">
      <table className="w-full min-w-[34rem] text-sm tabular-nums [&_td]:px-1.5 [&_th]:px-1.5">
        <thead className="text-left text-chalk-dim"><tr><th className="py-1 font-medium">&nbsp;</th><th className="font-medium">P</th><th className="font-medium">W</th><th className="font-medium">L</th><th className="font-medium">D/T</th><th className="font-medium">Runs</th><th className="font-medium">HS</th><th className="font-medium">Avg</th><th className="font-medium">SR</th><th className="font-medium">Wkts</th><th className="font-medium">Econ</th><th className="font-medium">Best</th></tr></thead>
        <tbody>{rows.map((x) => (
          <tr key={x.key} className="border-t border-pitch-600">
            <td className="py-1.5 font-semibold capitalize">{x.label}</td><td>{x.record.matches}</td><td>{x.record.won}</td><td>{x.record.lost}</td><td>{x.record.drawn + x.record.tied}</td>
            <td>{x.batting.runs}</td><td>{x.batting.highest ? score(x.batting.highest) : '–'}</td><td>{dash(x.batting.average)}</td><td>{dash(x.batting.strikeRate)}</td>
            <td>{x.bowling.wickets}</td><td>{dash(x.bowling.economy)}</td><td>{x.bowling.best ? `${x.bowling.best.wickets}/${x.bowling.best.runs}` : '–'}</td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}
function Form({ rows }) {
  return (
    <section className="panel p-4">
      <h2 className="font-display text-2xl font-bold">Last {rows.length} matches</h2>
      <ul className="mt-2 divide-y divide-pitch-600">
        {rows.map((h) => (
          <li key={h.id}>
            <Link to={`/m/${h.id}/stats`} className="flex items-center gap-3 py-2.5 hover:text-flood">
              <span className={`w-12 shrink-0 rounded-full py-0.5 text-center text-xs font-bold ${h.outcome === 'won' ? 'bg-turf text-pitch-900' : h.outcome === 'lost' ? 'bg-leather' : 'bg-pitch-600'}`}>{h.outcome}</span>
              <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{h.name}</span><span className="block truncate text-sm text-chalk-dim">{h.result}</span></span>
              <span className="shrink-0 text-right text-sm tabular-nums"><span className="block">{h.balls ? `${h.runs} (${h.balls})` : 'did not bat'}</span><span className="block text-chalk-dim">{h.bowled ? `${h.wickets}/${h.conceded}` : 'did not bowl'}</span></span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
function History({ rows }) {
  return (
    <section className="panel p-4">
      <h2 className="font-display text-2xl font-bold">Match history</h2>
      <ul className="mt-2 divide-y divide-pitch-600">
        {rows.map((h) => (
          <li key={h.id}>
            <Link to={`/m/${h.id}`} className="flex items-center gap-3 py-2.5 hover:text-flood">
              <span className={`w-12 shrink-0 rounded-full py-0.5 text-center text-xs font-bold ${h.outcome === 'won' ? 'bg-turf text-pitch-900' : h.outcome === 'lost' ? 'bg-leather' : 'bg-pitch-600'}`}>{h.outcome === 'played' ? '—' : h.outcome}</span>
              <span className="min-w-0"><span className="block truncate font-semibold">{h.name}</span><span className="block truncate text-sm text-chalk-dim">{h.result}</span></span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
function Bests({ bests, me }) {
  const as = (x) => (x.name && x.name !== me ? ` as ${x.name}` : '');
  const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  const when = (x) => (x.endedAt ? new Date(x.endedAt).toLocaleDateString() : '');
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <section className="panel p-4">
        <h2 className="font-display text-2xl font-bold">Highest scores</h2>
        {bests.batting.length ? <ol className="mt-2 space-y-2">{bests.batting.map((k, n) => (
          <li key={n}><Link to={`/m/${k.matchId}/stats`} className="flex items-baseline gap-3 hover:text-flood"><span className="font-display text-3xl font-bold tabular-nums">{score(k)}</span>
            <span className="min-w-0 text-sm text-chalk-dim"><span className="block truncate">{n(k.balls, 'ball')}, {n(k.fours, 'four')}, {n(k.sixes, 'six').replace('sixs', 'sixes')}{as(k)}</span><span className="block truncate">{k.match} {when(k)}</span></span></Link></li>
        ))}</ol> : <p className="text-chalk-dim">No innings yet.</p>}
      </section>
      <section className="panel p-4">
        <h2 className="font-display text-2xl font-bold">Best bowling</h2>
        {bests.bowling.length ? <ol className="mt-2 space-y-2">{bests.bowling.map((s, n) => (
          <li key={n}><Link to={`/m/${s.matchId}/stats`} className="flex items-baseline gap-3 hover:text-flood"><span className="font-display text-3xl font-bold tabular-nums">{s.wickets}/{s.runs}</span>
            <span className="min-w-0 text-sm text-chalk-dim"><span className="block truncate">{s.overs} overs, economy {dash(s.economy)}{as(s)}</span><span className="block truncate">{s.match} {when(s)}</span></span></Link></li>
        ))}</ol> : <p className="text-chalk-dim">No wickets yet.</p>}
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
