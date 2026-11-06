// Check the database and every match:  npm run integrity
const { runIntegrity } = await import('../integrity.js');
const r = runIntegrity('cli');
console.log(r.ok ? `All good: ${r.matches} matches checked.` : `${r.problemCount} problems found:`);
for (const p of r.problems) console.log(` - ${p.matchId || ''} ${p.kind}: ${p.detail}`);
process.exit(r.ok ? 0 : 1);
