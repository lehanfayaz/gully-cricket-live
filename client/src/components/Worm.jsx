import { useState } from 'react';

// Score progression ("worm"): cumulative runs at the end of each over, one line per innings.
// Colour follows the team (validated pair on the pitch surface); a team's second innings is dashed.
export const TEAM_COLOR = { A: '#B88716', B: '#3F8FDB' };

export default function Worm({ innings }) {
  const series = innings.filter((i) => i.progression.length).map((i) => ({
    key: i.number, team: i.batting, label: `${i.battingName}${innings.length > 2 || i.superOver ? ` ${i.superOver ? 'super over' : `inn ${i.number}`}` : ''}`,
    dashed: innings.filter((x) => x.batting === i.batting && x.number < i.number && !x.superOver).length > 0 || i.superOver,
    points: [{ over: 0, runs: 0, wickets: 0 }, ...i.progression],
  }));
  const [hover, setHover] = useState(null);
  const [table, setTable] = useState(false);
  if (!series.length) return null;
  const W = 420, H = 230, L = 34, R = 56, T = 12, Bm = 28; // sized so labels stay readable on a phone
  const maxO = Math.max(...series.flatMap((s) => s.points.map((p) => p.over)), 1);
  const maxR = Math.max(...series.flatMap((s) => s.points.map((p) => p.runs)), 10);
  const niceMax = Math.ceil(maxR / 10) * 10;
  const x = (o) => L + (o / maxO) * (W - L - R), y = (r) => T + (1 - r / niceMax) * (H - T - Bm);
  const ticks = Array.from({ length: 5 }, (_, k) => Math.round((niceMax / 4) * k));
  const step = Math.max(1, Math.ceil(maxO / 6));
  const oTicks = Array.from({ length: Math.floor(maxO / step) + 1 }, (_, k) => k * step);
  const move = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const o = Math.round((((e.clientX - box.left) / box.width) * W - L) / (W - L - R) * maxO);
    setHover(o >= 0 && o <= maxO ? o : null);
  };
  return (
    <figure className="panel p-4">
      <div className="flex items-center justify-between gap-2">
        <figcaption className="font-display text-xl font-bold">Score progression</figcaption>
        <button type="button" className="text-sm text-chalk-dim underline" onClick={() => setTable(!table)}>{table ? 'Show chart' : 'Show as table'}</button>
      </div>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-chalk-dim" aria-label="Legend">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <svg width="22" height="8" aria-hidden="true"><line x1="1" y1="4" x2="21" y2="4" stroke={TEAM_COLOR[s.team]} strokeWidth="2" strokeDasharray={s.dashed ? '4 3' : undefined} strokeLinecap="round" /></svg>{s.label}
          </li>
        ))}
      </ul>
      {table ? (
        <div className="mt-2 max-h-72 overflow-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-left text-chalk-dim"><tr><th className="py-1 font-medium">Over</th>{series.map((s) => <th key={s.key} className="py-1 font-medium">{s.label}</th>)}</tr></thead>
            <tbody>{Array.from({ length: maxO }, (_, k) => k + 1).map((o) => (
              <tr key={o} className="border-t border-pitch-600"><td className="py-1">{o}</td>{series.map((s) => { const p = s.points.find((q) => q.over === o); return <td key={s.key}>{p ? `${p.runs}/${p.wickets}` : ''}</td>; })}</tr>
            ))}</tbody>
          </table>
        </div>
      ) : (
        <div className="relative mt-2">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Runs by over: ${series.map((s) => `${s.label} ${s.points.at(-1).runs}/${s.points.at(-1).wickets} in ${s.points.at(-1).over} overs`).join('; ')}`}
            onMouseMove={move} onMouseLeave={() => setHover(null)} onTouchStart={(e) => move(e.touches[0] ? { currentTarget: e.currentTarget, clientX: e.touches[0].clientX } : e)}>
            {ticks.map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="#1C553A" strokeWidth="1" /><text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize="12" fill="#A9BDB0">{t}</text></g>)}
            {oTicks.map((o) => <text key={o} x={x(o)} y={H - 8} textAnchor="middle" fontSize="12" fill="#A9BDB0">{o}</text>)}
            <text x={W - 4} y={H - 8} textAnchor="end" fontSize="12" fill="#6F8A7B">overs</text>
            {hover != null && <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - Bm} stroke="#6F8A7B" strokeWidth="1" />}
            {series.map((s) => (
              <g key={s.key}>
                <polyline fill="none" stroke={TEAM_COLOR[s.team]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={s.dashed ? '6 4' : undefined}
                  points={s.points.map((p) => `${x(p.over)},${y(p.runs)}`).join(' ')} />
                {/* Wickets: a ringed dot at the over they fell in */}
                {s.points.filter((p, k) => k > 0 && p.wickets > s.points[k - 1].wickets).map((p) => (
                  <circle key={p.over} cx={x(p.over)} cy={y(p.runs)} r="4" fill={TEAM_COLOR[s.team]} stroke="#0E281D" strokeWidth="2"><title>{`Wicket in over ${p.over}`}</title></circle>
                ))}
                <text x={x(s.points.at(-1).over) + 6} y={y(s.points.at(-1).runs) + 4} fontSize="12" fill="#F2F5EC">{`${s.points.at(-1).runs}/${s.points.at(-1).wickets}`}</text>
                {hover != null && s.points.find((p) => p.over === hover) && <circle cx={x(hover)} cy={y(s.points.find((p) => p.over === hover).runs)} r="4" fill={TEAM_COLOR[s.team]} stroke="#0E281D" strokeWidth="2" />}
              </g>
            ))}
          </svg>
          {hover != null && hover > 0 && (
            <div className="pointer-events-none absolute top-0 rounded-lg bg-pitch-900/95 px-3 py-2 text-sm shadow-xl ring-1 ring-pitch-500"
              style={{ left: `${Math.min(70, (x(hover) / W) * 100)}%` }}>
              <div className="font-semibold">After over {hover}</div>
              {series.map((s) => { const p = s.points.find((q) => q.over === hover); return p && <div key={s.key} className="flex items-center gap-1.5 tabular-nums"><span className="inline-block h-0.5 w-3" style={{ background: TEAM_COLOR[s.team] }} />{s.label}: {p.runs}/{p.wickets} ({p.overRuns} this over)</div>; })}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
