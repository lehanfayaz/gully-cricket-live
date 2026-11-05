import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { emit, getSocket } from '../api.js';
import { SignInCard, useApp } from '../App.jsx';
import { Commentary, OverStrip, ScoreBug, Scorecards } from '../components/Board.jsx';
import { BatPanel, BowlPanel, InningsBreak, Lobby, MySealedOver, ResultCard, Waiting } from '../components/Panels.jsx';
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
    const onFx = (f) => {
      if (f.type === 'runs') return;
      clearTimeout(fxTimer.current);
      setFx({ ...f, key: Math.random() });
      fxTimer.current = setTimeout(() => setFx(null), f.type === 'result' ? 2600 : 1800);
    };
    const onCheer = (c) => {
      const key = Math.random();
      setCheers((x) => [...x.slice(-24), { ...c, key, x: 8 + Math.random() * 84 }]);
      setTimeout(() => setCheers((x) => x.filter((y) => y.key !== key)), 2300);
    };
    const onKicked = (k) => { if (k.matchId === id) { toast({ title: 'Removed from match', body: 'The umpire removed you from this match.' }); nav('/'); } };
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
  const myTurn = !!cur && state.status === 'live' && !state.paused &&
    ((cur.phase === 'awaiting_sequence' && cur.bowlerId === me) || (cur.phase === 'awaiting_shot' && cur.set?.batterId === me));
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
  const tabs = [['play', 'Play'], ['card', 'Scorecard'], ['chat', 'Chat'], ...(isUmp ? [['ump', 'Umpire']] : [])];

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
            {tab === 'play' && <PlayTab state={state} priv={priv} me={me} isUmp={isUmp} online={online} />}
            {tab === 'card' && <Scorecards state={state} />}
            {tab === 'ump' && isUmp && <UmpirePanel state={state} priv={priv} me={me} online={online} />}
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
            className={`relative py-3 font-display text-lg font-bold ${tab === k ? 'text-flood' : 'text-chalk-dim'}`}>
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

function PlayTab({ state, priv, me, isUmp, online }) {
  const cur = state.current;
  if (state.status === 'lobby') return <Lobby state={state} me={me} isUmp={isUmp} online={online} />;
  if (state.status === 'completed' || state.status === 'abandoned') {
    return <><ResultCard state={state} /><Scorecards state={state} /></>;
  }
  const strip = (
    <section className="panel mown p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="font-display text-xl font-bold">{cur?.open ? 'This over' : 'Last over'}</h2>
        <span className="text-sm text-chalk-dim">Run rate {cur?.runRate}</span>
      </div>
      <div className="mx-auto max-w-lg"><OverStrip set={cur?.set} /></div>
    </section>
  );
  let panel = null;
  if (state.status === 'innings_break') panel = <InningsBreak state={state} isUmp={isUmp} />;
  else if (cur.phase === 'paused') panel = <Waiting title="Play is paused" body="The umpire will resume the match shortly." />;
  else if (cur.phase === 'awaiting_sequence') {
    panel = cur.bowlerId === me
      ? <BowlPanel matchId={state.id} nextBatter={cur.strikerName} />
      : <Waiting title={`${cur.bowlerName} is sealing the over`}
          body={cur.strikerId === me ? "You're on strike next. Get ready to pick." : `${cur.strikerName} is waiting on strike.`} />;
  } else if (cur.phase === 'awaiting_shot') {
    if (cur.set?.batterId === me) panel = <BatPanel matchId={state.id} cur={cur} />;
    else if (priv.mySequence) panel = <MySealedOver seq={priv.mySequence} set={cur.set} />;
    else panel = <Waiting title={`${cur.strikerName} is picking a number`} body={`Ball ${(cur.set?.balls.filter((b) => !b.voided).length || 0) + 1} of the over against ${cur.bowlerName}.`} />;
  }
  return (
    <>
      {strip}
      {panel}
      <section className="panel p-4">
        <h2 className="mb-2 font-display text-xl font-bold">Ball by ball</h2>
        <Commentary items={state.commentary} />
      </section>
    </>
  );
}
