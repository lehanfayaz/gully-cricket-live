// Broadcast-style score bug, the six-ball over strip, commentary and full scorecards.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import TeamBadge from './TeamBadge.jsx';
import { teamIdentity } from './Panels.jsx';

export function ScoreBug({ state, online }) {
  const cur = state.current;
  const inn = state.innings[state.innings.length - 1];
  const live = state.status === 'live' && !state.paused;
  if (!inn) {
    return (
      <div className="flex items-end justify-between px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 truncate font-display text-3xl font-extrabold leading-none"><TeamBadge team={teamIdentity(state, 'A')} size={30} />{state.teams.A.name} <span className="text-chalk-faint">v</span> {state.teams.B.name}<TeamBadge team={teamIdentity(state, 'B')} size={30} /></div>
          <div className="mt-1 text-sm text-chalk-dim">{state.config.overs} over{state.config.overs > 1 ? 's' : ''} a side, {state.config.wickets} wicket{state.config.wickets > 1 ? 's' : ''}</div>
        </div>
        <Online n={online} />
      </div>
    );
  }
  const bat = inn.card.batting.find((b) => b.id === cur?.strikerId);
  const bowl = (inn.card.bowling || []).find((b) => b.id === cur?.bowlerId);
  return (
    <div className="overflow-hidden">
      <div className="flex items-stretch">
        <div className="flex flex-1 items-center gap-3 bg-pitch-900/90 px-4 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold text-chalk-dim">
              {live && <span className="h-2 w-2 animate-pulse rounded-full bg-leather" aria-hidden />}
              <span className="truncate">{state.format === 'test' && state.test ? `Day ${state.test.day}, session ${state.test.session}, innings ${inn.number}` : inn.superOver ? 'Super over' : inn.number === 1 ? '1st innings' : '2nd innings'}{state.paused ? ', paused' : ''}{state.status === 'suspended' ? ', suspended' : ''}</span>
            </div>
            <div className="flex items-center gap-2 truncate font-display text-xl font-bold leading-tight"><TeamBadge team={teamIdentity(state, inn.batting)} size={24} />{inn.battingName}</div>
          </div>
          <div className="ml-auto text-right">
            <div className="font-display text-5xl font-extrabold leading-none tabular-nums">{inn.runs}<span className="text-chalk-dim">/{inn.wickets}</span></div>
          </div>
        </div>
        <div className="flex w-20 flex-col items-center justify-center bg-flood text-pitch-900">
          <div className="font-display text-3xl font-extrabold leading-none tabular-nums">{inn.overs}</div>
          <div className="text-xs font-semibold">{state.format === 'test' ? 'overs' : `of ${inn.maxBalls / 6} ov`}</div>
        </div>
      </div>
      <div className="flex items-center gap-3 bg-pitch-700/90 px-4 py-1.5 text-sm">
        {cur && state.status === 'live' ? (
          <>
            <span className="truncate"><span className="text-turf">🏏</span> <b>{cur.strikerName}</b> {bat ? `${bat.runs} (${bat.balls})` : '0 (0)'}</span>
            <span className="truncate text-chalk-dim">bowling: <b className="text-chalk">{cur.bowlerName}</b> {bowl ? `${bowl.wickets}-${bowl.runs}` : ''}</span>
          </>
        ) : <span className="text-chalk-dim">Run rate {cur?.runRate}</span>}
        <span className="ml-auto"><Online n={online} /></span>
      </div>
      {state.format === 'test' && state.test?.situation && state.status === 'live' && !inn.target && (
        <div className="bg-pitch-600 px-4 py-1 text-sm font-semibold">{state.test.situation}</div>
      )}
      {inn.target && state.status === 'live' && state.format === 'test' && (
        <div className="bg-leather px-4 py-1 text-sm font-semibold">Need {cur.need} to win</div>
      )}
      {inn.target && state.status === 'live' && state.format !== 'test' && (
        <div className="bg-leather px-4 py-1 text-sm font-semibold">
          Need {cur.need} from {cur.ballsLeft} ball{cur.ballsLeft === 1 ? '' : 's'}{cur.requiredRate ? `, required rate ${cur.requiredRate}` : ''}
        </div>
      )}
    </div>
  );
}

function Online({ n }) {
  return <span className="whitespace-nowrap text-xs text-chalk-dim"><span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-turf align-middle" />{n} watching</span>;
}

// The six leather balls of the over. Newly revealed balls flip over one by one.
export const REVEAL_STEP = 520; // ms between balls in the reveal
export function OverStrip({ over, compact }) {
  const prev = useRef(null);
  const [hidden, setHidden] = useState([]);
  const n = over?.balls.length || 0;
  useEffect(() => {
    const p = prev.current;
    prev.current = over ? { key: over.number, n } : null;
    if (!p || !over) return;
    const fresh = p.key === over.number ? over.balls.slice(p.n) : over.balls;
    if (!fresh.length || (p.key === over.number && n <= p.n)) return;
    const queue = fresh.map((b) => b.pos);
    setHidden(queue);
    let k = 0;
    const t = setInterval(() => { k += 1; setHidden(queue.slice(k)); if (k >= queue.length) clearInterval(t); }, REVEAL_STEP);
    return () => clearInterval(t);
  }, [over?.number, n]); // eslint-disable-line react-hooks/exhaustive-deps
  const byPos = new Map((over?.balls || []).map((b) => [b.pos, b]));
  return (
    <div className={`grid grid-cols-6 ${compact ? 'gap-2' : 'gap-2.5 sm:gap-4'}`}>
      {Array.from({ length: 6 }, (_, i) => {
        const b = byPos.get(i);
        const visible = b && !hidden.includes(i);
        const dead = over && (i >= over.slots || (over.finished && !b));
        return (
          <div key={i} className="flex flex-col items-center gap-1">
            <div className={`ball ${visible ? 'flipped' : ''} ${!over ? 'empty' : ''} ${dead ? 'dead' : ''}`}
              aria-label={visible ? `Ball ${i + 1}: ${b.wicket ? 'out' : `${b.runs} runs`}` : `Ball ${i + 1}${dead ? ': not bowled' : ''}`}>
              <div className="ball-inner">
                <div className="ball-face" />
                <div className={`ball-back font-display font-extrabold ${compact ? 'text-xl' : 'text-3xl'} ${b?.wicket ? 'is-wicket' : b && b.runs >= 4 ? 'is-boundary' : ''}`}>{b ? (b.wicket ? 'W' : b.runs) : ''}</div>
              </div>
            </div>
            {!compact && <div className="h-4 text-xs tabular-nums text-chalk-dim">{visible ? `${b.bat} v ${b.bowl}` : ''}</div>}
          </div>
        );
      })}
    </div>
  );
}

export function Commentary({ items, limit = 12 }) {
  const list = items.filter((c) => !c.voided).slice(0, limit);
  if (!list.length) return <p className="text-chalk-dim">Ball-by-ball commentary appears here once play starts.</p>;
  return (
    <ol className="space-y-1.5">
      {list.map((c) => (
        <li key={c.id} className="flex gap-3 text-sm">
          <span className="w-10 shrink-0 font-display text-base font-bold tabular-nums text-chalk-dim">{c.over}</span>
          <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full font-display font-bold ${c.wicket ? 'bg-leather' : c.runs === 6 ? 'bg-flood text-pitch-900' : c.runs === 4 ? 'bg-turf text-pitch-900' : 'bg-pitch-600'}`}>{c.wicket ? 'W' : c.runs}</span>
          <span className="pt-1">
            {c.wicket ? <><b>{c.batter}</b> is out. {c.bowler} had {c.bowl} too.</> : <><b>{c.batter}</b> picks {c.bat}, {c.bowler} had {c.bowl}.</>}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function Scorecards({ state }) {
  if (!state.innings.length) return <p className="p-4 text-chalk-dim">The scorecard fills in once the first ball is bowled.</p>;
  return (
    <div className="space-y-4">
      {state.innings.map((inn) => (
        <section key={inn.number} className="panel overflow-hidden">
          <header className="flex items-baseline justify-between bg-pitch-700 px-4 py-2">
            <h3 className="flex items-center gap-2 font-display text-xl font-bold"><TeamBadge team={teamIdentity(state, inn.batting)} size={24} />{inn.battingName}{inn.superOver ? ' (super over)' : ''}</h3>
            <span className="font-display text-2xl font-extrabold tabular-nums">{inn.runs}/{inn.wickets} <span className="text-base font-medium text-chalk-dim">({inn.overs})</span></span>
          </header>
          <table className="w-full text-sm">
            <thead className="text-left text-chalk-dim"><tr><th className="px-4 py-1.5 font-medium">Batting</th><th className="text-right font-medium">R</th><th className="text-right font-medium">B</th><th className="text-right font-medium">4s</th><th className="text-right font-medium">6s</th><th className="px-4 text-right font-medium">SR</th></tr></thead>
            <tbody>
              {inn.card.batting.map((b) => (
                <tr key={b.id} className="border-t border-pitch-600">
                  <td className="px-4 py-1.5"><Link className="hover:text-flood" to={`/u/${b.id}`}>{b.name}</Link>{b.outs ? <span className="text-chalk-faint"> out{b.outs > 1 ? ` ×${b.outs}` : ''}</span> : <span className="text-turf"> not out</span>}</td>
                  <td className="text-right font-semibold tabular-nums">{b.runs}</td><td className="text-right tabular-nums">{b.balls}</td><td className="text-right tabular-nums">{b.fours}</td><td className="text-right tabular-nums">{b.sixes}</td>
                  <td className="px-4 text-right tabular-nums">{b.balls ? ((b.runs * 100) / b.balls).toFixed(0) : '-'}</td>
                </tr>
              ))}
              {inn.extras !== 0 && <tr className="border-t border-pitch-600 text-chalk-dim"><td className="px-4 py-1.5">Umpire adjustments</td><td className="text-right tabular-nums">{inn.extras}</td><td colSpan={4} /></tr>}
            </tbody>
          </table>
          <table className="w-full text-sm">
            <thead className="text-left text-chalk-dim"><tr className="border-t border-pitch-500"><th className="px-4 py-1.5 font-medium">Bowling</th><th className="text-right font-medium">O</th><th className="text-right font-medium">R</th><th className="text-right font-medium">W</th><th className="px-4 text-right font-medium">Econ</th></tr></thead>
            <tbody>
              {inn.card.bowling.map((b) => (
                <tr key={b.id} className="border-t border-pitch-600">
                  <td className="px-4 py-1.5"><Link className="hover:text-flood" to={`/u/${b.id}`}>{b.name}</Link></td>
                  <td className="text-right tabular-nums">{Math.floor(b.balls / 6)}.{b.balls % 6}</td><td className="text-right tabular-nums">{b.runs}</td>
                  <td className="text-right font-semibold tabular-nums">{b.wickets}</td><td className="px-4 text-right tabular-nums">{b.balls ? ((b.runs * 6) / b.balls).toFixed(1) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {inn.target && <p className="border-t border-pitch-600 px-4 py-2 text-sm text-chalk-dim">Target {inn.target}</p>}
        </section>
      ))}
    </div>
  );
}
