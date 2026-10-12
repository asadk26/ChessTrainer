// Vercel Function: POST /api/coach/complete — asks the configured LLM to phrase
// the coaching. The API key stays in Vercel's environment variables; callers
// must present COACH_ACCESS_TOKEN in the x-coach-token header.
import { coachComplete } from '../../server/coachApi';

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Bad request' }, { status: 400 });
  }
  const r = await coachComplete({ env: process.env, hosted: true }, request.headers.get('x-coach-token'), body);
  return Response.json(r.body, { status: r.status, headers: { 'cache-control': 'no-store' } });
}
