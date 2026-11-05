// The role-specific play area: bowler, batter, lobby, breaks and results.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { emit, matchLink } from '../api.js';
import { useApp } from '../App.jsx';

const NUM_COLORS = {
  1: 'bg-[#7FD1FF] text-pitch-900', 2: 'bg-turf text-pitch-900', 3: 'bg-[#B58CFF] text-pitch-900',
  4: 'bg-flood text-pitch-900', 5: 'bg-[#FF8A3D] text-pitch-900', 6: 'bg-leather text-chalk',
};

export function BowlPanel({ matchId, nextBatter }) {
  const { toast } = useApp();
  const [seq, setSeq] = useState([]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const add = (n) => { if (seq.length < 6) { setSeq([...seq, n]); setConfirm(false); } };
  const random = () => { setSeq(Array.from({ length: 6 }, () => 1 + Math.floor(Math.random() * 6))); setConfirm(false); };
  const seal = async () => {
    if (!confirm) { setConfirm(true); return; }
    setBusy(true);
    const r = await emit('bowler:submit', { matchId, sequence: seq });
    setBusy(false);
    if (!r.ok) { toast({ title: 'Not sealed', body: r.error }); setConfirm(false); }
  };
  return (
    <section className="panel your-turn p-4" aria-label="Bowl your over">
      <h2 className="font-display text-3xl font-extrabold leading-none">Your over. Seal six numbers.</h2>
      <p className="mt-1 text-sm text-chalk-dim">{nextBatter} can't see these. If they pick the same number on a ball, they're out.</p>
      <div className="mt-4 grid grid-cols-6 gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <button key={i} type="button" onClick={() => { setSeq(seq.filter((_, j) => j !== i)); setConfirm(false); }} disabled={seq[i] == null}
            aria-label={seq[i] ? `Ball ${i + 1}: ${seq[i]}. Tap to remove.` : `Ball ${i + 1}: empty`}
            className={`aspect-square rounded-full font-display text-3xl font-extrabold ${seq[i] ? `${NUM_COLORS[seq[i]]} pop` : 'ring-2 ring-dashed ring-pitch-500 text-chalk-faint'}`}>
            {seq[i] ?? i + 1}
          </button>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-6 gap-2">
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <button key={n} type="button" onClick={() => add(n)} disabled={seq.length >= 6} className="rounded-lg bg-pitch-600 py-3 font-display text-2xl font-bold hover:bg-pitch-500 disabled:opacity-40">{n}</button>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <button type="button" className="btn-ghost" onClick={random}>Random</button>
        <button type="button" className="btn-ghost" onClick={() => { setSeq([]); setConfirm(false); }} disabled={!seq.length}>Clear</button>
        <button type="button" className={`${confirm ? 'btn-flood' : 'btn-go'} flex-1`} disabled={seq.length !== 6 || busy} onClick={seal}>
          {confirm ? `Seal ${seq.join(' ')} for good` : seq.length === 6 ? 'Seal the over' : `${6 - seq.length} more to pick`}
        </button>
      </div>
      {confirm && <p className="mt-2 text-sm text-flood">Once sealed, you can't change it. Tap again to confirm.</p>}
    </section>
  );
}

export function MySealedOver({ seq, set }) {
  const played = new Map((set?.balls || []).filter((b) => !b.voided).map((b) => [b.i, b]));
  return (
    <section className="panel p-4">
      <h2 className="font-display text-xl font-bold">Your sealed over</h2>
      <p className="text-sm text-chalk-dim">Only you can see this. The batter is picking now.</p>
      <div className="mt-3 grid grid-cols-6 gap-2">
        {seq.map((n, i) => {
          const b = played.get(i);
          return (
            <div key={i} className={`grid aspect-square place-items-center rounded-full font-display text-2xl font-extrabold ${b ? (b.wicket ? 'bg-leather' : 'bg-pitch-600 text-chalk-faint line-through') : i < (set?.cap ?? 6) ? NUM_COLORS[n] : 'bg-pitch-700 text-chalk-faint'}`}>{n}</div>
          );
        })}
      </div>
    </section>
  );
}

export function BatPanel({ matchId, cur }) {
  const { toast } = useApp();
  const [pick, setPick] = useState(null);
  const [busy, setBusy] = useState(false);
  const ballInSet = (cur.set?.balls?.filter((b) => !b.voided).length || 0) + 1;
  useEffect(() => { setPick(null); }, [cur.nextBallNo]);
  const play = async () => {
    if (!pick) return;
    setBusy(true);
    const r = await emit('batter:play', { matchId, number: pick, ballNo: cur.nextBallNo });
    setBusy(false);
    if (!r.ok) toast({ title: 'Shot not played', body: r.error });
  };
  return (
    <section className="panel your-turn p-4" aria-label="Bat">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-3xl font-extrabold leading-none">You're on strike</h2>
        <span className="font-display text-xl text-chalk-dim">Ball {ballInSet} of {cur.set?.cap ?? 6}</span>
      </div>
      <p className="mt-1 text-sm text-chalk-dim">Pick a number. Match {cur.bowlerName}'s and you're out.</p>
      <div className="mt-4 grid grid-cols-3 gap-3">
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <button key={n} type="button" onClick={() => setPick(n)} aria-pressed={pick === n}
            className={`aspect-[5/4] rounded-2xl font-display text-6xl font-extrabold shadow-lg transition ${NUM_COLORS[n]} ${pick === n ? 'scale-105 ring-4 ring-chalk' : pick ? 'opacity-55' : ''}`}>
            {n}
          </button>
        ))}
      </div>
      <button type="button" className="btn-go mt-4 w-full py-4 text-2xl" disabled={!pick || busy} onClick={play}>
        {pick ? `Play ${pick}` : 'Pick a number'}
      </button>
    </section>
  );
}

export function Waiting({ title, body }) {
  return (
    <section className="panel p-5 text-center">
      <h2 className="font-display text-2xl font-bold">{title}</h2>
      {body && <p className="mt-1 text-chalk-dim">{body}</p>}
    </section>
  );
}

export function Invite({ id }) {
  const { toast } = useApp();
  const link = matchLink(id);
  const share = async () => {
    if (navigator.share) { try { await navigator.share({ title: 'Join my cricket match', text: `Join my match on FOOTY CRICKET LEAGUE, code ${id}`, url: link }); return; } catch {} }
    try { await navigator.clipboard.writeText(link); toast({ title: 'Link copied', body: 'Send it to your friends.', ms: 2500 }); } catch { toast({ title: 'Copy this link', body: link }); }
  };
  return (
    <section className="panel flex items-center gap-4 p-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-chalk-dim">Match code</div>
        <div className="font-display text-4xl font-extrabold tracking-[0.18em] text-flood">{id}</div>
        <div className="truncate text-xs text-chalk-faint">{link}</div>
      </div>
      <button type="button" onClick={share} className="btn-flood shrink-0">Share link</button>
    </section>
  );
}

export function Teams({ state, me, isUmp, online = [] }) {
  const { toast } = useApp();
  const act = async (action) => {
    const r = await emit('umpire', { matchId: state.id, action });
    if (!r.ok) toast({ title: 'Not done', body: r.error });
  };
  const move = (team, idx, dir) => {
    const ids = state.teams[team].players.map((p) => p.id);
    const j = idx + dir; if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    act({ type: 'order', team, userIds: ids });
  };
  const bench = state.members.filter((m) => !m.team);
  const editable = isUmp && state.status !== 'completed' && state.status !== 'abandoned';
  const dot = (id) => <span className={`mr-2 inline-block h-2 w-2 rounded-full ${online.includes(id) ? 'bg-turf' : 'bg-pitch-500'}`} aria-label={online.includes(id) ? 'online' : 'offline'} />;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {['A', 'B'].map((t) => (
          <section key={t} className="panel p-4">
            <h3 className="flex items-baseline justify-between font-display text-xl font-bold">
              {state.teams[t].name}
              <span className="text-sm font-medium text-chalk-dim">{state.teams[t].players.length}/{state.config.playersPerTeam}</span>
            </h3>
            {state.teams[t].players.length === 0 ? <p className="mt-1 text-sm text-chalk-dim">{editable ? 'Add players from the list below.' : 'No players yet.'}</p> : (
              <ol className="mt-2 space-y-1">
                {state.teams[t].players.map((p, i) => (
                  <li key={p.id} className="flex items-center gap-2">
                    <span className="w-5 text-right font-display text-chalk-faint">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{dot(p.id)}<Link to={`/u/${p.id}`} className="hover:text-flood">{p.name}</Link>{p.id === me ? <span className="text-chalk-faint"> (you)</span> : ''}</span>
                    {editable && (
                      <span className="flex shrink-0 gap-1">
                        <button className="rounded px-2 py-1 text-chalk-dim hover:bg-pitch-600" aria-label={`Move ${p.name} up the batting order`} onClick={() => move(t, i, -1)} disabled={i === 0}>↑</button>
                        <button className="rounded px-2 py-1 text-chalk-dim hover:bg-pitch-600" aria-label={`Move ${p.name} down the batting order`} onClick={() => move(t, i, 1)} disabled={i === state.teams[t].players.length - 1}>↓</button>
                        <button className="rounded px-2 py-1 text-chalk-dim hover:bg-pitch-600" onClick={() => act({ type: 'assign', userId: p.id, team: t === 'A' ? 'B' : 'A' })}>Swap</button>
                        <button className="rounded px-2 py-1 text-chalk-dim hover:bg-pitch-600" onClick={() => act({ type: 'assign', userId: p.id, team: null })}>Bench</button>
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        ))}
      </div>
      <section className="panel p-4">
        <h3 className="font-display text-xl font-bold">Spectators <span className="text-sm font-medium text-chalk-dim">{bench.length}</span></h3>
        {bench.length === 0 ? <p className="text-sm text-chalk-dim">Anyone who opens the link shows up here.</p> : (
          <ul className="mt-2 divide-y divide-pitch-600">
            {bench.map((p) => (
              <li key={p.id} className="flex items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate">{dot(p.id)}{p.name}{p.id === state.umpire.id ? <span className="text-chalk-faint"> (umpire)</span> : ''}{p.id === me ? <span className="text-chalk-faint"> (you)</span> : ''}</span>
                {editable && <>
                  <button className="rounded bg-pitch-600 px-2.5 py-1 text-sm hover:bg-pitch-500" onClick={() => act({ type: 'assign', userId: p.id, team: 'A' })}>{state.teams.A.name}</button>
                  <button className="rounded bg-pitch-600 px-2.5 py-1 text-sm hover:bg-pitch-500" onClick={() => act({ type: 'assign', userId: p.id, team: 'B' })}>{state.teams.B.name}</button>
                </>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function Lobby({ state, me, isUmp, online }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const ready = state.teams.A.players.length > 0 && state.teams.B.players.length > 0;
  const start = async () => {
    setBusy(true);
    const r = await emit('match:start', { matchId: state.id });
    setBusy(false);
    if (!r.ok) toast({ title: 'Match not started', body: r.error });
  };
  const setToss = (t) => emit('umpire', { matchId: state.id, action: { type: 'setup', tossBat: t } });
  const mine = state.members.find((m) => m.id === me);
  return (
    <div className="space-y-3">
      <Invite id={state.id} />
      {isUmp ? (
        <section className="panel space-y-3 p-4">
          <h2 className="font-display text-2xl font-bold">You're the umpire</h2>
          <p className="text-sm text-chalk-dim">Put people into teams and set the batting order. You can play as well as umpire.</p>
          <div>
            <span className="label">Batting first</span>
            <div className="flex gap-2">
              {['A', 'B'].map((t) => (
                <button key={t} type="button" onClick={() => setToss(t)} aria-pressed={state.tossBat === t}
                  className={`flex-1 rounded-lg py-2 font-display text-lg font-bold ${state.tossBat === t ? 'bg-turf text-pitch-900' : 'bg-pitch-600'}`}>{state.teams[t].name}</button>
              ))}
            </div>
          </div>
          <button type="button" className="btn-go w-full text-xl" disabled={!ready || busy} onClick={start}>{ready ? 'Start match' : 'Each team needs a player'}</button>
        </section>
      ) : (
        <Waiting title="Waiting for the umpire to start" body={mine?.team ? `You're playing for ${state.teams[mine.team].name}.` : `You're spectating. ${state.umpire.name} can put you into a team.`} />
      )}
      <Teams state={state} me={me} isUmp={isUmp} online={online} />
    </div>
  );
}

export function InningsBreak({ state, isUmp }) {
  const { toast } = useApp();
  const last = state.innings[state.innings.length - 1];
  const tie = last.number === 2 && state.innings[0].runs === last.runs;
  const label = last.number === 1 ? 'Start the second innings' : last.number === 2 ? 'Start the super over' : 'Start the super over chase';
  const next = async () => {
    const r = await emit('match:nextInnings', { matchId: state.id });
    if (!r.ok) toast({ title: 'Not started', body: r.error });
  };
  return (
    <section className="panel p-5 text-center">
      <h2 className="font-display text-4xl font-extrabold">{tie ? 'Scores level!' : 'Innings break'}</h2>
      <p className="mt-1 text-lg text-chalk-dim">{last.battingName} made {last.runs}/{last.wickets}. {tie ? 'A super over decides it.' : `Target ${last.runs + 1}.`}</p>
      {isUmp ? <button className="btn-flood mt-4 w-full text-xl" onClick={next}>{label}</button> : <p className="mt-3 text-sm text-chalk-faint">The umpire starts the next innings.</p>}
    </section>
  );
}

export function ResultCard({ state }) {
  const players = [...state.teams.A.players, ...state.teams.B.players];
  return (
    <section className="panel overflow-hidden text-center">
      <div className="bg-flood px-5 py-6 text-pitch-900">
        <div className="text-5xl" aria-hidden>🏆</div>
        <h2 className="mt-1 font-display text-4xl font-extrabold leading-tight">{state.result?.text}</h2>
      </div>
      <div className="p-4">
        <p className="text-sm text-chalk-dim">Every ball is saved. See how everyone's stats moved:</p>
        <div className="mt-2 flex flex-wrap justify-center gap-2">
          {players.map((p) => <Link key={p.id} to={`/u/${p.id}`} className="rounded-full bg-pitch-600 px-3 py-1 text-sm hover:bg-pitch-500">{p.name}</Link>)}
        </div>
        <Link to="/" className="btn-go mt-4 w-full">Play another match</Link>
      </div>
    </section>
  );
}
