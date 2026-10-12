// Browser side of Chess.com fetching. Goes through this app's small server proxy
// (/api/chesscom), which sets an identifying User-Agent as Chess.com asks — a
// browser can't set that header itself. If the proxy isn't there (e.g. a plain
// static host), it falls back to calling the public API directly.
import type { ChessComFetch } from './chesscom';

const DIRECT = 'https://api.chess.com/pub/';

async function toResult(r: Response) {
  let json: unknown;
  try {
    json = await r.json();
  } catch {
    json = undefined;
  }
  const retry = Number(r.headers.get('retry-after'));
  return { status: r.status, json, retryAfter: Number.isFinite(retry) && retry > 0 ? retry : undefined };
}

export const chesscomFetch: ChessComFetch = async (path) => {
  try {
    const r = await fetch(`/api/chesscom?path=${encodeURIComponent(path)}`);
    // Only trust answers that really came from our proxy (a static host would serve index.html).
    if (r.headers.get('x-chesscom-proxy') === '1') return toResult(r);
  } catch {
    // no proxy reachable: fall through to a direct request
  }
  return toResult(await fetch(DIRECT + path));
};
