# Running FOOTY CRICKET LEAGUE in production

## Settings (Railway variables)

| Variable | What it does | Default |
|---|---|---|
| `ADMIN_USERNAMES` | Comma-separated registered usernames that are always admins (the owners). They can make other people moderators or admins from Admin, Users. | none |
| `DB_PATH` | The database file. Keep it on the Railway volume (`/app/data`). | `data/cricket.db` |
| `BACKUP_DIR` | Where backups go. | `backups/` beside the database |
| `BACKUP_HOURS` | Hours between automatic backups. | 6 |
| `BACKUP_KEEP` | How many backups to keep. | 28 (a week at 6-hourly) |
| `SESSION_DAYS` | A sign-in lasts this many days after it was last used. | 30 |
| `SQUADS_STALE_DAYS` | Squads older than this are shown to players with their date, as possibly out of date. | 14 |
| `CRICKETDATA_API_KEY` | Turns on the daily squad sync from CricketData.org. | off |

## Roles

| Role | Can |
|---|---|
| Player | Play; manage their own profile. |
| Moderator | Everything a player can, plus: view the admin dashboard, users and their careers; suspend and reactivate players; view, inspect and abandon matches; clean up old lobbies. |
| Admin | Everything, plus: rename users, change roles, cricket data (sync, imports, corrections, merges), settings (AI, formats, stadiums, commentary, achievements, challenges), logs, backups, restores and data checks. |

Owners (`ADMIN_USERNAMES`) are always admins: they can't be suspended or demoted from the app. Nobody can change their own role or suspend themselves. Guests can't hold staff roles.

## Backups and recovery

- **Automatic:** a consistent snapshot every `BACKUP_HOURS`. Each one is checked (SQLite integrity check, row counts) before it's kept; the newest `BACKUP_KEEP` are kept.
- **On demand:** Admin, System, Back up now; or `npm run backup` on the server.
- **Off-site:** backups live on the same volume as the database. Download one regularly (Admin, System, Download) and keep it somewhere else.

**Restore from the admin page**
1. Admin, System: choose **Restore** on a backup. It's checked again and scheduled.
2. Choose **Restart and restore now** (or wait for the next deploy or restart). The restore happens before the database is opened.
3. The database it replaced is kept beside it as `pre-restore-<time>.db`, so a restore can itself be undone.

**Restore from the command line** (with the server stopped)
```
npm run restore -- /app/data/backups/backup-<time>.db
```
This refuses a damaged file and keeps the current database as `pre-restore-<time>.db`.

## Data checks

Run daily, from Admin, System, **Check now**, or with `npm run integrity`. They check:
- the SQLite file (`integrity_check`) and its links between records (`foreign_key_check`);
- every match:
  - each revealed submission against the hash published when it was locked in;
  - each delivery against the numbers locked in;
  - runs and wickets against the numbers;
  - digits allowed for the format;
  - the bowler repetition rule;
  - continuous ball numbering;
  - wickets and overs within the limits;
- tournament fixtures against their matches.

Staff are notified of any problem. To investigate one match, use Admin, Matches, then open the match. It shows the event log, every submission (numbers still hidden from players stay hidden here too) and the checks for that match.

## Protection against changed scores

- Every game action runs in one database transaction: either it all happens, or nothing does.
- The database refuses changes to a recorded delivery, apart from the two the rules allow: voiding, and a dot-over-rule dismissal on a ball that scored nothing. Deleting deliveries, swapping locked-in numbers, and editing the match event log or the admin audit log are refused too.
- Staff can abandon a match (it counts as no result), but they can't edit scores. Umpire corrections stay where they were: the umpire's void and adjust actions, recorded in the match's event log. Tournament matches can't have results declared or runs adjusted.

## Cricket data

- **Daily sync** (with `CRICKETDATA_API_KEY`). It retries an hour after a failure and keeps the last good squads; staff are notified of failures.
- **Spreadsheet import** (Admin, Cricket data). This takes an .xlsx file with Team and Player columns; you see a preview first, including which existing team each sheet team updates. Imported squads aren't overwritten by the automatic sync.
- **Shipped workbook:** this release ships the squads workbook compiled on 6 Nov 2026 and imports it once on first start.
- **The same person stays one record:** players are matched by any id they've had, then once by name and country. If a provider renumbers a player, it's recognised. Possible duplicates are listed for an admin to merge.
- **History is kept:** squads are stored per season, and players who leave are kept. Each match keeps its own copy of the teams it was played with, so later changes never alter a finished match.
- **Out-of-date squads:** squads older than `SQUADS_STALE_DAYS` are shown to players with their date and a note that they may be out of date.

## Logs

- **Admin audit log:** every staff action with who, when, what and from where. Append-only.
- **Match event log:** every ball, decision, declaration, suspension and correction, per match. Append-only.
- **Server error log:** the newest 5,000 errors with details. Staff get at most one notification per half hour for errors.
