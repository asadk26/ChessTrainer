// A tiny read-only proxy to Chess.com's public API, shared by the Vite dev/preview
// middleware and the Vercel function. It exists to send a descriptive User-Agent
// (Chess.com asks API clients to identify themselves) and only ever forwards the
// two endpoints game syncing needs — it is not an open proxy.
import type { Env } from './llm.js';

const ALLOWED = /^player\/[a-z0-9_-]{3,25}\/games\/(archives|\d{4}\/\d{2})$/i;
const UPSTREAM = 'https://api.chess.com/pub/';

export interface ProxyResult {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export function userAgent(env: Env): string {
  const contact = env.CHESSCOM_CONTACT?.trim();
  return `ChessCoach/1.0 (personal chess training app; ${contact ? `contact: ${contact}` : 'no contact configured'})`;
}

/** Cache finished months for a day, this month's games and the archive list briefly. */
function cacheControl(path: string, now = new Date()): string {
  const m = /\/(\d{4})\/(\d{2})$/.exec(path);
  if (!m) return 'public, max-age=300';
  const current = Number(m[1]) === now.getUTCFullYear() && Number(m[2]) === now.getUTCMonth() + 1;
  return current ? 'public, max-age=300' : 'public, max-age=86400';
}

export async function proxyChessCom(path: string | null, env: Env, fetchImpl: typeof fetch = fetch): Promise<ProxyResult> {
  const base = { 'content-type': 'application/json', 'x-chesscom-proxy': '1' };
  if (!path || !ALLOWED.test(path)) return { status: 400, body: JSON.stringify({ error: 'Unsupported path' }), headers: { ...base, 'cache-control': 'no-store' } };
  let r: Response;
  try {
    r = await fetchImpl(UPSTREAM + path, { headers: { 'user-agent': userAgent(env), accept: 'application/json' } });
  } catch {
    return { status: 502, body: JSON.stringify({ error: 'Could not reach Chess.com' }), headers: { ...base, 'cache-control': 'no-store' } };
  }
  const headers: Record<string, string> = { ...base, 'cache-control': r.ok ? cacheControl(path) : 'no-store' };
  const retry = r.headers.get('retry-after');
  if (retry) headers['retry-after'] = retry;
  return { status: r.status, body: await r.text(), headers };
}
