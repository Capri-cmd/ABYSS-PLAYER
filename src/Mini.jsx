// abyss — a classic three-window stack (player, art + lyrics, playlist) in the spirit of old
// desktop players, with YouTube Music, offline downloads and skins inside it.
import { useEffect, useRef, useState } from 'react';
import { api, artistText, createStore, dayKey, dl, downloads, fmtTime, isPlayable, lib, library, nav, navBack, navClear, openArtist, openList, prefs, recall, remember, settings, toast, useStore } from './state.js';
import { audio, clearUpcoming, cycleRepeat, getAnalyser, jump, next, player, playList, playTrack, prev, seek, setCrossfade, setVolume, shufflePlay, toggle, toggleShuffle } from './player.js';
import { ContextMenu, Cover, Icon, openMenu, Toast } from './ui.jsx';
import { useDrag } from './drag.js';

// Each skin is a set of colors. Every skin has an art screen with its own picture (the user's png).
// Skins listed in SKIN_ICONS (electron/main.js) also change the taskbar icon.
export const SKINS = {
  abyss: { name: 'abyss', desk: '#e9e2bd', body: '#FFF6CA', ink: '#336699', lcd: '#1f3a57', lcdInk: '#FFF6CA' },
  aqua: { name: 'aqua', desk: '#bfe6ea', body: '#eaf8f9', ink: '#2a8c94', lcd: '#1f6f75', lcdInk: '#c9fbff' },
  rosemary: { name: 'rosemary', desk: '#fbe4ec', body: '#ffe3ec', ink: '#c2457a', lcd: '#4a1f33', lcdInk: '#ffd6e5' },
  mint: { name: 'mint', desk: '#dfe9d2', body: '#eef6e2', ink: '#4f7a2a', lcd: '#1f2e14', lcdInk: '#d6f0b8' },
  wired: { name: 'wired', desk: '#15151b', body: '#2a2a33', ink: '#c9c2d9', lcd: '#0b0b10', lcdInk: '#c9c2d9' },
};
const SKIN_IDS = Object.keys(SKINS);
const TALL_DEFAULT = 880;

// The picture of each skin, shared by the art screen and the settings panel.
const art = createStore({});
const loadArt = async (skin) => art.set({ [skin]: await api('skin:art', skin) });

const T = {
  prev: 'M19 5L9 12l10 7zM5 5h2.5v14H5z',
  play: 'M7 4.5v15l12.5-7.5z',
  pause: 'M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z',
  stop: 'M6 6h12v12H6z',
  next: 'M5 5l10 7-10 7zM16.5 5H19v14h-2.5z',
};

export function Mini() {
  const skinId = useStore(settings, (s) => s.skin);
  const skin = SKINS[skinId] ?? SKINS.abyss;
  const flag = (key, fallback) => recall(key, fallback) === '1';
  const [showPl, setShowPl] = useState(() => flag('abyss.pl', '1'));
  const [showLy, setShowLy] = useState(() => flag('abyss.ly', '1'));
  const [showArt, setShowArt] = useState(() => flag('abyss.art', '1'));
  const [showSet, setShowSet] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const root = useRef(null);
  const tall = showPl || showSet;

  // Opening an artist from anywhere brings the playlist window up to show their page.
  const navDepth = useStore(nav, (s) => s.stack.length);
  useEffect(() => { if (navDepth) { setShowPl(true); setShowSet(false); } }, [navDepth]);

  useEffect(() => { loadArt(skinId); }, [skinId]);
  useEffect(() => { api('win:profile', showProfile); }, [showProfile]);

  // The window grows to the remembered height when the playlist or settings are open, and
  // shrinks to fit when only the player (and art / lyrics) is showing.
  useEffect(() => {
    remember('abyss.pl', showPl ? '1' : '0');
    remember('abyss.ly', showLy ? '1' : '0');
    remember('abyss.art', showArt ? '1' : '0');
    // A timer, not requestAnimationFrame: frames don't run while the window is covered.
    const id = setTimeout(() => {
      if (tall) api('win:fit', Number(recall('abyss.height', 0)) || TALL_DEFAULT, false);
      else api('win:fit', root.current.offsetHeight, true);
    }, 30);
    return () => clearTimeout(id);
  }, [showPl, showLy, showArt, tall, skinId]);
  useEffect(() => {
    const onResize = () => tall && remember('abyss.height', String(window.innerHeight));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [tall]);

  useEffect(() => {
    const onKey = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
      if (e.code === 'Space' && !/BUTTON/.test(document.activeElement?.tagName)) { e.preventDefault(); toggle(); }
      if (e.ctrlKey && e.key === 'ArrowRight') next();
      if (e.ctrlKey && e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const style = { '--m-desk': skin.desk, '--m-body': skin.body, '--m-ink': skin.ink, '--m-lcd': skin.lcd, '--m-lcd-ink': skin.lcdInk };
  return (
    <div className={`mini skin-${skinId} ${tall ? 'tall' : ''}`} style={style} ref={root}>
      {showProfile && <Profile onClose={() => setShowProfile(false)} onSettings={() => setShowSet(true)} />}
      <div className="stack">
        <PlayerWindow
          toggles={{ showPl, showLy, showArt, showSet, showProfile }}
          onPl={() => { setShowPl((v) => !v); setShowSet(false); }}
          onLy={() => setShowLy((v) => !v)}
          onArt={() => setShowArt((v) => !v)}
          onSet={() => setShowSet((v) => !v)}
          onProfile={() => setShowProfile((v) => !v)}
        />
        {showArt && <ArtScreen skinId={skinId} />}
        {showLy && <Ticker />}
        {showSet ? <SettingsWindow showArt={showArt} onArt={() => setShowArt((v) => !v)} onClose={() => setShowSet(false)} /> : showPl && <Playlist />}
      </div>
      <ContextMenu />
      <Toast />
    </div>
  );
}

// ---------- player window ----------

function TitleBar({ showSet, onSet, showProfile, onProfile }) {
  const onTop = useStore(settings, (s) => s.onTop);
  const account = useStore(settings, (s) => s.account);
  return (
    <div className="mtitle">
      <button className={`mt-me ${showProfile ? 'on' : ''}`} aria-pressed={showProfile} title="Your profile" onClick={onProfile}>
        {account?.photo ? <img src={account.photo} alt="" referrerPolicy="no-referrer" /> : <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>}
      </button>
      <span className="grow">ABYSS</span>
      <button className={`mt-btn ${showSet ? 'on' : ''}`} aria-pressed={showSet} title="Settings" onClick={onSet}>SET</button>
      <button className={`mt-btn ${onTop ? 'on' : ''}`} aria-pressed={onTop} title="Keep on top of other windows" onClick={() => api('win:on-top', !onTop)}>PIN</button>
      <button className="mt-btn" aria-label="Minimize" onClick={() => api('win:minimize')}>_</button>
      <button className="mt-btn" aria-label="Close" onClick={() => api('win:close')}>X</button>
    </div>
  );
}

function PlayerWindow({ toggles, onPl, onLy, onArt, onSet, onProfile }) {
  const t = useStore(player, (s) => s.queue[s.index]);
  const playing = useStore(player, (s) => s.playing);
  const liked = useStore(library, (s) => (t ? s.liked.some((x) => x.id === t.id) : false));
  const d = useStore(downloads, (s) => (t ? s.items[t.id] : null));
  const buttons = [
    ['prev', 'Previous', () => prev(), false],
    ['play', 'Play', () => !playing && toggle(), playing],
    ['pause', 'Pause', () => playing && toggle(), !playing && audio.currentTime > 0],
    ['stop', 'Stop', () => { if (playing) toggle(); seek(0); }, false],
    ['next', 'Next', () => next(), false],
  ];
  const dlLabel = d?.status === 'done' ? '✓ SAVED' : d?.status === 'downloading' ? `${Math.round((d.progress || 0) * 100)}%` : d?.status === 'queued' ? 'QUEUED' : '⬇ SAVE';
  return (
    <section className="mwin" aria-label="Player">
      <TitleBar showSet={toggles.showSet} onSet={onSet} showProfile={toggles.showProfile} onProfile={onProfile} />
      <div className="mbody">
        <Lcd />
        <MiniSeek />
        <div className="mrow">
          {buttons.map(([k, label, fn, on]) => (
            <button key={k} className={`mround ${on ? 'on' : ''}`} aria-label={label} onClick={fn}>
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d={T[k]} /></svg>
            </button>
          ))}
          <MiniVolume />
        </div>
        <div className="mrow">
          <button className={`mpill ${toggles.showPl ? 'on' : ''}`} aria-pressed={toggles.showPl} title="Playlist" onClick={onPl}>PL</button>
          <button className={`mpill ${toggles.showLy ? 'on' : ''}`} aria-pressed={toggles.showLy} title="Lyrics" onClick={onLy}>LY</button>
          <button className={`mpill ${toggles.showArt ? 'on' : ''}`} aria-pressed={toggles.showArt} title="Art screen" onClick={onArt}>ART</button>
          <span className="grow" />
          <button className={`mpill ${d?.status === 'done' ? 'on' : ''}`} title="Save this song for offline" disabled={!t} onClick={() => t && dl.start(t)}>{dlLabel}</button>
          <button className={`mpill ${liked ? 'on' : ''}`} aria-pressed={liked} title={liked ? 'Unlike' : 'Like'} disabled={!t} onClick={() => t && lib.toggleLike(t)}>♥</button>
        </div>
      </div>
    </section>
  );
}

function Lcd() {
  const t = useStore(player, (s) => s.queue[s.index]);
  const time = useStore(player, (s) => s.time);
  const duration = useStore(player, (s) => s.duration);
  const playing = useStore(player, (s) => s.playing);
  const loading = useStore(player, (s) => s.loading);
  const shuffle = useStore(player, (s) => s.shuffle);
  const repeat = useStore(player, (s) => s.repeat);
  const offline = useStore(downloads, (s) => (t ? s.items[t.id]?.status === 'done' : false));
  const [remaining, setRemaining] = useState(false);
  const bars = useRef(null);

  useEffect(() => {
    const els = [...bars.current.children];
    const data = new Uint8Array(64);
    let raf;
    const loop = () => {
      const a = getAnalyser();
      if (a && !audio.paused) {
        a.getByteFrequencyData(data);
        els.forEach((b, i) => {
          const v = data[Math.min(63, 1 + Math.floor((i / els.length) ** 1.4 * 46))] / 255;
          b.style.height = `${Math.max(6, v * v * 100)}%`;
        });
      } else els.forEach((b) => (b.style.height = '6%'));
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, []);

  const text = t ? `${artistText(t)} — ${t.title}${t.album?.name ? ` :: ${t.album.name}` : ''} ::` : 'abyss :: search a song to start ::';
  const state = playing ? 'play' : time > 0 ? 'pause' : 'stop';
  const shown = remaining && duration ? `-${fmtTime(duration - time)}` : fmtTime(time);
  return (
    <div className="mlcd">
      <div className="mlcd-left">
        <button className="mlcd-time" title="Elapsed / remaining" onClick={() => setRemaining((v) => !v)}>
          <span className="glyph" aria-label={loading ? 'loading' : state}>
            {loading ? '…' : <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d={T[state]} /></svg>}
          </span>
          <span className="digits">{shown}</span>
        </button>
        <div className="mbadges">
          <span>{offline ? 'OFFLINE' : 'STREAM'}</span>
          {shuffle && <span>SHF</span>}
          {repeat !== 'off' && <span>{repeat === 'one' ? 'RPT1' : 'RPT'}</span>}
        </div>
      </div>
      <div className="mlcd-right">
        <div className="mbars" ref={bars} aria-hidden="true">{Array.from({ length: 24 }, (_, i) => <i key={i} />)}</div>
        <div className="mmarquee" title={text}>
          <span style={{ animationDuration: `${Math.max(8, text.length * 0.28)}s` }}>{text}&nbsp;&nbsp;&nbsp;{text}&nbsp;&nbsp;&nbsp;</span>
        </div>
      </div>
    </div>
  );
}

function MiniSeek() {
  const time = useStore(player, (s) => s.time);
  const duration = useStore(player, (s) => s.duration);
  const [drag, setDrag] = useState(null);
  const [ref, handlers] = useDrag((r) => { setDrag(null); seek(r * duration); }, (r) => setDrag(r * duration));
  const pct = duration ? ((drag ?? time) / duration) * 100 : 0;
  return (
    <div ref={ref} className="mseek" role="slider" tabIndex={0} aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(drag ?? time)}
      onKeyDown={(e) => { if (e.key === 'ArrowRight') seek(Math.min(duration, time + 5)); if (e.key === 'ArrowLeft') seek(Math.max(0, time - 5)); }} {...handlers}>
      <div className="fill" style={{ width: `${pct}%` }} />
      <div className="knob" style={{ left: `${pct}%` }} />
    </div>
  );
}

function MiniVolume() {
  const volume = useStore(player, (s) => s.volume);
  const [ref, handlers] = useDrag(setVolume, setVolume);
  return (
    <div className="mvol-wrap" title={`Volume ${Math.round(volume * 100)}%`}>
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5L6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7" /></svg>
      <div ref={ref} className="mvol" role="slider" tabIndex={0} aria-label="Volume" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(volume * 100)}
        onWheel={(e) => setVolume(volume - Math.sign(e.deltaY) * 0.05)}
        onKeyDown={(e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setVolume(volume + 0.05); if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setVolume(volume - 0.05); }} {...handlers}>
        <div className="fill" style={{ width: `${volume * 100}%` }} />
      </div>
    </div>
  );
}

// ---------- profile ----------
// A side capsule (like a music gadget clipped to a bag): your picture, who you are, and what
// you listen to. It slides out to the left of the player.

function listenTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

// The last seven days of plays as little LCD bars, today on the right.
function Week({ days }) {
  const list = Array.from({ length: 7 }, (_, k) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - k));
    return { key: dayKey(d), letter: 'SMTWTFS'[d.getDay()], n: days[dayKey(d)] ?? 0 };
  });
  const max = Math.max(1, ...list.map((d) => d.n));
  const total = list.reduce((a, d) => a + d.n, 0);
  return (
    <div className="pweek">
      <div className="mset-head">THIS WEEK <span className="cnt">{total} plays</span></div>
      <div className="mlcd pweek-bars" role="img" aria-label={`Plays over the last seven days: ${list.map((d) => d.n).join(', ')}`}>
        {list.map((d, k) => (
          <div key={d.key} className={k === 6 ? 'today' : ''} title={`${d.key}: ${d.n} plays`}>
            <i style={{ height: `${d.n ? Math.max(8, (d.n / max) * 100) : 3}%` }} />
            <span>{d.letter}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Profile({ onClose, onSettings }) {
  const s = useStore(settings);
  const url = useStore(art, (st) => st[s.skin]);
  const stats = useStore(library, (l) => l.stats);
  const liked = useStore(library, (l) => l.liked.length);
  const saved = useStore(downloads, (d) => Object.values(d.items).filter((x) => x.status === 'done').length);
  const t = useStore(player, (p) => p.queue[p.index]);
  const tops = Object.entries(stats.artists ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const recent = useStore(library, (l) => l.history).filter((x) => x.id !== t?.id).slice(0, 3);
  const queue = useStore(player, (p) => p.queue);
  const index = useStore(player, (p) => p.index);
  const upNext = queue.slice(index + 1, index + 4).map((u, k) => ({ t: u, i: index + 1 + k }));
  const name = s.signedIn ? s.account?.name || 'listener' : 'guest listener';

  return (
    <aside className="mprofile" aria-label="Your profile">
      <div className="mprofile-in">
        <div className="hook" aria-hidden="true" />
        <div className="capsule">
          <button className="cap-x mt-btn" aria-label="Close profile" onClick={onClose}>X</button>
          <div className="pic">
            {url ? <img src={url} alt="" draggable={false} /> : s.account?.photo ? <img src={s.account.photo} alt="" referrerPolicy="no-referrer" draggable={false} /> : (
              <button className="pic-empty" onClick={() => pickArt(s.skin)}><Icon name="picture" size={26} stroke={1.8} /><span>your picture</span></button>
            )}
            <div className="mart-scan" aria-hidden="true" />
          </div>
          <div className="who">
            {s.account?.photo && url && <img className="avatar" src={s.account.photo} alt="" referrerPolicy="no-referrer" />}
            <div className="grow">
              <div className="name" title={name}>{name}</div>
              <div className="handle">{s.signedIn ? s.account?.handle || 'youtube music' : 'not signed in'}</div>
            </div>
          </div>
          {!s.signedIn && <button className="mpill on" onClick={onSettings}>SIGN IN</button>}
          <div className="mlcd pstats">
            <div><span>PLAYS</span><b>{stats.plays}</b></div>
            <div><span>TIME</span><b>{listenTime(stats.seconds)}</b></div>
            <div><span>LIKED</span><b>{liked}</b></div>
            <div><span>OFFLINE</span><b>{saved}</b></div>
          </div>
          <Week days={stats.days ?? {}} />
          <div className="tops">
            <div className="mset-head">TOP ARTISTS</div>
            {tops.length ? tops.map(([artist, n], i) => (
              <button key={artist} className="top" onClick={() => openArtist({ name: artist })} title={`Open ${artist}`}>
                <span className="rank">{i + 1}</span>
                <span className="grow">
                  <span className="tname">{artist}</span>
                  <span className="tbar"><i style={{ width: `${(n / tops[0][1]) * 100}%` }} /></span>
                </span>
                <span className="cnt">{n}</span>
              </button>
            )) : <div className="top dim">play a few songs</div>}
          </div>
          {upNext.length > 0 && (
            <div className="precent">
              <div className="mset-head">UP NEXT</div>
              {upNext.map(({ t: u, i }) => (
                <button key={`${u.id}-${i}`} onClick={() => jump(i)} onContextMenu={(e) => openMenu(e, u)} title={`${u.title} — ${artistText(u)}`}>
                  <Cover track={u} />
                  <span className="grow"><span className="t">{u.title}</span><span className="a">{artistText(u)}</span></span>
                </button>
              ))}
            </div>
          )}
          {recent.length > 0 && (
            <div className="precent">
              <div className="mset-head">RECENT</div>
              {recent.map((r) => (
                <button key={r.id} onClick={() => playTrack(r)} onContextMenu={(e) => openMenu(e, r)} title={`${r.title} — ${artistText(r)}`}>
                  <Cover track={r} />
                  <span className="grow"><span className="t">{r.title}</span><span className="a">{artistText(r)}</span></span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

// ---------- art screen ----------
// Like the picture area of an old media player, with scanlines over it. It shows the song's cover;
// a picture the user picks for the skin fills the background, with the cover framed in front.

async function pickArt(skin) {
  const u = await api('skin:pick-art', skin);
  if (u) art.set({ [skin]: u });
}

function ArtScreen({ skinId }) {
  const t = useStore(player, (s) => s.queue[s.index]);
  const playing = useStore(player, (s) => s.playing);
  const url = useStore(art, (s) => s[skinId]);
  const [over, setOver] = useState(false);

  const onDrop = async (e) => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const u = await api('skin:set-art', skinId, window.abyss.pathForFile(file));
    if (u) art.set({ [skinId]: u });
    else toast('drop a png, jpg, webp or gif');
  };

  return (
    <section className={`mwin mart ${over ? 'over' : ''}`} aria-label="Art screen"
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <div className="mart-screen">
        {url && <img className="mart-bg" src={url} alt="" draggable={false} />}
        {t && <Cover track={t} className={url ? 'mart-cover' : 'mart-full'} />}
        {!url && !t && (
          <button className="mart-empty" onClick={() => pickArt(skinId)}>
            <Icon name="picture" size={30} stroke={1.8} />
            <span>choose a picture</span>
            <span className="hint">or drop a png here</span>
          </button>
        )}
        <div className="mart-scan" aria-hidden="true" />
        <div className="mart-status">{t ? (playing ? `♪ ${t.title}` : 'Paused') : 'Ready'}</div>
        <div className="mart-tools">
          <button className="mt-btn" onClick={() => pickArt(skinId)} title={url ? 'Change the picture' : 'Add a picture behind the cover'}>PIC</button>
          {url && <button className="mt-btn" onClick={async () => art.set({ [skinId]: await api('skin:clear-art', skinId) })} title="Remove the picture">X</button>}
        </div>
      </div>
    </section>
  );
}

// ---------- lyric ticker ----------

function Ticker() {
  const t = useStore(player, (s) => s.queue[s.index]);
  const [data, setData] = useState(null);
  const [active, setActive] = useState(-1);

  useEffect(() => {
    if (!t) return setData(null);
    let alive = true;
    setData(null);
    setActive(-1);
    api('lyrics:get', t).then((d) => alive && setData(d)).catch(() => alive && setData({ synced: false, lines: [] }));
    return () => (alive = false);
  }, [t?.id]);

  useEffect(() => {
    if (!data?.synced) return;
    let raf;
    const tick = () => {
      const now = audio.currentTime + 0.2;
      let i = -1;
      for (let k = 0; k < data.lines.length && data.lines[k].t <= now; k++) i = k;
      setActive((p) => (p === i ? p : i));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [data]);

  let prevLine = '';
  let line = '';
  if (!t) line = '♪ press play';
  else if (!data) line = 'finding lyrics…';
  else if (!data.lines.length) line = 'no lyrics for this one';
  else if (!data.synced) {
    prevLine = 'plain lyrics';
    line = data.lines.find((l) => l.text.trim())?.text ?? '';
  } else {
    prevLine = data.lines[active - 1]?.text ?? '';
    line = active < 0 ? '♪' : data.lines[active].text || '♪';
  }
  return (
    <section className="mwin mticker" aria-label="Lyrics">
      <span className="mside">LYRICS</span>
      <div className="mlcd small">
        <div className="prev">{prevLine || ' '}</div>
        <div className="cur">▸ {line}</div>
      </div>
    </section>
  );
}

// Artist names that open the artist's page. They sit inside song rows, so a click on a name
// opens the artist and a click anywhere else on the row still plays the song.
function Artists({ t }) {
  const list = t.artists?.filter((a) => a.name && a.name !== 'N/A') ?? [];
  if (!list.length) return <>{artistText(t)}</>;
  return list.map((a, i) => (
    <span key={`${a.name}-${i}`}>
      {i > 0 && ', '}
      <span className="alink" role="link" tabIndex={-1} title={`Open ${a.name}`}
        onClick={(e) => { e.stopPropagation(); openArtist(a); }}>{a.name}</span>
    </span>
  ));
}

// ---------- playlist window ----------

const TABS = [['queue', 'QUEUE'], ['library', 'LIBRARY'], ['search', 'SEARCH'], ['offline', 'OFFLINE']];

function totalTime(list) {
  const total = list.reduce((a, t) => a + (t.duration || 0), 0);
  const hours = Math.floor(total / 3600);
  return hours ? `${hours}:${fmtTime(total % 3600).padStart(5, '0')}` : fmtTime(total);
}

function Playlist() {
  const [tab, setTab] = useState(() => recall('abyss.tab', 'queue'));
  const queue = useStore(player, (s) => s.queue);
  const index = useStore(player, (s) => s.index);
  const shuffle = useStore(player, (s) => s.shuffle);
  const repeat = useStore(player, (s) => s.repeat);
  const items = useStore(downloads, (s) => s.items);
  const nowId = queue[index]?.id;

  useEffect(() => remember('abyss.tab', tab), [tab]);

  // Each tab produces: rows (songs or folders), how a song row plays, and the songs for DL ALL.
  const libView = useLibraryView();
  const search = useSearch();
  const navView = useNavView();
  const browsing = navView.active;
  let view;
  if (browsing) {
    view = navView.view;
  } else if (tab === 'queue') {
    const rows = queue.map((t, i) => ({ t, i })).slice(Math.max(0, index));
    view = { rows, play: (row) => jump(row.i), songs: rows.map((r) => r.t), empty: 'queue is empty — search a song and press play' };
  } else if (tab === 'library') {
    view = libView.view;
  } else if (tab === 'search') {
    const list = search.results ?? [];
    view = { rows: list.map((t, i) => ({ t, i })), play: (row) => playList(list, row.i), songs: list, empty: search.busy ? 'searching…' : search.results ? 'nothing found' : 'type a song or artist and press enter' };
  } else {
    const active = Object.values(items).filter((d) => d.status !== 'done' && d.track);
    const done = Object.values(items).filter((d) => d.status === 'done').map((d) => d.track);
    view = {
      rows: [...active.map((d) => ({ t: d.track, i: -1, dl: d })), ...done.map((t, i) => ({ t, i }))],
      play: (row) => (row.i < 0 ? null : playList(done, row.i)),
      songs: [],
      empty: 'nothing saved yet — use ⬇ SAVE or right-click a song › download',
    };
  }
  const songs = view.rows.filter((r) => r.t).map((r) => r.t);
  let n = 0;

  return (
    <section className="mwin mplaylist" aria-label="Playlist">
      <div className="mtitle">
        <span className="grow">PLAYLIST — {view.title ?? TABS.find(([k]) => k === tab)[1]}</span>
        <span>{songs.length}{songs.some((t) => t.duration) ? ` · ${totalTime(songs)}` : ''}</span>
      </div>
      <div className="mtabs" role="tablist" aria-label="Playlist view">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={!browsing && tab === k} className={!browsing && tab === k ? 'on' : ''} onClick={() => { navClear(); setTab(k); }}>{label}</button>
        ))}
      </div>
      <div className="mlist">
        {browsing && navView.bar}
        {!browsing && tab === 'search' && (
          <form className="msearch" onSubmit={(e) => { e.preventDefault(); search.run(); }}>
            <input aria-label="Search songs" placeholder="search songs, artists…" value={search.q} onChange={(e) => search.setQ(e.target.value)} />
            <button type="submit">GO</button>
          </form>
        )}
        {!browsing && tab === 'library' && libView.bar}
        {view.rows.length ? view.rows.map((row, k) => {
          if (row.label) return <div key={`label-${k}`} className="mlabel">{row.label}</div>;
          if (row.folder) {
            return (
              <button key={row.folder.id} className="mitem folder" onClick={row.open} onContextMenu={(e) => e.preventDefault()}>
                <span className="n">▸</span>
                <span className="name">{row.folder.name}</span>
                <span className="len">{row.folder.meta}</span>
              </button>
            );
          }
          const t = row.t;
          const d = row.dl ?? items[t.id];
          const now = t.id === nowId && (tab !== 'queue' || row.i === index);
          const mark = d?.status === 'done' ? '⬇' : d?.status === 'downloading' ? `${Math.round((d.progress || 0) * 100)}%` : d?.status === 'queued' ? '…' : d?.status === 'error' ? '!' : '';
          return (
            <button key={`${t.id}-${row.i}-${k}`} className={`mitem ${now ? 'now' : ''} ${row.dl ? 'pending' : ''}`} onClick={() => view.play(row)} onContextMenu={(e) => openMenu(e, t, { playlistId: view.playlistId })} title={`${t.title} — ${artistText(t)}`}>
              <span className="n">{String(++n).padStart(2, '0')}</span>
              <span className="name">{t.title}<span className="by"> — <Artists t={t} /></span></span>
              {mark && <span className="mark" title={d?.error || ''}>{mark}</span>}
              <span className="len">{t.duration ? fmtTime(t.duration) : ''}</span>
            </button>
          );
        }) : <div className="mempty">{view.loading ? 'loading…' : view.empty}</div>}
      </div>
      <div className="mfoot">
        <button className={shuffle ? 'on' : ''} aria-pressed={shuffle} onClick={toggleShuffle} title="Shuffle">SHUF</button>
        <button className={repeat !== 'off' ? 'on' : ''} onClick={cycleRepeat} title="Repeat: off / all / one">{repeat === 'one' ? 'RPT1' : 'RPT'}</button>
        <button onClick={clearUpcoming} title="Clear what's up next">CLR</button>
        <button onClick={() => { if (!queue.length) return; const p = lib.save(queue); toast(`saved “${p.name}” to your library`); }} title="Save the queue as a playlist">SAVE</button>
        <span className="grow" />
        <button onClick={() => dl.startMany(view.songs)} disabled={!view.songs.length} title="Save every song in this list for offline">⬇ ALL</button>
      </div>
    </section>
  );
}

// Artist pages, and albums / playlists opened from them. Pages are kept for the session so
// BACK is instant.
const pageCache = new Map();

function useNavView() {
  const stack = useStore(nav, (s) => s.stack);
  const top = stack[stack.length - 1] ?? null;
  const key = top ? `${top.kind}:${top.id ?? top.name}` : null;
  const [page, setPage] = useState({ key: null, data: null, failed: false });

  useEffect(() => {
    if (!key) return;
    if (pageCache.has(key)) return setPage({ key, data: pageCache.get(key), failed: false });
    let alive = true;
    setPage({ key, data: null, failed: false });
    const load = top.kind === 'artist' ? api('yt:artist', { id: top.id, name: top.name }) : api('yt:playlist', top.id);
    load.then((data) => {
      pageCache.set(key, data);
      if (alive) setPage({ key, data, failed: false });
    }).catch(() => {
      if (!alive) return;
      setPage({ key, data: null, failed: true });
      toast(top.kind === 'artist' ? `couldn’t open ${top.name}` : 'couldn’t load this list');
    });
    return () => (alive = false);
  }, [key]);

  if (!top) return { active: false };
  const data = page.key === key ? page.data : null;
  const isArtist = top.kind === 'artist';
  const tracks = data?.tracks ?? [];
  const name = data?.title || top.name;

  const bar = (
    <div className="mchips martist">
      <button onClick={navBack}>‹ BACK</button>
      {isArtist && data?.cover && <img className="martist-pic" src={data.cover} alt="" referrerPolicy="no-referrer" draggable={false} />}
      <span className="mchip-title" title={name}>{name}{isArtist && data?.subtitle ? <span className="martist-sub"> · {data.subtitle}</span> : null}</span>
      <button className="on" disabled={!tracks.length} onClick={() => playList(tracks, 0)}>PLAY</button>
      <button disabled={!tracks.length} onClick={() => shufflePlay(tracks)}>SHUF</button>
    </div>
  );

  let rows = [];
  if (!isArtist) {
    rows = tracks.map((t, i) => ({ t, i, list: tracks }));
  } else if (data) {
    if (tracks.length) rows.push({ label: 'TOP SONGS' }, ...tracks.map((t, i) => ({ t, i, list: tracks })));
    if (data.allSongs) rows.push({ folder: { id: data.allSongs, name: 'all songs', meta: '›' }, open: () => openList({ id: data.allSongs, title: `${name} — all songs` }) });
    for (const s of data.sections ?? []) {
      const playable = s.items.filter(isPlayable);
      rows.push({ label: s.title.toUpperCase() });
      for (const it of s.items) {
        if (isPlayable(it)) rows.push({ t: it, i: playable.indexOf(it), list: playable });
        else {
          const meta = it.type === 'artist' ? 'artist' : it.type === 'album' ? (it.subtitle?.match(/\b(19|20)\d{2}\b/)?.[0] ?? 'album') : 'list';
          rows.push({ folder: { id: it.id, name: it.title, meta }, open: () => (it.type === 'artist' ? openArtist({ id: it.id, name: it.title }) : openList(it)) });
        }
      }
    }
  }

  return {
    active: true,
    bar,
    view: {
      title: isArtist ? 'ARTIST' : name,
      rows,
      play: (row) => playList(row.list, row.i),
      songs: tracks,
      loading: !data && !page.failed,
      empty: page.failed ? 'couldn’t load this — press BACK and try again' : 'nothing here',
    },
  };
}

function useSearch() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    const text = q.trim();
    if (!text) return;
    setBusy(true);
    try {
      setResults(await api('yt:search', text));
    } catch {
      setResults([]);
      toast('search failed — check your connection');
    } finally {
      setBusy(false);
    }
  };
  return { q, setQ, results, busy, run };
}

// LIBRARY: your likes, playlists you saved in abyss, and (signed in) your YouTube Music library.
function useLibraryView() {
  const [src, setSrc] = useState(() => recall('abyss.libsrc', 'liked'));
  const [open, setOpen] = useState(null); // { id, name, from }
  const [renaming, setRenaming] = useState(null);
  const [remote, setRemote] = useState({ key: null, data: null, loading: false });
  const liked = useStore(library, (s) => s.liked);
  const playlists = useStore(library, (s) => s.playlists);
  const signedIn = useStore(settings, (s) => s.signedIn);

  useEffect(() => remember('abyss.libsrc', src), [src]);

  const key = src === 'youtube' ? (open ? `pl:${open.id}` : 'yt') : null;
  useEffect(() => {
    if (!key || remote.key === key) return;
    let alive = true;
    setRemote({ key, data: null, loading: true });
    const load = key === 'yt' ? api('yt:library') : api('yt:playlist', open.id).then((p) => p.tracks);
    load.then((data) => alive && setRemote({ key, data, loading: false })).catch(() => {
      if (!alive) return;
      setRemote({ key, data: [], loading: false });
      toast('couldn’t load your YouTube library');
    });
    return () => (alive = false);
  }, [key]);

  const choose = (s) => { setSrc(s); setOpen(null); };
  const openSaved = open?.from === 'saved' ? playlists.find((x) => x.id === open.id) : null;
  const finishRename = () => { if (renaming !== null) lib.renamePlaylist(open.id, renaming); setRenaming(null); };
  const bar = (
    <div className="mchips">
      {open ? <button onClick={() => { setOpen(null); setRenaming(null); }}>‹ BACK</button> : null}
      {!open && <button className={src === 'liked' ? 'on' : ''} onClick={() => choose('liked')}>♥ LIKED</button>}
      {!open && <button className={src === 'saved' ? 'on' : ''} onClick={() => choose('saved')}>SAVED</button>}
      {!open && signedIn && <button className={src === 'youtube' ? 'on' : ''} onClick={() => choose('youtube')}>YOUTUBE</button>}
      {open && renaming === null && <span className="mchip-title" title={openSaved?.name ?? open.name}>{openSaved?.name ?? open.name}</span>}
      {open && renaming !== null && (
        <form className="mrename" onSubmit={(e) => { e.preventDefault(); finishRename(); }}>
          <input autoFocus aria-label="Playlist name" value={renaming} maxLength={60} onChange={(e) => setRenaming(e.target.value)} onFocus={(e) => e.target.select()} onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)} />
          <button type="submit">OK</button>
        </form>
      )}
      {openSaved && renaming === null && <button onClick={() => setRenaming(openSaved.name)}>RENAME</button>}
      {openSaved && renaming === null && <button className="danger" onClick={() => { lib.deletePlaylist(open.id); setOpen(null); toast('playlist deleted'); }}>DELETE</button>}
    </div>
  );

  const songsView = (list, extra = {}) => ({ rows: list.map((t, i) => ({ t, i })), play: (row) => playList(list, row.i), songs: list, ...extra });
  let view;
  if (src === 'saved' && open) {
    const p = playlists.find((x) => x.id === open.id);
    view = songsView(p?.tracks ?? [], { title: p?.name, playlistId: open.id, empty: 'empty — right-click any song › add to playlist' });
    if (!p) view.empty = 'this playlist is gone';
  } else if (src === 'saved') {
    view = {
      rows: playlists.map((p) => ({ folder: { id: p.id, name: p.name, meta: `${p.tracks.length}` }, open: () => setOpen({ id: p.id, name: p.name, from: 'saved' }) })),
      songs: [],
      empty: 'no playlists yet — press SAVE under the queue, or right-click a song › add to playlist',
    };
  } else if (src === 'youtube' && signedIn) {
    if (open) view = songsView(remote.key === key && remote.data ? remote.data : [], { title: open.name, loading: remote.loading, empty: 'this playlist is empty' });
    else {
      const lists = remote.key === 'yt' && remote.data ? remote.data : [];
      view = {
        rows: [{ id: 'LM', title: 'liked music' }, ...lists].map((p) => ({ folder: { id: p.id, name: p.title, meta: p.type === 'album' ? 'album' : '' }, open: () => setOpen({ id: p.id, name: p.title, from: 'youtube' }) })),
        songs: [],
        loading: remote.loading,
        empty: '',
      };
    }
  } else {
    view = songsView(liked, { empty: 'press ♥ on a song and it lands here' });
  }
  return { view, bar };
}

lib.save = (queue) => lib.createPlaylist(`queue ${new Date().toLocaleDateString()}`, queue);

// ---------- settings window ----------

function SettingsWindow({ showArt, onArt, onClose }) {
  const s = useStore(settings);
  const items = useStore(downloads, (st) => st.items);
  const url = useStore(art, (st) => st[s.skin]);
  const fade = useStore(player, (st) => st.crossfade);
  const [cookie, setCookie] = useState('');
  const [busy, setBusy] = useState(false);
  const saved = Object.values(items).filter((d) => d.status === 'done');
  const size = saved.reduce((a, d) => a + (d.size || 0), 0);

  const signIn = async () => {
    setBusy(true);
    const r = await api('auth:cookie', cookie);
    setBusy(false);
    if (r.ok) {
      setCookie('');
      await prefs.reload();
      toast(`signed in${r.account?.name ? ` as ${r.account.name}` : ''}`);
    } else toast(r.error);
  };

  return (
    <section className="mwin mplaylist" aria-label="Settings">
      <div className="mtitle">
        <span className="grow">SETTINGS</span>
        <button className="mt-btn" onClick={onClose}>DONE</button>
      </div>
      <div className="mset">
        <div className="mset-block">
          <div className="mset-head">SKIN</div>
          <div className="mskins">
            {SKIN_IDS.map((id) => (
              <button key={id} className={`mskin ${s.skin === id ? 'on' : ''}`} aria-pressed={s.skin === id} onClick={() => api('win:skin', id)} title={`Skin: ${id}`}>
                <span className="sw" aria-hidden="true"><i style={{ background: SKINS[id].body }} /><i style={{ background: SKINS[id].ink }} /></span>
                <span>{id}</span>
              </button>
            ))}
          </div>
          <div className="mset-row">
            <span className="grow">Art screen</span>
            <button className={`mpill ${showArt ? 'on' : ''}`} aria-pressed={showArt} onClick={onArt}>{showArt ? 'ON' : 'OFF'}</button>
          </div>
          <div className="mset-row">
            <span className="grow">Picture for “{s.skin}” {url ? '— set' : ''}</span>
            <button className="mpill" onClick={() => pickArt(s.skin)}>{url ? 'CHANGE' : 'CHOOSE'}</button>
            {url && <button className="mpill" onClick={async () => art.set({ [s.skin]: await api('skin:clear-art', s.skin) })}>REMOVE</button>}
          </div>
          <p className="mset-note">Each skin keeps its own picture. You can also drop a png straight onto the art screen.</p>
        </div>

        <div className="mset-block">
          <div className="mset-head">PLAYBACK</div>
          <div className="mset-row">
            <span className="grow">Crossfade between songs</span>
          </div>
          <div className="mset-row mfade" role="radiogroup" aria-label="Crossfade length">
            {[0, 3, 5, 8, 12].map((n) => (
              <button key={n} role="radio" aria-checked={fade === n} className={`mpill ${fade === n ? 'on' : ''}`} onClick={() => setCrossfade(n)}>{n ? `${n}s` : 'OFF'}</button>
            ))}
          </div>
          <p className="mset-note">The next song starts fading in before this one ends, like a DJ mix.</p>
        </div>

        <div className="mset-block">
          <div className="mset-head">YOUTUBE MUSIC</div>
          {s.signedIn ? (
            <div className="mset-row">
              <span className="grow">Signed in{s.account?.name ? ` as ${s.account.name}` : ''}. Your likes sync, and LIBRARY › YOUTUBE shows your playlists.</span>
              <button className="mpill" onClick={async () => { await api('auth:signout'); await prefs.reload(); toast('signed out'); }}>SIGN OUT</button>
            </div>
          ) : (
            <>
              <ol className="msteps">
                <li>Open YouTube Music in your browser and sign in.</li>
                <li>Press F12 › Network, then reload the page.</li>
                <li>Click any request to music.youtube.com and copy the whole “cookie” value under Request Headers.</li>
                <li>Paste it below. It’s stored encrypted on this PC.</li>
              </ol>
              <div className="mset-row">
                <button className="mpill" onClick={() => api('auth:open-browser')}>OPEN YT MUSIC</button>
                <input className="minput grow" type="password" aria-label="YouTube Music cookie" placeholder="paste cookie here" value={cookie} onChange={(e) => setCookie(e.target.value)} />
                <button className="mpill on" disabled={!cookie || busy} onClick={signIn}>{busy ? '…' : 'SIGN IN'}</button>
              </div>
              <p className="mset-note">Optional — search, play and downloads all work without an account.</p>
            </>
          )}
        </div>

        <div className="mset-block">
          <div className="mset-head">DOWNLOADS</div>
          <div className="mset-row">
            <span className="grow mpath" title={s.downloadDir}>{s.downloadDir}</span>
          </div>
          <div className="mset-row">
            <span className="grow">{saved.length} songs · {(size / 1024 / 1024).toFixed(0)} MB saved</span>
            <button className="mpill" onClick={async () => { const f = await api('dl:pick-folder'); if (f) await prefs.reload(); }}>CHANGE</button>
            <button className="mpill" onClick={() => api('dl:open-folder')}>OPEN</button>
          </div>
        </div>

        <div className="mset-block">
          <div className="mset-head">WINDOW</div>
          <div className="mset-row">
            <span className="grow">Keep abyss on top of other windows</span>
            <button className={`mpill ${s.onTop ? 'on' : ''}`} aria-pressed={s.onTop} onClick={() => api('win:on-top', !s.onTop)}>{s.onTop ? 'ON' : 'OFF'}</button>
          </div>
        </div>

        <div className="mset-block">
          <div className="mset-head">ABOUT</div>
          <p className="mset-note">abyss {s.version} — open source. While Discord is open, your profile shows what you’re listening to (turn it off in Discord › Settings › Activity Privacy).</p>
          <div className="mset-row">
            <button className="mpill" onClick={() => api('app:open-url', 'https://github.com/Capri-cmd/ABYSS-PLAYER')}>GITHUB</button>
          </div>
        </div>
      </div>
    </section>
  );
}
