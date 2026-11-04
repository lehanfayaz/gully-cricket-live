# Gully Cricket Live

A real-time multiplayer number-cricket game that runs in the browser. One person creates a match and umpires, friends join from a link on their own phones, and everything happens in the app: sealing the bowler's numbers, batting, chat, notifications, scoring, and saved stats. No WhatsApp needed.

## How a ball works

1. The bowler secretly seals six numbers (1–6) for the over.
2. The batter picks a number for each ball.
3. Same number as the bowler: the batter is out and the rest of that sequence is thrown away.
4. Different number: the batter scores the number they picked.
5. A new batter gets a fresh six-number sequence (you can turn this off per match so the over continues instead).

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
- **The bowler's sequence stays secret.** It is stored on the server and sent only to the bowler's own device. The public state never contains it while the over is open. When the over ends, the sequence is revealed together with a salt, and everyone can check it against the SHA-256 fingerprint that was published at the moment it was sealed. So the bowler can't change it afterwards either.
- **The umpire can't peek.** The umpire is told a sequence was sealed but can't see it. For a dispute, "Open sealed over" shows it to the umpire only. That needs a reason, is announced to everyone, and is recorded in the audit trail. It's blocked if the umpire is also the batter.
- **No double plays.** Each shot carries the ball number it is for. A repeated or late tap is rejected, a sealed over can't be resubmitted, and only the current batter or bowler can act.
- **Corrections are audited.** Voiding a ball or adjusting runs requires a reason and is announced in chat. A voided ball's over is closed and the bowler seals a fresh one, because its numbers were already revealed.
- **Reconnects are seamless.** All state lives in the database. A phone that drops and comes back gets the full match, its private chat and (for the bowler) its sealed sequence again.
- **Accounts.** Guests get a random 256-bit session token. Registered users' passwords are hashed with scrypt. A guest can add a username and password later and keep all their stats.

## Rules decisions you can change

- **Batting order cycles.** If a team has fewer players than wickets (for example 1 v 1 with 3 wickets), the order loops, so the same player bats again.
- **Overs are counted in legal balls.** With "fresh six balls after a wicket" on, a new batter's sequence can carry on past the old over boundary. The innings still ends after overs × 6 balls, and the last sequence is cut short to fit.
- **Super over.** It's 6 balls with 2 wickets. The team that batted second bats first. A second tie is recorded as a tie.
- **Ranking points** are runs + 20 per wicket taken + 25 per win.

## Ideas for next steps

- Web Push (service worker plus VAPID keys) so turn alerts arrive even with the browser closed. Right now alerts show in the app, as a browser notification while the tab is open in the background, and as a vibration.
- Swap SQLite for Postgres if you ever need more than one server instance.
- A per-ball timer that auto-plays or forfeits if someone goes AFK.
