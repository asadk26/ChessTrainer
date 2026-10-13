// Read-only proxy to the Lichess opening explorer, shared by the Vite dev/preview middleware
// and the Vercel function. The explorer needs a (free) Lichess personal API token, which stays
// server-side in LICHESS_TOKEN. Only position queries are forwarded; it is not an open proxy,
// and on a hosted deployment it requires the same access code as the AI coach.
import { timingSafeEqual } from 'node:crypto';
import type { Env } from './llm.js';

const UPSTREAM = 'https://explorer.lichess.org/lichess';
const FEN = /^[rnbqkpRNBQKP1-8/]{15,90} [wb] (?:[KQkq]{1,4}|-) (?:[a-h][36]|-) \d{1,3} \d{1,4}$/;
const GROUPS = new Set(['0', '1000', '1200', '1400', '1600', '1800', '2000', '2200', '2500']);

export interface ProxyResult {
  status: number;
  body: string;
  headers: Record<string, string>;
}

const json = (status: number, body: unknown, cache = 'no-store'): ProxyResult => ({
  status,
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', 'cache-control': cache },
});

function tokenOk(expected: string | undefined, given: string | null | undefined, hosted: boolean): boolean {
  if (!hosted) return true;
  if (!expected) return false;
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function proxyLichess(
  params: URLSearchParams,
  env: Env,
  opts: { hosted: boolean; accessCode?: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<ProxyResult> {
  if (!env.LICHESS_TOKEN) return json(503, { error: 'Lichess opening data is not set up (LICHESS_TOKEN).' });
  if (!tokenOk(env.COACH_ACCESS_TOKEN, opts.accessCode, opts.hosted)) return json(401, { error: 'Missing or incorrect access code.' });
  const fen = params.get('fen') ?? '';
  const ratings = (params.get('ratings') ?? '1000,1200,1400').split(',').filter((r) => GROUPS.has(r));
  if (!FEN.test(fen) || !ratings.length) return json(400, { error: 'Bad position or ratings' });
  const q = new URLSearchParams({ variant: 'standard', speeds: 'blitz,rapid,classical', ratings: ratings.join(','), fen, moves: '8', topGames: '0', recentGames: '0' });
  let r: Response;
  try {
    r = await fetchImpl(`${UPSTREAM}?${q}`, { headers: { authorization: `Bearer ${env.LICHESS_TOKEN}`, accept: 'application/json' } });
  } catch {
    return json(502, { error: 'Could not reach Lichess' });
  }
  if (r.status === 429) return json(429, { error: 'Lichess rate limit: try again in a minute.' });
  if (!r.ok) return json(r.status, { error: `Lichess returned ${r.status}` });
  // Opening statistics change slowly: cache a week.
  return { status: 200, body: await r.text(), headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=604800' } };
}
