import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { emit, getSocket } from '../api.js';
import { SignInCard, useApp } from '../App.jsx';
import { Commentary, OverStrip, REVEAL_STEP, ScoreBug, Scorecards } from '../components/Board.jsx';
import { InningsBreak, Lobby, ResultCard, Waiting } from '../components/Panels.jsx';
import { OverStatus, SubmitOver } from '../components/OverPanel.jsx';
import { Lineups } from '../components/Lineups.jsx';
import { SessionHistory, TestDashboard } from '../components/TestPanel.jsx';
import Chat from '../components/Chat.jsx';
import UmpirePanel from '../components/Umpire.jsx';
import { Cheers, FxOverlay } from '../components/Fx.jsx';

export default function Match() {
  const { id: raw } = useParams();
  const id = raw.toUpperCase();
  const { user } = useApp();
  if (!user) {
    return <div className="px-4 py-10"><SignInCard title={`You've been invited to match ${id}`} /></div>;
  }
  return <Live key={`${id}-${user.id}`} id={id} me={user.id} />;
}

function Live({ id, me }) {
  const nav = useNavigate();
  const { toast } = useApp();
  const [state, setState] = useState(null);
  const [priv, setPriv] = useState({});
  const [messages, setMessages] = useState([]);
  const [online, setOnline] = useState([]);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('play');
  const [fx, setFx] = useState(null);
  const [cheers, setCheers] = useState([]);
  const [connected, setConnected] = useState(true);
  const [alerts, setAlerts] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const fxTimer = useRef();
  const revealEnd = useRef(0);

  useEffect(() => {
    const s = getSocket();
    const open = async () => {
      const r = await emit('match:open', { matchId: id });
      if (!r.ok) { setError(r.error); return; }
      setError(''); setState(r.state); setPriv(r.private); setMessages(r.chat);
    };
    const onState = (x) => x.id === id && setState(x);
    const onPrivate = (x) => x.matchId === id && setPriv(x);
    const onChat = (m) => setMessages((list) => (list.some((x) => x.id === m.id) ? list : [...list, m].slice(-400)));
    const onUpdate = (m) => setMessages((list) => list.map((x) => (x.id === m.id ? m : x)));
    const onPresence = (p) => p.matchId === id && setOnline(p.online);
    // Big moments wait until the over's balls have finished flipping.
    const show = (f, at) => {
      setTimeout(() => {
        clearTimeout(fxTimer.current);
        setFx({ ...f, key: Math.random() });
        fxTimer.current = setTimeout(() => setFx(null), f.type === 'result' ? 2600 : 1800);
      }, Math.max(0, at - Date.now()));
    };
    const onFx = (f) => {
      if (f.type === 'reveal') {
        const end = Date.now() + f.balls.length * REVEAL_STEP + 350;
        revealEnd.current = end;
        const pick = f.wicket ? 'wicket' : f.balls.some((b) => b.runs === 6) ? 'six' : f.balls.some((b) => b.runs === 4) ? 'four' : null;
        if (pick) show({ type: pick, batter: f.batter }, end);
        return;
      }
      if (f.type === 'toss') return; // the coin animates in the toss panel
      show(f, Math.max(Date.now(), revealEnd.current + (f.type === 'result' || f.type === 'tie' ? 1900 : 0)));
    };
    const onCheer = (c) => {
      const key = Math.random();
      setCheers((x) => [...x.slice(-24), { ...c, key, x: 8 + Math.random() * 84 }]);
      setTimeout(() => setCheers((x) => x.filter((y) => y.key !== key)), 2300);
    };
    const onKicked = (k) => { if (k.matchId === id) { toast({ title: 'Removed from match', body: 'You were removed from this match.' }); nav('/'); } };
    const onConnect = () => { setConnected(true); open(); };
    const onDisconnect = () => setConnected(false);
    s.on('connect', onConnect); s.on('disconnect', onDisconnect);
    s.on('state', onState); s.on('private', onPrivate); s.on('chat', onChat); s.on('chat:update', onUpdate);
    s.on('presence', onPresence); s.on('fx', onFx); s.on('cheer', onCheer); s.on('kicked', onKicked);
    if (s.connected) open();
    return () => {
      s.off('connect', onConnect); s.off('disconnect', onDisconnect);
      s.off('state', onState); s.off('private', onPrivate); s.off('chat', onChat); s.off('chat:update', onUpdate);
      s.off('presence', onPresence); s.off('fx', onFx); s.off('cheer', onCheer); s.off('kicked', onKicked);
    };
  }, [id, nav, toast]);

  const cur = state?.current;
  const role = overRole(state, me);
  const myTurn = !!role && !priv.myLocked;
  useEffect(() => {
    document.title = myTurn ? '🏏 Your turn! FOOTY CRICKET LEAGUE' : state ? `${state.name}: FOOTY CRICKET LEAGUE` : 'FOOTY CRICKET LEAGUE';
  }, [myTurn, state?.name]);
  useEffect(() => { if (myTurn) setTab('play'); }, [myTurn]);

  if (error) {
    return (
      <div className="px-4 py-16 text-center">
        <h1 className="font-display text-3xl font-bold">{error}</h1>
        <Link to="/" className="btn-go mt-6">Back to home</Link>
      </div>
    );
  }
  if (!state) return <div className="grid min-h-[60dvh] place-items-center font-display text-2xl text-chalk-dim">Walking out to the middle…</div>;

  const isUmp = !!priv.isUmpire;
  const tabs = [['play', 'Play'], ['lineups', 'Lineups'], ['card', 'Score'], ['chat', 'Chat'],
    ...(isUmp ? [['ump', 'Umpire']] : priv.isHost ? [['ump', 'Host']] : [])];

  return (
    <div className="flex min-h-dvh flex-col pb-16 lg:pb-0">
      <div className="sticky top-0 z-20 bg-pitch-900/95 shadow-lg backdrop-blur">
        <div className="flex items-center gap-3 px-3 pt-2">
          <Link to="/" aria-label="Home" className="rounded-lg px-2 py-1 text-xl text-chalk-dim hover:bg-pitch-700">‹</Link>
          <h1 className="min-w-0 flex-1 truncate font-display text-lg font-semibold text-chalk-dim">{state.name} <span className="text-chalk-faint">{state.id}</span></h1>
          {alerts === 'default' && (
            <button className="rounded-full bg-pitch-700 px-3 py-1 text-xs font-semibold text-flood ring-1 ring-flood/60"
              onClick={async () => setAlerts(await Notification.requestPermission())}>Turn on turn alerts</button>
          )}
          {!connected && <span className="rounded-full bg-leather px-2 py-0.5 text-xs font-semibold">Reconnecting…</span>}
        </div>
        <ScoreBug state={state} online={online.length} />
        {state.tournament && (
          <Link to={`/t/${state.tournament.id}`} className="flex items-center justify-between gap-2 border-t border-pitch-600 px-4 py-1.5 text-sm hover:bg-pitch-800">
            <span className="truncate text-chalk-dim">{state.tournament.label}</span>
            <span className="shrink-0 font-semibold text-flood">{state.status === 'completed' || state.status === 'abandoned' ? 'Back to the tournament' : 'Tournament'}</span>
          </Link>
        )}
      </div>

      <div className="flex-1 lg:grid lg:grid-cols-[1fr_380px] lg:gap-4 lg:px-4 lg:pt-4">
        <div className="min-w-0">
          <nav className="hidden gap-1 lg:flex" role="tablist">
            {tabs.filter(([k]) => k !== 'chat').map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`rounded-t-lg px-4 py-2 font-display text-lg font-bold ${tab === k ? 'bg-pitch-800 text-chalk' : 'text-chalk-dim hover:text-chalk'}`}>{label}</button>
            ))}
          </nav>
          <div className="space-y-3 p-3 lg:p-0 lg:pt-3">
            {tab === 'play' && <PlayTab state={state} priv={priv} me={me} isUmp={isUmp} online={online} openLineups={() => setTab('lineups')} />}
            {tab === 'lineups' && <Lineups state={state} priv={priv} me={me} />}
            {tab === 'card' && <><AnalysisLink id={state.id} done={state.status === 'completed'} /><Scorecards state={state} /><SessionHistory state={state} /></>}
            {tab === 'ump' && (isUmp || priv.isHost) && <UmpirePanel state={state} priv={priv} />}
            {tab === 'chat' && <Chat className="h-[calc(100dvh-15rem)] lg:hidden" state={state} me={me} priv={priv} messages={messages} />}
          </div>
        </div>
        <aside className="hidden lg:block">
          <div className="sticky top-[10.5rem]">
            <Chat className="h-[calc(100dvh-12rem)]" state={state} me={me} priv={priv} messages={messages} />
          </div>
        </aside>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-20 grid border-t border-pitch-600 bg-pitch-900/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
        style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }} role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`relative py-3 font-display text-base font-bold sm:text-lg ${tab === k ? 'text-flood' : 'text-chalk-dim'}`}>
            {label}
            {k === 'play' && myTurn && tab !== 'play' && <span className="absolute right-4 top-2 h-2.5 w-2.5 rounded-full bg-leather" />}
            {tab === k && <span className="absolute inset-x-6 top-0 h-0.5 bg-flood" />}
          </button>
        ))}
      </nav>

      <FxOverlay fx={fx} />
      <Cheers items={cheers} />
    </div>
  );
}

// Is it this user's over to submit right now? Returns 'bowl', 'bat' or null.
function overRole(state, me) {
  const cur = state?.current;
  if (!cur || state.status !== 'live' || state.paused) return null;
  const bowler = cur.open ? cur.set.bowlerId : cur.bowlerId;
  const batter = cur.open ? cur.set.batterId : cur.strikerId;
  // You act for a player if it's you, or you control their team's roster (real-team one-v-one).
  const mine = (pid) => pid === me || state.members.find((x) => x.id === pid)?.controller === me;
  return mine(bowler) ? 'bowl' : mine(batter) ? 'bat' : null;
}

function PlayTab({ state, priv, me, isUmp, online, openLineups }) {
  const cur = state.current;
  if (state.status === 'lobby') return <Lobby state={state} me={me} priv={priv} online={online} openLineups={openLineups} />;
  if (state.status === 'completed' || state.status === 'abandoned') {
    return <><ResultCard state={state} />
      {state.tournament && <Link to={`/t/${state.tournament.id}`} className="btn-flood w-full text-xl">Back to {state.tournament.name || 'the tournament'}</Link>}
      <AnalysisLink id={state.id} done /><Scorecards state={state} /></>;
  }
  const role = overRole(state, me);
  const inn = state.innings[state.innings.length - 1];
  const captainHere = priv.captainOf?.includes(inn?.bowling) || priv.captainOf?.includes(inn?.batting);
  let panel = null;
  const test = state.format === 'test';
  if (['suspended', 'session_break', 'day_break'].includes(state.status)) panel = null; // the Test dashboard explains the pause
  else if (state.status === 'innings_break') panel = test && state.test?.followOn ? null : <InningsBreak state={state} isUmp={isUmp} />;
  else if (cur.phase === 'paused') panel = <Waiting title="Play is paused" body="The umpire will resume the match shortly." />;
  else if (role) panel = <SubmitOver key={`${cur.number}-${cur.overNumber}-${cur.ballInOver}-${cur.open}`} state={state} role={role} cur={cur} priv={priv} />;
  else panel = <OverStatus cur={cur} me={me} single={state.play === 'ball'} />;
  return (
    <>
      {test && state.test && <TestDashboard state={state} priv={priv} me={me} />}
      <section className="panel mown p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-display text-xl font-bold">{cur?.over ? `Over ${cur.over.number}${cur.over.finished ? ', finished' : ''}` : 'This over'}</h2>
          <span className="text-sm text-chalk-dim">{cur && state.status === 'live' && !cur.over?.finished ? `${cur.ballsLeftInOver} ball${cur.ballsLeftInOver === 1 ? '' : 's'} left` : `Run rate ${cur?.runRate}`}</span>
        </div>
        <div className="mx-auto max-w-lg"><OverStrip over={cur?.over} /></div>
      </section>
      {panel}
      {captainHere && state.status === 'live' && !cur.open && (
        <button onClick={openLineups} className="panel flex w-full items-center justify-between p-3 text-left text-sm hover:bg-pitch-700">
          <span>You're captain. Change who bowls or bats next before this over starts.</span>
          <span className="font-semibold text-flood">Lineups</span>
        </button>
      )}
      <section className="panel p-4">
        <h2 className="mb-2 font-display text-xl font-bold">Ball by ball</h2>
        <Commentary items={state.commentary} />
      </section>
    </>
  );
}

// Link to the full analysis: stats, replay and highlights, from the saved deliveries.
function AnalysisLink({ id, done }) {
  return (
    <Link to={`/m/${id}/stats`} className="panel flex w-full items-center justify-between gap-3 p-4 hover:bg-pitch-700">
      <span><span className="block font-display text-xl font-bold">{done ? 'Match analysis and replay' : 'Analysis so far'}</span>
        <span className="block text-sm text-chalk-dim">Ball-by-ball replay, highlights, partnerships{done ? ', and every stat from this match' : ' and figures from the deliveries played'}.</span></span>
      <span className="shrink-0 font-semibold text-flood">Open</span>
    </Link>
  );
}
