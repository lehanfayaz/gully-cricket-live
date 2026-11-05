import { useEffect, useState } from 'react';

// A person's picture: their uploaded one, a real squad player's photo, or their initials.
const bust = new Map(); // userId -> version, bumped after an upload so the new picture shows straight away
export const refreshAvatar = (id) => bust.set(id, Date.now());

export default function Avatar({ id, name, size = 40, className = '' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [id]);
  const initials = (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const s = { width: size, height: size, fontSize: Math.max(10, size * 0.38) };
  if (!id || failed) return <span aria-hidden style={s} className={`grid shrink-0 place-items-center rounded-full bg-pitch-600 font-display font-bold text-chalk-dim ${className}`}>{initials}</span>;
  return <img src={`/api/users/${id}/avatar${bust.get(id) ? `?v=${bust.get(id)}` : ''}`} alt="" style={s} loading="lazy" onError={() => setFailed(true)} className={`shrink-0 rounded-full bg-pitch-600 object-cover ${className}`} />;
}

// Shrink a picked photo on the device to a 256px square JPEG before upload.
export function shrinkImage(file, px = 256) {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type)) return reject(new Error('Pick a picture file.'));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = px; c.height = px;
      const side = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, px, px);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('That picture could not be read.'));
    img.src = URL.createObjectURL(file);
  });
}
