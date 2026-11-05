// CricketData.org (formerly CricAPI) adapter: https://cricketdata.org
// Needs CRICKETDATA_API_KEY. The free plan allows 100 calls a day; one full sync uses roughly 25.
// Returns provider-neutral data; server/sync.js writes it into the database.

const ROLE = (r = '') => {
  const s = r.toLowerCase();
  if (s.includes('wk') || s.includes('keeper')) return 'wk';
  if (s.includes('allrounder') || s.includes('all-rounder') || s.includes('all rounder')) return 'ar';
  if (s.includes('bowl')) return 'bowl';
  if (s.includes('bat')) return 'bat';
  return null;
};
const YEAR = (s) => Number((String(s).match(/(20\d\d)/) || [])[1]) || null;

export function createCricketData({ apiKey, baseUrl = 'https://api.cricapi.com/v1', fetchImpl = fetch, maxSeries = 20 }) {
  let calls = 0;
  async function call(endpoint, params = {}) {
    const qs = new URLSearchParams({ apikey: apiKey, offset: '0', ...params });
    const res = await fetchImpl(`${baseUrl}/${endpoint}?${qs}`, { headers: { accept: 'application/json' } });
    calls += 1;
    if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status}`);
    const body = await res.json();
    if (body.status && body.status !== 'success') throw new Error(`${endpoint}: ${body.reason || body.status}`);
    return body.data ?? [];
  }
  const squadsOf = (data) => (Array.isArray(data) ? data : []).map((t) => ({
    team: { name: t.teamName || t.name, short: t.shortname || t.shortName || null, logo: t.img || t.image || null, extId: t.id || null },
    players: (t.players || t.squad || []).filter((p) => p && (p.id || p.name)).map((p) => ({
      extId: p.id || `name:${p.name}`, name: p.name, role: ROLE(p.role || p.playingRole), batting: p.battingStyle || null,
      bowling: p.bowlingStyle || null, country: p.country || null, image: p.playerImg && !/icon512/.test(p.playerImg) ? p.playerImg : null,
    })),
  }));

  return {
    name: 'cricketdata',
    get calls() { return calls; },
    // IPL: the latest "Indian Premier League" series and its squads.
    async ipl() {
      const series = (await call('series', { search: 'Indian Premier League' }))
        .filter((s) => /indian premier league/i.test(s.name) && !/women/i.test(s.name))
        .sort((a, b) => (YEAR(b.name) || 0) - (YEAR(a.name) || 0) || String(b.startDate).localeCompare(String(a.startDate)));
      const latest = series[0];
      if (!latest) throw new Error('No IPL series found.');
      const year = YEAR(latest.name);
      return { season: { id: `ipl-${year}`, name: `IPL ${year}`, year, extId: latest.id }, squads: squadsOf(await call('series_squad', { id: latest.id })) };
    },
    // International: the most recent squad for each national team, from the latest series that have squads.
    async international(knownTeamNames) {
      const pages = [];
      for (const offset of ['0', '25', '50']) pages.push(...(await call('series', { offset })));
      const isNational = (n) => knownTeamNames.some((k) => n.toLowerCase().includes(k.toLowerCase()));
      const candidates = pages
        .filter((s) => (s.squads ?? 1) > 0 && !/women|u19|under-19|premier league|super league|bash|t10|county|ranji|trophy \d/i.test(s.name) && isNational(s.name))
        .sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)))
        .slice(0, maxSeries);
      const latestByTeam = new Map();
      for (const s of candidates) {
        let sq;
        try { sq = squadsOf(await call('series_squad', { id: s.id })); } catch { continue; }
        for (const t of sq) {
          if (!t.team.name || /women|\bA\b|u19|xi$/i.test(t.team.name) || latestByTeam.has(t.team.name.toLowerCase())) continue;
          if (t.players.length >= 8) latestByTeam.set(t.team.name.toLowerCase(), t);
        }
      }
      return { season: { id: 'int-current', name: 'Current international squads', year: new Date().getFullYear() }, squads: [...latestByTeam.values()] };
    },
  };
}
