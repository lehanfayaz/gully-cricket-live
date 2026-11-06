import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import Avatar, { refreshAvatar, shrinkImage } from '../components/Avatar.jsx';
import TeamBadge from '../components/TeamBadge.jsx';

const SECTIONS = [['overview', 'Career'], ['achievements', 'Achievements'], ['batting', 'Batting'], ['bowling', 'Bowling'], ['formats', 'Formats'], ['teams', 'Teams'], ['ai', 'v the AI'], ['form', 'Recent form'], ['bests', 'Career bests']];
const dash = (v) => (v == null ? '–' : v);
const score = (k) => `${k.runs}${k.notOut || k.out === false ? '*' : ''}`;

export default function Profile() {
  const { id } = useParams();
  const { user, setUser, toast } = useApp();
  const [p, setP] = useState(null);
  const [c, setC] = useState(null);
  const [ach, setAch] = useState(null);
  const [, bump] = useState(0);
  const [err, setErr] = useState('');
  const [name, setName] = useState('');
  const [sec, setSec] = useState('overview');
  useEffect(() => {
    setP(null); setC(null); setAch(null);
    Promise.all([api(`/api/users/${id}`), api(`/api/users/${id}/career`), api(`/api/users/${id}/achievements`)])
      .then(([r, k, a]) => { setP(r); setC(k); setAch(a); setName(r.user.name); }).catch((e) => setErr(e.message));
  }, [id]);
  if (err) return <p className="p-8 text-center text-chalk-dim">{err}</p>;
  if (!p || !c || !ach) return <p className="p-8 text-center text-chalk-dim">Loading stats…</p>;
  const b = c.batting, w = c.bowling, r = c.record;
  const isMe = user?.id === id;
  const rename = async (e) => {
    e.preventDefault();
    try { const res = await api('/api/me', { method: 'PATCH', body: { name } }); setUser(res.user); toast({ title: 'Name updated', ms: 2000 }); } catch (x) { toast({ title: 'Name not changed', body: x.message }); }
  };
  return (
    <div className="space-y-4 px-4 pb-12 pt-2">
      <header className="flex items-center gap-4">
        <Avatar id={p.user.hasAvatar ? id : null} name={p.user.name} size={88} className="ring-4 ring-pitch-600" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-display text-5xl font-extrabold leading-none">{p.user.name}</h1>
          <p className="mt-1 text-chalk-dim">{p.user.guest ? 'Guest player' : `@${p.user.username}`}, playing since {new Date(p.user.created_at).toLocaleDateString()}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded-full bg-flood px-3 py-0.5 font-display text-base font-bold text-pitch-900">{ach.level.name}</span>
            {p.user.favIntl && <span className="flex items-center gap-1 text-chalk-dim"><TeamBadge team={p.user.favIntl} size={20} />{p.user.favIntl.name}</span>}
            {p.user.favIpl && <span className="flex items-center gap-1 text-chalk-dim"><TeamBadge team={p.user.favIpl} size={20} />{p.user.favIpl.short || p.user.favIpl.name}</span>}
          </div>
        </div>
      </header>
      <LevelBar level={ach.level} />
      <nav className="flex gap-1 overflow-x-auto pb-1" aria-label="Statistics sections">
        {SECTIONS.map(([k, l]) => (
          <button key={k} type="button" aria-current={sec === k} onClick={() => setSec(k)}
            className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold ${sec === k ? 'bg-flood text-pitch-900' : 'bg-pitch-700 text-chalk-dim hover:text-chalk'}`}>{l}</button>
        ))}
      </nav>
      {r.matches === 0 && sec !== 'achievements' && <p className="panel p-4 text-chalk-dim">No finished matches yet. Stats appear here once a match is completed.</p>}
      {r.matches > 0 && sec === 'overview' && <Overview b={b} w={w} r={r} extra={[['Tournament wins', ach.tournamentWins], ['Achievements', `${ach.achievements.filter((a) => a.unlocked).length} of ${ach.achievements.length}`]]} />}
      {sec === 'achievements' && <Achievements ach={ach} />}
      {r.matches > 0 && sec === 'batting' && <BattingRecord b={b} />}
      {r.matches > 0 && sec === 'bowling' && <BowlingRecord w={w} />}
      {r.matches > 0 && sec === 'formats' && <Splits rows={c.formats} empty="No finished matches yet." />}
      {r.matches > 0 && sec === 'teams' && <Splits rows={c.teams} empty="No finished matches yet." />}
      {r.matches > 0 && sec === 'ai' && (c.ai.overall.matches ? <><RecordRow title="All matches against the AI" r={c.ai.overall} /><Splits rows={c.ai.byOpponent} /></> : <p className="panel p-4 text-chalk-dim">No finished matches against the AI yet.</p>)}
      {r.matches > 0 && sec === 'form' && <><Form rows={c.recent} /><History rows={p.history} /></>}
      {r.matches > 0 && sec === 'bests' && <Bests bests={c.bests} me={p.user.name} />}
      {isMe && (
        <section className="panel space-y-3 p-4">
          <ProfileEdit p={p} id={id} onChange={() => { bump((x) => x + 1); api(`/api/users/${id}`).then(setP); }} />
          <form onSubmit={rename} className="flex items-end gap-2">
            <div className="flex-1"><label className="label" htmlFor="rn">Display name</label><input id="rn" className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={24} /></div>
            <button className="btn-ghost">Save name</button>
          </form>
          {user.guest ? <Upgrade /> : <ChangePassword />}
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

function Overview({ b, w, r, extra = [] }) {
  const big = [['Runs', b.runs], ['Highest', b.highest ? score(b.highest) : '–'], ['Wickets', w.wickets], ['Best bowling', w.best ? `${w.best.wickets}/${w.best.runs}` : '–']];
  return (
    <>
      <section className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-pitch-600 sm:grid-cols-4">
        {big.map(([k, v]) => <div key={k} className="bg-pitch-800 p-4"><div className="font-display text-5xl font-extrabold tabular-nums text-flood">{v}</div><div className="text-sm text-chalk-dim">{k}</div></div>)}
      </section>
      <Grid items={[['Matches', r.matches], ['Won', r.won], ['Lost', r.lost], ['Tied', r.tied], ['Drawn', r.drawn], ['Win %', r.matches ? Math.round((r.won * 100) / r.matches) : null],
        ['Batting avg', b.average], ['Strike rate', b.strikeRate], ['Bowling avg', w.average], ['Economy', w.economy], ['Fours', b.fours], ['Sixes', b.sixes], ...extra]} />
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

function LevelBar({ level }) {
  const L = level, nx = L.next;
  const pct = nx ? Math.min(100, (L.xp / nx.xp) * 100) : 100;
  return (
    <section className="panel p-4" aria-label="Career level">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-display text-xl font-bold">{L.name}</span>
        <span className="text-sm tabular-nums text-chalk-dim">{L.xp.toLocaleString()} XP</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-pitch-900" role="progressbar" aria-valuemin={0} aria-valuemax={nx?.xp || L.xp} aria-valuenow={L.xp}><div className="h-full rounded-full bg-flood" style={{ width: `${pct}%` }} /></div>
      <p className="mt-1 text-xs text-chalk-faint">{nx ? `${nx.name} at ${nx.xp.toLocaleString()} XP and ${nx.achievements} achievements (${L.achievementCount} so far).` : 'Top level reached.'} XP comes from runs, wickets, wins (more against harder AI), achievements and challenges: {L.breakdown.play} from play, {L.breakdown.achievements} from achievements, {L.breakdown.challenges} from challenges.</p>
    </section>
  );
}

const when = (t) => (t ? new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const refLink = (ref) => (ref?.id ? (ref.kind === 'tournament' ? `/t/${ref.id}` : `/m/${ref.id}/stats`) : null);
function Achievements({ ach }) {
  const unlocked = ach.achievements.filter((a) => a.unlocked).sort((a, b) => b.unlockedAt - a.unlockedAt);
  const locked = ach.achievements.filter((a) => !a.unlocked).sort((a, b) => b.progress - a.progress);
  const resets = (t) => (t ? `Resets ${new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'No time limit');
  return (
    <div className="space-y-4">
      <section className="grid gap-3 sm:grid-cols-3">
        {[['daily', 'Today'], ['weekly', 'This week'], ['longterm', 'Long term']].map(([k, t]) => (
          <div key={k} className="panel p-4">
            <div className="flex items-baseline justify-between gap-2"><h2 className="font-display text-xl font-bold">{t}</h2><span className="text-xs text-chalk-faint">{resets(ach.challenges[k].endsAt)}</span></div>
            <ul className="mt-2 space-y-3">
              {ach.challenges[k].list.map((c) => (
                <li key={c.id}>
                  <div className="flex items-baseline justify-between gap-2 text-sm"><span className={c.done ? 'text-turf' : ''}>{c.done ? '✓ ' : ''}{c.description || c.title}</span><span className="shrink-0 text-xs text-chalk-faint">{c.xp} XP</span></div>
                  <Bar value={c.progress} label={`${Math.min(c.value, c.target)} of ${c.target}`} done={c.done} />
                </li>
              ))}
              {!ach.challenges[k].list.length && <li className="text-sm text-chalk-dim">None right now.</li>}
            </ul>
          </div>
        ))}
      </section>
      <section>
        <h2 className="font-display text-2xl font-bold">Unlocked ({unlocked.length})</h2>
        {unlocked.length ? (
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">{unlocked.map((a) => (
            <li key={a.id} className="panel flex items-center gap-3 p-3">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-flood/20 text-2xl" aria-hidden>{a.icon}</span>
              <span className="min-w-0 flex-1"><span className="block font-semibold">{a.title}</span><span className="block text-sm text-chalk-dim">{a.description}</span>
                <span className="block text-xs text-chalk-faint">{when(a.unlockedAt)}{refLink(a.ref) && <>, <Link className="underline" to={refLink(a.ref)}>{a.ref.kind === 'tournament' ? 'the tournament' : 'the match'}</Link></>}</span></span>
              <span className="shrink-0 text-xs text-flood">+{a.xp} XP</span>
            </li>
          ))}</ul>
        ) : <p className="mt-1 text-chalk-dim">Nothing yet. Every achievement is earned in a finished match.</p>}
      </section>
      <section>
        <h2 className="font-display text-2xl font-bold">Still to earn ({locked.length})</h2>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">{locked.map((a) => (
          <li key={a.id} className="panel flex items-center gap-3 p-3">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-pitch-900 text-2xl opacity-40 grayscale" aria-hidden>{a.icon}</span>
            <span className="min-w-0 flex-1"><span className="block font-semibold text-chalk-dim">{a.title}</span><span className="block text-sm text-chalk-faint">{a.description}</span>
              <Bar value={a.progress} label={a.target != null ? `${Math.min(a.value ?? 0, a.target)} of ${a.target}` : ''} /></span>
            <span className="shrink-0 text-xs text-chalk-faint">{a.xp} XP</span>
          </li>
        ))}</ul>
      </section>
      <section className="panel p-4">
        <h2 className="font-display text-2xl font-bold">Career milestones</h2>
        {ach.milestones.length ? (
          <ol className="mt-2 border-l-2 border-pitch-500 pl-4">{ach.milestones.map((m, i) => (
            <li key={i} className="relative pb-3"><span className="absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full bg-flood" aria-hidden />
              <span className="font-semibold">{m.title}</span> <span className="text-sm text-chalk-faint">{when(m.at)}</span>
              {refLink(m.ref) && !m.achievement && <span className="block text-sm text-chalk-dim"><Link className="underline" to={refLink(m.ref)}>{m.ref.name}</Link></span>}</li>
          ))}</ol>
        ) : <p className="mt-1 text-chalk-dim">Milestones appear as you play.</p>}
      </section>
    </div>
  );
}
function Bar({ value, label, done }) {
  return (
    <div className="mt-1 flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-pitch-900"><div className={`h-full rounded-full ${done ? 'bg-turf' : 'bg-flood/80'}`} style={{ width: `${Math.round(value * 100)}%` }} /></div>
      <span className="shrink-0 text-xs tabular-nums text-chalk-faint">{label}</span>
    </div>
  );
}

function ProfileEdit({ p, id, onChange }) {
  const { toast } = useApp();
  const [teams, setTeams] = useState(null);
  useEffect(() => { api('/api/cricket/teams').then(setTeams).catch(() => setTeams({ teams: [] })); }, []);
  const upload = async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    try { const dataUrl = await shrinkImage(file); await api('/api/me/avatar', { method: 'PUT', body: { dataUrl } }); refreshAvatar(id); onChange(); toast({ title: 'Picture updated', ms: 2000 }); }
    catch (x) { toast({ title: 'Picture not changed', body: x.message }); }
  };
  const remove = async () => { try { await api('/api/me/avatar', { method: 'DELETE' }); refreshAvatar(id); onChange(); } catch (x) { toast({ title: 'Not removed', body: x.message }); } };
  const fav = async (key, value) => { try { await api('/api/me', { method: 'PATCH', body: { [key]: value || null } }); onChange(); } catch (x) { toast({ title: 'Not saved', body: x.message }); } };
  const opts = (cat) => (teams?.teams || []).filter((t) => t.category === cat);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="label w-full">Profile picture</span>
        <label className="btn-ghost cursor-pointer">{p.user.hasAvatar ? 'Change picture' : 'Add a picture'}<input type="file" accept="image/*" className="sr-only" onChange={upload} /></label>
        {p.user.hasAvatar && <button type="button" className="text-sm text-chalk-dim underline" onClick={remove}>Remove</button>}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div><label className="label" htmlFor="fi">Favourite international team</label>
          <select id="fi" className="field" value={p.user.favIntl?.id || ''} onChange={(e) => fav('favIntl', e.target.value)}><option value="">None</option>{opts('international').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
        <div><label className="label" htmlFor="fp">Favourite IPL franchise</label>
          <select id="fp" className="field" value={p.user.favIpl?.id || ''} onChange={(e) => fav('favIpl', e.target.value)}><option value="">None</option>{opts('ipl').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
      </div>
    </div>
  );
}

function ChangePassword() {
  const { toast } = useApp();
  const [f, setF] = useState({ current: '', next: '' });
  const save = async (e) => {
    e.preventDefault();
    try { await api('/api/me/password', { body: f }); setF({ current: '', next: '' }); toast({ title: 'Password changed', body: 'Other devices have been signed out.' }); }
    catch (x) { toast({ title: 'Password not changed', body: x.message }); }
  };
  return (
    <form onSubmit={save} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <div><label className="label" htmlFor="pw0">Current password</label><input id="pw0" type="password" autoComplete="current-password" className="field" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></div>
      <div><label className="label" htmlFor="pw1">New password (8+ characters)</label><input id="pw1" type="password" autoComplete="new-password" minLength={8} className="field" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></div>
      <button className="btn-ghost" disabled={!f.current || f.next.length < 8}>Change password</button>
    </form>
  );
}
