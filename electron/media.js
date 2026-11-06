// Audio streams and downloads, powered by yt-dlp.
import { app } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { load, save } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// yt-dlp runs on the Python that ships inside abyss (vendor/python, see scripts/vendor-python.mjs),
// falling back to a system Python when that is missing (e.g. a dev checkout without `npm run vendor`).
function findPython() {
  const exe = process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3'];
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, 'python', ...exe)
    : path.join(here, '..', 'vendor', 'python', ...exe);
  if (fs.existsSync(bundled)) return bundled;
  return process.platform === 'win32' ? 'python' : 'python3';
}
const PYTHON = findPython();

// YouTube hides its audio URLs behind player JavaScript that yt-dlp solves with Node. abyss's own
// executable runs as Node when ELECTRON_RUN_AS_NODE is set, so no separate Node install is needed.
const ENV = { ...process.env, ABYSS_NODE: process.execPath, ELECTRON_RUN_AS_NODE: '1', PYTHONUTF8: '1' };
const JS = ['--js-runtimes', `node:${process.execPath}`];

// Signed in: yt-dlp uses the account's session too (logged-in requests are refused far less often).
// The cookie lives in a private file in abyss's own data folder while signed in.
let cookieFile = null;
const env = () => (cookieFile ? { ...ENV, ABYSS_COOKIES: cookieFile } : ENV);
const cookieArgs = () => (cookieFile ? ['--cookies', cookieFile] : []);

export function setCookies(header) {
  const file = path.join(app.getPath('userData'), 'yt-cookies.txt');
  if (header) {
    const lines = ['# Netscape HTTP Cookie File'];
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i < 1) continue;
      lines.push(['.youtube.com', 'TRUE', '/', 'TRUE', '2147483647', part.slice(0, i).trim(), part.slice(i + 1).trim()].join('\t'));
    }
    fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
    cookieFile = file;
  } else {
    fs.rmSync(file, { force: true });
    cookieFile = null;
  }
  // Running workers and cached stream links belong to the old session.
  streams.clear();
  stopWorkers();
  warmUp();
}

const watchUrl = (id) => `https://music.youtube.com/watch?v=${id}`;
const lastLine = (text) => text.trim().split('\n').pop() || '';

function run(args, onLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, ['-m', 'yt_dlp', ...JS, ...cookieArgs(), ...args], { windowsHide: true, env: env() });
    let out = '';
    let err = '';
    let buf = '';
    proc.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      if (onLine) {
        buf += s;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        lines.forEach(onLine);
      }
    });
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(lastLine(err) || `yt-dlp exited ${code}`))));
  });
}

// ---------- stream lookups: a pool of warm yt-dlp workers ----------
// Each lookup through the yt-dlp command costs ~20s (Python start-up + solving YouTube's player
// script). ytdlp_worker.py keeps that work loaded, so a lookup takes a few seconds instead.

const AUDIO = 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best';
const WORKER = path.join(here, 'ytdlp_worker.py').replace('app.asar', 'app.asar.unpacked');
const MAX_WORKERS = 2;
const MAX_PREFETCH = 4;
const workers = [];
const queue = []; // { id, urgent, resolve, reject }
let workerFailures = 0;

function spawnWorker() {
  const w = { proc: spawn(PYTHON, ['-u', WORKER], { windowsHide: true, env: env() }), ready: false, job: null, buf: '', err: '', dead: false };
  w.proc.stdout.on('data', (d) => {
    w.buf += d.toString();
    let i;
    while ((i = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, i).trim();
      w.buf = w.buf.slice(i + 1);
      if (line) onWorkerLine(w, line);
    }
  });
  w.proc.stderr.on('data', (d) => (w.err = (w.err + d.toString()).slice(-4000)));
  const died = (e) => {
    if (w.dead) return;
    w.dead = true;
    workers.splice(workers.indexOf(w), 1);
    if (!w.ready) workerFailures++;
    if (w.job) w.job.reject(new Error(lastLine(w.err) || e?.message || 'yt-dlp worker stopped'));
    pump();
  };
  w.proc.on('exit', died);
  w.proc.on('error', died);
  workers.push(w);
}

function onWorkerLine(w, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.ready) {
    w.ready = true;
    workerFailures = 0;
  } else if (w.job) {
    const job = w.job;
    w.job = null;
    if (msg.error) job.reject(new Error(msg.error));
    else job.resolve(msg);
  }
  pump();
}

function pump() {
  if (workerFailures >= 3) {
    // Python or its yt_dlp module is missing: fall back to one yt-dlp command per lookup.
    while (queue.length) {
      const job = queue.shift();
      run([watchUrl(job.id), '-f', AUDIO, '-j', '--no-playlist', '--no-warnings'])
        .then((json) => {
          const info = JSON.parse(json);
          const fmt = info.requested_downloads?.[0] ?? info;
          job.resolve({ url: fmt.url ?? info.url, headers: fmt.http_headers ?? info.http_headers ?? {}, ext: fmt.ext, size: fmt.filesize || fmt.filesize_approx || 0 });
        })
        .catch(job.reject);
    }
    return;
  }
  const idle = workers.filter((w) => w.ready && !w.job);
  while (idle.length && queue.length) {
    const w = idle.shift();
    w.job = queue.shift();
    w.proc.stdin.write(JSON.stringify({ seq: Date.now(), id: w.job.id }) + '\n');
  }
  const starting = workers.filter((w) => !w.ready).length;
  if (queue.length > starting && workers.length < MAX_WORKERS) spawnWorker();
}

// Start one worker at launch so the first song doesn't pay the start-up cost.
export function warmUp() {
  if (!workers.length) spawnWorker();
}

export function stopWorkers() {
  for (const w of [...workers]) w.proc.kill();
}

function lookup(id, urgent) {
  return new Promise((resolve, reject) => {
    const job = { id, urgent, resolve, reject };
    if (urgent) queue.unshift(job);
    else {
      queue.push(job);
      // Hover pre-loads must never pile up in front of real plays.
      const extra = queue.filter((j) => !j.urgent);
      while (extra.length > MAX_PREFETCH) {
        const old = extra.shift();
        queue.splice(queue.indexOf(old), 1);
        old.reject(new Error('skipped'));
      }
    }
    pump();
  });
}

// ---------- streaming ----------

const streams = new Map(); // id -> entry | { pending }

export function resolveStream(id, urgent = false) {
  const hit = streams.get(id);
  if (hit?.pending) {
    // Already waiting as a pre-load: move it to the front now that it is being played.
    if (urgent) {
      const i = queue.findIndex((j) => j.id === id);
      if (i > 0) {
        const [job] = queue.splice(i, 1);
        job.urgent = true;
        queue.unshift(job);
      }
    }
    return hit.pending;
  }
  if (hit && hit.expires > Date.now() + 60_000) return Promise.resolve(hit);
  const pending = lookup(id, urgent)
    .then((info) => {
      const u = new URL(info.url);
      const entry = {
        url: info.url,
        headers: info.headers ?? {},
        expires: Number(u.searchParams.get('expire')) * 1000 || Date.now() + 3 * 3600_000,
        ext: info.ext,
        size: Number(u.searchParams.get('clen')) || info.size || 0,
        type: info.ext === 'webm' ? 'audio/webm' : 'audio/mp4',
      };
      streams.set(id, entry);
      return entry;
    })
    .catch((e) => {
      streams.delete(id);
      throw e;
    });
  streams.set(id, { pending });
  return pending;
}

export const forgetStream = (id) => streams.delete(id);

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range' };

// googlevideo refuses open-ended ranges ("bytes=0-"), which is what <audio> asks for. So the
// requested range is served by fetching bounded chunks one after another into a single stream.
const CHUNK = 2 * 1024 * 1024;

async function fetchChunk(id, from, to) {
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const s = await resolveStream(id, true);
    const res = await fetch(s.url, { headers: { ...s.headers, Range: `bytes=${from}-${to}` } });
    if (res.ok) return res;
    await res.body?.cancel();
    last = `HTTP ${res.status}`;
    console.warn(`[stream] ${id} bytes ${from}-${to}: ${last} (attempt ${attempt + 1}, client ${new URL(s.url).searchParams.get('c')})`);
    if (res.status === 403 || res.status === 410) forgetStream(id);
  }
  throw new Error(`stream chunk ${from}-${to} failed (${last})`);
}

export async function streamResponse(id, req) {
  const local = downloadedFile(id);
  if (local) return fileResponse(local, req);
  const s = await resolveStream(id, true);
  let total = s.size;
  if (!total) {
    // Size unknown: ask for one byte and read it from Content-Range.
    const probe = await fetchChunk(id, 0, 0);
    total = Number(/\/(\d+)/.exec(probe.headers.get('content-range') || '')?.[1]) || 0;
    await probe.body?.cancel();
    if (!total) return new Response('stream size unknown', { status: 502, headers: CORS });
    s.size = total;
  }
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  const start = m?.[1] ? Number(m[1]) : 0;
  const end = m?.[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  if (start >= total) return new Response('', { status: 416, headers: { ...CORS, 'Content-Range': `bytes */${total}` } });

  let pos = start;
  let reader = null;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          if (!reader) {
            if (pos > end) return controller.close();
            const to = Math.min(pos + CHUNK - 1, end);
            reader = (await fetchChunk(id, pos, to)).body.getReader();
          }
          const { done, value } = await reader.read();
          if (done) {
            reader = null;
            continue;
          }
          pos += value.byteLength;
          controller.enqueue(value);
          return;
        }
      } catch (e) {
        console.warn(`[stream] ${id}: ${e.message}`);
        if (/HTTP 403/.test(e.message)) onBlocked(id);
        controller.error(e);
      }
    },
    cancel() {
      reader?.cancel().catch(() => {});
    },
  });
  return new Response(body, {
    status: m ? 206 : 200,
    headers: {
      ...CORS,
      'Content-Type': s.type,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      ...(m ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
    },
  });
}

const MIME = { '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.webm': 'audio/webm', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

export function fileResponse(file, req) {
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  if (m) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
      status: 206,
      headers: { ...CORS, 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), {
    headers: { ...CORS, 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
  });
}

// ---------- downloads ----------

// Loaded on first use, after the app has picked its data folder.
let loadedIndex = null;
const idx = () => (loadedIndex ??= load('downloads', { items: {} }));
const active = new Map(); // id -> { track, progress, status }
const waiting = [];
let notify = () => {};
let onBlocked = () => {};
let dirOf = () => path.join(app.getPath('music'), 'abyss');

export function setupDownloads({ onProgress, downloadDir, blocked }) {
  notify = onProgress;
  if (blocked) onBlocked = blocked;
  dirOf = downloadDir;
}

export function downloadedFile(id) {
  const d = idx().items[id];
  if (d && fs.existsSync(d.file)) return d.file;
  return null;
}

export function coverFile(id) {
  const f = path.join(app.getPath('userData'), 'covers', `${id}.jpg`);
  return fs.existsSync(f) ? f : null;
}

export function listDownloads() {
  const done = Object.values(idx().items).filter((d) => fs.existsSync(d.file)).map((d) => ({ ...d, status: 'done', progress: 1 }));
  const running = [...active.values()].map((a) => ({ track: a.track, status: a.status, progress: a.progress }));
  return [...running, ...done.sort((a, b) => b.at - a.at)];
}

const safe = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);

export function download(track) {
  if (idx().items[track.id] && downloadedFile(track.id)) return;
  if (active.has(track.id)) return;
  active.set(track.id, { track, progress: 0, status: 'queued' });
  waiting.push(track);
  notify({ id: track.id, track, status: 'queued', progress: 0 });
  pumpDownloads();
}

let running = 0;
function pumpDownloads() {
  while (running < 2 && waiting.length) {
    const track = waiting.shift();
    running++;
    runDownload(track).finally(() => {
      running--;
      pumpDownloads();
    });
  }
}

async function runDownload(track) {
  const state = active.get(track.id);
  state.status = 'downloading';
  notify({ id: track.id, track, status: 'downloading', progress: 0 });
  const dir = dirOf();
  fs.mkdirSync(dir, { recursive: true });
  const artist = track.artists?.map((a) => a.name).join(', ') || 'unknown';
  const name = safe(`${artist} - ${track.title} [${track.id}]`);
  let file = null;
  try {
    const out = await run(
      [watchUrl(track.id), '-f', AUDIO, '-o', path.join(dir, `${name}.%(ext)s`), '--no-playlist', '--no-warnings', '--newline', '--progress', '--no-simulate',
        '--progress-template', 'download:ABYSS %(progress._percent_str)s', '--print', 'after_move:ABYSSFILE %(filepath)s'],
      (line) => {
        const p = /ABYSS\s+([\d.]+)%/.exec(line);
        if (p) {
          state.progress = Number(p[1]) / 100;
          notify({ id: track.id, track, status: 'downloading', progress: state.progress });
        }
        const f = /ABYSSFILE (.+)$/.exec(line);
        if (f) file = f[1].trim();
      },
    );
    if (!file) file = /ABYSSFILE (.+)/.exec(out)?.[1]?.trim();
    if (!file || !fs.existsSync(file)) throw new Error('download finished but file is missing');
    await saveCover(track);
    idx().items[track.id] = { track, file, size: fs.statSync(file).size, at: Date.now() };
    save('downloads', idx());
    active.delete(track.id);
    notify({ id: track.id, track, status: 'done', progress: 1 });
  } catch (e) {
    active.delete(track.id);
    notify({ id: track.id, track, status: 'error', progress: 0, error: e.message });
  }
}

async function saveCover(track) {
  if (!track.cover) return;
  try {
    const dir = path.join(app.getPath('userData'), 'covers');
    fs.mkdirSync(dir, { recursive: true });
    const res = await fetch(track.cover);
    if (res.ok) fs.writeFileSync(path.join(dir, `${track.id}.jpg`), Buffer.from(await res.arrayBuffer()));
  } catch {
    /* cover is optional */
  }
}

export function removeDownload(id) {
  const d = idx().items[id];
  if (!d) return;
  fs.rm(d.file, { force: true }, () => {});
  delete idx().items[id];
  save('downloads', idx());
  notify({ id, status: 'removed', progress: 0 });
}

export const downloadDirDefault = () => path.join(app.getPath('music'), 'abyss');
