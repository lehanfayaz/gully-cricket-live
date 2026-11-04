import { io } from 'socket.io-client';

const KEY = 'gcl_token';
export const auth = { token: localStorage.getItem(KEY) };
export function setToken(t) {
  auth.token = t;
  if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY);
  resetSocket();
}

export async function api(path, { method, body } = {}) {
  const r = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'The server could not be reached.');
  return j;
}

let socket = null;
const listeners = new Set();
export function getSocket() {
  if (!socket) {
    socket = io({ auth: { token: auth.token }, transports: ['websocket', 'polling'] });
    for (const fn of listeners) fn(socket);
  }
  return socket;
}
export function onSocket(fn) { listeners.add(fn); if (socket) fn(socket); return () => listeners.delete(fn); }
function resetSocket() { socket?.disconnect(); socket = null; }

export const emit = (event, payload) => new Promise((resolve) => {
  const s = getSocket();
  const timer = setTimeout(() => resolve({ ok: false, error: 'No answer from the server. Check your connection.' }), 8000);
  s.emit(event, payload, (r) => { clearTimeout(timer); resolve(r || { ok: false }); });
});

export const matchLink = (id) => `${location.origin}/m/${id}`;
export const oversText = (balls) => `${Math.floor(balls / 6)}.${balls % 6}`;
