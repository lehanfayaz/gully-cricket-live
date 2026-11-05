// Mirror of server/rules.js, only used to show the right buttons. The server re-checks everything.
export const digitsFor = (state, role) => (state.format === 'test'
  ? (role === 'bowl' ? [1, 2, 3, 4, 6] : [0, 1, 2, 3, 4, 6])
  : [1, 2, 3, 4, 5, 6]);
// Bowlers, every format, per over: one number may be used 3 times, every other number at most twice.
export const repeatLimit = (state, role) => (role === 'bowl' ? 3 : null);
// Would adding `n` to the over (already bowled + picked so far) break the rule?
export function wouldBreak(n, soFar, limit = 3) {
  if (!limit) return false;
  const counts = {};
  for (const x of soFar) counts[x] = (counts[x] || 0) + 1;
  const next = (counts[n] || 0) + 1;
  if (next > limit) return true;
  return next === limit && Object.entries(counts).some(([d, c]) => Number(d) !== n && c >= limit);
}
