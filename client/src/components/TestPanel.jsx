// Test match dashboard: day and session, progress, scoring requirements, breaks, suspend/resume, declarations, follow-on.
import { useEffect, useState } from 'react';
import { emit, oversText } from '../api.js';
import { useApp } from '../App.jsx';

export const STATUS_CHIP = {
  live: ['Live', 'bg-leather text-chalk'],
  resumed: ['Resumed', 'bg-turf text-pitch-900'],
  session_break: ['Session completed', 'bg-flood text-pitch-900'],
  day_break: ['Day completed', 'bg-flood text-pitch-900'],
  suspended: ['Suspended', 'bg-chalk text-pitch-900'],
  innings_break: ['Innings break', 'bg-pitch-500 text-chalk'],
  completed: ['Match completed', 'bg-pitch-500 text-chalk'],
  abandoned: ['Abandoned', 'bg-pitch-500 text-chalk'],
};

export function StatusChip({ state }) {
  const [label, tone] = STATUS_CHIP[state.stage] || STATUS_CHIP[state.status] || ['', ''];
  if (!label) return null;
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${tone}`}>{label}</span>;
}

function useClock(active) {
  const [t, setT] = useState(Date.now());
  useEffect(() => { if (!active) return; const k = setInterval(() => setT(Date.now()), 1000); return () => clearInterval(k); }, [active]);
  return t;
}

export function RequirementBanner({ state, me }) {
  const reqs = state.test?.requirements || [];
  if (!reqs.length) return null;
  return reqs.map((r) => (
    <div key={r.id} role="status" className={`rounded-xl px-4 py-3 text-sm font-semibold ${r.status === 'pending' ? 'bg-leather text-chalk' : 'bg-flood text-pitch-900'}`}>
      {r.status === 'pending'
        ? <>Dot-over rule broken by {r.name}. Play is held until the umpire rules.</>
        : <>Scoring requirement: {r.batterId === me ? 'you' : r.name} must score within the next {r.ballsLeft} legal ball{r.ballsLeft === 1 ? '' : 's'}{r.startsNextOver ? ' (from the start of the next over)' : ''}.</>}
    </div>
  ));
}

export function TestDashboard({ state, priv, me }) {
  const { toast } = useApp();
  const t = state.test;
  const [reason, setReason] = useState('');
  const now = useClock(!!t.sessionMinutes && state.status === 'live');
  const act = async (action, ok) => {
    const r = await emit('test', { matchId: state.id, action });
    if (!r.ok) toast({ title: 'Not done', body: r.error });
    else if (ok) toast({ title: ok, ms: 2500 });
  };
  const inn = state.innings[state.innings.length - 1];
  const capOf = priv.captainOf || [];
  const admin = state.mode === 'umpire' ? priv.isUmpire : priv.isHost;
  const canRestart = admin || (state.mode === 'auto' && capOf.length > 0);
  const quota = t.oversPerSession * 6;
  const pct = Math.min(100, (t.sessionBalls / quota) * 100);
  const elapsed = t.sessionStartedAt ? Math.floor((now - t.sessionStartedAt) / 60000) : 0;
  const live = state.status === 'live';
  const pendingRule = t.requirements.find((r) => r.status === 'pending');

  return (
    <section className="panel space-y-3 p-4" aria-label="Test match">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-2xl font-extrabold">Day {t.day} of {t.days}, session {t.session} of {t.sessionsPerDay}</h2>
        <StatusChip state={state} />
      </div>
      {['live', 'resumed', 'innings_break'].includes(state.stage) || state.status === 'live' ? (
        <div>
          <div className="flex justify-between text-sm text-chalk-dim">
            <span>Session: {oversText(t.sessionBalls)} of {t.oversPerSession} overs</span>
            <span>{oversText(t.sessionBallsLeft)} overs left</span>
          </div>
          <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-pitch-900" role="progressbar" aria-valuenow={t.sessionBalls} aria-valuemax={quota}>
            <div className="h-full rounded-full bg-turf transition-all" style={{ width: `${pct}%` }} />
          </div>
          {t.sessionMinutes > 0 && live && (
            <p className={`mt-1 text-xs ${elapsed >= t.sessionMinutes ? 'font-semibold text-leather' : 'text-chalk-faint'}`}>
              {elapsed >= t.sessionMinutes ? `Session time is up (${t.sessionMinutes} min). The ${state.mode === 'umpire' ? 'umpire' : 'host'} can end the session.` : `${t.sessionMinutes - elapsed} min left in the session time limit.`}
            </p>
          )}
        </div>
      ) : null}
      {t.situation && <p className="font-semibold">{t.situation}{inn ? `. ${inn.battingName} ${inn.runs}/${inn.wickets} in this innings.` : ''}</p>}
      <RequirementBanner state={state} me={me} />

      {pendingRule && priv.isUmpire && (
        <div className="grid grid-cols-2 gap-2">
          <button className="btn-danger" onClick={() => act({ type: 'rule', decision: 'out' })}>Give {pendingRule.name} out</button>
          <button className="btn-ghost" onClick={() => act({ type: 'rule', decision: 'waive' })}>Waive and play on</button>
        </div>
      )}

      {t.followOn && (
        <div className="rounded-xl bg-pitch-900/60 p-3">
          <p className="font-semibold">{state.teams[t.followOn.team].name} lead by {t.followOn.lead} (follow-on margin {t.followOnMargin}).</p>
          {capOf.includes(t.followOn.team) || priv.isUmpire ? (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button className="btn-flood" onClick={() => act({ type: 'follow_on', enforce: true })}>Enforce follow-on</button>
              <button className="btn-ghost" onClick={() => act({ type: 'follow_on', enforce: false })}>Bat again ourselves</button>
            </div>
          ) : <p className="text-sm text-chalk-dim">Waiting for their captain to decide.</p>}
        </div>
      )}

      {(state.status === 'session_break' || state.status === 'day_break') && (
        <div className="rounded-xl bg-pitch-900/60 p-3">
          <p className="font-semibold">{state.status === 'day_break' ? `End of day ${t.day}. Day ${t.day + 1} starts with session 1.` : `Break. Session ${t.session + 1} is next.`}</p>
          <p className="text-sm text-chalk-dim">Everything is saved, including the over in progress and any scoring requirement.</p>
          {canRestart && <button className="btn-go mt-2 w-full" onClick={() => act({ type: 'next_session' })}>Start {state.status === 'day_break' ? `day ${t.day + 1}` : `session ${t.session + 1}`}</button>}
        </div>
      )}

      {state.status === 'suspended' && (
        <div className="rounded-xl bg-pitch-900/60 p-3">
          <p className="font-semibold">Match suspended and saved.</p>
          <p className="text-sm text-chalk-dim">Same link, same score, same lineups. It carries on from the next ball when it's resumed.</p>
          {priv.isHost && <button className="btn-go mt-2 w-full" onClick={() => act({ type: 'resume' })}>Continue match</button>}
        </div>
      )}

      {t.breakRequest && live && (
        <div className="rounded-xl bg-pitch-900/60 p-3 text-sm">
          <p className="font-semibold">{state.teams[t.breakRequest].name}'s captain has asked for a session break.</p>
          {admin && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button className="btn-flood py-2" onClick={() => act({ type: 'end_session', requested: true })}>Approve break</button>
              <button className="btn-ghost py-2" onClick={() => act({ type: 'decline_break' })}>Play on</button>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {live && inn && capOf.includes(inn.batting) && !state.current?.open && (
          <button className="btn-ghost py-2 text-base" onClick={() => act({ type: 'declare' }, 'Declared')}>Declare</button>
        )}
        {live && capOf.length > 0 && !admin && !t.breakRequest && (
          <button className="btn-ghost py-2 text-base" onClick={() => act({ type: 'request_break' }, 'Break requested')}>Ask for a session break</button>
        )}
        {live && admin && <button className="btn-ghost py-2 text-base" onClick={() => act({ type: 'end_session' })}>End session now</button>}
      </div>

      {priv.isHost && ['live', 'session_break', 'day_break', 'innings_break'].includes(state.status) && (
        <details className="rounded-xl bg-pitch-900/50 p-3">
          <summary className="cursor-pointer font-semibold">End session and save for later</summary>
          <p className="mt-2 text-sm text-chalk-dim">Suspends the match exactly where it is. Nothing moves on until you continue it.</p>
          <div className="mt-2 flex gap-2">
            <input className="field py-2" aria-label="Reason (optional)" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={140} />
            <button className="btn-flood shrink-0 py-2" onClick={() => act({ type: 'suspend', reason }, 'Match suspended')}>Suspend</button>
          </div>
        </details>
      )}
    </section>
  );
}

export function SessionHistory({ state }) {
  const t = state.test;
  if (!t?.sessions.length) return null;
  const label = (s) => s.endReason === 'overs' || !s.endReason ? '' : s.endReason === 'manual' ? 'ended early' : s.endReason === 'requested' ? 'break requested' : 'match over';
  return (
    <div className="space-y-3">
      <section className="panel p-4">
        <h3 className="font-display text-xl font-bold">Days</h3>
        <ul className="mt-1 divide-y divide-pitch-600 text-sm">
          {t.daySummaries.map((d) => (
            <li key={d.day} className="flex justify-between py-1.5"><span>Day {d.day}</span><span className="tabular-nums">{d.runs} runs, {d.wickets} wkts, {oversText(d.balls)} ov</span></li>
          ))}
        </ul>
      </section>
      <section className="panel p-4">
        <h3 className="font-display text-xl font-bold">Sessions</h3>
        <ol className="mt-1 space-y-1">
          {[...t.sessions].reverse().map((s) => (
            <li key={s.idx}>
              <details className="rounded-lg bg-pitch-900/50 px-3 py-2">
                <summary className="flex cursor-pointer flex-wrap justify-between gap-2 text-sm">
                  <span className="font-semibold">Day {s.day}, session {s.num}{!s.endedAt ? ' (in progress)' : label(s) ? ` (${label(s)})` : ''}</span>
                  <span className="tabular-nums text-chalk-dim">{s.runs} runs, {s.wickets} wkts, {oversText(s.balls)} ov</span>
                </summary>
                <div className="mt-2 space-y-2 text-sm">
                  {s.innings.map((i) => <p key={i.number}>{i.battingName} batting, {i.bowlingName} bowling: {i.runs}/{i.wickets} in {oversText(i.balls)} ov</p>)}
                  {s.batters.length > 0 && <p className="text-chalk-dim">Batting: {s.batters.map((b) => `${b.name} ${b.runs} (${b.balls})${b.outs ? ' out' : ''}`).join(', ')}</p>}
                  {s.bowlers.length > 0 && <p className="text-chalk-dim">Bowling: {s.bowlers.map((b) => `${b.name} ${oversText(b.balls)}-${b.runs}-${b.wickets}`).join(', ')}</p>}
                  {!s.balls && <p className="text-chalk-faint">No balls bowled.</p>}
                </div>
              </details>
            </li>
          ))}
        </ol>
      </section>
      {t.suspensions.length > 0 && (
        <section className="panel p-4">
          <h3 className="font-display text-xl font-bold">Suspensions</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {t.suspensions.map((x, i) => (
              <li key={i}>Day {x.day}, session {x.session}: suspended by {x.by} at {new Date(x.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}{x.reason ? ` (${x.reason})` : ''}{x.resumedAt ? `, resumed by ${x.resumedBy} at ${new Date(x.resumedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : ', not resumed yet'}.</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
