import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';
import TeamBadge from '../components/TeamBadge.jsx';

const KIND = { groups: 'Groups and knockout', league: 'Round robin', knockout: 'Knockout', custom: 'Custom tournament' };
const TABS = [['overview', 'Overview'], ['fixtures', 'Fixtures'], ['table', 'Table'], ['bracket', 'Bracket'], ['teams', 'Teams'], ['stats', 'Stats']];
const fmtMatch = (s) => `${s.format === 't20' ? 'T20' : s.format === 'odi' ? 'ODI' : `${s.overs}-over`} matches, ${s.wickets} wickets, AI ${s.aiLevel}`;

export default function Tournament() {
  const { id } = useParams();
  const { toast } = useApp();
  const nav = useNavigate();
  const [t, setT] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('overview');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api(`/api/tournaments/${id}`).then(setT).catch((e) => setErr(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  // While AI matches are being played, refresh so standings fill in as each one finishes.
  useEffect(() => { if (!t?.job?.running) return; const h = setInterval(load, 1200); return () => clearInterval(h); }, [t?.job?.running, load]);
  if (err) return <p className="p-8 text-center text-chalk-dim">{err}</p>;
  if (!t) return <p className="p-8 text-center text-chalk-dim">Loading the tournament…</p>;
  const byKey = Object.fromEntries(t.teams.map((x) => [x.key, x]));
  const play = async () => {
    setBusy(true);
    try { const r = await api(`/api/tournaments/${id}/play`, { method: 'POST' }); nav(`/m/${r.matchId}`); }
    catch (x) { toast({ title: 'Not started', body: x.message }); setBusy(false); }
  };
  const simulate = async (limit) => {
    setBusy(true);
    try { await api(`/api/tournaments/${id}/simulate`, { body: limit ? { limit } : {} }); await load(); }
    catch (x) { toast({ title: 'Not started', body: x.message }); }
    setBusy(false);
  };
  const abandon = async () => {
    if (!window.confirm('Abandon this tournament? Results so far are kept, but no more matches can be played.')) return;
    try { await api(`/api/tournaments/${id}/abandon`, { method: 'POST' }); load(); } catch (x) { toast({ title: 'Not abandoned', body: x.message }); }
  };
  const me = t.teams.find((x) => x.human);
  return (
    <div className="space-y-4 px-4 pb-12 pt-2">
      <header className="flex items-start gap-3">
        {me && <TeamBadge team={me} size={48} />}
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-4xl font-extrabold leading-none sm:text-5xl">{t.name}</h1>
          <p className="mt-1 text-chalk-dim">{KIND[t.kind]}. {t.teams.length} teams. {fmtMatch(t.settings)}. You are {me?.name}.</p>
        </div>
      </header>
      <div className="h-2 overflow-hidden rounded-full bg-pitch-700" role="progressbar" aria-valuemin={0} aria-valuemax={t.progress.total} aria-valuenow={t.progress.played} aria-label="Matches played">
        <div className="h-full bg-turf" style={{ width: `${(t.progress.played / Math.max(1, t.progress.total)) * 100}%` }} />
      </div>
      <p className="-mt-2 text-sm text-chalk-dim">{t.progress.played} of {t.progress.total} matches played{t.status === 'abandoned' ? '. This tournament was abandoned.' : ''}</p>

      <NextAction t={t} byKey={byKey} busy={busy} play={play} simulate={simulate} />

      <nav className="no-scrollbar flex gap-1 overflow-x-auto pb-1" aria-label="Tournament sections">
        {TABS.filter(([k]) => (k === 'table' ? t.groups.length > 0 : k === 'bracket' ? t.bracket.length > 0 : true)).map(([k, l]) => (
          <button key={k} type="button" aria-current={tab === k} onClick={() => setTab(k)}
            className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold ${tab === k ? 'bg-flood text-pitch-900' : 'bg-pitch-700 text-chalk-dim hover:text-chalk'}`}>{l}</button>
        ))}
      </nav>
      {tab === 'overview' && <Overview t={t} byKey={byKey} />}
      {tab === 'fixtures' && <Fixtures t={t} byKey={byKey} />}
      {tab === 'table' && <Tables t={t} />}
      {tab === 'bracket' && <Bracket t={t} byKey={byKey} />}
      {tab === 'teams' && <Teams t={t} />}
      {tab === 'stats' && <Stats s={t.stats} />}
      {t.owner && t.status === 'active' && <button type="button" className="text-sm text-chalk-faint underline" onClick={abandon}>Abandon tournament</button>}
    </div>
  );
}

function NextAction({ t, byKey, busy, play, simulate }) {
  if (t.status === 'completed') {
    return (
      <section className="panel mown flex items-center gap-4 p-5">
        <TeamBadge team={t.champion} size={64} />
        <div><p className="text-sm text-chalk-dim">Champions</p><h2 className="font-display text-4xl font-extrabold leading-none text-flood">{t.champion.name}</h2>
          <p className="mt-1 text-chalk-dim">{t.champion.human ? 'You won the tournament!' : 'Crowned after every fixture was played out.'}</p></div>
      </section>
    );
  }
  if (t.status !== 'active') return null;
  if (t.job?.running) return (
    <section className="panel p-5" aria-live="polite">
      <h2 className="font-display text-2xl font-bold">Playing the AI matches…</h2>
      <p className="text-chalk-dim">{t.job.current ? `Now: ${t.job.current}. ` : ''}{t.job.played} finished so far. Every ball is played by the AI through the normal rules.</p>
    </section>
  );
  if (!t.owner) return <section className="panel p-4 text-chalk-dim">You're viewing someone else's tournament.</section>;
  const n = t.next;
  if (!n) return null;
  if (n.human) {
    const f = t.fixtures.find((x) => x.id === n.id);
    return (
      <section className="panel mown p-5">
        <p className="text-sm text-chalk-dim">Your next match: {f.roundName}</p>
        <div className="my-2 flex items-center gap-3">
          <TeamBadge team={byKey[f.home]} size={40} /><span className="font-display text-2xl font-bold">{byKey[f.home].name}</span>
          <span className="text-chalk-faint">v</span>
          <span className="font-display text-2xl font-bold">{byKey[f.away].name}</span><TeamBadge team={byKey[f.away]} size={40} />
        </div>
        <button type="button" className="btn-flood w-full text-xl" disabled={busy} onClick={play}>{n.matchId ? 'Resume your match' : 'Play your match'}</button>
      </section>
    );
  }
  return (
    <section className="panel p-5">
      <h2 className="font-display text-2xl font-bold">{t.humanOut ? `${t.teams.find((x) => x.human).name} are out` : `${t.aiBefore} AI match${t.aiBefore === 1 ? '' : 'es'} before your next one`}</h2>
      <p className="text-chalk-dim">{t.humanOut ? 'The tournament carries on without you. Play out the rest to crown a champion.' : `Next: ${n.roundName}. Play them now, or one at a time.`}</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" className="btn-go text-lg" disabled={busy} onClick={() => simulate()}>{t.humanOut ? 'Play to the end' : 'Play them all'}</button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => simulate(1)}>Just the next one</button>
      </div>
    </section>
  );
}

function Score({ f, k, byKey }) {
  const inns = f.score.filter((s) => s.team === k && !s.superOver);
  const so = f.score.filter((s) => s.team === k && s.superOver);
  const team = byKey[k];
  return (
    <div className={`flex items-center gap-2 ${f.winner && f.winner !== k ? 'text-chalk-dim' : ''}`}>
      {team ? <TeamBadge team={team} size={24} /> : <span className="h-6 w-6" />}
      <span className={`min-w-0 flex-1 truncate ${f.winner === k ? 'font-bold' : ''}`}>{team ? team.name : '—'}{team?.human ? ' (you)' : ''}</span>
      <span className="shrink-0 tabular-nums">{inns.map((s) => `${s.runs}/${s.wickets}`).join(' & ')}{inns.length ? <span className="text-xs text-chalk-faint"> ({inns.at(-1).overs})</span> : ''}{so.length ? <span className="text-xs text-chalk-faint"> SO {so.map((s) => s.runs).join(', ')}</span> : ''}</span>
    </div>
  );
}

function FixtureCard({ f, byKey }) {
  const label = (k, l) => (k ? null : <div className="flex items-center gap-2 text-chalk-faint"><span className="h-6 w-6" /><span className="truncate">{l}</span></div>);
  return (
    <li className={`panel p-3 ${f.human ? 'ring-1 ring-flood/50' : ''}`}>
      <div className="mb-1 flex items-center justify-between text-xs text-chalk-faint"><span>{f.roundName}</span><span>{f.status === 'live' ? 'In progress' : f.status === 'ready' ? 'Up next' : f.status === 'pending' ? 'To be decided' : f.status === 'bye' ? 'Bye' : ''}</span></div>
      <div className="space-y-1">
        {f.home ? <Score f={f} k={f.home} byKey={byKey} /> : label(f.home, f.homeLabel)}
        {f.status !== 'bye' && (f.away ? <Score f={f} k={f.away} byKey={byKey} /> : label(f.away, f.awayLabel))}
      </div>
      {f.result && <p className="mt-1 text-sm text-chalk-dim">{f.result}</p>}
      {f.matchId && (
        <div className="mt-2 flex gap-3 text-sm">
          {f.status === 'completed' && <Link className="font-semibold text-flood" to={`/m/${f.matchId}/stats`}>Scorecard and replay</Link>}
          {f.status === 'live' && f.human && <Link className="font-semibold text-flood" to={`/m/${f.matchId}`}>Open match</Link>}
        </div>
      )}
    </li>
  );
}

function Overview({ t, byKey }) {
  const mine = t.fixtures.filter((f) => f.human);
  const recent = t.fixtures.filter((f) => f.status === 'completed').slice(-4).reverse();
  return (
    <div className="space-y-4">
      {t.final && <FinalCard final={t.final} />}
      <section>
        <h2 className="font-display text-2xl font-bold">Your matches</h2>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">{mine.map((f) => <FixtureCard key={f.id} f={f} byKey={byKey} />)}</ul>
        {mine.length === 0 && <p className="text-chalk-dim">No matches yet.</p>}
      </section>
      {recent.length > 0 && (
        <section>
          <h2 className="font-display text-2xl font-bold">Latest results</h2>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">{recent.map((f) => <FixtureCard key={f.id} f={f} byKey={byKey} />)}</ul>
        </section>
      )}
      {t.groups.length > 0 && <Tables t={t} compact />}
    </div>
  );
}

function FinalCard({ final }) {
  return (
    <section className="panel overflow-x-auto p-4">
      <div className="flex items-baseline justify-between gap-2"><h2 className="font-display text-2xl font-bold">The final</h2><Link to={`/m/${final.matchId}/stats`} className="text-sm font-semibold text-flood">Full analysis and replay</Link></div>
      <p className="text-chalk-dim">{final.result}</p>
      {final.innings.map((i) => (
        <div key={i.number} className="mt-3">
          <div className="flex justify-between font-semibold"><span>{i.battingName}{i.superOver ? ', super over' : ''}</span><span className="tabular-nums">{i.runs}/{i.wickets} ({i.overs})</span></div>
          <table className="mt-1 w-full text-sm tabular-nums">
            <thead className="text-left text-chalk-dim"><tr><th className="py-0.5 font-medium">Batter</th><th className="font-medium">R</th><th className="font-medium">B</th><th className="font-medium">4s</th><th className="font-medium">6s</th></tr></thead>
            <tbody>{i.battingCard.map((b) => <tr key={b.id} className="border-t border-pitch-600"><td className="py-1">{b.name}<span className="text-xs text-chalk-faint">{b.outs ? '' : ' not out'}</span></td><td className="font-semibold">{b.runs}</td><td>{b.balls}</td><td>{b.fours}</td><td>{b.sixes}</td></tr>)}</tbody>
          </table>
          <table className="mt-1 w-full text-sm tabular-nums">
            <thead className="text-left text-chalk-dim"><tr><th className="py-0.5 font-medium">Bowler</th><th className="font-medium">O</th><th className="font-medium">R</th><th className="font-medium">W</th><th className="font-medium">Econ</th></tr></thead>
            <tbody>{i.bowlingCard.map((b) => <tr key={b.id} className="border-t border-pitch-600"><td className="py-1">{b.name}</td><td>{b.overs}</td><td>{b.runs}</td><td className="font-semibold">{b.wickets}</td><td>{b.economy ?? '–'}</td></tr>)}</tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

function Fixtures({ t, byKey }) {
  const rounds = [];
  for (const f of t.fixtures) {
    const key = f.stage === 'group' ? `Round ${f.round}` : f.roundName.replace(/ \d+$/, '');
    let r = rounds.find((x) => x.key === key);
    if (!r) rounds.push(r = { key, list: [] });
    r.list.push(f);
  }
  return (
    <div className="space-y-4">
      {rounds.map((r) => (
        <section key={r.key}>
          <h2 className="font-display text-2xl font-bold">{r.key}</h2>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">{r.list.map((f) => <FixtureCard key={f.id} f={f} byKey={byKey} />)}</ul>
        </section>
      ))}
    </div>
  );
}

const STATUS = { qualified: ['Qualified', 'font-semibold text-turf'], eliminated: ['Out', 'font-semibold text-leather'], in: ['In a qualifying place', 'text-chalk-dim'], out: ['Outside the places', 'text-chalk-faint'] };
function Tables({ t, compact }) {
  const solo = t.groups.length === 1 && !t.fixtures.some((f) => f.stage !== 'group');
  return (
    <div className="space-y-4">
      {t.groups.map((g) => (
        <section key={g.name} className="panel overflow-x-auto p-4">
          <h2 className="font-display text-2xl font-bold">{t.groups.length > 1 ? `Group ${g.name}` : 'Points table'}</h2>
          <table className="mt-2 w-full min-w-[26rem] text-sm tabular-nums [&_td]:px-1.5 [&_th]:px-1.5">
            <thead className="text-left text-chalk-dim"><tr><th className="py-1 font-medium">#</th><th className="font-medium">Team</th><th className="font-medium">P</th><th className="font-medium">W</th><th className="font-medium">L</th><th className="font-medium">T</th><th className="font-medium">NR</th><th className="font-medium">Pts</th><th className="font-medium">NRR</th>{!compact && <th className="font-medium">Form</th>}</tr></thead>
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.key} className={`border-t ${r.rank === g.qualify ? 'border-b-2 border-b-flood/60' : ''} border-pitch-600 ${r.human ? 'bg-flood/10' : ''}`}>
                  <td className="py-1.5">{r.rank}</td>
                  <td><span className="flex items-center gap-2"><TeamBadge team={r} size={22} />
                    <span className="min-w-0"><span className="block truncate font-semibold">{r.name}{r.human && <span className="ml-1 text-xs font-normal text-flood">you</span>}</span>
                      {(r.champion || !solo) && <span className={`block text-xs ${r.champion ? 'font-bold text-flood' : STATUS[r.status][1]}`}>{r.champion ? 'Champion' : STATUS[r.status][0]}</span>}</span></span></td>
                  <td>{r.played}</td><td>{r.won}</td><td>{r.lost}</td><td>{r.tied}</td><td>{r.noResult}</td><td className="font-bold">{r.points}</td>
                  <td>{r.played ? (r.nrr > 0 ? '+' : '') + r.nrr.toFixed(3) : '–'}</td>
                  {!compact && <td className="whitespace-nowrap font-mono text-xs">{r.form.join(' ') || '–'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          {!compact && <p className="mt-2 text-xs text-chalk-faint">Win 2 points, tie or no result 1. Ties on points are split by net run rate (a side bowled out counts its full overs). {g.qualify && !solo ? `Top ${g.qualify} qualify; the line marks the cut. “Qualified” and “Out” are certain; the others are where teams stand now.` : ''}</p>}
        </section>
      ))}
    </div>
  );
}

function Bracket({ t, byKey }) {
  return (
    <div className="space-y-4">
      <div className="no-scrollbar flex gap-3 overflow-x-auto pb-2">
        {t.bracket.map((r) => (
          <section key={r.round} className="flex w-60 shrink-0 flex-col">
            <h2 className="mb-2 font-display text-xl font-bold">{r.name}</h2>
            <ul className="flex flex-1 flex-col justify-around gap-3">{r.fixtures.map((f) => <FixtureCard key={f.id} f={f} byKey={byKey} />)}</ul>
          </section>
        ))}
      </div>
      {t.third && <section><h2 className="mb-2 font-display text-xl font-bold">Third-place play-off</h2><ul className="max-w-sm"><FixtureCard f={t.third} byKey={byKey} /></ul></section>}
    </div>
  );
}

function Teams({ t }) {
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {t.teams.map((x) => (
        <li key={x.key} className={`panel flex items-center gap-3 p-3 ${x.human ? 'ring-2 ring-flood' : ''}`}>
          <span className="w-6 text-right text-sm tabular-nums text-chalk-faint">{x.seed}</span>
          <TeamBadge team={x} size={36} />
          <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{x.name}</span>
            <span className="block text-sm text-chalk-dim">{x.group ? `Group ${x.group}. ` : ''}{x.human ? 'Your team' : `AI, ${t.settings.aiLevel}, ${x.personality}`}{x.category === 'custom' ? '. Custom team' : x.category === 'ipl' ? '. IPL' : ''}</span></span>
          {t.champion?.key === x.key && <span className="rounded-full bg-flood px-2 py-0.5 text-xs font-bold text-pitch-900">Champion</span>}
        </li>
      ))}
    </ul>
  );
}

function Stats({ s }) {
  if (!s.matches) return <p className="panel p-4 text-chalk-dim">Stats appear once the first match is finished.</p>;
  const List = ({ title, rows, render }) => (
    <section className="panel p-4">
      <h2 className="font-display text-xl font-bold">{title}</h2>
      {rows.length ? <ol className="mt-2 space-y-1.5 text-sm">{rows.map((r, i) => <li key={i} className="flex gap-2"><span className="w-4 text-chalk-faint">{i + 1}</span>{render(r)}</li>)}</ol> : <p className="text-sm text-chalk-dim">None yet.</p>}
    </section>
  );
  const who = (r) => <span className="min-w-0 flex-1 truncate"><b>{r.name}</b> <span className="text-chalk-faint">{r.team || r.teamName}</span></span>;
  return (
    <div className="space-y-4">
      <section className="panel grid grid-cols-3 gap-4 p-4 sm:grid-cols-6">
        {[['Matches', s.matches], ['Runs', s.runs], ['Wickets', s.wickets], ['Overs', s.overs], ['Fours', s.fours], ['Sixes', s.sixes]].map(([k, v]) => <div key={k}><div className="font-display text-3xl font-bold tabular-nums">{v}</div><div className="text-xs text-chalk-dim">{k}</div></div>)}
      </section>
      <div className="grid gap-4 sm:grid-cols-2">
        <List title="Most runs" rows={s.mostRuns} render={(r) => <>{who(r)}<span className="tabular-nums">{r.runs} <span className="text-chalk-faint">({r.balls}b, SR {r.strikeRate ?? '–'})</span></span></>} />
        <List title="Most wickets" rows={s.mostWickets} render={(r) => <>{who(r)}<span className="tabular-nums">{r.wickets} <span className="text-chalk-faint">({r.runs} runs, {r.overs} ov)</span></span></>} />
        <List title="Highest scores" rows={s.highestScores} render={(r) => <>{who(r)}<span className="tabular-nums">{r.runs}{r.out ? '' : '*'} <span className="text-chalk-faint">({r.balls}b)</span></span></>} />
        <List title="Best bowling" rows={s.bestBowling} render={(r) => <>{who(r)}<span className="tabular-nums">{r.wickets}/{r.runs} <span className="text-chalk-faint">({r.overs} ov)</span></span></>} />
        <List title="Most sixes" rows={s.mostSixes} render={(r) => <>{who(r)}<span className="tabular-nums">{r.sixes}</span></>} />
        <List title="Highest team totals" rows={s.highestTotals} render={(r) => <><span className="min-w-0 flex-1 truncate"><b>{r.team}</b> <span className="text-chalk-faint">v {r.against}, {r.round}</span></span><span className="tabular-nums">{r.runs}/{r.wickets} <span className="text-chalk-faint">({r.overs})</span></span></>} />
      </div>
      <p className="text-xs text-chalk-faint">Counted from every delivery of this tournament's matches. Super overs are not included.</p>
    </div>
  );
}
