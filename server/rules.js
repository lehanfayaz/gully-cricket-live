// Which numbers each player may pick, by match format. Kept separate from the match flow
// so limited-overs and Test rules can't leak into each other. Used by the server (authoritative)
// and mirrored in the client only to grey out buttons.

export const LIMITED = {
  batter: [1, 2, 3, 4, 5, 6],
  bowler: [1, 2, 3, 4, 5, 6],
  maxRepeatPerOver: 3, // see checkDigits: one number may be used 3 times per over, every other at most twice
};

export const TEST = {
  batter: [0, 1, 2, 3, 4, 6], // 0 is a deliberate dot ball; no 5
  bowler: [1, 2, 3, 4, 6],    // no 0, no 5
  maxRepeatPerOver: 3,        // same repetition rule as limited overs: only the available numbers differ
};

export const isTest = (config) => config.format === 'test';
export const rulesFor = (config) => (isTest(config) ? TEST : LIMITED);

// Validate one submission. `alreadyThisOver` is the bowler's numbers already bowled (revealed, legal) in this over.
// Returns an error message, or null if it's fine.
export function checkDigits(config, role, seq, alreadyThisOver = []) {
  const rules = rulesFor(config);
  const allowed = role === 'bowl' ? rules.bowler : rules.batter;
  const bad = seq.find((n) => !allowed.includes(n));
  if (bad !== undefined) {
    return `${role === 'bowl' ? 'Bowlers' : 'Batters'} can pick ${allowed.join(', ')}${isTest(config) ? ' in a Test match' : ''}. ${bad} isn't allowed.`;
  }
  if (role === 'bowl' && rules.maxRepeatPerOver) {
    // Bowler repetition rule, per over: no number more than 3 times, and only ONE number may reach 3.
    const max = rules.maxRepeatPerOver;
    const counts = {};
    for (const n of [...alreadyThisOver, ...seq]) counts[n] = (counts[n] || 0) + 1;
    const before = (d) => alreadyThisOver.filter((n) => n === Number(d)).length;
    const tooMany = Object.entries(counts).find(([, c]) => c > max);
    if (tooMany) {
      const used = before(tooMany[0]);
      return `A bowler can use a number at most ${max} times in an over. ${tooMany[0]} would be used ${tooMany[1]} times${used ? ` (${used} already bowled this over)` : ''}.`;
    }
    const triples = Object.entries(counts).filter(([, c]) => c === max).map(([d]) => d);
    if (triples.length > 1) {
      const already = triples.filter((d) => before(d) === max);
      return `Only one number can be used ${max} times in an over; the rest at most twice. ${triples.join(' and ')} would both be used ${max} times${already.length ? ` (${already.join(' and ')} ${already.length > 1 ? 'have' : 'has'} already been used ${max} times this over)` : ''}.`;
    }
  }
  return null;
}

// Dot-over rule (Tests only): a batter who faces all six legal balls of an over without scoring
// must score off one of the first two legal balls of the next over.
export function isDotOver(overBalls, batterId) {
  return overBalls.length === 6 && overBalls.every((b) => b.batter_id === batterId && b.runs === 0 && !b.is_wicket);
}
