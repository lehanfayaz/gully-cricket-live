import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAppConfig } from '../appConfig.js';
import { useApp, SignInCard } from '../App.jsx';
import TeamBadge from '../components/TeamBadge.jsx';
import { SyncNote } from '../components/TeamPicker.jsx';
import { Choice, Stepper, Toggle } from './Home.jsx';

const KINDS = [
  ['groups', 'Groups, then knockout', 'Teams split into groups, play each other, and the best go through to knockouts.'],
  ['league', 'Round robin', 'Everyone plays everyone. Top of the table wins, or the top teams meet in a final.'],
  ['knockout', 'Knockout', 'Lose and you are out. Byes go to the top seeds when the numbers are uneven.'],
  ['custom', 'Custom', 'Choose the groups, rounds, how many qualify and whether there is a third-place match.'],
];
const nextPow2 = (n) => { let p = 1; while (p < n) p *= 2; return p; };

// What the chosen structure produces, worked out the same way as the server.
function preview(kind, s, n) {
  const groups = kind === 'knockout' ? 0 : kind === 'league' ? 1 : s.groups;
  const legs = kind === 'league' || kind === 'custom' ? s.legs : 1;
  const qualify = groups === 0 ? n : s.qualify;
  if (n < 2) return { error: 'Pick at least two teams.' };
  let league = 0;
  if (groups > 0) {
    const smallest = Math.floor(n / groups);
    if (smallest < 2) return { error: `${n} teams can't be split into ${groups} groups of at least two.` };
    if (qualify > smallest) return { error: `At most ${smallest} can qualify from each group.` };
    for (let g = 0; g < groups; g++) { const size = Math.floor(n / groups) + (g < n % groups ? 1 : 0); league += ((size * (size - 1)) / 2) * legs; }
  }
  const Q = groups > 0 ? groups * qualify : n;
  const P = Q >= 2 ? nextPow2(Q) : 0;
  const knockout = Q >= 2 ? Q - 1 + (s.thirdPlace && P >= 4 ? 1 : 0) : 0;
  return { groups, league, knockout, total: league + knockout, byes: P ? P - Q : 0, Q };
}

export default function TournamentNew() {
  const { user } = useApp();
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [teams, setTeams] = useState(null);
  const [f, setF] = useState({ name: '', kind: 'groups', picked: [], mine: 0, groups: 2, legs: 1, qualify: 2, thirdPlace: false,
    format: 't20', overs: 5, wickets: 10, play: 'over', aiLevel: 'medium', aiPersonality: 'mixed' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api('/api/cricket/teams').then(setTeams).catch(() => setTeams({ categories: [], teams: [], sync: {} })); }, []);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const pv = useMemo(() => preview(f.kind, { groups: +f.groups, legs: +f.legs, qualify: +f.qualify, thirdPlace: f.thirdPlace }, f.picked.length), [f]);
  if (!user) return <div className="p-4"><SignInCard title="Sign in to start a tournament" /></div>;
  const steps = ['Format', 'Teams', 'Structure', 'Matches', 'Start'];
  const canNext = [true, f.picked.length >= 2, !pv.error, true, true][step];
  const create = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api('/api/tournaments', { body: {
        kind: f.kind, name: f.name || defaultName(f), humanIndex: f.mine,
        teams: f.picked.map((t) => (t.id ? { teamId: t.id } : { name: t.name })),
        structure: { groups: +f.groups, legs: +f.legs, qualify: +f.qualify, thirdPlace: f.thirdPlace },
        match: { format: f.format, overs: +f.overs, wickets: +f.wickets, play: f.play, aiLevel: f.aiLevel, aiPersonality: f.aiPersonality },
      } });
      nav(`/t/${r.id}`);
    } catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <section className="mx-4 mb-12 mt-2 panel mown p-5">
      <h1 className="font-display text-4xl font-extrabold leading-none">New tournament</h1>
      <p className="mt-1 text-chalk-dim">You play one team. The AI plays the rest, through the same rules, ball by ball.</p>
      <ol className="mt-4 flex gap-1" aria-label="Steps">
        {steps.map((s, i) => <li key={s} className={`h-1.5 flex-1 rounded-full ${i <= step ? 'bg-flood' : 'bg-pitch-600'}`} aria-current={i === step ? 'step' : undefined}><span className="sr-only">{s}</span></li>)}
      </ol>
      <p className="mt-2 text-sm text-chalk-dim">Step {step + 1} of {steps.length}: {steps[step]}</p>

      <div className="mt-4 space-y-4">
        {step === 0 && <div className="grid gap-2 sm:grid-cols-2">{KINDS.map(([k, t, b]) => <Choice key={k} selected={f.kind === k} onClick={() => set('kind')(k)} title={t} body={b} />)}</div>}
        {step === 1 && (teams ? <TeamsStep data={teams} f={f} setF={setF} /> : <p className="text-chalk-dim">Loading teams…</p>)}
        {step === 2 && <StructureStep f={f} set={set} pv={pv} />}
        {step === 3 && <MatchStep f={f} set={set} />}
        {step === 4 && (
          <div className="space-y-3">
            <div><label className="label" htmlFor="tn">Tournament name</label><input id="tn" className="field" value={f.name} placeholder={defaultName(f)} onChange={set('name')} maxLength={60} /></div>
            <div className="rounded-xl bg-pitch-900/60 p-4 text-sm text-chalk-dim">
              <p><b className="text-chalk">{f.picked.length} teams</b>, you are <b className="text-chalk">{f.picked[f.mine]?.name}</b>.</p>
              <p>{KINDS.find((k) => k[0] === f.kind)[1]}: {pv.league ? `${pv.league} group matches, ` : ''}{pv.knockout ? `${pv.knockout} knockout matches` : 'no knockout'}{pv.byes ? ` (${pv.byes} bye${pv.byes === 1 ? '' : 's'})` : ''}. {pv.total} matches in all.</p>
              <p>{f.format === 't20' ? 'T20' : f.format === 'odi' ? 'ODI' : `${f.overs}-over`} matches, {f.wickets} wickets, AI {f.aiLevel}, {f.aiPersonality === 'mixed' ? 'each AI team with its own personality' : `all AI teams ${f.aiPersonality}`}.</p>
              <p className="mt-2">Knockout ties go to super overs until someone wins. Your progress is saved after every ball: leave any time and carry on later.</p>
            </div>
          </div>
        )}
      </div>
      {err && <p className="mt-3 text-sm text-leather" role="alert">{err}</p>}
      <div className="mt-5 flex gap-2">
        {step > 0 && <button type="button" className="btn-ghost" onClick={() => setStep(step - 1)}>Back</button>}
        {step < steps.length - 1
          ? <button type="button" className="btn-go flex-1 text-xl" disabled={!canNext} onClick={() => setStep(step + 1)}>Next</button>
          : <button type="button" className="btn-flood flex-1 text-xl" disabled={busy} onClick={create}>Start the tournament</button>}
      </div>
    </section>
  );
}
const defaultName = (f) => `${f.picked[f.mine]?.short || 'My'} ${f.kind === 'knockout' ? 'Cup' : f.kind === 'league' ? 'League' : 'Championship'}`;

function TeamsStep({ data, f, setF }) {
  const [cat, setCat] = useState('international');
  const [q, setQ] = useState('');
  const [custom, setCustom] = useState('');
  const picked = f.picked;
  const has = (t) => picked.some((p) => p.id === t.id);
  const toggle = (t) => setF((x) => {
    if (has(t)) { const i = x.picked.findIndex((p) => p.id === t.id); const list = x.picked.filter((p) => p.id !== t.id); return { ...x, picked: list, mine: x.mine === i ? 0 : x.mine > i ? x.mine - 1 : x.mine }; }
    if (x.picked.length >= 16) return x;
    return { ...x, picked: [...x.picked, { id: t.id, name: t.name, short: t.short, color: t.color, logo: t.logo, country: t.country, squadSize: t.squadSize }] };
  });
  const addCustom = (e) => {
    e.preventDefault();
    const name = custom.trim();
    if (name.length < 2 || picked.some((p) => p.name.toLowerCase() === name.toLowerCase()) || picked.length >= 16) return;
    setF((x) => ({ ...x, picked: [...x.picked, { name, short: name.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase(), custom: true }] }));
    setCustom('');
  };
  const move = (i, d) => setF((x) => {
    const j = i + d; if (j < 0 || j >= x.picked.length) return x;
    const list = [...x.picked]; [list[i], list[j]] = [list[j], list[i]];
    const mine = x.mine === i ? j : x.mine === j ? i : x.mine;
    return { ...x, picked: list, mine };
  });
  const remove = (i) => setF((x) => ({ ...x, picked: x.picked.filter((_, k) => k !== i), mine: x.mine === i ? 0 : x.mine > i ? x.mine - 1 : x.mine }));
  const list = data.teams.filter((t) => t.category === cat && (!q || t.name.toLowerCase().includes(q.toLowerCase())));
  const allIn = list.length > 0 && list.every(has);
  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center justify-between gap-2">
          <span className="label">Add teams ({picked.length} of 16)</span>
          <button type="button" className="text-sm text-chalk-dim underline" onClick={() => list.forEach((t) => { if (allIn ? has(t) : !has(t)) toggle(t); })}>{allIn ? 'Remove all shown' : 'Add all shown'}</button>
        </div>
        <div className="mb-2 flex flex-wrap gap-1">
          {data.categories.map((c) => <button key={c.id} type="button" aria-pressed={cat === c.id} onClick={() => setCat(c.id)} className={`rounded-full px-3 py-1 text-sm font-semibold ${cat === c.id ? 'bg-flood text-pitch-900' : 'bg-pitch-700 text-chalk-dim'}`}>{c.name}</button>)}
          <input aria-label="Search teams" className="field ml-auto w-32 py-1 text-sm" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ul className="no-scrollbar grid max-h-60 grid-cols-2 gap-1 overflow-y-auto sm:grid-cols-3">
          {list.map((t) => (
            <li key={t.id}>
              <button type="button" aria-pressed={has(t)} onClick={() => toggle(t)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm ring-2 ${has(t) ? 'bg-turf/15 ring-turf' : 'bg-pitch-900/60 ring-transparent hover:ring-pitch-500'}`}>
                <TeamBadge team={t} size={26} /><span className="truncate font-semibold">{t.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <form onSubmit={addCustom} className="mt-2 flex gap-2">
          <input className="field flex-1" placeholder="Or add your own team name" value={custom} onChange={(e) => setCustom(e.target.value)} maxLength={30} aria-label="Custom team name" />
          <button className="btn-ghost" disabled={custom.trim().length < 2}>Add</button>
        </form>
        <div className="mt-2"><SyncNote data={data} /></div>
      </div>
      {picked.length > 0 && (
        <div>
          <span className="label">Seeding and your team</span>
          <p className="mb-2 text-xs text-chalk-faint">Order sets the seeds (top seeds are kept apart and get any byes). Tap “Mine” on the team you'll play.</p>
          <ol className="space-y-1">
            {picked.map((t, i) => (
              <li key={t.id || t.name} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${f.mine === i ? 'bg-flood/15 ring-2 ring-flood' : 'bg-pitch-900/60'}`}>
                <span className="w-5 text-right text-sm tabular-nums text-chalk-faint">{i + 1}</span>
                <TeamBadge team={t} size={26} />
                <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{t.name}</span>{t.custom ? <span className="block text-xs text-chalk-faint">Custom team</span> : !t.squadSize ? <span className="block truncate text-xs text-chalk-faint">Stand-in players</span> : null}</span>
                <button type="button" aria-pressed={f.mine === i} onClick={() => setF((x) => ({ ...x, mine: i }))} className={`rounded-md px-2 py-1 text-xs font-bold ${f.mine === i ? 'bg-flood text-pitch-900' : 'bg-pitch-600'}`}>Mine</button>
                <button type="button" aria-label={`Move ${t.name} up`} onClick={() => move(i, -1)} className="rounded-md bg-pitch-600 px-2 py-1 text-xs">▲</button>
                <button type="button" aria-label={`Move ${t.name} down`} onClick={() => move(i, 1)} className="rounded-md bg-pitch-600 px-2 py-1 text-xs">▼</button>
                <button type="button" aria-label={`Remove ${t.name}`} onClick={() => remove(i)} className="rounded-md bg-pitch-600 px-2 py-1 text-xs">✕</button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function StructureStep({ f, set, pv }) {
  const n = f.picked.length;
  return (
    <div className="space-y-4">
      {(f.kind === 'groups' || f.kind === 'custom') && (
        <div className="grid grid-cols-2 gap-3">
          <Stepper label="Groups" value={+f.groups} set={set('groups')} min={f.kind === 'custom' ? 0 : 2} max={4} />
          {+f.groups > 0 && <Stepper label="Qualify from each group" value={+f.qualify} set={set('qualify')} min={1} max={f.kind === 'groups' ? 2 : 8} />}
        </div>
      )}
      {f.kind === 'custom' && +f.groups === 0 && <p className="text-sm text-chalk-dim">No groups: a straight knockout of all {n} teams.</p>}
      {(f.kind === 'league' || (f.kind === 'custom' && +f.groups > 0)) && (
        <div>
          <span className="label">Times each pair meets</span>
          <div className="grid grid-cols-2 gap-2">
            <Choice selected={+f.legs === 1} onClick={() => set('legs')(1)} title="Once" body="Single round robin" />
            <Choice selected={+f.legs === 2} onClick={() => set('legs')(2)} title="Twice" body="Home and away" />
          </div>
        </div>
      )}
      {f.kind === 'league' && (
        <div>
          <span className="label">After the league</span>
          <div className="grid grid-cols-3 gap-2">
            {[[1, 'Top wins', 'No knockout'], [2, 'Final', 'Top two'], [4, 'Semis', 'Top four']].map(([q, t, b]) => (
              <Choice key={q} selected={+f.qualify === q} onClick={() => set('qualify')(q)} title={t} body={b} />
            ))}
          </div>
        </div>
      )}
      {f.kind !== 'league' && <Toggle label="Third-place play-off" hint="The beaten semi-finalists play for third." checked={f.thirdPlace} onChange={set('thirdPlace')} />}
      {f.kind === 'league' && +f.qualify === 4 && <Toggle label="Third-place play-off" hint="The beaten semi-finalists play for third." checked={f.thirdPlace} onChange={set('thirdPlace')} />}
      <div className="rounded-xl bg-pitch-900/60 p-4 text-sm" aria-live="polite">
        {pv.error ? <p className="text-leather">{pv.error}</p> : (
          <p className="text-chalk-dim"><b className="text-chalk">{pv.total} matches</b>: {pv.league ? `${pv.league} in ${pv.groups > 1 ? `${pv.groups} groups` : 'the league'}` : 'no group stage'}{pv.knockout ? `, then ${pv.knockout} knockout${pv.byes ? ` (${pv.byes} bye${pv.byes === 1 ? '' : 's'} for the top seeds)` : ''}` : ''}.</p>
        )}
      </div>
    </div>
  );
}

function MatchStep({ f, set }) {
  const cfg = useAppConfig();
  useEffect(() => {
    if (!cfg.formats.enabled.includes(f.format)) set('format')(['t20', 'odi', 'custom'].find((k) => cfg.formats.enabled.includes(k)) || f.format);
    if (!cfg.ai.levels.includes(f.aiLevel)) set('aiLevel')(cfg.ai.defaultLevel);
    if (f.aiPersonality !== 'mixed' && !cfg.ai.personalities.includes(f.aiPersonality)) set('aiPersonality')('mixed');
  }, [cfg]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="space-y-4">
      <div>
        <span className="label">Match format</span>
        <div className="grid grid-cols-3 gap-2">
          {[['t20', 'T20', '20 overs'], ['odi', 'ODI', '50 overs'], ['custom', 'Custom', 'Pick the overs']].filter(([k]) => cfg.formats.enabled.includes(k)).map(([k, t, b]) => <Choice key={k} selected={f.format === k} onClick={() => set('format')(k)} title={t} body={b} />)}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {f.format === 'custom' && <Stepper label="Overs per match" value={+f.overs} set={set('overs')} min={1} max={cfg.formats.maxCustomOvers} />}
        <Stepper label="Wickets" value={+f.wickets} set={set('wickets')} min={1} max={10} />
      </div>
      <div>
        <span className="label">How you submit</span>
        <div className="grid grid-cols-2 gap-2">
          <Choice selected={f.play === 'over'} onClick={() => set('play')('over')} title="Whole over" body="Lock in the over at once" />
          <Choice selected={f.play === 'ball'} onClick={() => set('play')('ball')} title="Ball by ball" body="One number at a time" />
        </div>
      </div>
      <div>
        <span className="label">AI difficulty</span>
        <div className="grid grid-cols-4 gap-2">
          {cfg.ai.levels.map((l) => (
            <button key={l} type="button" aria-pressed={f.aiLevel === l} onClick={() => set('aiLevel')(l)}
              className={`rounded-lg py-2 font-display text-lg font-bold capitalize ${f.aiLevel === l ? 'bg-flood text-pitch-900' : 'bg-pitch-600'}`}>{l}</button>
          ))}
        </div>
      </div>
      <div>
        <span className="label">AI personalities</span>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {['mixed', ...cfg.ai.personalities].map((p) => (
            <button key={p} type="button" aria-pressed={f.aiPersonality === p} onClick={() => set('aiPersonality')(p)}
              className={`rounded-lg py-2 text-sm font-semibold capitalize ${f.aiPersonality === p ? 'bg-turf text-pitch-900' : 'bg-pitch-600'}`}>{p}</button>
          ))}
        </div>
        <p className="mt-1 text-xs text-chalk-faint">{f.aiPersonality === 'mixed' ? 'Each AI team gets its own style, so every opponent plays differently.' : `Every AI team plays ${f.aiPersonality}.`}</p>
      </div>
    </div>
  );
}
