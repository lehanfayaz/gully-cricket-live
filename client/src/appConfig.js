// The admin's settings that shape what players are offered (formats, AI options, stadiums, commentary).
// Fetched once; the server enforces the same rules, so this only keeps the screens in step.
import { useEffect, useState } from 'react';
import { api } from './api.js';

const FALLBACK = {
  ai: { levels: ['easy', 'medium', 'hard', 'expert'], defaultLevel: 'medium', personalities: ['strategic', 'aggressive', 'defensive', 'unpredictable'], defaultPersonality: 'strategic' },
  formats: { enabled: ['test', 't20', 'odi', 'custom'], maxCustomOvers: 50, maxTestDays: 5 },
  themes: { enabled: ['day', 'night', 'international', 'ipl', 'custom'], default: 'night', custom: [] },
  commentary: { enabled: true },
};
let cached = null, pending = null;
const listeners = new Set();
export function loadAppConfig(force = false) {
  if (pending && !force) return pending;
  pending = api('/api/config').then((c) => { cached = c; for (const l of listeners) l(c); return c; }).catch(() => FALLBACK);
  return pending;
}
export function useAppConfig() {
  const [c, set] = useState(cached || FALLBACK);
  useEffect(() => { listeners.add(set); if (!cached) loadAppConfig(); return () => listeners.delete(set); }, []);
  return c;
}
export const getAppConfig = () => cached || FALLBACK;
