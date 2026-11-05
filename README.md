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
