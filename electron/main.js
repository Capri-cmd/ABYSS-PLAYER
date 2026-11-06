// abyss — main process. One small frameless window (the player), plus everything it needs:
// YouTube Music access, audio streaming, downloads, lyrics, Discord presence and skins.
import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yt from './yt.js';
import * as media from './media.js';
import * as lyrics from './lyrics.js';
import * as discord from './discord.js';
import { flushAll, load, save } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEV = Boolean(process.env.ABYSS_DEV);

protocol.registerSchemesAsPrivileged([
  { scheme: 'abyss', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } },
]);

// A separate profile folder lets a test copy run beside your real one.
if (process.env.ABYSS_PROFILE) app.setPath('userData', process.env.ABYSS_PROFILE);
if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('app.abyss.player');

const settings = load('settings', {
  downloadDir: '',
  cookie: '',
  skin: 'abyss',
  onTop: false,
  bounds: null,
  skinArt: {}, // skin id -> picture the user picked, kept in userData/skins
});
let library = load('library', { playlists: [], liked: [], history: [], stats: { plays: 0, seconds: 0, artists: {} } });
let win = null;
let account = null;

const send = (channel, payload) => win?.webContents.send(channel, payload);

// ---------- window ----------
// Frameless: the player draws its own title bar and buttons. Windows still gives it edge
// resizing, snapping and a shadow. The width is fixed; the height follows what's open.

const WIDTH = 420;
const PROFILE_WIDTH = 240; // the profile capsule slides out on the left
const MIN_HEIGHT = 260;
let width = WIDTH;
const BIG = 100000; // "no maximum"
const ICON = path.join(here, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const SKIN_ICONS = { aqua: path.join(here, '..', 'assets', 'skins', 'aqua', process.platform === 'win32' ? 'icon.ico' : 'icon.png') };

const winState = () => ({ onTop: settings.onTop, skin: settings.skin });

function rememberBounds() {
  if (!win || win.isMinimized()) return;
  const b = win.getBounds();
  // Always remember the player's own spot, without the profile panel.
  settings.bounds = { ...b, x: b.x + b.width - WIDTH, width: WIDTH };
  save('settings', settings);
}

function createWindow() {
  win = new BrowserWindow({
    ...(settings.bounds ?? { height: 880 }),
    width: WIDTH,
    minWidth: WIDTH,
    maxWidth: WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: '#e9e2bd',
    frame: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: settings.onTop,
    title: 'abyss',
    icon: SKIN_ICONS[settings.skin] || ICON,
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  if (settings.onTop) win.setAlwaysOnTop(true, 'floating');
  win.once('ready-to-show', () => win.show());
  let boundsTimer;
  for (const e of ['move', 'resize']) win.on(e, () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(rememberBounds, 400); });
  win.on('close', rememberBounds);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (DEV) {
    win.webContents.on('console-message', (e) => {
      if (e.level === 'warning' || e.level === 'error') console.log(`[renderer ${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
    });
    win.loadURL(process.env.ABYSS_DEV_URL || 'http://localhost:5199');
  } else win.loadFile(path.join(here, '..', 'dist', 'index.html'));
}

// The player asks for a height that fits what's open; `locked` stops manual resizing when only
// the compact player is showing.
function fitHeight(height, locked) {
  const h = Math.max(MIN_HEIGHT, Math.round(height));
  win.setMaximumSize(width, locked ? h : BIG);
  win.setMinimumSize(width, locked ? h : MIN_HEIGHT);
  win.setSize(width, h);
}

// Opening the profile widens the window to the left, so the player itself doesn't move.
function setProfileOpen(open) {
  const next = open ? WIDTH + PROFILE_WIDTH : WIDTH;
  if (next === width) return;
  const b = win.getBounds();
  const [, minH] = win.getMinimumSize();
  const [, maxH] = win.getMaximumSize();
  width = next;
  win.setMinimumSize(Math.min(width, b.width), minH);
  win.setMaximumSize(Math.max(width, b.width), maxH);
  win.setBounds({ x: b.x + b.width - width, y: b.y, width, height: b.height });
  win.setMinimumSize(width, minH);
  win.setMaximumSize(width, maxH);
}

// ---------- skins: their own taskbar icon and a picture the user picks ----------

const SKIN_DIR = () => path.join(app.getPath('userData'), 'skins');
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;

function setSkin(skin) {
  settings.skin = String(skin);
  win?.setIcon(SKIN_ICONS[settings.skin] || ICON);
  save('settings', settings);
  send('win:changed', winState());
}

function artUrl(skin) {
  const file = settings.skinArt?.[skin];
  if (!file) return null;
  const full = path.join(SKIN_DIR(), file);
  if (!fs.existsSync(full)) return null;
  return `abyss://art/${encodeURIComponent(file)}?v=${Math.round(fs.statSync(full).mtimeMs)}`;
}

// Copy the chosen picture into abyss's own folder so it keeps working if the original moves.
function setArt(skin, source) {
  if (!/^[a-z0-9-]+$/.test(skin) || !IMAGE.test(source) || !fs.existsSync(source)) return null;
  fs.mkdirSync(SKIN_DIR(), { recursive: true });
  const old = settings.skinArt?.[skin];
  const file = `${skin}${path.extname(source).toLowerCase()}`;
  if (old && old !== file) fs.rmSync(path.join(SKIN_DIR(), old), { force: true });
  fs.copyFileSync(source, path.join(SKIN_DIR(), file));
  settings.skinArt = { ...settings.skinArt, [skin]: file };
  save('settings', settings);
  return artUrl(skin);
}

function clearArt(skin) {
  const file = settings.skinArt?.[skin];
  if (file) fs.rmSync(path.join(SKIN_DIR(), file), { force: true });
  const { [skin]: _, ...rest } = settings.skinArt ?? {};
  settings.skinArt = rest;
  save('settings', settings);
  return null;
}

// ---------- YouTube Music account ----------
// Google blocks sign-in pages inside apps, so the user signs in with their own browser and gives
// abyss that session's cookie. It's stored encrypted with the OS keychain.

function readCookie() {
  if (!settings.cookie) return '';
  try {
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(settings.cookie, 'base64')) : settings.cookie;
  } catch {
    return '';
  }
}

function writeCookie(cookie) {
  settings.cookie = !cookie ? '' : safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(cookie).toString('base64') : cookie;
  save('settings', settings);
}

async function useCookie(header) {
  writeCookie(header);
  media.setCookies(header);
  await yt.init(header);
  account = header ? await yt.account() : null;
  send('auth:changed', { signedIn: Boolean(header), account });
  return Boolean(account);
}

async function signInWithCookie(header) {
  header = String(header || '').trim().replace(/^cookie:\s*/i, '');
  if (!/SAPISID=/.test(header)) return { ok: false, error: 'That cookie has no SAPISID — copy the whole cookie value from music.youtube.com.' };
  const ok = await useCookie(header);
  if (!ok) await useCookie('');
  return ok ? { ok, account } : { ok: false, error: 'YouTube did not accept that cookie.' };
}

async function restoreAccount() {
  const header = readCookie();
  await yt.init(header);
  if (!header) return;
  media.setCookies(header);
  account = await yt.account();
  send('auth:changed', { signedIn: true, account });
}

const publicSettings = () => ({
  signedIn: Boolean(settings.cookie),
  account,
  downloadDir: settings.downloadDir || media.downloadDirDefault(),
  skin: settings.skin,
  onTop: settings.onTop,
  version: app.getVersion(),
});

// ---------- IPC ----------

const handlers = {
  'yt:search': (q) => yt.search(q),
  'yt:playlist': (id) => (String(id).startsWith('MPRE') ? yt.album(id) : yt.playlist(id)),
  'yt:upnext': (id) => yt.upNext(id),
  'yt:artist': async (a) => yt.artist(a.id || (await yt.findArtist(a.name))),
  'yt:library': () => yt.library(),
  'yt:like': (id, on) => yt.rate(id, on),

  'stream:prefetch': (id) => {
    if (!media.downloadedFile(id)) media.resolveStream(id).catch(() => {});
  },

  'lyrics:get': (track) => lyrics.get(track),

  'dl:start': (track) => media.download(track),
  'dl:list': () => media.listDownloads(),
  'dl:remove': (id) => media.removeDownload(id),
  'dl:open-folder': () => shell.openPath(settings.downloadDir || media.downloadDirDefault()),
  'dl:pick-folder': async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return null;
    settings.downloadDir = r.filePaths[0];
    save('settings', settings);
    return settings.downloadDir;
  },

  'lib:load': () => library,
  'lib:save': (data) => {
    library = data;
    save('library', library);
  },

  'settings:load': () => publicSettings(),

  'auth:open-browser': () => shell.openExternal('https://music.youtube.com/'),
  'auth:cookie': (header) => signInWithCookie(header),
  'auth:signout': () => useCookie(''),

  'win:state': () => winState(),
  'win:minimize': () => win.minimize(),
  'win:close': () => win.close(),
  'win:on-top': (on) => {
    settings.onTop = Boolean(on);
    win.setAlwaysOnTop(settings.onTop, 'floating');
    save('settings', settings);
    send('win:changed', winState());
  },
  'win:fit': (height, locked) => fitHeight(height, locked),
  'win:profile': (open) => setProfileOpen(Boolean(open)),
  'win:skin': (skin) => setSkin(skin),

  'skin:art': (skin) => artUrl(skin),
  'skin:pick-art': async (skin) => {
    const r = await dialog.showOpenDialog(win, { title: 'Pick a picture for this skin', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
    return r.canceled ? null : setArt(skin, r.filePaths[0]);
  },
  'skin:set-art': (skin, file) => setArt(skin, String(file)),
  'skin:clear-art': (skin) => clearArt(skin),

  'discord:update': (np) => discord.update(np),
  'app:open-url': (url) => /^https:\/\/(github\.com|music\.youtube\.com)\//.test(url) && shell.openExternal(url),
};

for (const [channel, fn] of Object.entries(handlers)) {
  ipcMain.handle(channel, async (_e, ...args) => fn(...args));
}

// ---------- boot ----------

app.whenReady().then(() => {
  protocol.handle('abyss', async (req) => {
    const url = new URL(req.url);
    const id = decodeURIComponent(url.pathname.slice(1));
    try {
      if (url.host === 'track') return await media.streamResponse(id, req);
      if (url.host === 'cover') {
        const f = media.coverFile(id);
        return f ? media.fileResponse(f, req) : new Response('', { status: 404 });
      }
      if (url.host === 'art') {
        const f = path.join(SKIN_DIR(), path.basename(id));
        return fs.existsSync(f) ? media.fileResponse(f, req) : new Response('', { status: 404 });
      }
    } catch (e) {
      console.error('[abyss://]', e.message);
      return new Response(e.message, { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    return new Response('', { status: 404 });
  });

  yt.setCacheDir(path.join(app.getPath('userData'), 'yt-cache'));
  restoreAccount().catch((e) => console.error('[yt] init failed:', e.message));
  media.warmUp();
  media.setupDownloads({
    onProgress: (p) => send('dl:progress', p),
    downloadDir: () => settings.downloadDir || media.downloadDirDefault(),
    blocked: (id) => send('stream:blocked', { id, signedIn: Boolean(settings.cookie) }),
  });
  discord.start();
  createWindow();
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// Nothing waits on a debounce timer when the app closes: write every pending save now.
app.on('before-quit', () => {
  flushAll();
  media.stopWorkers();
  discord.stop();
});
app.on('window-all-closed', () => app.quit());
