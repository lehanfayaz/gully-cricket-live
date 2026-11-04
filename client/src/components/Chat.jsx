// Stadium chat (public) plus the private bowler–umpire line.
import { useEffect, useMemo, useRef, useState } from 'react';
import { emit, getSocket } from '../api.js';
import { useApp } from '../App.jsx';

const REACTIONS = ['🔥', '👏', '😂', '😱', '🏏', '💯'];
const CHEERS = ['🔥', '👏', '😱', '🏏', '🎉', '😂'];
const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function Chat({ state, me, priv, messages, className = '' }) {
  const { toast } = useApp();
  const isUmp = priv?.isUmpire;
  const mine = state.members.find((m) => m.id === me);
  const [channel, setChannel] = useState('public');
  const [text, setText] = useState('');
  const [seen, setSeen] = useState({});
  const listRef = useRef(null);

  const channels = useMemo(() => {
    const list = [{ key: 'public', label: 'Stadium' }];
    if (isUmp) {
      const ids = new Set(messages.filter((m) => m.channel.startsWith('pvt:')).map((m) => m.channel.slice(4)));
      if (state.current?.bowlerId) ids.add(state.current.bowlerId);
      for (const id of ids) {
        if (id === me) continue;
        const name = state.members.find((m) => m.id === id)?.name || 'Player';
        list.push({ key: `pvt:${id}`, label: `🔒 ${name}` });
      }
    } else if (mine?.team) list.push({ key: `pvt:${me}`, label: '🔒 Umpire' });
    return list;
  }, [isUmp, messages, state.current?.bowlerId, state.members, me, mine?.team]);

  const shown = messages.filter((m) => m.channel === channel);
  const lastId = shown.length ? shown[shown.length - 1].id : 0;
  useEffect(() => { setSeen((s) => ({ ...s, [channel]: lastId })); }, [channel, lastId]);
  useEffect(() => {
    const el = listRef.current; if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [shown.length, channel]);
  useEffect(() => { listRef.current && (listRef.current.scrollTop = listRef.current.scrollHeight); }, [channel]);

  const unread = (key) => messages.filter((m) => m.channel === key && m.id > (seen[key] || 0) && m.userId && m.userId !== me).length;

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    const r = await emit('chat:send', { matchId: state.id, channel, text });
    if (r.ok) setText(''); else toast({ title: 'Message not sent', body: r.error, ms: 3000 });
  };
  const cheer = (emoji) => getSocket().emit('cheer', { matchId: state.id, emoji });

  return (
    <section className={`panel flex min-h-0 flex-col ${className}`} aria-label="Match chat">
      {channels.length > 1 && (
        <div className="no-scrollbar flex gap-1 overflow-x-auto border-b border-pitch-600 p-2" role="tablist">
          {channels.map((c) => {
            const n = channel === c.key ? 0 : unread(c.key);
            return (
              <button key={c.key} role="tab" aria-selected={channel === c.key} onClick={() => setChannel(c.key)}
                className={`whitespace-nowrap rounded-full px-3 py-1 text-sm font-semibold ${channel === c.key ? 'bg-chalk text-pitch-900' : 'bg-pitch-700 text-chalk-dim'}`}>
                {c.label}{n ? <span className="ml-1.5 rounded-full bg-leather px-1.5 text-xs text-chalk">{n}</span> : null}
              </button>
            );
          })}
        </div>
      )}
      {channel !== 'public' && (
        <p className="border-b border-pitch-600 px-3 py-1.5 text-xs text-chalk-dim">Private line between {isUmp ? 'you and this player' : 'you and the umpire'}. Nobody else can read it.</p>
      )}
      <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {shown.length === 0 && <p className="text-center text-sm text-chalk-dim">{channel === 'public' ? 'Say something to get the stands going.' : 'No messages yet.'}</p>}
        {shown.map((m) => <Message key={m.id} m={m} me={me} state={state} isUmp={isUmp} />)}
      </div>
      {channel === 'public' && (
        <div className="flex justify-around border-t border-pitch-600 px-2 py-1" aria-label="Send a cheer to the stadium">
          {CHEERS.map((e) => <button key={e} onClick={() => cheer(e)} className="rounded-lg px-2 py-1 text-2xl transition hover:bg-pitch-600 active:scale-90" aria-label={`Cheer ${e}`}>{e}</button>)}
        </div>
      )}
      <form onSubmit={send} className="flex gap-2 border-t border-pitch-600 p-2">
        <input aria-label="Message" className="field py-2.5" value={text} onChange={(e) => setText(e.target.value)} maxLength={300}
          placeholder={priv?.muted && channel === 'public' ? 'The umpire has muted you' : channel === 'public' ? 'Message the stadium' : 'Message privately'}
          disabled={priv?.muted && channel === 'public'} />
        <button className="btn-go px-4 py-2.5" disabled={!text.trim()}>Send</button>
      </form>
    </section>
  );
}

function Message({ m, me, state, isUmp }) {
  const { toast } = useApp();
  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState(false);
  if (m.kind !== 'user') {
    const meta = m.meta || {};
    const tone = meta.type === 'ball'
      ? meta.wicket ? 'bg-leather/90 text-chalk' : meta.runs === 6 ? 'bg-flood text-pitch-900' : meta.runs === 4 ? 'bg-turf text-pitch-900' : 'bg-pitch-700/80 text-chalk-dim'
      : meta.type === 'result' ? 'bg-flood text-pitch-900 font-bold' : meta.type === 'dispute' || meta.type === 'correction' ? 'bg-[#3a2a12] text-flood' : 'text-chalk-faint';
    return <div className={`mx-auto max-w-[95%] rounded-lg px-3 py-1 text-center text-xs ${tone}`}>{m.text}</div>;
  }
  const mineMsg = m.userId === me;
  const react = async (emoji) => { setPicker(false); const r = await emit('chat:react', { matchId: state.id, messageId: m.id, emoji }); if (!r.ok) toast({ title: 'Reaction failed', body: r.error, ms: 2500 }); };
  const mod = async (action) => { setMenu(false); const r = await emit('umpire', { matchId: state.id, action }); if (!r.ok) toast({ title: 'Not done', body: r.error }); };
  const target = state.members.find((x) => x.id === m.userId);
  return (
    <div className={`group flex flex-col ${mineMsg ? 'items-end' : 'items-start'}`}>
      <div className="flex items-baseline gap-2 px-1 text-xs text-chalk-faint">
        <span className="font-semibold text-chalk-dim">{m.name}{m.userId === state.umpire.id ? ' (umpire)' : ''}</span>
        <time>{time(m.at)}</time>
      </div>
      <div className="relative flex max-w-[85%] items-center gap-1">
        <div className={`rounded-2xl px-3 py-2 text-[15px] ${mineMsg ? 'rounded-br-sm bg-turf text-pitch-900' : 'rounded-bl-sm bg-pitch-600'} ${m.deleted ? 'italic opacity-60' : ''}`}>
          {m.deleted ? 'Removed by the umpire' : m.text}
        </div>
        {!m.deleted && (
          <span className="flex shrink-0 opacity-60 transition group-hover:opacity-100">
            <button className="rounded px-1 text-sm hover:bg-pitch-600" aria-label="React" onClick={() => setPicker((p) => !p)}>☺</button>
            {isUmp && !mineMsg && <button className="rounded px-1 text-sm hover:bg-pitch-600" aria-label="Moderate" onClick={() => setMenu((x) => !x)}>⋯</button>}
          </span>
        )}
        {picker && (
          <div className="pop absolute top-full z-10 mt-1 flex gap-1 rounded-full bg-pitch-900 p-1 shadow-xl ring-1 ring-pitch-500">
            {REACTIONS.map((e) => <button key={e} onClick={() => react(e)} className="rounded-full px-1.5 text-xl hover:bg-pitch-600">{e}</button>)}
          </div>
        )}
        {menu && (
          <div className="pop absolute right-0 top-full z-10 mt-1 w-44 overflow-hidden rounded-lg bg-pitch-900 text-sm shadow-xl ring-1 ring-pitch-500">
            <button className="block w-full px-3 py-2 text-left hover:bg-pitch-600" onClick={() => mod({ type: 'delete_message', messageId: m.id })}>Remove message</button>
            {target && <button className="block w-full px-3 py-2 text-left hover:bg-pitch-600" onClick={() => mod({ type: 'mute', userId: m.userId, muted: !target.muted })}>{target.muted ? 'Unmute' : 'Mute'} {m.name}</button>}
            {target && <button className="block w-full px-3 py-2 text-left text-leather hover:bg-pitch-600" onClick={() => mod({ type: 'kick', userId: m.userId })}>Remove {m.name} from match</button>}
          </div>
        )}
      </div>
      {m.reactions?.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-1 px-1">
          {m.reactions.map((r) => (
            <button key={r.emoji} onClick={() => react(r.emoji)} className={`rounded-full px-2 py-0.5 text-xs ${r.users.includes(me) ? 'bg-flood/25 ring-1 ring-flood' : 'bg-pitch-700'}`}>{r.emoji} {r.n}</button>
          ))}
        </div>
      )}
    </div>
  );
}
