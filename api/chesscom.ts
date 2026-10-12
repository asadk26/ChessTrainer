// Vercel Function: GET /api/chesscom?path=player/{name}/games/... — read-only
// proxy to Chess.com's public API that identifies itself with a User-Agent.
import { proxyChessCom } from '../server/chesscomProxy';

export async function GET(request: Request): Promise<Response> {
  const r = await proxyChessCom(new URL(request.url).searchParams.get('path'), process.env);
  return new Response(r.body, { status: r.status, headers: r.headers });
}
