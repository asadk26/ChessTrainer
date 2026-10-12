import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { applyTheme, getThemePref, watchSystemTheme } from './ui/theme';

applyTheme(getThemePref());
watchSystemTheme();

// The app uses hash routes (#/game/...), which survive refreshes on any static
// host. If someone opens a path-style URL (/game/...), convert it to the hash form.
if (window.location.pathname !== '/' && !window.location.hash && !/\.[a-z0-9]+$/i.test(window.location.pathname)) {
  window.history.replaceState(null, '', `/#${window.location.pathname}${window.location.search}`);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('Service worker registration failed:', e));
  });
}
// Ask the browser not to evict saved games under storage pressure (best effort).
void navigator.storage?.persist?.().catch(() => undefined);
