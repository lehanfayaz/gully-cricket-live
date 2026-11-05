// Locking in six numbers. The bowler and the batter use the same pad; neither sees the other's until both are in.
import { useState } from 'react';
import { emit } from '../api.js';
import { useApp } from '../App.jsx';

export const NUM_COLORS = {
  1: 'bg-[#7FD1FF] text-pitch-900', 2: 'bg-turf text-pitch-900', 3: 'bg-[#B58CFF] text-pitch-900',
  4: 'bg-flood text-pitch-900', 5: 'bg-[#FF8A3D] text-pitch-900', 6: 'bg-leather text-chalk',
};

function Slots({ seq, onRemove, cap = 6, small }) {
  return (
    <div className="grid grid-cols-6 gap-2">
      {Array.from({ length: 6 }, (_, i) => {
        const n = seq[i];
        const beyond = i >= cap;
        return (
          <button key={i} type="button" disabled={!onRemove || n == null} onClick={() => onRemove?.(i)}
            aria-label={n ? `Ball ${i + 1}: ${n}${onRemove ? '. Tap to remove.' : ''}` : `Ball ${i + 1}: empty`}
            className={`relative aspect-square rounded-xl font-display font-extrabold ${small ? 'text-2xl' : 'text-4xl'} ${n ? `${NUM_COLORS[n]} pop` : 'border-2 border-dashed border-pitch-500 text-chalk-faint'} ${beyond ? 'opacity-40' : ''}`}>
            {n ?? <span className="text-base font-semibold">{i + 1}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function SubmitOver({ state, role, cur, priv }) {
  const { toast } = useApp();
  const [seq, setSeq] = useState([]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = cur.open ? cur.set : null;
  const otherLocked = role === 'bowl' ? set?.batterLocked : set?.bowlerLocked;
  const otherName = role === 'bowl' ? cur.strikerName : cur.bowlerName;
  const cap = cur.cap;

  if (priv.myLocked) {
    return (
      <section className="panel p-4" aria-live="polite">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-2xl font-bold">You're locked in</h2>
          <span className="rounded-full bg-turf px-3 py-1 text-sm font-bold text-pitch-900">🔒 Submitted</span>
        </div>
        <p className="mb-3 mt-1 text-sm text-chalk-dim">Only you can see these. They can't be changed.</p>
        <Slots seq={priv.myLocked} cap={cap} small />
        <div className="mt-4 flex items-center gap-3 rounded-xl bg-pitch-900/60 px-4 py-3">
          <span className="relative flex h-3 w-3"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-flood opacity-75" /><span className="relative inline-flex h-3 w-3 rounded-full bg-flood" /></span>
          <span>Waiting for <b>{otherName}</b> to lock in. The over is revealed the moment they do.</span>
        </div>
      </section>
    );
  }

  const add = (n) => { if (seq.length < 6) { setSeq([...seq, n]); setConfirm(false); } };
  const random = () => { setSeq(Array.from({ length: 6 }, () => 1 + Math.floor(Math.random() * 6))); setConfirm(false); };
  const submit = async () => {
    if (!confirm) { setConfirm(true); return; }
    setBusy(true);
    const r = await emit('over:submit', { matchId: state.id, sequence: seq });
    setBusy(false);
    if (!r.ok) { toast({ title: 'Over not submitted', body: r.error }); setConfirm(false); }
    else setSeq([]);
  };
  return (
    <section className="panel your-turn p-4" aria-label="Submit your over">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-3xl font-extrabold leading-none">{role === 'bowl' ? 'Bowl your over' : 'Bat your over'}</h2>
          <p className="mt-1 text-sm text-chalk-dim">
            {role === 'bowl' ? `Pick six numbers. Any ball where ${otherName} picks the same number, they're out.` : `Pick six numbers. You score what you pick, unless ${otherName} picked the same number for that ball.`}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold ${otherLocked ? 'bg-flood text-pitch-900' : 'bg-pitch-600 text-chalk-dim'}`}>
          {otherLocked ? `${otherName} is locked in` : `${otherName} is choosing`}
        </span>
      </div>
      {cap < 6 && <p className="mt-2 text-sm text-flood">Only the first {cap} ball{cap === 1 ? '' : 's'} count{cap === 1 ? 's' : ''}: that's all that's left in the innings.</p>}
      <div className="mt-4"><Slots seq={seq} cap={cap} onRemove={(i) => { setSeq(seq.filter((_, j) => j !== i)); setConfirm(false); }} /></div>
      <div className="mt-3 grid grid-cols-6 gap-2">
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <button key={n} type="button" onClick={() => add(n)} disabled={seq.length >= 6}
            className={`rounded-xl py-4 font-display text-3xl font-extrabold shadow-md transition active:scale-95 disabled:opacity-35 ${NUM_COLORS[n]}`}>{n}</button>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <button type="button" className="btn-ghost" onClick={random}>Random</button>
        <button type="button" className="btn-ghost" onClick={() => { setSeq([]); setConfirm(false); }} disabled={!seq.length}>Reset</button>
        <button type="button" className={`${confirm ? 'btn-flood' : 'btn-go'} flex-1`} disabled={seq.length !== 6 || busy} onClick={submit}>
          {confirm ? `Lock in ${seq.join(' ')}` : seq.length === 6 ? 'Submit over' : `${6 - seq.length} more`}
        </button>
      </div>
      {confirm && <p className="mt-2 text-sm text-flood">Once submitted you can't change it. Tap again to lock in.</p>}
    </section>
  );
}

// What everyone else sees while the over is being chosen.
export function OverStatus({ cur, me }) {
  const set = cur.open ? cur.set : null;
  const row = (label, name, locked) => (
    <div className="flex items-center justify-between rounded-xl bg-pitch-900/60 px-4 py-3">
      <span><span className="text-sm text-chalk-dim">{label}</span><span className="block font-display text-xl font-bold">{name}</span></span>
      {locked
        ? <span className="rounded-full bg-turf px-3 py-1 text-sm font-bold text-pitch-900">🔒 Locked in</span>
        : <span className="flex items-center gap-2 text-sm text-chalk-dim"><span className="h-2 w-2 animate-pulse rounded-full bg-flood" />Choosing</span>}
    </div>
  );
  const next = cur.strikerId === me ? "You're batting soon." : cur.bowlerId === me ? "You're bowling soon." : null;
  return (
    <section className="panel space-y-2 p-4" aria-live="polite">
      <h2 className="font-display text-2xl font-bold">Over in progress</h2>
      {row('Bowling', cur.bowlerName, set?.bowlerLocked)}
      {row('Batting', cur.strikerName, set?.batterLocked)}
      <p className="text-sm text-chalk-dim">{next || 'Both sixes stay hidden until both are locked in. Then the whole over is revealed.'}</p>
    </section>
  );
}
