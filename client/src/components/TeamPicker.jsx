// Pick a real international or IPL team from the synced team database.
import { useMemo, useState } from 'react';
import TeamBadge from './TeamBadge.jsx';

const fmt = (t) => (t ? new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : null);

export default function TeamPicker({ data, value, onChange, exclude, label }) {
  const [cat, setCat] = useState(() => data.teams.find((t) => t.id === value)?.category || 'international');
  const [q, setQ] = useState('');
  const list = useMemo(() => data.teams.filter((t) => t.category === cat && (!q || t.name.toLowerCase().includes(q.toLowerCase()) || (t.short || '').toLowerCase().includes(q.toLowerCase()))), [data, cat, q]);
  return (
    <div>
      <span className="label">{label}</span>
      <div className="mb-2 flex gap-1" role="tablist">
        {data.categories.map((c) => (
          <button key={c.id} type="button" role="tab" aria-selected={cat === c.id} onClick={() => setCat(c.id)}
            className={`rounded-full px-3 py-1 text-sm font-semibold ${cat === c.id ? 'bg-flood text-pitch-900' : 'bg-pitch-700 text-chalk-dim'}`}>{c.name}</button>
        ))}
        <input aria-label="Search teams" className="field ml-auto w-32 py-1 text-sm" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ul className="no-scrollbar grid max-h-64 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
        {list.map((t) => {
          const taken = exclude && exclude === t.id;
          return (
            <li key={t.id}>
              <button type="button" onClick={() => onChange(t.id)} aria-pressed={value === t.id}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left ring-2 ${value === t.id ? 'bg-turf/15 ring-turf' : 'bg-pitch-900/60 ring-transparent hover:ring-pitch-500'} ${taken ? 'opacity-50' : ''}`}>
                <TeamBadge team={t} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{t.name}</span>
                  <span className="block text-xs text-chalk-faint">{t.squadSize ? `${t.squadSize} in squad` : 'Squad not synced yet'}{taken ? ', picked by the other side' : ''}</span>
                </span>
              </button>
            </li>
          );
        })}
        {!list.length && <li className="text-sm text-chalk-faint">No teams match.</li>}
      </ul>
    </div>
  );
}

export function SyncNote({ data }) {
  const s = data.sync;
  return (
    <p className="text-xs text-chalk-faint">
      {s.lastSuccessAt ? `Teams and squads last updated ${fmt(s.lastSuccessAt)}${data.provider ? ` from ${data.provider}` : ''}.`
        : `Squads haven't been synced yet${data.provider ? '' : ' (no data provider set up)'}. Team list as of ${fmt(s.seedAsOf) || 'setup'}; teams without a squad use numbered stand-in players.`}
    </p>
  );
}
