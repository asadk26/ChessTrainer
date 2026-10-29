import { UciEngine } from './uci';

const ENGINE_URL = `${import.meta.env.BASE_URL}stockfish/stockfish-lite-single.js`;

let shared: UciEngine | null = null;
let failed = false;

/** Start Stockfish (single-threaded WASM "lite" build) in its own Web Worker; null if it can't run. */
async function startEngine(): Promise<UciEngine | null> {
  if (failed || typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') return null;
  try {
    const worker = new Worker(ENGINE_URL);
    const engine = new UciEngine('Stockfish 17.1 lite (WASM)', (cmd) => worker.postMessage(cmd), () => worker.terminate());
    worker.onmessage = (e: MessageEvent) => engine.receive(String(e.data));
    const ok = await Promise.race([
      engine.analyse('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', { depth: 4, multiPv: 1 }).then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 20000)),
    ]);
    worker.onerror = () => {
      failed = true;
    };
    if (!ok) {
      engine.dispose();
      throw new Error('Engine did not respond');
    }
    return engine;
  } catch (e) {
    console.warn('Stockfish unavailable:', e);
    failed = true;
    return null;
  }
}

/**
 * The shared engine for live, one-off questions (the practice board, checking a move).
 * Lazily started; null if the browser can't run it, so callers can degrade gracefully.
 */
export async function getBrowserEngine(): Promise<UciEngine | null> {
  if (shared) return shared;
  shared = await startEngine();
  return shared;
}

/**
 * A fresh engine for analysing one whole game; the caller disposes it. A shared engine carries its
 * hash table over from whatever it analysed before (other games, live questions in between), so the
 * same game could come out differently from run to run.
 */
export function createBrowserEngine(): Promise<UciEngine | null> {
  return startEngine();
}
