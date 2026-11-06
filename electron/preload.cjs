const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = ['dl:progress', 'auth:changed', 'win:changed', 'stream:blocked'];

contextBridge.exposeInMainWorld('abyss', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  // The real path of a file dropped onto the window (used to drop art onto a skin).
  pathForFile: (file) => webUtils.getPathForFile(file),
  on: (channel, cb) => {
    if (!EVENTS.includes(channel)) throw new Error(`unknown event ${channel}`);
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
