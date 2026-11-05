import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { SignInCard, useApp } from '../App.jsx';
import TeamBadge from '../components/TeamBadge.jsx';
import TeamPicker, { SyncNote } from '../components/TeamPicker.jsx';

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
          Bowler and batter each lock in their numbers, then the reveal: same number and you're out, different and you score what you picked.
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

const STEPS = ['Who plays', 'Format', 'Rules', 'Teams'];

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
    name: '', format: 'custom', overs: 2, wickets: 3, playersPerTeam: 11, mode: 'auto', play: 'over', superOver: true,
    noConsecutive: true, spectators: 'open', teamA: 'Lions', teamB: 'Tigers', copyFrom: '',
    days: 3, sessionsPerDay: 3, oversPerSession: 15, inningsPerTeam: 2, sessionMinutes: 0, lunch: true, tea: true, stumps: true, followOn: true,
    participation: 'ai', teamSource: 'real', aiLevel: 'medium', xiSize: 11, allowSameTeam: false, realA: 'int-ind', realB: 'int-aus',
  });
  const [past, setPast] = useState([]);
  const [teams, setTeams] = useState(null);
  useEffect(() => { api('/api/cricket/teams').then(setTeams).catch(() => setTeams({ categories: [], teams: [], sync: {} })); }, []);
  const oneVOne = f.participation !== 'team';
  const real = oneVOne && f.teamSource === 'real';
  const tA = teams?.teams.find((t) => t.id === f.realA), tB = teams?.teams.find((t) => t.id === f.realB);
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
      const { format, overs, wickets, playersPerTeam, mode, play, superOver, noConsecutive, spectators,
        days, sessionsPerDay, oversPerSession, inningsPerTeam, sessionMinutes, lunch, tea, stumps, followOn,
        participation, teamSource, aiLevel, xiSize, allowSameTeam } = f;
      const names = real ? [tA?.name, tB?.name] : [f.teamA, f.teamB];
      const r = await api('/api/matches', { body: {
        name: f.name || `${names[0]} v ${names[1]}`, teamA: f.teamA, teamB: f.teamB, copyFrom: (!oneVOne && f.copyFrom) || undefined,
        realTeams: real ? { A: f.realA, B: f.realB } : undefined,
        config: { format, overs, wickets, playersPerTeam, mode, play, superOver, noConsecutive, spectators,
          days, sessionsPerDay, oversPerSession, inningsPerTeam, sessionMinutes, lunch, tea, stumps, followOn,
          participation, teamSource: oneVOne ? teamSource : 'custom', aiLevel, xiSize, allowSameTeam } } });
      nav(`/m/${r.id}`);
    } catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <section className="panel mown p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-2xl font-bold">Create a match</h2>
        <span className="text-sm text-chalk-dim">Step {step + 1} of {STEPS.length}</span>
      </div>
      <ol className="mt-3 grid grid-cols-4 gap-1.5" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className={`border-t-4 pt-1 text-xs font-semibold ${i <= step ? 'border-flood text-chalk' : 'border-pitch-600 text-chalk-faint'}`}>{s}</li>
        ))}
      </ol>

      <div className="mt-4 space-y-4">
        {step === 0 && <>
          <div>
            <span className="label">Who's playing</span>
            <div className="grid gap-2">
              <Choice selected={f.participation === 'ai'} onClick={() => set('participation')('ai')} title="Me v the AI" body="Play one-v-one against the computer, at the level you choose." />
              <Choice selected={f.participation === 'pvp'} onClick={() => set('participation')('pvp')} title="Me v a friend" body="One-v-one. Your friend joins from the link and takes the other side." />
              <Choice selected={f.participation === 'team'} onClick={() => set('participation')('team')} title="Team match" body="Several people a side, with captains. Custom teams only." />
            </div>
          </div>
          {oneVOne && (
            <div>
              <span className="label">Teams</span>
              <div className="grid grid-cols-2 gap-2">
                <Choice selected={f.teamSource === 'real'} onClick={() => set('teamSource')('real')} title="Real teams" body="International sides and IPL franchises with their squads." />
                <Choice selected={f.teamSource === 'custom'} onClick={() => set('teamSource')('custom')} title="Custom teams" body="Name your own sides." />
              </div>
            </div>
          )}
          {real && (teams ? (
            <>
              <TeamPicker data={teams} value={f.realA} onChange={set('realA')} exclude={f.allowSameTeam ? null : f.realB} label="Your team" />
              <TeamPicker data={teams} value={f.realB} onChange={set('realB')} exclude={f.allowSameTeam ? null : f.realA} label={f.participation === 'ai' ? "The AI's team" : "Your friend's team"} />
              <Toggle label="Allow both sides to be the same team" checked={f.allowSameTeam} onChange={set('allowSameTeam')} />
              <SyncNote data={teams} />
            </>
          ) : <p className="text-chalk-dim">Loading teams…</p>)}
          {f.participation === 'ai' && (
            <div>
              <span className="label">AI difficulty</span>
              <div className="grid grid-cols-4 gap-2">
                {['easy', 'medium', 'hard', 'expert'].map((l) => (
                  <button key={l} type="button" aria-pressed={f.aiLevel === l} onClick={() => set('aiLevel')(l)}
                    className={`rounded-lg py-2 font-display text-lg font-bold capitalize ${f.aiLevel === l ? 'bg-flood text-pitch-900' : 'bg-pitch-600'}`}>{l}</button>
                ))}
              </div>
              <p className="mt-1 text-xs text-chalk-faint">{{ easy: 'Picks at random within the rules.', medium: 'Avoids obvious mistakes.', hard: 'Learns your habits and reads the match situation.', expert: 'Learns your patterns, plays the situation, stays hard to read.' }[f.aiLevel]}</p>
            </div>
          )}
          {real && tA && tB && (
            <div className="flex items-center justify-center gap-3 rounded-xl bg-pitch-900/60 p-3">
              <TeamBadge team={tA} size={40} /><span className="font-display text-xl font-bold">{tA.name}</span>
              <span className="text-chalk-faint">v</span>
              <span className="font-display text-xl font-bold">{tB.name}</span><TeamBadge team={tB} size={40} />
            </div>
          )}
          {real && f.realA === f.realB && !f.allowSameTeam && <p className="text-sm text-leather">Both sides have the same team. Pick a different one, or allow it above.</p>}
        </>}
        {step === 1 && <>
          <div><label className="label" htmlFor="mn">Match name</label><input id="mn" className="field" value={f.name} onChange={set('name')} placeholder={`${f.teamA} v ${f.teamB}`} maxLength={60} /></div>
          <div>
            <span className="label">Format</span>
            <div className="grid grid-cols-2 gap-2">
              <Choice selected={f.format === 't20'} onClick={() => setF((x) => ({ ...x, format: 't20', overs: 20, wickets: x.format === 'test' ? 3 : x.wickets }))} title="T20" body="20 overs a side." />
              <Choice selected={f.format === 'odi'} onClick={() => setF((x) => ({ ...x, format: 'odi', overs: 50, wickets: x.format === 'test' ? 3 : x.wickets }))} title="ODI" body="50 overs a side." />
              <Choice selected={f.format === 'custom'} onClick={() => setF((x) => ({ ...x, format: 'custom', overs: x.format === 't20' || x.format === 'odi' ? 2 : x.overs, wickets: x.format === 'test' ? 3 : x.wickets }))} title="Custom overs" body="Pick the overs yourself." />
              <Choice selected={f.format === 'test'} onClick={() => setF((x) => ({ ...x, format: 'test', wickets: 10 }))} title="Test match" body="Days and sessions, two innings each." />
            </div>
          </div>
          {f.format !== 'test' ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                {f.format === 'custom' ? <Stepper label="Overs" value={f.overs} set={set('overs')} min={1} max={50} /> : <div><span className="label">Overs</span><div className="py-2 text-center font-display text-3xl font-bold">{f.overs}</div></div>}
                <Stepper label="Wickets" value={f.wickets} set={set('wickets')} min={1} max={20} />
                {real ? <Stepper label="Playing XI" value={f.xiSize} set={set('xiSize')} min={2} max={11} /> : oneVOne ? <div><span className="label">Per side</span><div className="py-2 text-center font-display text-3xl font-bold">1</div></div> : <Stepper label="Per side" value={f.playersPerTeam} set={set('playersPerTeam')} min={1} max={15} />}
              </div>
              {f.format === 'custom' && !oneVOne && (
                <div className="flex flex-wrap gap-2 text-sm">
                  <span className="text-chalk-dim">Quick formats:</span>
                  {[['1 v 1 quickie', 1, 1, 1], ['3 a side', 3, 3, 3], ['5 a side', 5, 5, 5]].map(([l, o, w, p]) => (
                    <button key={l} type="button" className="rounded-full bg-pitch-700 px-3 py-1 hover:bg-pitch-600" onClick={() => setF((x) => ({ ...x, overs: o, wickets: w, playersPerTeam: p }))}>{l}</button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Stepper label="Days" value={f.days} set={set('days')} min={1} max={5} />
                <Stepper label="Sessions a day" value={f.sessionsPerDay} set={set('sessionsPerDay')} min={1} max={4} />
                <Stepper label="Overs a session" value={f.oversPerSession} set={set('oversPerSession')} min={1} max={90} />
              </div>
              <p className="text-sm text-chalk-dim">{f.sessionsPerDay * f.oversPerSession} overs a day, {f.days * f.sessionsPerDay * f.oversPerSession} overs scheduled in all. A session ends after its overs (or when ended early); innings carry on across sessions and days.</p>
              <div className="grid grid-cols-3 gap-3">
                <Stepper label="Wickets" value={f.wickets} set={set('wickets')} min={1} max={20} />
                {real ? <Stepper label="Playing XI" value={f.xiSize} set={set('xiSize')} min={2} max={11} /> : oneVOne ? <div><span className="label">Per side</span><div className="py-2 text-center font-display text-3xl font-bold">1</div></div> : <Stepper label="Per side" value={f.playersPerTeam} set={set('playersPerTeam')} min={1} max={15} />}
                <Stepper label="Time limit (min)" value={f.sessionMinutes} set={set('sessionMinutes')} min={0} max={240} />
              </div>
              <div>
                <span className="label">Innings each</span>
                <div className="grid grid-cols-2 gap-2">
                  {[1, 2].map((n) => <button key={n} type="button" aria-pressed={f.inningsPerTeam === n} onClick={() => set('inningsPerTeam')(n)} className={`rounded-lg py-2 font-display text-lg font-bold ${f.inningsPerTeam === n ? 'bg-turf text-pitch-900' : 'bg-pitch-600'}`}>{n} innings</button>)}
                </div>
              </div>
              <div className="divide-y divide-pitch-600">
                <Toggle label="Lunch break after session 1" hint="Off: session 2 starts straight away." checked={f.lunch} onChange={set('lunch')} />
                <Toggle label="Tea break after session 2" checked={f.tea} onChange={set('tea')} />
                <Toggle label="Stumps at the end of each day" hint="Off: the next day starts straight away." checked={f.stumps} onChange={set('stumps')} />
                {f.inningsPerTeam === 2 && <Toggle label="Allow the follow-on" hint={`If the side batting second trails by ${f.days >= 5 ? 200 : f.days >= 3 ? 150 : f.days === 2 ? 100 : 75}+, the leading captain can make them bat again.`} checked={f.followOn} onChange={set('followOn')} />}
              </div>
              <p className="rounded-lg bg-pitch-900/60 p-3 text-sm text-chalk-dim">Test rules: batters pick 0, 1, 2, 3, 4 or 6, and bowlers pick 1, 2, 3, 4 or 6. A batter who plays out a six-ball dot over must score off one of the first two balls of their next over.</p>
            </>
          )}
        </>}

        {step === 2 && <>
          <div>
            <span className="label">How players submit</span>
            <div className="grid gap-2 sm:grid-cols-2">
              <Choice selected={f.play === 'over'} onClick={() => set('play')('over')} title="Complete over" body="Bowler and batter each lock in the numbers for the rest of the over. The whole over is revealed at once." />
              <Choice selected={f.play === 'ball'} onClick={() => set('play')('ball')} title="Ball by ball" body="Both pick one number per ball. Each ball is revealed as soon as both are in." />
            </div>
            <p className="mt-1 text-xs text-chalk-faint">This can't be changed once the match is created.</p>
          </div>
          {f.participation === 'ai' ? <p className="rounded-lg bg-pitch-900/60 p-3 text-sm text-chalk-dim">Against the AI there's no umpire: the game runs itself.</p> : <div>
            <span className="label">Umpire</span>
            <div className="grid gap-2 sm:grid-cols-2">
              <Choice selected={f.mode === 'auto'} onClick={() => set('mode')('auto')} title="No umpire" body="The game runs itself: scoring, innings changes and the result are automatic." />
              <Choice selected={f.mode === 'umpire'} onClick={() => set('mode')('umpire')} title="With umpire (you)" body={f.participation === 'pvp' ? 'You umpire; two friends play each other.' : "You start innings, can pause, correct mistakes and privately check the bowler's numbers."} />
            </div>
          </div>}
          <div className="divide-y divide-pitch-600">
            <Toggle label="No bowling two overs in a row" checked={f.noConsecutive} onChange={set('noConsecutive')} />
            {f.format !== 'test' && <Toggle label="Super over on a tie" checked={f.superOver} onChange={set('superOver')} />}
          </div>
          <div>
            <span className="label">Spectators</span>
            <div className="grid gap-2 sm:grid-cols-2">
              <Choice selected={f.spectators === 'open'} onClick={() => set('spectators')('open')} title="Watch and chat" body="Anyone with the link can follow live and join the stadium chat." />
              <Choice selected={f.spectators === 'watch'} onClick={() => set('spectators')('watch')} title="Watch only" body="Spectators follow live; only players can chat." />
            </div>
          </div>
        </>}

        {step === 3 && real && tA && tB && <>
          <div className="grid grid-cols-2 gap-3">
            {[[tA, 'You'], [tB, f.participation === 'ai' ? `AI (${f.aiLevel})` : 'Your friend']].map(([t, who]) => (
              <div key={who} className="rounded-xl bg-pitch-900/60 p-3 text-center">
                <TeamBadge team={t} size={48} className="mx-auto" />
                <div className="mt-1 font-display text-xl font-bold">{t.name}</div>
                <div className="text-sm text-chalk-dim">{who}</div>
                <div className="text-xs text-chalk-faint">{t.squadSize ? `${t.squadSize} in squad` : 'Stand-in players (squad not synced)'}</div>
              </div>
            ))}
          </div>
          <p className="rounded-lg bg-pitch-900/60 p-3 text-sm text-chalk-dim">Next you'll pick your playing XI and batting order, confirm your lineup, and toss.{f.participation === 'pvp' ? ' Send your friend the link so they can take the other side.' : ''}</p>
        </>}
        {step === 3 && !real && <>
          {past.length > 0 && !oneVOne && (
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
          <p className="rounded-lg bg-pitch-900/60 p-3 text-sm text-chalk-dim">Next you'll get the invite link. Friends join and pick a team (the first one in each team is captain). Both captains confirm their lineups, then the toss decides who bats first.</p>
        </>}
      </div>

      {err && <p className="mt-3 text-sm text-leather" role="alert">{err}</p>}
      <div className="mt-5 flex gap-2">
        {step > 0 && <button type="button" className="btn-ghost" onClick={() => setStep(step - 1)}>Back</button>}
        {step < 3
          ? <button type="button" className="btn-go flex-1 text-xl" disabled={step === 0 && real && (!tA || !tB || (f.realA === f.realB && !f.allowSameTeam))} onClick={() => setStep(step + 1)}>Next</button>
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

const statusLabel = { lobby: 'Setting up', live: 'Live', innings_break: 'Innings break', session_break: 'Session break', day_break: 'Day completed', suspended: 'Suspended', completed: 'Finished', abandoned: 'Abandoned' };

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
                <span className="flex shrink-0 -space-x-2">{m.badges?.map((b, i) => <TeamBadge key={i} team={b} size={28} />)}</span>
                <span className="min-w-0 flex-1">
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
