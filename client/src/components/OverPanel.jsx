// Locking in numbers. The bowler and the batter use the same pad and neither sees the other's until both are in.
// The pad asks for exactly as many numbers as there are balls left in the over (or one, in ball-by-ball matches).
import { useState } from 'react';
import { emit } from '../api.js';
import { useApp } from '../App.jsx';
import { digitsFor, repeatLimit, wouldBreak } from '../rules.js';
import { animationsOn, useSettings } from '../settings.js';
import { sfx } from '../sound.js';

export const NUM_COLORS = {
  0: 'bg-chalk-dim text-pitch-900',
  1: 'bg-[#7FD1FF] text-pitch-900', 2: 'bg-turf text-pitch-900', 3: 'bg-[#B58CFF] text-pitch-900',
  4: 'bg-flood text-pitch-900', 5: 'bg-[#FF8A3D] text-pitch-900', 6: 'bg-leather text-chalk',
};

function Slots({ seq, count, onRemove, small }) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.max(count, 3)}, minmax(0, 1fr))` }}>
      {Array.from({ length: count }, (_, i) => {
        const n = seq[i];
        return (
          <button key={i} type="button" disabled={!onRemove || n == null} onClick={() => onRemove?.(i)}
            aria-label={n != null ? `Ball ${i + 1}: ${n}${onRemove ? '. Tap to remove.' : ''}` : `Ball ${i + 1}: empty`}
            className={`aspect-square max-h-24 rounded-xl font-display font-extrabold ${small ? 'text-2xl' : 'text-4xl'} ${n != null ? `${NUM_COLORS[n]} pop` : 'border-2 border-dashed border-pitch-500 text-chalk-faint'}`}>
            {n ?? <span className="text-base font-semibold">{i + 1}</span>}
          </button>
        );
      })}
    </div>
  );
}

const overLine = (cur) => `Over ${cur.overNumber}, ball ${cur.ballInOver}. ${cur.ballsLeftInOver} ball${cur.ballsLeftInOver === 1 ? '' : 's'} left in the over.`;

export function SubmitOver({ state, role, cur, priv }) {
  const { toast } = useApp();
  const [seq, setSeq] = useState([]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = cur.open ? cur.set : null;
  const otherLocked = role === 'bowl' ? set?.batterLocked : set?.bowlerLocked;
  const otherName = role === 'bowl' ? cur.strikerName : cur.bowlerName;
  const myName = role === 'bowl' ? cur.bowlerName : cur.strikerName;
  const forRoster = state.teamSource === 'real';
  const need = cur.cap;
  const single = need === 1;
  const digits = digitsFor(state, role);
  const limit = repeatLimit(state, role);
  const bowled = limit ? cur.bowledThisOver || [] : [];
  const used = (n, extra = []) => [...bowled, ...extra].filter((x) => x === n).length;
  const blocked = (n, extra) => limit != null && wouldBreak(n, [...bowled, ...extra], limit);
  const myReq = state.test?.requirements?.find((r) => r.batterId === cur.strikerId && r.status === 'active');
  const ruleNote = (
    <>
      {state.format === 'test' && (
        <p className="mt-2 text-xs text-chalk-faint">Test rules: {role === 'bowl' ? 'bowlers pick 1, 2, 3, 4 or 6' : 'batters pick 0, 1, 2, 3, 4 or 6 (0 is a dot ball)'}. No 5.</p>
      )}
      {limit && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs" aria-label="Times each number has been used this over">
          <span className="text-chalk-faint">Used this over{cur.ballInOver > 1 ? ' since the start or last wicket' : ''} (one number up to 3, the rest up to 2):</span>
          {digits.map((n) => <span key={n} className={`rounded px-1.5 py-0.5 tabular-nums ${blocked(n, seq) ? 'bg-leather text-chalk' : 'bg-pitch-700 text-chalk-dim'}`}>{n}: {used(n, seq)}</span>)}
        </div>
      )}
      {role === 'bat' && myReq && (
        <p className="mt-2 rounded-lg bg-flood px-3 py-2 text-sm font-semibold text-pitch-900">Scoring requirement: you must score within the next {myReq.ballsLeft} legal ball{myReq.ballsLeft === 1 ? '' : 's'}.</p>
      )}
    </>
  );

  if (priv.myLocked) {
    return (
      <section className="panel p-4" aria-live="polite">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-2xl font-bold">You're locked in</h2>
          <LockedChip />
        </div>
        <p className="mb-3 mt-1 text-sm text-chalk-dim">Only you can see {single ? 'this' : 'these'}. {single ? 'It' : 'They'} can't be changed.</p>
        <Slots seq={priv.myLocked} count={priv.myLocked.length} small />
        <div className="mt-4 flex items-center gap-3 rounded-xl bg-pitch-900/60 px-4 py-3">
          <span className="relative flex h-3 w-3"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-flood opacity-75" /><span className="relative inline-flex h-3 w-3 rounded-full bg-flood" /></span>
          <span>Waiting for <b>{otherName}</b>. {single ? 'The ball' : 'The over'} is revealed the moment they lock in.</span>
        </div>
      </section>
    );
  }

  const submit = async (digits) => {
    setBusy(true);
    const r = await emit('over:submit', { matchId: state.id, sequence: digits });
    setBusy(false);
    if (!r.ok) { toast({ title: 'Not submitted', body: r.error }); setConfirm(false); }
    else { setSeq([]); sfx.lock(); }
  };
  const add = (n) => { if (seq.length < need && !blocked(n, seq)) { setSeq([...seq, n]); setConfirm(false); } };
  const random = () => {
    const out = [];
    while (out.length < need) {
      const ok = digits.filter((n) => !blocked(n, out));
      out.push(ok[Math.floor(Math.random() * ok.length)]);
    }
    setSeq(out); setConfirm(false);
  };
  const header = (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className="font-display text-3xl font-extrabold leading-none">
          {single ? (role === 'bowl' ? 'Bowl this ball' : 'Play this ball') : role === 'bowl' ? `Bowl ${need} balls` : `Bat ${need} balls`}
        </h2>
        {forRoster && <p className="mt-1 font-semibold text-flood">{role === 'bowl' ? 'Bowling' : 'Batting'}: {myName}</p>}
        <p className="mt-1 text-sm text-chalk-dim">
          {overLine(cur)}{' '}
          {role === 'bowl' ? `If ${otherName} picks the same number, they're out.` : `Score what you pick, unless ${otherName} picked the same.`}
        </p>
      </div>
      <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold ${otherLocked ? 'bg-flood text-pitch-900' : 'bg-pitch-600 text-chalk-dim'}`}>
        {otherLocked ? `${otherName} is locked in` : `${otherName} is choosing`}
      </span>
    </div>
  );

  if (single) {
    // Ball by ball (or the last ball of an over): pick one number, then lock it in.
    const pick = seq[0];
    return (
      <section className="panel your-turn p-4" aria-label="Submit your number">
        {header}
        <div className="mt-4 grid grid-cols-3 gap-3">
          {digits.map((n) => (
            <button key={n} type="button" onClick={() => setSeq([n])} aria-pressed={pick === n} disabled={blocked(n, [])}
              title={blocked(n, []) ? `${n} can't be used again this over` : undefined}
              className={`aspect-[5/4] rounded-2xl font-display text-6xl font-extrabold shadow-lg transition disabled:opacity-20 ${NUM_COLORS[n]} ${pick === n ? 'scale-105 ring-4 ring-chalk' : pick != null ? 'opacity-50' : ''}`}>{n}</button>
          ))}
        </div>
        {ruleNote}
        <button type="button" className="btn-go mt-4 w-full py-4 text-2xl" disabled={pick == null || busy} onClick={() => submit([pick])}>
          {pick != null ? `Lock in ${pick}` : 'Pick a number'}
        </button>
      </section>
    );
  }

  return (
    <section className="panel your-turn p-4" aria-label="Submit your over">
      {header}
      <div className="mt-4"><Slots seq={seq} count={need} onRemove={(i) => { setSeq(seq.filter((_, j) => j !== i)); setConfirm(false); }} /></div>
      <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${digits.length}, minmax(0, 1fr))` }}>
        {digits.map((n) => (
          <button key={n} type="button" onClick={() => add(n)} disabled={seq.length >= need || blocked(n, seq)}
            title={blocked(n, seq) ? `${n} can't be used again this over: only one number may be used 3 times` : undefined}
            className={`rounded-xl py-4 font-display text-3xl font-extrabold shadow-md transition active:scale-95 disabled:opacity-25 ${NUM_COLORS[n]}`}>{n}</button>
        ))}
      </div>
      {ruleNote}
      <div className="mt-3 flex gap-2">
        <button type="button" className="btn-ghost" onClick={random}>Random</button>
        <button type="button" className="btn-ghost" onClick={() => { setSeq([]); setConfirm(false); }} disabled={!seq.length}>Reset</button>
        <button type="button" className={`${confirm ? 'btn-flood' : 'btn-go'} flex-1`} disabled={seq.length !== need || busy}
          onClick={() => (confirm ? submit(seq) : setConfirm(true))}>
          {confirm ? `Lock in ${seq.join(' ')}` : seq.length === need ? 'Submit over' : `${need - seq.length} more`}
        </button>
      </div>
      {confirm && <p className="mt-2 text-sm text-flood">Once submitted you can't change it. Tap again to lock in.</p>}
    </section>
  );
}

// What everyone else sees while the numbers are being chosen.
export function OverStatus({ cur, me, single }) {
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
      <h2 className="font-display text-2xl font-bold">{single ? `Ball ${cur.ballInOver} of over ${cur.overNumber}` : `Over ${cur.overNumber}`}</h2>
      <p className="text-sm text-chalk-dim">{overLine(cur)}</p>
      {row('Bowling', cur.bowlerName, set?.bowlerLocked)}
      {row('Batting', cur.strikerName, set?.batterLocked)}
      <p className="text-sm text-chalk-dim">{next || 'Both picks stay hidden until both are locked in.'}</p>
    </section>
  );
}

// The "submitted" stamp lands when you lock in.
function LockedChip() {
  const s = useSettings();
  return <span className={`rounded-full bg-turf px-3 py-1 text-sm font-bold text-pitch-900 ${animationsOn(s) ? 'lock-stamp' : ''}`}>🔒 Submitted</span>;
}
