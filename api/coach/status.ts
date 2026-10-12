// Vercel Function: GET /api/coach/status — is an AI coach configured on this deployment?
import { coachStatus } from '../../server/coachApi';

export function GET(): Response {
  const r = coachStatus({ env: process.env, hosted: true });
  return Response.json(r.body, { status: r.status, headers: { 'cache-control': 'no-store' } });
}
