// Accounts, roles and protection: who may do what, suspended accounts, session lifetime, rate limits,
// security headers, the admin audit log and the server error log.
import { all, get, run } from './db.js';

// ---------- roles and permissions ----------
// Admins: everything. Moderators: look after players and matches (view, suspend, abandon), but not data,
// configuration, roles or backups. People named in ADMIN_USERNAMES are always admins (the owners).
export const ROLES = ['player', 'moderator', 'admin'];
const PERMS = {
  'admin.view': ['moderator', 'admin'],
  'users.view': ['moderator', 'admin'],
  'users.suspend': ['moderator', 'admin'],
  'users.edit': ['admin'],
  'users.role': ['admin'],
  'matches.view': ['moderator', 'admin'],
  'matches.manage': ['moderator', 'admin'],
  'cricket.manage': ['admin'],
  'config.manage': ['admin'],
  'audit.view': ['admin'],
  'system.manage': ['admin'],
};
export const ownerNames = () => String(process.env.ADMIN_USERNAMES || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
export const isOwner = (u) => !!u?.username && !u.guest && ownerNames().includes(String(u.username).toLowerCase());
export function roleOf(u) {
  if (!u) return null;
  if (isOwner(u)) return 'admin';
  if (u.guest) return 'player'; // guests never get staff roles
  return ROLES.includes(u.role) ? u.role : 'player';
}
export const can = (u, perm) => !!u && u.status !== 'suspended' && (PERMS[perm] || []).includes(roleOf(u));
export const permissionsOf = (u) => Object.keys(PERMS).filter((p) => can(u, p));
export const need = (perm) => (req, res, next) => (can(req.user, perm) ? next() : res.status(req.user ? 403 : 401).json({ error: req.user ? "You don't have permission to do that." : 'Sign in first.' }));

// ---------- sessions ----------
export const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
// A token is good for SESSION_DAYS after it was last used; suspended accounts can't use theirs.
export function userFromToken(token) {
  if (!token || token.length < 20) return null;
  const u = get(`SELECT u.id, u.username, u.display_name AS name, u.is_guest AS guest, u.role, u.status, s.created_at, s.last_used_at
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, token);
  if (!u) return null;
  const last = u.last_used_at || u.created_at;
  if (Date.now() - last > SESSION_DAYS * 86400000) { run('DELETE FROM sessions WHERE token = ?', token); return null; }
  // Touch at most once a minute.
  if (Date.now() - last > 60000) { run('UPDATE sessions SET last_used_at = ? WHERE token = ?', Date.now(), token); run('UPDATE users SET last_seen_at = ? WHERE id = ?', Date.now(), u.id); }
  return u;
}

// ---------- rate limits (per client, in memory) ----------
const buckets = new Map();
export function limited(key, max, windowMs) {
  const t = Date.now();
  const b = buckets.get(key);
  if (!b || t - b.start > windowMs) { buckets.set(key, { start: t, n: 1 }); return false; }
  b.n++;
  return b.n > max;
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t - b.start > 3600000) buckets.delete(k); }, 600000).unref();
export const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
export const rateLimit = (name, max, windowMs, message = 'Too many requests. Wait a moment and try again.') => (req, res, next) =>
  (limited(`${name}:${clientIp(req)}`, max, windowMs) ? res.status(429).json({ error: message }) : next());

// ---------- security headers ----------
export function headers(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}

// ---------- logs ----------
export function audit(req, action, targetType, targetId, detail) {
  run('INSERT INTO admin_audit (at, user_id, username, action, target_type, target_id, detail, ip) VALUES (?,?,?,?,?,?,?,?)',
    Date.now(), req?.user?.id || null, req?.user?.username || req?.user?.name || 'system', action, targetType || null, targetId != null ? String(targetId) : null,
    detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail), req ? clientIp(req) : null);
}
export function logError(source, err, extra = {}) {
  try {
    run('INSERT INTO error_log (at, source, route, user_id, message, stack) VALUES (?,?,?,?,?,?)', Date.now(), source, extra.route || null, extra.userId || null, String(err?.message || err).slice(0, 2000), String(err?.stack || '').slice(0, 8000));
    // Keep the newest 5,000.
    run('DELETE FROM error_log WHERE id < (SELECT COALESCE(MAX(id), 0) - 5000 FROM error_log)');
  } catch {}
  console.error(`[${source}]`, err);
}
export const recentAudit = ({ limit = 200, before } = {}) => all(`SELECT * FROM admin_audit ${before ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`, ...(before ? [before, limit] : [limit]));
export const recentErrors = (limit = 100) => all('SELECT * FROM error_log ORDER BY id DESC LIMIT ?', limit);
