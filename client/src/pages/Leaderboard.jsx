import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

const SORTS = [['points', 'Ranking'], ['runs', 'Runs'], ['wickets', 'Wickets'], ['wins', 'Wins'], ['sixes', 'Sixes'], ['strikeRate', 'Strike rate']];

export default function Leaderboard() {
  const [sort, setSort] = useState('points');
  const [rows, setRows] = useState(null);
  const [recent, setRecent] = useState([]);
  useEffect(() => { setRows(null); api(`/api/leaderboard?sort=${sort}`).then((r) => setRows(r.rows)).catch(() => setRows([])); }, [sort]);
  useEffect(() => { api('/api/matches/recent').then((r) => setRecent(r.matches)).catch(() => {}); }, []);
  return (
    <div className="grid gap-4 px-4 pb-12 pt-2 lg:grid-cols-[1fr_320px]">
      <section>
        <h1 className="font-display text-5xl font-extrabold leading-none">Leaderboard</h1>
        <p className="mt-1 text-sm text-chalk-dim">Ranking points are runs, plus 20 for every wicket taken and 25 for every win. Strike rate needs at least 12 balls faced.</p>
        <div className="no-scrollbar mt-3 flex gap-1 overflow-x-auto" role="tablist">
          {SORTS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={sort === k} onClick={() => setSort(k)}
              className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-semibold ${sort === k ? 'bg-flood text-pitch-900' : 'bg-pitch-700 text-chalk-dim'}`}>{l}</button>
          ))}
        </div>
        <div className="panel mt-3 overflow-x-auto">
          {rows === null ? <p className="p-4 text-chalk-dim">Loading…</p> : rows.length === 0 ? <p className="p-4 text-chalk-dim">Finish a match to get on the board.</p> : (
            <table className="w-full min-w-[520px] text-sm">
              <thead className="text-left text-chalk-dim">
                <tr><th className="px-4 py-2 font-medium">#</th><th className="font-medium">Player</th><th className="text-right font-medium">Pts</th><th className="text-right font-medium">Runs</th><th className="text-right font-medium">SR</th><th className="text-right font-medium">6s</th><th className="text-right font-medium">Wkts</th><th className="px-4 text-right font-medium">Won</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-pitch-600">
                    <td className={`px-4 py-2 font-display text-xl font-extrabold ${r.rank <= 3 ? 'text-flood' : 'text-chalk-faint'}`}>{r.rank}</td>
                    <td><Link to={`/u/${r.id}`} className="font-semibold hover:text-flood">{r.name}</Link></td>
                    <td className="text-right font-semibold tabular-nums">{r.points}</td><td className="text-right tabular-nums">{r.runs}</td>
                    <td className="text-right tabular-nums">{r.strikeRate}</td><td className="text-right tabular-nums">{r.sixes}</td>
                    <td className="text-right tabular-nums">{r.wickets}</td><td className="px-4 text-right tabular-nums">{r.wins}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
      <aside className="panel h-fit p-4">
        <h2 className="font-display text-2xl font-bold">Recent results</h2>
        {recent.length === 0 ? <p className="mt-1 text-sm text-chalk-dim">No finished matches yet.</p> : (
          <ul className="mt-2 divide-y divide-pitch-600 text-sm">
            {recent.map((m) => <li key={m.id}><Link to={`/m/${m.id}`} className="block py-2 hover:text-flood"><span className="block font-semibold">{m.name}</span><span className="text-chalk-dim">{m.result?.text}</span></Link></li>)}
          </ul>
        )}
      </aside>
    </div>
  );
}
