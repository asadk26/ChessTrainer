// Vercel Function: GET /api/lichess?fen=...&ratings=... — the Lichess opening explorer,
// with the Lichess token kept server-side (LICHESS_TOKEN).
import { proxyLichess } from '../server/lichessProxy.js';

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const r = await proxyLichess(url.searchParams, process.env, { hosted: true, accessCode: request.headers.get('x-coach-token') });
  return new Response(r.body, { status: r.status, headers: r.headers });
}
