// Match setup (lobby), innings breaks and results.
import { Link } from 'react-router-dom';
import { emit, matchLink } from '../api.js';
import { useApp } from '../App.jsx';

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
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="font-display text-4xl font-extrabold tracking-[0.18em] text-flood">{id}</div>
        <div className="truncate text-xs text-chalk-faint">{link}</div>
      </div>
      <button type="button" onClick={share} className="btn-flood shrink-0">Share link</button>
    </div>
  );
}

function Step({ n, title, done, children }) {
  return (
    <section className="panel p-4">
      <h2 className="mb-3 flex items-center gap-3 font-display text-2xl font-bold">
        <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-lg ${done ? 'bg-turf text-pitch-900' : 'bg-pitch-600 text-chalk-dim'}`}>{done ? '✓' : n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Lobby({ state, me, priv, online, openLineups }) {
  const { toast } = useApp();
  const host = priv.isHost;
  const mine = state.members.find((m) => m.id === me);
  const ready = state.teams.A.players.length > 0 && state.teams.B.players.length > 0;
  const canStart = state.mode === 'umpire' ? priv.isUmpire : host || priv.captainOf?.length > 0;
  const call = async (ev, payload, fail) => {
    const r = await emit(ev, { matchId: state.id, ...payload });
    if (!r.ok) toast({ title: fail, body: r.error });
  };
  const bench = state.members.filter((m) => !m.team);
  const dot = (id) => <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${online.includes(id) ? 'bg-turf' : 'bg-pitch-500'}`} aria-label={online.includes(id) ? 'online' : 'offline'} />;
  const c = state.config;

  return (
    <div className="space-y-3">
      <section className="panel p-4 text-sm text-chalk-dim">
        <span className="font-semibold text-chalk">{state.mode === 'umpire' ? `Umpire: ${state.umpire.name}` : 'No umpire: the game runs itself'}</span>
        {`. ${c.overs} over${c.overs > 1 ? 's' : ''} a side, ${c.wickets} wicket${c.wickets > 1 ? 's' : ''}, up to ${c.playersPerTeam} a side. `}
        {c.freshSetAfterWicket ? 'A wicket ends the over. ' : 'After a wicket the over carries on. '}
        {c.noConsecutive ? 'No bowler bowls two overs in a row. ' : ''}
        {c.spectators === 'watch' ? 'Spectators watch only.' : 'Spectators can chat.'}
      </section>

      <Step n={1} title="Invite players" done={state.members.length > 1}>
        <Invite id={state.id} />
        <p className="mt-2 text-sm text-chalk-dim">{state.members.length} {state.members.length === 1 ? 'person has' : 'people have'} joined.</p>
      </Step>

      <Step n={2} title="Pick teams and captains" done={ready}>
        <div className="grid gap-3 sm:grid-cols-2">
          {['A', 'B'].map((t) => {
            const team = state.teams[t];
            const inIt = mine?.team === t;
            const full = team.players.length >= c.playersPerTeam;
            return (
              <div key={t} className="rounded-xl bg-pitch-900/60 p-3">
                <div className="flex items-baseline justify-between">
                  <h3 className="font-display text-xl font-bold">{team.name}</h3>
                  <span className="text-xs text-chalk-dim">{team.players.length}/{c.playersPerTeam}</span>
                </div>
                <ul className="mt-1 space-y-1">
                  {team.players.map((p) => (
                    <li key={p.id} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{dot(p.id)}{p.name}{p.id === me ? <span className="text-chalk-faint"> (you)</span> : ''}</span>
                      {state.captains[t] === p.id
                        ? <span className="rounded-full bg-chalk px-2 py-0.5 text-[11px] font-bold text-pitch-900">Captain</span>
                        : host && <button className="rounded px-2 py-0.5 text-xs text-chalk-dim hover:bg-pitch-600" onClick={() => call('umpire', { action: { type: 'captain', team: t, userId: p.id } }, 'Captain not changed')}>Make captain</button>}
                      {host && p.id !== me && <button className="rounded px-2 py-0.5 text-xs text-chalk-dim hover:bg-pitch-600" aria-label={`Move ${p.name} to spectators`} onClick={() => call('umpire', { action: { type: 'assign', userId: p.id, team: null } }, 'Not moved')}>✕</button>}
                    </li>
                  ))}
                  {!team.players.length && <li className="text-sm text-chalk-faint">Nobody yet. The first to join is captain.</li>}
                </ul>
                <button disabled={!inIt && full} className={`mt-3 w-full rounded-lg py-2 font-display text-lg font-bold disabled:opacity-40 ${inIt ? 'bg-pitch-600 text-chalk-dim' : 'bg-turf text-pitch-900'}`}
                  onClick={() => call('team:join', { team: inIt ? null : t }, 'Could not change team')}>
                  {inIt ? 'Leave team' : full ? `${team.name} is full` : `Join ${team.name}`}
                </button>
              </div>
            );
          })}
        </div>
        <div className="mt-3">
          <h3 className="text-sm font-semibold text-chalk-dim">Watching ({bench.length})</h3>
          {bench.length === 0 ? <p className="text-sm text-chalk-faint">Everyone who opens the link appears here.</p> : (
            <ul className="mt-1 divide-y divide-pitch-600">
              {bench.map((p) => (
                <li key={p.id} className="flex items-center gap-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-sm">{dot(p.id)}{p.name}{p.id === state.host.id ? <span className="text-chalk-faint"> ({state.mode === 'umpire' ? 'umpire' : 'host'})</span> : ''}{p.id === me ? <span className="text-chalk-faint"> (you)</span> : ''}</span>
                  {host && ['A', 'B'].map((t) => (
                    <button key={t} className="rounded bg-pitch-600 px-2.5 py-1 text-xs hover:bg-pitch-500" onClick={() => call('umpire', { action: { type: 'assign', userId: p.id, team: t } }, 'Not added')}>{state.teams[t].name}</button>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Step>

      <Step n={3} title="Captains set the lineups" done={false}>
        <p className="text-sm text-chalk-dim">Each captain sets their batting order, openers and bowling order. Only the captain can change their team's lineup.</p>
        <button className="btn-ghost mt-3 w-full" onClick={openLineups}>{priv.captainOf?.length ? 'Set your lineup' : 'See the lineups'}</button>
      </Step>

      <Step n={4} title="Start the match" done={false}>
        <span className="label">Batting first</span>
        <div className="flex gap-2">
          {['A', 'B'].map((t) => (
            <button key={t} type="button" disabled={!host} onClick={() => call('umpire', { action: { type: 'setup', tossBat: t } }, 'Not changed')} aria-pressed={state.tossBat === t}
              className={`flex-1 rounded-lg py-2 font-display text-lg font-bold disabled:cursor-default ${state.tossBat === t ? 'bg-turf text-pitch-900' : 'bg-pitch-600 text-chalk-dim'}`}>{state.teams[t].name}</button>
          ))}
        </div>
        {canStart
          ? <button type="button" className="btn-go mt-3 w-full text-xl" disabled={!ready} onClick={() => call('match:start', {}, 'Match not started')}>{ready ? 'Start match' : 'Each team needs a player'}</button>
          : <p className="mt-3 text-sm text-chalk-dim">{state.mode === 'umpire' ? `${state.umpire.name} (umpire) starts the match.` : 'The host or either captain can start the match.'}</p>}
      </Step>
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
      {isUmp ? <button className="btn-flood mt-4 w-full text-xl" onClick={next}>{label}</button> : <p className="mt-3 text-sm text-chalk-faint">The umpire starts the next innings. Captains can adjust lineups now.</p>}
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
