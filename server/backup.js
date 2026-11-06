// Automated backups: a consistent snapshot of the whole database (VACUUM INTO works safely while the game
// is running), checked for integrity, on a schedule and on demand. Older ones are pruned.
// Recovery: from the admin page (applied at the next start, see db.js) or `npm run restore -- <file>`.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db, file } from './db.js';

export const backupDir = () => process.env.BACKUP_DIR || path.join(path.dirname(file === ':memory:' ? path.resolve('data/x') : file), 'backups');
const KEEP = () => Math.max(2, Number(process.env.BACKUP_KEEP || 28));
const HOURS = () => Math.max(1, Number(process.env.BACKUP_HOURS || 6));

export function verify(p) {
  const d = new DatabaseSync(p, { readOnly: true });
  try {
    const ok = d.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok';
    const counts = Object.fromEntries(['users', 'matches', 'balls', 'tournaments'].map((t) => [t, d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
    return { ok, counts };
  } finally { d.close(); }
}

export function createBackup(trigger = 'manual') {
  if (file === ':memory:' && !process.env.BACKUP_DIR) throw new Error('The database is in memory; there is nothing to back up.');
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${trigger}.db`;
  const out = path.join(dir, name);
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  const v = verify(out);
  if (!v.ok) { fs.rmSync(out, { force: true }); throw new Error('The new backup failed its integrity check and was discarded.'); }
  fs.writeFileSync(`${out}.json`, JSON.stringify({ trigger, at: Date.now(), size: fs.statSync(out).size, ...v }));
  prune();
  return describe(name);
}

function describe(name) {
  const p = path.join(backupDir(), name);
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(`${p}.json`, 'utf8')); } catch {}
  const st = fs.statSync(p);
  return { name, size: st.size, at: meta.at || st.mtimeMs, trigger: meta.trigger || 'unknown', ok: meta.ok ?? null, counts: meta.counts || null };
}
export function listBackups() {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^backup-.*\.db$/.test(f)).map(describe).sort((a, b) => b.at - a.at);
}
function prune() {
  for (const b of listBackups().slice(KEEP())) { fs.rmSync(path.join(backupDir(), b.name), { force: true }); fs.rmSync(path.join(backupDir(), `${b.name}.json`), { force: true }); }
}
// Only names we made, inside the backup folder.
export function backupPath(name) {
  if (!/^backup-[\w-]+\.db$/.test(String(name))) throw new Error('Unknown backup.');
  const p = path.join(backupDir(), name);
  if (!fs.existsSync(p)) throw new Error('That backup no longer exists.');
  return p;
}
// Ask for a restore at the next start (the running database is never swapped underneath the game).
export function requestRestore(name) {
  const p = backupPath(name);
  const v = verify(p);
  if (!v.ok) throw new Error('That backup failed its integrity check, so it was not scheduled.');
  fs.writeFileSync(path.join(path.dirname(file), 'restore-pending.json'), JSON.stringify({ backup: p, requestedAt: Date.now() }));
  return v;
}
export function pendingRestore() {
  if (file === ':memory:') return null;
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'restore-pending.json'), 'utf8')); } catch { return null; }
}
export function cancelRestore() { if (file !== ':memory:') fs.rmSync(path.join(path.dirname(file), 'restore-pending.json'), { force: true }); }

export function startBackups(onError) {
  if (file === ':memory:') return null;
  const due = () => { const last = listBackups().find((b) => b.trigger === 'schedule'); return !last || Date.now() - last.at > HOURS() * 3600000; };
  const tick = () => { try { if (due()) createBackup('schedule'); } catch (e) { onError?.(e); } };
  setTimeout(tick, 30000).unref();
  return setInterval(tick, 15 * 60000).unref();
}
