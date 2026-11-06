// Restore the database from a backup, from the command line. Stop the server first.
//   npm run restore -- data/backups/backup-2026-11-06T....db
// The current database is kept beside it as pre-restore-<time>.db.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const src = process.argv[2];
const dest = process.env.DB_PATH || path.resolve('data/cricket.db');
if (!src || !fs.existsSync(src)) { console.error('Usage: npm run restore -- <backup file>'); process.exit(1); }
const d = new DatabaseSync(src, { readOnly: true });
const ok = d.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok';
const counts = Object.fromEntries(['users', 'matches', 'balls'].map((t) => [t, d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
d.close();
if (!ok) { console.error('That backup failed its integrity check. Nothing was changed.'); process.exit(1); }
if (fs.existsSync(dest)) { const keep = path.join(path.dirname(dest), `pre-restore-${Date.now()}.db`); fs.copyFileSync(dest, keep); console.log(`Current database kept as ${keep}`); }
for (const ext of ['-wal', '-shm']) fs.rmSync(dest + ext, { force: true });
fs.copyFileSync(src, dest);
console.log(`Restored ${dest} from ${src}:`, counts);
