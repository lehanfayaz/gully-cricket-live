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
          Bowler and batter each lock in six numbers. Then the over is revealed ball by ball: a match and you're out, a miss and you score what you picked.
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

const STEPS = ['Format', 'Rules', 'Teams'];

function Choice({ selected, onClick, title, body }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={selected}
      className={`rounded-xl p-3 text-left ring-2 transition ${selected ? 'bg-turf/15 ring-turf' : 'bg-pitch-900/60 ring-pitch-600 hover:ring-pitch-500'}`}>
      <span className="block font-display text-xl font-bold">{title}</span>
      <span className="block text-sm text-chalk-dim">{body}</span>
    </button>
  );
}

function CreateMatch() {
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [f, setF] = useState({
    name: '', overs: 2, wickets: 3, playersPerTeam: 11, mode: 'auto', superOver: true, freshSetAfterWicket: true,
    noConsecutive: true, spectators: 'open', teamA: 'Lions', teamB: 'Tigers', tossBat: 'A', copyFrom: '',
  });
  const [past, setPast] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/matches/mine').then((r) => setPast(r.matches)).catch(() => {}); }, []);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const pickPast = (id) => {
    const m = past.find((x) => x.id === id);
    setF((x) => ({ ...x, copyFrom: id, ...(m ? { teamA: m.team_a, teamB: m.team_b } : {}) }));
  };
  const create = async () => {
    setBusy(true); setErr('');
    try {
      const { overs, wickets, playersPerTeam, mode, superOver, freshSetAfterWicket, noConsecutive, spectators } = f;
      const r = await api('/api/matches', { body: {
        name: f.name || `${f.teamA} v ${f.teamB}`, teamA: f.teamA, teamB: f.teamB, tossBat: f.tossBat, copyFrom: f.copyFrom || undefined,
        config: { overs, wickets, playersPerTeam, mode, superOver, freshSetAfterWicket, noConsecutive, spectators } } });
      nav(`/m/${r.id}`);
    } catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <section className="panel mown p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-2xl font-bold">Create a match</h2>
        <span className="text-sm text-chalk-dim">Step {step + 1} of {STEPS.length + 1}</span>
      </div>
      <ol className="mt-3 grid grid-cols-4 gap-1.5" aria-label="Steps">
        {[...STEPS, 'Players'].map((s, i) => (
          <li key={s} className={`border-t-4 pt-1 text-xs font-semibold ${i <= step ? 'border-flood text-chalk' : 'border-pitch-600 text-chalk-faint'}`}>{s}</li>
        ))}
      </ol>

      <div className="mt-4 space-y-4">
        {step === 0 && <>
          <div><label className="label" htmlFor="mn">Match name</label><input id="mn" className="field" value={f.name} onChange={set('name')} placeholder={`${f.teamA} v ${f.teamB}`} maxLength={60} /></div>
          <div className="grid grid-cols-3 gap-3">
            <Stepper label="Overs" value={f.overs} set={set('overs')} min={1} max={50} />
            <Stepper label="Wickets" value={f.wickets} set={set('wickets')} min={1} max={20} />
            <Stepper label="Per side" value={f.playersPerTeam} set={set('playersPerTeam')} min={1} max={15} />
          </div>
          <div className="flex flex-wrap gap-2 text-sm">
            <span className="text-chalk-dim">Quick formats:</span>
            {[['1 v 1 quickie', 1, 1, 1], ['3 a side', 3, 3, 3], ['5 a side', 5, 5, 5], ['T5 full squads', 5, 10, 11]].map(([l, o, w, p]) => (
              <button key={l} type="button" className="rounded-full bg-pitch-700 px-3 py-1 hover:bg-pitch-600" onClick={() => setF((x) => ({ ...x, overs: o, wickets: w, playersPerTeam: p }))}>{l}</button>
            ))}
          </div>
        </>}

        {step === 1 && <>
          <div>
            <span className="label">Umpire</span>
            <div className="grid gap-2 sm:grid-cols-2">
              <Choice selected={f.mode === 'auto'} onClick={() => set('mode')('auto')} title="No umpire" body="The game runs itself: scoring, innings changes and the result are automatic." />
              <Choice selected={f.mode === 'umpire'} onClick={() => set('mode')('umpire')} title="With umpire (you)" body="You start innings, can pause, correct mistakes and privately check the bowler's numbers." />
            </div>
          </div>
          <div className="divide-y divide-pitch-600">
            <Toggle label="A wicket ends the over" hint="The new batter and bowler start a fresh over. Turn off to let the over carry on." checked={f.freshSetAfterWicket} onChange={set('freshSetAfterWicket')} />
            <Toggle label="No bowling two overs in a row" checked={f.noConsecutive} onChange={set('noConsecutive')} />
            <Toggle label="Super over on a tie" checked={f.superOver} onChange={set('superOver')} />
          </div>
          <div>
            <span className="label">Spectators</span>
            <div className="grid gap-2 sm:grid-cols-2">
              <Choice selected={f.spectators === 'open'} onClick={() => set('spectators')('open')} title="Watch and chat" body="Anyone with the link can follow live and join the stadium chat." />
              <Choice selected={f.spectators === 'watch'} onClick={() => set('spectators')('watch')} title="Watch only" body="Spectators follow live; only players can chat." />
            </div>
          </div>
        </>}

        {step === 2 && <>
          {past.length > 0 && (
            <div>
              <label className="label" htmlFor="cp">Team selection</label>
              <select id="cp" className="field" value={f.copyFrom} onChange={(e) => pickPast(e.target.value)}>
                <option value="">New teams (players join from the link)</option>
                {past.map((m) => <option key={m.id} value={m.id}>Same squads as {m.name}</option>)}
              </select>
              {f.copyFrom && <p className="mt-1 text-sm text-chalk-dim">Players, captains and lineups are copied over. You can still change them before the start.</p>}
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label" htmlFor="ta">Team one</label><input id="ta" className="field" value={f.teamA} onChange={set('teamA')} maxLength={30} /></div>
            <div><label className="label" htmlFor="tb">Team two</label><input id="tb" className="field" value={f.teamB} onChange={set('teamB')} maxLength={30} /></div>
          </div>
          <div>
            <span className="label">Batting first</span>
            <div className="flex gap-2">
              {['A', 'B'].map((t) => (
                <button key={t} type="button" onClick={() => set('tossBat')(t)} aria-pressed={f.tossBat === t}
                  className={`flex-1 truncate rounded-lg px-2 py-2 font-display text-lg font-bold ${f.tossBat === t ? 'bg-turf text-pitch-900' : 'bg-pitch-600'}`}>{t === 'A' ? f.teamA : f.teamB}</button>
              ))}
            </div>
          </div>
          <p className="rounded-lg bg-pitch-900/60 p-3 text-sm text-chalk-dim">Next you'll get the invite link. Friends join, pick a team (the first one in each team is captain), and captains set the batting and bowling orders.</p>
        </>}
      </div>

      {err && <p className="mt-3 text-sm text-leather" role="alert">{err}</p>}
      <div className="mt-5 flex gap-2">
        {step > 0 && <button type="button" className="btn-ghost" onClick={() => setStep(step - 1)}>Back</button>}
        {step < 2
          ? <button type="button" className="btn-go flex-1 text-xl" onClick={() => setStep(step + 1)}>Next</button>
          : <button type="button" className="btn-go flex-1 text-xl" disabled={busy} onClick={create}>Create match and get link</button>}
      </div>
    </section>
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
                  <span className="block truncate text-sm text-chalk-dim">{m.result?.text || `${m.team_a} v ${m.team_b}`}{m.umpire ? ', you hosted' : ''}</span>
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
