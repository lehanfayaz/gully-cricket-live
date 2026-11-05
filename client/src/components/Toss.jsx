// The toss: the system picks which captain calls, the coin is flipped on the server, the winner chooses bat or bowl.
import { useEffect, useRef, useState } from 'react';
import { emit } from '../api.js';
import { useApp } from '../App.jsx';

function Coin({ result, spinning }) {
  return (
    <div className={`coin mx-auto ${result ? `coin-${result}` : 'coin-idle'} ${spinning ? 'coin-spin' : ''}`} aria-hidden>
      <div className="coin-inner">
        <div className="coin-face">H</div>
        <div className="coin-face tails">T</div>
      </div>
    </div>
  );
}

export function TossPanel({ state, priv }) {
  const { toast } = useApp();
  const t = state.toss;
  const prev = useRef(t.result);
  const [spinning, setSpinning] = useState(false);
  useEffect(() => {
    if (!prev.current && t.result) { setSpinning(true); const k = setTimeout(() => setSpinning(false), 2100); prev.current = t.result; return () => clearTimeout(k); }
    prev.current = t.result;
  }, [t.result]);
  const name = (team) => state.teams[team]?.name;
  const capName = (team) => state.members.find((m) => m.id === state.captains[team])?.name || 'their captain';
  const mine = (team) => priv.captainOf?.includes(team);
  const send = async (ev, payload) => {
    const r = await emit(ev, { matchId: state.id, ...payload });
    if (!r.ok) toast({ title: 'Not done', body: r.error });
  };

  if (state.stage === 'awaiting_lineups') {
    return <p className="text-sm text-chalk-dim">The toss unlocks as soon as both captains have confirmed their lineups.</p>;
  }
  return (
    <div className="text-center">
      <Coin result={t.result} spinning={spinning} />
      {!t.call && (
        mine(t.caller) ? (
          <div className="mt-4">
            <p className="font-display text-2xl font-bold">You're calling. Heads or tails?</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <button className="btn-flood text-2xl" onClick={() => send('toss:call', { call: 'heads' })}>Heads</button>
              <button className="btn-flood text-2xl" onClick={() => send('toss:call', { call: 'tails' })}>Tails</button>
            </div>
          </div>
        ) : <p className="mt-4 text-lg"><b>{capName(t.caller)}</b> ({name(t.caller)}) is calling the toss…</p>
      )}
      {t.call && (
        <div className="mt-4" aria-live="polite">
          {spinning ? <p className="font-display text-2xl font-bold">{name(t.caller)} called {t.call}…</p> : (
            <>
              <p className="font-display text-3xl font-extrabold">It's {t.result}! <span className="text-flood">{name(t.winner)}</span> win the toss.</p>
              {!t.decision && (mine(t.winner) ? (
                <div className="mt-3">
                  <p className="text-chalk-dim">Your call, captain: bat or bowl first?</p>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <button className="btn-go text-2xl" onClick={() => send('toss:decide', { decision: 'bat' })}>🏏 Bat</button>
                    <button className="btn-go text-2xl" onClick={() => send('toss:decide', { decision: 'bowl' })}>⚾ Bowl</button>
                  </div>
                </div>
              ) : <p className="mt-2 text-chalk-dim">Waiting for {capName(t.winner)} to choose bat or bowl.</p>)}
              {t.decision && <p className="mt-2 text-lg">{name(t.winner)} chose to <b>{t.decision}</b> first. {name(state.tossBat)} bat first.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
