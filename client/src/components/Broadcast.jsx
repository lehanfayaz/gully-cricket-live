// Broadcast presentation: stadium backdrops, presentation settings, and full-screen moments
// (innings break, the winning celebration, the trophy). All cosmetic, all client-side: none of it
// waits on or holds up the match, and none of it changes a number.
import { useEffect, useMemo, useState } from 'react';
import { animationsOn, setSettings, useSettings } from '../settings.js';
import { applyVolumes, sfx, unlock } from '../sound.js';
import TeamBadge from './TeamBadge.jsx';
import { useAppConfig } from '../appConfig.js';

// The stadium to show: the player's choice if the organisers still offer it, otherwise their default.
// Organiser-made themes (ids starting x-) are drawn like the custom stadium, in their colours.
export function useStadium() {
  const s = useSettings(), cfg = useAppConfig();
  const pick = cfg.themes.enabled.includes(s.stadium) ? s.stadium : cfg.themes.default;
  const made = cfg.themes.custom.find((t) => t.id === pick);
  return made ? { t: 'custom', colors: made } : { t: pick, colors: s.custom };
}
export const STADIUMS = [
  ['day', 'Day', 'Blue skies and a sunlit outfield'],
  ['night', 'Night', 'Under the floodlights'],
  ['international', 'International', 'Stands in both teams’ colours'],
  ['ipl', 'IPL-style', 'LED boards and a party crowd'],
  ['custom', 'Custom', 'Your own colours'],
];

// The stadium behind the match: sky, stands and lights, drawn with gradients. Sits behind everything.
export function Stadium({ teams }) {
  const s0 = useSettings();
  const motion = animationsOn(s0);
  const { t, colors } = useStadium();
  const s = { ...s0, custom: colors };
  const a = teams?.A?.color || '#1C4E9C', b = teams?.B?.color || '#C8102E';
  const sky = { day: 'linear-gradient(180deg,#5FA8E8 0%,#9CCBF0 34%,#2F7A4E 34.5%,#0E281D 70%)',
    night: 'radial-gradient(ellipse at 15% 6%,rgba(255,250,220,.35),transparent 22%),radial-gradient(ellipse at 85% 6%,rgba(255,250,220,.35),transparent 22%),linear-gradient(180deg,#050B1A 0%,#0B1630 30%,#14402B 30.5%,#061510 72%)',
    international: `linear-gradient(180deg,#24364F 0%,#3B5574 28%,#1F5A3A 28.5%,#0A1F17 72%)`,
    ipl: 'radial-gradient(ellipse at 50% 0%,rgba(190,60,255,.45),transparent 45%),linear-gradient(180deg,#140726 0%,#2A0C47 30%,#1A4A30 30.5%,#061510 72%)',
    custom: `linear-gradient(180deg,${s.custom.sky} 0%,${s.custom.sky} 30%,#1F5A3A 30.5%,#0A1F17 72%)` }[t] || '';
  const stands = t === 'international' ? [a, b] : t === 'custom' ? [s.custom.stands, s.custom.accent] : t === 'ipl' ? ['#B03CFF', '#FFD23F'] : t === 'day' ? ['#C9D6E3', '#8FA6BD'] : ['#1D2A44', '#243556'];
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" style={{ background: sky }}>
      {/* The stands: two tiers of seats in a band just above the outfield. */}
      <div className="absolute inset-x-0" style={{ top: '18%', height: '13%', background: `repeating-linear-gradient(90deg, ${stands[0]} 0 14px, ${stands[1]} 14px 28px)`, opacity: t === 'day' ? 0.55 : 0.6, maskImage: 'linear-gradient(180deg,transparent,black 40%)' }} />
      {(t === 'ipl' || t === 'international') && (
        <div className={`absolute inset-x-0 ${motion ? 'led-run' : ''}`} style={{ top: '30%', height: '1.2%', background: `repeating-linear-gradient(90deg, ${stands[0]} 0 40px, ${stands[1]} 40px 80px)`, opacity: 0.85 }} />
      )}
      {t === 'night' && [12, 88].map((x) => <div key={x} className="absolute h-[45%] w-[30%] -translate-x-1/2" style={{ left: `${x}%`, top: 0, background: 'radial-gradient(ellipse at 50% 0%,rgba(255,250,215,.18),transparent 70%)' }} />)}
      {t === 'day' && <div className="absolute h-40 w-40 rounded-full" style={{ right: '8%', top: '2%', background: 'radial-gradient(circle,rgba(255,244,200,.9),rgba(255,244,200,0) 70%)' }} />}
      {/* Mown stripes on the outfield, then a dark fade so the panels stay readable. */}
      <div className="absolute inset-x-0 bottom-0" style={{ top: '31%', background: 'repeating-linear-gradient(90deg,rgba(255,255,255,.035) 0 60px,transparent 60px 120px)' }} />
      <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg,rgba(6,21,16,.15) 0%,rgba(6,21,16,.55) 45%,rgba(6,21,16,.85) 100%)' }} />
    </div>
  );
}

// The wide shot: a band showing the ground (sky, stands, lights, boards and the pitch) above the play panel.
export function StadiumBand({ teams, names }) {
  const s0 = useSettings();
  const motion = animationsOn(s0);
  const { t, colors } = useStadium();
  const s = { ...s0, custom: colors };
  const a = teams?.A?.color || '#1C4E9C', b = teams?.B?.color || '#C8102E';
  const sky = { day: 'linear-gradient(180deg,#4F9BE0,#A9D3F3)', night: 'linear-gradient(180deg,#030814,#0D1A38)', international: 'linear-gradient(180deg,#1E3350,#41618A)', ipl: 'linear-gradient(180deg,#12051F,#3A1060)', custom: `linear-gradient(180deg,${s.custom.sky},${s.custom.sky})` }[t];
  const stands = t === 'international' ? [a, b] : t === 'custom' ? [s.custom.stands, s.custom.accent] : t === 'ipl' ? ['#B03CFF', '#FFD23F'] : t === 'day' ? ['#D7E1EC', '#9DB3C9'] : ['#1D2A44', '#2B3E63'];
  const boards = t === 'ipl' ? ['#B03CFF', '#FFD23F'] : t === 'international' ? [a, b] : t === 'custom' ? [s.custom.accent, s.custom.stands] : t === 'day' ? ['#1F5FBF', '#E0393E'] : ['#13402B', '#FFD23F'];
  return (
    <div aria-hidden className="relative h-28 overflow-hidden rounded-2xl ring-1 ring-pitch-600 sm:h-36" style={{ background: sky }}>
      {t === 'night' && <>{[8, 92].map((x) => <div key={x} className="absolute top-0 h-full w-1/2 -translate-x-1/2" style={{ left: `${x}%`, background: 'radial-gradient(ellipse at 50% 0%,rgba(255,250,215,.4),transparent 60%)' }} />)}
        {[8, 92].map((x) => <div key={`m${x}`} className="absolute top-1 h-3 w-8 -translate-x-1/2 rounded-sm bg-[#FFF8D8] shadow-[0_0_24px_8px_rgba(255,248,216,.6)]" style={{ left: `${x}%` }} />)}</>}
      {t === 'day' && <div className="absolute -top-6 right-6 h-20 w-20 rounded-full" style={{ background: 'radial-gradient(circle,rgba(255,246,205,1),rgba(255,246,205,0) 70%)' }} />}
      {t === 'ipl' && <div className="absolute inset-x-0 top-0 h-full" style={{ background: 'radial-gradient(ellipse at 30% 0%,rgba(255,60,200,.35),transparent 50%),radial-gradient(ellipse at 70% 0%,rgba(60,140,255,.35),transparent 50%)' }} />}
      {/* Stands: rows of seats curving down to the boundary. */}
      <div className="absolute inset-x-0" style={{ top: '22%', height: '40%', background: `repeating-linear-gradient(90deg,${stands[0]} 0 9px,${stands[1]} 9px 18px)`, opacity: 0.75, clipPath: 'ellipse(75% 100% at 50% 100%)' }} />
      {/* Advertising boards along the rope. */}
      <div className={`absolute inset-x-0 flex items-center justify-around font-display text-[10px] font-bold text-white/90 ${motion && (t === 'ipl' || t === 'international') ? 'led-run' : ''}`}
        style={{ top: '58%', height: '9%', background: `repeating-linear-gradient(90deg,${boards[0]} 0 80px,${boards[1]} 80px 160px)` }}>
        <span>FOOTY CRICKET LEAGUE</span><span className="hidden sm:inline">{names?.A} v {names?.B}</span><span>FCL</span>
      </div>
      {/* The outfield and the pitch. */}
      <div className="absolute inset-x-0 bottom-0" style={{ top: '67%', background: 'repeating-linear-gradient(90deg,#2F7A4E 0 30px,#2A6E46 30px 60px)' }} />
      <div className="absolute bottom-0 left-1/2 h-[30%] w-10 -translate-x-1/2" style={{ background: 'linear-gradient(180deg,#C9B27C,#B39A63)', clipPath: 'polygon(20% 0,80% 0,100% 100%,0 100%)' }} />
      {t === 'night' && <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg,transparent 50%,rgba(0,0,0,.25))' }} />}
    </div>
  );
}

export function PresentationSettings({ onClose }) {
  const s = useSettings();
  const cfg = useAppConfig();
  const choices = [...STADIUMS.filter(([k]) => cfg.themes.enabled.includes(k)), ...cfg.themes.custom.filter((x) => cfg.themes.enabled.includes(x.id)).map((x) => [x.id, x.name, 'A stadium from the organisers'])];
  const current = cfg.themes.enabled.includes(s.stadium) ? s.stadium : cfg.themes.default;
  const vol = (k, label) => (
    <label className="flex items-center gap-3 text-sm">
      <span className="w-24 shrink-0">{label}</span>
      <input type="range" min="0" max="1" step="0.05" value={s.sound[k]} disabled={s.sound.muted} className="flex-1 accent-[#FFD23F]"
        onChange={(e) => { setSettings({ sound: { [k]: Number(e.target.value) } }); applyVolumes(); }} aria-label={`${label} volume`} />
      <span className="w-9 text-right tabular-nums text-chalk-dim">{Math.round(s.sound[k] * 100)}</span>
    </label>
  );
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h2 className="font-display text-2xl font-bold">Presentation</h2>{onClose && <button type="button" className="btn-ghost px-3 py-1" onClick={onClose}>Done</button>}</div>
      <p className="text-sm text-chalk-dim">Looks and sounds only, on this device. Nothing here changes how a match is played or scored.</p>
      <div>
        <span className="label">Stadium</span>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {choices.map(([k, l, d]) => (
            <button key={k} type="button" aria-pressed={current === k} onClick={() => setSettings({ stadium: k })}
              className={`rounded-xl p-2.5 text-left ring-2 ${current === k ? 'bg-turf/15 ring-turf' : 'bg-pitch-900/60 ring-pitch-600 hover:ring-pitch-500'}`}>
              <span className="block font-semibold">{l}</span><span className="block text-xs text-chalk-dim">{d}</span>
            </button>
          ))}
        </div>
        {current === 'custom' && (
          <div className="mt-2 flex flex-wrap gap-4 text-sm">
            {[['sky', 'Sky'], ['stands', 'Stands'], ['accent', 'Second colour']].map(([k, l]) => (
              <label key={k} className="flex items-center gap-2">{l}<input type="color" value={s.custom[k]} onChange={(e) => setSettings({ custom: { [k]: e.target.value } })} className="h-8 w-10 rounded bg-transparent" /></label>
            ))}
          </div>
        )}
      </div>
      <div className="space-y-2">
        <span className="label">Sound</span>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!s.sound.muted} onChange={(e) => { unlock(); setSettings({ sound: { muted: !e.target.checked } }); applyVolumes(); if (e.target.checked) setTimeout(() => sfx.cheer(0.8), 50); }} /> Sound on</label>
        {vol('master', 'Master')}{vol('ambience', 'Stadium')}{vol('crowd', 'Crowd')}{vol('effects', 'Effects')}
      </div>
      <div className="space-y-1">
        <span className="label">On screen</span>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.animations} onChange={(e) => setSettings({ animations: e.target.checked })} /> Animations (your device's reduce-motion setting also turns them off)</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.commentary} onChange={(e) => setSettings({ commentary: e.target.checked })} /> Commentary</label>
      </div>
    </div>
  );
}

// A small sheet over the match screen.
export function SettingsSheet({ open, onClose }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={onClose} role="dialog" aria-modal="true" aria-label="Presentation settings">
      <div className="panel max-h-[90dvh] w-full max-w-lg overflow-y-auto rounded-b-none p-5 sm:rounded-b-2xl" onClick={(e) => e.stopPropagation()}>
        <PresentationSettings onClose={onClose} />
      </div>
    </div>
  );
}

// Confetti in the given colours (CSS-only pieces).
function Confetti({ colors, n = 70 }) {
  const pieces = useMemo(() => Array.from({ length: n }, (_, i) => ({ x: Math.random() * 100, d: 1.6 + Math.random() * 1.8, delay: Math.random() * 0.6, c: colors[i % colors.length], r: Math.random() * 360, w: 6 + Math.random() * 6 })), [colors, n]);
  return pieces.map((p, i) => <span key={i} className="confetti absolute top-0 block" style={{ left: `${p.x}%`, width: p.w, height: p.w * 0.45, background: p.c, animationDuration: `${p.d}s`, animationDelay: `${p.delay}s`, transform: `rotate(${p.r}deg)` }} />);
}

// Full-screen moments driven by the match state. They show what has already happened and fade on their own.
export function Moments({ state, after = () => 0 }) {
  const s = useSettings();
  const [m, setM] = useState(null);
  const [seenInnings, setSeenInnings] = useState(null);
  const [seenResult, setSeenResult] = useState(null);
  const count = state?.innings?.length || 0;
  useEffect(() => {
    if (!state) return;
    if (seenInnings == null) { setSeenInnings(count); setSeenResult(state.status); return; } // nothing on first load
    // Wait for the over's reveal to finish flipping before the big screen (the score is already updated).
    const later = (fn) => setTimeout(fn, Math.max(0, after() - Date.now() + 900));
    if (count > seenInnings && count >= 2 && state.status !== 'completed') {
      const prev = state.innings[count - 2], next = state.innings[count - 1];
      later(() => setM({ kind: 'innings', prev, next, key: Math.random() }));
    }
    if (state.status === 'completed' && seenResult !== 'completed') later(() => { setM({ kind: 'win', key: Math.random() }); sfx.win(); });
    setSeenInnings(count); setSeenResult(state.status);
  }, [count, state?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!m) return; const h = setTimeout(() => setM(null), m.kind === 'win' ? 5200 : 3800); return () => clearTimeout(h); }, [m]);
  if (!m || !animationsOn(s)) return null;
  const team = (k) => ({ ...(state.teamMeta?.[k] || {}), name: state.teams[k].name, color: state.teamMeta?.[k]?.color });
  if (m.kind === 'innings') {
    const { prev, next } = m;
    return (
      <div className="pointer-events-none fixed inset-0 z-40 grid place-items-center bg-pitch-900/70" aria-live="polite">
        <div className="pop panel w-[min(92vw,30rem)] p-6 text-center">
          <p className="text-sm text-chalk-dim">{next.superOver ? 'Super over' : 'Innings break'}</p>
          <div className="mt-2 flex items-center justify-center gap-3"><TeamBadge team={team(prev.batting)} size={44} /><span className="font-display text-3xl font-extrabold">{prev.battingName}</span></div>
          <p className="font-display text-6xl font-extrabold tabular-nums text-flood">{prev.runs}/{prev.wickets}</p>
          <p className="text-chalk-dim">{prev.overs} overs</p>
          <p className="mt-3 text-lg">{next.target ? <><b>{next.battingName}</b> need <b>{next.target}</b> to win{state.format !== 'test' ? ` from ${next.maxBalls} balls` : ''}.</> : <><b>{next.battingName}</b> to bat.</>}</p>
        </div>
      </div>
    );
  }
  const w = state.result?.winner;
  const colors = w ? [team(w).color || '#FFD23F', '#FFD23F', '#F2F5EC'] : ['#FFD23F', '#2FD67B', '#F2F5EC'];
  return (
    <div className="pointer-events-none fixed inset-0 z-40 overflow-hidden" aria-live="polite">
      <Confetti colors={colors} />
      <div className="absolute inset-x-0 top-[22%] grid place-items-center">
        <div className="pop panel px-6 py-5 text-center">
          {w && <div className="mx-auto mb-2 w-fit"><TeamBadge team={team(w)} size={64} /></div>}
          <p className="font-display text-4xl font-extrabold text-flood">{w ? `${state.teams[w].name} win!` : state.result?.tie ? 'It’s a tie!' : 'Match over'}</p>
          <p className="mt-1 text-chalk-dim">{state.result?.text}</p>
        </div>
      </div>
    </div>
  );
}

// The trophy, for a tournament's champions. Shown once per tournament on this device.
export function TrophyShow({ tournament }) {
  const s = useSettings();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (tournament?.status !== 'completed' || !tournament.champion) return;
    const k = `fcl_trophy_${tournament.id}`;
    try { if (localStorage.getItem(k)) return; localStorage.setItem(k, '1'); } catch {}
    setShow(true); sfx.win();
    const h = setTimeout(() => setShow(false), 6000);
    return () => clearTimeout(h);
  }, [tournament?.status, tournament?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!show) return null;
  const c = tournament.champion;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-hidden bg-pitch-900/80" onClick={() => setShow(false)} role="dialog" aria-label="Champions">
      {animationsOn(s) && <Confetti colors={[c.color || '#FFD23F', '#FFD23F', '#F2F5EC']} n={110} />}
      <div className="pop text-center">
        <svg viewBox="0 0 120 140" className={`mx-auto h-44 w-40 ${animationsOn(s) ? 'trophy-rise' : ''}`} aria-hidden>
          <defs><linearGradient id="gold" x1="0" x2="1"><stop offset="0" stopColor="#C9A12A" /><stop offset=".5" stopColor="#FFE08A" /><stop offset="1" stopColor="#B88716" /></linearGradient></defs>
          <path d="M30 12h60v26c0 22-14 38-30 38S30 60 30 38z" fill="url(#gold)" />
          <path d="M30 20H14c0 18 8 28 20 30M90 20h16c0 18-8 28-20 30" fill="none" stroke="url(#gold)" strokeWidth="6" />
          <rect x="54" y="76" width="12" height="22" fill="url(#gold)" /><rect x="36" y="98" width="48" height="12" rx="2" fill="url(#gold)" /><rect x="30" y="110" width="60" height="16" rx="3" fill="#13402B" stroke="url(#gold)" strokeWidth="3" />
        </svg>
        <div className="mt-3 flex items-center justify-center gap-3"><TeamBadge team={c} size={48} /><span className="font-display text-5xl font-extrabold text-flood">{c.name}</span></div>
        <p className="mt-1 text-xl text-chalk">{c.human ? 'You are the champions!' : `Champions of ${tournament.name}`}</p>
        <p className="mt-4 text-sm text-chalk-faint">Tap to close</p>
      </div>
    </div>
  );
}
