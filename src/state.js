// Small stores shared by the player: UI bits, your library, downloads and settings.
import { useSyncExternalStore } from 'react';

export const api = (channel, ...args) => window.abyss.invoke(channel, ...args);

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      subs.forEach((f) => f());
    },
    subscribe(f) {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

export const useStore = (store, select = (s) => s) => useSyncExternalStore(store.subscribe, () => select(store.get()));

export const artistText = (t) => t?.artists?.map((a) => a.name).join(', ') || t?.subtitle || '';
export const fmtTime = (s) => {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
export const isPlayable = (t) => t && (t.type === 'song' || t.type === 'video');

// Remembered per-viewer toggles (which windows are open, which tab). Never critical.
export const remember = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the choice just won't be remembered */
  }
};
export const recall = (key, fallback) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};

// ---------- ui ----------

export const ui = createStore({ menu: null, toast: null });
let toastTimer;
export function toast(text) {
  clearTimeout(toastTimer);
  ui.set({ toast: text });
  toastTimer = setTimeout(() => ui.set({ toast: null }), 2600);
}

// ---------- library (local playlists, likes, history) ----------

export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const library = createStore({ playlists: [], liked: [], history: [], stats: { plays: 0, seconds: 0, artists: {}, days: {} }, loaded: false });
const persist = () => {
  const { playlists, liked, history, stats } = library.get();
  api('lib:save', { playlists, liked, history, stats });
};
const slim = (t) => ({ id: t.id, type: t.type, title: t.title, artists: t.artists, album: t.album, duration: t.duration, cover: t.cover });

export const lib = {
  async load() {
    const data = await api('lib:load');
    library.set({ ...data, stats: { plays: 0, seconds: 0, artists: {}, days: {}, ...data.stats }, loaded: true });
  },
  toggleLike(t) {
    const liked = library.get().liked;
    const has = liked.some((x) => x.id === t.id);
    library.set({ liked: has ? liked.filter((x) => x.id !== t.id) : [slim(t), ...liked] });
    persist();
    // Signed in: the like goes to your YouTube Music account too.
    if (settings.get().signedIn) api('yt:like', t.id, !has).catch(() => {});
    toast(has ? 'removed from liked songs' : 'added to liked songs');
  },
  createPlaylist(name, tracks = []) {
    const p = { id: `local-${Date.now().toString(36)}`, name: name || 'new playlist', tracks: tracks.map(slim), createdAt: Date.now() };
    library.set((s) => ({ playlists: [p, ...s.playlists] }));
    persist();
    return p;
  },
  addToPlaylist(pid, t) {
    library.set((s) => ({
      playlists: s.playlists.map((p) => (p.id === pid && !p.tracks.some((x) => x.id === t.id) ? { ...p, tracks: [...p.tracks, slim(t)] } : p)),
    }));
    persist();
    toast(`added to ${library.get().playlists.find((x) => x.id === pid)?.name}`);
  },
  removeFromPlaylist(pid, id) {
    library.set((s) => ({ playlists: s.playlists.map((p) => (p.id === pid ? { ...p, tracks: p.tracks.filter((x) => x.id !== id) } : p)) }));
    persist();
  },
  renamePlaylist(pid, name) {
    const clean = name.trim().slice(0, 60);
    if (!clean) return;
    library.set((s) => ({ playlists: s.playlists.map((p) => (p.id === pid ? { ...p, name: clean } : p)) }));
    persist();
  },
  deletePlaylist(pid) {
    library.set((s) => ({ playlists: s.playlists.filter((p) => p.id !== pid) }));
    persist();
  },
  // Every song started counts toward the profile: plays, time and favourite artists.
  addHistory(t) {
    library.set((s) => {
      const artists = { ...s.stats.artists };
      for (const a of t.artists ?? []) if (a.name) artists[a.name] = (artists[a.name] ?? 0) + 1;
      // Plays per day for the profile's "this week" chart; only the last five weeks are kept.
      const today = dayKey(new Date());
      const days = Object.fromEntries(Object.entries({ ...s.stats.days, [today]: (s.stats.days?.[today] ?? 0) + 1 }).sort().slice(-35));
      return {
        history: [slim(t), ...s.history.filter((x) => x.id !== t.id)].slice(0, 200),
        stats: { plays: s.stats.plays + 1, seconds: s.stats.seconds + (t.duration || 0), artists, days },
      };
    });
    persist();
  },
};

// ---------- downloads ----------

export const downloads = createStore({ items: {} });
export const dl = {
  async load() {
    const list = await api('dl:list');
    const items = {};
    for (const d of list) items[d.track.id] = d;
    downloads.set({ items });
    window.abyss.on('dl:progress', (p) => {
      downloads.set((s) => {
        const items = { ...s.items };
        if (p.status === 'removed') delete items[p.id];
        else items[p.id] = { ...items[p.id], ...p, track: p.track ?? items[p.id]?.track };
        return { items };
      });
      if (p.status === 'done') toast(`saved offline: “${p.track.title}”`);
      if (p.status === 'error') toast(`download failed: ${p.error}`);
    });
  },
  start(t) {
    if (!isPlayable(t)) return;
    const d = downloads.get().items[t.id];
    if (d && d.status !== 'error') return toast(d.status === 'done' ? 'already saved offline' : 'already downloading');
    api('dl:start', slim(t));
    toast(`downloading “${t.title}”`);
  },
  startMany(list) {
    const items = downloads.get().items;
    const todo = list.filter((t) => isPlayable(t) && (!items[t.id] || items[t.id].status === 'error'));
    if (!todo.length) return toast('everything here is already offline');
    todo.forEach((t) => api('dl:start', slim(t)));
    toast(`downloading ${todo.length} song${todo.length === 1 ? '' : 's'}`);
  },
  remove: (id) => api('dl:remove', id),
};

// ---------- settings ----------

export const settings = createStore({ signedIn: false, account: null, downloadDir: '', skin: 'abyss', onTop: false, version: '' });
export const prefs = {
  async load() {
    settings.set(await api('settings:load'));
    window.abyss.on('auth:changed', ({ signedIn, account }) => settings.set({ signedIn, account }));
    window.abyss.on('win:changed', ({ skin, onTop }) => settings.set({ skin, onTop }));
    // YouTube refused a stream. Logged-out playback gets blocked far more, so point there.
    let lastBlocked = 0;
    window.abyss.on('stream:blocked', ({ signedIn }) => {
      if (Date.now() - lastBlocked < 20_000) return;
      lastBlocked = Date.now();
      toast(signedIn ? 'YouTube refused this song — skipping' : 'YouTube is blocking playback without an account — sign in under SET');
    });
  },
  reload: async () => settings.set(await api('settings:load')),
};

// ---------- artist pages ----------
// Opening an artist (or an album / playlist from their page) pushes onto a small stack the
// playlist window shows instead of its tabs. BACK pops it; picking a tab clears it.

export const nav = createStore({ stack: [] });
export const openArtist = (a) => {
  if (!a?.name && !a?.id) return;
  nav.set((s) => ({ stack: [...s.stack, { kind: 'artist', id: a.id || null, name: a.name || 'artist' }] }));
};
export const openList = (p) => nav.set((s) => ({ stack: [...s.stack, { kind: 'list', id: p.id, name: p.title || p.name }] }));
export const navBack = () => nav.set((s) => ({ stack: s.stack.slice(0, -1) }));
export const navClear = () => nav.get().stack.length && nav.set({ stack: [] });
