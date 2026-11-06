// YouTube Music (InnerTube) access through youtubei.js — the same backend ArchiveTune uses.
// Everything returned to the renderer is normalized into plain objects.
import path from 'node:path';
import os from 'node:os';
import { Innertube, Log, UniversalCache } from 'youtubei.js';

// youtubei.js prints parser warnings for every new YouTube layout tweak; keep real errors only.
Log.setLevel(Log.Level.ERROR);

let yt = null;
let ready = null;
let cacheDir = path.join(os.tmpdir(), 'abyss-yt-cache');

export function setCacheDir(dir) {
  cacheDir = dir;
}

export function init(cookie = '') {
  ready = Innertube.create({
    cookie: cookie || undefined,
    cache: new UniversalCache(true, cacheDir),
    retrieve_player: false,
    generate_session_locally: true,
    lang: 'en',
    // A stalled request should fail fast instead of freezing the page that asked for it.
    fetch: (input, init = {}) => fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(45_000) }),
  }).then((instance) => {
    yt = instance;
    return yt;
  });
  return ready;
}

const client = async () => yt ?? ready ?? init();

// ---------- normalizing ----------

const txt = (t) => {
  if (t == null) return '';
  if (typeof t === 'string') return t;
  if (typeof t.text === 'string') return t.text;
  if (typeof t.toString === 'function') {
    const s = t.toString();
    return s === '[object Object]' ? '' : s;
  }
  return '';
};

function bigThumb(url) {
  if (!url) return '';
  if (url.startsWith('//')) url = 'https:' + url;
  if (/googleusercontent|ggpht/.test(url)) return url.replace(/=w\d+-h\d+.*$/, '=w544-h544-l90-rj').replace(/=s\d+.*$/, '=s544');
  return url;
}

function thumbOf(node) {
  if (!node) return '';
  const candidates = [
    node.thumbnail?.contents,
    node.thumbnail?.thumbnails,
    Array.isArray(node.thumbnail) ? node.thumbnail : null,
    node.thumbnails,
    node.thumbnail?.thumbnail?.contents,
    node.thumbnail?.thumbnail,
    node.foreground_thumbnail?.contents,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return bigThumb(c[c.length - 1].url);
  }
  return '';
}

function artistsOf(item) {
  const list = item.artists || item.authors || [];
  // Album track rows carry a placeholder artist "N/A"; drop it so the album's real artists are used.
  let out = list.map((a) => ({ name: txt(a.name), id: a.channel_id || a.endpoint?.payload?.browseId || null })).filter((a) => a.name && a.name !== 'N/A');
  if (!out.length && item.author) {
    const name = txt(item.author.name ?? item.author);
    if (name) out = [{ name, id: item.author.channel_id || null }];
  }
  if (!out.length) {
    // Two-row and card items keep the artist in the meta line: "Song • Artist A & Artist B • 3:12"
    const parts = metaParts(item).filter((p) => p !== 'N/A' && !KINDS[p] && !/^\d+(:\d+)+$/.test(p) && !/^\d{4}$/.test(p) && !/views|plays|songs|subscribers|listeners/i.test(p));
    if (parts[0]) out = parts[0].split(/, | & /).map((name) => ({ name, id: null }));
  }
  return out;
}

const KINDS = { Song: 'song', Video: 'video', Album: 'album', Single: 'album', EP: 'album', Playlist: 'playlist', Artist: 'artist' };

// The grey line under a title: the subtitle, or the second column of a list row.
function metaParts(item) {
  const text = txt(item.subtitle) || txt(item.flex_columns?.[1]?.title);
  return text.split(' • ').map((s) => s.trim()).filter(Boolean);
}

const TYPES = { song: 'song', video: 'video', album: 'album', playlist: 'playlist', artist: 'artist', library_artist: 'artist', non_music_track: 'song' };

function norm(item) {
  if (!item) return null;
  if (item.type === 'PlaylistPanelVideoWrapper') item = item.primary;
  if (!item) return null;
  const payload = item.endpoint?.payload || item.on_tap?.payload || item.overlay?.content?.endpoint?.payload || {};
  const videoId = item.video_id || payload.videoId || (item.item_type === 'song' || item.item_type === 'video' ? item.id : null);
  const meta = metaParts(item);
  let type = TYPES[item.item_type] || (videoId ? 'song' : null);
  if (videoId && !TYPES[item.item_type] && KINDS[meta[0]] === 'video') type = 'video';
  const browseId = payload.browseId || (!videoId ? item.id : null);
  if (!type && browseId && KINDS[meta[0]]) type = KINDS[meta[0]];
  if (!type && browseId) {
    if (browseId.startsWith('MPRE')) type = 'album';
    else if (browseId.startsWith('UC')) type = 'artist';
    else if (/^(VL|PL|RD|OLAK)/.test(browseId)) type = 'playlist';
  }
  const title = txt(item.title) || txt(item.name);
  if (!title || !type) return null;
  if (type === 'song' && item.item_type === 'video') type = 'video';
  const album = item.album ? { id: item.album.id || null, name: txt(item.album.name) } : null;
  return {
    id: videoId || browseId,
    type,
    title,
    artists: type === 'artist' ? [] : artistsOf(item),
    album,
    duration: item.duration?.seconds || seconds(meta.find((p) => /^\d+(:\d+)+$/.test(p))),
    cover: thumbOf(item),
    subtitle: txt(item.subtitle),
    explicit: Boolean(item.badges?.some?.((b) => /explicit/i.test(txt(b.label) || b.icon_type || ''))),
  };
}

function seconds(text) {
  if (!text) return 0;
  return text.split(':').reduce((a, n) => a * 60 + Number(n), 0);
}

const items = (list) => (list || []).map(norm).filter(Boolean);

function shelves(list) {
  const out = [];
  for (const s of list || []) {
    if (!s) continue;
    if (s.type === 'MusicCardShelf') {
      out.push({ title: 'top result', items: [norm(s), ...items(s.contents)].filter(Boolean) });
      continue;
    }
    const title = txt(s.header?.title) || txt(s.title) || txt(s.header?.strapline);
    const contents = items(s.contents);
    if (contents.length) out.push({ title: title || 'more', items: contents });
  }
  return out;
}

// ---------- API ----------

// Songs first, then music videos, as one list.
export async function search(q) {
  const y = await client();
  const [songs, videos] = await Promise.allSettled([y.music.search(q, { type: 'song' }), y.music.search(q, { type: 'video' })]);
  const pick = (r) => (r.status === 'fulfilled' ? items((r.value.contents || []).flatMap((c) => c.contents || [])) : []);
  const list = [...pick(songs), ...pick(videos)].filter((t) => t.type === 'song' || t.type === 'video');
  if (!list.length && songs.status === 'rejected') throw songs.reason;
  return list;
}

// "Artist A & Artist B" in a header, keeping each artist's channel link when YouTube gives one.
function headerArtists(text) {
  const runs = (text?.runs || []).filter((r) => r.endpoint?.payload?.browseId?.startsWith('UC'));
  if (runs.length) return runs.map((r) => ({ name: txt(r.text), id: r.endpoint.payload.browseId }));
  return txt(text).split(/, | & /).map((name) => name.trim()).filter(Boolean).map((name) => ({ name, id: null }));
}

function headerInfo(h) {
  const artists = h?.strapline_text_one ? headerArtists(h.strapline_text_one) : h?.author?.name ? [{ name: txt(h.author.name), id: h.author.channel_id || null }] : [];
  return {
    artists,
    title: txt(h?.title),
    subtitle: txt(h?.subtitle),
    second: txt(h?.second_subtitle),
    artist: txt(h?.strapline_text_one) || txt(h?.author?.name),
    artistId: h?.strapline_text_one?.endpoint?.payload?.browseId || h?.author?.channel_id || null,
    description: txt(h?.description?.description ?? h?.description),
    cover: thumbOf(h),
  };
}

// Songs of a saved album (YouTube album ids start with MPRE), with the album's cover and artists.
export async function album(id) {
  const y = await client();
  const a = await y.music.getAlbum(id);
  const h = headerInfo(a.header);
  const tracks = items(a.contents).map((t) => ({ ...t, cover: t.cover || h.cover, album: { id, name: h.title }, artists: t.artists.length ? t.artists : h.artists }));
  return { id, kind: 'album', ...h, tracks };
}

export async function playlist(id) {
  const y = await client();
  let p = await y.music.getPlaylist(id);
  const h = headerInfo(p.header);
  const tracks = items(p.contents ?? p.items);
  let guard = 0;
  while (p.has_continuation && tracks.length < 5000 && guard++ < 60) {
    p = await p.getContinuation();
    tracks.push(...items(p.contents ?? p.items));
  }
  return { id, kind: 'playlist', ...h, tracks };
}

export async function upNext(videoId) {
  const y = await client();
  const panel = await y.music.getUpNext(videoId, true);
  return items(panel.contents).filter((t) => t.type === 'song' || t.type === 'video');
}

export async function lyrics(videoId) {
  const y = await client();
  try {
    const l = await y.music.getLyrics(videoId);
    return txt(l?.description) || null;
  } catch {
    return null;
  }
}

// The signed-in account's saved playlists (liked songs are opened separately as playlist "LM").
export async function library() {
  const y = await client();
  if (!y.session.logged_in) return [];
  const lib = await y.music.getLibrary();
  let list = shelves(lib.contents).flatMap((s) => s.items).filter((i) => i.type === 'playlist' || i.type === 'album');
  let page = lib;
  for (let i = 0; i < 5 && page.has_continuation; i++) {
    try {
      page = await page.getContinuation();
      list.push(...items(page.contents?.contents ?? page.contents ?? []));
    } catch {
      break;
    }
  }
  const seen = new Set();
  list = list.filter((p) => p.id !== 'VLLM' && p.id !== 'LM' && !seen.has(p.id) && seen.add(p.id));
  return list;
}

// The signed-in account's name and picture, or null when signed out / the cookie was rejected.
export async function account() {
  const y = await client();
  if (!y.session.logged_in) return null;
  try {
    const all = await y.account.getInfo(true);
    const me = all.find((a) => a.is_selected) ?? all[0];
    if (!me) return { name: 'YouTube account', photo: '' };
    return { name: txt(me.account_name), handle: txt(me.channel_handle), photo: bigThumb(me.account_photo?.at(-1)?.url) };
  } catch (e) {
    console.warn('[yt] account info:', e.message);
    return { name: 'YouTube account', photo: '' };
  }
}

// Mirror a like in abyss to the YouTube Music account.
export async function rate(videoId, liked) {
  const y = await client();
  if (!y.session.logged_in) return false;
  await (liked ? y.interact.like(videoId) : y.interact.removeRating(videoId));
  return true;
}

// An artist's page: top songs, then their albums, singles, videos and related artists.
export async function artist(id) {
  const y = await client();
  const a = await y.music.getArtist(id);
  const h = headerInfo(a.header);
  const secs = shelves(a.sections);
  const songs = secs.find((s) => /songs/i.test(s.title));
  const shelf = (a.sections || []).find((s) => /songs/i.test(txt(s?.header?.title) || txt(s?.title)));
  const more = shelf?.bottom_endpoint?.payload?.browseId || shelf?.header?.endpoint?.payload?.browseId || shelf?.endpoint?.payload?.browseId || null;
  return {
    id,
    kind: 'artist',
    ...h,
    allSongs: more && /^(VL|PL|OLAK)/.test(more) ? more : null,
    tracks: songs?.items.filter((i) => i.type === 'song' || i.type === 'video') ?? [],
    sections: secs.filter((s) => s !== songs),
  };
}

// Find an artist's channel by name, for artist names YouTube didn't link.
export async function findArtist(name) {
  const y = await client();
  const r = await y.music.search(name, { type: 'artist' });
  const found = items((r.contents || []).flatMap((c) => c.contents || [])).filter((i) => i.type === 'artist');
  const exact = found.find((a) => a.title.toLowerCase() === name.toLowerCase());
  return (exact ?? found[0])?.id ?? null;
}
