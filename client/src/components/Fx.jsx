// Full-screen moments for sixes, fours, wickets and results, plus floating crowd cheers.
export function FxOverlay({ fx }) {
  if (!fx) return null;
  const words = { six: 'SIX!', four: 'FOUR!', wicket: 'OUT!', tie: 'TIE!', result: 'GAME!' };
  const word = words[fx.type];
  if (!word) return null;
  const color = fx.type === 'wicket' ? 'text-leather' : fx.type === 'four' ? 'text-turf' : 'text-flood';
  return (
    <div key={fx.key} className="pointer-events-none fixed inset-0 z-40 grid place-items-center overflow-hidden" aria-live="assertive">
      <div className={`absolute inset-0 ${fx.type === 'wicket' ? 'bg-leather/15' : 'bg-flood/10'}`} />
      {fx.type === 'wicket' && (
        <div className="absolute bottom-[38%] flex gap-3" aria-hidden>
          {[-1, 0, 1].map((d) => (
            <span key={d} className="stump block h-28 w-2.5 rounded-full bg-chalk"
              style={{ '--fly': `translate(${d * 90 + 20}px, -140px) rotate(${d * 70 + 25}deg)` }} />
          ))}
        </div>
      )}
      {fx.type === 'six' && <span className="six-ball absolute h-6 w-6 rounded-full bg-leather shadow-[0_0_20px_rgba(224,57,62,.8)] ring-2 ring-chalk/70" />}
      {fx.type === 'four' && <span className="four-ball absolute bottom-[26%] h-5 w-5 rounded-full bg-leather ring-2 ring-chalk/70" />}
      <div className={`fx-word font-display text-[34vw] font-extrabold leading-none drop-shadow-[0_8px_0_rgba(0,0,0,0.45)] sm:text-[200px] ${color}`}>{word}</div>
      {fx.batter && fx.type !== 'result' && (
        <div className="fx-word absolute bottom-[30%] font-display text-2xl font-bold text-chalk">{fx.type === 'wicket' ? `${fx.batter} has to go` : fx.batter}</div>
      )}
    </div>
  );
}

export function Cheers({ items }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 h-0" aria-hidden>
      {items.map((c) => (
        <span key={c.key} className="cheer absolute bottom-20 text-4xl" style={{ left: `${c.x}%` }}>{c.emoji}</span>
      ))}
    </div>
  );
}
