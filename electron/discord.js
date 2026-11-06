// Discord Rich Presence, always on: "Listening to abyss" with the song, artist, cover and a live
// progress bar. It talks to the Discord desktop app over local IPC (no login, no bot); if Discord
// isn't running, abyss keeps retrying quietly so presence appears as soon as Discord opens.
import { Client } from '@xhayper/discord-rpc';

// The "abyss" application on the Discord Developer Portal. A client ID is public, not a secret.
const CLIENT_ID = '1566051422296875109';
const RETRY_MS = 15_000;

let rpc = null;
let connected = false;
let last = null;
let retry = null;
let onStatus = () => {};

export function start(statusCallback) {
  if (statusCallback) onStatus = statusCallback;
  if (!rpc) connect();
}

function scheduleRetry() {
  clearTimeout(retry);
  retry = setTimeout(connect, RETRY_MS);
}

function connect() {
  clearTimeout(retry);
  rpc?.destroy().catch(() => {});
  rpc = new Client({ clientId: CLIENT_ID, transport: { type: 'ipc' } });
  rpc.on('ready', () => {
    connected = true;
    onStatus({ connected: true, user: rpc.user?.username ?? null });
    if (last) update(last);
  });
  rpc.on('disconnected', () => {
    connected = false;
    onStatus({ connected: false });
    scheduleRetry();
  });
  rpc.login().catch(() => {
    connected = false;
    scheduleRetry();
  });
}

const cut = (s, n = 120) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
// Discord rejects fields shorter than 2 characters.
const field = (s) => (s && s.length >= 2 ? cut(s) : s ? `${s} ` : undefined);

export function update(np) {
  last = np;
  if (!connected || !rpc?.user) return;
  if (!np || np.paused) {
    rpc.user.clearActivity().catch(() => {});
    return;
  }
  const link = `https://music.youtube.com/watch?v=${np.id}`;
  const start = Date.now() - Math.round(np.position * 1000);
  rpc.user
    .setActivity({
      type: 2, // Listening
      statusDisplayType: 2, // member list shows the song ("Listening to <title>"), not just "abyss"
      details: field(np.title),
      detailsUrl: link,
      state: field(np.artist) || 'unknown artist',
      largeImageKey: np.cover?.startsWith('http') ? np.cover : undefined,
      largeImageText: field(np.album || np.title),
      largeImageUrl: link,
      startTimestamp: start,
      endTimestamp: np.duration ? start + Math.round(np.duration * 1000) : undefined,
      buttons: [{ label: 'Listen on YouTube Music', url: link }],
      instance: false,
    })
    .catch((e) => console.warn('[discord]', e.message));
}

// Called on quit so the profile doesn't keep showing a song after abyss closes.
export async function stop() {
  clearTimeout(retry);
  try {
    if (connected) await rpc.user?.clearActivity();
    await rpc?.destroy();
  } catch {
    /* Discord already gone */
  }
  rpc = null;
  connected = false;
}

export const status = () => ({ connected, user: rpc?.user?.username ?? null });
