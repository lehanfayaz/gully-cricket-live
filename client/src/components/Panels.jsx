// Match setup (lobby), innings breaks and results.
import { Link } from 'react-router-dom';
import { emit, matchLink } from '../api.js';
import { useApp } from '../App.jsx';
import { TossPanel } from './Toss.jsx';
import TeamBadge from './TeamBadge.jsx';

export const teamIdentity = (state, t) => state.teamMeta?.[t] || { name: state.teams[t].name, short: state.teams[t].name.slice(0, 3).toUpperCase(), color: t === 'A' ? '#2FD67B' : '#FFD23F' };

// One-v-one: two seats, each a person or the AI.
function Seats({ state, me, priv, call }) {
  const mine = state.members.find((m) => m.id === me);
  const playing = state.members.some((m) => m.id === me && (m.kind === 'controller' || (m.team && state.participation !== 'team')));
  const umpire = state.mode === 'umpire' && state.host.id === me;
  return (
    <div className="grid grid-cols-2 gap-3">
      {['A', 'B'].map((t) => {
        const id = teamIdentity(state, t);
        const who = state.teamSource === 'real' ? state.teams[t].controller : state.teams[t].players[0];
        const open = !who;
        return (
          <div key={t} className="rounded-xl bg-pitch-900/60 p-3 text-center">
            <TeamBadge team={id} size={48} className="mx-auto" />
            <div className="mt-1 truncate font-display text-xl font-bold">{state.teams[t].name}</div>
            {open ? (
              !playing && !umpire && !state.toss.result
                ? <button className="btn-go mt-2 w-full py-2" onClick={() => call('team:join', { team: t }, 'Could not join')}>Play as {state.teams[t].name}</button>
                : <p className="mt-1 text-sm text-chalk-dim">Waiting for a player. Share the link.</p>
            ) : (
              <p className="mt-1 text-sm text-chalk-dim">{who.bot ? `🤖 ${who.name}` : who.id === me ? 'You' : who.name}</p>
            )}
          </div>
        );
      })}
    </div>
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

// Where the match is: lineups → toss → start → live.
export function stageLabel(state) {
  const t = (k) => state.teams[k].name;
  switch (state.stage) {
    case 'awaiting_lineups': {
      const pending = ['A', 'B'].filter((k) => !state.lineups[k].confirmedAt);
      return pending.length === 2 ? 'Awaiting both teams’ confirmation' : `Awaiting ${t(pending[0])} confirmation`;
    }
    case 'toss_call': return 'Both teams confirmed. Ready for toss';
    case 'toss_decision': return `Toss completed. ${t(state.toss.winner)} to choose`;
    case 'ready_to_start': return 'Ready to start';
    case 'live': return 'Match live';
    case 'resumed': return 'Resumed';
    case 'session_break': return 'Session completed';
    case 'day_break': return 'Day completed';
    case 'suspended': return 'Suspended';
    case 'innings_break': return 'Innings break';
    default: return 'Match finished';
  }
}

export function StageTracker({ state }) {
  const order = ['awaiting_lineups', 'toss_call', 'ready_to_start', 'live'];
  const at = state.stage === 'toss_decision' ? 1.5 : Math.max(0, order.indexOf(state.stage));
  const steps = [['Lineups confirmed', 1], ['Toss', 2], ['Ready to start', 2.5], ['Live', 3]];
  return (
    <section className="panel p-4" aria-label="Match status">
      <div className="font-display text-2xl font-extrabold text-flood">{stageLabel(state)}</div>
      <ol className="mt-3 grid grid-cols-4 gap-1.5">
        {steps.map(([label, need]) => (
          <li key={label} className={`border-t-4 pt-1 text-xs font-semibold ${at >= need ? 'border-turf text-chalk' : at >= need - 1 ? 'border-flood text-chalk' : 'border-pitch-600 text-chalk-faint'}`}>{label}</li>
        ))}
      </ol>
    </section>
  );
}

export function Lobby({ state, me, priv, online, openLineups }) {
  const { toast } = useApp();
  const host = priv.isHost;
  const mine = state.members.find((m) => m.id === me);
  const tossed = !!state.toss.result;
  const call = async (ev, payload, fail) => {
    const r = await emit(ev, { matchId: state.id, ...payload });
    if (!r.ok) toast({ title: fail, body: r.error });
  };
  const bench = state.members.filter((m) => !m.team);
  const people = state.members.filter((m) => !m.ghost && !m.bot).length;
  const dot = (id) => <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${online.includes(id) ? 'bg-turf' : 'bg-pitch-500'}`} aria-label={online.includes(id) ? 'online' : 'offline'} />;
  const c = state.config;
  const both = !!(state.lineups.A.confirmedAt && state.lineups.B.confirmedAt);
  const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="space-y-3">
      <StageTracker state={state} />
      <section className="panel p-4 text-sm text-chalk-dim">
        <span className="font-semibold text-chalk">{{ t20: 'T20. ', odi: 'ODI. ', custom: '', test: 'Test match. ' }[state.format] || ''}{state.play === 'ball' ? 'Ball by ball' : 'Complete over'}</span>
        {state.play === 'ball' ? ': bowler and batter pick one number per ball. ' : ': bowler and batter lock in the rest of the over at once. '}
        <span className="font-semibold text-chalk">{state.mode === 'umpire' ? `Umpire: ${state.umpire.name}.` : 'No umpire.'}</span>
        {state.format === 'test'
          ? ` ${c.days} day${c.days > 1 ? 's' : ''}, ${c.sessionsPerDay} session${c.sessionsPerDay > 1 ? 's' : ''} a day of ${c.oversPerSession} overs, ${c.inningsPerTeam} innings each, ${c.wickets} wickets an innings. `
          : ` ${c.overs} over${c.overs > 1 ? 's' : ''} a side, ${c.wickets} wicket${c.wickets > 1 ? 's' : ''}, up to ${c.playersPerTeam} a side. `}
        {c.noConsecutive ? 'No bowler bowls two overs in a row. ' : ''}
        {c.spectators === 'watch' ? 'Spectators watch only.' : 'Spectators can chat.'}
      </section>

      <Step n={1} title="Invite players" done={people > 1}>
        <Invite id={state.id} />
        <p className="mt-2 text-sm text-chalk-dim">{people} {people === 1 ? 'person has' : 'people have'} joined.</p>
      </Step>

      {state.participation !== 'team' ? (
        <Step n={2} title="Players" done={!!(state.teamSource === 'real' ? state.teams.A.controller && state.teams.B.controller : state.teams.A.players.length && state.teams.B.players.length)}>
          <Seats state={state} me={me} priv={priv} call={call} />
        </Step>
      ) : <Step n={2} title="Pick teams and captains" done={state.teams.A.players.length > 0 && state.teams.B.players.length > 0}>
        {tossed && <p className="mb-2 text-sm text-flood">Squads are locked now the toss is done.</p>}
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
                        : host && !tossed && <button className="rounded px-2 py-0.5 text-xs text-chalk-dim hover:bg-pitch-600" onClick={() => call('umpire', { action: { type: 'captain', team: t, userId: p.id } }, 'Captain not changed')}>Make captain</button>}
                      {host && !tossed && p.id !== me && <button className="rounded px-2 py-0.5 text-xs text-chalk-dim hover:bg-pitch-600" aria-label={`Move ${p.name} to spectators`} onClick={() => call('umpire', { action: { type: 'assign', userId: p.id, team: null } }, 'Not moved')}>✕</button>}
                    </li>
                  ))}
                  {!team.players.length && <li className="text-sm text-chalk-faint">Nobody yet. The first to join is captain.</li>}
                </ul>
                {!tossed && (
                  <button disabled={!inIt && full} className={`mt-3 w-full rounded-lg py-2 font-display text-lg font-bold disabled:opacity-40 ${inIt ? 'bg-pitch-600 text-chalk-dim' : 'bg-turf text-pitch-900'}`}
                    onClick={() => call('team:join', { team: inIt ? null : t }, 'Could not change team')}>
                    {inIt ? 'Leave team' : full ? `${team.name} is full` : `Join ${team.name}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {!tossed && (
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
        )}
      </Step>}

      <Step n={3} title={state.participation === 'team' ? 'Captains confirm lineups' : 'Confirm lineups'} done={both}>
        <table className="w-full text-sm">
          <thead className="text-left text-chalk-dim"><tr><th className="pb-1 font-medium">Team</th><th className="pb-1 font-medium">Captain</th><th className="pb-1 text-right font-medium">Lineup</th></tr></thead>
          <tbody>
            {['A', 'B'].map((t) => {
              const at = state.lineups[t].confirmedAt;
              const cap = state.members.find((m) => m.id === state.captains[t]);
              return (
                <tr key={t} className="border-t border-pitch-600">
                  <td className="py-2 font-semibold"><span className="flex items-center gap-2"><TeamBadge team={teamIdentity(state, t)} size={22} />{state.teams[t].name}</span></td>
                  <td className="py-2">{cap ? (cap.bot ? `🤖 ${cap.name}` : cap.name) : <span className="text-chalk-faint">none yet</span>}</td>
                  <td className="py-2 text-right">
                    {at ? <span className="rounded-full bg-turf px-2.5 py-0.5 text-xs font-bold text-pitch-900">Confirmed {time(at)}</span>
                      : <span className="rounded-full bg-pitch-600 px-2.5 py-0.5 text-xs font-bold text-chalk-dim">Pending</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {priv.captainOf?.map((t) => !state.lineups[t].confirmedAt && !tossed && (
          <div key={t} className="mt-3 rounded-xl bg-pitch-900/60 p-3">
            <p className="text-sm">{state.teamSource === 'real' ? `You're playing as ${state.teams[t].name}. Pick your XI and batting order, then confirm.` : state.participation === 'team' ? `You're ${state.teams[t].name}'s captain. Check the batting and bowling order, then confirm.` : 'Ready? Confirm to unlock the toss.'}</p>
            <div className="mt-2 flex gap-2">
              <button className="btn-ghost flex-1" onClick={openLineups}>Review lineup</button>
              <button className="btn-go flex-1" disabled={!state.teams[t].players.length} onClick={() => call('lineup:confirm', { team: t }, 'Lineup not confirmed')}>Confirm lineup</button>
            </div>
          </div>
        ))}
        {!priv.captainOf?.length && <button className="btn-ghost mt-3 w-full" onClick={openLineups}>See the lineups</button>}
        {!tossed && <p className="mt-2 text-xs text-chalk-faint">Changing a confirmed lineup before the toss means confirming it again.</p>}
      </Step>

      <Step n={4} title="Toss" done={!!state.toss.decision}>
        <TossPanel state={state} priv={priv} />
      </Step>

      {state.mode === 'umpire' && (
        <Step n={5} title="Start the match" done={false}>
          {state.stage !== 'ready_to_start' ? <p className="text-sm text-chalk-dim">The umpire can start once the toss is done.</p>
            : priv.isUmpire ? <button type="button" className="btn-go w-full text-xl" onClick={() => call('match:start', {}, 'Match not started')}>Start match</button>
              : <p className="text-sm text-chalk-dim">Waiting for {state.umpire.name} (umpire) to start the match.</p>}
        </Step>
      )}
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
