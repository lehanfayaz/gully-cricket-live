// Team lineups: the captain's batting and bowling orders, kept separate from the scoreboard.
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { emit } from '../api.js';
import { useApp } from '../App.jsx';

// Drag (mouse or touch) by the handle to reorder. Arrow buttons do the same for keyboards.
function SortableList({ items, keyOf, render, onCommit, enabled }) {
  const [drag, setDrag] = useState(null); // { from, to, dy }
  const refs = useRef([]);
  const start = (e, i) => {
    if (!enabled) return;
    e.preventDefault();
    const h = refs.current[i]?.getBoundingClientRect().height || 56;
    const y0 = e.clientY;
    let to = i;
    setDrag({ from: i, to: i, dy: 0 });
    const move = (ev) => {
      const dy = ev.clientY - y0;
      to = Math.max(0, Math.min(items.length - 1, i + Math.round(dy / (h + 6))));
      setDrag({ from: i, to, dy });
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      setDrag(null);
      if (to !== i) { const next = [...items]; const [x] = next.splice(i, 1); next.splice(to, 0, x); onCommit(next); }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  const nudge = (i, d) => { const j = i + d; if (j < 0 || j >= items.length) return; const next = [...items]; [next[i], next[j]] = [next[j], next[i]]; onCommit(next); };
  return (
    <ol className="space-y-1.5">
      {items.map((it, i) => {
        let shift = 0;
        if (drag) {
          const h = (refs.current[drag.from]?.getBoundingClientRect().height || 56) + 6;
          if (i === drag.from) shift = drag.dy;
          else if (drag.from < drag.to && i > drag.from && i <= drag.to) shift = -h;
          else if (drag.from > drag.to && i < drag.from && i >= drag.to) shift = h;
        }
        return (
          <li key={keyOf(it)} ref={(el) => (refs.current[i] = el)}
            style={{ transform: shift ? `translateY(${shift}px)` : undefined, transition: drag && i === drag.from ? 'none' : 'transform .15s' }}
            className={`flex items-center gap-2 rounded-xl bg-pitch-900/60 px-2 py-2 ${drag?.from === i ? 'relative z-10 shadow-2xl ring-2 ring-flood' : ''}`}>
            {enabled && (
              <span onPointerDown={(e) => start(e, i)} className="cursor-grab touch-none select-none px-1.5 text-xl leading-none text-chalk-faint active:cursor-grabbing" aria-hidden>⠿</span>
            )}
            <span className="w-6 shrink-0 text-center font-display text-lg font-bold text-chalk-faint">{i + 1}</span>
            <div className="min-w-0 flex-1">{render(it, i)}</div>
            {enabled && (
              <span className="flex shrink-0 flex-col">
                <button type="button" className="px-1.5 text-xs leading-4 text-chalk-dim disabled:opacity-20" disabled={i === 0} onClick={() => nudge(i, -1)} aria-label="Move up">▲</button>
                <button type="button" className="px-1.5 text-xs leading-4 text-chalk-dim disabled:opacity-20" disabled={i === items.length - 1} onClick={() => nudge(i, 1)} aria-label="Move down">▼</button>
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

const Tag = ({ tone = 'muted', children }) => {
  const tones = { live: 'bg-turf text-pitch-900', out: 'bg-leather text-chalk', next: 'bg-flood text-pitch-900', muted: 'bg-pitch-600 text-chalk-dim', cap: 'bg-chalk text-pitch-900' };
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${tones[tone]}`}>{children}</span>;
};

export function TeamLineup({ state, team, priv, me }) {
  const { toast } = useApp();
  const t = state.teams[team];
  const isCaptain = priv.captainOf?.includes(team);
  const finished = state.status === 'completed' || state.status === 'abandoned';
  const can = isCaptain && !finished;
  const cur = state.current;
  const live = state.status === 'live' && cur;
  const inn = state.innings[state.innings.length - 1];
  const batting = live && inn?.batting === team;
  const bowling = live && inn?.bowling === team;
  const card = (kind) => {
    // This team's figures across the match.
    const map = new Map();
    for (const i of state.innings) for (const r of i.card[kind]) if ((kind === 'batting' ? i.batting : i.bowling) === team) {
      const x = map.get(r.id) || { runs: 0, balls: 0, outs: 0, wickets: 0, overs: 0 };
      x.runs += r.runs; x.balls += r.balls; x.outs += r.outs || 0; x.wickets += r.wickets || 0; x.overs += r.overs || 0; map.set(r.id, x);
    }
    return map;
  };
  const bat = card('batting'), bowl = card('bowling');
  const act = async (action) => {
    const r = await emit('captain', { matchId: state.id, action: { team, ...action } });
    if (!r.ok) toast({ title: 'Lineup not changed', body: r.error });
  };
  const dismissed = batting ? cur.dismissed || {} : {};
  const order = t.players;
  const nextUp = batting ? order.filter((p) => p.id !== cur.strikerId).sort((a, b) => (dismissed[a.id] || 0) - (dismissed[b.id] || 0) || a.ord - b.ord)[0] : null;
  const bowlers = [...t.players].filter((p) => p.bowls).sort((a, b) => a.bowlOrd - b.bowlOrd);
  const benchBowlers = t.players.filter((p) => !p.bowls);
  const bench = state.members.filter((m) => !m.team);
  const full = t.players.length >= state.config.playersPerTeam;
  const lastOver = bowling ? cur.lastOverBowler : null;
  const overs = state.innings.filter((i) => i.bowling === team).flatMap((i) => i.overList.map((o) => ({ ...o, inn: i.number })));

  return (
    <section className="panel space-y-4 p-4">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-3xl font-extrabold">{t.name}</h2>
        <span className="text-sm text-chalk-dim">{isCaptain ? "You're captain" : `Captain: ${state.members.find((m) => m.id === state.captains[team])?.name || 'none yet'}`}</span>
      </header>
      {!t.players.length && <p className="text-chalk-dim">No players yet.</p>}

      {t.players.length > 0 && (
        <div>
          <h3 className="mb-1.5 flex items-baseline justify-between font-display text-xl font-bold">
            Batting order {batting && <span className="text-sm font-medium text-turf">batting now</span>}
          </h3>
          {can && <p className="mb-2 text-xs text-chalk-dim">Drag ⠿ to reorder. The top player opens; the next one in is first in line.</p>}
          <SortableList items={order} keyOf={(p) => p.id} enabled={can}
            onCommit={(next) => act({ type: 'bat_order', userIds: next.map((p) => p.id) })}
            render={(p, i) => {
              const s = bat.get(p.id);
              const onStrike = batting && cur.strikerId === p.id;
              const outs = dismissed[p.id] || 0;
              return (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Link to={`/u/${p.id}`} className="truncate font-semibold hover:text-flood">{p.name}</Link>
                  {state.captains[team] === p.id && <Tag tone="cap">C</Tag>}
                  {i < 2 && order.length > 1 && <Tag>Opener</Tag>}
                  {onStrike && <Tag tone="live">On strike</Tag>}
                  {!onStrike && outs > 0 && <Tag tone="out">Out{outs > 1 ? ` ×${outs}` : ''}</Tag>}
                  {nextUp?.id === p.id && !onStrike && <Tag tone="next">Next in</Tag>}
                  {batting && !onStrike && !outs && nextUp?.id !== p.id && !s && <Tag>Yet to bat</Tag>}
                  {s && <span className="text-sm tabular-nums text-chalk-dim">{s.runs} ({s.balls})</span>}
                  {can && batting && cur.strikerFresh && !onStrike && (
                    <button className="ml-auto rounded-lg bg-pitch-600 px-2 py-1 text-xs font-semibold hover:bg-pitch-500" onClick={() => act({ type: 'next_batter', userId: p.id })}>Send in now</button>
                  )}
                </div>
              );
            }} />
        </div>
      )}

      {t.players.length > 0 && (
        <div>
          <h3 className="mb-1.5 flex items-baseline justify-between font-display text-xl font-bold">
            Bowling order {bowling && <span className="text-sm font-medium text-turf">bowling now</span>}
          </h3>
          {can && <p className="mb-2 text-xs text-chalk-dim">Overs go down this list in turn{state.config.noConsecutive ? ', and nobody bowls two in a row' : ''}. Pick who bowls the next over any time before it starts.</p>}
          <SortableList items={bowlers} keyOf={(p) => p.id} enabled={can}
            onCommit={(next) => act({ type: 'bowl_order', userIds: next.map((p) => p.id) })}
            render={(p) => {
              const s = bowl.get(p.id);
              const nextBowler = bowling && cur.bowlerId === p.id;
              const blocked = state.config.noConsecutive && lastOver === p.id && bowlers.length > 1;
              return (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="truncate font-semibold">{p.name}</span>
                  {nextBowler && <Tag tone="live">{cur.open ? 'Bowling' : 'Bowls next'}</Tag>}
                  {lastOver === p.id && !nextBowler && <Tag>Bowled last over</Tag>}
                  {s && <span className="text-sm tabular-nums text-chalk-dim">{Math.floor(s.balls / 6)}.{s.balls % 6} ov, {s.wickets}-{s.runs}</span>}
                  {can && (
                    <span className="ml-auto flex gap-1">
                      {bowling && !cur.open && !nextBowler && !blocked && (
                        <button className="rounded-lg bg-pitch-600 px-2 py-1 text-xs font-semibold hover:bg-pitch-500" onClick={() => act({ type: 'next_bowler', userId: p.id })}>Bowl next over</button>
                      )}
                      {bowlers.length > 1 && (
                        <button className="rounded-lg px-2 py-1 text-xs text-chalk-dim hover:bg-pitch-600" onClick={() => act({ type: 'bowl_order', userIds: bowlers.filter((b) => b.id !== p.id).map((b) => b.id) })}>Rest</button>
                      )}
                    </span>
                  )}
                </div>
              );
            }} />
          {benchBowlers.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-chalk-dim">
              Not bowling:
              {benchBowlers.map((p) => can
                ? <button key={p.id} className="rounded-full bg-pitch-700 px-2.5 py-0.5 hover:bg-pitch-600" onClick={() => act({ type: 'bowl_order', userIds: [...bowlers.map((b) => b.id), p.id] })}>+ {p.name}</button>
                : <span key={p.id}>{p.name}</span>)}
            </div>
          )}
        </div>
      )}

      {overs.length > 0 && (
        <div>
          <h3 className="mb-1 font-display text-xl font-bold">Overs bowled</h3>
          <ol className="divide-y divide-pitch-600 text-sm">
            {overs.map((o) => (
              <li key={`${o.inn}-${o.n}`} className="flex justify-between py-1.5">
                <span><span className="text-chalk-faint">{o.inn > 2 ? 'Super over' : `Over ${o.n}`}</span> {o.bowler} to {o.batter}</span>
                <span className="tabular-nums">{o.runs} run{o.runs === 1 ? '' : 's'}{o.wickets ? `, ${o.wickets} wkt` : ''} <span className="text-chalk-faint">({o.balls} b)</span></span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {can && (
        <details className="rounded-xl bg-pitch-900/50 p-3">
          <summary className="cursor-pointer font-semibold">Squad changes</summary>
          <div className="mt-3 space-y-3 text-sm">
            <div>
              <span className="label">Add a player who's watching</span>
              {bench.length === 0 ? <p className="text-chalk-faint">Nobody is watching right now.</p> : full ? <p className="text-chalk-faint">The squad is full.</p> : (
                <div className="flex flex-wrap gap-2">{bench.map((p) => <button key={p.id} className="rounded-full bg-pitch-600 px-3 py-1 hover:bg-pitch-500" onClick={() => act({ type: 'add', userId: p.id })}>+ {p.name}</button>)}</div>
              )}
            </div>
            <div>
              <span className="label">Take a player out of the squad</span>
              <div className="flex flex-wrap gap-2">{t.players.filter((p) => p.id !== me).map((p) => <button key={p.id} className="rounded-full bg-pitch-600 px-3 py-1 hover:bg-pitch-500" onClick={() => act({ type: 'remove', userId: p.id })}>− {p.name}</button>)}</div>
            </div>
            <div>
              <span className="label">Hand over the captaincy</span>
              <div className="flex flex-wrap gap-2">{t.players.filter((p) => p.id !== me).map((p) => <button key={p.id} className="rounded-full bg-pitch-600 px-3 py-1 hover:bg-pitch-500" onClick={() => act({ type: 'captain', userId: p.id })}>Make {p.name} captain</button>)}</div>
            </div>
          </div>
        </details>
      )}
    </section>
  );
}

export function Lineups({ state, priv, me }) {
  const mine = priv.team;
  const teams = mine === 'B' ? ['B', 'A'] : ['A', 'B'];
  return (
    <div className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-2">
        {teams.map((t) => <TeamLineup key={t} state={state} team={t} priv={priv} me={me} />)}
      </div>
      <section className="panel p-4">
        <h2 className="font-display text-2xl font-bold">Match history</h2>
        <p className="text-sm text-chalk-dim">Every lineup change and decision, newest first.</p>
        {!state.history.length ? <p className="mt-2 text-sm text-chalk-faint">Nothing yet.</p> : (
          <ol className="mt-2 space-y-1 text-sm">
            {state.history.map((h) => (
              <li key={h.id} className="flex gap-3">
                <time className="w-12 shrink-0 tabular-nums text-chalk-faint">{new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                <span>{h.text}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
