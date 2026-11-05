// Umpire panel (with-umpire matches) or host panel (no-umpire matches).
import { useState } from 'react';
import { emit } from '../api.js';
import { useApp } from '../App.jsx';
import { NUM_COLORS } from './OverPanel.jsx';

export default function UmpirePanel({ state, priv }) {
  const { toast } = useApp();
  const [reason, setReason] = useState('');
  const [adjust, setAdjust] = useState(1);
  const [outcome, setOutcome] = useState('A');
  const [armed, setArmed] = useState(false);
  const cur = state.current;
  const ump = priv.isUmpire;
  const finished = state.status === 'completed' || state.status === 'abandoned';
  const act = async (action, ok) => {
    const r = await emit('umpire', { matchId: state.id, action });
    if (!r.ok) toast({ title: 'Not done', body: r.error });
    else { setArmed(false); if (ok) toast({ title: ok, ms: 2500 }); }
  };
  const needReason = (fn) => { if (!reason.trim()) { toast({ title: 'Add a reason first', body: 'Corrections are announced to everyone with the reason.', ms: 3500 }); return; } fn(); setReason(''); };

  if (finished) return <section className="panel p-4 text-chalk-dim">The match is over. The full record is in the Lineups and Scorecard tabs.</section>;

  return (
    <div className="space-y-3">
      {!ump && (
        <section className="panel p-4">
          <h2 className="font-display text-2xl font-bold">You're hosting</h2>
          <p className="mt-1 text-sm text-chalk-dim">There's no umpire in this match, so overs, wickets, innings changes and the result all happen automatically. Captains run their own lineups. You can still moderate chat and end the match early if people have to leave.</p>
        </section>
      )}

      {ump && cur && state.status === 'live' && (
        <section className="panel space-y-3 p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-2xl font-bold">This over</h2>
            {state.paused
              ? <button className="btn-go py-2" onClick={() => act({ type: 'resume' })}>Resume play</button>
              : <button className="btn-ghost py-2" onClick={() => act({ type: 'pause' })}>Pause play</button>}
          </div>
          <p className="text-sm text-chalk-dim">{cur.bowlerName} bowling to {cur.strikerName}.</p>
          {priv.bowlerSequence ? (
            <div>
              <div className="mb-1 text-sm text-chalk-dim">Bowler's {priv.bowlerSequence.length === 1 ? 'number' : 'numbers'} (only you can see this; the batter's stay hidden until the reveal)</div>
              <div className="grid grid-cols-6 gap-2">
                {priv.bowlerSequence.map((n, i) => <div key={i} className={`grid aspect-square place-items-center rounded-xl font-display text-2xl font-extrabold ${NUM_COLORS[n]}`}>{n}</div>)}
              </div>
            </div>
          ) : <p className="rounded-lg bg-pitch-900/60 p-3 text-sm text-chalk-dim">{cur.set?.status === 'open' && cur.set.bowlerLocked ? "You're batting, so the bowler's numbers stay hidden from you too." : "The bowler's numbers will appear here when they lock in."}</p>}
        </section>
      )}

      {ump && state.innings.length > 0 && (
        <section className="panel space-y-3 p-4">
          <h2 className="font-display text-2xl font-bold">Corrections</h2>
          <div>
            <label className="label" htmlFor="rs">Reason (shown to everyone)</label>
            <input id="rs" className="field" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={140} placeholder="e.g. Ali's phone submitted by mistake" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <button className="btn-ghost" onClick={() => needReason(() => act({ type: 'void', reason }, 'Last over voided'))}>Void the last reveal</button>
            <div className="flex gap-2">
              <input type="number" aria-label="Runs to add or remove" className="field w-24" value={adjust} min={-50} max={50} onChange={(e) => setAdjust(e.target.value)} />
              <button className="btn-ghost flex-1" onClick={() => needReason(() => act({ type: 'adjust', runs: Number(adjust), reason }, 'Runs adjusted'))}>Adjust runs</button>
            </div>
          </div>
          <p className="text-xs text-chalk-faint">Voiding cancels the last revealed submission (the last ball in ball-by-ball matches); both players lock in again.</p>
        </section>
      )}

      {state.status !== 'lobby' && (
        <section className="panel space-y-3 p-4">
          <h2 className="font-display text-2xl font-bold">End the match early</h2>
          <div className="flex gap-2">
            <select aria-label="Result" className="field" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="A">{state.teams.A.name} win</option>
              <option value="B">{state.teams.B.name} win</option>
              <option value="tie">Declare a tie</option>
              {state.format === 'test' && <option value="draw">Declare a draw</option>}
              <option value="abandon">Abandon (no result)</option>
            </select>
            <button className="btn-danger shrink-0" onClick={() => (armed ? act({ type: 'end', outcome, reason }) : setArmed(true))}>{armed ? 'Tap to confirm' : 'End match'}</button>
          </div>
          <p className="text-xs text-chalk-faint">Matches that finish normally are decided automatically.</p>
        </section>
      )}
    </div>
  );
}
