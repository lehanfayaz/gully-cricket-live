import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Link, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, auth, onSocket, setToken } from './api.js';
import Home from './pages/Home.jsx';
import Match from './pages/Match.jsx';
import Profile from './pages/Profile.jsx';
import Leaderboard from './pages/Leaderboard.jsx';
import AdminPage from './pages/AdminPage.jsx';
import MatchStats from './pages/MatchStats.jsx';
import Tournament from './pages/Tournament.jsx';
import TournamentNew from './pages/TournamentNew.jsx';
import { PresentationSettings } from './components/Broadcast.jsx';

const Ctx = createContext(null);
export const useApp = () => useContext(Ctx);

export default function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    if (!auth.token) { setReady(true); return; }
    api('/api/me').then((r) => { if (r.user) setUser(r.user); else setToken(null); }).catch(() => {}).finally(() => setReady(true));
  }, []);

  const toast = useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((x) => [...x.slice(-1), { id, ...t }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), t.ms || 4000);
  }, []);

  // Player-turn notifications arrive over the socket wherever you are in the app.
  useEffect(() => onSocket((s) => {
    s.on('notify', (n) => {
      // On the match page itself the play panel already lights up for your turn, so skip the banner there.
      const here = location.pathname.toUpperCase().endsWith(`/M/${n.matchId}`);
      if (!(here && (n.kind === 'bat' || n.kind === 'bowl'))) toast({ title: n.title, body: n.body, kind: n.kind, matchId: n.matchId });
      if (n.kind === 'bat' || n.kind === 'bowl') navigator.vibrate?.([120, 60, 120]);
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification(n.title, { body: n.body, tag: `fcl-${n.matchId}`, renotify: true }); } catch {}
      }
    });
  }), [toast]);

  const signIn = (r) => { setToken(r.token); setUser(r.user); };
  const signOut = async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch {} setToken(null); setUser(null); };

  if (!ready) return <div className="grid min-h-dvh place-items-center font-display text-2xl text-chalk-dim">Rolling the pitch…</div>;
  return (
    <Ctx.Provider value={{ user, setUser, signIn, signOut, toast }}>
      <BrowserRouter>
        <Shell>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/m/:id" element={<Match />} />
            <Route path="/m/:id/stats" element={<MatchStats />} />
            <Route path="/t/new" element={<TournamentNew />} />
            <Route path="/t/:id" element={<Tournament />} />
            <Route path="/settings" element={<div className="px-4 pb-12 pt-2"><section className="panel mx-auto max-w-xl p-5"><PresentationSettings /></section></div>} />
            <Route path="/u/:id" element={<Profile />} />
            <Route path="/leaderboard" element={<Leaderboard />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="*" element={<div className="p-8 text-center text-chalk-dim">That page does not exist. <Link className="text-flood underline" to="/">Go home</Link></div>} />
          </Routes>
        </Shell>
        <Toasts toasts={toasts} dismiss={(id) => setToasts((x) => x.filter((y) => y.id !== id))} />
      </BrowserRouter>
    </Ctx.Provider>
  );
}

function Shell({ children }) {
  const { user } = useApp();
  const loc = useLocation();
  const inMatch = loc.pathname.startsWith('/m/') && !loc.pathname.endsWith('/stats');
  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col">
      {!inMatch && (
        <header className="flex items-center justify-between px-4 pb-2 pt-4">
          <Link to="/" className="flex items-center gap-2">
            <span className="h-7 w-7"><div className="ball"><div className="ball-inner"><div className="ball-face" /></div></div></span>
            <span className="font-display text-lg font-extrabold leading-[0.95] sm:text-2xl">FOOTY CRICKET <span className="text-flood">LEAGUE</span></span>
          </Link>
          <nav className="flex shrink-0 items-center gap-3 whitespace-nowrap text-sm font-medium text-chalk-dim sm:gap-4">
            <Link to="/leaderboard" className="hover:text-chalk">Leaderboard</Link>
            {user && <Link to={`/u/${user.id}`} className="hover:text-chalk">My stats</Link>}
            <Link to="/settings" className="hover:text-chalk" aria-label="Presentation settings">⚙</Link>
            {user?.admin && <Link to="/admin" className="hover:text-chalk">Admin</Link>}
          </nav>
        </header>
      )}
      <main className="flex-1">{children}</main>
    </div>
  );
}

function Toasts({ toasts, dismiss }) {
  const nav = useNavigate();
  const loc = useLocation();
  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-50 flex flex-col items-center gap-2 px-3" aria-live="polite">
      {toasts.map((t) => {
        const elsewhere = t.matchId && !loc.pathname.endsWith(t.matchId);
        const urgent = t.kind === 'bat' || t.kind === 'bowl' || t.kind === 'umpire';
        return (
          <button key={t.id} onClick={() => (elsewhere ? nav(`/m/${t.matchId}`) : dismiss(t.id))}
            className={`pop pointer-events-auto w-full max-w-md rounded-xl px-4 py-2.5 text-left shadow-2xl ring-1 ${urgent ? 'bg-flood text-pitch-900 ring-flood' : 'bg-pitch-700 text-chalk ring-pitch-500'}`}>
            <div className="font-display text-lg font-bold leading-tight">{t.title}</div>
            {t.body && <div className="text-sm opacity-85">{t.body}{elsewhere ? ' Tap to open the match.' : ''}</div>}
          </button>
        );
      })}
    </div>
  );
}

// Asks for a display name (guest) or sign-in. Used on Home and when opening an invite link.
export function SignInCard({ title = 'Pick a name to play', onDone }) {
  const { signIn } = useApp();
  const [mode, setMode] = useState('guest');
  const [form, setForm] = useState({ name: '', username: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const first = useRef(null);
  useEffect(() => { first.current?.focus(); }, [mode]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const path = mode === 'guest' ? '/api/auth/guest' : mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const r = await api(path, { body: form });
      signIn(r); onDone?.();
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="panel mx-auto w-full max-w-sm space-y-3 p-5">
      <h2 className="font-display text-3xl font-bold leading-tight">{title}</h2>
      {mode === 'guest' ? (
        <div>
          <label className="label" htmlFor="nm">Your name</label>
          <input id="nm" ref={first} className="field" value={form.name} onChange={set('name')} placeholder="e.g. Rahul" maxLength={24} autoComplete="nickname" />
        </div>
      ) : (
        <>
          <div><label className="label" htmlFor="un">Username</label><input id="un" ref={first} className="field" value={form.username} onChange={set('username')} autoComplete="username" /></div>
          {mode === 'register' && <div><label className="label" htmlFor="dn">Display name</label><input id="dn" className="field" value={form.name} onChange={set('name')} maxLength={24} /></div>}
          <div><label className="label" htmlFor="pw">Password</label><input id="pw" type="password" className="field" value={form.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></div>
        </>
      )}
      {err && <p className="text-sm text-leather" role="alert">{err}</p>}
      <button className="btn-go w-full" disabled={busy}>{mode === 'guest' ? 'Play as guest' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
      <div className="flex justify-between text-sm text-chalk-dim">
        {mode !== 'guest' ? <button type="button" onClick={() => setMode('guest')} className="underline">Play as guest instead</button>
          : <button type="button" onClick={() => setMode('login')} className="underline">I have an account</button>}
        {mode !== 'register' && <button type="button" onClick={() => setMode('register')} className="underline">Create account</button>}
      </div>
    </form>
  );
}
