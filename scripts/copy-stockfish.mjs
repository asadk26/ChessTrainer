// Copies the single-threaded "lite" Stockfish WASM build into public/ so Vite can
// serve it as a Web Worker. The single-threaded build needs no COOP/COEP headers.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'stockfish', 'src');
const dest = join(root, 'public', 'stockfish');

if (!existsSync(src)) {
  console.warn('[copy-stockfish] node_modules/stockfish not found; skipping.');
  process.exit(0);
}
const files = readdirSync(src).filter((f) => /lite-single-[0-9a-f]+\.(js|wasm)$/.test(f));
const js = files.find((f) => f.endsWith('.js'));
if (!js) {
  console.warn('[copy-stockfish] lite single-threaded build not found; skipping.');
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
for (const f of files) {
  const out = join(dest, f.replace(/-[0-9a-f]+\.(js|wasm)$/, '.$1').replace(/^stockfish-[\d.]+-/, 'stockfish-'));
  if (!existsSync(out)) copyFileSync(join(src, f), out);
}
console.log('[copy-stockfish] engine ready in public/stockfish/');
