// Tiny JSON persistence in the app's userData folder.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const file = (name) => path.join(app.getPath('userData'), `${name}.json`);
const timers = {};
const pending = {};

export function load(name, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file(name), 'utf8')) };
  } catch {
    return structuredClone(fallback);
  }
}

function write(name) {
  const data = pending[name];
  if (data === undefined) return;
  delete pending[name];
  // Write to a temp file then rename, so a crash mid-write never leaves a half-written file.
  const target = file(name);
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(data, null, 1));
  fs.renameSync(`${target}.tmp`, target);
}

export function save(name, data) {
  pending[name] = data;
  clearTimeout(timers[name]);
  timers[name] = setTimeout(() => {
    try {
      write(name);
    } catch (err) {
      console.error(`[store] could not save ${name}:`, err.message);
    }
  }, 250);
}

export function flushAll() {
  for (const name of Object.keys(pending)) {
    clearTimeout(timers[name]);
    try {
      write(name);
    } catch (err) {
      console.error(`[store] could not save ${name}:`, err.message);
    }
  }
}
