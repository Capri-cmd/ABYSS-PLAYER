// Builds vendor/python: a private Python with yt-dlp installed inside it, so the packaged app
// needs no Python on the user's computer. Run: npm run vendor
//   Windows: Python's official embeddable build (needs a system Python 3.12 only to run pip).
//   Linux:   a relocatable build from python-build-standalone, which brings its own pip.
// Run it on the OS you are building for.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'vendor', 'python');
const cache = path.join(root, 'vendor', 'downloads');

async function download(url, file) {
  if (fs.existsSync(file)) return;
  console.log('downloading', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

fs.mkdirSync(cache, { recursive: true });
fs.rmSync(dest, { recursive: true, force: true });

let python;
if (process.platform === 'win32') {
  const VERSION = '3.12.10';
  const zip = path.join(cache, `python-${VERSION}-embed-amd64.zip`);
  await download(`https://www.python.org/ftp/python/${VERSION}/python-${VERSION}-embed-amd64.zip`, zip);
  fs.mkdirSync(dest, { recursive: true });
  // Windows' own tar (Git's GNU tar misreads "C:" as a remote host).
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-xf', zip, '-C', dest], { stdio: 'inherit' });
  // The embeddable build only looks where its ._pth file says: add site-packages and enable `site`.
  const pth = fs.readdirSync(dest).find((f) => f.endsWith('._pth'));
  fs.writeFileSync(path.join(dest, pth), ['python312.zip', '.', 'Lib\\site-packages', 'import site', ''].join('\r\n'));
  const site = path.join(dest, 'Lib', 'site-packages');
  console.log('installing yt-dlp into', site);
  execFileSync('python', ['-m', 'pip', 'install', '--upgrade', '--pre', '--target', site, '--no-warn-script-location', 'yt-dlp[default]'], { stdio: 'inherit' });
  python = path.join(dest, 'python.exe');
} else if (process.platform === 'linux' && process.arch === 'x64') {
  const RELEASE = '20261026';
  const NAME = `cpython-3.12.16+${RELEASE}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`;
  const tgz = path.join(cache, NAME);
  await download(`https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/${encodeURIComponent(NAME)}`, tgz);
  // The archive holds a single "python/" folder.
  execFileSync('tar', ['-xzf', tgz, '-C', path.dirname(dest)], { stdio: 'inherit' });
  python = path.join(dest, 'bin', 'python3');
  console.log('installing yt-dlp into', dest);
  execFileSync(python, ['-m', 'pip', 'install', '--upgrade', '--pre', '--no-warn-script-location', '--disable-pip-version-check', 'yt-dlp[default]'], { stdio: 'inherit' });
  // The test suite, GUI toolkit and headers aren't needed at runtime.
  for (const p of ['lib/python3.12/test', 'lib/python3.12/idlelib', 'lib/python3.12/tkinter', 'include', 'share']) fs.rmSync(path.join(dest, p), { recursive: true, force: true });
} else {
  throw new Error(`no bundled Python recipe for ${process.platform}/${process.arch}`);
}

const version = execFileSync(python, ['-c', 'import yt_dlp; print(yt_dlp.version.__version__)']).toString().trim();
console.log('bundled yt-dlp', version);
