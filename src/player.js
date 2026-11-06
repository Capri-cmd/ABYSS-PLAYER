// The audio engine: queue, shuffle/repeat, radio autoplay, media keys and Discord presence.
import { api, createStore, lib, artistText, isPlayable, toast } from './state.js';

// Two decks, like a DJ: `audio` is the one you hear. With crossfade on, the next song loads
// silently on the other deck and fades in while the current one fades out.
const makeDeck = () => {
  const a = new Audio();
  a.crossOrigin = 'anonymous';
  a.preload = 'auto';
  return a;
};
const decks = [makeDeck(), makeDeck()];
export let audio = decks[0];
let other = decks[1];

const savedVolume = Number(localStorage.getItem('abyss.volume') ?? 0.8);

export const player = createStore({
  queue: [],
  index: -1,
  playing: false,
  loading: false,
  time: 0,
  duration: 0,
  shuffle: false,
  repeat: 'off', // off | all | one
  volume: savedVolume,
  autoplay: true,
  crossfade: Number(localStorage.getItem('abyss.crossfade') ?? 5), // seconds, 0 = off
});
decks.forEach((d) => (d.volume = savedVolume ** 2));

export const current = () => {
  const s = player.get();
  return s.queue[s.index] ?? null;
};

// ---------- analyser for the visualizer ----------

let ctx = null;
let analyser = null;
const gains = new Map(); // deck -> its fade GainNode
function ensureGraph() {
  if (ctx) return;
  try {
    ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.82;
    for (const d of decks) {
      const g = ctx.createGain();
      ctx.createMediaElementSource(d).connect(g);
      g.connect(analyser);
      gains.set(d, g);
    }
    analyser.connect(ctx.destination);
  } catch (e) {
    console.warn('visualizer unavailable', e);
  }
}
function setGain(deck, value, overSeconds = 0) {
  const g = gains.get(deck);
  if (!g) return;
  const now = ctx.currentTime;
  g.gain.cancelScheduledValues(now);
  if (!overSeconds) return g.gain.setValueAtTime(value, now);
  g.gain.setValueAtTime(g.gain.value, now);
  g.gain.linearRampToValueAtTime(value, now + overSeconds);
}
export const getAnalyser = () => analyser;

// ---------- loading ----------

let pendingSeek = 0;
let errorStreak = 0;
let counted = true; // a song counts toward history and the profile once it actually starts playing

function load(i, autoplay = true) {
  const t = player.get().queue[i];
  if (!t) return;
  ensureGraph();
  endFade();
  dropPrepared();
  setGain(audio, 1);
  player.set({ index: i, time: 0, duration: t.duration || 0, loading: true });
  audio.src = `abyss://track/${encodeURIComponent(t.id)}`;
  if (autoplay) {
    ctx?.resume();
    audio.play().catch(() => {});
  }
  started(t);
}

// Bookkeeping shared by a normal start and a crossfaded one.
function started(t) {
  setMediaSession(t);
  counted = false;
  prefetchNext();
  extendRadio();
  saveSession();
}

// ---------- crossfade ----------

let prepared = null; // { id, failed } — the song loading silently on the other deck
let fadeTimer = null;

// The song that plays after this one, or null when it's repeat-one / the end.
function upcomingIndex() {
  const { queue, index, repeat } = player.get();
  if (repeat === 'one') return -1;
  if (index + 1 < queue.length) return index + 1;
  if (repeat === 'all' && queue.length > 1) return 0;
  return -1;
}

function prepare(t) {
  prepared = { id: t.id, failed: false };
  setGain(other, 0);
  other.src = `abyss://track/${encodeURIComponent(t.id)}`;
  other.load();
}

function dropPrepared() {
  if (!prepared) return;
  prepared = null;
  other.pause();
  other.removeAttribute('src');
  other.load();
}

// Swap decks: the prepared song fades in over `seconds` while the current one fades out.
function startFade(seconds) {
  const i = upcomingIndex();
  const t = player.get().queue[i];
  const old = audio;
  audio = other;
  other = old;
  prepared = null;
  setGain(audio, 0);
  setGain(audio, 1, seconds);
  setGain(old, 0, seconds);
  ctx?.resume();
  audio.play().catch(() => {});
  player.set({ index: i, time: 0, duration: Number.isFinite(audio.duration) ? audio.duration : t.duration || 0, loading: false });
  started(t);
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(endFade, seconds * 1000 + 150);
}

// Finish a fade right away: silence and empty the deck that was fading out.
function endFade() {
  if (!fadeTimer) return;
  clearTimeout(fadeTimer);
  fadeTimer = null;
  other.pause();
  other.removeAttribute('src');
  other.load();
  setGain(audio, 1);
}

// Runs on every time tick of the playing deck.
function crossfadeTick() {
  const secs = player.get().crossfade;
  if (!secs || fadeTimer || !gains.size) return;
  const d = audio.duration;
  if (!Number.isFinite(d) || d < secs * 2 + 10) return;
  const left = d - audio.currentTime;
  const i = upcomingIndex();
  const t = i >= 0 ? player.get().queue[i] : null;
  if (!t) return dropPrepared();
  if (left > secs + 25) return;
  if (prepared?.id !== t.id) return prepare(t);
  if (left <= secs && !prepared.failed && other.readyState >= 3) startFade(Math.max(0.5, left - 0.1));
}

export function setCrossfade(seconds) {
  player.set({ crossfade: seconds });
  localStorage.setItem('abyss.crossfade', String(seconds));
  if (!seconds) dropPrepared();
}

function prefetchNext() {
  const { queue, index } = player.get();
  const n = queue[index + 1];
  if (n) api('stream:prefetch', n.id);
}

let radioBusy = false;
async function extendRadio(force = false) {
  const { queue, index, autoplay, repeat } = player.get();
  if (!autoplay || repeat !== 'off' || radioBusy || !queue.length) return;
  if (!force && queue.length - index > 3) return;
  radioBusy = true;
  try {
    const seed = queue.at(-1);
    const more = await api('yt:upnext', seed.id);
    const seen = new Set(player.get().queue.map((t) => t.id));
    // Radio songs are marked so songs you add yourself can go ahead of them.
    const fresh = more.filter((t) => !seen.has(t.id)).map((t) => ({ ...t, auto: true }));
    if (fresh.length) player.set((s) => ({ queue: [...s.queue, ...fresh] }));
  } catch (e) {
    console.warn('radio', e);
  } finally {
    radioBusy = false;
  }
}

// ---------- public controls ----------

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function playList(tracks, start = 0) {
  const list = tracks.filter(isPlayable);
  if (!list.length) return;
  const first = list[Math.min(start, list.length - 1)];
  let queue = list;
  let index = list.indexOf(first);
  if (player.get().shuffle) {
    queue = [first, ...shuffled(list.filter((t) => t !== first))];
    index = 0;
  }
  player.set({ queue, index });
  load(index);
}

export function shufflePlay(tracks) {
  player.set({ shuffle: true });
  const list = tracks.filter(isPlayable);
  playList(list, Math.floor(Math.random() * list.length));
}

export async function playTrack(t) {
  if (!isPlayable(t)) return;
  player.set({ queue: [t], index: 0 });
  load(0);
  extendRadio(true);
}

export function startRadio(t) {
  playTrack(t);
  toast(`radio from “${t.title}”`);
}

export function playNext(t) {
  const { queue, index } = player.get();
  if (!queue.length) return playTrack(t);
  const q = [...queue];
  q.splice(index + 1, 0, t);
  player.set({ queue: q });
  toast(`“${t.title}” plays next`);
  saveSession();
}

export function addToQueue(t) {
  const { queue, index } = player.get();
  if (!queue.length) return playTrack(t);
  // After the songs you queued yourself, ahead of the radio's picks.
  let at = queue.findIndex((x, i) => i > index && x.auto);
  if (at < 0) at = queue.length;
  const q = [...queue];
  q.splice(at, 0, t);
  player.set({ queue: q });
  toast(`added “${t.title}” to queue`);
  saveSession();
}

export function next(auto = false) {
  const { queue, index, repeat } = player.get();
  // The song ended before its crossfade could start: if the next one is ready, cut straight to it.
  if (auto && prepared && !prepared.failed && other.readyState >= 2 && prepared.id === queue[upcomingIndex()]?.id) return startFade(0.05);
  if (auto && repeat === 'one') {
    audio.currentTime = 0;
    audio.play();
    return;
  }
  if (index + 1 < queue.length) return load(index + 1);
  if (repeat === 'all' && queue.length) return load(0);
  extendRadio(true).then(() => {
    if (player.get().index + 1 < player.get().queue.length) load(player.get().index + 1);
  });
}

export function prev() {
  const { index } = player.get();
  if (audio.currentTime > 3 || index <= 0) {
    audio.currentTime = 0;
    return;
  }
  load(index - 1);
}

export function toggle() {
  const { index, queue } = player.get();
  if (!queue.length) return;
  if (!audio.src) {
    load(index < 0 ? 0 : index);
    return;
  }
  ctx?.resume();
  endFade();
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

export function seek(t) {
  if (!audio.src) {
    pendingSeek = t;
    player.set({ time: t });
    return;
  }
  audio.currentTime = t;
  player.set({ time: t });
}

export function setVolume(v) {
  v = Math.max(0, Math.min(1, v));
  decks.forEach((d) => (d.volume = v * v));
  player.set({ volume: v });
  localStorage.setItem('abyss.volume', String(v));
}

export function toggleShuffle() {
  const { shuffle, queue, index } = player.get();
  if (!shuffle) {
    const head = queue.slice(0, index + 1);
    player.set({ shuffle: true, queue: [...head, ...shuffled(queue.slice(index + 1))] });
  } else player.set({ shuffle: false });
  saveSession();
}

export function cycleRepeat() {
  const order = { off: 'all', all: 'one', one: 'off' };
  player.set((s) => ({ repeat: order[s.repeat] }));
}

export const jump = (i) => load(i);

export function removeAt(i) {
  const { queue, index } = player.get();
  if (i === index) return;
  const q = queue.filter((_, k) => k !== i);
  player.set({ queue: q, index: i < index ? index - 1 : index });
  saveSession();
}

export function move(from, to) {
  const { queue, index } = player.get();
  if (from === to) return;
  const q = [...queue];
  const [item] = q.splice(from, 1);
  q.splice(to, 0, item);
  const cur = queue[index];
  player.set({ queue: q, index: q.indexOf(cur) });
  saveSession();
}

export function clearUpcoming() {
  const { queue, index } = player.get();
  player.set({ queue: queue.slice(0, index + 1) });
  saveSession();
}

// ---------- audio events ----------
// Both decks get the listeners, but only the one you hear drives the player.
const on = (event, fn) => decks.forEach((d) => d.addEventListener(event, (e) => e.target === audio && fn(e)));
decks.forEach((d) => d.addEventListener('error', () => { if (d === other && prepared) prepared.failed = true; }));

let lastTick = 0;
on('playing', () => {
  errorStreak = 0;
  if (!counted && current()) {
    counted = true;
    lib.addHistory(current());
  }
  player.set({ playing: true, loading: false });
  announce();
});
on('pause', () => {
  player.set({ playing: false });
  announce();
  saveSession();
});
on('waiting', () => player.set({ loading: true }));
on('canplay', () => player.set({ loading: false }));
on('loadedmetadata', () => {
  if (Number.isFinite(audio.duration)) player.set({ duration: audio.duration });
  if (pendingSeek) {
    audio.currentTime = pendingSeek;
    pendingSeek = 0;
  }
});
on('timeupdate', () => {
  const now = performance.now();
  if (now - lastTick < 250) return;
  lastTick = now;
  player.set({ time: audio.currentTime });
  crossfadeTick();
  if ('setPositionState' in navigator.mediaSession && Number.isFinite(audio.duration)) {
    navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: 1 });
  }
});
on('seeked', announce);
on('ended', () => next(true));
on('error', () => {
  const t = current();
  player.set({ playing: false, loading: false });
  if (!t) return;
  errorStreak++;
  toast(`couldn’t play “${t.title}”${errorStreak < 3 ? ' — skipping' : ''}`);
  if (errorStreak < 3) setTimeout(() => current() === t && next(), 1200);
});

// ---------- discord + media keys ----------

function announce() {
  const t = current();
  if (!t) return;
  api('discord:update', {
    id: t.id,
    title: t.title,
    artist: artistText(t),
    album: t.album?.name ?? '',
    cover: t.cover,
    duration: Number.isFinite(audio.duration) ? audio.duration : t.duration,
    position: audio.currentTime,
    paused: audio.paused,
  });
}

function setMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: artistText(t),
    album: t.album?.name ?? '',
    artwork: t.cover ? [{ src: t.cover, sizes: '544x544', type: 'image/jpeg' }] : [],
  });
}
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => toggle());
  navigator.mediaSession.setActionHandler('pause', () => toggle());
  navigator.mediaSession.setActionHandler('nexttrack', () => next());
  navigator.mediaSession.setActionHandler('previoustrack', () => prev());
  navigator.mediaSession.setActionHandler('seekto', (d) => seek(d.seekTime));
}

// ---------- session restore ----------

function saveSession() {
  const { queue, index, shuffle, repeat } = player.get();
  try {
    localStorage.setItem('abyss.session', JSON.stringify({ queue: queue.slice(Math.max(0, index - 50), index + 150), index: Math.min(index, 50), time: audio.currentTime, shuffle, repeat }));
  } catch {
    /* storage full or unavailable */
  }
}
window.addEventListener('beforeunload', saveSession);

export function restoreSession() {
  try {
    const s = JSON.parse(localStorage.getItem('abyss.session') || 'null');
    if (!s?.queue?.length) return;
    const t = s.queue[s.index];
    pendingSeek = s.time || 0;
    player.set({ queue: s.queue, index: s.index, time: pendingSeek, duration: t?.duration ?? 0, shuffle: s.shuffle, repeat: s.repeat });
    if (t) setMediaSession(t);
  } catch {
    /* ignore a broken session */
  }
}
