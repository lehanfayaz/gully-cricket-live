// Umpire control panel: flow, corrections with audit trail, disputes, results and moderation.
import { useState } from 'react';
import { emit } from '../api.js';
import { useApp } from '../App.jsx';
import { Teams } from './Panels.jsx';

const ACTION_LABELS = {
  start: 'Started the match', next_innings: 'Started the next innings', assign: 'Changed a team', batting_order: 'Changed the batting order',
  setup: 'Changed match settings', pause: 'Paused play', resume: 'Resumed play', bowler: 'Changed the bowler', striker: 'Changed the batter',
  void_ball: 'Voided a ball', adjust_runs: 'Adjusted runs', unseal: 'Opened a sealed over', end_match: 'Ended the match',
  mute: 'Muted someone', unmute: 'Unmuted someone', kick: 'Removed someone', delete_message: 'Removed a message',
};

export default function UmpirePanel({ state, priv, me, online }) {
  const { toast } = useApp();
  const [reason, setReason] = useState('');
  const [adjust, setAdjust] = useState(1);
  const [outcome, setOutcome] = useState('A');
  const [armed, setArmed] = useState(null);
  const cur = state.current;
  const inn = state.innings[state.innings.length - 1];
  const finished = state.status === 'completed' || state.status === 'abandoned';
  const between = cur && state.status === 'live' && !cur.open;

  const act = async (action, ok) => {
    const r = await emit('umpire', { matchId: state.id, action });
    if (!r.ok) toast({ title: 'Not done', body: r.error });
    else { setArmed(null); if (ok) toast({ title: ok, ms: 2500 }); }
  };
  const needReason = (fn) => { if (!reason.trim()) { toast({ title: 'Add a reason first', body: 'Corrections and disputes are recorded with a reason everyone can see.', ms: 3500 }); return; } fn(); setReason(''); };
  const confirmThen = (key, fn) => (armed === key ? fn() : setArmed(key));

  const bowlers = inn ? state.teams[inn.bowling].players : [];
  const batters = inn ? state.teams[inn.batting].players : [];

  return (
    <div className="space-y-3">
      {!finished && state.status !== 'lobby' && (
        <section className="panel space-y-3 p-4">
          <h2 className="font-display text-2xl font-bold">Match control</h2>
          <div className="flex flex-wrap gap-2">
            {state.paused
              ? <button className="btn-go" onClick={() => act({ type: 'resume' })}>Resume play</button>
              : <button className="btn-ghost" onClick={() => act({ type: 'pause' })}>Pause play</button>}
          </div>
          {cur && state.status === 'live' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="bw">Bowler for the next over</label>
                <select id="bw" className="field" value={cur.bowlerId || ''} disabled={!between} onChange={(e) => act({ type: 'bowler', userId: e.target.value })}>
                  {bowlers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="st">Batter on strike</label>
                <select id="st" className="field" value={cur.strikerId || ''} disabled={!between} onChange={(e) => act({ type: 'striker', userId: e.target.value })}>
                  {batters.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              {!between && <p className="text-xs text-chalk-faint sm:col-span-2">You can change the bowler or batter between overs.</p>}
            </div>
          )}
        </section>
      )}

      {!finished && inn && (
        <section className="panel space-y-3 p-4">
          <h2 className="font-display text-2xl font-bold">Corrections and disputes</h2>
          <p className="text-sm text-chalk-dim">Every change is announced in the stadium chat and kept in the audit trail below.</p>
          <div>
            <label className="label" htmlFor="rs">Reason</label>
            <input id="rs" className="field" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={140} placeholder="e.g. Ali tapped the wrong number" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <button className="btn-ghost" onClick={() => needReason(() => act({ type: 'void', reason }, 'Last ball voided'))}>Void the last ball</button>
            <div className="flex gap-2">
              <input type="number" aria-label="Runs to add or remove" className="field w-24" value={adjust} min={-50} max={50} onChange={(e) => setAdjust(e.target.value)} />
              <button className="btn-ghost flex-1" onClick={() => needReason(() => act({ type: 'adjust', runs: Number(adjust), reason }, 'Runs adjusted'))}>Adjust runs</button>
            </div>
          </div>
          {cur?.open && (
            <div className="rounded-lg bg-pitch-900/60 p-3">
              {priv.unsealedSequence ? (
                <>
                  <div className="text-sm text-chalk-dim">Sealed sequence for this over (opened for review)</div>
                  <div className="mt-1 font-display text-3xl font-extrabold tracking-[0.3em] text-flood">{priv.unsealedSequence.join(' ')}</div>
                </>
              ) : (
                <>
                  <p className="text-sm text-chalk-dim">The current over is sealed. Open it only to settle a dispute; everyone will be told.</p>
                  <button className="btn-ghost mt-2" onClick={() => needReason(() => act({ type: 'unseal', reason }))}>Open sealed over</button>
                </>
              )}
            </div>
          )}
        </section>
      )}

      {!finished && state.status !== 'lobby' && (
        <section className="panel space-y-3 p-4">
          <h2 className="font-display text-2xl font-bold">End the match early</h2>
          <div className="flex gap-2">
            <select aria-label="Result" className="field" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="A">{state.teams.A.name} win</option>
              <option value="B">{state.teams.B.name} win</option>
              <option value="tie">Declare a tie</option>
              <option value="abandon">Abandon (no result)</option>
            </select>
            <button className="btn-danger shrink-0" onClick={() => confirmThen('end', () => act({ type: 'end', outcome, reason }))}>{armed === 'end' ? 'Tap to confirm' : 'End match'}</button>
          </div>
          <p className="text-xs text-chalk-faint">Uses the reason above, if you've typed one. Matches that finish normally are decided automatically.</p>
        </section>
      )}

      <Teams state={state} me={me} isUmp online={online} />

      <section className="panel p-4">
        <h2 className="font-display text-2xl font-bold">Audit trail</h2>
        {!priv.audit?.length ? <p className="text-sm text-chalk-dim">Umpire actions will be listed here.</p> : (
          <ol className="mt-2 space-y-1 text-sm">
            {priv.audit.map((a) => (
              <li key={a.id} className="flex gap-3">
                <time className="w-12 shrink-0 tabular-nums text-chalk-faint">{new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                <span>{ACTION_LABELS[a.action] || a.action}{a.detail?.reason ? `: ${a.detail.reason}` : ''}{a.detail?.delta ? ` (${a.detail.delta > 0 ? '+' : ''}${a.detail.delta})` : ''}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
