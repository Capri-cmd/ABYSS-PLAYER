// electron-builder afterPack hook. On Linux, make sure nothing inside the packed app is writable
// by other users: Electron's own download carries some 0666/0777 files, and those would end up
// world-writable in /opt/abyss after installing the .deb or .pacman.
// (chrome-sandbox gets its final mode from the package's install script.)
const fs = require('node:fs');
const path = require('node:path');

function tighten(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    const mode = fs.statSync(p).mode & 0o7777;
    if (mode & 0o022) fs.chmodSync(p, mode & ~0o022);
    if (entry.isDirectory()) tighten(p);
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  tighten(context.appOutDir);
};
