// Which numbers each player may pick, by match format. Kept separate from the match flow
// so limited-overs and Test rules can't leak into each other. Used by the server (authoritative)
// and mirrored in the client only to grey out buttons.

export const LIMITED = {
  batter: [1, 2, 3, 4, 5, 6],
  bowler: [1, 2, 3, 4, 5, 6],
  maxRepeatPerOver: 3, // a bowler can't pick the same number more than 3 times in one over
};

export const TEST = {
  batter: [0, 1, 2, 3, 4, 6], // 0 is a deliberate dot ball; no 5
  bowler: [1, 2, 3, 4, 6],    // no 0, no 5
  maxRepeatPerOver: 3,        // same limit as limited overs: only the available numbers differ
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
    const counts = {};
    for (const n of [...alreadyThisOver, ...seq]) counts[n] = (counts[n] || 0) + 1;
    const over = Object.entries(counts).find(([, c]) => c > rules.maxRepeatPerOver);
    if (over) {
      const used = alreadyThisOver.filter((n) => n === Number(over[0])).length;
      return `A bowler can use each number at most ${rules.maxRepeatPerOver} times in an over. ${over[0]} would be used ${over[1]} times${used ? ` (${used} already bowled this over)` : ''}.`;
    }
  }
  return null;
}

// Dot-over rule (Tests only): a batter who faces all six legal balls of an over without scoring
// must score off one of the first two legal balls of the next over.
export function isDotOver(overBalls, batterId) {
  return overBalls.length === 6 && overBalls.every((b) => b.batter_id === batterId && b.runs === 0 && !b.is_wicket);
}
