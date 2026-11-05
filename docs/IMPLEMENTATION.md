# How FOOTY CRICKET LEAGUE works

A reference for anyone changing the game. It describes the code as it is, where each rule is enforced, and how each rule is verified.

## Architecture

| Part | File | Role |
|---|---|---|
| Web server, real-time | `server/index.js` | Express REST API, Socket.IO events, auth, admin endpoints, AI scheduling, broadcasting state |
| Rules engine | `server/engine.js` | Every match action: creation, lineups, toss, submissions, reveal, innings, sessions, suspension, results, chat. Clients only send intents. |
| Digit rules | `server/rules.js` | Which numbers each role may pick per format, and the bowler repetition rule. Mirrored in `client/src/rules.js` only to grey out buttons. |
| AI player | `server/ai.js` | Chooses numbers from public information only, then calls the same engine functions as a person |
| Database | `server/db.js` | SQLite (Node's built-in `node:sqlite`), schema and in-place upgrades |
| Cricket data | `server/cricketdb.js`, `server/sync.js`, `server/providers/cricketdata.js` | Teams, squads and the daily sync |
| Stats | `server/stats.js` | Profiles, records and leaderboards from the ball records |
| Client | `client/src/…` | React screens; no game logic beyond display |

Every engine action runs inside one SQLite transaction (`tx` in `db.js`, `BEGIN IMMEDIATE`). The server is a single Node process, so actions on a match are applied one at a time: two submissions can never interleave.

## Match lifecycle

1. **Create** (`createMatch`): format, play style (complete over or ball by ball, fixed for the match), umpire or not, who plays (team match, me v a friend, me v the AI), custom or real teams.
2. **Lobby:** players join from the link; captains arrange batting and bowling orders and **confirm** (`confirmLineup`). A change before the toss resets that confirmation (`lineupChanged`).
3. **Toss** (`callToss`, `decideToss`): unlocks only when both lineups are confirmed. The system picks the caller; the coin is flipped on the server; the winner chooses bat or bowl. Quick matches can skip the toss and pick bat or bowl directly (recorded as such).
4. **Live:** for each submission the engine works out who must submit (`submitOver`); when both sides are in, `reveal` scores every ball in one transaction; `progress` handles wickets, overs, innings and sessions.
5. **Result** (`finishMatch`): result text, status `completed`, all balls kept for stats.

## Where each rule lives

| Rule | Where |
|---|---|
| Numbers each role may pick (Test: batter 0,1,2,3,4,6; bowler 1,2,3,4,6. Limited: 1–6 both) | `rules.js` `LIMITED` / `TEST`, enforced by `checkDigits` in `submitOver` |
| Bowler repetition: one number up to 3 times, every other up to 2, never 4 | `checkDigits` (server), counted over `bowledThisOver(inn)` plus the new submission |
| Repetition resets after a wicket and at a new over; ball count does not | `bowledThisOver`: only balls in the current over **after the last wicket in it**. The over's ball count comes from `totals()` and is unaffected. |
| How many numbers a submission needs | `capFor`: balls left in the over (never past the innings' or Test session's end); 1 in ball-by-ball play |
| No duplicate submissions | `submitOver` refuses a second lock-in for the same side of an open submission; client re-sends are idempotent failures |
| Hidden until both are in | Open submissions are never in `publicState`; each player only gets their own numbers back via `privateState`. SHA-256 fingerprints are published, and sequences and salts are revealed after |
| Test dot-over rule | `reveal`: after the 6th legal ball of an over, `isDotOver` creates a `dot_rules` row for the next over; balls 1–2 of that over meet, cancel (wicket) or break it. `endTestInnings` cancels open ones. No umpire: out (`dismissal = 'dot_rule'`, not credited to the bowler). Umpire: play held until a ruling. |
| Sessions | `capFor` keeps a submission within the session; `sessionCheck` ends it after its overs; `endSession` records a summary and pauses (or rolls on if that break is switched off). Innings are independent of sessions. |
| Suspend / resume | `testAction` `suspend` saves `status_before` in `suspensions`; `resume` restores exactly that status. Nothing advances automatically. Open submissions and requirements stay in the database. |

## Data integrity

- All scoring is calculated on the server from the stored digits; clients never send runs or wickets.
- Each action is one transaction: a crash mid-action leaves the previous consistent state.
- Completed balls are rows in `balls`; disconnecting loses nothing. On reconnect the client receives the full public state, its own private state and chat history (`match:open`).
- Corrections (umpire void/adjust) are recorded in `audit` and announced.

## Verification

`npm test` runs four suites against a real server with real socket clients:

| Suite | Covers |
|---|---|
| `test/match.test.js` | Limited overs: lineup confirmation, toss, complete-over and ball-by-ball play, remaining-ball digit counts, repetition rule, wicket reset (444663 → 4443), umpire tools, chat, reconnection |
| `test/testmatch.test.js` | Test digits, sessions, suspend/resume, day changes, dot-over rule (no-umpire and umpire rulings), declarations, follow-on, innings win, draw |
| `test/rules.test.js` | Every rule example from the specification, in both formats and both play styles, through the real engine, including repetition tracking across a mid-over session break and suspension |
| `test/ai.test.js` | AI rule compliance (fuzzed), AI never seeing hidden picks, one-v-one and real-team matches, data sync, Quick Match |
