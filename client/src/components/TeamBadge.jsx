// Team identity: the provider's logo if there is one, otherwise a flag (international) or a coloured badge with the short code.
const flagOf = (code) => {
  if (!code) return null;
  if (code === 'GB-ENG') return '🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
  if (code === 'GB-SCT') return '🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
  if (!/^[A-Z]{2}$/.test(code)) return null;
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
};
const textOn = (hex) => {
  const h = (hex || '#2A6E4C').replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? '#0A1F17' : '#F2F5EC';
};

export default function TeamBadge({ team, size = 32, className = '' }) {
  if (!team) return null;
  const s = { width: size, height: size, fontSize: Math.max(9, size * 0.32) };
  if (team.logo) return <img src={team.logo} alt="" style={s} className={`shrink-0 rounded-full bg-chalk object-contain p-0.5 ${className}`} loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} />;
  const flag = flagOf(team.country);
  if (flag) return <span aria-hidden style={{ ...s, fontSize: size * 0.72, lineHeight: 1 }} className={`grid shrink-0 place-items-center ${className}`}>{flag}</span>;
  return (
    <span aria-hidden style={{ ...s, background: team.color || '#2A6E4C', color: textOn(team.color) }}
      className={`grid shrink-0 place-items-center rounded-full font-display font-extrabold leading-none ring-2 ring-chalk/20 ${className}`}>
      {(team.short || team.name || '?').slice(0, 4)}
    </span>
  );
}
