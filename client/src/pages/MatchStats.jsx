import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import Worm, { TEAM_COLOR } from '../components/Worm.jsx';

// Match analysis: everything here comes from the saved deliveries of this match.
export default function MatchStats() {
  const { id } = useParams();
  const [q, setQ] = useSearchParams();
  const tab = q.get('tab') || 'summary';
  const [data, setData] = useState(null);
  const [rp, setRp] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    Promise.all([api(`/api/matches/${id}/analysis`), api(`/api/matches/${id}/replay`)])
      .then(([a, r]) => { setData(a); setRp(r); }).catch((e) => setErr(e.message));
  }, [id]);
  if (err) return <p className="p-8 text-center text-chalk-dim">{err}</p>;
  if (!data) return <p className="p-8 text-center text-chalk-dim">Adding up the deliveries…</p>;
  const A = data.analysis;
  const go = (t, extra = {}) => setQ({ tab: t, ...extra });
  const tabs = [['summary', 'Summary'], ['scorecard', 'Scorecard'], ['replay', 'Replay'], ['highlights', 'Highlights']];
  return (
    <div className="space-y-4 px-4 pb-12 pt-4">
      <Link to={`/m/${id}`} className="text-sm text-chalk-dim hover:text-chalk">Back to the match</Link>
      <header>
        <h1 className="font-display text-4xl font-extrabold leading-none sm:text-5xl">{A.name}</h1>
        <p className="mt-1 text-chalk-dim">{A.formatName}. {A.result?.text || (A.status === 'completed' ? 'Finished.' : 'In progress: figures so far.')}</p>
      </header>
      <nav className="flex gap-1 overflow-x-auto rounded-xl bg-pitch-900/60 p-1" aria-label="Match analysis">
        {tabs.map(([k, l]) => (
          <button key={k} type="button" aria-current={tab === k} onClick={() => go(k)}
            className={`flex-1 whitespace-nowrap rounded-lg px-3 py-2 font-display text-lg font-bold ${tab === k ? 'bg-flood text-pitch-900' : 'text-chalk-dim hover:text-chalk'}`}>{l}</button>
        ))}
      </nav>
      {tab === 'summary' && <Summary A={A} />}
      {tab === 'scorecard' && <Scorecard A={A} />}
      {tab === 'replay' && rp && <Replay rp={rp} startBall={Number(q.get('ball')) || null} />}
      {tab === 'highlights' && <Highlights list={data.highlights} jump={(ballId) => go('replay', ballId ? { ball: String(ballId) } : {})} />}
    </div>
  );
}

const Stat = ({ v, k }) => <div><div className="font-display text-3xl font-bold tabular-nums">{v ?? '–'}</div><div className="text-xs text-chalk-dim">{k}</div></div>;

function Summary({ A }) {
  return (
    <div className="space-y-4">
      <section className="space-y-2">
        {A.innings.map((i) => (
          <div key={i.id} className="panel flex items-center gap-3 p-4" style={{ borderLeft: `4px solid ${TEAM_COLOR[i.batting]}` }}>
            <div className="min-w-0 flex-1">
              <div className="truncate font-display text-xl font-bold">{i.battingName}{i.superOver ? ', super over' : A.innings.length > 2 ? `, innings ${i.number}` : ''}</div>
              <div className="text-sm text-chalk-dim">{i.overs} overs, run rate {i.runRate ?? '–'}{i.target ? `, chasing ${i.target}` : ''}{i.adjustments ? `, umpire adjustments ${i.adjustments > 0 ? '+' : ''}${i.adjustments}` : ''}</div>
            </div>
            <div className="font-display text-4xl font-extrabold tabular-nums">{i.runs}/{i.wickets}</div>
          </div>
        ))}
      </section>
      <section className="panel grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <Stat k="Total runs" v={A.totals.runs} /><Stat k="Wickets" v={A.totals.wickets} /><Stat k="Overs" v={A.totals.overs} /><Stat k="Run rate" v={A.totals.runRate} />
      </section>
      <section className="grid gap-3 sm:grid-cols-3">
        <Card title="Best batter">{A.bestBatter ? <><b className="text-chalk">{A.bestBatter.name}</b>: {A.bestBatter.runs} off {A.bestBatter.balls}, strike rate {A.bestBatter.strikeRate ?? '–'}</> : 'No balls faced yet.'}</Card>
        <Card title="Best bowler">{A.bestBowler ? <><b className="text-chalk">{A.bestBowler.name}</b>: {A.bestBowler.wickets}/{A.bestBowler.runs} in {A.bestBowler.overs} overs, economy {A.bestBowler.economy ?? '–'}</> : 'No wickets taken by a bowler.'}</Card>
        <Card title="Highest partnership">{A.highestPartnership ? <>{A.highestPartnership.runs} for the {ordinal(A.highestPartnership.wicket)} wicket ({A.highestPartnership.balls} balls), {A.highestPartnership.team}, by {A.highestPartnership.batters.join(' and ')}{A.highestPartnership.broken ? '' : ', unbroken'}</> : 'None yet.'}</Card>
      </section>
      <Worm innings={A.innings} />
      {A.test && <TestDays test={A.test} />}
    </div>
  );
}
const Card = ({ title, children }) => <div className="panel p-4"><h3 className="font-display text-lg font-bold text-flood">{title}</h3><p className="mt-1 text-sm text-chalk-dim">{children}</p></div>;
const ordinal = (n) => `${n}${[, 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th'}`;

function TestDays({ test }) {
  return (
    <section className="panel overflow-x-auto p-4">
      <h2 className="font-display text-2xl font-bold">Days and sessions</h2>
      <table className="mt-2 w-full text-sm tabular-nums">
        <thead className="text-left text-chalk-dim"><tr><th className="py-1 font-medium">Session</th><th className="font-medium">Overs</th><th className="font-medium">Runs</th><th className="font-medium">Wkts</th><th className="font-medium">Rate</th><th className="font-medium">By team</th></tr></thead>
        <tbody>
          {test.days.map((d) => [
            ...test.sessions.filter((s) => s.day === d.day).map((s) => (
              <tr key={s.idx} className="border-t border-pitch-600"><td className="py-1.5">Day {s.day}, session {s.num}</td><td>{s.overs}</td><td>{s.runs}</td><td>{s.wickets}</td><td>{s.runRate ?? '–'}</td>
                <td className="text-chalk-dim">{Object.entries(s.byTeam).map(([t, x]) => `${t} ${x.runs}/${x.wickets}`).join(', ') || 'No play'}</td></tr>
            )),
            <tr key={`d${d.day}`} className="border-t border-pitch-500 font-semibold"><td className="py-1.5">Day {d.day} total</td><td>{d.overs}</td><td>{d.runs}</td><td>{d.wickets}</td><td>{d.runRate ?? '–'}</td><td /></tr>,
          ])}
        </tbody>
      </table>
    </section>
  );
}

function Scorecard({ A }) {
  return (
    <div className="space-y-4">
      {A.innings.map((i) => (
        <section key={i.id} className="panel overflow-x-auto p-4">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-display text-2xl font-bold">{i.battingName}{i.superOver ? ', super over' : A.innings.length > 2 ? `, innings ${i.number}` : ''}</h2>
            <span className="font-display text-2xl font-bold tabular-nums">{i.runs}/{i.wickets} <span className="text-base text-chalk-dim">({i.overs})</span></span>
          </div>
          <table className="mt-2 w-full text-sm tabular-nums">
            <thead className="text-left text-chalk-dim"><tr><th className="py-1 font-medium">Batter</th><th className="font-medium">R</th><th className="font-medium">B</th><th className="font-medium">4s</th><th className="font-medium">6s</th><th className="font-medium">Dots</th><th className="font-medium">SR</th></tr></thead>
            <tbody>{i.battingCard.map((b) => (
              <tr key={b.id} className="border-t border-pitch-600"><td className="py-1.5"><div className="font-semibold">{b.name}</div><div className="text-xs text-chalk-faint">{b.outs ? b.dismissals.join('; ') : 'not out'}</div></td>
                <td className="font-semibold">{b.runs}</td><td>{b.balls}</td><td>{b.fours}</td><td>{b.sixes}</td><td>{b.dots}</td><td>{b.strikeRate ?? '–'}</td></tr>
            ))}</tbody>
          </table>
          {i.adjustments !== 0 && <p className="mt-1 text-sm text-chalk-dim">Umpire adjustments: {i.adjustmentList.map((a) => `${a.delta > 0 ? '+' : ''}${a.delta} (${a.reason})`).join(', ')}</p>}
          {i.voidedBalls > 0 && <p className="mt-1 text-sm text-chalk-dim">{i.voidedBalls} deliveries were voided by the umpire and are not counted.</p>}
          <table className="mt-4 w-full text-sm tabular-nums">
            <thead className="text-left text-chalk-dim"><tr><th className="py-1 font-medium">Bowler</th><th className="font-medium">O</th><th className="font-medium">M</th><th className="font-medium">R</th><th className="font-medium">W</th><th className="font-medium">Dots</th><th className="font-medium">Econ</th></tr></thead>
            <tbody>{i.bowlingCard.map((b) => (
              <tr key={b.id} className="border-t border-pitch-600"><td className="py-1.5 font-semibold">{b.name}</td><td>{b.overs}</td><td>{b.maidens}</td><td>{b.runs}</td><td className="font-semibold">{b.wickets}</td><td>{b.dots}</td><td>{b.economy ?? '–'}</td></tr>
            ))}</tbody>
          </table>
          {i.fow.length > 0 && (
            <div className="mt-4">
              <h3 className="font-display text-lg font-bold">Fall of wickets</h3>
              <p className="text-sm text-chalk-dim">{i.fow.map((f) => `${f.score}/${f.wicket} (${f.batter}, ${f.over})`).join(', ')}</p>
            </div>
          )}
          <div className="mt-3">
            <h3 className="font-display text-lg font-bold">Partnerships</h3>
            <ul className="mt-1 space-y-1">
              {i.partnerships.map((p) => {
                const max = Math.max(...i.partnerships.map((x) => x.runs), 1);
                return (
                  <li key={p.wicket} className="text-sm">
                    <div className="flex items-center gap-2">
                      <span className="w-20 shrink-0 text-chalk-dim">{ordinal(p.wicket)} wkt</span>
                      <span className="h-2 flex-1 rounded-r bg-pitch-900/60"><span className="block h-2 rounded-r" style={{ width: `${Math.max(2, (p.runs / max) * 100)}%`, background: TEAM_COLOR[i.batting] }} /></span>
                      <span className="w-16 shrink-0 text-right tabular-nums">{p.runs}{p.broken ? '' : '*'} <span className="text-chalk-faint">({p.balls})</span></span>
                    </div>
                    <div className="truncate pl-[5.5rem] text-xs text-chalk-faint">{p.batters.join(', ')}</div>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      ))}
    </div>
  );
}

// ---------- replay ----------
function Replay({ rp, startBall }) {
  const balls = useMemo(() => rp.frames.filter((f) => f.type === 'ball'), [rp]);
  const startAt = Math.max(0, startBall ? rp.frames.findIndex((f) => f.id === startBall) : 0);
  const [i, setI] = useState(startAt);
  useEffect(() => { setI(startAt); }, [startAt]);
  if (!rp.frames.length) return <p className="panel p-4 text-chalk-dim">No deliveries have been revealed yet.</p>;
  const f = rp.frames[i];
  const find = (from, dir, test) => { for (let k = from + dir; k >= 0 && k < rp.frames.length; k += dir) if (test(rp.frames[k])) return k; return from; };
  const isBall = (x) => x.type === 'ball';
  const overOf = (x) => `${x.innings}:${x.over?.split('.')[0]}`;
  // Jump to the first ball of the next or previous over (or of this over, if we're part-way through it).
  // The delivery a frame belongs to: itself, or the last ball before it (none before the first ball).
  const anchorOf = (k) => { if (isBall(rp.frames[k])) return rp.frames[k]; const j = find(k, -1, isBall); return isBall(rp.frames[j]) ? rp.frames[j] : null; };
  const firstBall = (x) => isBall(x) && x.over.endsWith('.1');
  const nextOver = () => { const a = anchorOf(i); setI(find(i, 1, (x) => firstBall(x) && (!a || overOf(x) !== overOf(a)))); };
  const prevOver = () => {
    const a = anchorOf(i);
    const startOfThis = find(i + 1, -1, (x) => firstBall(x) && a && overOf(x) === overOf(a));
    setI(startOfThis < i ? startOfThis : find(i, -1, (x) => firstBall(x) && (!a || overOf(x) !== overOf(a))));
  };
  // The over this frame belongs to, as a strip.
  const anchor = anchorOf(i);
  const strip = anchor ? rp.frames.filter((x) => isBall(x) && x.innings === anchor.innings && x.over.split('.')[0] === anchor.over.split('.')[0]) : [];
  const ballPos = isBall(f) ? balls.indexOf(f) + 1 : null;
  const inningsStarts = rp.frames.filter((x) => x.type === 'innings_start');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {inningsStarts.map((s) => (
          <button key={s.i} type="button" onClick={() => setI(s.i)} className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${f.innings === s.innings ? 'bg-turf text-pitch-900' : 'bg-pitch-600'}`}>
            {s.batting}{s.superOver ? ' super over' : inningsStarts.length > 2 ? ` inn ${s.innings}` : ''}
          </button>
        ))}
      </div>
      <section className="panel p-5" aria-live="polite">
        <Frame f={f} />
      </section>
      {strip.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label={`Over ${Number(anchor.over.split('.')[0]) + 1}`}>
          {strip.map((b) => (
            <button key={b.id} type="button" onClick={() => setI(b.i)} title={`${b.over}: ${b.batter} picked ${b.bat}, ${b.bowler} picked ${b.bowl}`}
              className={`h-10 min-w-10 rounded-full px-2 font-display text-lg font-bold ring-2 ${b.i === i ? 'ring-flood' : 'ring-transparent'} ${b.voided ? 'bg-pitch-700 text-chalk-faint line-through' : b.wicket ? 'bg-leather' : b.runs >= 4 ? 'bg-turf text-pitch-900' : 'bg-pitch-600'}`}>
              {b.voided ? '×' : b.wicket ? 'W' : b.runs}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-4 gap-2">
        <button type="button" className="btn-ghost" onClick={prevOver} aria-label="Previous over">« Over</button>
        <button type="button" className="btn-ghost" onClick={() => setI(Math.max(0, i - 1))} aria-label="Previous step">‹ Back</button>
        <button type="button" className="btn-ghost" onClick={() => setI(Math.min(rp.frames.length - 1, i + 1))} aria-label="Next step">Next ›</button>
        <button type="button" className="btn-ghost" onClick={nextOver} aria-label="Next over">Over »</button>
      </div>
      <label className="block">
        <span className="label">Step {i + 1} of {rp.frames.length}{ballPos ? `, delivery ${ballPos} of ${balls.length}` : ''}</span>
        <input type="range" min="0" max={rp.frames.length - 1} value={i} onChange={(e) => setI(Number(e.target.value))} className="w-full accent-[#FFD23F]" />
      </label>
    </div>
  );
}

function Frame({ f }) {
  const score = f.score && <div className="font-display text-5xl font-extrabold tabular-nums">{f.score.runs}/{f.score.wickets}{f.score.overs && <span className="ml-2 text-xl text-chalk-dim">({f.score.overs})</span>}</div>;
  if (f.type === 'innings_start') return <><p className="text-sm text-chalk-dim">Innings {f.innings}{f.superOver ? ', super over' : ''}</p><h2 className="font-display text-3xl font-bold">{f.batting} bat, {f.bowling} bowl</h2>{f.target && <p className="text-chalk-dim">Target {f.target}</p>}</>;
  if (f.type === 'session') return <><h2 className="font-display text-3xl font-bold">Day {f.day}, session {f.session}</h2><p className="text-chalk-dim">Play starts at</p>{score}</>;
  if (f.type === 'over_end') return <><h2 className="font-display text-3xl font-bold">End of over {f.over}{f.partial ? ' (incomplete)' : ''}</h2><p className="text-chalk-dim">{f.runs} run{f.runs === 1 ? '' : 's'}{f.wickets ? `, ${f.wickets} wicket${f.wickets === 1 ? '' : 's'}` : ''}{f.bowler ? `, bowled by ${f.bowler}` : ''}</p>{score}</>;
  if (f.type === 'adjustment') return <><h2 className="font-display text-3xl font-bold">Umpire adjustment {f.delta > 0 ? '+' : ''}{f.delta}</h2><p className="text-chalk-dim">{f.reason}</p>{score}</>;
  if (f.type === 'innings_end') return <><h2 className="font-display text-3xl font-bold">{f.team} {f.declared ? 'declared' : 'innings over'}</h2>{score}</>;
  if (f.type === 'match_end') return <><h2 className="font-display text-3xl font-bold">Result</h2><p className="text-lg">{f.result}</p></>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-chalk-dim">Ball {f.over}{f.day ? `, day ${f.day} session ${f.session}` : ''}{f.voided ? ': voided by the umpire, not counted' : ''}</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-pitch-900/60 p-3"><div className="text-xs text-chalk-dim">Batter</div><div className="truncate font-semibold">{f.batter}</div><div className="font-display text-5xl font-extrabold text-flood">{f.bat}</div></div>
        <div className="rounded-xl bg-pitch-900/60 p-3"><div className="text-xs text-chalk-dim">Bowler</div><div className="truncate font-semibold">{f.bowler}</div><div className="font-display text-5xl font-extrabold">{f.bowl}</div></div>
      </div>
      <p className={`font-display text-3xl font-bold ${f.voided ? 'text-chalk-faint' : f.wicket ? 'text-leather' : 'text-turf'}`}>
        {f.voided ? 'Voided' : f.wicket ? (f.dismissal === 'matched' ? 'Out! The numbers matched.' : 'Out under the dot-over rule.') : `${f.runs} run${f.runs === 1 ? '' : 's'}`}
      </p>
      {score}
      {f.need != null && !f.voided && <p className="text-chalk-dim">{f.need === 0 ? 'Target reached.' : `${f.need} needed.`}</p>}
    </div>
  );
}

function Highlights({ list, jump }) {
  if (!list.length) return <p className="panel p-4 text-chalk-dim">No highlights yet: they appear as deliveries are played.</p>;
  const order = { winner: 0, performance: 1, big_over: 2, streak: 3, session: 4, day: 5, wicket: 6 };
  const groups = [['winner', 'The finish'], ['performance', 'Best performances'], ['big_over', 'Biggest overs'], ['streak', 'Scoring runs'], ['session', 'Key sessions'], ['day', 'Day by day'], ['wicket', 'Every wicket']];
  return (
    <div className="space-y-4">
      {groups.map(([k, title]) => {
        const items = list.filter((h) => h.kind === k).sort((a, b) => (order[a.kind] - order[b.kind]) || (b.runs || 0) - (a.runs || 0));
        if (!items.length) return null;
        return (
          <section key={k}>
            <h2 className="font-display text-2xl font-bold">{title}</h2>
            <ul className="mt-2 space-y-2">
              {items.map((h, n) => (
                <li key={n} className="panel flex items-start gap-3 p-3">
                  <div className="min-w-0 flex-1"><div className="font-semibold">{h.title}</div><div className="text-sm text-chalk-dim">{h.detail}</div></div>
                  {h.ballId != null && <button type="button" className="shrink-0 rounded-lg bg-pitch-600 px-3 py-1.5 text-sm font-semibold hover:bg-pitch-500" onClick={() => jump(h.ballId)}>Watch</button>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
