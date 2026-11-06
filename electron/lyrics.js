// Lyrics: LrcLib for synced lines, YouTube Music for plain text, Google's public endpoint for translate/romanize.
import * as yt from './yt.js';

const UA = { 'User-Agent': 'abyss/0.1 (desktop music player)' };
const cache = new Map();

function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const s of stamps) lines.push({ t: Number(s[1]) * 60 + Number(s[2]), text });
  }
  return lines.sort((a, b) => a.t - b.t);
}

const clean = (s) => s.replace(/\s*[([](feat|ft|with|prod|official|lyric|audio|video|visualizer|remaster)[^)\]]*[)\]]/gi, '').trim();

async function lrclib(track) {
  const artist = track.artists?.[0]?.name ?? '';
  const q = new URLSearchParams({ track_name: clean(track.title), artist_name: artist });
  if (track.album?.name) q.set('album_name', track.album.name);
  if (track.duration) q.set('duration', String(Math.round(track.duration)));
  let res = await fetch(`https://lrclib.net/api/get?${q}`, { headers: UA });
  if (res.ok) {
    const hit = await res.json();
    if (hit.syncedLyrics || hit.plainLyrics) return hit;
  }
  res = await fetch(`https://lrclib.net/api/search?${new URLSearchParams({ q: `${clean(track.title)} ${artist}` })}`, { headers: UA });
  if (!res.ok) return null;
  const list = await res.json();
  const near = (h) => !track.duration || Math.abs((h.duration ?? 0) - track.duration) < 6;
  return list.find((h) => h.syncedLyrics && near(h)) ?? list.find((h) => h.plainLyrics && near(h)) ?? null;
}

export async function get(track) {
  if (cache.has(track.id)) return cache.get(track.id);
  let result = { synced: false, lines: [], source: null };
  try {
    const hit = await lrclib(track);
    if (hit?.syncedLyrics) result = { synced: true, lines: parseLrc(hit.syncedLyrics), source: 'LrcLib' };
    else if (hit?.plainLyrics) result = { synced: false, lines: hit.plainLyrics.split(/\r?\n/).map((text) => ({ t: -1, text })), source: 'LrcLib' };
  } catch (e) {
    console.warn('[lyrics] lrclib:', e.message);
  }
  if (!result.lines.length) {
    const plain = await yt.lyrics(track.id).catch(() => null);
    if (plain) result = { synced: false, lines: plain.split(/\r?\n/).map((text) => ({ t: -1, text })), source: 'YouTube Music' };
  }
  cache.set(track.id, result);
  return result;
}

// Google's Chrome-extension translate endpoint; the plain "gtx" one is often rate-limited.
const GT = 'https://clients5.google.com/translate_a';
const tcache = new Map();

async function gt(path, params) {
  const res = await fetch(`${GT}/${path}?${params}`);
  if (!res.ok) throw new Error(`translate failed (${res.status})`);
  return res.json();
}

// Translates many lines at once: one `q` per line, chunked to keep URLs short.
async function translateLines(lines, lang) {
  const out = [];
  let chunk = [];
  const flush = async () => {
    if (!chunk.length) return;
    const params = new URLSearchParams({ client: 'dict-chrome-ex', sl: 'auto', tl: lang });
    chunk.forEach((l) => params.append('q', l || ' '));
    const data = await gt('t', params);
    // One line comes back as ["text","lang"], several as [["text","lang"], ...]
    const rows = chunk.length === 1 ? [data[0]] : data;
    rows.forEach((r) => out.push((Array.isArray(r) ? r[0] : r) ?? ''));
    chunk = [];
  };
  for (const l of lines) {
    chunk.push(l);
    if (chunk.join('').length > 1500 || chunk.length >= 40) await flush();
  }
  await flush();
  return out;
}

async function romanizeLine(line) {
  if (!line.trim()) return '';
  const params = new URLSearchParams({ client: 'dict-chrome-ex', sl: 'auto', tl: 'en', q: line });
  params.append('dt', 'rm');
  const data = await gt('single', params);
  const rm = (data[0] || []).map((p) => p?.[3]).filter(Boolean).join(' ');
  return rm || line;
}

// mode: 'translate' (to `lang`) or 'romanize'
export async function transform(lines, mode, lang = 'en') {
  const key = `${mode}:${lang}:${lines.join('\n')}`;
  if (tcache.has(key)) return tcache.get(key);
  let out;
  if (mode === 'romanize') {
    out = new Array(lines.length).fill('');
    let next = 0;
    const worker = async () => {
      while (next < lines.length) {
        const i = next++;
        out[i] = await romanizeLine(lines[i]).catch(() => lines[i]);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  } else {
    out = await translateLines(lines, lang);
  }
  out = lines.map((l, i) => (l.trim() ? (out[i] ?? '').trim() : ''));
  tcache.set(key, out);
  return out;
}
