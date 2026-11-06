// Builds vendor/python: Python's official embeddable build with yt-dlp installed inside it,
// so the packaged app needs no Python on the user's PC. Run: npm run vendor
// Requires a matching system Python (3.12) only on the machine that builds abyss, for pip.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '3.12.10';
const dest = path.join(root, 'vendor', 'python');
const zip = path.join(root, 'vendor', `python-${VERSION}-embed-amd64.zip`);
const site = path.join(dest, 'Lib', 'site-packages');

fs.mkdirSync(path.dirname(zip), { recursive: true });
if (!fs.existsSync(zip)) {
  const url = `https://www.python.org/ftp/python/${VERSION}/python-${VERSION}-embed-amd64.zip`;
  console.log('downloading', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
// Windows' own tar (Git's GNU tar misreads "C:" as a remote host).
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(tar, ['-xf', zip, '-C', dest], { stdio: 'inherit' });

// The embeddable build only looks where its ._pth file says: add site-packages and enable `site`.
const pth = fs.readdirSync(dest).find((f) => f.endsWith('._pth'));
fs.writeFileSync(path.join(dest, pth), ['python312.zip', '.', 'Lib\\site-packages', 'import site', ''].join('\r\n'));

console.log('installing yt-dlp into', site);
execFileSync('python', ['-m', 'pip', 'install', '--upgrade', '--pre', '--target', site, '--no-warn-script-location', 'yt-dlp[default]'], { stdio: 'inherit' });

const version = execFileSync(path.join(dest, 'python.exe'), ['-c', 'import yt_dlp; print(yt_dlp.version.__version__)']).toString().trim();
console.log('bundled yt-dlp', version);
