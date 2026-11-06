// Presentation settings, kept on this device. They are purely cosmetic: nothing here reaches the server
// or changes how a match is played or scored.
import { useEffect, useState } from 'react';

const KEY = 'fcl_presentation';
export const DEFAULTS = {
  stadium: null,                    // null = the organisers' default; day | night | international | ipl | custom | x-… (organiser themes)
  custom: { sky: '#1B2A4A', stands: '#7A4FD6', accent: '#FFD23F' },
  animations: true,
  commentary: true,
  sound: { muted: true, master: 0.8, ambience: 0.35, crowd: 0.7, effects: 0.8 },
};
let current = load();
const listeners = new Set();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...DEFAULTS, ...s, custom: { ...DEFAULTS.custom, ...s.custom }, sound: { ...DEFAULTS.sound, ...s.sound } };
  } catch { return { ...DEFAULTS }; }
}
export const getSettings = () => current;
export function setSettings(patch) {
  current = { ...current, ...patch, custom: { ...current.custom, ...patch.custom }, sound: { ...current.sound, ...patch.sound } };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch {}
  for (const fn of listeners) fn(current);
}
export function useSettings() {
  const [s, set] = useState(current);
  useEffect(() => { listeners.add(set); return () => listeners.delete(set); }, []);
  return s;
}
// Animations are off when the person turns them off here or asks their device for reduced motion.
export const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
export const animationsOn = (s = current) => s.animations && !reducedMotion();
