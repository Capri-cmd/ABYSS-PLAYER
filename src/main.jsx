import { createRoot } from 'react-dom/client';
import '@fontsource/vt323';
import '@fontsource/silkscreen';
import '@fontsource/silkscreen/700.css';
import './mini.css';
import { Mini } from './Mini.jsx';
import { dl, lib, prefs, settings } from './state.js';
import { player, restoreSession } from './player.js';

if (import.meta.env.DEV) window.__abyss = { player, settings };

Promise.allSettled([lib.load(), dl.load(), prefs.load()]).then(() => {
  restoreSession();
  createRoot(document.getElementById('root')).render(<Mini />);
});
