# FOOTY CRICKET LEAGUE

A real-time multiplayer number-cricket game that runs in the browser. One person creates a match and umpires, friends join from a link on their own phones, and everything happens in the app: sealing the bowler's numbers, batting, chat, notifications, scoring, and saved stats. No WhatsApp needed.

## How a match runs

1. The creator picks the format, the **play style** (complete over or ball by ball, fixed for the match) and whether there's an **umpire**.
2. Friends join from the link and pick a team. The first player in each team is captain.
3. Each captain arranges the batting order (the top player opens) and the bowling order, then **confirms the lineup**. Changing a confirmed lineup before the toss resets its confirmation.
4. Once both are confirmed, the system picks which captain **calls the toss**. The coin is flipped on the server, and the winning captain chooses **bat or bowl**.
5. No umpire: the match starts straight away. With an umpire: the umpire starts it.

## How the numbers work

- **Complete over:** bowler and batter each lock in one number per ball left in the over (six at the start of an over, fewer after a wicket). Nothing is shown until both are in; then the server reveals them together.
- **Ball by ball:** both pick one number per ball, revealed as soon as both are in.
- Same number: out, and the rest of that submission is ignored. Different: the batter scores what they picked.
- Overs are always six legal balls. After a wicket, the next batter faces the rest of the same over against the same bowler, entering only as many numbers as there are balls left.

## Formats and digit rules

| Format | Overs | Batter may pick | Bowler may pick |
|---|---|---|---|
| T20 / ODI / Custom (limited overs) | 20 / 50 / your choice | 1–6, any number of times | 1–6 |
| Test match | Days × sessions × overs per session | 0, 1, 2, 3, 4, 6 (0 = dot ball, no 5) | 1, 2, 3, 4, 6 (no 0 or 5) |

**Bowler repetition rule (every format, per over, resets each over):** one number may be used 3 times; every other number at most twice; never 4 times. So 333552 and 555442 are fine, 333555 and 64444 are not. Counted across the over (including ball-by-ball picks), but a wicket resets the count: e.g. after 44 and a wicket on ball 2, the bowler can lock in 4443 for the last four balls. The over's ball count does not reset.

These rules live in `server/rules.js` and are enforced on the server; the pads only show valid buttons.

## Test matches

- **Set-up:** 1–5 days, 1–4 sessions a day, overs per session, wickets per innings (default 10), 1 or 2 innings each, an optional session time limit, lunch/tea/stumps breaks (switch one off to roll straight on), optional follow-on.
- **Sessions** end after their overs (or early, by the umpire/host, or on a captain's approved request). A session ending never ends an over or an innings: the same over, batter, bowler and any scoring requirement carry on next session. The last session of the last day ends in a draw if there's no result.
- **Suspend / continue:** the host (or umpire) can save the match at any point. Nothing moves on until it's continued, and it uses the same link. Every suspension is logged.
- **Innings** end on all out, a declaration (batting captain or umpire), or the chase. Follow-on margins: 200 (5 days), 150 (3–4), 100 (2), 75 (1). Innings victories are detected after the third innings.
- **Dot-over rule:** a batter who plays out all six legal balls of an over without scoring must score off one of the first two legal balls of their next over. It survives breaks and suspensions, is cancelled if they're out or the innings ends, and is tracked per batter. If broken: no umpire, the batter is out (not credited to the bowler); with an umpire, play is held until the umpire gives them out or waives it.

## Who plays: one-v-one, against the AI, or teams

- **Me v the AI:** one human against the computer (easy, medium, hard, expert). The AI is an ordinary participant: it reads only what any opponent can see (the public match state and balls already revealed, never an open submission), and it submits through the same server functions and validation as a person. It confirms its lineup, calls and decides the toss, and handles the follow-on and Test declarations. No umpire in AI matches.
- **Me v a friend:** one human each side; the friend takes the open side from the invite link. With an umpire, the creator umpires and two friends play.
- **Team match:** the existing multiplayer teams with captains (custom teams only).

In one-v-one matches you can play as a **real team** (international or IPL) or custom teams. With a real team you pick your playing XI from its squad, set the batting and bowling order and the captain on the field, then confirm. Each person plays every ball for their side; the roster players' names appear on the scoreboard.

## Real teams and squads

Team and squad data lives in its own tables (categories, seasons, teams, players, squads, sync runs) and is copied into each match when it's created, so later changes never alter finished matches.

- **Source:** [CricketData.org](https://cricketdata.org) (licensed cricket data API; the ICC and IPL don't offer public APIs). Set `CRICKETDATA_API_KEY` on the server. The free plan (100 calls a day) is enough: a sync uses about 25.
- **Schedule:** on start-up if due, then daily; after a failure it retries an hour later. Admins can run it by hand.
- **What it does:** takes the latest IPL season's squads and each national team's most recent squad; adds new teams and players, records renames, transfers and releases, and never creates duplicate players (one record per provider id; a transfer moves their season assignment).
- **Fallback:** a starter list of team names (`server/data/teams.seed.json`, no players) is used until the first sync. A team with no synced squad plays with clearly labelled stand-in players; no player names are invented.
- **Admins** (registered usernames in `ADMIN_USERNAMES`, comma-separated) get an Admin page: sync status and history, Sync now, and editing of teams and squads. Admin edits are kept; the sync won't overwrite them. Sync failures are shown to admins.

## Umpire, host and captains

- **No umpire**: fully automatic. The creator is the "host": they can moderate chat and end a match early, nothing more.
- **With umpire**: the creator umpires. They start the match and each innings, can pause, void the last reveal, adjust runs and end early. They privately see the bowler's numbers (never the batter's).
- **Captains**: only the captain can change their team's batting order, bowling order, next bowler (between overs), next batter (before they start) and, until the toss, the squad. This is checked on the server. Every change is written to the match history.

## Run it locally

Needs Node.js 22.5 or newer, because it uses Node's built-in SQLite, so there is nothing native to compile.

```bash
npm install
npm run build      # builds the React client into client/dist
npm start          # serves app + API + WebSockets on http://localhost:3000
npm test           # plays two full matches over real sockets and checks every rule
```

For development, run `npm run dev:server` and `npm run dev:client` in two terminals and open http://localhost:5173.

To try it with friends on the same Wi-Fi, open `http://<your-computer's-IP>:3000` on their phones.

## Put it online (so friends anywhere can join)

The server keeps WebSocket connections open and writes to a SQLite file, so it needs a host that runs a long-lived Node process **with a persistent disk**. Vercel's serverless functions can't hold WebSockets, so use one of these instead:

- **Railway**: New project, then Deploy from GitHub repo. It picks up the `Dockerfile`. Add a Volume mounted at `/app/data`. Under Networking, generate a domain.
- **Render**: Push to GitHub, then New, then Blueprint. It reads `render.yaml`, which attaches a 1 GB disk at `/app/data`. Persistent disks need a paid instance (Starter).
- **Fly.io**: Run `fly launch`, then `fly volumes create cricket_data --size 1`, then mount it at `/app/data` in `fly.toml`.
- **Any VPS**: Run `docker build -t cricket . && docker run -d -p 80:3000 -v cricket-data:/app/data cricket`.

Without a persistent disk the database resets on every deploy.

Environment variables (all optional): `PORT` (default 3000), `DB_PATH` (default `data/cricket.db`), `CORS_ORIGIN` (only if you host the client on a different domain).

## What's inside

```
server/
  index.js    Express REST API, Socket.IO real-time layer, auth, static hosting
  engine.js   Game rules: matches, innings, sealed overs, balls, results, umpire actions, chat
  stats.js    Player profiles, records and leaderboards from the ball-by-ball record
  db.js       SQLite schema (users, sessions, matches, members, innings, sets, balls, messages, reactions, audit)
client/src/
  pages/      Home (create/join), Match (live game), Profile, Leaderboard
  components/ Score bug and over strip, role panels, chat, umpire panel, animations
test/match.test.js   End-to-end test with four socket clients
```

## Integrity and security

- **The server decides everything.** Clients only send intents ("seal these six numbers", "I pick 4 for ball 7"). Runs, wickets, overs, innings changes and results are all calculated on the server inside a database transaction.
- **Both sequences stay secret until both are in.** Each is stored on the server and sent back only to the player who entered it. The public state only says "locked in". The reveal happens inside one database transaction when the second sequence arrives. Afterwards both sequences and their salts are published, so anyone can check them against the SHA-256 fingerprints.
- **No changes, no duplicates.** A locked-in sequence can't be resubmitted or edited, and only the current bowler and batter can submit.
- **Captain permissions are enforced on the server.** A request from anyone but that team's captain is rejected, and lineups lock once an over has started.
- **Corrections are audited.** Voiding the last over or adjusting runs needs a reason, is announced in chat and is kept in the match history.
- **Reconnects are seamless.** A phone that drops and comes back gets the full match and its own locked-in sequence again.
- **Upgrades keep your data.** New columns are added to an existing database on start-up, so matches and stats from earlier versions carry over.
- **Accounts.** Guests get a random 256-bit session token. Registered users' passwords are hashed with scrypt. A guest can add a username and password later and keep all their stats.

## Rules decisions you can change

- **Batting order cycles.** If a team has fewer players than wickets (for example 1 v 1 with 3 wickets), the next batter is whoever in the order has been out the fewest times, so the same player can bat again.
- **Out batters come back last.** A captain can't send an out player back in while a teammate hasn't batted yet.
- **Super over.** It's 6 balls with 2 wickets. The team that batted second bats first. A second tie is recorded as a tie.
- **Ranking points** are runs + 20 per wicket taken + 25 per win.

## Ideas for next steps

- Web Push (service worker plus VAPID keys) so turn alerts arrive even with the browser closed. Right now alerts show in the app, as a browser notification while the tab is open in the background, and as a vibration.
- Swap SQLite for Postgres if you ever need more than one server instance.
- A per-ball timer that auto-plays or forfeits if someone goes AFK.
