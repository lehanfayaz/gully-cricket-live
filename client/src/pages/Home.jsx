import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { SignInCard, useApp } from '../App.jsx';

export default function Home() {
  const { user, signOut } = useApp();
  if (!user) {
    return (
      <div className="px-4 pb-10 pt-6">
        <Hero />
        <SignInCard />
      </div>
    );
  }
  return (
    <div className="grid gap-5 px-4 pb-12 pt-4 lg:grid-cols-[1.1fr_1fr]">
      <div className="space-y-5">
        <Hero compact />
        <CreateMatch />
      </div>
      <div className="space-y-5">
        <JoinMatch />
        <MyMatches />
        <p className="text-sm text-chalk-dim">
          Signed in as <span className="font-semibold text-chalk">{user.name}</span>{user.guest ? ' (guest)' : ''}.{' '}
          <button onClick={signOut} className="underline">Sign out</button>
        </p>
      </div>
    </div>
  );
}

function Hero({ compact }) {
  return (
    <section className={`${compact ? 'pb-1' : 'pb-6 pt-4'} max-w-xl`}>
      <h1 className={`font-display font-extrabold leading-[0.9] ${compact ? 'text-4xl' : 'text-6xl'}`}>
        Pick a number.<br />Don't match the bowler.
      </h1>
      {!compact && (
        <p className="mt-4 max-w-md text-lg text-chalk-dim">
          The bowler seals six numbers. You pick one each ball. Match theirs and you're out; miss and you score what you picked.
          Everyone plays live from their own phone.
        </p>
      )}
    </section>
  );
}

function Toggle({ label, hint, checked, onChange }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-1">
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="mt-0.5 h-6 w-11 shrink-0 rounded-full bg-pitch-600 p-0.5 transition peer-checked:bg-turf peer-focus-visible:ring-2 peer-focus-visible:ring-flood">
        <span className={`block h-5 w-5 rounded-full bg-chalk transition ${checked ? 'translate-x-5' : ''}`} />
      </span>
      <span><span className="block font-medium">{label}</span>{hint && <span className="block text-sm text-chalk-dim">{hint}</span>}</span>
    </label>
  );
}

function Stepper({ label, value, set, min, max }) {
  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex items-center rounded-lg bg-pitch-900/80 ring-1 ring-pitch-500">
        <button type="button" aria-label={`Fewer ${label}`} className="px-4 py-2 text-2xl text-chalk-dim disabled:opacity-30" disabled={value <= min} onClick={() => set(value - 1)}>−</button>
        <span className="flex-1 text-center font-display text-3xl font-bold tabular-nums">{value}</span>
        <button type="button" aria-label={`More ${label}`} className="px-4 py-2 text-2xl text-chalk-dim disabled:opacity-30" disabled={value >= max} onClick={() => set(value + 1)}>+</button>
      </div>
    </div>
  );
}

function CreateMatch() {
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', teamA: 'Lions', teamB: 'Tigers', overs: 2, wickets: 3, playersPerTeam: 11, superOver: true, freshSetAfterWicket: true, autoBowler: true });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const { overs, wickets, playersPerTeam, superOver, freshSetAfterWicket, autoBowler } = f;
      const r = await api('/api/matches', { body: { name: f.name || `${f.teamA} v ${f.teamB}`, teamA: f.teamA, teamB: f.teamB, config: { overs, wickets, playersPerTeam, superOver, freshSetAfterWicket, autoBowler } } });
      nav(`/m/${r.id}`);
    } catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="panel mown space-y-4 p-5">
      <div>
        <h2 className="font-display text-2xl font-bold">Create a match</h2>
        <p className="text-sm text-chalk-dim">You'll be the umpire. Share the link, then put friends into teams.</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="label" htmlFor="ta">Team one</label><input id="ta" className="field" value={f.teamA} onChange={set('teamA')} maxLength={30} /></div>
        <div><label className="label" htmlFor="tb">Team two</label><input id="tb" className="field" value={f.teamB} onChange={set('teamB')} maxLength={30} /></div>
      </div>
      <div><label className="label" htmlFor="mn">Match name (optional)</label><input id="mn" className="field" value={f.name} onChange={set('name')} placeholder={`${f.teamA} v ${f.teamB}`} maxLength={60} /></div>
      <div className="grid grid-cols-3 gap-3">
        <Stepper label="Overs" value={f.overs} set={set('overs')} min={1} max={50} />
        <Stepper label="Wickets" value={f.wickets} set={set('wickets')} min={1} max={20} />
        <Stepper label="Squad size" value={f.playersPerTeam} set={set('playersPerTeam')} min={1} max={15} />
      </div>
      <div className="divide-y divide-pitch-600">
        <Toggle label="Super over on a tie" checked={f.superOver} onChange={set('superOver')} />
        <Toggle label="Fresh six balls after a wicket" hint="The incoming batter gets a new six-number sequence, like the WhatsApp game. Turn off to finish the current over instead." checked={f.freshSetAfterWicket} onChange={set('freshSetAfterWicket')} />
        <Toggle label="Rotate bowlers each over" hint="The umpire can still pick the bowler before any over." checked={f.autoBowler} onChange={set('autoBowler')} />
      </div>
      {err && <p className="text-sm text-leather" role="alert">{err}</p>}
      <button className="btn-go w-full text-xl" disabled={busy}>Create match</button>
    </form>
  );
}

function JoinMatch() {
  const nav = useNavigate();
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const go = async (e) => {
    e.preventDefault(); setErr('');
    const c = code.trim().toUpperCase().replace(/.*\/M\//, '');
    try { await api(`/api/matches/${c}`); nav(`/m/${c}`); } catch (x) { setErr(x.message); }
  };
  return (
    <form onSubmit={go} className="panel p-5">
      <h2 className="font-display text-2xl font-bold">Join with a code</h2>
      <div className="mt-3 flex gap-2">
        <input aria-label="Match code" className="field font-display text-xl uppercase tracking-[0.2em]" value={code} onChange={(e) => setCode(e.target.value)} placeholder="K7PQ2M" maxLength={80} />
        <button className="btn-flood shrink-0">Join</button>
      </div>
      {err && <p className="mt-2 text-sm text-leather" role="alert">{err}</p>}
    </form>
  );
}

const statusLabel = { lobby: 'Picking teams', live: 'Live', innings_break: 'Innings break', completed: 'Finished', abandoned: 'Abandoned' };

function MyMatches() {
  const [rows, setRows] = useState(null);
  useEffect(() => { api('/api/matches/mine').then((r) => setRows(r.matches)).catch(() => setRows([])); }, []);
  return (
    <section className="panel p-5">
      <h2 className="font-display text-2xl font-bold">Your matches</h2>
      {rows === null ? <p className="mt-2 text-chalk-dim">Loading…</p> : rows.length === 0 ? (
        <p className="mt-2 text-chalk-dim">No matches yet. Create one, or open an invite link from a friend.</p>
      ) : (
        <ul className="mt-2 divide-y divide-pitch-600">
          {rows.map((m) => (
            <li key={m.id}>
              <Link to={`/m/${m.id}`} className="flex items-center justify-between gap-3 py-3 hover:text-flood">
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{m.name}</span>
                  <span className="block truncate text-sm text-chalk-dim">{m.result?.text || `${m.team_a} v ${m.team_b}`}{m.umpire ? ', you umpired' : ''}</span>
                </span>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${m.status === 'live' ? 'bg-leather text-chalk' : 'bg-pitch-600 text-chalk-dim'}`}>{statusLabel[m.status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
