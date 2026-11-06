// Application configuration that admins manage: which AI levels, personalities and match formats are
// offered, stadium themes, and commentary templates. Stored in app_settings; every value is validated
// here, and the engine enforces it when a match or tournament is created.
import { get, run } from './db.js';

const KEY = 'app_config';
export const LEVELS = ['easy', 'medium', 'hard', 'expert'];
export const PERSONALITIES = ['strategic', 'aggressive', 'defensive', 'unpredictable'];
export const FORMATS = ['test', 't20', 'odi', 'custom'];
export const BUILTIN_THEMES = ['day', 'night', 'international', 'ipl', 'custom'];
// Commentary events whose wording admins can change. Numbers (the score, runs needed, a batter's total)
// are always added by the system from the record, so a template can't state a wrong number.
export const COMMENTARY_EVENTS = {
  wicket: { label: 'Wicket (numbers matched)', forbid: /\b(four|six|dot|not out)\b/i },
  six: { label: 'Six', forbid: /\b(four|out|wicket|dot)\b/i },
  four: { label: 'Four', forbid: /\b(six|out|wicket|dot)\b/i },
  dot: { label: 'Dot ball (0)', forbid: /\b(four|six|out|wicket)\b/i },
  runs: { label: 'Runs (1, 2, 3 or 5)', forbid: /\b(four|six|out|wicket|dot)\b/i },
};
export const PLACEHOLDERS = ['batter', 'bowler', 'bat', 'bowl', 'runs'];

export const DEFAULTS = {
  ai: { levels: [...LEVELS], defaultLevel: 'medium', personalities: [...PERSONALITIES], defaultPersonality: 'strategic' },
  formats: { enabled: [...FORMATS], maxCustomOvers: 50, maxTestDays: 5 },
  themes: { enabled: [...BUILTIN_THEMES], default: 'night', custom: [] }, // custom: [{ id, name, sky, stands, accent }]
  commentary: { enabled: true, templates: {} },                         // templates: { six: ['…', '…'] }
};

let cache = null;
export function getConfig() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse(get('SELECT value FROM app_settings WHERE key = ?', KEY)?.value || '{}'); } catch {}
  cache = {
    ai: { ...DEFAULTS.ai, ...saved.ai }, formats: { ...DEFAULTS.formats, ...saved.formats },
    themes: { ...DEFAULTS.themes, ...saved.themes }, commentary: { ...DEFAULTS.commentary, ...saved.commentary },
  };
  return cache;
}
export const resetCache = () => { cache = null; };

const hex = (v) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v) : null);
const fail = (msg) => { throw new Error(msg); };

// Check and save one section. Returns the stored section.
export function saveSection(section, input) {
  const cur = getConfig();
  let next;
  if (section === 'ai') {
    const levels = [...new Set((input.levels || []).filter((l) => LEVELS.includes(l)))];
    const personalities = [...new Set((input.personalities || []).filter((p) => PERSONALITIES.includes(p)))];
    if (!levels.length) fail('Keep at least one AI difficulty.');
    if (!personalities.length) fail('Keep at least one AI personality.');
    const defaultLevel = levels.includes(input.defaultLevel) ? input.defaultLevel : levels[0];
    const defaultPersonality = personalities.includes(input.defaultPersonality) ? input.defaultPersonality : personalities[0];
    next = { levels: LEVELS.filter((l) => levels.includes(l)), defaultLevel, personalities: PERSONALITIES.filter((p) => personalities.includes(p)), defaultPersonality };
  } else if (section === 'formats') {
    const enabled = FORMATS.filter((f) => (input.enabled || []).includes(f));
    if (!enabled.length) fail('Keep at least one match format.');
    const maxCustomOvers = Math.trunc(Number(input.maxCustomOvers));
    const maxTestDays = Math.trunc(Number(input.maxTestDays));
    if (!(maxCustomOvers >= 1 && maxCustomOvers <= 50)) fail('Custom matches can be 1 to 50 overs.');
    if (!(maxTestDays >= 1 && maxTestDays <= 5)) fail('Test matches can be 1 to 5 days.');
    next = { enabled, maxCustomOvers, maxTestDays };
  } else if (section === 'themes') {
    const custom = (input.custom || []).slice(0, 12).map((t, i) => {
      const name = String(t.name || '').trim().slice(0, 30);
      if (!name) fail('Give every theme a name.');
      const sky = hex(t.sky), stands = hex(t.stands), accent = hex(t.accent);
      if (!sky || !stands || !accent) fail(`Colours for ${name} must be like #1B2A4A.`);
      return { id: `x-${String(t.id || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24) || i}`, name, sky, stands, accent };
    });
    const ids = [...BUILTIN_THEMES, ...custom.map((t) => t.id)];
    const enabled = ids.filter((id) => (input.enabled || []).includes(id));
    if (!enabled.length) fail('Keep at least one stadium.');
    next = { enabled, default: enabled.includes(input.default) ? input.default : enabled[0], custom };
  } else if (section === 'commentary') {
    const templates = {};
    for (const [ev, lines] of Object.entries(input.templates || {})) {
      if (!COMMENTARY_EVENTS[ev]) fail(`Unknown commentary event "${ev}".`);
      const list = (Array.isArray(lines) ? lines : String(lines).split('\n')).map((l) => String(l).trim()).filter(Boolean).slice(0, 10);
      for (const l of list) {
        if (l.length > 160) fail('Keep each line under 160 characters.');
        if (/\d/.test(l)) fail(`Use placeholders, not numbers: "${l}". The system adds every number from the record.`);
        const bad = [...l.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).filter((x) => !PLACEHOLDERS.includes(x));
        if (bad.length) fail(`Unknown placeholder {${bad[0]}}. Use: ${PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}.`);
        if (/[{}]/.test(l.replace(/\{\w+\}/g, ''))) fail(`Check the braces in "${l}".`);
        if (COMMENTARY_EVENTS[ev].forbid.test(l)) fail(`"${l}" describes a different kind of ball than a ${COMMENTARY_EVENTS[ev].label.toLowerCase()}.`);
      }
      if (list.length) templates[ev] = list;
    }
    next = { enabled: input.enabled !== false, templates };
  } else fail('Unknown settings section.');
  const all_ = { ...cur, [section]: next };
  run('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(all_));
  cache = null;
  return getConfig()[section];
}

// What players' devices need to know (no admin detail).
export function publicConfig() {
  const c = getConfig();
  return { ai: c.ai, formats: c.formats, themes: c.themes, commentary: { enabled: c.commentary.enabled } };
}

// Fill a commentary template with the ball's own values.
export function fillTemplate(t, v) { return t.replace(/\{(\w+)\}/g, (_, k) => (v[k] ?? '')); }
