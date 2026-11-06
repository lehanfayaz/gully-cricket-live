# How FOOTY CRICKET LEAGUE works

A reference for anyone changing the game. It describes the code as it is, where each rule is enforced, and how each rule is verified.

## Architecture

| Part | File | Role |
|---|---|---|
| Web server, real-time | `server/index.js` | Express REST API, Socket.IO events, auth, admin endpoints, AI scheduling, broadcasting state |
| Rules engine | `server/engine.js` | Every match action: creation, lineups, toss, submissions, reveal, innings, sessions, suspension, results, chat. Clients only send intents. |
| Digit rules | `server/rules.js` | Which numbers each role may pick per format, and the bowler repetition rule. Mirrored in `client/src/rules.js` only to grey out buttons. |
| AI player | `server/ai.js` | Reads public state and revealed balls only, then acts through the same engine functions as a person |
| Security | `server/security.js` | Roles and permissions, sessions, rate limits, security headers, audit and error logs |
| Admin | `server/admin.js` | Users, matches, notifications, overview |
| Configuration | `server/config.js` | Admin-managed AI options, formats, stadiums, commentary templates (validated, enforced on match creation) |
| Backups | `server/backup.js`, `server/tools/` | Automatic verified backups, restore at start-up, command-line backup, restore and integrity tools |
| Integrity | `server/integrity.js` | Database and per-match checks from first principles |
| Squad import | `server/importer.js` | Spreadsheet import through the sync pipeline |
| Career | `server/career.js` | Achievements and challenges as data-driven rules, levels, milestones |
| Commentary | `server/commentary.js` | Ball-by-ball commentary written from the saved deliveries |
| Tournaments | `server/tournament.js` | Fixtures, standings, net run rate, qualification, bracket, AI v AI play, tournament stats |
| Statistics and analysis | `server/analytics.js` | Careers, match analysis, ball-by-ball replay and highlights, all derived from the saved deliveries |
| AI decisions | `server/aibrain.js` | Pure decision functions (no database or engine access): opponent models, difficulty, personality, situation, captaincy |
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

## Career: profile, levels, achievements and challenges

**Profile.**
- Picture: resized on the device to a 256px JPEG and stored in `users.avatar`. It's served by `GET /api/users/:id/avatar`; for real squad players, that endpoint uses the photo from the cricket database.
- Favourite international team and IPL franchise.
- Career figures, all from `analytics.career`.
- Tournament wins.

**Achievements and challenges are data.** Each is a rule in the `achievements` / `challenges` tables, checked by a generic evaluator (`career.evaluate`) against per-match facts computed from completed matches (`career.matchFacts`), or against tournaments won.

Rule types:
- `max`: the best value in one match.
- `sum`: a total across matches.
- `count`: matches meeting the conditions.
- `streak`: consecutive matches meeting them.
- `tournaments`: tournaments won.

Fields: runs, balls, fours, sixes, bestKnock, wicketsTaken, bestSpell, conceded, wicketsLost.

Conditions: won, format, overs, maxOvers, vsAI, aiLevel, maxWicketsLost, hatTrick, teamCategory, tournament (and, for tournaments, allIpl and kind).

Admins add, edit and switch them off on the admin page, with no code changes. A new rule applies to past matches straight away. An unlock is stored once, dated when the qualifying match or tournament ended, linked to it, and never taken away.

**Challenges.** Daily and weekly challenges count only matches in the current period (UTC days, and weeks from Monday). Up to three of each are shown, rotating with the date. Long-term challenges count all matches.

**Levels: Rookie, Amateur, Professional, Elite, Legend.** Each level needs both experience and a number of achievements, so starting matches alone never levels you up. Experience comes from:
- Runs, and 15 per wicket.
- Wins, worth more against harder AI.
- Achievement and challenge XP.

## Broadcast presentation

All of this is client-side and cosmetic. Settings are stored on the device (`client/src/settings.js`), and nothing in them reaches the server or changes play.

- **Stadiums:**
  - Day, night, international (both teams' colours), IPL-style and custom colours.
  - Shown as a backdrop and as a wide shot above the play panel.
- **Animations:**
  - The coin toss.
  - A stamp when you lock in.
  - Ball-by-ball reveal flips.
  - Wicket, four (ball to the rope) and six (ball into the stands).
  - The innings-break card, confetti for the winner, and the tournament trophy.

  They trigger from state that has already updated, never hold anything up, and are off when the device asks for reduced motion or the setting is off.
- **Team presentation:** logos, colours, names, player names, and pictures for the batter and bowler on the scoreboard (uploaded picture, squad photo, or initials).
- **Sound (`client/src/sound.js`):** synthesised in the browser: ambience, crowd, wicket, boundary, six and win. There are separate volumes for stadium, crowd and effects, under a master volume and mute. It's off until the player turns it on.
- **Commentary (`server/commentary.js`):**
  - Written on the server from the same ball records as the scorecard, so its numbers always match.
  - Covers the score, a batter's total when out, the runs and balls needed, milestones, crucial wickets, Test day and session starts, and the six-ball dot over and the two-ball scoring requirement.
  - Wording varies, but stays fixed for each ball.
  - Players can turn it off; the plain ball-by-ball line is then shown instead.

## Tournaments against the AI

**Formats.**
- Knockout: byes go to the top seeds when the field isn't a power of two.
- Round robin: once or home and away, then top wins, a final, or semis.
- Groups then knockout: snake-seeded groups, with cross-group pairings so teams from one group only meet again in the final.
- Custom: 0–4 groups, legs, qualifiers per group, and an optional third-place play-off.

All four are built from one structure (`groups`, `legs`, `qualify`, `thirdPlace`).

**Every fixture is a real match.** `createTournamentMatch` creates the match through the engine:
- The human's team is side A, controlled by the human.
- Each AI team is a bot with its own difficulty and personality (`config.aiSides`).
- AI v AI fixtures (`participation: 'aivai'`) are played by `aiStep` for both bots, ball by ball, through the same validation.
- Knockouts set `untilWinner`, so a tied super over leads to another, as in the ICC rules.
- Tournament matches can't have a result declared or runs adjusted. They can only be abandoned, which counts as no result; in a knockout the higher seed then goes through.

**Nothing is stored that can drift.** `tournament_fixtures` records which match each fixture is, and its winner. Standings, net run rate and qualification are recomputed from the completed matches on every view (`standings`).
- Points: 2 for a win, 1 for a tie or no result.
- Net run rate: a side bowled out counts its full overs; no-result matches are left out.
- Ties on points are split by NRR.
- "Qualified" and "Out" are shown only once mathematically certain (on points); otherwise the table shows where a team currently stands.

Knockout places resolve from their sources (group rank, winner or loser of a fixture, or bye) as soon as those are final (`syncIn`).

**Persistence.** Everything is in the database:
- Leaving and coming back reopens the dashboard exactly as it was.
- "Resume your match" reopens the human's match where it stopped.
- An AI match interrupted by a restart carries on from its saved state.

**Endpoints.**
- `GET /api/tournaments/mine`, `POST /api/tournaments`, `GET /api/tournaments/:id`.
- `POST /api/tournaments/:id/play`: the human's next match, once earlier fixtures are done.
- `POST /api/tournaments/:id/simulate`: AI fixtures up to the human's next match, or `{limit: 1}` for one.
- `POST /api/tournaments/:id/abandon`.

**Pages.** `/t/new` (the wizard) and `/t/:id` (the dashboard: overview, fixtures, table, bracket, teams, stats, and the final's scorecard).

## Statistics, replay and highlights

**Source of truth.** Every figure comes from the `balls` table (revealed deliveries only), plus the umpire's run adjustments recorded in `audit` (`adjust_runs`). Voided deliveries appear in the replay, marked, and are never counted. Nothing is estimated: a figure with nothing to count is shown as a dash, never as zero.

**Who gets credit.** In real-team matches, deliveries are played by squad players that a person or the AI controls. Career figures credit the controller (`members.controller_id`); match figures name the squad player. The leaderboard uses the same rule. Super overs are kept out of career figures but shown in the match.

**Definitions.** A knock is one batter's stint between two wickets (`balls.stint`). A dot ball is a delivery with no runs, wickets included. A maiden is a complete six-ball over by one bowler with no runs. A partnership is the runs added for a wicket; one batter faces at a time, so it names who was in. Bowlers are not credited with dot-over-rule dismissals.

**Endpoints.**
- `GET /api/users/:id/career`: career summary, batting, bowling, splits by format, team and AI opponent, recent form and career bests.
- `GET /api/matches/:id/analysis`: innings summaries, cards, fall of wickets, partnerships, best players, Test sessions and days, and highlights.
- `GET /api/matches/:id/replay`: the timeline of deliveries, over ends, sessions, adjustments and innings transitions, with the running score.

**Pages.** The career dashboard is at `/u/:id`; match analysis is at `/m/:id/stats`, with Summary, Scorecard, Replay and Highlights tabs. Each highlight opens the replay at its delivery.

## AI opponent

Difficulty (`aiLevel`) and personality (`aiPersonality`) are separate settings, chosen in the match wizard and in Quick Match, and shown in the AI's name.

**What it may see.** `ai.js` reads `publicState` and the `balls` table, which only holds balls that have been revealed. It never reads the `sets` table, so it never sees a submission that is still hidden. `aibrain.js` has no database access at all: it works only on what it is handed. Expert also reads the human's revealed balls from their earlier matches. The AI always submits through `submitOver`, with the same validation as a person.

**Difficulty**, by how it reads the opponent:

| Level | Opponent model | Uses the repetition rule | Reads the situation | Randomness |
|---|---|---|---|---|
| Easy | None (uniform) | No | No | High |
| Medium | Overall frequency, half-trusted | Yes (digits the bowler can't use are safe) | Half | Medium |
| Hard | Recency + what follows their last pick + habits by ball position | Yes | Fully | Low; plans its one triple, avoids needless dot overs |
| Expert | Seven predictors scored on how well each has predicted this opponent's recent picks, trusting whichever has been right | Yes | Fully | Lowest |

**Personality** shifts the trade-offs: Aggressive (cheaper wickets, bigger numbers, hunts wickets, bats first, picks an extra batter); Defensive (protects its wicket, bowls tight, picks an extra bowler, declares later); Unpredictable (more randomness and deliberate surprise, may shuffle the batting order); Strategic (balanced, weighs the situation most).

**Situation.** A wicket's cost in runs depends on the chase rate, the overs left per wicket in hand, the last wicket, and in Tests whether a win is still possible.

**Captaincy.** It picks its XI for the format and its personality, sets the batting and bowling orders, chooses the next bowler from this innings' figures (wicket-takers early, economy at the death, never two overs in a row, with the workload spread), and handles the toss, follow-on and declarations.

Each AI action is logged in `ai_decisions`. If the AI ever needed its fallback, that would be logged as `fallback`, and the grid test asserts it never happens.

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
| `test/admin.test.js` | Declaring at any time; roles and permissions; suspension; sessions; passwords; rate limits; headers; configuration enforced; commentary templates; tamper guards; integrity checks catching tampering; match management; audit log; sync identity, duplicates and merging; backups and restore in a real process; spreadsheet import |
| `test/career.test.js` | Achievements and challenges earned in real matches and a tournament, dated and linked to the match; admin rules applying without code changes; levels; profile picture and favourite teams |
| `test/broadcast.test.js` | Every commentary line checked against the scorecard and replay (Test dot-over rule, umpire adjustments and voided overs, AI v AI in each format) |
| `test/tournament.test.js` | Complete tournaments of every kind from first fixture to champion with no manual edits; tables recomputed independently; byes; repeated super overs; fairness; resuming in a new process |
| `test/analytics.test.js` | Replay rebuilt into every scorecard (19 matches incl. Tests, real teams, voided overs and umpire adjustments); every career figure recounted directly from the balls table |
| `test/aigrid.test.js` | Every difficulty × personality played as complete matches (Test, T20, ODI, Quick × complete over and ball by ball, 128 matches) and audited ball by ball; fairness; strength and personality differences; 8,000 fuzzed decisions |


## Automated test coverage (Phase 7 checklist)

`npm test` runs eleven suites. Where each required area is covered:

| Area | Where |
|---|---|
| Digit restrictions (every format, both roles) | `rules.test.js`; every ball of every simulated match in `aigrid.test.js` and `tournament.test.js`; `integrity.js` checks |
| Bowler repetition limits | `rules.test.js` (all patterns), AI fuzz in `ai.test.js` and `aigrid.test.js` |
| Wicket-based repetition resets | `rules.test.js` (the 444663 example and others) |
| Over progression and incomplete overs | `rules.test.js`, `match.test.js` (submission sized to balls left, innings ending mid-over), `analytics.test.js` (partial overs in the replay) |
| Test sessions, suspension and resumption | `testmatch.test.js`, `admin.test.js` (declaring in breaks and suspensions) |
| Consecutive dot-over scoring requirement | `testmatch.test.js`, `broadcast.test.js` |
| AI submissions | `ai.test.js`, `aigrid.test.js` (128 complete matches, fairness, strength) |
| Tournament progression | `tournament.test.js` (every format to a champion, resuming in a new process) |
| Statistics | `analytics.test.js` (every figure recounted from the balls table) |
| Replay consistency | `analytics.test.js` (replay rebuilt into the scorecard for every match) |
| Achievements | `career.test.js` |
| Security, admin and recovery | `admin.test.js` |
