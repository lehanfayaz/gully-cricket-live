// Match sounds, synthesised in the browser (no audio files): stadium ambience, crowd reactions, wicket,
// boundary, six and match-winning sounds. Each has its own volume, under a master volume and mute.
// Nothing here waits on, or holds up, the match: sounds fire alongside what's already on screen.
import { getSettings } from './settings.js';

let ctx = null, master, buses = {}, ambience = null, noiseBuf = null;

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain(); master.connect(ctx.destination);
  for (const k of ['ambience', 'crowd', 'effects']) { buses[k] = ctx.createGain(); buses[k].connect(master); }
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  applyVolumes();
  return ctx;
}
export function applyVolumes() {
  if (!ctx) return;
  const s = getSettings().sound;
  const t = ctx.currentTime;
  master.gain.setTargetAtTime(s.muted ? 0 : s.master, t, 0.05);
  for (const k of ['ambience', 'crowd', 'effects']) buses[k].gain.setTargetAtTime(s[k], t, 0.05);
}
// Browsers only allow sound after a tap; call this from a click (e.g. the sound toggle).
export function unlock() { const c = ensure(); if (c?.state === 'suspended') c.resume(); }
const live = () => { const s = getSettings().sound; return ctx && !s.muted && s.master > 0 && ctx.state === 'running'; };

function noise({ bus, dur, gain, type = 'bandpass', freq = 1000, q = 0.7, attack = 0.01, sweep }) {
  const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain(); const t = ctx.currentTime;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + dur);
  src.connect(f).connect(g).connect(buses[bus]); src.start(t); src.stop(t + dur + 0.05);
}
function tone({ bus = 'effects', freq, dur, gain = 0.2, type = 'sine', at = 0, to }) {
  const o = ctx.createOscillator(); o.type = type; const g = ctx.createGain(); const t = ctx.currentTime + at;
  o.frequency.setValueAtTime(freq, t); if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(buses[bus]); o.start(t); o.stop(t + dur + 0.05);
}

// A low crowd murmur that loops while you're on the match screen.
export function startAmbience() {
  ensure();
  if (!ctx || ambience) return;
  const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 450; f.Q.value = 0.5;
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.15; const lg = ctx.createGain(); lg.gain.value = 120; lfo.connect(lg).connect(f.frequency);
  const g = ctx.createGain(); g.gain.value = 0.18;
  src.connect(f).connect(g).connect(buses.ambience); src.start(); lfo.start();
  ambience = { src, lfo };
}
export function stopAmbience() { if (!ambience) return; try { ambience.src.stop(); ambience.lfo.stop(); } catch {} ambience = null; }

export const sfx = {
  lock() { if (!live()) return; tone({ freq: 660, dur: 0.08, gain: 0.08, type: 'triangle' }); tone({ freq: 990, dur: 0.1, gain: 0.06, type: 'triangle', at: 0.06 }); },
  tick() { if (!live()) return; tone({ freq: 1200, dur: 0.04, gain: 0.04, type: 'square' }); },
  bat() { if (!live()) return; noise({ bus: 'effects', dur: 0.12, gain: 0.5, freq: 2500, q: 2 }); tone({ freq: 180, dur: 0.12, gain: 0.25, type: 'triangle', to: 90 }); },
  cheer(size = 1) { if (!live()) return; noise({ bus: 'crowd', dur: 1.2 + size, gain: 0.25 * size, freq: 900, q: 0.4, attack: 0.15, sweep: 1400 }); },
  groan() { if (!live()) return; noise({ bus: 'crowd', dur: 1.4, gain: 0.2, freq: 600, q: 0.6, attack: 0.2, sweep: 300 }); },
  wicket() {
    if (!live()) return;
    noise({ bus: 'effects', dur: 0.25, gain: 0.6, type: 'highpass', freq: 1800 });                       // stumps clatter
    tone({ freq: 140, dur: 0.3, gain: 0.35, type: 'sine', to: 60 });
    setTimeout(() => sfx.cheer(1.3), 120);
  },
  four() { if (!live()) return; sfx.bat(); setTimeout(() => sfx.cheer(1), 150); },
  six() { if (!live()) return; sfx.bat(); tone({ freq: 300, dur: 0.6, gain: 0.08, type: 'sine', to: 1200, at: 0.05 }); setTimeout(() => sfx.cheer(1.6), 200); },
  win() {
    if (!live()) return;
    [523, 659, 784, 1046].forEach((f, i) => tone({ freq: f, dur: 0.35, gain: 0.14, type: 'triangle', at: i * 0.14 }));
    tone({ freq: 1046, dur: 0.9, gain: 0.12, type: 'triangle', at: 0.56 });
    sfx.cheer(2);
  },
  coin() { if (!live()) return; for (let i = 0; i < 6; i++) tone({ freq: 2400 + i * 80, dur: 0.05, gain: 0.03, type: 'square', at: i * 0.09 }); },
};
