// Shared bits: icons, album covers (with offline fallback), the right-click menu and toasts.
import { useEffect, useRef, useState } from 'react';
import { downloads, dl, lib, library, openArtist, toast, ui, useStore } from './state.js';
import { addToQueue, current, playNext, playTrack, startRadio } from './player.js';

const P = {
  play: <path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none" />,
  next: <path d="M5 5l10 7-10 7zM16.5 5H19v14h-2.5z" fill="currentColor" stroke="none" />,
  download: <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />,
  queue: <><path d="M3 6h13M3 12h13M3 18h9" /><path d="M18 14v7l4-3.5z" fill="currentColor" /></>,
  heart: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z" />,
  heartFill: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z" fill="currentColor" />,
  back: <path d="M15 18l-6-6 6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  radio: <><circle cx="12" cy="12" r="2" /><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19.1 4.9a10 10 0 0 1 0 14.2M4.9 19.1a10 10 0 0 1 0-14.2" /></>,
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  link: <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />,
  trash: <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  picture: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></>,
};

export function Icon({ name, size = 16, stroke = 2.2 }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {P[name]}
    </svg>
  );
}

// An album cover; offline it falls back to the copy saved with the download.
export function Cover({ track, className = '' }) {
  const first = track?.cover;
  const [url, setUrl] = useState(first);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setUrl(first);
    setFailed(false);
  }, [first]);
  const onError = () => {
    if (track?.id && !url?.startsWith('abyss://')) setUrl(`abyss://cover/${encodeURIComponent(track.id)}`);
    else setFailed(true);
  };
  return (
    <div className={`cover ${className}`}>
      {url && !failed ? <img src={url} alt="" draggable={false} referrerPolicy="no-referrer" onError={onError} /> : <div className="ph" aria-hidden="true"><i /><i /></div>}
    </div>
  );
}

// ---------- right-click menu ----------

export function openMenu(e, track, extra = {}) {
  e.preventDefault();
  e.stopPropagation();
  ui.set({ menu: { x: e.clientX, y: e.clientY, track, ...extra } });
}

export function ContextMenu() {
  const menu = useStore(ui, (s) => s.menu);
  const playlists = useStore(library, (s) => s.playlists);
  const liked = useStore(library, (s) => s.liked);
  const d = useStore(downloads, (s) => (menu ? s.items[menu.track.id] : null));
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const [sub, setSub] = useState(false);
  const [naming, setNaming] = useState(null); // the new playlist's name while it's being typed

  useEffect(() => {
    if (!menu) return;
    setSub(false);
    setNaming(null);
    const close = (e) => { if (!ref.current?.contains(e.target)) ui.set({ menu: null }); };
    const esc = (e) => e.key === 'Escape' && ui.set({ menu: null });
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    window.addEventListener('blur', () => ui.set({ menu: null }), { once: true });
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [menu]);

  useEffect(() => {
    if (!menu || !ref.current) return;
    const { offsetWidth: w, offsetHeight: h } = ref.current;
    setPos({ x: Math.max(6, Math.min(menu.x, window.innerWidth - w - 6)), y: Math.max(6, Math.min(menu.y, window.innerHeight - h - 6)) });
    (ref.current.querySelector('input') ?? ref.current.querySelector('button'))?.focus();
  }, [menu, sub, naming !== null]);

  if (!menu) return null;
  const t = menu.track;
  const isLiked = liked.some((x) => x.id === t.id);
  const artists = t.artists?.filter((a) => a.name && a.name !== 'N/A') ?? [];
  const run = (fn) => () => { ui.set({ menu: null }); fn(); };

  return (
    <div className="menu" ref={ref} role="menu" style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y }}>
      {sub ? (
        <>
          <button role="menuitem" onClick={() => setSub(false)}><Icon name="back" />back</button>
          <hr />
          {naming === null ? (
            <button role="menuitem" onClick={() => setNaming(`playlist ${playlists.length + 1}`)}><Icon name="plus" />new playlist</button>
          ) : (
            <form className="menu-name" onSubmit={(e) => { e.preventDefault(); const name = naming.trim() || `playlist ${playlists.length + 1}`; ui.set({ menu: null }); lib.createPlaylist(name, [t]); toast(`made “${name}” with this song`); }}>
              <input aria-label="Playlist name" value={naming} maxLength={60} onChange={(e) => setNaming(e.target.value)} onFocus={(e) => e.target.select()} />
              <button type="submit">OK</button>
            </form>
          )}
          {playlists.map((p) => <button key={p.id} role="menuitem" onClick={run(() => lib.addToPlaylist(p.id, t))}><Icon name="list" />{p.name}</button>)}
        </>
      ) : (
        <>
          {t.id !== current()?.id && <button role="menuitem" onClick={run(() => playTrack(t))}><Icon name="play" />play</button>}
          <button role="menuitem" onClick={run(() => playNext(t))}><Icon name="next" />play next</button>
          <button role="menuitem" onClick={run(() => addToQueue(t))}><Icon name="queue" />add to queue</button>
          <button role="menuitem" onClick={run(() => startRadio(t))}><Icon name="radio" />start radio</button>
          {artists.slice(0, 3).map((a, i) => <button key={`${a.name}-${i}`} role="menuitem" onClick={run(() => openArtist(a))}><Icon name="user" />go to {a.name}</button>)}
          <hr />
          <button role="menuitem" onClick={run(() => lib.toggleLike(t))}><Icon name={isLiked ? 'heartFill' : 'heart'} />{isLiked ? 'remove from liked' : 'like'}</button>
          <button role="menuitem" onClick={() => setSub(true)}><Icon name="plus" />add to playlist…</button>
          {menu.playlistId && <button role="menuitem" onClick={run(() => lib.removeFromPlaylist(menu.playlistId, t.id))}><Icon name="x" />remove from this playlist</button>}
          {d?.status === 'done' ? (
            <button role="menuitem" onClick={run(() => dl.remove(t.id))}><Icon name="trash" />remove download</button>
          ) : (
            <button role="menuitem" onClick={run(() => dl.start(t))}><Icon name="download" />download</button>
          )}
          <hr />
          <button role="menuitem" onClick={run(() => { navigator.clipboard.writeText(`https://music.youtube.com/watch?v=${t.id}`); toast('link copied'); })}><Icon name="link" />copy link</button>
        </>
      )}
    </div>
  );
}

export function Toast() {
  const text = useStore(ui, (s) => s.toast);
  return <div className="toast" role="status" aria-live="polite" hidden={!text}>{text}</div>;
}
